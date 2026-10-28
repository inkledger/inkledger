# inkledger design system

How inkledger looks, feels and is built, for the people and the AI agents who change it.

The rules here are not wishes: `pnpm lint` enforces most of them, and an e2e test guards the others. Where a rule exists because of a past mistake, its **why** is given; keep it when you are tempted to "simplify" it away.

A printable version with live colour swatches and the type scale is in `docs/design-system.pdf`. It is regenerated from the code with `pnpm docs:design-system`.

---

## 1. How to use this document

| You are… | Read | Then |
| --- | --- | --- |
| Building a new page | §2, §5, §6, §8 | Copy `src/pages/Dashboard.tsx`'s structure |
| Adding a component | §3, §4, §6, §7 | Check §12 before you open a PR |
| Changing colours or type | §3 and the token sources | Run `pnpm theme:tokens`, `pnpm lint`, the e2e |
| An AI agent | All of it, §11 first | Never invent a token, size or colour |

**Sources of truth.** When this document and the code disagree, the code wins: fix the document.
- `src/index.css`: tokens and base styles.
- `tailwind.config.js`: the scale and how tokens map to classes.
- `src/components/ui/*`: low-level primitives (shadcn/Radix).
- `src/components/app/*`: the app's own building blocks.
- `scripts/check-design.mjs`: the enforced rules.
- `docs/dev/ux-patterns.md`: interaction conventions, each guarded by an e2e test.

---

## 2. Principles

1. **Calm, warm, data first.** Warm neutrals with one terracotta accent (the user's colour, §3.2). Colour carries data and state, never decoration. The reference is a time-tracker dashboard: one white panel divided by hairlines, not a wall of boxed cards.
2. **Pastel and tone on tone.** Every colour derives from one base hue. Saturated fills were rejected as "too loud", and hue jumps towards pink or lilac as "a costume party".
3. **Minimal is not anonymous.** Character comes from texture (the grain on covers and paper) and one accent, **never from motion**. Hover animations and "fun" movement were rejected; a flat, toneless version was called "anonymous".
4. **Compact by default.** The root font is 14 px (§4.2). Density is a choice the user makes, not a page's.
5. **Everything is the app.** No page, pane or screen with its own look. A separate server page was called "awful and inconsistent". The Outlook pane is a page of the app's build for this reason (§10).
6. **Every screen has a way back**, and going back returns to where you were (state and scroll).
7. **Say what happens.** Copy describes what will happen and how to undo it, never the internals (§9).

---

## 3. Colour

### 3.1 Tokens, never values

Colours are CSS variables holding HSL triples (`--primary: 16.5 71.7% 78%`). Tailwind maps each one to a class with alpha support: `bg-primary`, `bg-primary/40`, `text-muted-foreground`.

| Never | Use |
| --- | --- |
| Hex in components (`#B5562F`) | A token class (`text-primary-strong`) |
| Tailwind's palette (`bg-red-500`, `text-gray-600`) | A semantic token (`bg-danger-soft text-danger`) |
| `bg-white`, `text-black` | `bg-card`, `text-foreground` |
| A new CSS variable used directly | Register it in `tailwind.config.js` with `token("name")`, or the class generates nothing (the lint checks this) |

### 3.2 The palette is derived

The user picks one base colour (Settings → Appearance, stored as `settings.theme_color`; the default is terracotta `#B5562F`).
- `src/lib/theme/derive.ts` derives the whole light and dark palette from it in OKLCH, staying within 12° of its hue.
- `src/lib/theme/apply.ts` writes it at run time.
- The defaults in `src/index.css` between `@theme-derived:start` and `@theme-derived:end` are generated with `pnpm theme:tokens`. Never edit that block by hand.

`src/lib/theme/derive.test.ts` checks the contrast of every pair that matters, for many base colours: AA text, and focus rings ≥ 3:1. A colour change that breaks contrast fails the unit tests.

### 3.3 Roles

| Token | Role | Typical classes |
| --- | --- | --- |
| `canvas` | Behind everything (the page's ground) | `bg-canvas` |
| `background`, `card`, `popover` | Panels, cards, floating layers | `bg-card` |
| `foreground` | Main text | `text-foreground` |
| `muted` / `muted-foreground` | Quiet fills / secondary text (AA on card) | `bg-muted`, `text-muted-foreground` |
| `accent` | Hover and selected rows | `hover:bg-accent` |
| `border`, `input` | Hairlines, field borders | `border`, `border-input` |
| `action` / `action-foreground` | The one main action on a screen (the default `Button`) | via `Button` |
| `primary`, `primary-soft`, `primary-strong` | Brand tint, soft fills, accent text and dots | `text-primary-strong` |
| `ring` | Focus ring, always full strength | `focus-visible:ring-2 ring-ring` |
| `success`, `warning`, `danger`, `info` (+ `-soft`) | State: text on its soft fill | `bg-success-soft text-success` |
| `chart-*`, `project-1..6` | Data only: charts, project colours | `bg-chart-focus` |
| `paper`, `tape-1..5`, `string` | The pinboard's notes, washi tape, the red string | pinboard only |
| `cover-*`, `sunset-*` | Grainy covers on stat cards only | `cover-sunset` |

### 3.4 Rules that came from mistakes

- **Project colours are stable per project.** A hash of the project key picks one of `--project-1..6`, never the project's rank in a period, which made colours jump around.
- **Hatched stripes mean one thing only:** tracked but not yet logged (a live timer). Never use them for logged data.
- **No decorative covers** on cards or on the issue page; covers are only on stat cards. A favourite-card banner was removed as wasted space.
- **No gradients** except the theme's own sunset band on covers and the brand mark. No purple, blue or "AI" gradients.
- **Dark mode is not inverted light.** It has its own derived values. Check both themes, every time.

---

## 4. Type, density and spacing

### 4.1 Fonts

- **Inter Variable** for text. Its features `cv11`, `ss01`, `ss03` and `calt` give a single-storey a, open digits and a curved l.
- **Inter Tight Variable** (`font-display`) for titles and numbers that headline.
- **No monospace anywhere in the UI**, keys and codes included; the lint refuses `font-mono`. Use `tabular-nums` where digits must line up.

### 4.2 Type scale (the only sizes)

| Class | Size | Use |
| --- | --- | --- |
| `text-display` | 2.75 rem, 600 | One per page at most (big stats) |
| `text-title` | 1.75 rem, 600 | Page titles (`PageHeader`) |
| `text-heading` | 1.375 rem, 600 | Section and dialog headlines |
| `text-body` | 1 rem | Body text |
| `text-body-sm` | 0.875 rem | Dense lists, tables, most UI text |
| `text-caption` | 0.8125 rem | Secondary lines, labels, hints |
| `text-overline` | ≥ 11 px, 600, tracked | Small uppercase labels |
| `text-2xs` | ≥ 11 px, 600 | Counters in pills |

Tailwind's `text-xs`, `text-sm`, `text-lg`… and arbitrary sizes such as `text-[13px]` are refused by the lint. Nothing is ever smaller than 11 px.

### 4.3 Density

Every size is in rem, so density scales the root: compact is 14 px (the default), comfortable is 16 px (`html[data-density]`). Never fix a size in px to "escape" density. The exceptions are hairlines and the 44 px touch target.

### 4.4 Spacing and radius

- **Spacing.** Tailwind's 4 px scale.
  - Gap `2` by default; gap `1` only for dense chip groups.
  - Sections use `p-5 md:p-6` (`PanelSection`).
  - `touch` (44 px) and `target` (24 px) are named spacings for hit areas.
- **Radius.** It comes from `--radius` (0.5 rem):
  - `rounded-sm`, `md`, `lg`, `xl` and `2xl` only;
  - `rounded-3xl` and arbitrary radii are refused.
  - Cards use `rounded-lg`; fields and buttons use `rounded-md`.

---

## 5. Surfaces, elevation and motion

### 5.1 Surfaces

Every element that stands out from what is under it declares what it is, with `{...surface(kind)}` from `src/components/app/surface.ts`. Never write `data-surface` by hand.

| Kind | What it is |
| --- | --- |
| `control` | A button, switch, segmented option or nav box standing on the page |
| `chip` | A chip, badge or count pill |
| `picture` | An avatar, project picture or mark (its own silhouette) |
| `note` | A paper note on the pinboard (its shadow is part of the drawing) |
| `bar` | A data bar, block or meter on a chart or timeline |
| `card` | A card or a group of controls |
| `panel` | The main panel over the page |
| `nav` | A navigation item (stands out only while current) |
| `menu` | A menu, popover or list floating over the page |
| `dialog` | A dialog or sheet floating over the page |
| `ground` | What surfaces stand on (receives shadows, casts none) |
| `glass` | See-through by design (casts no shadow) |

A box with a border or a fill and no `surface()` fails the lint, unless the line above says why: `// surface: none — <why>`.

This catalogue is what lets a module that draws light and shadow (the Shadow mod) reach every page without guessing from the DOM.

### 5.2 Elevation

The shadows are `shadow-xs`, `sm`, `md`, `lg` and `xl`: two soft layers tinted with `--shadow-color`.
- Pages and cards use `xs` or `sm` at most.
- `md` and above are for popovers and dialogs, inside `components/ui` only (the lint enforces it).
- Prefer hairlines to shadows for separating sections.

### 5.3 Motion

- The durations are 180 ms (`DEFAULT`), `fast` (120 ms) and `slow` (260 ms), with ease `cubic-bezier(.2,.8,.2,1)`.
- Motion explains a change: a page appears, a panel opens. **It never decorates**: no hover lifts, no bouncing, no animated gradients.
- `prefers-reduced-motion: reduce` stops all animations and transitions app-wide.
- **Smoothness first.** Nothing may cause jank. Writes to `:root` cost a frame, and modules are measured on GPU and on software rendering.

### 5.4 Icons

- Use lucide icons only, with one stroke weight everywhere (1.75, set in `index.css`).
- Icons sit at `h-4 w-4`, or `h-3.5 w-3.5` in captions.
- An icon that carries meaning without text has an `aria-label` on its button; one that only decorates is `aria-hidden`.

---

## 6. Components

### 6.1 Use what exists

Before writing a component, look in `src/components/app/` and `src/components/ui/`.

| Need | Use | Not |
| --- | --- | --- |
| Page title row | `PageHeader` (breadcrumb, h1, description, actions; sets the tab title) | A custom `<h1>` row |
| A block of the page panel | `PanelSection` / `PanelRow` (hairlines, not boxes) | Nested cards |
| Text with actions on a row | `ActionRow` (content `minmax(0,1fr)`, actions `shrink-0`) | Ad-hoc flex rows |
| A button | `Button`: variants `default` (the one main action), `outline`, `ghost`, `secondary`, `link`, `destructive`; sizes `sm`, `default`, `lg`, `icon`, `icon-sm`, `icon-lg` | Raw `<button>` with its own styling |
| A small label | `Chip`: tone `neutral`, `info`, `success`, `warning` or `danger`; variant `soft` for alerts, `dot` for status in lists | Coloured spans |
| Two to five exclusive choices | `SegmentedControl` (one radio group, arrows move) | A row of toggled buttons |
| A choice from a list | `Select` (Radix, themed) | `<select>` or `<datalist>` (they ignore the theme; datalist is refused) |
| Picking an issue | `IssuePicker` | A custom search list |
| A link to another site | `ExternalLink` (asks before opening an unknown domain) | `<a target="_blank">` |
| Copying text | `CopyButton` | Hand-written clipboard code |
| Loading, empty, error | `PageSpinner`, `EmptyState`, `ErrorState` (with Retry) | Bare text |
| A meter or progress bar | `Meter` | Divs with widths |
| The brand | `BrandMark` (follows the theme) | The favicon image |
| A dialog | `Dialog` with title and description (named in every state) | Custom overlays |
| A dialog's body | `lazyPart` keeps it out of the first load | Importing heavy parts eagerly |

### 6.2 States every component handles

1. **Loading.** One status per region: the spinner is decorative, its region says "Loading"; skeletons are `aria-hidden`.
2. **Empty.** It says what to do next (`EmptyState`), never only "No data".
3. **Error.** It says what failed and offers Retry (`ErrorState`, `toastError(e, { action })`). A failed action keeps what was typed.
4. **Busy.** While an action runs, its button is disabled and the result is announced (`role="status"` or a toast).
5. **Long content.**
   - User text wraps with `[overflow-wrap:anywhere]` (not `break-words`, which the lint refuses).
   - Single lines truncate with `truncate` inside a `min-w-0` parent.

---

## 7. Layout and overflow

- **One panel, hairlines inside.** Pages are one rounded panel over the canvas, divided by hairlines. On desktop the panel stays put and scrolls inside. Pages driven by controls (Dashboard, Timesheet, Issues) keep the header and their toolbar fixed and solid, with no blur.
- **Intrinsic sizing is the usual bug.**
  - A grid track that holds text is `minmax(0,1fr)` (or `grid-cols-[minmax(0,1fr)]`).
  - Flexible flex children get `min-w-0`.
  - Never hide an overflowing child with the parent's `overflow`, and never add a global `overflow-x-hidden` to mask it.
- **Horizontal scroll only inside a declared scroller** (a table, the Board). The page itself never scrolls sideways, at 320 px included.
- **Phones.**
  - The tab bar is Home, Board, ⏱, Issues and More, and `--bottom-nav-h` reserves its space.
  - Rows and tab items are `min-h-touch`.
  - Icon buttons get a 44 px tap area on touch screens (`coarse:`) without changing their look.
- **At 320 px controls wrap** instead of overflowing. Tables that hide on a phone keep their sorting through a native control.

---

## 8. Interaction

These conventions are in `docs/dev/ux-patterns.md`, each with its e2e test. The essentials:

- **Drafts are safe.** A dialog holding typed work asks before closing (`useDirtyClose`).
- **One target per action.** An action started from a day acts on that day, never on "today" by accident. Switching a view keeps the period you were looking at.
- **Forms.**
  - A field the server refused takes the focus, with its message tied by `aria-describedby`.
  - A form-wide error is `role="alert"`.
- **Keyboard.**
  - A choice group is one Tab stop; arrows move within it.
  - Lists that pick one thing are buttons with `aria-pressed`.
  - Shortcuts are written per platform (`MOD_KEY`: ⌘ on Apple, Ctrl elsewhere).
- **Focus.** Rings use the full `ring-ring` colour; faded rings (`ring-ring/40`) are refused.
- **Toasts.** Every toast and notification can be closed without opening it. Errors use `toastError`, which explains and offers Retry.

---

## 9. Copy and languages

- **No hard-coded text.** Every string is a typed key in `contracts/i18n/{en,it}` (`t("ui.mail.pinTitle")`).
  - English and Italian are both required, and their key sets must match.
  - `pnpm parity:update` records the change.
- **Say what happens**, in the user's words: "a deleted worklog stays in Recently deleted for 30 days", not "can't be undone".
- **Labels are short;** the panel or section title gives context, so a button inside "TODO" says "Add TODO".
- **Settings search** finds localized synonyms: add the words a user would type to `settings.categories.*.keywords`.
- **The repo is public:** English in code, comments, docs and commit messages; no personal data, hosts or company names.

---

## 10. Special surfaces

- **The pinboard.**
  - One warm grainy paper for every note (`--paper`, with the covers' grain).
  - The colour sits on a washi-tape strip (`--tape-1..5`), with a tiny static tilt.
  - Titles use the display font.
  - No hover movement.
- **Covers** (stat cards only): grainy, with the sunset band derived from the theme.
- **The Outlook add-in's pane** is a page of the app's build: `outlook.html` and `src/outlook/`.
  - It uses the same components, tokens, fonts, theme colour and language as the app, and nothing hand-styled.
  - Outlook's panes are narrow (320–480 px), so a section puts its selector and its short action button on one row; nothing may need a sideways scroll.
  - The e2e checks both widths.
- **Modules** draw only through the host APIs and the surface catalogue (§5.1). They never style the app's elements directly, and they keep their own licence and version (they stay at 1.0.0 until told otherwise).

---

## 11. For AI agents: hard rules

Do:
- Read the component you are changing and its neighbours first, and copy their idiom: naming, comment density, structure.
- Use only the tokens, sizes, radii and shadows listed here.
  - If a value is missing, say so; do not invent one.
- Reuse the components in §6.1.
- Mark every standing box with `surface()`.
- Give long text `[overflow-wrap:anywhere]` and its grid tracks `minmax(0,1fr)`.
- Add English and Italian keys together.
- Check light and dark, at 320 px and on desktop.
- Add an e2e test for any interaction you fix or add.
- Run `pnpm lint` and `pnpm check` before you say you are done.

Never:
- Hex colours, Tailwind palette colours, `text-xs`/`sm`/`lg`, `font-mono`, `break-words`, `<datalist>`, `rounded-3xl`, or shadows above `sm` outside `components/ui`.
- Hover animations, gradients, glassmorphism or decorative covers.
- A global `overflow-x-hidden`, `!important`, or inline `style` for colours or sizes.
- A page, pane or dialog with its own look.
- Text that is not an i18n key.
- Silencing the lint without a `design-ok` comment explaining the reviewed exception.

---

## 12. Checklist before a PR

- [ ] Tokens only. `node scripts/check-design.mjs` prints no violations.
- [ ] `pnpm lint && pnpm check` pass.
- [ ] Light and dark both look right.
- [ ] Compact and comfortable density both look right.
- [ ] At 320 px: nothing overflows, controls wrap, touch targets are 44 px.
- [ ] Loading, empty, error and busy states exist and are announced.
- [ ] Keyboard only: reachable, visible focus, Esc closes, no traps.
- [ ] English and Italian keys added; `pnpm parity:update` run.
- [ ] Every new or fixed interaction has an e2e test in `e2e/` (run it with `PROVIDERS_READ_ONLY=1`).
- [ ] No new component where §6.1 already has one.
