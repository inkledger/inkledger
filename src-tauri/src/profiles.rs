//! Server profiles: each one an inkledger server (its own Jira and user), e.g.
//! localhost:3000 and localhost:47823, or two Macs on Tailscale. One is
//! active and shown in the window; switching is a navigation, and every
//! server keeps its own session (its cookie name carries the port).

use crate::i18n::fault;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const KEY: &str = "profiles";
/// Before profiles: one saved server.
const LEGACY_KEY: &str = "server";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Normalized origin, also the id ("http://localhost:3000").
    pub url: String,
    pub name: String,
    /// Who is signed in there and on which Jira (told by the page).
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub jira: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub list: Vec<Profile>,
    pub active: Option<String>,
}

/// Origin as stored: no trailing slash.
pub fn key(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// "my-mac" for a Tailscale name, else host[:port].
pub fn default_name(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_suffix(".ts.net").and_then(|h| h.split('.').next()).unwrap_or(host);
    match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

impl Profiles {
    /// Adds (or renames) the profile for `url` and makes it active.
    pub fn upsert(&mut self, url: &Url, name: Option<&str>) {
        let id = key(url);
        let name = name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        match self.list.iter_mut().find(|p| p.url == id) {
            Some(p) => {
                if let Some(n) = name {
                    p.name = n;
                }
            }
            None => self.list.push(Profile { url: id.clone(), name: name.unwrap_or_else(|| default_name(url)), user: None, jira: None }),
        }
        self.active = Some(id);
    }

    pub fn remove(&mut self, id: &str) {
        self.list.retain(|p| p.url != id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
    }

    /// New name for a profile; false if it doesn't exist or the name is blank.
    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        let name = name.trim();
        match self.get_mut(id) {
            Some(p) if !name.is_empty() => {
                p.name = name.chars().take(60).collect();
                true
            }
            _ => false,
        }
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Profile> {
        self.list.iter_mut().find(|p| p.url == id)
    }
}

pub fn load(app: &AppHandle) -> Profiles {
    let Ok(store) = app.store(STORE) else { return Profiles::default() };
    if let Some(p) = store.get(KEY).and_then(|v| serde_json::from_value::<Profiles>(v).ok()) {
        return p;
    }
    // One server saved by an older version: it becomes the first profile.
    let mut profiles = Profiles::default();
    if let Some(url) = store.get(LEGACY_KEY).and_then(|v| v.as_str().and_then(|s| Url::parse(s).ok())) {
        profiles.upsert(&url, None);
    }
    profiles
}

pub fn save(app: &AppHandle, profiles: &Profiles) -> Result<(), String> {
    let store = app.store(STORE).map_err(fault)?;
    store.set(KEY, serde_json::to_value(profiles).map_err(fault)?);
    store.delete(LEGACY_KEY);
    store.save().map_err(fault)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn names_and_dedupes_profiles() {
        let mut p = Profiles::default();
        p.upsert(&u("http://localhost:3000/"), None);
        p.upsert(&u("https://my-mac.tail1234.ts.net/"), Some(" Work "));
        p.upsert(&u("http://localhost:3000/"), Some("Dev"));
        assert_eq!(p.list.len(), 2);
        assert_eq!(p.list[0].name, "Dev");
        assert_eq!(p.list[1].name, "Work");
        assert_eq!(p.active.as_deref(), Some("http://localhost:3000"));
        assert_eq!(default_name(&u("https://my-mac.tail1234.ts.net/")), "my-mac");
        assert_eq!(default_name(&u("http://localhost:47823/")), "localhost:47823");
    }

    #[test]
    fn renames_only_with_a_real_name() {
        let mut p = Profiles::default();
        p.upsert(&u("http://localhost:3000/"), None);
        assert!(p.rename("http://localhost:3000", "  Dev  "));
        assert_eq!(p.list[0].name, "Dev");
        assert!(!p.rename("http://localhost:3000", "   "));
        assert!(!p.rename("http://localhost:9", "X"));
    }

    #[test]
    fn removing_the_active_profile_clears_it() {
        let mut p = Profiles::default();
        p.upsert(&u("http://localhost:3000/"), None);
        p.upsert(&u("http://localhost:47823/"), None);
        p.remove("http://localhost:47823");
        assert_eq!(p.active, None);
        assert_eq!(p.list.len(), 1);
    }
}
