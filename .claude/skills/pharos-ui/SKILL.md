---
name: pharos-ui
description: The Pharos interface's design system and UX rules. Covers its look, its type, spacing, radius and layer scales, the components to reuse, how actions, approval, progress and history behave, and how UI text is written. Use before adding or changing anything in packages/ui (a screen, dialog, window, control, menu item, CSS rule or UI text), when reviewing UI work, and when deciding what the window assistant's layout spec can contain.
---

# Pharos UI

Pharos is a working tool for scientists. A screen succeeds when someone new
can tell what it's for and what to do next without reading help. It should
look good because it's consistent and quiet, not because it's decorated.

Before changing a surface, read its section of `packages/ui/src/style.css`
(sections start with `/* ---- name */`) and reuse what's there. Add a class
only when no existing one fits.

## The look (decided: extend it, don't redesign it)

- A warm paper desk (`--paper`) with sheets (`--sheet`) and white surfaces
  (`--surface`) on it, and ink text (`--ink`, `--text`).
- The serif (`--serif`) is for titles only: `.display`, dialog `h2`, the
  assistant's title. Everything else is the system sans.
- Labels are small spaced monospace capitals (`.eyebrow`, `button.primary`).
- Use thin rules (`--line`, `--line-strong`) instead of boxes and fills.
  Shadows (`--shadow*`) are only for things that float: windows, popovers,
  dialogs.
- Colours have fixed meanings. Don't use them to decorate:
  - `--accent` (blue): focus, selection, what needs attention
  - `--ai` (violet) plus the `sparkle` icon: something the assistant
    suggested or did
  - `--danger`: destructive actions and failures
  - `--warn-*`: warnings
- Light is the default. Dark is opt-in (`data-theme="dark"`). Every colour
  comes from a token defined in both theme blocks at the top of `style.css`.
  Never type a hex or `rgba()` into a component rule. The success green
  `#3d8b5a` breaks this rule today; give it a token (`--ok`) instead of
  copying it.

## Scales

The stylesheet predates these scales, so off-scale values exist. New rules
use only the scales. When you edit an existing rule, move its values onto
the scale.

| What | Allowed values |
| --- | --- |
| Sans text | 11 (meta, badges), 12 (`.small`, secondary), 13 (controls, drawer, chat), 14 (base), 16 (section titles) |
| Serif titles | 20, 26, 34, 44 (larger only on the welcome screen) |
| Mono caps | 10.5 (`.eyebrow`, `kbd`), 11 (`button.primary`) |
| Spacing | 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48 px (1px only for hairline offsets) |
| Radius | 3 for controls (buttons, chips, fields); 6 for panels (popovers, dialogs, cards, drop zone); 10 for windows; 50% or 999px for dots and pills |

Sizes are in px; half pixels only where listed.

Layers: `.desktop` is its own stacking context. The windows inside it stack
by a JS counter in `windows.ts`, which starts at 11, next to the ask box
(480) and the minimised stack. Above the desktop:

| Layer | z-index |
| --- | --- |
| top bar | 500 |
| menus | 700 |
| toast | 900 |
| overview | 1000 |
| drop overlay | 5000 |

Modals use `<dialog>` and `showModal()`, which puts them in the browser's
top layer, so they need no z-index. A new floating element takes the layer
of its closest peer. Never invent a new z-index number.

Fixed sizes:

- The Controls drawer is 252px wide.
- The assistant column is `min(300px, 24vw)` and is hidden below 1100px.
- Icon buttons are 30×30.
- `icon(name, size)` sizes: 13–14 inside text and chips, 15–16 in buttons
  and toolbars.

## Components to reuse

| Need | Use |
| --- | --- |
| The main action of a surface | `button.primary` (ink fill, mono caps): at most one per dialog, drawer section or panel |
| A secondary action | `.btn`, or a plain `<button>` in a dialog `<footer>` |
| A low-weight action inside text | `.link` or `.link-btn` ("View log") |
| An icon-only action | `.icon-btn` with `aria-label` (and `title` for the hover hint) |
| Picking one of a few options | `.chip`, with `.on` for the chosen one |
| Parameter forms | `manifestParamFields()` / `readManifestParams()` (`param-fields.ts`), built from `ParamSpec`; never build them by hand |
| A form row | `label.field` wrapping its control; `label.check` for checkboxes |
| A section label | `.eyebrow`; in the drawer, `.ctl-sec` with `.ctl-sec-title` |
| Secondary text | `.muted`, `.small`; for inline warnings, `.chat-warn`; for errors, `.error` |
| Work in progress | `progressHtml()`, `barHtml()`, `clockHtml()` (`progress.ts`): the same block for steps, activity and the busy line; never a bare spinner |
| Modals | `showDialog`, `confirmDialog`, `alertDialog`, `promptDialog`, `browseDialog` (`dialogs.ts`): `<h2>`, then the body, then a `<footer>` with Cancel first and the primary last |
| Confirmations and slow work | `notify(text)` shows a toast; `busy(label, fn)` shows the busy line and turns errors into a dialog |
| Icons | `icon(name, size)` (`icons.ts`): line icons on a 24×24 grid in `currentColor`, already `aria-hidden`. Draw new ones in the same style; no emoji or icon fonts |
| Sizes and escaping | `formatSize()`; and `escapeHtml()` on everything put into markup |

## How things behave

- **Every command is an entry in `ACTIONS`** (`main.ts`, `act({...})`), with
  a title, menu, icon, keywords, and optionally a shortcut and description.
  That one entry gives the command its menu item, its place in the ask box's
  search, and its shortcut. A feature with no UI isn't done.
- **Ellipses:** a title that opens a dialog ends with `…` ("Add data…"). One
  that acts immediately doesn't.
- **Nothing runs without approval.** New or changed steps show as
  *proposed*, with a single "Approve and run". Ship downloads are listed
  with their sizes before they start. Never offer "download everything".
- **Running work is never silent.** It shows its phase, a live clock, a
  progress bar (or the indeterminate stripe), and ways to view the log and
  to cancel. After `QUIET_MS` (30 seconds) with no news, it says so.
- **History is the undo.** Processes land on the window's timeline, and
  selecting a node shows that result. Layout edits by the assistant apply
  immediately and can be undone; steps it adds wait for approval.
- **Tools live in windows.** A data window offers processing for the data it
  shows (its ⋯ menu and "Suggested for this data"). There's no global tool
  palette.
- **Destructive actions** confirm with a specific verb ("Remove 3 ships")
  or offer undo, and say what's kept ("your data on disk is kept").
- **The assistant explains itself.** What it proposes carries its
  `rationale`, marked with `--ai` and the sparkle icon.

## Clarity rules

1. One primary action per surface. The next step should be obvious without
   reading anything.
2. Show what's needed now and put details behind a disclosure (like "What
   data can I use?" on the welcome screen).
3. Put help next to the thing it explains, where it can be seen. A `title`
   tooltip can repeat it but is never the only place an explanation lives:
   keyboard and touch users never see tooltips.
4. People see titles, never ids: book and ship titles, a parameter's `label`
   and `unit`. Don't show `ship › operation`, snake_case names, raw paths or
   JSON unless someone asked for detail.
5. One name for each thing, and only that name: book, ship, window,
   history, Controls, the assistant. In UI text, a book is never a
   "recipe" or "pipeline".
6. Every empty state says what will appear there and how to get it
   ("Processes you add from ⋯ land here").
7. Every error says what happened and what to do next.
8. Numbers always carry units. Columns of numbers use
   `font-variant-numeric: tabular-nums`. File sizes go through
   `formatSize()`.

## Writing

- Use sentence case everywhere: titles, buttons, menus ("Approve and run").
  Ignore any guideline that asks for Title Case.
- Keep it short and plain, in the second person and active voice. Say what
  something does for the user ("Track the cells over time").
- Buttons name the outcome as a verb ("Apply and re-run", "Choose this
  folder"). Avoid "OK" or "Continue" when a verb fits.
- Use `…`, not `...`; loading text ends with it ("Loading…").
- `·` joins facts on one line; `›` shows a path ("File › Add data…").
- No exclamation marks, "Oops" or emoji.

## Accessibility baseline

- Use `<button>` for actions, a `<label>` wrapping each input, and
  `<dialog>` for modals. Never put a click handler on a `div` or `span`.
- Icon-only buttons need an `aria-label`.
- The global `:focus-visible` ring uses `--accent`. Any rule that removes an
  outline must show focus on its container with `:focus-within`.
- Updates that happen while you wait (toasts, run status) need
  `role="status"` or `aria-live="polite"`.
- Animate `transform` and `opacity` only, and list the properties (never
  `transition: all`). A global reduced-motion rule turns animations off, so
  motion must never be the only signal of a state.
- `--faint` is for decoration and disabled states only, never for text
  someone needs to read.

## The window assistant's layout spec

The window assistant never writes HTML. It returns a layout spec that the
UI renders with these components, at the drawer's 252px width (see
`userflow.md`). The spec's vocabulary is the components above: sections,
fields from `ParamSpec`, chips, notes and one primary action. Bindings
point at step parameters, so every edit can be undone. If something can't
be expressed in the spec, extend the renderer; never pass markup through.

## Before you finish

- Look at it. Run `npm run build`, then `npm start`. Check light and dark
  themes, widths of 1100px and 760px, keyboard only (Tab through it), and
  reduced motion.
- Run the `web-design-guidelines` skill on the files you changed.
- Search your diff for raw hex or `rgba()`, new z-index numbers, off-scale
  px values, `title=` used as the only help, and ids or synonyms in UI text.
