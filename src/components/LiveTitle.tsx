import { useEffect } from "react";
import { formatHMS } from "@contracts/time";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { setLiveTitle } from "@/hooks/useDocumentTitle";
import { BRAND_ARMS, BRAND_HEAD, BRAND_HEAD_OPACITY } from "@/lib/brand";

const ICON = "/favicon.svg";
/** Favicon with a dot: the timer is running (visible in tabs and the Dock). Ink on paper; paper on ink in dark mode, as the favicon. */
const INK = "hsl(24 12% 9%)";
const PAPER = "hsl(36 30% 97%)";
const RUNNING_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <style>@media (prefers-color-scheme: dark) { .tile { fill: ${INK} } .mark { stroke: ${PAPER} } .dot { fill: ${PAPER}; stroke: ${INK} } }</style>
    <rect class="tile" width="32" height="32" rx="8" fill="${PAPER}"/>
    <path class="mark" d="${BRAND_HEAD}" fill="none" stroke="${INK}" stroke-opacity="${BRAND_HEAD_OPACITY}" stroke-width="2.5" stroke-linecap="round"/>
    <path class="mark" d="${BRAND_ARMS}" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle class="dot" cx="26" cy="6" r="5.5" fill="${INK}" stroke="${PAPER}" stroke-width="1.5"/>
  </svg>`
)}`;

type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function setIcon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && link.getAttribute("href") !== href)
    link.setAttribute("href", href);
}

/**
 * While a timer runs: "▶ 1:23:45 DEMO-123" in the tab title, a dot on the
 * favicon and on the installed app's Dock icon. Renders nothing.
 */
export function LiveTitle() {
  const { timers, fetchedAt } = useTimers();
  const running = timers.find(t => t.state === "running");
  const elapsed = useElapsed(
    running?.state ?? "paused",
    running?.elapsedSeconds ?? 0,
    fetchedAt
  );

  useEffect(() => {
    setLiveTitle(running ? `▶ ${formatHMS(elapsed)} ${running.issueKey}` : "");
  }, [running, elapsed]);

  const isRunning = !!running;
  useEffect(() => {
    setIcon(isRunning ? RUNNING_ICON : ICON);
    const nav = navigator as BadgeNavigator;
    try {
      if (isRunning) void nav.setAppBadge?.().catch(() => undefined);
      else void nav.clearAppBadge?.().catch(() => undefined);
    } catch {
      // Badging unsupported
    }
  }, [isRunning]);

  useEffect(
    () => () => {
      setLiveTitle("");
      setIcon(ICON);
    },
    []
  );
  return null;
}
