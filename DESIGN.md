---
version: alpha
name: サニー Terminal
description: >-
  The visual identity for Sunny's read-only web dashboard — a TUI (text-user-
  interface) rendered in the browser: GitHub Dark palette, one monospace size on
  a fixed vertical rhythm, hierarchy from weight / case / rules, links not buttons.
colors:
  # Surfaces (GitHub Dark "canvas", darkest → elevated)
  bg: "#0d1117"
  bg-dark: "#010409"
  surface: "#161b22"
  surface-elevated: "#21262d"
  border: "#30363d"
  # Foreground / text
  fg: "#e6edf3"
  fg-muted: "#8b949e"
  fg-dim: "#6e7681"
  # Accents (GitHub Dark semantic roles)
  primary: "#58a6ff"
  secondary: "#bc8cff"
  tertiary: "#58a6ff"
  neutral: "#6e7681"
  # Status
  success: "#3fb950"
  warning: "#d29922"
  error: "#f85149"
  info: "#58a6ff"
  accent: "#f0883e"
typography:
  # ONE size (15px) on ONE line-height (24px row). Every level is the same size;
  # hierarchy comes from weight, case, color, and rules — never size (a terminal
  # has a single cell height). Levels are kept as named roles only.
  masthead:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: 0.2em
  headline-lg:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: 0.04em
  headline-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 700
    lineHeight: 24px
  body-lg:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  body-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  body-sm:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  label-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 500
    lineHeight: 24px
    letterSpacing: 0.08em
  label-sm:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 500
    lineHeight: 24px
    letterSpacing: 0.08em
spacing:
  # All vertical space is a multiple of the 24px row (or its 12px half / 6px
  # quarter), so blocks land on the terminal grid.
  base: 24px
  xs: 6px
  sm: 12px
  md: 24px
  lg: 36px
  xl: 48px
  row: 24px
rounded:
  # Sharp corners — a terminal draws boxes with line characters, never radii.
  none: 0px
  sm: 0px
  md: 0px
  lg: 0px
  full: 9999px
components:
  link:
    textColor: "{colors.primary}"
  pane:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.none}"
    padding: 24px
---

# サニー Terminal

## Overview

This is the design language for **Sunny's web dashboard** — a *read-only* window
into a personal AI agent's innards: what it remembers, what it has said (and
privately thought), what it has scheduled, and how it is running. A place for
**looking, not driving**.

It should not merely be *dark and monospace* — it should read as an actual
**TUI rendered in the browser**, like `lazygit`, `htop`, or a well-kept `tmux`
session. That means a single type size on a fixed character grid, regions drawn
with line rules rather than floating cards, hierarchy carried by **weight, case,
color, and spacing**, and a strict vertical rhythm so the whole page looks
*printed by a terminal*, line by line. Precise, dense, quietly technical.

## Colors

The palette is **GitHub Dark** (Primer): near-black slate canvases under a soft
off-white foreground, with a small set of accents reserved for meaning.

- **Background (#0d1117):** The base canvas. **Inset (#010409)** is the darkest
  well (code blocks); **Surface (#161b22)** / **Surface Elevated (#21262d)** are
  the faint tonal steps used sparingly for grouping.
- **Border (#30363d):** The line color — every rule, divider, and box edge.
- **Foreground (#e6edf3):** Primary text, with **Muted (#8b949e)** for secondary
  text and **Dim (#6e7681)** for metadata, timestamps, and comments.
- **Primary (#58a6ff):** GitHub blue — links, active navigation, and every
  interactive affordance (which all read as links, never buttons).
- **Secondary (#bc8cff):** Purple — Sunny's own voice and section emphasis.
- **Status — Success (#3fb950), Warning (#d29922), Error (#f85149):** Green /
  amber / red, used only for health and run outcomes.
- **Accent (#f0883e):** Orange, held in reserve for a rare highlight.

## Typography

A single **monospace coder stack** at a **single size (15px)** on a **24px line**
— the cell of the grid. There is exactly one font size; you may **not** scale
text for emphasis. Hierarchy is expressed only by:

- **Weight** — bold for headings, section labels, and Sunny's name.
- **Case** — **Title Case** for headings, labels, and chrome (never lowercase,
  never ALL-CAPS). Filenames keep their literal case (`SUNNY.md`).
- **Color** — dim for metadata, blue for links, purple for Sunny, status hues.
- **Spacing** — headings/sections are set off by a blank row, the way a terminal
  prints a heading; never by a larger font, a rule, or an underline.

Italics may mark quoted or de-emphasized text. The masthead **サニー** is the
same size as everything else — bold and widely spaced, like a title bar, not a
logo.

## Layout

A single-column, **fixed-max-width reading column** (~900px) centered on the
canvas — one focused terminal pane.

**Vertical rhythm is law.** Every line of text sits on the 24px baseline grid,
and every vertical gap (between paragraphs, list rows, sections, panels) is a
whole multiple of the 24px row (or its 12px half). Nothing uses an arbitrary
margin; the page should look like consecutive printed lines with blank lines
between blocks. Horizontal padding is a multiple of the character width.

Navigation differs by page depth: the **home page** presents the menu as a
**vertical, enumerated index** (a directory listing); **child pages** pin the
menu as a **horizontal, side-scrolling bar** at the top.

## Elevation & Depth

There is **no elevation** — no shadows, no floating cards — and **no CSS borders,
rules, dividers, or `<hr>`s**. A terminal draws structure with text and blank
space, not strokes. Regions are delineated by **spacing (blank rows), indentation,
and dim Title-Case labels**. The faint surface tones are used only to shade an
inset (a code block, a selected row), never to outline or lift a region off the
page.

## Shapes

**No CSS-drawn shapes** — no `border`, `rule`, `outline`, `box-shadow`, or rounded
corner anywhere; structure is text on the canvas. The one exception is the
terminal's *own* way to draw a frame: **box-drawing line characters**
(`┌─┐ │ └─┘`, `─`) rendered as text. Used sparingly (e.g. framing the top nav),
an ASCII line-box is on-language; a CSS border is not. The only non-text element
in the whole UI is the small round status dot — no pills, no rounded buttons.

## Components

- **Links & actions:** every interactive element renders as a **hyperlink** —
  blue text, underline on hover, no border, no fill, no padding box. Navigation,
  "request access", search submit, tab, accordion toggle: all are link text
  (optionally bracketed `[like this]` or prefixed `›`), never a styled button.
- **Panes:** a titled region is just a Title-Case dim label and the content below
  it, separated from neighbors by a blank row. No box, no border, no rule.
- **Headings:** bold, Title-Case text on the grid, set off by a blank row — never
  by a larger font, a rule, an underline, or a border.
- **ASCII frames:** where a region genuinely needs a frame (e.g. the top nav),
  draw it with box-drawing *characters* (`┌─┐ │ └─┘`), not a CSS border.
- **Tables/lists:** dense rows on the baseline grid, columns aligned by the
  monospace cell and separated by spacing (not hairlines); metadata dimmed.

## Do's and Don'ts

- Do render every action as a hyperlink (blue, hover-underline) — never a button.
- Do Title-Case headings, labels, and chrome — never lowercase, never ALL-CAPS.
- Do express hierarchy with weight, case, color, and spacing — never size.
- Do keep every block on the 24px baseline grid for a consistent vertical rhythm.
- Do reserve green/amber/red strictly for status and run outcomes; links stay blue.
- Do draw any needed frame with box-drawing *characters* (`┌─┐`), used sparingly.
- Don't use a second font size, rounded corners, shadows, cards, or any CSS border
  / rule / divider / `<hr>` — a terminal has no strokes.
- Don't render a raw URL, or expose any control (send/edit/trigger) — observe-only.
