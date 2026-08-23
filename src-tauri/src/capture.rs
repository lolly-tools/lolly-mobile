// SPDX-License-Identifier: MPL-2.0
//! ⚠️ STAGED DRAFT - NOT WIRED (not `mod`-ed in lib.rs; no deps in Cargo.toml).
//!
//! This was the first attempt at iOS url-shot capture via the typed objc2-web-kit
//! bindings. IT DOES NOT COMPILE ON iOS: objc2-web-kit 0.3.2 declares `WKWebView`
//! with the macOS superclass chain (`super(NSView, NSResponder, NSObject)`), so the
//! class is unavailable on the aarch64-apple-ios target (`unresolved import
//! objc2_web_kit::WKWebView`). The vector pipeline (createPDF → NSData → the JS
//! side's PDF→SVG) and the command/result shapes here are correct; only the way we
//! reach WKWebView is wrong.
//!
//! TWO WAYS FORWARD (pick when resuming, on-device):
//!   1. A Swift plugin (RECOMMENDED) - WKWebView is trivial in Swift/UIKit
//!      (~20 lines: load, wait, createPDF); Tauri v2 supports iOS plugins.
//!   2. Raw objc2 `msg_send!` with a runtime `class!(WKWebView)` lookup (avoids the
//!      macOS-bound typed binding, at the cost of a lot of unsafe messaging).
//! The JS half is ready at bridge-overrides/capture.ts; wire the vite override +
//! `capture` capability (iOS-gated) back on once the native command exists.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! Page/vector capture on iOS via an offscreen WKWebView - the mobile twin of the
//! desktop headless-Chrome capture (shells/tauri-desktop). Command names + result
//! shapes MIRROR the desktop pair so bridge-overrides/capture.ts is near-verbatim.
//!
//! v1 is VECTOR-first: `capture_page_pdf` prints the page to a PDF
//! (WKWebView.createPDF) that the JS side turns into SVG through the engine's PDF
//! interpreter - the "vector screenshot" path. `capture_page` (raster PNG) is
//! deferred on iOS (WKWebView.takeSnapshot's completion is typed against the
//! macOS-only NSImage in the binding); a tool asking for a raster gets a clear
//! "export as SVG" message until that lands.
//!
//! WKWebView is main-thread-only, and load+print are asynchronous, so the command
//! dispatches to the main thread and blocks a worker thread on a channel until the
//! completion handler fires.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSpec {
    pub url: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub scroll_depth: Option<f64>,
    pub range_to: Option<f64>,
    pub wait_ms: Option<f64>,
    pub dpr: Option<f64>,
    pub css: Option<String>,
    pub crop: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub data: String,
    pub width: f64,
    pub height: f64,
    pub frame_height: f64,
    pub page_width: f64,
    pub page_height: f64,
    pub scroll_y: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorResult {
    /// base64 PDF.
    pub data: String,
    pub page_width: f64,
    pub page_height: f64,
}

const DEFAULT_WIDTH: f64 = 1024.0;
const DEFAULT_WAIT_MS: f64 = 2500.0;
const MAX_WAIT_MS: f64 = 15_000.0;
/// A tall working height for the offscreen frame; the printed PDF's own page
/// geometry (read back by the JS side) is what sizes the result. `ponytail:
/// fixed working height - measure the live scrollHeight (evaluateJavaScript) once
/// the basic pipeline is verified on device, so very tall pages don't clip.`
const WORK_HEIGHT: f64 = 4000.0;

#[cfg(target_os = "ios")]
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(target_os = "ios")]
mod ios {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSData, NSError, NSString, NSTimer, NSURLRequest, NSURL};
    use objc2_ui_kit::{UIApplication, UIWindow};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView, WKWebViewConfiguration};

    /// (pdf_bytes, page_width, page_height).
    type Sent = Result<(Vec<u8>, f64, f64), String>;

    pub fn run_pdf(app: &tauri::AppHandle, spec: CaptureSpec) -> Sent {
        let (tx, rx) = mpsc::channel::<Sent>();
        let wait_ms = spec.wait_ms.unwrap_or(DEFAULT_WAIT_MS).clamp(0.0, MAX_WAIT_MS);
        let width = spec.width.filter(|w| *w > 0.0).unwrap_or(DEFAULT_WIDTH);
        let url = spec.url.clone();

        let tx_main = tx.clone();
        let dispatched = app.run_on_main_thread(move || {
            let mtm = match MainThreadMarker::new() {
                Some(m) => m,
                None => {
                    let _ = tx_main.send(Err("capture: not on the main thread".into()));
                    return;
                }
            };
            if let Err(e) = start(mtm, &url, width, wait_ms, tx_main.clone()) {
                let _ = tx_main.send(Err(e));
            }
        });
        if let Err(e) = dispatched {
            return Err(format!("capture: could not reach the main thread: {e}"));
        }

        match rx.recv_timeout(Duration::from_millis((wait_ms as u64) + 25_000)) {
            Ok(res) => res,
            Err(_) => Err("capture: timed out waiting for the page".into()),
        }
    }

    fn start(
        mtm: MainThreadMarker,
        url: &str,
        width: f64,
        wait_ms: f64,
        tx: mpsc::Sender<Sent>,
    ) -> Result<(), String> {
        let ns_url = unsafe { NSURL::URLWithString(&NSString::from_str(url)) }
            .ok_or_else(|| format!("capture: not a valid URL: {url}"))?;
        let req = unsafe { NSURLRequest::requestWithURL(&ns_url) };

        let config = WKWebViewConfiguration::new(mtm);
        let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width, WORK_HEIGHT));
        let webview = unsafe {
            WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config)
        };
        webview.setAlpha(0.0);

        // Offscreen in the key window so the content actually lays out.
        if let Some(window) = key_window(mtm) {
            window.addSubview(&webview);
        }
        unsafe { webview.loadRequest(&req) };

        // After the settle delay: print to PDF, send the bytes + page geometry.
        let wv = webview.clone();
        let page_w = width;
        let timer_block = RcBlock::new(move |_t: core::ptr::NonNull<NSTimer>| {
            let cfg = WKPDFConfiguration::new(mtm);
            let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(page_w, WORK_HEIGHT));
            cfg.setRect(rect);

            let wv2 = wv.clone();
            let tx2 = tx.clone();
            let handler = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                wv2.removeFromSuperview();
                if !err.is_null() || data.is_null() {
                    let _ = tx2.send(Err("capture: PDF print failed".into()));
                    return;
                }
                let bytes = unsafe { (*data).to_vec() };
                let _ = tx2.send(Ok((bytes, page_w, WORK_HEIGHT)));
            });
            unsafe { wv.createPDFWithConfiguration_completionHandler(Some(&cfg), &handler) };
            core::mem::forget(handler);
        });
        unsafe {
            NSTimer::scheduledTimerWithTimeInterval_repeats_block(wait_ms / 1000.0, false, &timer_block);
        }
        core::mem::forget(timer_block);
        Ok(())
    }

    fn key_window(mtm: MainThreadMarker) -> Option<Retained<UIWindow>> {
        let app = UIApplication::sharedApplication(mtm);
        let windows = app.windows();
        for i in 0..windows.count() {
            let w = windows.objectAtIndex(i);
            if w.isKeyWindow() {
                return Some(w);
            }
        }
        (windows.count() > 0).then(|| windows.objectAtIndex(0))
    }
}

// ── The commands ───────────────────────────────────────────────────────────────

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn capture_page_pdf(app: tauri::AppHandle, spec: CaptureSpec) -> Result<VectorResult, String> {
    let (bytes, page_w, page_h) = ios::run_pdf(&app, spec)?;
    Ok(VectorResult { data: base64(&bytes), page_width: page_w, page_height: page_h })
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn capture_page(_app: tauri::AppHandle, _spec: CaptureSpec) -> Result<CaptureResult, String> {
    // Raster on iOS is deferred (see the module header); vector/SVG is the path.
    Err("Raster capture isn't available on iOS yet - export this as SVG (vector).".into())
}

// Non-iOS (Android, desktop host builds): the commands exist so the handler list
// compiles everywhere, but capture is iOS-only for now.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn capture_page(_app: tauri::AppHandle, _spec: CaptureSpec) -> Result<CaptureResult, String> {
    Err("Page capture is only available on iOS in this build.".into())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn capture_page_pdf(_app: tauri::AppHandle, _spec: CaptureSpec) -> Result<VectorResult, String> {
    Err("Vector capture is only available on iOS in this build.".into())
}
