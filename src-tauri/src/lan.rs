//! Local network sharing (desktop, no Tailscale): phones on the same Wi-Fi
//! reach this Mac's inkledger server over HTTPS.
//!
//! - A local CA ("inkledger — <Mac>") is created once and kept in the app's data
//!   folder; a phone trusts it once (profile on iPhone, CA cert on Android).
//! - Each start issues a server certificate for `<Mac>.local` and the Mac's
//!   current LAN addresses, signed by that CA.
//! - A TLS proxy on :47843 forwards the bytes to the shared server
//!   (a loopback one, e.g. 127.0.0.1:47823); a plain HTTP welcome page on
//!   :47844 hands out the CA and the steps.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::i18n::{fault, tr, trf};

pub const TLS_PORT: u16 = 47843;
pub const WELCOME_PORT: u16 = 47844;
const CA_CERT: &str = "lan-ca.pem";
const CA_KEY: &str = "lan-ca-key.pem";

/// The local certificate authority (PEM), created once.
pub struct Ca {
    pub cert_pem: String,
    key_pem: String,
}

fn ca_name(mac: &str) -> String {
    format!("inkledger — {mac}")
}

pub fn create_ca(mac: &str) -> Result<Ca, String> {
    let key = KeyPair::generate().map_err(fault)?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(fault)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, ca_name(mac));
    dn.push(DnType::OrganizationName, "inkledger");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    params.not_before = rcgen::date_time_ymd(2025, 1, 1);
    params.not_after = rcgen::date_time_ymd(2035, 1, 1);
    let cert = params.self_signed(&key).map_err(fault)?;
    Ok(Ca { cert_pem: cert.pem(), key_pem: key.serialize_pem() })
}

/// The CA in `dir`, created there the first time.
pub fn load_or_create_ca(dir: &Path, mac: &str) -> Result<Ca, String> {
    let (cert, key) = (dir.join(CA_CERT), dir.join(CA_KEY));
    if let (Ok(cert_pem), Ok(key_pem)) = (std::fs::read_to_string(&cert), std::fs::read_to_string(&key)) {
        return Ok(Ca { cert_pem, key_pem });
    }
    std::fs::create_dir_all(dir).map_err(fault)?;
    let ca = create_ca(mac)?;
    std::fs::write(&cert, &ca.cert_pem).map_err(fault)?;
    std::fs::write(&key, &ca.key_pem).map_err(fault)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600));
    }
    Ok(ca)
}

/// A server certificate for these names and addresses (≤ 397 days, as phones require).
pub fn issue_server_cert(ca: &Ca, names: &[String], ips: &[IpAddr]) -> Result<(String, String), String> {
    let ca_key = KeyPair::from_pem(&ca.key_pem).map_err(fault)?;
    let issuer = Issuer::from_ca_cert_pem(&ca.cert_pem, ca_key).map_err(fault)?;
    let key = KeyPair::generate().map_err(fault)?;
    let mut params = CertificateParams::new(names.to_vec()).map_err(fault)?;
    params.subject_alt_names.extend(ips.iter().map(|ip| SanType::IpAddress(*ip)));
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, names.first().cloned().unwrap_or_else(|| "inkledger".into()));
    params.distinguished_name = dn;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let now = time_now();
    params.not_before = now - std::time::Duration::from_secs(86_400);
    params.not_after = now + std::time::Duration::from_secs(397 * 86_400);
    let cert = params.signed_by(&key, &issuer).map_err(fault)?;
    Ok((cert.pem(), key.serialize_pem()))
}

fn time_now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

/// SHA-256 of the CA certificate, "AB:CD:…", to compare on the phone.
pub fn fingerprint(cert_pem: &str) -> String {
    let der = pem_der(cert_pem).unwrap_or_default();
    let digest = ring::digest::digest(&ring::digest::SHA256, &der);
    digest.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn pem_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// iPhone configuration profile installing the CA (then trusted by hand).
pub fn mobileconfig(cert_pem: &str, mac: &str) -> String {
    let der = base64::engine::general_purpose::STANDARD.encode(pem_der(cert_pem).unwrap_or_default());
    let fp = fingerprint(cert_pem).replace(':', "");
    let uuid = |n: &str| format!("{}-{}-4{}-8{}-{}", &fp[0..8], &fp[8..12], &fp[13..16], &fp[17..20], n);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>ikl-ca.cer</string>
<key>PayloadContent</key><data>{der}</data>
<key>PayloadDisplayName</key><string>{name}</string>
<key>PayloadIdentifier</key><string>io.github.inkledger.app.ca.cert</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>{u1}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>{name}</string>
<key>PayloadDescription</key><string>{desc}</string>
<key>PayloadIdentifier</key><string>io.github.inkledger.app.ca</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>{u2}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
"#,
        name = ca_name(mac),
        desc = tr("lan.profile_desc"),
        u1 = uuid("000000000001"),
        u2 = uuid("000000000002"),
    )
}

/// The Mac's LAN IPv4 addresses (no loopback, link-local or Tailscale ranges).
pub fn lan_ips() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| matches!(ip, IpAddr::V4(v4) if is_lan(v4)))
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

/// Private ranges a Wi-Fi gives out (not Tailscale's 100.64/10).
pub fn is_lan(ip: &Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback()
}

/// "My-Mac" (Bonjour name: reachable as My-Mac.local), if known.
pub fn local_host_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("scutil").args(["--get", "LocalHostName"]).output().ok()?;
        let name = String::from_utf8(out.stdout).ok()?.trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

// ---------- running ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    running: bool,
    /// The shared server (loopback origin).
    target: Option<String>,
    /// https://<addr>:47843 for each LAN name / address.
    addresses: Vec<String>,
    /// http://<ip>:47844: the CA and the steps, for a phone's first visit.
    welcome: Option<String>,
    fingerprint: Option<String>,
    error: Option<String>,
}

struct Running {
    status: LanStatus,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct LanState(Mutex<Option<Running>>);

fn stopped(error: Option<String>) -> LanStatus {
    LanStatus { running: false, target: None, addresses: vec![], welcome: None, fingerprint: None, error }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(fault)
}

/// Only a server on this machine can be shared (the proxy dials loopback).
fn loopback_target(url: &Url) -> Result<SocketAddr, String> {
    let host = url.host_str().unwrap_or_default();
    let ip: IpAddr = match host {
        "localhost" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        h => h.trim_matches(['[', ']']).parse().map_err(|_| tr("lan.only_this_mac").to_string())?,
    };
    if !ip.is_loopback() || url.scheme() != "http" {
        return Err(tr("lan.only_localhost").into());
    }
    Ok(SocketAddr::new(ip, url.port_or_known_default().unwrap_or(80)))
}

/// `extra` are the user's own DNS names for this Mac (Settings → Dispositivi).
pub async fn start(app: &AppHandle, state: &LanState, target: Url, extra: &[String]) -> Result<LanStatus, String> {
    stop(state);
    let upstream = loopback_target(&target)?;
    let mac = local_host_name().unwrap_or_else(|| "Mac".into());
    let ca = load_or_create_ca(&data_dir(app)?, &mac)?;
    let ips = lan_ips();
    if ips.is_empty() {
        return Err(tr("lan.no_network").into());
    }
    let mut names: Vec<String> = local_host_name().map(|n| vec![format!("{n}.local")]).unwrap_or_default();
    names.extend(extra.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()));
    names.dedup();
    let (cert_pem, key_pem) = issue_server_cert(&ca, &names, &ips)?;

    let tls = tls_acceptor(&cert_pem, &key_pem, &ca.cert_pem)?;
    let proxy = TcpListener::bind(("0.0.0.0", TLS_PORT)).await.map_err(|e| trf("lan.port_busy", &[("port", &TLS_PORT.to_string()), ("err", &e.to_string())]))?;
    let welcome_l = TcpListener::bind(("0.0.0.0", WELCOME_PORT))
        .await
        .map_err(|e| trf("lan.port_busy", &[("port", &WELCOME_PORT.to_string()), ("err", &e.to_string())]))?;

    let hosts: Vec<String> = names.iter().cloned().chain(ips.iter().map(|ip| ip.to_string())).collect();
    let first_ip = ips[0].to_string();
    let status = LanStatus {
        running: true,
        target: Some(target.as_str().trim_end_matches('/').to_string()),
        addresses: hosts.iter().map(|h| format!("https://{h}:{TLS_PORT}")).collect(),
        welcome: Some(format!("http://{first_ip}:{WELCOME_PORT}")),
        fingerprint: Some(fingerprint(&ca.cert_pem)),
        error: None,
    };
    let page = Arc::new(Welcome { ca_pem: ca.cert_pem.clone(), mac, hosts, fingerprint: fingerprint(&ca.cert_pem) });
    let tasks = vec![
        tauri::async_runtime::spawn(serve_proxy(proxy, tls, upstream)),
        tauri::async_runtime::spawn(serve_welcome(welcome_l, page)),
    ];
    *state.0.lock().map_err(fault)? = Some(Running { status: status.clone(), tasks });
    Ok(status)
}

pub fn stop(state: &LanState) {
    if let Ok(mut g) = state.0.lock() {
        if let Some(r) = g.take() {
            for t in r.tasks {
                t.abort();
            }
        }
    }
}

pub fn status(state: &LanState) -> LanStatus {
    state.0.lock().ok().and_then(|g| g.as_ref().map(|r| r.status.clone())).unwrap_or_else(|| stopped(None))
}

fn tls_acceptor(cert_pem: &str, key_pem: &str, ca_pem: &str) -> Result<tokio_rustls::TlsAcceptor, String> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let chain = vec![
        CertificateDer::from(pem_der(cert_pem).ok_or_else(|| tr("lan.bad_cert").to_string())?),
        CertificateDer::from(pem_der(ca_pem).ok_or_else(|| tr("lan.bad_ca").to_string())?),
    ];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pem_der(key_pem).ok_or_else(|| tr("lan.bad_key").to_string())?));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(fault)?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(fault)?;
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

/// TLS in, plain bytes to the server: the server sees the real Host header.
async fn serve_proxy(listener: TcpListener, tls: tokio_rustls::TlsAcceptor, upstream: SocketAddr) {
    loop {
        let Ok((socket, _)) = listener.accept().await else { continue };
        let tls = tls.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(mut client) = tls.accept(socket).await else { return };
            let Ok(mut server) = TcpStream::connect(upstream).await else { return };
            let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
        });
    }
}

struct Welcome {
    ca_pem: String,
    mac: String,
    hosts: Vec<String>,
    fingerprint: String,
}

async fn serve_welcome(listener: TcpListener, page: Arc<Welcome>) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { continue };
        let page = page.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let Ok(n) = tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut buf)).await else {
                return;
            };
            let req = String::from_utf8_lossy(&buf[..n.unwrap_or(0)]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (ctype, body, file) = welcome_response(&page, &path);
            let disposition = file.map(|f| format!("Content-Disposition: attachment; filename=\"{f}\"\r\n")).unwrap_or_default();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n{disposition}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        });
    }
}

/// What the welcome server answers: the CA (two formats) or the steps.
fn welcome_response(page: &Welcome, path: &str) -> (&'static str, Vec<u8>, Option<&'static str>) {
    match path {
        "/ikl.mobileconfig" => (
            "application/x-apple-aspen-config",
            mobileconfig(&page.ca_pem, &page.mac).into_bytes(),
            Some("ikl.mobileconfig"),
        ),
        "/ikl-ca.crt" => ("application/x-x509-ca-cert", pem_der(&page.ca_pem).unwrap_or_default(), Some("ikl-ca.crt")),
        _ => ("text/html; charset=utf-8", welcome_html(page).into_bytes(), None),
    }
}

fn welcome_html(page: &Welcome) -> String {
    let links: String = page
        .hosts
        .iter()
        .map(|h| format!(r#"<li><a href="https://{h}:{TLS_PORT}/install">https://{h}:{TLS_PORT}</a></li>"#))
        .collect();
    format!(
        r#"<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>body{{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#f3f1f0;color:#1a1614}}
main{{max-width:520px;margin:auto;background:#fff;border:1px solid #ebe6e3;border-radius:16px;padding:20px 22px}}
h1{{font-size:22px;margin:0 0 4px}}h2{{font-size:15px;margin:18px 0 6px}}p,li{{color:#5b524d}}
a.btn{{display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border-radius:9px;background:#3f2a22;color:#fff;text-decoration:none;font-weight:600}}
code{{font-size:12px;word-break:break-all}}@media(prefers-color-scheme:dark){{body{{background:#0e0d0c;color:#f1ece9}}main{{background:#171514;border-color:#2b2826}}p,li{{color:#a59a93}}a.btn{{background:#f0c9b6;color:#1a1614}}}}</style></head>
<body><main><h1>{title}</h1><p>{intro}</p>
<h2>{step1}</h2>
<a class="btn" href="/ikl.mobileconfig">iPhone / iPad</a><a class="btn" href="/ikl-ca.crt">Android</a>
<p>{ios}</p>
<p>{android}</p>
<p>{fingerprint}<br><code>{fp}</code></p>
<h2>{step2}</h2><ul>{links}</ul>
<p>{note}</p>
</main></body></html>"#,
        lang = crate::i18n::current().code(),
        title = tr("welcome.title"),
        intro = trf("welcome.intro", &[("mac", &html(&page.mac))]),
        step1 = tr("welcome.step1"),
        ios = trf("welcome.ios", &[("ca", &html(&ca_name(&page.mac)))]),
        android = tr("welcome.android"),
        fingerprint = tr("welcome.fingerprint"),
        step2 = tr("welcome.step2"),
        note = tr("welcome.note"),
        fp = page.fingerprint,
    )
}

fn html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ---------- commands ----------

#[tauri::command]
pub fn lan_status(state: State<LanState>) -> LanStatus {
    status(&state)
}

/// Shares the server the window shows (it must be on this Mac).
#[tauri::command]
pub async fn lan_start(app: AppHandle, webview: tauri::Webview, names: Option<Vec<String>>) -> Result<LanStatus, String> {
    let url = webview.url().map_err(fault)?;
    let origin = Url::parse(&url.origin().ascii_serialization()).map_err(fault)?;
    let names = names.unwrap_or_default();
    let state = app.state::<LanState>();
    let s = start(&app, &state, origin.clone(), &names).await?;
    crate::remember_lan(&app, Some((origin.as_str(), &names)));
    Ok(s)
}

#[tauri::command]
pub fn lan_stop(app: AppHandle, state: State<LanState>) -> LanStatus {
    stop(&state);
    crate::remember_lan(&app, None);
    status(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issues_a_server_cert_signed_by_the_ca() {
        let dir = std::env::temp_dir().join(format!("ikl-lan-{}", std::process::id()));
        let ca = load_or_create_ca(&dir, "Test").unwrap();
        // The same CA next time: phones trust it once.
        assert_eq!(load_or_create_ca(&dir, "Test").unwrap().cert_pem, ca.cert_pem);
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        let (cert, key) = issue_server_cert(&ca, &["mac.local".into()], &[ip]).unwrap();
        assert!(cert.starts_with("-----BEGIN CERTIFICATE-----"));
        // rustls accepts the chain and key.
        assert!(tls_acceptor(&cert, &key, &ca.cert_pem).is_ok());
        assert_eq!(fingerprint(&ca.cert_pem).split(':').count(), 32);
        let profile = mobileconfig(&ca.cert_pem, "Test");
        assert!(profile.contains("com.apple.security.root") && profile.contains("<data>"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shares_only_a_server_on_this_mac() {
        assert!(loopback_target(&Url::parse("http://127.0.0.1:47823").unwrap()).is_ok());
        assert!(loopback_target(&Url::parse("http://localhost:3000").unwrap()).is_ok());
        assert!(loopback_target(&Url::parse("https://mac.tail1.ts.net").unwrap()).is_err());
        assert!(loopback_target(&Url::parse("http://192.168.1.4:47823").unwrap()).is_err());
    }

    #[test]
    fn lan_ranges() {
        assert!(is_lan(&"192.168.1.20".parse().unwrap()));
        assert!(is_lan(&"10.0.0.5".parse().unwrap()));
        assert!(!is_lan(&"100.101.1.2".parse().unwrap()));
        assert!(!is_lan(&"127.0.0.1".parse().unwrap()));
    }

    /// End to end: a TLS client trusting only our CA reaches a plain server through the proxy.
    #[test]
    fn proxies_tls_to_the_server() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("ikl-lan-e2e-{}", std::process::id()));
            let ca = load_or_create_ca(&dir, "Test").unwrap();
            let (cert, key) = issue_server_cert(&ca, &["localhost".into()], &[]).unwrap();
            // Upstream: answers one HTTP request.
            let up = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let up_addr = up.local_addr().unwrap();
            tauri::async_runtime::spawn(async move {
                let (mut s, _) = up.accept().await.unwrap();
                let mut b = [0u8; 1024];
                let _ = s.read(&mut b).await;
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
            });
            let front = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let front_addr = front.local_addr().unwrap();
            tauri::async_runtime::spawn(serve_proxy(front, tls_acceptor(&cert, &key, &ca.cert_pem).unwrap(), up_addr));

            let mut roots = rustls::RootCertStore::empty();
            roots.add(rustls::pki_types::CertificateDer::from(pem_der(&ca.cert_pem).unwrap())).unwrap();
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
            let tcp = TcpStream::connect(front_addr).await.unwrap();
            let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
            let mut tls = connector.connect(name, tcp).await.unwrap();
            tls.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let mut out = String::new();
            tls.read_to_string(&mut out).await.ok();
            assert!(out.ends_with("ok"), "{out}");
            let _ = std::fs::remove_dir_all(dir);
        });
    }
}
