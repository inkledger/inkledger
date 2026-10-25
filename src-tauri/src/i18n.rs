//! Native-side texts (menus, tray, errors told to the page, the Wi-Fi welcome
//! page) in English (default) and Italian. The choice is the web app's
//! language: the page tells it with `set_locale`, it is kept in the store.

use std::sync::RwLock;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const KEY: &str = "locale";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    En,
    It,
}

impl Locale {
    pub fn parse(s: &str) -> Option<Locale> {
        match s {
            "en" => Some(Locale::En),
            "it" => Some(Locale::It),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::It => "it",
        }
    }
}

static CURRENT: RwLock<Locale> = RwLock::new(Locale::En);

pub fn current() -> Locale {
    CURRENT.read().map(|l| *l).unwrap_or(Locale::En)
}

fn set_current(locale: Locale) {
    if let Ok(mut l) = CURRENT.write() {
        *l = locale;
    }
}

/// Loads the saved language (call once at startup).
pub fn init(app: &AppHandle) {
    let saved = app.store(STORE).ok().and_then(|s| s.get(KEY)).and_then(|v| v.as_str().and_then(Locale::parse));
    if let Some(l) = saved {
        set_current(l);
    }
}

/// Validates, remembers and applies a language.
pub fn set(app: &AppHandle, locale: &str) -> Result<Locale, String> {
    let l = Locale::parse(locale).ok_or_else(|| format!("unsupported locale: {locale}"))?;
    let store = app.store(STORE).map_err(fault)?;
    store.set(KEY, l.code());
    store.save().map_err(fault)?;
    set_current(l);
    Ok(l)
}

/// Text for `key` in the current language.
pub fn tr(key: &str) -> &'static str {
    lookup(current(), key)
}

/// Text with `{name}` placeholders filled.
pub fn trf(key: &str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(tr(key).to_string(), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
}

/// A fault of this device (a file, the store, a certificate, the window) as the page
/// tells it: in the user's language, the system's own words kept after it (there is no
/// server log to look them up in; a caller that only logs it logs these words).
pub fn fault(e: impl std::fmt::Display) -> String {
    trf("err.system", &[("err", &e.to_string())])
}

fn lookup(locale: Locale, key: &str) -> &'static str {
    match TABLE.iter().find(|(k, _, _)| *k == key) {
        Some((_, en, it)) => match locale {
            Locale::En => en,
            Locale::It => it,
        },
        None => "",
    }
}

/// (key, English, Italian).
const TABLE: &[(&str, &str, &str)] = &[
    // Tray and menus
    ("tray.none", "No active timer", "Nessun timer attivo"),
    ("tray.pause", "Pause", "Pausa"),
    ("tray.resume", "Resume", "Riprendi"),
    ("tray.stop", "Stop and log…", "Ferma e registra…"),
    ("tray.quick_start", "Start timer…", "Avvia timer…"),
    ("tray.show", "Open inkledger", "Apri inkledger"),
    ("tray.quit", "Quit inkledger", "Esci da inkledger"),
    ("menu.server", "Server", "Server"),
    ("menu.manage", "Manage servers…", "Gestisci server…"),
    ("menu.go", "Go", "Vai"),
    ("menu.back", "Back", "Indietro"),
    ("menu.forward", "Forward", "Avanti"),
    // Global shortcuts
    ("shortcut.start", "Start a timer", "Avvia un timer"),
    ("shortcut.toggle", "Pause / resume the timer", "Pausa / riprendi il timer"),
    ("shortcut.show", "Show inkledger", "Mostra inkledger"),
    // Errors told to the page
    ("err.invalid_address", "Invalid address", "Indirizzo non valido"),
    ("err.use_http", "Use an http or https address", "Usa un indirizzo http o https"),
    ("err.no_credentials", "The address can't contain credentials", "L'indirizzo non può contenere credenziali"),
    ("err.no_host", "Address without a host", "Indirizzo senza host"),
    ("err.not_inkledger", "This doesn't look like an inkledger server", "Non sembra un server inkledger"),
    ("err.no_response", "no response", "nessuna risposta"),
    ("err.refused", "connection refused or wrong protocol", "connessione rifiutata o protocollo errato"),
    ("err.network", "network error", "errore di rete"),
    (
        "err.unreachable_ts",
        "{place} is unreachable ({why}). Check that Tailscale is running on this device and on the server.",
        "{place} non raggiungibile ({why}). Controlla che Tailscale sia attivo su questo dispositivo e sul server.",
    ),
    (
        "err.unreachable_local",
        "{place} is unreachable ({why}). Is the server running on this computer?",
        "{place} non raggiungibile ({why}). Il server è avviato su questo computer?",
    ),
    (
        "err.unreachable_other",
        "{place} is unreachable ({why}). Check the address and the network.",
        "{place} non raggiungibile ({why}). Controlla l'indirizzo e la rete.",
    ),
    ("err.no_window", "Window not found", "Finestra non trovata"),
    ("err.invalid_name", "Invalid name", "Nome non valido"),
    ("err.setting_unavailable", "Setting not available on this system", "Impostazione non disponibile su questo sistema"),
    ("err.not_on_mobile", "Not available on mobile", "Non disponibile su mobile"),
    ("err.system", "Something went wrong on this device ({err})", "Qualcosa non ha funzionato su questo dispositivo ({err})"),
    // Tailscale
    ("ts.not_installed", "Tailscale is not installed on this computer", "Tailscale non è installato su questo computer"),
    (
        "ts.approve",
        "Tailscale asks you to approve Serve: open {link} and confirm, then try again.",
        "Tailscale chiede di approvare Serve: apri {link} e conferma, poi riprova.",
    ),
    (
        "ts.https_off",
        "HTTPS certificates are off on the tailnet: Tailscale admin console → DNS → HTTPS Certificates → Enable, then try again.",
        "Nella tailnet i certificati HTTPS sono spenti: console di Tailscale → DNS → HTTPS Certificates → Enable, poi riprova.",
    ),
    ("ts.serve_failed", "Tailscale did not enable Serve: {out}", "Tailscale non ha attivato Serve: {out}"),
    (
        "ts.only_this_server",
        "Only the server this window shows from this computer (localhost) can be published",
        "Si può pubblicare solo il server che questa finestra mostra da questo computer (localhost)",
    ),
    // Wi-Fi sharing
    ("lan.only_this_mac", "Only a server on this computer can be shared", "Si può condividere solo un server di questo computer"),
    (
        "lan.only_localhost",
        "Only a server on this computer (localhost) can be shared",
        "Si può condividere solo un server di questo computer (localhost)",
    ),
    (
        "lan.no_network",
        "No local network: this computer is not connected to a Wi-Fi or a network",
        "Nessuna rete locale: il computer non è collegato a una Wi-Fi o a una rete",
    ),
    ("lan.port_busy", "Port {port} is busy: {err}", "Porta {port} occupata: {err}"),
    ("lan.bad_cert", "invalid certificate", "certificato non valido"),
    ("lan.bad_ca", "invalid CA", "CA non valida"),
    ("lan.bad_key", "invalid key", "chiave non valida"),
    (
        "lan.profile_desc",
        "Certificate to open inkledger on the local network of the computer running inkledger.",
        "Certificato per aprire inkledger sulla rete locale del computer su cui gira inkledger.",
    ),
    // Wi-Fi welcome page (served to phones)
    ("welcome.title", "inkledger on the local network", "inkledger sulla rete locale"),
    (
        "welcome.intro",
        "The computer “{mac}” shares inkledger on this Wi-Fi, over an encrypted connection. Once only, install its certificate.",
        "Il computer «{mac}» condivide inkledger su questa Wi-Fi, con una connessione cifrata. Una volta sola, installa il suo certificato.",
    ),
    ("welcome.step1", "1. Install the certificate", "1. Installa il certificato"),
    (
        "welcome.ios",
        "<b>iPhone:</b> Settings → Profile Downloaded → Install. Then Settings → General → About → Certificate Trust Settings → turn on “{ca}”.",
        "<b>iPhone:</b> Impostazioni → Profilo scaricato → Installa. Poi Impostazioni → Generali → Info → Impostazioni certificati attendibili → attiva «{ca}».",
    ),
    (
        "welcome.android",
        "<b>Android:</b> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate → ikl-ca.crt.",
        "<b>Android:</b> Impostazioni → Sicurezza → Crittografia e credenziali → Installa un certificato → Certificato CA → ikl-ca.crt.",
    ),
    (
        "welcome.fingerprint",
        "Before trusting the certificate, compare the SHA-256 fingerprint your phone shows for it with the one in the inkledger app on that computer (this page alone proves nothing):",
        "Prima di fidarti del certificato, confronta l'impronta SHA-256 che il telefono mostra per esso con quella nell'app inkledger su quel computer (questa pagina da sola non prova nulla):",
    ),
    ("welcome.step2", "2. Open inkledger", "2. Apri inkledger"),
    (
        "welcome.note",
        "In the Android app add one of these addresses as a server; on iPhone open it in Safari and add it to the Home Screen.",
        "Nell'app Android aggiungi uno di questi indirizzi come server; su iPhone aprilo in Safari e aggiungilo alla schermata Home.",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_has_both_languages_and_matching_placeholders() {
        let holes = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next().map(str::to_string)).collect();
            v.sort();
            v
        };
        for (k, en, it) in TABLE {
            assert!(!en.is_empty() && !it.is_empty(), "{k}");
            assert_eq!(holes(en), holes(it), "{k}");
        }
        let mut keys: Vec<_> = TABLE.iter().map(|t| t.0).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), TABLE.len());
    }

    #[test]
    fn looks_up_by_language() {
        assert_eq!(lookup(Locale::En, "err.invalid_name"), "Invalid name");
        assert_eq!(lookup(Locale::It, "err.invalid_name"), "Nome non valido");
        assert_eq!(Locale::parse("fr"), None);
        assert_eq!(Locale::parse("it"), Some(Locale::It));
    }

    #[test]
    fn a_fault_keeps_the_system_words_after_the_users() {
        let told = fault("Permission denied (os error 13)");
        assert!(told.ends_with("(Permission denied (os error 13))"), "{told}");
        assert!(told.len() > "(Permission denied (os error 13))".len());
    }
}
