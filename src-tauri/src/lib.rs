//! Native shell of inkledger: the window shows the user's server (the same web
//! app as in the browser). The local page (ui/index.html) asks for its
//! address on first run, and whenever the server can't be reached.

use std::time::Duration;

#[cfg(desktop)]
mod idle;
#[cfg(desktop)]
mod lan;
#[cfg(desktop)]
mod tailscale;
mod i18n;
mod profiles;
#[cfg(desktop)]
mod shortcuts;
#[cfg(desktop)]
mod tray;

use i18n::{fault, tr, trf};
use tauri::{AppHandle, Manager, Url};

/// Launched at login (autostart): start hidden in the menu bar.
#[cfg(desktop)]
const HIDDEN_ARG: &str = "--hidden";

/// Where the bundled pages are served: the CLI's dev server in `tauri dev`
/// (nothing is embedded then), else the app's own origin.
fn local_origin(dev_url: Option<&Url>) -> Url {
    if let Some(dev) = dev_url {
        return dev.clone();
    }
    #[cfg(any(windows, target_os = "android"))]
    let origin = "http://tauri.localhost/";
    #[cfg(not(any(windows, target_os = "android")))]
    let origin = "tauri://localhost/";
    Url::parse(origin).expect("valid local origin")
}

/// The profiles page (ui/index.html), as the main window navigates back to it.
fn local_page(app: &AppHandle, query: &str) -> Url {
    let dev = if tauri::is_dev() { app.config().build.dev_url.as_ref() } else { None };
    let mut url = local_origin(dev).join("index.html").expect("valid local page");
    url.set_query(query.strip_prefix('?').filter(|q| !q.is_empty()));
    url
}

/// This machine or a bare IP: served over plain http (no certificate).
fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// A Mac on the same Wi-Fi (private address or Bonjour name): its HTTPS uses
/// the local CA (lan.rs), which only the webview is asked to trust.
fn on_lan(host: &str) -> bool {
    host.ends_with(".local")
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_private())
}

/// Normalized server origin: http(s) only, no path, no credentials. Without a
/// scheme: http for localhost and IPs, https otherwise (Tailscale names).
fn parse_server(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        let host = raw.split(['/', ':']).next().unwrap_or_default();
        let scheme = if is_local_host(host) || raw.starts_with('[') { "http" } else { "https" };
        format!("{scheme}://{raw}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| tr("err.invalid_address").to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(tr("err.use_http").into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(tr("err.no_credentials").into());
    }
    let host = url.host_str().ok_or_else(|| tr("err.no_host").to_string())?;
    let origin = match url.port() {
        Some(p) => format!("{}://{}:{}/", url.scheme(), host, p),
        None => format!("{}://{}/", url.scheme(), host),
    };
    Url::parse(&origin).map_err(|_| tr("err.invalid_address").to_string())
}

/// The server is inkledger and answers over its scheme (TLS included):
/// `GET /api/health` → `{"status":"ok"}`. Done here, not in the page, so the
/// webview's network rules don't get in the way.
async fn reachable(server: &Url) -> Result<(), String> {
    let unreachable = |why: &str| unreachable_message(server, why);
    // The probe only reads /api/health; on the LAN the certificate is the
    // local CA's, which the webview (not this client) has been told to trust.
    let lan = on_lan(server.host_str().unwrap_or_default());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .danger_accept_invalid_certs(lan)
        .build()
        .map_err(fault)?;
    let health = server.join("api/health").map_err(fault)?;
    let res = client.get(health).send().await.map_err(|e| {
        if e.is_timeout() {
            unreachable(tr("err.no_response"))
        } else if e.is_connect() {
            unreachable(tr("err.refused"))
        } else {
            unreachable(tr("err.network"))
        }
    })?;
    if !res.status().is_success() {
        return Err(unreachable(&format!("HTTP {}", res.status().as_u16())));
    }
    let body: serde_json::Value = res.json().await.map_err(|_| tr("err.not_inkledger").to_string())?;
    if body.get("status").and_then(|s| s.as_str()) == Some("ok") {
        Ok(())
    } else {
        Err(tr("err.not_inkledger").into())
    }
}

/// Why a server can't be reached, with the hint that fits it: Tailscale only
/// for Tailscale names; a server on this machine just has to be running.
fn unreachable_message(server: &Url, why: &str) -> String {
    let host = server.host_str().unwrap_or_default();
    let place = match server.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    let key = if host.ends_with(".ts.net") {
        "err.unreachable_ts"
    } else if is_local_host(host) {
        "err.unreachable_local"
    } else {
        "err.unreachable_other"
    };
    trf(key, &[("place", &place), ("why", why)])
}

const LAN_KEY: &str = "lan";

/// Remembers the server shared on the Wi-Fi and its extra names (None: not shared).
#[cfg(desktop)]
pub(crate) fn remember_lan(app: &AppHandle, shared: Option<(&str, &[String])>) {
    use tauri_plugin_store::StoreExt;
    if let Ok(store) = app.store("settings.json") {
        match shared {
            Some((t, names)) => store.set(LAN_KEY, serde_json::json!({ "target": t, "names": names })),
            None => {
                store.delete(LAN_KEY);
            }
        }
        let _ = store.save();
    }
}

#[cfg(desktop)]
fn remembered_lan(app: &AppHandle) -> Option<(Url, Vec<String>)> {
    use tauri_plugin_store::StoreExt;
    let v = app.store("settings.json").ok()?.get(LAN_KEY)?;
    // Older versions stored just the URL.
    let target = v["target"].as_str().or(v.as_str())?;
    let names = v["names"].as_array().map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect()).unwrap_or_default();
    Some((Url::parse(target).ok()?, names))
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| tr("err.no_window").to_string())
}

/// After any change: the menus list the profiles.
fn profiles_changed(app: &AppHandle) {
    #[cfg(desktop)]
    {
        if let Ok(menu) = app_menu(app) {
            let _ = app.set_menu(menu);
        }
        tray::rebuild(app);
    }
    #[cfg(mobile)]
    let _ = app;
}

/// Language of the native side ("en" | "it").
#[tauri::command]
fn get_locale() -> &'static str {
    i18n::current().code()
}

/// The web app's language: validated, kept, and the menus/tray follow it.
#[tauri::command]
fn set_locale(app: AppHandle, locale: String) -> Result<(), String> {
    i18n::set(&app, &locale)?;
    profiles_changed(&app);
    Ok(())
}

/// The profiles and which one is open.
#[tauri::command]
fn list_profiles(app: AppHandle) -> profiles::Profiles {
    profiles::load(&app)
}

/// Check a server, make it the active profile (added if new) and open it.
async fn open_url(app: &AppHandle, raw: &str, name: Option<&str>) -> Result<(), String> {
    let server = parse_server(raw)?;
    reachable(&server).await?;
    let mut p = profiles::load(app);
    p.upsert(&server, name);
    profiles::save(app, &p)?;
    profiles_changed(app);
    main_window(app)?.navigate(server).map_err(fault)
}

/// Add (or rename) a profile and open it — the connect page.
#[tauri::command]
async fn add_profile(app: AppHandle, url: String, name: Option<String>) -> Result<(), String> {
    open_url(&app, &url, name.as_deref()).await
}

/// Switch to a saved profile.
#[tauri::command]
async fn open_profile(app: AppHandle, url: String) -> Result<(), String> {
    open_url(&app, &url, None).await
}

#[tauri::command]
fn rename_profile(app: AppHandle, url: String, name: String) -> Result<(), String> {
    let mut p = profiles::load(&app);
    if !p.rename(&url, &name) {
        return Err(tr("err.invalid_name").into());
    }
    profiles::save(&app, &p)?;
    profiles_changed(&app);
    Ok(())
}

#[tauri::command]
fn remove_profile(app: AppHandle, url: String) -> Result<(), String> {
    let mut p = profiles::load(&app);
    p.remove(&url);
    profiles::save(&app, &p)?;
    profiles_changed(&app);
    Ok(())
}

/// The page says who is signed in on its server: shown next to the profile.
#[tauri::command]
fn set_profile_info(app: AppHandle, webview: tauri::Webview, user: String, jira: String) -> Result<(), String> {
    let url = webview.url().map_err(fault)?;
    let mut p = profiles::load(&app);
    let Some(profile) = p.get_mut(&profiles::key(&parse_server(url.as_str())?)) else { return Ok(()) };
    if profile.user.as_deref() == Some(user.as_str()) && profile.jira.as_deref() == Some(jira.as_str()) {
        return Ok(());
    }
    profile.user = Some(user);
    profile.jira = Some(jira);
    profiles::save(&app, &p)?;
    profiles_changed(&app);
    Ok(())
}

/// Sign-out from the app (the page has ended the session): this server's
/// profile is removed, the others keep theirs; back to the profiles page.
#[tauri::command]
fn forget_server(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    let url = webview.url().map_err(fault)?;
    let mut p = profiles::load(&app);
    p.remove(&profiles::key(&parse_server(url.as_str())?));
    profiles::save(&app, &p)?;
    profiles_changed(&app);
    main_window(&app)?.navigate(local_page(&app, "?change=1")).map_err(fault)
}

/// The start page with the profiles, to add the first one (or pick another).
#[tauri::command]
fn manage_profiles(app: AppHandle) -> Result<(), String> {
    change_server(&app, None);
    Ok(())
}

/// The server the window shows now (its origin), if it shows one.
fn current_server(app: &AppHandle) -> Option<Url> {
    let url = main_window(app).ok()?.url().ok()?;
    let here = local_page(app, "");
    if url.origin() == here.origin() || !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    parse_server(url.as_str()).ok()
}

/// Menu "Manage servers…": the servers live in the app's Settings; the
/// start page only when no server is open.
fn manage_servers(app: &AppHandle) {
    match current_server(app).and_then(|s| s.join("settings/servers").ok()) {
        Some(url) => {
            if let Ok(window) = main_window(app) {
                let _ = window.navigate(url);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        None => change_server(app, None),
    }
}

/// To the start page, optionally telling why; it offers the way back to the
/// server the window came from.
fn change_server(app: &AppHandle, error: Option<&str>) {
    let from = current_server(app).or_else(|| {
        profiles::load(app).active.and_then(|a| Url::parse(&a).ok())
    });
    let mut url = local_page(app, "?change=1");
    if let Some(e) = error {
        url.query_pairs_mut().append_pair("error", e);
    }
    if let Some(from) = from {
        url.query_pairs_mut().append_pair("from", from.as_str().trim_end_matches('/'));
    }
    if let Ok(window) = main_window(app) {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Switch from a menu: on failure the profiles page says why.
#[cfg(desktop)]
fn switch_from_menu(app: &AppHandle, url: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = open_url(&app, &url, None).await {
            change_server(&app, Some(&e));
        }
    });
}

/// "Server" menu: one entry per profile (the open one ticked), then manage.
/// `prefix` keeps the app menu's and the tray's item ids apart.
#[cfg(desktop)]
pub(crate) fn server_submenu(app: &AppHandle, prefix: &str) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    let p = profiles::load(app);
    let menu = Submenu::with_id(app, format!("{prefix}server"), tr("menu.server"), true)?;
    for profile in &p.list {
        let label = match &profile.user {
            Some(u) => format!("{} — {}", profile.name, u),
            None => profile.name.clone(),
        };
        let active = p.active.as_deref() == Some(profile.url.as_str());
        menu.append(&CheckMenuItem::with_id(app, format!("{prefix}profile:{}", profile.url), label, true, active, None::<&str>)?)?;
    }
    if !p.list.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, format!("{prefix}change-server"), tr("menu.manage"), true, None::<&str>)?)?;
    Ok(menu)
}

#[cfg(desktop)]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuItem, Submenu};
    let menu = tauri::menu::Menu::default(app)?;
    // The window has no browser buttons: Back/Forward live here (⌘[ ⌘]).
    let go = Submenu::with_items(
        app,
        tr("menu.go"),
        true,
        &[
            &MenuItem::with_id(app, "app-back", tr("menu.back"), true, Some("CmdOrCtrl+["))?,
            &MenuItem::with_id(app, "app-forward", tr("menu.forward"), true, Some("CmdOrCtrl+]"))?,
        ],
    )?;
    menu.append(&go)?;
    menu.append(&server_submenu(app, "app-")?)?;
    Ok(menu)
}

/// Back/forward in the window's own history (the app keeps its place).
#[cfg(desktop)]
fn history_step(app: &AppHandle, back: bool) {
    if let Ok(w) = main_window(app) {
        let _ = w.eval(if back { "history.back()" } else { "history.forward()" });
    }
}

/// A "Server" menu choice (id without its prefix); false if it isn't one.
#[cfg(desktop)]
pub(crate) fn on_server_menu(app: &AppHandle, id: &str) -> bool {
    if id == "change-server" {
        manage_servers(app);
        true
    } else if let Some(url) = id.strip_prefix("profile:") {
        switch_from_menu(app, url.to_string());
        true
    } else {
        false
    }
}

/// Native permissions as far as the system tells them: "granted",
/// "denied", "prompt" (not asked yet) or "unknown" (the system doesn't say).
#[tauri::command]
fn notification_permission(app: AppHandle) -> String {
    #[cfg(target_os = "macos")]
    {
        // The desktop plugin always says "granted"; macOS decides silently.
        let _ = app;
        "unknown".into()
    }
    #[cfg(not(target_os = "macos"))]
    match tauri_plugin_notification::NotificationExt::notification(&app).permission_state() {
        Ok(tauri_plugin_notification::PermissionState::Granted) => "granted".into(),
        Ok(tauri_plugin_notification::PermissionState::Denied) => "denied".into(),
        Ok(_) => "prompt".into(),
        Err(_) => "unknown".into(),
    }
}

#[tauri::command]
fn request_notification_permission(app: AppHandle) -> String {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    match app.notification().request_permission() {
        Ok(PermissionState::Granted) => "granted".into(),
        Ok(PermissionState::Denied) => "denied".into(),
        Ok(_) => "prompt".into(),
        Err(_) => "unknown".into(),
    }
}

/// System settings panes the permissions guide links to (fixed list: the
/// page can't open arbitrary URLs).
fn settings_url(pane: &str) -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    return match pane {
        "notifications" => Some("x-apple.systempreferences:com.apple.Notifications-Settings.extension"),
        "login-items" => Some("x-apple.systempreferences:com.apple.LoginItems-Settings.extension"),
        "keyboard" => Some("x-apple.systempreferences:com.apple.Keyboard-Settings.extension"),
        "focus" => Some("x-apple.systempreferences:com.apple.Focus-Settings.extension"),
        _ => None,
    };
    #[cfg(windows)]
    return match pane {
        "notifications" => Some("ms-settings:notifications"),
        "login-items" => Some("ms-settings:startupapps"),
        "focus" => Some("ms-settings:quiethours"),
        _ => None,
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = pane;
        None
    }
}

#[tauri::command]
fn open_system_settings(app: AppHandle, pane: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = settings_url(&pane).ok_or_else(|| tr("err.setting_unavailable").to_string())?;
    app.opener().open_url(url, None::<&str>).map_err(fault)
}

/// Bring the main window forward (the page asks, e.g. after an away stretch).
#[tauri::command]
fn show_window(app: AppHandle) {
    #[cfg(desktop)]
    tray::show_main(&app);
    #[cfg(mobile)]
    let _ = app;
}

/// A system notification (Notification Center on macOS).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title);
    if let Some(body) = body {
        n = n.body(body);
    }
    n.show().map_err(fault)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutInfo {
    keys: &'static str,
    label: &'static str,
    ok: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInfo {
    version: String,
    /// "macos", "windows", "linux", "ios", "android".
    platform: &'static str,
    desktop: bool,
    autostart: Option<bool>,
    shortcuts: Vec<ShortcutInfo>,
}

/// What the Settings page shows about the app.
#[tauri::command]
fn native_info(app: AppHandle) -> NativeInfo {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let failed = app.state::<shortcuts::Failed>();
        let failed = failed.0.lock().map(|f| f.clone()).unwrap_or_default();
        NativeInfo {
            version: app.package_info().version.to_string(),
            platform: std::env::consts::OS,
            desktop: true,
            autostart: app.autolaunch().is_enabled().ok(),
            shortcuts: shortcuts::ALL
                .iter()
                .map(|s| ShortcutInfo { keys: s.keys, label: tr(s.label), ok: !failed.contains(&s.keys) })
                .collect(),
        }
    }
    #[cfg(mobile)]
    NativeInfo { version: app.package_info().version.to_string(), platform: std::env::consts::OS, desktop: false, autostart: None, shortcuts: vec![] }
}

/// Open at login (hidden in the menu bar).
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    let result = {
        use tauri_plugin_autostart::ManagerExt;
        let a = app.autolaunch();
        if enabled { a.enable() } else { a.disable() }.map_err(fault)
    };
    #[cfg(mobile)]
    let result = {
        let _ = (app, enabled);
        Err(tr("err.not_on_mobile").to_string())
    };
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            get_locale,
            set_locale,
            add_profile,
            open_profile,
            rename_profile,
            remove_profile,
            set_profile_info,
            forget_server,
            manage_profiles,
            notification_permission,
            request_notification_permission,
            open_system_settings,
            notify,
            native_info,
            set_autostart,
            show_window,
            #[cfg(desktop)]
            tray::set_tray_state,
            #[cfg(desktop)]
            lan::lan_status,
            #[cfg(desktop)]
            lan::lan_start,
            #[cfg(desktop)]
            lan::lan_stop,
            #[cfg(desktop)]
            tailscale::tailscale_info,
            #[cfg(desktop)]
            tailscale::tailscale_serve,
        ]);

    // Desktop: one instance (opens maximized, tauri.conf.json), launch at login,
    // a "Server" menu, the menu bar timer, global shortcuts and system idle.
    // Closing the window keeps the app in the menu bar.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .manage(tray::TrayState::default())
        .manage(lan::LanState::default())
        .manage(shortcuts::Failed::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            i18n::init(app.handle());
            app.set_menu(app_menu(app.handle())?)?;
            app.on_menu_event(|app, event| {
                match event.id().as_ref().strip_prefix("app-") {
                    Some("back") => history_step(app, true),
                    Some("forward") => history_step(app, false),
                    Some(id) => {
                        on_server_menu(app, id);
                    }
                    None => {}
                }
            });
            tray::create(app.handle())?;
            shortcuts::register(app.handle())?;
            idle::spawn(app.handle().clone());
            // Shared on the Wi-Fi last time: share again.
            if let Some((target, names)) = remembered_lan(app.handle()) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<lan::LanState>();
                    if let Err(e) = lan::start(&handle, &state, target, &names).await {
                        eprintln!("[lan] not restarted: {e}");
                    }
                });
            }
            // Started at login: stay in the menu bar.
            if std::env::args().any(|a| a == HIDDEN_ARG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        });

    #[cfg(mobile)]
    let builder = builder.setup(|app| {
        i18n::init(app.handle());
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building inkledger");
    app.run(|_app, _event| {
        // Dock icon clicked with the window hidden: show it again.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            tray::show_main(_app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::parse_server;

    #[test]
    fn normalizes_server_addresses() {
        assert_eq!(parse_server("mac.tail1234.ts.net").unwrap().as_str(), "https://mac.tail1234.ts.net/");
        assert_eq!(parse_server("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert_eq!(parse_server("127.0.0.1:47823").unwrap().as_str(), "http://127.0.0.1:47823/");
        // Another Mac on the Wi-Fi: HTTPS through its local CA.
        assert_eq!(parse_server("192.168.1.20:47843").unwrap().as_str(), "https://192.168.1.20:47843/");
        assert_eq!(parse_server("My-Mac.local:47843").unwrap().as_str(), "https://my-mac.local:47843/");
        assert_eq!(parse_server(" http://127.0.0.1:47823/board ").unwrap().as_str(), "http://127.0.0.1:47823/");
        assert!(parse_server("ftp://x").is_err());
        assert!(parse_server("https://u:p@x.ts.net").is_err());
        assert!(parse_server("").is_err());
    }

    /// One-shot HTTP server answering `body` on 127.0.0.1.
    fn serve_once(body: &'static str) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        port
    }

    #[test]
    fn local_page_follows_the_dev_server() {
        let dev = tauri::Url::parse("http://localhost:1430/").unwrap();
        assert_eq!(super::local_origin(Some(&dev)).join("index.html").unwrap().as_str(), "http://localhost:1430/index.html");
        let bundled = super::local_origin(None).join("index.html").unwrap();
        assert!(bundled.as_str().ends_with("localhost/index.html"), "{bundled}");
    }

    #[test]
    fn hints_tailscale_only_for_tailscale_names() {
        let msg = |u: &str| super::unreachable_message(&parse_server(u).unwrap(), "x");
        assert!(msg("localhost:3000").contains("localhost:3000 is unreachable"));
        assert!(!msg("localhost:3000").contains("Tailscale"));
        assert!(!msg("127.0.0.1:47823").contains("Tailscale"));
        assert!(msg("my-mac.tail1.ts.net").contains("Tailscale"));
        assert!(!msg("jira.example.com").contains("Tailscale"));
    }

    #[test]
    fn probes_the_health_endpoint() {
        let check = |url: &str| tauri::async_runtime::block_on(super::reachable(&parse_server(url).unwrap()));
        let ok = serve_once(r#"{"status":"ok"}"#);
        assert!(check(&format!("http://127.0.0.1:{ok}")).is_ok());
        let other = serve_once(r#"{"hello":1}"#);
        assert!(check(&format!("http://127.0.0.1:{other}")).is_err());
        // Plain-http server reached over https: TLS fails, no hang.
        let plain = serve_once(r#"{"status":"ok"}"#);
        assert!(check(&format!("https://127.0.0.1:{plain}")).is_err());
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(check(&format!("http://127.0.0.1:{closed}")).is_err());
    }
}
