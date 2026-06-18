---
version: alpha
name: サニー Terminal
description: >-
  The visual identity for Sunny's read-only web dashboard — a terminal-inspired
  observability surface themed after the Tokyo Night VS Code palette, set in a
  monospace coder typeface. Source of truth for the dashboard's Tailwind theme.
colors:
  # Surfaces (Tokyo Night backgrounds, darkest → elevated)
  bg: "#1a1b26"
  bg-dark: "#16161e"
  surface: "#1f2335"
  surface-elevated: "#292e42"
  border: "#414868"
  # Foreground / text
  fg: "#c0caf5"
  fg-muted: "#a9b1d6"
  fg-dim: "#565f89"
  # Accents (semantic roles map onto Tokyo Night's accent hues)
  primary: "#7aa2f7"
  secondary: "#bb9af7"
  tertiary: "#7dcfff"
  neutral: "#565f89"
  # Status
  success: "#9ece6a"
  warning: "#e0af68"
  error: "#f7768e"
  info: "#7dcfff"
  accent: "#ff9e64"
typography:
  masthead:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: 0.15em
  headline-lg:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.2
  headline-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.3
  body-lg:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.08em
  label-sm:
    fontFamily: ui-monospace, "JetBrains Mono", "Fira Code", monospace
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.1em
spacing:
  base: 16px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
rounded:
  none: 0px
  sm: 3px
  md: 6px
  lg: 10px
  full: 9999px
components:
  link:
    textColor: "{colors.tertiary}"
  menu-item:
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: 8px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: 16px
---

# サニー Terminal

## Overview

This is the design language for **Sunny's web dashboard** — a *read-only* window
into a personal AI agent's innards: what it remembers, what it has said (and
privately thought), what it has scheduled, and how it is running. It is a place
for **looking, not driving**.

The mood is a calm, late-night terminal: a dark canvas, a single monospace
voice, and restrained jewel-toned accents drawn from the **Tokyo Night** VS Code
theme. The interface should read like a well-kept `tmux` session — dense but
legible, structured like a directory listing, never noisy. Color is used
sparingly and semantically (status, links, emphasis), never decoratively. The
overall feeling is precise, trustworthy, and quietly technical.

## Colors

The palette is **Tokyo Night**: deep desaturated-indigo surfaces under a soft
periwinkle foreground, with a small set of luminous accents reserved for meaning.

- **Background (#1a1b26):** The base canvas — a near-black indigo that anchors
  every page and keeps long reading sessions easy on the eyes.
- **Surface (#1f2335) / Surface Elevated (#292e42):** Tonal layers for cards and
  panels; depth comes from these steps in tone, not from shadow.
- **Border (#414868):** A muted slate for hairline rules, dividers, and panel
  edges.
- **Foreground (#c0caf5):** The primary periwinkle text color, with **Muted
  (#a9b1d6)** for secondary text and **Dim (#565f89)** for metadata and comments.
- **Primary (#7aa2f7):** Tokyo Night blue — the core interactive accent for
  emphasis and active navigation.
- **Secondary (#bb9af7):** A magenta-violet for secondary emphasis and headings.
- **Tertiary (#7dcfff):** Cyan — used exclusively for hyperlinks so links are
  unmistakable against prose.
- **Status — Success (#9ece6a), Warning (#e0af68), Error (#f7768e):** Green /
  amber / red, used only to signal health and run outcomes.
- **Accent (#ff9e64):** A warm orange held in reserve for the rare highlight that
  must stand apart from the cool palette.

## Typography

A single **monospace coder stack** (`ui-monospace, "JetBrains Mono",
"Fira Code", monospace`) is used everywhere — the terminal aesthetic depends on
the fixed-width grid. Hierarchy comes from size and weight, not from switching
families.

- **Masthead:** The Katakana name **サニー** sits at the top of every page in
  bold, widely letter-spaced monospace — the prompt banner of the session.
- **Headlines:** Bold/semibold monospace establish page and section structure.
- **Body:** Regular monospace at 14–15px with generous line-height for the
  long-form markdown of memory and conversation.
- **Labels:** Small, uppercase-friendly monospace with extra letter-spacing for
  metadata, timestamps, and menu chrome — the "status line" voice.

## Layout

A single-column, **fixed-max-width reading column** (roughly 960px) centered on
the canvas, evoking a focused terminal pane. A strict **8px spacing scale** (with
a 4px half-step) keeps a consistent vertical rhythm; cards use 16px internal
padding.

Navigation differs by page depth: the **home page** presents the menu as a
**vertical, enumerated index** (a terminal directory listing); **child pages**
pin the menu as a **horizontal, side-scrolling bar** at the top so it never
wraps on narrow screens.

## Elevation & Depth

Depth is conveyed through **tonal layers**, not shadow. The page background is the
darkest tone; cards and panels step up through Surface and Surface Elevated, and
**borders** (not drop shadows) delineate regions. This keeps the flat, matte feel
of a terminal.

## Shapes

Restrained, lightly-softened rectangles. Corner radii stay small (3–10px) so the
UI feels engineered rather than rounded; the `full` radius is reserved for status
dots and pills. Sharp, consistent edges reinforce the technical character.

## Do's and Don'ts

- Do render links in the cyan tertiary color, as human-readable text — never show
  a raw URL.
- Do reserve green/amber/red strictly for status and run outcomes.
- Do keep to the single monospace family; vary size and weight for hierarchy.
- Don't use drop shadows; convey depth with tonal surface steps and borders.
- Don't introduce decorative color — accents must carry meaning.
- Don't expose any control affordance (send, edit, trigger); this surface is
  observe-only.
