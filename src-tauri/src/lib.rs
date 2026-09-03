mod site_fetch;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

/// One queued native happening, in the desktop shell's vocabulary
/// (desktop_integration.rs): `kind` is "deepLink" here, and a file route would
/// add "openFile" the same way.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileEvent {
    pub kind: String,
    pub value: String,
}

/// The lolly:// URLs iOS hands the running app (RunEvent::Opened, registered by
/// CFBundleURLTypes in gen/apple's Info.plist). Android never reaches this queue:
/// its MainActivity stashes an ACTION_VIEW link on the LollyShare bridge, and the
/// JS intake (shells/web drop-router.ts initDeepLinkIntake) prefers that bridge
/// and polls here only when it is absent. Poll, not push - the house Rust->JS
/// pattern, so a link that arrives before the web shell boots is not lost.
#[derive(Default)]
pub struct MobileEvents(Mutex<Vec<MobileEvent>>);

impl MobileEvents {
    fn push(&self, kind: &str, value: String) {
        if let Ok(mut q) = self.0.lock() {
            // A never-polling webview must not grow this without bound.
            if q.len() > 64 {
                q.drain(0..32);
            }
            q.push(MobileEvent { kind: kind.into(), value });
        }
    }
}

#[tauri::command]
fn mobile_poll_events(events: State<'_, MobileEvents>) -> Vec<MobileEvent> {
    events
        .0
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(MobileEvents::default())
        // The website source for the Design System studio (plans/97 section 9)
        // was the first command of this shell's own, because it has to enforce
        // the first-party redirect rule and the byte caps itself; the deep-link
        // queue is the second. Everything else is plugins (fs, http) or the
        // shared web bridge.
        .invoke_handler(tauri::generate_handler![
            site_fetch::site_fetch,
            mobile_poll_events
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lolly mobile")
        .run(|app, event| {
            // iOS delivers a lolly:// open as RunEvent::Opened. The cfg names macOS
            // too so `cargo check` on a Mac compiles this arm; the macOS app itself
            // is the desktop shell, which has its own handler.
            #[cfg(any(target_os = "ios", target_os = "macos"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                let events: State<'_, MobileEvents> = app.state();
                for u in urls.iter().filter(|u| u.scheme() == "lolly") {
                    events.push("deepLink", u.as_str().to_string());
                }
            }
            #[cfg(not(any(target_os = "ios", target_os = "macos")))]
            let _ = (app, &event);
        });
}
