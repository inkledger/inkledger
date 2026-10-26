# UX patterns

Conventions the UI follows. Each one has an e2e regression in `e2e/`; keep it green when you touch the pattern.

## Drafts and dirty forms
- A dialog holding typed work asks before closing: `useDirtyClose(close)` (`src/components/app/DirtyClose.tsx`) gives `onOpenChange`, `markDirty` and the confirm. Esc, the overlay and the close button all go through it.
- A failed action keeps what was typed and offers **Retry** in its toast (`toastError(e, { action })`).

## One target date and one context per action
- Actions started from a day (Timesheet "+", "Log time today") log on that day, never on "today" by accident.
- Switching period kind or view keeps the period being looked at (`usePeriod().setKind`, Timesheet view switch).

## Forms and errors
- A field refused by the tracker takes the focus; its message is tied with `aria-describedby` (multi-choice fields: on their `fieldset`). A form-wide error is a `role="alert"`.
- Dialogs are named in every state, loading and failed included.

## Keyboard
- Choice groups (`SegmentedControl`, theme presets) are one radio group: one Tab stop, arrows and Home/End move and choose, the focus follows.
- Lists inside popovers that pick one thing are plain buttons (`aria-pressed`), not a listbox they could not be operated as.
- Shortcuts are written per platform: `MOD_KEY` and `BACK_KEYS` in `src/lib/dom.ts` (⌘ on Apple devices, Ctrl/Alt elsewhere).

## Focus, motion and touch
- Focus rings use the full `ring-ring` colour (≥ 3:1 on every surface, checked by `src/lib/theme/derive.test.ts`); faded rings (`ring-ring/NN`) are refused by `pnpm lint`.
- `prefers-reduced-motion: reduce` stops animations and transitions app-wide (`src/index.css`); smooth scrolling falls back to instant.
- On a touch screen (`coarse:` variant) icon buttons and dialog/sheet close buttons get a 44 px tap area without changing their look; mobile rows and tab bar items use `min-h-touch`.

## Loading
- One status per loading region: `PageSpinner` is the status, the spinner inside it is decorative; skeletons are `aria-hidden`.

## Charts and narrow screens
- Every chart has a text equivalent: `PeriodBars` renders a screen-reader table (day, logged, target, pending, projects).
- At 320 px controls wrap instead of overflowing; tables that hide on a phone keep their sorting through a native select.

## Copy
- English and Italian keys are typed (`contracts/i18n`); no hard-coded UI text.
- Say what happens: a deleted worklog stays in **Recently deleted** for 30 days, so no "can't be undone".
- Settings search matches localized synonyms (`settings.categories.*.keywords`): add the words a tracker uses (webhook, repository, token) when a setting is about them.
