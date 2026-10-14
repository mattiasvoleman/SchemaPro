---
name: SchemaPro
description: The signed-in web app of a Swedish school's planning chain and school day, one working pattern on every page.
colors:
  background: "hsl(0 0% 100%)"
  foreground: "hsl(240 10% 8%)"
  card: "hsl(0 0% 100%)"
  primary: "hsl(243 75% 59%)"
  primary-foreground: "hsl(0 0% 100%)"
  primary-hover: "hsl(243 75% 63%)"
  muted: "hsl(240 5% 96%)"
  muted-foreground: "hsl(240 4% 43%)"
  accent: "hsl(243 75% 96%)"
  accent-foreground: "hsl(243 75% 40%)"
  destructive: "hsl(0 72% 51%)"
  destructive-foreground: "hsl(0 0% 100%)"
  destructive-hover: "hsl(0 72% 45%)"
  success: "hsl(152 60% 36%)"
  success-strong: "hsl(152 65% 24%)"
  warning: "hsl(38 92% 50%)"
  warning-foreground: "hsl(32 81% 15%)"
  warning-strong: "hsl(38 92% 33%)"
  border: "hsl(240 6% 90%)"
  input-strong: "hsl(240 6% 56%)"
  sidebar: "hsl(240 6% 98%)"
  sidebar-foreground: "hsl(240 6% 26%)"
  sidebar-accent: "hsl(243 75% 94%)"
  sidebar-accent-foreground: "hsl(243 75% 40%)"
  sidebar-border: "hsl(240 6% 91%)"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  kpi-figure:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    fontFeature: "tnum"
  dialog-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  title-sm:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "cv02, cv03, cv04, cv11"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  label-caps:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.025em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  full: "9999px"
spacing:
  field: "6px"
  section-inner: "12px"
  filter-gap: "12px"
  page-rhythm: "16px"
  card-padding: "16px"
  field-grid: "16px"
  header-gap: "24px"
  dialog-padding: "24px"
  main-x-phone: "16px"
  main-x-sm: "24px"
  main-x-lg: "32px"
  main-y: "24px"
  width-wide: "64rem"
  width-narrow: "48rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    height: "36px"
  button-destructive-hover:
    backgroundColor: "{colors.destructive-hover}"
  button-sm:
    padding: "0 12px"
    height: "32px"
  button-icon:
    size: "36px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  badge-success:
    backgroundColor: "hsl(152 60% 36% / 0.15)"
    textColor: "{colors.success-strong}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-warning:
    backgroundColor: "hsl(38 92% 50% / 0.15)"
    textColor: "{colors.warning-foreground}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-secondary:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  section-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "16px"
  kpi-tile:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "16px"
    typography: "{typography.kpi-figure}"
  table-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
  notice-neutral:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  notice-warning:
    backgroundColor: "hsl(38 92% 50% / 0.1)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  notice-destructive:
    backgroundColor: "hsl(0 72% 51% / 0.05)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  notice-success:
    backgroundColor: "hsl(152 60% 36% / 0.1)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  nav-item:
    textColor: "{colors.sidebar-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
  dialog:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "32rem"
---

# Design System: SchemaPro

## Overview

**Creative North Star: "The Planning Ledger"**

Every signed-in page is a working ledger for the schemaläggare: a title that names the page, the figures that summarise it, then the rows and sections where the work happens. The pattern was lifted from Tjänstefördelning and Timplan and applied to every page under `web/app/[locale]/(app)` (commit 5cf0a5b). Density is high and calm: one sans-serif at 14px body, white or near-black card surfaces with hairline borders, one indigo accent, and colour reserved for status. Nothing on the page floats; the only shadows belong to controls and overlays.

The system is built from a small set of shared, server-safe primitives (`Page`, `PageHeader`, `SectionCard`, `KpiStrip`, `TableCard`, `Notice`, `LoadError`, `EmptyState`, `FilterBar`, `FormField`, `RowActions`, `Stepper`) and one status map (`web/lib/status-variants.ts`). A new page is assembled from them; a page that hand-rolls a callout, a chip or a table frame is off-system. Accessibility rules are written into the components themselves (named buttons, labelled sections, live roles, measured contrast), so following the components is following the rules.

Two surfaces keep their own look, by owner decision: the sign-in pages under `(auth)` (a centred `max-w-sm` card on `bg-muted/40` with the brand mark), and the public viewer Schemavisaren at `web/app/v` (its own root layout with no theme, no providers and no session; `max-w-6xl`, server-printed week, a phone list below `md`). The print document (uppdragsbeskrivning, A4, 15 mm margins, always light) is the third sanctioned variant.

**Key Characteristics:**
- One page anatomy: Page → PageHeader → (Tabs) → (FilterBar) → (KpiStrip) → SectionCards and TableCards, spaced only by the parent's 16px rhythm.
- One accent (indigo primary) for the primary action, focus ring, links and the active nav item; status colour only through Badge variants and Notice tones.
- Flat page surfaces: `rounded-lg border bg-card`, no shadows on page content.
- Every query-backed region runs the same state ladder, and a failed load never reads as empty or 0.
- Light and dark themes from the same HSL tokens; reduced motion honoured app-wide.

## Colors

A cool neutral ground (hue 240) with one blue-violet accent (hue 243) and three status hues; tokens are HSL channel triplets in `web/app/globals.css`, consumed as `hsl(var(--token))` through `web/tailwind.config.ts`. Dark-theme values live under `.dark` and are listed in the sidecar.

### Primary
- **Indigo Ledger** (`primary`): the default Button, the focus ring (`ring` equals primary), `text-primary` links, the current Stepper step, the brand mark's tile. In dark mode it is lifted to 70% lightness so `text-primary` on card measures 4.83:1 (68% failed at 4.37:1). The Button's label on it measures 6.18:1 light and 5.12:1 dark.
- **Indigo Ledger Hover** (`primary-hover`): the default Button under the pointer, a solid shade. Light is what `primary/90` painted on white (label 5.09:1); dark lifts the fill to 74% (label 6.27:1), where the old `primary/90` fade let the page through and fell to 4.34:1.
- **Indigo Wash** (`accent`, `accent-foreground`): the hover fill of outline and ghost buttons; the sidebar uses its own pair (`sidebar-accent`, `sidebar-accent-foreground`) for the active and hovered nav item.

### Secondary
- **Signal Red** (`destructive`): the destructive Button, the solid destructive Badge, the destructive Notice's 5% tint, 40% edge and its OctagonX icon, form error text. In dark the fill is lighter (58%), so its ink is a near-black red (`0 80% 6%`, 4.88:1) as `success` has, not white (4.04:1). Its hover is a solid `destructive-hover` (45% light, 64% dark; 5.83:1 and 5.84:1), not `destructive/90`, which let the surface through.
- **Ledger Green** (`success`, `success-strong`): the base shade tints (Badge 15%, Notice 10%, done Stepper step 10%); the strong shade is the ink and icon colour on light grounds (5.7:1). In dark mode strong equals base.
- **Amber Signal** (`warning`, `warning-strong`, `warning-foreground`): the base shade tints (Badge 15%, Notice 10%, edge 50%); `warning-strong` (4.2:1) is the warning icon; `warning-foreground` is the warning Badge's ink in light (dark uses `warning` itself).

### Neutral
- **Paper** (`background`, `card`): page and card surface; identical in light, card is a step up (8% vs 5% lightness) in dark.
- **Ink** (`foreground`): all running text, Notice text in every tone, table cells.
- **Fog** (`muted`, also `secondary`): neutral Notice fill, Tabs track, skeletons, empty-state icon disc, group rows at 40%, table row hover at 50%.
- **Slate Text** (`muted-foreground`): subtitles, descriptions, hints, table heads, KPI labels, decorative icons, inactive tabs. 5.43:1 on white and 4.94:1 on `muted` (it was 4.83 and 4.40 at 46%, under AA on its own surface), AA, not AAA.
- **Hairline** (`border`, `input`): every card, table and tile edge and the outline Button's edge. `input` measures 1.27:1 on white and 1.40:1 on the dark page, `border` 1.27:1 and 1.23:1 on card, so both are decoration and never the only sign that a control is there.
- **Field Edge** (`input-strong`): the edge of every text field, select and textarea: Input, Textarea, SelectTrigger, NativeSelect, DateField (box and calendar button) and the timplan grid's cells. Also the track of an unchecked Switch, whose thumb is `background`, so it stands out from the track by the same ratio (and by 6.18:1 / 5.12:1 on the checked `primary` track). SC 1.4.11 asks 3:1 of it on every surface a control sits on: light 3.49:1 on background and card, 3.35:1 on sidebar, 3.18:1 on muted; dark 3.80, 3.59, 3.68 and 3.07:1. `web/app/globals-css.test.ts` computes these from the tokens.
- **Sidebar Mist** (`sidebar`, `sidebar-foreground`, `sidebar-border`): the fixed navigation column.

### Named Rules
**The Field Edge Rule.** A text field, select or textarea draws `border-input-strong` through the shared primitive or its exported class (`NATIVE_SELECT_CLASS`), never through a copy of it. The one raw `<input>` is the timplan grid's 32px numeric cell, which names the token itself and whose test pins it. `border-input` is only for boxes that a label already identifies.

**The Ink Stays Foreground Rule.** Tinted surfaces (Notice, done Stepper step) keep their text in `foreground`; the tone is carried by the tint, the hairline edge and the icon. Red on its 5% tint measures 4.45:1 and green on its tint 3.45:1, both under AA, so neither is ever the ink. Icons and Badge text use the `-strong` shades.

**The One Meaning Per Colour Rule.** Status colour comes only from `web/lib/status-variants.ts`: success = done, ok, approved, covered, active, applied; warning = needs action (open, draft, under, pending, ongoing); destructive = failed, over, passed, rejected, blocked; secondary = neutral information, handled, upcoming, kinds; outline = inactive or finished (historic, revoked, withdrawn, ended). A draft needs a decision, so it is warning; revoked is finished, so it is outline. Raw palette classes (`amber-*`, `red-*`, …) do not appear in signed-in pages.

## Typography

**Body Font:** the `--font-sans` stack: Inter, then ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial. Inter is named but not loaded by the app (no `next/font`, no font files), so the rendered face is Inter only where installed and otherwise the platform UI face.
**Display / Label Font:** the same stack; there is one family. Body carries `font-feature-settings: "cv02", "cv03", "cv04", "cv11"`.

**Character:** a single neutral sans, sized small and set with weight (600 for headings, 500 for labels) rather than size jumps.

### Hierarchy
- **Headline** (600, 1.5rem/2rem, tracking -0.025em): the page h1 in PageHeader, one per route.
- **Title** (600, 1rem/1.5rem): section h2 in SectionCard and borderless `<section>`s.
- **Title-sm** (600, 0.875rem): h3 for nested sections, nested sub-blocks and EmptyState titles. `font-medium` is not a heading weight.
- **Dialog title** (600, 1.125rem, leading none, tight tracking): DialogTitle only. `text-lg` also remains on the print uppdragsbeskrivning's h2s.
- **Body** (400, 0.875rem/1.25rem): everything else, including table cells and Notice text. `intro` paragraphs hold to `max-w-prose`.
- **KPI figure** (600, 1.25rem on phones, 1.5rem from `sm`, tabular numerals).
- **Label** (500, 0.875rem, leading none): form labels.
- **Meta** (400, 0.75rem/1rem): hints, error lines, secondary lines in cells, Badge text (500).
- **Label-caps** (500, 0.75rem, uppercase, tracking 0.025em, muted): only KPI tile labels and table/list group rows (day rows on the cover board). The nav group label is the single `tracking-wider` (0.05em, 600) instance.

### Named Rules
**The No Skipped Level Rule.** h1 → h2 → h3, never an h3 directly under the h1. SectionCard takes `headingLevel` 2 or 3; EmptyState and LoadError take 2 when they stand directly under the h1.

**The Tabular Figures Rule.** Numbers, dates and times are `tabular-nums`; numeric columns and their heads are right-aligned; an empty value is an em dash "—" in muted text.

## Layout

AppShell: a fixed 16rem (`w-64`) sidebar from `lg`, a sticky 4rem header (`bg-background/80` with backdrop blur) holding locale, theme, notifications and user menu, and `<main>` padded 16px / 24px from `sm` / 32px from `lg` horizontally, 24px vertically. The content column is `min-w-0` so wide matrices scroll inside their own frame instead of widening the page. Below `lg` the menu is an 18rem (`w-72`) drawer over `bg-black/50`.

**Page widths** (`<Page width>`): `full` (default) for tables, matrices and boards; `wide` (max 64rem) for wizards and settings pages (years, rollover, integrations, setup, generate); `narrow` (max 48rem) for personal reading pages and print documents (teacher tjänst, notifications, student and teacher attendance, uppdragsbeskrivning). Capped pages stay left-aligned, not centred, so every h1 starts at the same x. Loading, empty and error branches render inside the same width.

**Rhythm:** Page is `space-y-4` (16px) and is the only source of vertical spacing between blocks; blocks carry no top or bottom margins of their own. PageHeader keeps its own 24px bottom margin, so header-to-content is 24px and block-to-block 16px. Inside a SectionCard the rhythm is 12px; inside a field 6px.

**Order of blocks:** PageHeader → page-level Tabs (state in `?tab=`) → FilterBar → KpiStrip → sections and tables. Summary figures go in the KpiStrip, never in header actions or filter rows.

**Grids:** field grids `grid gap-4 sm:grid-cols-2 [&>*]:min-w-0` (three columns for time triples), never a non-responsive two-column grid. KpiStrip is two columns at base, widening to 3 (`sm`), 4 (`lg`) or 5. A right rail is `grid gap-4 [bp]:grid-cols-[minmax(0,1fr)_20rem]` with the breakpoint chosen by the page's width needs (Timplan `xl`, Vikarietavla `2xl`).

**Responsive tables:** a table that must stay a table on a phone hides its secondary columns with `hidden sm:table-cell` and repeats the essential value as a `block text-xs text-muted-foreground sm:hidden` line under the first cell. A board read row by row on a phone (Vikarietavla) renders two versions split by CSS alone: a `ul divide-y rounded-md border bg-card sm:hidden` list and the TableCard with `hidden sm:block`; `display:none` keeps only one in the accessibility tree.

## Elevation & Depth

Page content is flat: depth comes from the card surface and its hairline border, never from shadow. Shadows exist only on controls (Button `shadow` / `shadow-sm`, Input `shadow-sm`, active Tab `shadow`) and on overlays (Dialog `shadow-lg`, mobile drawer `shadow-xl`). Overlays dim the page with `bg-black/60` (dialogs) or `bg-black/50` (drawer).

### Named Rules
**The Flat Page Rule.** No `shadow-*` on SectionCard, TableCard, KpiTile, Notice or list rows. A surface is distinguished by `border bg-card`, a tint, or `bg-muted/40`.

## Shapes

Radius is derived from `--radius` (10px): `rounded-lg` (10px) for cards, table frames, KPI tiles, empty states, the Tabs track and dialogs (from `sm`; full-bleed below); `rounded-md` (8px) for buttons, inputs, badges, notices, nav items, inner boxes and record lists; `rounded-full` only for Stepper pills and the EmptyState icon disc. Borders are 1px hairlines everywhere; EmptyState alone uses a dashed border. A nested sub-block inside a card is `rounded-md border p-3`.

## Components

### Page header
- One `PageHeader` per route: h1 (also the tab title "{title} · SchemaPro" via DocumentTitle), optional one-sentence `subtitle` with no trailing period, optional `meta` row of Badges, optional `intro` (foreground, `max-w-prose`) for longer explanation, optional `back` link rendered above the h1 as a ghost small button with ArrowLeft and a named destination ("Till tjänstefördelningen", never "Tillbaka"), hidden in print.
- **Actions**, left to right: the scope selector (`YearSelect`, a Radix Select `w-44`, skeleton of the same size while loading, nothing when the school has no years); outline secondary actions with a leading icon; at most one primary action. Beyond four, the rest go behind a ghost `MoreHorizontal` icon menu with an aria-label. Actions centre on a title+subtitle pair and top-align when `meta` or `intro` makes the block tall.
- **NextStep:** a ghost small "Nästa steg: {name}" link with ArrowRight along the manual's chain, at the page end or in the actions; it never competes with the primary.

### Sections (SectionCard)
- `<section aria-labelledby>` named by its own h2 (or h3), `rounded-lg border bg-card p-4`, internal 12px rhythm.
- Header row: title with an optional size-4 muted decorative icon, an optional muted description, an optional `action` (outline small button) at the right.
- `footer`: a `border-t pt-3` row of right-aligned buttons (settings card Save).
- A section without a frame (a computed matrix under a table) is a bare `<section aria-labelledby>` with the same h2.
- shadcn Card is retired from page content (its title is a div); it remains only for dashboard link tiles.

### KPI strip
- `KpiStrip` is a `<dl>` grid with 12px gaps; each `KpiTile` is `rounded-lg border bg-card`, 12px padding on phones and 16px from `sm`. The dt is the label-caps style; the dd is the KPI figure; an optional second dd is a muted text-sm detail.
- `value={null}` shows the `fallback` sentence or a muted "—". Never pass 0 for a figure that failed to load.

### Tables
- **TableCard:** `overflow-x-auto rounded-lg border bg-card` around the shared Table, with a `sr-only` caption that names the table. While placeholder data stands in for a refetch, `busy` dims it to 60% and sets `aria-busy`.
- **Defaults:** head cells 40px tall, `px-3`, medium, muted, `scope="col"`; body cells `px-3 py-2.5`; rows with a hairline bottom and `muted/50` hover. First column `font-medium`; secondary lines `block text-xs text-muted-foreground`.
- **Inner table inside a SectionCard:** no frame of its own (the card is the frame). Wrap in `overflow-x-auto`; head cells `h-auto py-1.5 pr-3 text-xs`, body cells `py-1.5 pr-3`; first column `pl-0` and last `pr-0` so the outer columns sit flush with the card's padding; header row `hover:bg-transparent`. Used by constraints, publishing (validity, links), teacher absence and gaps.
- **Dense matrices** (timplan grid, täckning, staffing matrix, timplansposter, timetable) keep a raw `<table>` with sticky columns but copy the frame: `rounded-lg border bg-card`, sr-only caption, `text-xs` muted heads, sticky cells on `bg-card`.
- **Group rows:** `bg-muted/40`, `py-1.5`, label-caps text, no hover change.
- **Row actions (`RowActions`):** the last cell, right-aligned, width sized to its buttons (`w-24` for two, `w-32` three, `w-40` four). Ghost icon buttons named after the row ("Redigera 7A"), the same text as `title`. Past three (or the page's `inlineMax`), the rest fold into a "Fler åtgärder för {name}" menu whose action runs after the menu closes. The delete icon is not red.
- **Record lists:** `ul divide-y rounded-md border` with `li px-3 py-2 text-sm`.

### Notices and the state ladder
- **Notice** is the one callout: `rounded-md px-4 py-3 text-sm text-foreground`, a font-medium title line, a body, an optional outline small action and an optional ghost dismiss. Tones: neutral (`bg-muted`, no border, no icon); warning (`border-warning/50 bg-warning/10`, TriangleAlert in `warning-strong`); destructive (`border-destructive/40 bg-destructive/5`, OctagonX in `destructive`); success (`border-success/40 bg-success/10`, CircleCheck in `success-strong`). The role is `alert` for destructive and `status` otherwise; pass `role={null}` inside a region that is already live.
- **State ladder**, for every query-backed region, in this order:
  1. **Loading:** a full-width Skeleton inside `aria-busy="true"`: 16rem tall at page level, 24rem for grids and matrices, 4–6rem for a section.
  2. **Error:** `LoadError` with "X kunde inte hämtas" and a hint that says what did not change. At page level it is an EmptyState with TriangleAlert in a `role="alert"` wrapper; inline it is a destructive Notice.
  3. **No scope** (no läsår, nothing chosen): an EmptyState with a domain icon, a title saying what to pick, and an action when one exists.
  4. **Empty:** at page level, an EmptyState (dashed `rounded-lg` box, `py-16`, muted icon disc, h3 title, muted `max-w-sm` description, CTA) whose title says why it is empty. At section level, one muted non-italic sentence. A search or filter that matches nothing is an in-table "Inget matchar …" row, never the empty state.
  5. **Refetch failed** with data already in hand: the content stays as last read, and an inline `LoadError` (destructive Notice) above it carries the shared `common.refetchFailedHint`. Only a failure with nothing in hand stops the region.

### Chips (Badge)
- `rounded-md border px-2 py-0.5 text-xs font-medium`, default size only. Variants: default (primary fill), secondary (muted fill), destructive (solid red), success (15% tint, `success-strong` ink), warning (15% tint, `warning-foreground` ink, `warning` in dark), outline (hairline, foreground).
- The variant always comes from a map in `status-variants.ts`. Rows of count Badges may sit inside a row or card, never as a page summary.

### Forms
- **FormField:** `space-y-1.5`; a Label `htmlFor` the control; an optional muted "(valfritt)" inside the label; a `text-xs` muted hint and a `text-xs` destructive error, both linked by `aria-describedby`; the error also sets `aria-invalid`. For a Radix Select, the id and aria props go on the SelectTrigger (render-function child).
- **Controls:** Input, Textarea, Select and NativeSelect are 36px tall (Textarea at least 60px), `rounded-md border-input-strong`, `px-3`, text-sm, focus `ring-2 ring-ring`. Radix Select is the default select.
- **FilterBar:** `flex flex-wrap items-end gap-3` of FilterFields (a visible label above the control). Typical widths: DateField `w-40`, Select `w-44`, SearchField `max-w-sm` with the Search icon inside the left edge. Toolbar-only actions go last with `ml-auto` as outline small buttons; counts sit inline as muted text-sm.
- **Switch rows:** `flex items-start justify-between gap-4 rounded-md border p-3`.
- **Pending:** a spinning Loader2 replaces the button's icon and the label says what is happening ("Sparar …"). Results go to a toast; form errors to a destructive Notice inside the form.
- **Stepper:** an `ol` of `rounded-full` pills with ArrowRight between them. The current step is primary-filled with `aria-current="step"`; a done step is success-tinted with a `success-strong` Check and a screen-reader ", klart".

### Overlays
- **Dialog:** centred, `border bg-background p-6 shadow-lg`, `rounded-lg` from `sm`. It is capped at `100dvh - 2rem` with vertical scroll and `overflow-x-hidden`, so content must wrap and never widen; do not add another `max-h`. Header: title plus muted description. Footer: outline "Avbryt" and the confirm, stacked reversed on phones; a destructive delete sits at the footer's left (`sm:justify-between`). Focus returns to the element that opened the dialog, even when it was opened from state.
- **Size ladder:** `max-w-md` (28rem) for confirmations; `max-w-lg` (32rem, default) for create and edit forms; `max-w-2xl` (42rem) for review dialogs and lists (cover candidates and proposal, carry, cover settings); `max-w-4xl` (56rem) for wide diffs and proposals (staffing proposal, SS12000 diff review).
- **Side sheet:** the teacher-drawer recipe restyles DialogContent to a full-height `max-w-xl` panel on the right with no radius and no zoom.
- **ConfirmDialog:** every destructive or irreversible act (delete, unlink, cancel-all, reject, withdraw). A named title ("Ta bort {name}?"), a consequence body, `confirmLabel` = the verb. While `loading`, Escape, outside clicks and the X are blocked as well as the buttons.
- **Lazy dialogs:** dialogs are `React.lazy` with `Suspense fallback={null}`, mounted on first open, inside `DialogLoadBoundary`. If a chunk fails to load, the boundary hands the error to the page and remounts under a new key so the next open retries. Optional cards on budget-tight routes lazy-load with a fallback that renders nothing.

### Navigation
- The sidebar has a 4rem brand row (an 8×8 primary tile with CalendarRange, "SchemaPro" and the school name). The admin menu is grouped by the manual's four phases: an unlabelled Översikt, then Grunddata, Planering, Schemaläggning and Drift, then an unlabelled Integrationer last.
- Items are `rounded-md px-2.5 py-2 text-sm font-medium` with a size-4 icon. The active item is `sidebar-accent` with `aria-current="page"`; hover is `sidebar-accent/50`. Group labels are xs, semibold, uppercase, `tracking-wider` and full muted-foreground (at 70% they failed contrast).
- **Shared icons:** several entries borrow another entry's lucide icon (GraduationCap for Kom igång and Läsår; CalendarRange for Ramtider and Publicering; CalendarClock for Dagsplanering and Vikarietavla; CalendarOff for Lov and Avbokning; MapPin for Salar and Lokalbokningar). The shell is billed on every route, so a new nav entry reuses an icon already in the shell and says which one it borrows in a comment.
- **Mobile drawer:** a hand-written modal (not Radix, for the shell's byte budget) with `aria-modal`, focus moved to its close button, Tab wrapped inside, Escape to close, and focus returned to the hamburger.

### Bundle-budget exceptions
- **NativeSelect** (`NATIVE_SELECT_CLASS`, styled like Input, the same edge and 2px focus ring) instead of Radix Select on `/guardian` (phone-first, core tier), in integrations, in the cover candidates dialog and in the availability editor. Radix Select costs about 15 KB gzipped on a route with no other popover (+8.7 KB measured for YearSelect on /admin/generate), so weigh it before adding a YearSelect to a page with no other Select.
- `RowActions`' overflow uses DropdownMenu because it is already in the shell's chunk (the locale switcher).
- `/guardian` lazy-loads TeachingTimeCard and ChildSchedule with a null fallback, so the absence report never depends on those chunks.

## Do's and Don'ts

### Do:
- **Do** start every signed-in page with `<Page width>` and one `PageHeader`, and render every state branch inside the same width.
- **Do** run the state ladder (loading → error → no scope → empty → content) on every query-backed region, and give every error a hint saying what did not change.
- **Do** name every icon button after its object ("Ta bort 7A"), and make every section a `<section>` named by its heading.
- **Do** take Badge variants from `status-variants.ts`, and add a new domain map there rather than a local one.
- **Do** write icons as lucide components at `size-4`, `aria-hidden` when decorative (Button already sizes child SVGs to 16px).
- **Do** keep the AAA policy on the pages that claim it (`/admin/breaks`, `/admin/gaps`, and the summary lines on timplansposter). There, all text is `foreground`: `intro` instead of `subtitle`, `descriptionClassName`/`hintClassName="text-foreground"` on EmptyState, LoadError, SectionCard and FormField, table heads overridden to foreground, prose at `max-w-prose leading-relaxed`, boxed controls `h-11 border-muted-foreground`. Each such page keeps its measured contrast table in its header comment, including what it does not meet.
- **Do** honour reduced motion through the global block in `globals.css` (every animation and transition finishes in 0.01ms, `.animate-spin` exempt). A script that asks for smooth scrolling must check the media query itself.
- **Do** format dates and times with Intl and the active locale, and use " · " as separator and "–" for ranges.

### Don't:
- **Don't** add `mb-*`/`mt-*` or negative margins to page blocks, or bake margins into shared components; spacing comes from Page's `space-y-4`.
- **Don't** put red or green text on its own tint; carry the tone in the surface, edge and `-strong` icon.
- **Don't** paint a destructive trigger red; red belongs only on the ConfirmDialog's confirm.
- **Don't** put summary figures in header actions or filter rows, or render a failed figure as 0.
- **Don't** hand-roll chips, callouts or table frames, or use raw palette classes (`amber-*`, `red-*`) in signed-in pages.
- **Don't** add `max-h-[90vh] overflow-y-auto` to a dialog; DialogContent already caps and scrolls.
- **Don't** use the generic "Tillbaka" or "Bekräfta" when the destination or the verb can be named.
- **Don't** add a new icon import to the app shell for a nav entry when an existing one can be shared.
