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
2. **Pastel and tone on tone.** Every colour derives from one base hue. Saturated fills were rejected as "too loud", and hue jumps towards pink or lilac as "a costume party". The data palette (§3.5) stays in the family too: its series are told apart by lightness first, on a short warm arc around the base, never by spreading hues around the wheel.
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

**Variant and contrast** (Settings → Appearance; `settings.theme_variant`, `settings.theme_contrast`) are derived from the same base colour, orthogonal to light/dark:
- **Soft** (`standard | soft`): low glare, Solarized-inspired. Surfaces are parchment (light) or blue slate (dark), leaning at most 12° towards the base hue and kept under the hue rule's 0.03 chroma floor, so they read as a tint, never an accent. Accents follow the base as usual. Contrast never below AA (text 4.5:1, focus ring and field borders 3:1).
- **High contrast** (`normal | high | system`; `system` follows `prefers-contrast: more`): AAA. Body, accented and state text 7:1, muted text above 7:1, hairlines, field borders, data bars and the focus ring 3:1; the focus outline is 3 px. Soft and high contrast combine.
- State colours (`success`, `warning`, `danger`, `info`) keep their own fixed hues in every look (they carry meaning); soft and high contrast re-solve their lightness.
- `index.html` sets `html[data-variant]` and the resolved `html[data-contrast]` before the first paint; `pnpm theme:tokens` also writes the default colour's high-contrast tokens (`:root[data-contrast="high"]`, `.dark[data-contrast="high"]`).
- In high contrast, translucent text and hairline classes (`text-foreground/80`, `border-border/70`…) are drawn at full strength by `index.css`: never rely on opacity to make text quiet.
- Modules get the active palette through the host's theme (`contrast` and `variant` are in `ThemeState`).
- Forced colors (Windows contrast themes): the system palette wins; bars, chips and controls keep an outline in system colours.

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
| `data-1..8` | Data only: one colour per series of a chart (issue type, project, client), §3.5 | via `colourFor` / `assignColours` |
| `paper`, `tape-1..5`, `string` | The pinboard's notes, washi tape, the red string | pinboard only |
| `cover-*`, `sunset-*` | Grainy covers: focus mode, avatars, illustrations, the sign-in page (never on a page's figures) | `cover-sunset` |

### 3.4 Rules that came from mistakes

- **Project colours are stable per project.** A hash of the project key picks one of `--project-1..6`, never the project's rank in a period, which made colours jump around.
- **Hatched stripes mean one thing only:** tracked but not yet logged (a live timer). Never use them for logged data. The data palette's high-contrast textures (§3.5) are dots and level lines, never the 45° hatch.
- **No decorative covers** on cards, figures or the issue page. A page's figures are a `StatStrip` (the stat card with a cover and tiles was retired on 3 Nov, as a favourite-card banner was before it: wasted space).
- **No gradients** except the theme's own sunset band on covers and the brand mark. No purple, blue or "AI" gradients.
- **Dark mode is not inverted light.** It has its own derived values. Check both themes, every time, and the soft and high-contrast looks when you touch colour (`e2e/themes.test.mjs`).

### 3.5 The data palette (series colours)

Charts that split one measure into categories (a day's hours by issue type, rows by project or client) give each category its own colour. Before it, every bar wore `chart-focus` and "what kind of work" could not be read at a glance.

**Why one family.** The first palette spread eight hues 45° apart around the wheel at one chroma: next to the warm, muted UI a royal blue, a plum and an emerald read as another product ("why these colours, despite the design system?"). Series do need telling apart, but hue is the loudest way to do it and the one a dichromat loses first. So the palette is one family and **lightness carries the distinction**: hues stay on a short warm arc around the base, chroma stays moderate, and neighbours step light, dark, light.

**Where it comes from.** `derive.ts` writes `--data-1..8` (plus `--data-edge-1..8` and `--data-mark-1..8`) for every look, from the base colour (`DATA_SERIES`):
- On terracotta: terracotta (the base), light sand, dark olive, dusty rose, warm slate, pale sage, deep umber, sage-teal. The arc follows the base: from red-violet to ochre it steps up towards ochre and olive, from olive to violet it steps down through teal and sage, never across violet and magenta. Only two companions are cool relative to a warm base (slate, sage-teal), at low chroma; any hue between 170° and 300° is calmed to ¾ of the look's chroma. A grey base takes the default's warm family. A type keeps its hue in light, dark and every look.
- Chroma per look, a share of it per series: standard 0.095, soft 0.075 (calmer), high contrast 0.12 (firmer, and textured). A muted base (slate) keeps a muted family.
- Lightness is a ladder around the series that just reaches the look's contrast (3:1, 3.6:1 in high contrast) on the card, the canvas and the bars' muted track: neighbours differ by ≥ 0.08 and alternate lighter and darker. In light the base sits on that line, the dark series below it and the light ones above; in dark the ladder starts a little under the line and climbs to a pale top (squeezed if it doesn't fit).
- **Outline rule (WCAG 1.4.11).** A series whose fill is under the contrast (the light ones in light, the deepest in dark) wears a 1px inner outline in `--data-edge-N`, a deeper tone of itself that reaches it; the others' edge is their own colour, so no line shows. The base series and every series further from the ground than it reach the contrast by fill alone. The outline is drawn by `.bg-data-N` itself (index.css), so every chart, legend swatch and stripe gets it.
- `derive.test.ts` checks it for every preset, extreme and random base × look × scheme: the chroma cap, the lightness alternation, the outline rule, the texture ink, and the distance (OKLab ×100) under simulated protanopia, deuteranopia and tritanopia (≥ 6, the floor that is legal with the secondary cues below) between any two of the first five series and between series one or two slots apart, plus ≥ 10 for normal vision between series one or two slots apart. Further pairs may look alike to a dichromat: the legend's text and the textures carry them.

**How to use it.**
- Never by slot number in a component. `src/lib/dataColors.ts`: `assignColours(keys, dimension)` for a chart's series (busiest first), `colourFor(key, index, dimension)` for one. A category keeps its colour on every page and period: its first appearance takes the next free slot of its dimension (`type`, `project`, `client`) and the choice is saved on the device. A hash would give five types the same colour four times in five.
- A hue always means a real category. At most eight series: the ninth and the rest are summed as Other (`OTHER_COLOUR`, `data-other`), never a new hue; what has no category ("No type", "No client") wears the other neutral (`NONE_COLOUR`, `data-none`) and takes no slot, so the palette starts from real types. Both are greys `derive.ts` places where they stand furthest from the eight series (a muted family has near-grey companions, so the UI's `chart-other`/`chart-break` would pass for one): "No type" next to the ground, a near-hollow outlined segment, as far from every series as two series are; Other in the ladder's widest gap (≥ 4 under colour blindness: it is rare, always on top of the stack and named in the legend).
- Stack segments in palette order (the legend's), not by size: touching series are then one or two slots apart, the ones checked. Segments are cut by a 1px gap of the card's colour, at full strength.
- Colour is never the only cue. Every chart with two or more series has a text legend (`DataLegend`: name, time, share); a bar's tooltip and its accessible name list its series; the sr-only table names them; a row says its category in words. In high contrast each slot also wears a texture (`data-texture-2..8`, inked in `--data-mark-N`: dots, level lines, a grid; slot 1 solid).

**Never** for UI chrome: not for buttons, chips, navigation, state, or decoration. State keeps `success`/`warning`/`danger`/`info`; one-series charts keep `chart-focus`.

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
  - `control` (`--control-h`) is the one height of a control in a row: 2.25rem snapped to an even pixel (32 px compact, 36 px comfortable). `Button` (`default`, `icon`), `SegmentedControl` and `PeriodNav` use it with their border inside, so a header's controls share top, bottom and centre in every look (`e2e/header-align.test.mjs`). A group of buttons fills its border with `h-full`; never an `h-9` or a padding that adds to it.
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
- **A shadow is paint, never layout.** Nothing's position or size depends on a shadow, the Shadow mod's included.
  - A clipping container that does not scroll uses `overflow: clip` + `[overflow-clip-margin:var(--surface-room)]`.
  - A scroller reserves the constant `--surface-room` with `cast-room-x` / `cast-room-y`, and what stands right above such a list is `relative`, so the list's room never takes its clicks.
  - Never a padding, gap or size that follows the light.

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
| A page's figures | `StatStrip` (one row divided by hairlines, three to a row under lg (two for four figures), the cover's grainy sunset as a faint wash behind the row; the figure looked for first is `lead`: a step larger, in the primary colour; a figure can be a filter or carry a `meter` towards its target; `busy` while another period loads; variants compact/default/expanded) | A card with a cover and tiles (retired) |
| A pane beside a list resized by dragging its edge (the Issues preview) | `Splitter` (the ARIA window splitter: ← / → 16 px, Shift 64, Home / End, a double click back to the default; written to a CSS variable on the grid once a frame while dragged; limits in `lib/layout/split.ts`, clamped by the grid's track too; the width kept with `deviceSetting`) | A pane of fixed width, or a resize handle of its own |
| A collection (recent issues, a board column's cards, a day's entries, attachments) | `Collection` (§7.1): a bounded adaptive grid of its container's width, a row budget, then "Show all N" (the same total at every width), expanded in place or on the full page | A rail scrolled sideways, a column clipped by a mask, a list that grows the page, a `slice` with no way to the rest |
| ▶ on an issue shown as a card or tile | `StartIssueButton` (`controlId` for FlowMap; none while its timer runs; never the card's drag or link) | A per-page start button |
| A date typed or picked to jump to | `DateJump` (the picker jumps at once, typing on Enter or blur) | An `onChange` on a date input (typing "2" jumped to the 2nd) |
| A block that adapts to its own width | `region` (a container) and the `@m:` / `@l:` / `@xl:` variants: 28 / 56 / 80rem (`src/lib/layout/regions.ts`, shared with desk panes) | Viewport breakpoints (`md:`, `xl:`) inside a page's blocks |
| A header's controls | `Toolbar` (at most 3 groups; an item with a `menu` form folds behind ⋯ as the header's region narrows) | A row of controls that wraps the title |
| A row in a list | `ListRow` (lead, title, second line, trail; `min-h-target`, `coarse:min-h-touch`, never a fixed height) | A row with its own paddings |
| A card in a column or a grid | `ItemCard` (raised, `p-2.5`, `rounded-xl`) | A card with its own paddings |
| A board column's head, a folded column | `ColumnHeader`, `CollapsedColumn` (`components/app/Columns.tsx`) | A copy per board |
| A page's own controls under its header | `PageToolbar` (sticks under the sticky header on desktop, publishes `--page-toolbar-h`, opaque, wraps) | A search or filter row that scrolls away |
| Sections of a page shown one at a time | `Tabs` + `TabPanel` (`components/ui/tabs.tsx`: one Tab stop, arrows without modifiers, value kept by the caller in the URL) | A long stack of sections |
| A secondary part folded under its title | `Disclosure` (title and count; content drawn only while open) | Always-open blocks of detail |
| Text with actions on a row | `ActionRow` (content `minmax(0,1fr)`, actions `shrink-0`) | Ad-hoc flex rows |
| A button | `Button`: variants `default` (the one main action), `outline`, `ghost`, `secondary`, `link`, `destructive`; sizes `sm`, `default`, `lg`, `icon`, `icon-sm`, `icon-lg` | Raw `<button>` with its own styling |
| A small label | `Chip`: tone `neutral`, `info`, `success`, `warning` or `danger`; variant `soft` for alerts, `dot` for status in lists | Coloured spans |
| Two to five exclusive choices | `SegmentedControl` (one radio group, arrows move) | A row of toggled buttons |
| Text typed in a field | `Input` / `Textarea` (their type is `text-field`: never under 16 px on a phone, where iOS would zoom in) | A field's own smaller text size |
| A choice from a list | `Select` (Radix, themed) | `<select>` or `<datalist>` (they ignore the theme; datalist is refused) |
| Picking an issue | `IssuePicker` | A custom search list |
| Searching a long list (the catalogue: Quick start, ⌘K, the pickers) | `VirtualCommand` (only the rows in view drawn; cmdk's ranking and keys, plus PageUp/PageDown; each option says its place in the whole list) | cmdk with thousands of items (it mounts, scores and moves every row on each key) |
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
- **No long lists, no white space beside them.** Every collection is bounded (§7.1). Sections side by side share one height and the shorter one fills it; the row's hairline is the row's own, never a section's in mid-air.
- **The sidebar never scrolls and is the same open and closed.**
  - From top to bottom: brand (always visible), search, notifications, the sections, favorites (the only part that shrinks), then the foot.
  - Sections: where the day is spent (Dashboard, Board, Issues, Desk, Timesheet) are rows; every other entry is a tile, icon over its whole name, 3 columns open and 2 closed, in the same order. Every entry stays inside the navigation block (FlowMap measures a click on the block it is drawn in).
  - Icon-only tiles are 28–32 px with a 44 px touch area (`coarse:after:size-touch`), a tooltip and an accessible name.
  - Foot: "Now" (the timer card, with Start timer always its last line), a hairline, the account, then the quick tiles (theme, screensaver, sync) with the sidebar's toggle last.
  - Open, the timer card has every control on two lines (pause and stop by the time; move, discard and focus by the note). Closed, the ring opens a small player beside the rail with the same lines.
  - Open, the quick tiles are one row; closed, a 2×2 block. No feature leaves the sidebar to save room, and no control is shown on hover only.
  - Checked at 700–1000 px high, open and closed.
- **Horizontal scroll only inside a declared scroller** (a table, the Board). The page itself never scrolls sideways, at 320 px included.
- **A wide table freezes what identifies a row and its live controls** (the Issues catalogue: pick, star, key and title at the start; timer and actions at the end), and the middle scrolls sideways under them (`useStickyTable`, `.sticky-table` in `index.css`). Frozen cells stand on the card with the row's tint drawn over it, and show an edge only while something is under them. The start always stays frozen; while the middle would get less than 160 px the end scrolls with it instead, and the list never gets narrower than the frozen start (the title at 160 px) plus room for the end (`--list-min`, the splitter's limit). Every table of a page shares one column template (`[data-table-group]`) and scrolls sideways together. Its header stays under the page's bars as a mirrored strip (`aria-hidden`, skipped by the keyboard: the real header keeps the focus and the column names). A control focused under a frozen column is brought out from under it in JS, never with CSS `scroll-padding`.
- **Phones.**
  - The tab bar is Home, Board, ⏱, Issues and More, and `--bottom-nav-h` reserves its space.
  - Rows and tab items are `min-h-touch`.
  - Icon buttons get a 44 px tap area on touch screens (`coarse:`) without changing their look.
- **At 320 px controls wrap** instead of overflowing. Tables that hide on a phone keep their sorting through a native control.

---

### 7.1 Spatial system
Grounded in Material 3 (window classes, canonical layouts), Apple HIG (split views, toolbars), Fluent 2 (responsive techniques), WCAG 2.2 and NN/g research.

**Container first: regions.** A block lays itself out by its own width, not the window's.
- The sizes are in rem, so density moves them: `@s` < 28rem ≤ `@m` < 56rem ≤ `@l` < 80rem ≤ `@xl`. They are the same thresholds as a desk pane's.
- `max-@l:` applies below `@l`, where a row is stacked in one column. A list that fits a row's height there gets a count budget instead (My issues: two per column, then "Show all N →").
- Viewport breakpoints are only for the shell (sidebar, phone tab bar).

**Three page layouts, nothing ad hoc.**
| Layout | For | Rule |
| --- | --- | --- |
| Overview (bento) | Dashboard, Team | Regions in rows of one height. |
| List-detail | Issues, Notes, Settings | Two panes from `@xl`. On a narrower container a choice replaces the list and Back returns. The selection stays highlighted. An empty selection shows a placeholder. |
| Supporting pane | Issue detail, a Team person, a report drill-in | About 70/30 from `@l`. Below that, the supporting part goes under the main one or into a sheet. |

**Collections are bounded, and nothing is hidden for good.**
- A row budget, then "Show all N". Expanding happens in place (focus moves to the first new item, and the button becomes "Show fewer") or on the page that holds them all.
- Never sideways: horizontal scroll is only for declared boards (Board, Ideas) and data tables (WCAG 1.4.10's two-dimensional exceptions). Their headings and filters still reflow.
- Never a mask over focusable items, never an item off screen.

**Budgets (checked by `e2e/space-budget.test.mjs`).**
| | Desktop (≥ 1024) | Phone (390) |
| --- | --- | --- |
| Chrome (header + toolbar) | ≤ 15% of the viewport's height | ≤ 20% |
| Primary block | starts in the first screen | starts in the first screen, above the tab bar |
| Overview pages | ≤ 1.5 screens | ≤ 3 screens |
| Working pages (Timesheet, issue detail) | ≤ 1.5 screens | ≤ 2.5 screens |

**Toolbars.** A header toolbar has at most three groups: what the page shows, where it goes, its main action. Lower priorities fold into ⋯ as the container narrows, and the title never wraps because of controls.

**One datum, one place.** A value is shown once per view: the timer, favorites, an issue's key, status and assignee.

**Stability.** Expanding never moves what is above it. Open and closed states keep their footprint. No primary control appears on hover only.

**Variants are density.** A block's workspace variant (compact, default, expanded) changes its padding and how much a collection shows at once (Recent activity: 1, 2 or 3 rows), never which controls or data exist.

**Never remove to save space.** Budgets and variants change density and how much shows at once. What is folded stays one step away: "Show all N", ⋯, or Peek.

**Accessibility is measured, not assumed.**
- Focus is never covered, at the top or the bottom (2.4.11). The bars that stay put mark themselves (`usePublishChromeHeight`, `data-chrome`), and `useFocusClearOfBars` scrolls a covered control into view. Not CSS `scroll-padding`: with it Chrome treated the bars' own controls as covered and scrolled the page.
- Targets are 24 px (2.5.8), and 44 px on coarse pointers, as the catalog's `minTouchTargetPx` declares.
- Reflow at 320 px (1.4.10).
- Text spacing (1.4.12): `min-height`, never a fixed row height.
- Forced colors: the focus outline survives.
- Both densities.

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
  - Fields (`Input`, `Textarea`, `SelectTrigger`, `IssuePicker`, the palette's search) draw their focus inside themselves: `data-focus="inset"` gives an inset ring following the radius (2 px, 3 px in high contrast) instead of the outline, so it never sticks out over a dialog's edge or a separator.
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
- **Covers** (focus mode, avatars, illustrations): grainy, with the sunset band derived from the theme.
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
