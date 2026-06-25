# Terminal -- Style Reference
> A TUI rendered in the browser: GitHub Dark palette, one monospace size on a fixed vertical rhythm, hierarchy from weight / case / color / spacing -- links, not buttons.

**Theme:** dark

**Source:** Sunny's own dashboard design language (`DESIGN.md` in this repo) -- the サニー Terminal identity, GitHub Dark (Primer).

This style should read as an actual terminal UI -- like `lazygit`, `htop`, or a well-kept `tmux` session -- not merely "dark and monospace." A single type size on a fixed character grid, regions separated by blank rows rather than floating cards, hierarchy carried by weight/case/color/spacing, and a strict vertical rhythm so the page looks printed line by line. Precise, dense, quietly technical.

## Fonts (self-contained HTML)

One monospace face, on Google Fonts, loaded with a single `<link>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

Everything is `--font-mono`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, "Fira Code", monospace`. There is exactly one font family.

## Tokens -- Colors (GitHub Dark / Primer)

| Name | Value | Token | Role |
|------|-------|-------|------|
| Background | `#0d1117` | `--color-bg` | Base canvas |
| Inset | `#010409` | `--color-bg-dark` | Darkest well -- code blocks |
| Surface | `#161b22` | `--color-surface` | Faint tonal step for grouping (sparing) |
| Surface Elevated | `#21262d` | `--color-surface-elevated` | Slightly lifted inset / selected row |
| Border | `#30363d` | `--color-border` | The line color -- every rule, divider, ASCII frame |
| Foreground | `#e6edf3` | `--color-fg` | Primary text |
| Muted | `#8b949e` | `--color-fg-muted` | Secondary text |
| Dim | `#6e7681` | `--color-fg-dim` | Metadata, timestamps, comments |
| Primary | `#58a6ff` | `--color-primary` | GitHub blue -- links and every interactive affordance |
| Secondary | `#bc8cff` | `--color-secondary` | Purple -- emphasis / a distinct voice |
| Success | `#3fb950` | `--color-success` | Health / good outcomes only |
| Warning | `#d29922` | `--color-warning` | Caution only |
| Error | `#f85149` | `--color-error` | Failure only |
| Accent | `#f0883e` | `--color-accent` | Orange, reserved for a rare highlight |

## Tokens -- Typography

A single monospace stack at a **single size (15px)** on a **24px line** -- the cell of the grid. There is exactly one font size; do **not** scale text for emphasis. Hierarchy comes only from:

- **Weight** -- 700 for headings, section labels, and the masthead; 500 for labels; 400 for body.
- **Case** -- Title Case for headings, labels, and chrome (never lowercase, never ALL-CAPS). Filenames keep their literal case (`SUNNY.md`).
- **Color** -- dim for metadata, blue for links, purple for emphasis, status hues for outcomes.
- **Spacing** -- headings/sections are set off by a blank row, the way a terminal prints a heading; never by a larger font, a rule, or an underline.

| Role | Size | Weight | Line height | Letter spacing |
|------|------|--------|-------------|----------------|
| masthead | 15px | 700 | 24px | 0.2em |
| heading | 15px | 700 | 24px | 0.04em |
| label | 15px | 500 | 24px | 0.08em |
| body | 15px | 400 | 24px | normal |

## Tokens -- Spacing & Shapes

**Vertical rhythm is law.** Every gap is a whole multiple of the 24px row (or its 12px half / 6px quarter), so blocks land on the grid.

| Token | Value |
|-------|-------|
| `--spacing-xs` | 6px |
| `--spacing-sm` | 12px |
| `--spacing-md` / row | 24px |
| `--spacing-lg` | 36px |
| `--spacing-xl` | 48px |

**Radius: none.** Sharp corners everywhere (`--radius: 0`). A terminal draws boxes with line characters, never radii. The single exception is the small round status dot (`9999px`).

## Elevation & Depth

There is **no elevation** -- no shadows, no floating cards -- and **no CSS borders, rules, dividers, or `<hr>`**. Structure comes from **blank rows, indentation, and dim Title-Case labels**. The faint surface tones (#161b22 / #21262d) shade an inset (a code block, a selected row) only -- never to outline or lift a region. Where a region genuinely needs a frame (e.g. the top nav), draw it with **box-drawing characters** (`┌─┐ │ └─┘ ─`) rendered as text, never a CSS border.

## Components

- **Links & actions:** every interactive element renders as a **hyperlink** -- blue (#58a6ff) text, underline on hover, no border, no fill, no padding box. Nav, submit, tab, toggle: all link text (optionally bracketed `[like this]` or prefixed `›`), never a styled button.
- **Panes:** a titled region is just a dim Title-Case label and the content below, separated from neighbors by a blank row. No box, no border, no rule.
- **Headings:** bold (700) Title-Case text on the grid, set off by a blank row.
- **ASCII frames:** where a frame is genuinely needed, draw it with box-drawing characters, not a CSS border.
- **Status dot:** the only rounded, non-text element -- a small filled circle in a status hue.

## Layout

A single-column, fixed-max-width reading column (~900px) centered on the canvas -- one focused terminal pane. Every line sits on the 24px baseline; every vertical gap is a whole multiple of the row. The page should look like consecutive printed lines with blank lines between blocks. Horizontal padding is a multiple of the character width. No sidebar.

## Do's and Don'ts

### Do
- Use ONE font size (15px) on a 24px line; express all hierarchy through weight, case, color, and blank-row spacing.
- Render every action as a blue hyperlink; bracket or `›`-prefix it if it needs to look tappable.
- Use Title Case for headings/labels/chrome; keep literal case for filenames and code.
- Separate regions with blank rows and dim labels; shade insets with #161b22 only.
- Keep the column ~900px, single-column, on #0d1117.

### Don't
- Never scale the font size for emphasis -- there is exactly one size.
- Never use CSS `border`, `box-shadow`, `outline`, or `<hr>` -- draw frames with box-drawing characters if needed.
- Never use rounded corners (except the status dot) -- corners are sharp.
- Never use buttons with fills/borders -- interactive = hyperlink.
- Never use ALL-CAPS or lowercase for chrome; never use color outside the defined roles.

## Quick Start -- CSS Custom Properties

```css
:root {
  --color-bg: #0d1117;
  --color-bg-dark: #010409;
  --color-surface: #161b22;
  --color-surface-elevated: #21262d;
  --color-border: #30363d;
  --color-fg: #e6edf3;
  --color-fg-muted: #8b949e;
  --color-fg-dim: #6e7681;
  --color-primary: #58a6ff;
  --color-secondary: #bc8cff;
  --color-success: #3fb950;
  --color-warning: #d29922;
  --color-error: #f85149;
  --color-accent: #f0883e;

  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, "Fira Code", monospace;
  --text-base: 15px;
  --leading-row: 24px;

  --spacing-xs: 6px;
  --spacing-sm: 12px;
  --spacing-md: 24px;
  --spacing-lg: 36px;
  --spacing-xl: 48px;

  --radius: 0px;
  --column-max-width: 900px;
}

body {
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-mono);
  font-size: var(--text-base);
  line-height: var(--leading-row);
}
a { color: var(--color-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
```
