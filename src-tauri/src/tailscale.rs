//! Tailscale on this Mac, driven from the app (Settings → Dispositivi): is
//! it installed and connected, what is the Mac's name, is `serve` publishing
//! the server — and turning `serve` on without a terminal.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::i18n::{fault, tr, trf};

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    installed: bool,
    /// Logged in and connected.
    running: bool,
    /// "my-mac.tail1234.ts.net"
    dns_name: Option<String>,
    /// HTTPS certificates enabled in the tailnet (needed by `serve`).
    https: bool,
    /// What `serve` publishes: one entry per https port of the Mac's name.
    serves: Vec<Served>,
}

/// https://<name>:<port>/ → target (e.g. 47823 → "http://127.0.0.1:47823").
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Served {
    port: u16,
    target: String,
}

fn binary() -> Option<String> {
    let app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    if std::path::Path::new(app).exists() {
        return Some(app.into());
    }
    Command::new("tailscale").arg("version").output().ok().filter(|o| o.status.success()).map(|_| "tailscale".into())
}

/// Reads `tailscale status --json` and `tailscale serve status --json`.
pub fn parse(status: &Value, serve: &Value) -> TailscaleInfo {
    let dns_name = status["Self"]["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string()).filter(|s| !s.is_empty());
    let https = status["CertDomains"].as_array().is_some_and(|d| !d.is_empty());
    let mut serves: Vec<Served> = serve["Web"]
        .as_object()
        .map(|web| {
            web.iter()
                .filter_map(|(site, conf)| {
                    let port = site.rsplit_once(':')?.1.parse().ok()?;
                    let target = conf["Handlers"]["/"]["Proxy"].as_str()?.to_string();
                    Some(Served { port, target })
                })
                .collect()
        })
        .unwrap_or_default();
    serves.sort_by_key(|s| s.port);
    TailscaleInfo { installed: true, running: status["BackendState"].as_str() == Some("Running"), dns_name, https, serves }
}

fn json_of(bin: &str, args: &[&str]) -> Value {
    Command::new(bin).args(args).output().ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn tailscale_info() -> TailscaleInfo {
    let Some(bin) = binary() else { return TailscaleInfo::default() };
    parse(&json_of(&bin, &["status", "--json"]), &json_of(&bin, &["serve", "status", "--json"]))
}

/// The first https URL in Tailscale's output (an approval link).
pub fn approval_link(output: &str) -> Option<String> {
    output.split_whitespace().find(|w| w.starts_with("https://")).map(str::to_string)
}

/// Publishes http://127.0.0.1:<port> on https://<Mac>.ts.net:<port>: the
/// same port as here, so each server of this Mac (dev, container) keeps its
/// own address, and a local web server on 443 can't shadow it. If Tailscale
/// first wants Serve approved in the browser, returns that link as error.
/// Serve publishes only the server the window shows from this computer, on its own port:
/// a page from elsewhere (a tailnet name, a hostile one too) can't publish this machine's
/// other services (a database, another app) by asking for their port.
pub fn serves_itself(shown: &tauri::Url, port: u16) -> bool {
    shown.scheme() == "http" && matches!(shown.host_str(), Some("127.0.0.1") | Some("localhost")) && shown.port() == Some(port)
}

#[tauri::command]
pub async fn tailscale_serve(webview: tauri::Webview, port: u16) -> Result<TailscaleInfo, String> {
    let shown = webview.url().map_err(fault)?;
    if !serves_itself(&shown, port) {
        return Err(tr("ts.only_this_server").into());
    }
    // And it is inkledger answering there, not some other program on that port.
    let local = tauri::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(fault)?;
    crate::reachable(&local).await?;
    let bin = binary().ok_or_else(|| tr("ts.not_installed").to_string())?;
    let target = format!("http://127.0.0.1:{port}");
    let https = format!("--https={port}");
    let out =
        tauri::async_runtime::spawn_blocking(move || run_with_timeout(&bin, &["serve", "--bg", &https, &target], Duration::from_secs(15)))
            .await
            .map_err(fault)??;
    let info = tailscale_info();
    if info.serves.iter().any(|s| s.port == port && s.target == format!("http://127.0.0.1:{port}")) {
        return Ok(info);
    }
    match approval_link(&out) {
        Some(link) => Err(trf("ts.approve", &[("link", &link)])),
        None if !info.https => Err(tr("ts.https_off").into()),
        None => Err(trf("ts.serve_failed", &[("out", out.trim())])),
    }
}

/// Output of a command; killed after `limit` (Serve may wait for approval).
fn run_with_timeout(bin: &str, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = Command::new(bin).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(fault)?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = stdout.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(fault)?.is_some() {
            break;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(reader.join().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    #[test]
    fn serve_only_publishes_the_local_server_the_window_shows() {
        use super::serves_itself;
        let u = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(serves_itself(&u("http://127.0.0.1:47823/settings/devices"), 47823));
        assert!(serves_itself(&u("http://localhost:3000/"), 3000));
        // Another port of this machine (a database), asked by the page.
        assert!(!serves_itself(&u("http://127.0.0.1:47823/"), 5432));
        // A page from the tailnet (or anywhere else) publishes nothing here.
        assert!(!serves_itself(&u("https://evil.tail1234.ts.net:47823/"), 47823));
        assert!(!serves_itself(&u("http://192.168.1.4:47823/"), 47823));
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn reads_status_and_serve() {
        // As `tailscale status --json` / `serve status --json` print them.
        let status = json!({
            "BackendState": "Running",
            "CertDomains": ["my-mac.tail1234.ts.net"],
            "Self": { "DNSName": "my-mac.tail1234.ts.net.", "Online": true }
        });
        let serve = json!({
            "TCP": { "443": { "HTTPS": true }, "47823": { "HTTPS": true } },
            "Web": {
                "my-mac.tail1234.ts.net:47823": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:47823" } } },
                "my-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } }
            }
        });
        let info = parse(&status, &serve);
        assert!(info.running && info.https);
        assert_eq!(info.dns_name.as_deref(), Some("my-mac.tail1234.ts.net"));
        assert_eq!(
            info.serves,
            vec![
                Served { port: 443, target: "http://127.0.0.1:3000".into() },
                Served { port: 47823, target: "http://127.0.0.1:47823".into() },
            ]
        );
        let idle = parse(&json!({ "BackendState": "Stopped", "Self": {} }), &json!({}));
        assert!(!idle.running && idle.dns_name.is_none() && idle.serves.is_empty());
    }

    #[test]
    fn finds_the_approval_link() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n";
        assert_eq!(approval_link(out).as_deref(), Some("https://login.tailscale.com/f/serve?node=abc"));
        assert_eq!(approval_link("ok"), None);
    }
}
