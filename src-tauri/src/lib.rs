mod site_fetch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        // First invoke handler this shell has had. Everything else it does is
        // fulfilled by plugins (fs, http) or by the shared web bridge; the
        // website source for the Design System studio (plans/97 section 9) is the first
        // capability that needs a command of our own, because it has to enforce
        // the first-party redirect rule and the byte caps itself.
        .invoke_handler(tauri::generate_handler![site_fetch::site_fetch])
        .run(tauri::generate_context!())
        .expect("error while running Lolly mobile");
}
