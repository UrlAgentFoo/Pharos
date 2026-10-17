---
name: web-design-guidelines
description: Review Pharos UI code against the Web Interface Guidelines (accessibility, focus, forms, motion, content, interaction), adapted to Pharos. Use when asked to review or audit the UI, check accessibility or UX, or before finishing a change to packages/ui.
metadata:
  author: vercel (adapted for Pharos)
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines, for Pharos

Adapted from Vercel's `web-design-guidelines` skill (MIT, see `LICENSE`).
The upstream skill downloads its rules on every run. Here they're a reviewed
copy in `rules.md`, so a review never follows instructions that changed
upstream without anyone looking. The copy is from
`vercel-labs/web-interface-guidelines` `command.md`, commit `4ecfb9f`
(2026-10-05). To update it, download that file again, read the diff, then
replace `rules.md`.

## How it works

1. Read `rules.md` in this folder, and the `pharos-ui` skill.
2. Read the files given as the argument. With no argument, review
   `packages/ui/index.html` and `packages/ui/src/*.ts`, plus the parts of
   `packages/ui/src/style.css` those files use.
3. Check them against every rule that applies, using the Pharos notes below.
4. Report in the format `rules.md` gives (grouped by file, `file:line`,
   terse). Put the most serious findings first, and give each a fix when the
   fix isn't obvious.

## Pharos notes

The UI is plain TypeScript building HTML strings, with no framework.
Translate the rules accordingly:

- **Skip** the React and Next-specific rules: hydration, `useState`/URL sync
  via nuqs, `<Link>`, `priority`, controlled vs uncontrolled inputs.
- **Translate** `onKeyDown` to `addEventListener("keydown")`, and
  `htmlFor` to a wrapping `<label>` (the Pharos pattern).
- **Overridden by `pharos-ui`:** Title Case. Pharos uses sentence case.
- **Doesn't apply:** "URL reflects state". Pharos is a local app whose state
  is the project file.
- **Matters most here:**
  - icon-only buttons
  - labels on generated forms
  - help that exists only in a `title` tooltip
  - `aria-live` on run status
  - `:focus-visible` replacements where an outline is removed
  - `transition: all`
  - text that overflows narrow windows and the 252px drawer
  - long lists (ships, books, workspace entries)
  - confirmation or undo on destructive actions
- When a `pharos-ui` rule and a guideline disagree, `pharos-ui` wins. Say so
  in the finding.
