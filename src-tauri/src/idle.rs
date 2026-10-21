//! System-wide away detection (desktop): no input for a while, screen locked
//! or the machine asleep. A Rust thread, so it keeps working while the window
//! is hidden and the webview's timers are throttled. Emits `system-away`
//! with the stretch (epoch ms); the page applies the user's threshold.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Poll period; a longer gap between polls means the machine slept.
const TICK: Duration = Duration::from_secs(10);
const SLEPT_AFTER_MS: u64 = 90_000;
/// Input idle for this long starts a stretch (the page's threshold is minutes).
const IDLE_FROM_S: u64 = 60;

#[derive(Clone, Serialize)]
struct Away {
    since: u64,
    until: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Pure step of the detector: (state, now, idle seconds) → stretch ended.
pub(crate) fn step(idle_since: &mut Option<u64>, last: u64, now: u64, idle_s: Option<u64>) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    if now.saturating_sub(last) > SLEPT_AFTER_MS {
        out.push((idle_since.take().unwrap_or(last).min(last), now));
    }
    match idle_s {
        Some(s) if s >= IDLE_FROM_S => {
            if idle_since.is_none() {
                *idle_since = Some(now.saturating_sub(s * 1000));
            }
        }
        Some(s) => {
            if let Some(since) = idle_since.take() {
                out.push((since, now.saturating_sub(s * 1000)));
            }
        }
        None => {}
    }
    out
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = now_ms();
        let mut idle_since = None;
        loop {
            std::thread::sleep(TICK);
            let now = now_ms();
            let idle = user_idle::UserIdle::get_time().ok().map(|i| i.as_seconds());
            for (since, until) in step(&mut idle_since, last, now, idle) {
                if until > since {
                    let _ = app.emit("system-away", Away { since, until });
                }
            }
            last = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::step;

    #[test]
    fn idle_stretch_ends_when_input_resumes() {
        let mut s = None;
        assert!(step(&mut s, 0, 10_000, Some(5)).is_empty());
        // Polled every 10 s; idle for 600 s at 700 s.
        assert!(step(&mut s, 690_000, 700_000, Some(600)).is_empty());
        assert_eq!(s, Some(100_000));
        // Input again 2 s ago: the stretch is 100 s → 708 s.
        assert_eq!(step(&mut s, 700_000, 710_000, Some(2)), vec![(100_000, 708_000)]);
        assert_eq!(s, None);
    }

    #[test]
    fn a_long_gap_between_polls_is_sleep() {
        let mut s = None;
        assert_eq!(step(&mut s, 1_000, 3_600_000, None), vec![(1_000, 3_600_000)]);
    }
}
