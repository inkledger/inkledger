//! Menu bar / tray: the running timer at a glance, and its controls. The page
//! pushes the timer (`set_tray_state`); this side ticks the clock, so it stays
//! right while the window is hidden. Menu choices go back to the page as
//! `native-command` events and run the app's own mutations there.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::i18n::tr;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTimer {
    issue_key: String,
    summary: Option<String>,
    elapsed_seconds: f64,
    running: bool,
}

#[derive(Default)]
pub struct TrayState(Mutex<Option<(TrayTimer, Instant)>>);

/// h:mm of a timer, ticking from when the page reported it.
pub(crate) fn clock(elapsed_seconds: f64, running: bool, since_report: Duration) -> String {
    let s = elapsed_seconds + if running { since_report.as_secs_f64() } else { 0.0 };
    let m = (s / 60.0).floor() as u64;
    format!("{}:{:02}", m / 60, m % 60)
}

fn title(timer: &Option<(TrayTimer, Instant)>) -> Option<String> {
    timer.as_ref().map(|(t, at)| {
        let c = clock(t.elapsed_seconds, t.running, at.elapsed());
        if t.running {
            c
        } else {
            format!("❚❚ {c}")
        }
    })
}

fn menu(app: &AppHandle, timer: &Option<(TrayTimer, Instant)>) -> tauri::Result<Menu<tauri::Wry>> {
    let status = match timer {
        Some((t, _)) => match &t.summary {
            Some(s) => format!("{} · {}", t.issue_key, s.chars().take(40).collect::<String>()),
            None => t.issue_key.clone(),
        },
        None => tr("tray.none").into(),
    };
    let has = timer.is_some();
    let running = timer.as_ref().is_some_and(|(t, _)| t.running);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "tray-status", status, false, None::<&str>)?,
            &MenuItem::with_id(app, "tray-toggle", if running { tr("tray.pause") } else { tr("tray.resume") }, has, Some("Alt+Shift+P"))?,
            &MenuItem::with_id(app, "tray-stop", tr("tray.stop"), has, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "tray-quick-start", tr("tray.quick_start"), true, Some("Alt+Shift+T"))?,
            &MenuItem::with_id(app, "tray-show", tr("tray.show"), true, Some("Alt+Shift+J"))?,
            &crate::server_submenu(app, "tray-")?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "tray-quit", tr("tray.quit"), true, None::<&str>)?,
        ],
    )
}

fn refresh(app: &AppHandle, rebuild_menu: bool) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let state = app.state::<TrayState>();
    let timer = state.0.lock().map(|g| g.clone()).unwrap_or(None);
    let _ = tray.set_title(title(&timer));
    let _ = tray.set_tooltip(Some(match &timer {
        Some((t, _)) => format!("inkledger — {}", t.issue_key),
        None => "inkledger".into(),
    }));
    if rebuild_menu {
        if let Ok(m) = menu(app, &timer) {
            let _ = tray.set_menu(Some(m));
        }
    }
}

/// Show and focus the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// A command for the page (it owns the timers' logic).
pub fn command(app: &AppHandle, name: &str) {
    if matches!(name, "stop" | "quick-start") {
        show_main(app);
    }
    let _ = app.emit("native-command", name);
}

/// Rebuild the menu (profiles changed).
pub fn rebuild(app: &AppHandle) {
    refresh(app, true);
}

#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: State<TrayState>, timer: Option<TrayTimer>) {
    if let Ok(mut g) = state.0.lock() {
        *g = timer.map(|t| (t, Instant::now()));
    }
    refresh(&app, true);
}

pub fn create(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("inkledger")
        .menu(&menu(app, &None)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            // Only this menu's items: app-menu events may reach here too.
            let Some(id) = event.id().as_ref().strip_prefix("tray-") else { return };
            match id {
                "show" => show_main(app),
                "quit" => app.exit(0),
                "toggle" | "stop" | "quick-start" => command(app, id),
                id => {
                    crate::on_server_menu(app, id);
                }
            }
        })
        .build(app)?;
    // The clock ticks here, minute precision is enough.
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        refresh(&handle, false);
    });
    Ok(tray)
}

#[cfg(test)]
mod tests {
    use super::clock;
    use std::time::Duration;

    #[test]
    fn clock_ticks_only_while_running() {
        assert_eq!(clock(3_725.0, false, Duration::from_secs(600)), "1:02");
        assert_eq!(clock(3_725.0, true, Duration::from_secs(600)), "1:12");
        assert_eq!(clock(59.0, true, Duration::ZERO), "0:00");
    }
}
