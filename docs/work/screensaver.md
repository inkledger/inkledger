# Status: Screensaver mode

Batch 1 implemented (2026-10-26), awaiting visual review. Not committed.

## Goal and completion criteria
- A dedicated control puts the app into a screensaver: key Z, the palette, a sidebar row, a tile in
  More on phones, a button in Settings → Appearance.
- Scenes are procedural (seeded, no assets), drawn anew at every start.
- Real fullscreen and a screen wake lock where the browser allows; leaving fullscreen closes it.
- Any key, click or tap closes it without reaching the app; ← / → switch scene.
- Optional overlay: clock, date, running timer, today vs goal; fades after 4 s, back on pointer move.
- Add-ons can bring scenes through a new `screensaver` slot.

## Constraints and out of scope
- Smoothness first: 30 fps cap, DPR ≤ 1.5 and ≤ ~3.5 M pixels, no frames while hidden; reduced
  motion composes a still picture in 6 ms slices, renewed every minute.
- Mods untouched (they stay 1.0.0); scenes inside existing mods are inkledger-modules work. Its
  `types/host.ts` needs `pnpm sync-types` there to see the new slot and event.

## Decisions
- Built into the host (free) + `screensaver` slot: compatible change, host API stays v1.
- Scene picked by hand in Settings (per device, `deviceSetting`), not rotated.
- Radix Dialog as the shell (as FocusMode): `isDialogOpen()` pauses global and list shortcuts.
- Ink scene: curl-noise current over 3D simplex, drops bloom and fade, thin tentacles; butt line caps
  (round caps overlapping at low alpha read as beads); the paper washes clean every 150–210 s.

## Batches
- [x] 1. Infrastructure (flag, slot, event, triggers, overlay, settings) + Ink scene
- [ ] 2. Geometric (Truchet / Lissajous / drifting lattices); e2e of a real scene switch
- [ ] 3. Real sky (sun, moon, weather)
- [ ] 4. Data-art (hours today/week)

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm check` | all | pass |
| `pnpm lint` | all + design check | pass |
| `vitest run src/components/screensaver src/modules api/parity` | 8 files, 37 tests | pass |
| `node --test e2e/screensaver.test.mjs` | open, ←/→, key/click/tap close, mobile, reduced motion, axe, Vite StrictMode | pass (4 tests) |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 pnpm test:e2e` | full suite | pass (2241 unit, 223 e2e) |
| Harness screenshots, light/dark/mobile, 20 s | Ink scene | worst frame gap ~9 ms, no page errors |

## Blocks and next action
- Tauri: DOM fullscreen in the macOS webview not verified; the full-window dialog is the fallback.
- Next: user's visual review of Ink, then batch 2.
