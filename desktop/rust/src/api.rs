use crate::{
    compatibility::Compatibility,
    local::{self, Digest, Options, Outcome},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

const UI_ORIGIN: &str = "http://tauri.localhost";
const DESKTOP_KEY: &str = "x-gitdigest-desktop";

pub struct DesktopApi {
    key: String,
    compatibility: Compatibility,
    client: reqwest::Client,
}

impl DesktopApi {
    pub fn new(key: String, cache: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            key,
            compatibility: Compatibility::new(cache),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Loopback HTTP client configuration is valid"),
        })
    }

    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route("/api/{operation}", any(api))
            .with_state(self)
    }

    pub fn shutdown(&self) {
        self.compatibility.shutdown();
    }
}

async fn api(State(state): State<Arc<DesktopApi>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if parts
        .headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(UI_ORIGIN)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if parts.method == Method::OPTIONS {
        return with_origin(
            (
                StatusCode::NO_CONTENT,
                [
                    (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS"),
                    (
                        header::ACCESS_CONTROL_ALLOW_HEADERS,
                        "authorization, content-type, x-gitdigest-desktop, x-no-stream",
                    ),
                ],
            )
                .into_response(),
        );
    }
    if parts
        .headers
        .get(DESKTOP_KEY)
        .and_then(|value| value.to_str().ok())
        != Some(state.key.as_str())
    {
        return with_origin(StatusCode::FORBIDDEN.into_response());
    }
    let response = handle(state, parts, body).await;
    with_origin(response)
}

fn with_origin(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(UI_ORIGIN),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn handle(state: Arc<DesktopApi>, parts: axum::http::request::Parts, body: Body) -> Response {
    let ingest = parts.method == Method::POST && parts.uri.path() == "/api/ingest";
    let user_status = parts.method == Method::GET && parts.uri.path() == "/api/user-status";
    let verify = parts.method == Method::POST && parts.uri.path() == "/api/verify-auth";
    if !ingest && !user_status && !verify {
        return StatusCode::NOT_FOUND.into_response();
    }
    if user_status && !parts.headers.contains_key(header::AUTHORIZATION) {
        return Json(json!({ "configured": false, "user": null, "authorized": false }))
            .into_response();
    }
    let Ok(body) = to_bytes(body, 50 * 1024 * 1024).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Request is too large.");
    };
    if ingest {
        let Ok(options) = serde_json::from_slice::<Options>(&body) else {
            return error(
                StatusCode::BAD_REQUEST,
                "Please provide a valid repository URL or path",
            );
        };
        if options.input_text.trim().is_empty() {
            return error(
                StatusCode::BAD_REQUEST,
                "Please provide a valid repository URL or path",
            );
        }
        let stream = !parts.headers.contains_key("x-no-stream")
            && parts
                .headers
                .get(header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .is_none_or(|value| {
                    value.contains("application/x-ndjson")
                        || value.contains("*/*")
                        || value.contains("text/event-stream")
                });
        let (events, mut receiver) = mpsc::channel::<Event>(64);
        tokio::task::spawn_blocking(move || {
            let result = local::ingest(
                options,
                |path, count, total, status| {
                    !stream || events.blocking_send(Event::Progress(
                    json!({ "type": "progress", "path": path, "count": count, "total": total, "status": status }).to_string()
                )).is_ok()
                },
                || events.is_closed(),
            );
            let _ = events.blocking_send(Event::Complete(result));
        });
        match receiver.recv().await {
            Some(Event::Complete(Outcome::CompatibilityBackend)) => {}
            Some(Event::Complete(Outcome::Local(result))) if !stream => {
                return Json(result).into_response();
            }
            Some(Event::Complete(Outcome::Unreadable)) => {
                return error(
                    StatusCode::NOT_FOUND,
                    "The local file or folder could not be read.",
                );
            }
            Some(Event::Complete(Outcome::Cancelled)) | None => {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            Some(first) => {
                let lines = tokio_stream::iter([first])
                    .chain(ReceiverStream::new(receiver))
                    .filter_map(Event::into_line);
                return (
                    [(header::CONTENT_TYPE, "application/x-ndjson")],
                    Body::from_stream(lines),
                )
                    .into_response();
            }
        }
    }
    let lease = match state.compatibility.acquire(&state.key).await {
        Ok(lease) => lease,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not start the bundled GitHub ingestion engine.",
            );
        }
    };
    let mut upstream = state
        .client
        .request(
            parts.method,
            format!("http://127.0.0.1:{}{}", lease.port, parts.uri.path()),
        )
        .header(DESKTOP_KEY, &state.key);
    for header in [
        header::CONTENT_TYPE,
        header::AUTHORIZATION,
        header::ACCEPT,
        header::HeaderName::from_static("x-no-stream"),
    ] {
        if let Some(value) = parts.headers.get(&header) {
            upstream = upstream.header(header, value);
        }
    }
    let Ok(remote) = upstream.body(body).send().await else {
        return error(
            StatusCode::BAD_GATEWAY,
            "The GitHub ingestion engine did not respond.",
        );
    };
    let mut response = Response::builder().status(remote.status());
    if let Some(content_type) = remote.headers().get(header::CONTENT_TYPE) {
        response = response.header(header::CONTENT_TYPE, content_type);
    }
    response
        .body(Body::from_stream(remote.bytes_stream().map(move |chunk| {
            let _lease = &lease;
            chunk
        })))
        .expect("Valid upstream response")
}

enum Event {
    Progress(String),
    Complete(Outcome),
}

impl Event {
    fn into_line(self) -> Option<Result<String, serde_json::Error>> {
        fn result_line(result: Digest) -> Result<String, serde_json::Error> {
            #[derive(serde::Serialize)]
            struct ResultFrame {
                r#type: &'static str,
                data: Digest,
            }
            serde_json::to_string(&ResultFrame {
                r#type: "result",
                data: result,
            })
            .map(|mut line| {
                line.push('\n');
                line
            })
        }
        match self {
            Self::Progress(mut event) => {
                event.push('\n');
                Some(Ok(event))
            }
            Self::Complete(Outcome::Local(result)) => Some(result_line(result)),
            _ => None,
        }
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
