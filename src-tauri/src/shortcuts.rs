//! Global shortcuts (work from any app): ⌥⇧T start a timer, ⌥⇧P pause or
//! resume, ⌥⇧J show inkledger. One taken by another app is reported in Settings.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::tray;

pub struct Def {
    pub keys: &'static str,
    /// i18n key.
    pub label: &'static str,
    code: Code,
    command: &'static str,
}

pub const ALL: &[Def] = &[
    Def { keys: "⌥⇧T", label: "shortcut.start", code: Code::KeyT, command: "quick-start" },
    Def { keys: "⌥⇧P", label: "shortcut.toggle", code: Code::KeyP, command: "toggle" },
    Def { keys: "⌥⇧J", label: "shortcut.show", code: Code::KeyJ, command: "show" },
];

/// Shortcuts that could not be registered (keys).
#[derive(Default)]
pub struct Failed(pub Mutex<Vec<&'static str>>);

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), code)
}

pub fn register(app: &AppHandle) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, pressed, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(def) = ALL.iter().find(|d| shortcut(d.code) == *pressed) {
                    match def.command {
                        "show" => tray::show_main(app),
                        c => tray::command(app, c),
                    }
                }
            })
            .build(),
    )?;
    let failed = app.state::<Failed>();
    for def in ALL {
        if app.global_shortcut().register(shortcut(def.code)).is_err() {
            if let Ok(mut f) = failed.0.lock() {
                f.push(def.keys);
            }
        }
    }
    Ok(())
}
