#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod compatibility;
mod local;

use std::{net::TcpListener, sync::Arc};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::NewWindowResponse};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![pick_local_path])
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
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("GitDigest")
                .inner_size(1280.0, 900.0)
                .min_inner_size(420.0, 480.0)
                .initialization_script(bridge)
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
