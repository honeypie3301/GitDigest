#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod compatibility;
mod credentials;
mod local;

use std::{net::TcpListener, sync::Arc};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
    webview::{DownloadEvent, NewWindowResponse},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Downloads(std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>);

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("Only HTTPS links can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn reveal_download(
    app: tauri::AppHandle,
    downloads: tauri::State<Downloads>,
    path: String,
) -> Result<(), String> {
    let saved = downloads.0.lock().map_err(|error| error.to_string())?;
    if !saved.contains(std::path::Path::new(&path)) {
        return Err("This file was not downloaded by this session.".into());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn pick_local_path(window: tauri::WebviewWindow, kind: String) -> Option<String> {
    let dialog = window.dialog().file().set_parent(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let path = match kind.as_str() {
            "folder" => dialog.blocking_pick_folder(),
            "file" => dialog.blocking_pick_file(),
            _ => return None,
        };
        path.and_then(|path| path.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

fn main() {
    let result =
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .on_window_event(|window, event| {
                if let WindowEvent::Focused(focused) = event
                    && let Some(webview) = window.get_webview_window(window.label())
                {
                    set_webview_memory_target(&webview, *focused);
                }
            })
            .manage(Downloads::default())
            .invoke_handler(tauri::generate_handler![
                pick_local_path,
                credentials::read_token,
                credentials::save_token,
                open_external,
                reveal_download
            ])
            .setup(|app| {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
                listener.set_nonblocking(true)?;
                let endpoint = format!("http://{}", listener.local_addr()?);
                let mut secret = [0; 32];
                getrandom::fill(&mut secret)
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                let key = secret
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let state = api::DesktopApi::new(
                    key.clone(),
                    app.path().app_local_data_dir()?.join("ingestion-engine"),
                );
                app.manage(state.clone());
                tauri::async_runtime::spawn(async move {
                    if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                        let _ = axum::serve(listener, state.router()).await;
                    }
                });

                let bridge = include_str!("bridge.js")
                    .replace("__API_ENDPOINT__", &serde_json::to_string(&endpoint)?)
                    .replace("__API_KEY__", &serde_json::to_string(&key)?);
                let handle = app.handle().clone();
                let popup_handle = handle.clone();
                let window =
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .title("GitDigest")
                        .inner_size(1280.0, 900.0)
                        .min_inner_size(420.0, 480.0)
                        .visible(false)
                        .initialization_script(bridge)
                        .on_download(|webview, event| {
                            if let DownloadEvent::Finished { path, success, .. } = event {
                                if success && let Some(path) = &path {
                                    if let Ok(mut saved) = webview.state::<Downloads>().0.lock() {
                                        saved.insert(path.clone());
                                    }
                                }
                                let _ = webview.emit("download-finished", serde_json::json!({
                                "success": success,
                                "path": path.map(|path| path.to_string_lossy().into_owned()),
                            }));
                            }
                            true
                        })
                        .on_navigation(move |url| {
                            if url.host_str() == Some("tauri.localhost") && url.scheme() == "http" {
                                return true;
                            }
                            if url.scheme() == "https" {
                                let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                            }
                            false
                        })
                        .on_new_window(move |url, _| {
                            if url.scheme() == "https" {
                                let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                            }
                            NewWindowResponse::Deny
                        })
                        .build()?;
                fit_to_work_area(&window)?;
                window.show()?;
                Ok(())
            })
            .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<api::DesktopApi>>() {
                    state.shutdown();
                }
            }
        }),
        Err(error) => {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MessageBoxW};
            let title: Vec<_> = "GitDigest\0".encode_utf16().collect();
            let message: Vec<_> = format!("{error}\0").encode_utf16().collect();
            // Both strings remain valid and terminated until the dialog closes.
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    message.as_ptr(),
                    title.as_ptr(),
                    MB_ICONERROR,
                );
            }
        }
    }
}

fn fit_to_work_area(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let work = monitor.work_area();
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let width = inner
        .width
        .min(
            work.size
                .width
                .saturating_sub(outer.width.saturating_sub(inner.width)),
        )
        .max(1);
    let height = inner
        .height
        .min(
            work.size
                .height
                .saturating_sub(outer.height.saturating_sub(inner.height)),
        )
        .max(1);
    if width != inner.width || height != inner.height {
        let minimum_width = (420.0 * monitor.scale_factor()).round() as u32;
        let minimum_height = (480.0 * monitor.scale_factor()).round() as u32;
        window.set_min_size(Some(PhysicalSize::new(
            width.min(minimum_width),
            height.min(minimum_height),
        )))?;
        window.set_size(PhysicalSize::new(width, height))?;
    }
    let outer = window.outer_size()?;
    window.set_position(PhysicalPosition::new(
        work.position.x + (work.size.width.saturating_sub(outer.width) / 2) as i32,
        work.position.y + (work.size.height.saturating_sub(outer.height) / 2) as i32,
    ))
}

fn set_webview_memory_target(window: &WebviewWindow, focused: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        ICoreWebView2_19,
    };
    use windows_core::Interface;

    let _ = window.with_webview(move |webview| {
        let target = if focused {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        };
        // Tauri hands this callback the controller on its UI thread. Older runtimes
        // may not implement the optional memory-target interface.
        unsafe {
            if let Ok(core) = webview.controller().CoreWebView2()
                && let Ok(core) = core.cast::<ICoreWebView2_19>()
            {
                let _ = core.SetMemoryUsageTargetLevel(target);
            }
        }
    });
}
