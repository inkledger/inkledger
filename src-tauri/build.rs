fn main() {
    // App commands get permissions (allow-<name>): the server's page is a
    // remote origin and may only call what capabilities/remote.json grants.
    let commands = &[
        "list_profiles",
        "get_locale",
        "set_locale",
        "add_profile",
        "open_profile",
        "rename_profile",
        "remove_profile",
        "set_profile_info",
        "forget_server",
        "manage_profiles",
        "notification_permission",
        "request_notification_permission",
        "open_system_settings",
        "set_tray_state",
        "notify",
        "native_info",
        "set_autostart",
        "show_window",
        "lan_status",
        "lan_start",
        "lan_stop",
        "tailscale_info",
        "tailscale_serve",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
