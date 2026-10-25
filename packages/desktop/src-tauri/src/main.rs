// FreeCode desktop entrypoint.
// The UI is the static shell served by packages/desktop/server.mjs (devUrl);
// production bundles ship ../public as frontendDist.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running FreeCode");
}
