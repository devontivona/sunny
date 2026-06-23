# Sunglow -- Style Reference
> Parchment surfaces beneath monochrome controls, with ambient color appearing only as a deliberate decorative accent.

**Theme:** light

**Source:** Adapted from a style reference on Refero -- https://styles.refero.design/style/031056ff-7af1-46db-8daa-115f731c5d26

Sunglow is a warm-white paper surface system -- an off-white canvas (#fdfcfc) layered with parchment cards (#f5f3f1, radius 20-24px) that feel tactile without being decorative. The typographic personality splits sharply: a light display face (weight 300, negative tracking) for all headlines -- authority through restraint, not mass -- and a neutral grotesk for everything functional. The only color in an otherwise achromatic system is a vivid violet (#0447ff) and orange (#ff4704), used purely as decoration -- soft glowing gradient orbs -- never as a UI state. All interactive affordances are monochrome: black pill buttons, white pill buttons with hairline borders, ghost text links. The system refuses to use color as a call to action.

## Fonts (self-contained HTML)

All four faces are on Google Fonts, so a single page can load them with one `<link>` -- no proprietary/licensed fonts. Add this to `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=Space+Grotesk:wght@700&family=Inter:wght@400;500&family=JetBrains+Mono&display=swap" rel="stylesheet">
```

| Role | Font | Weights |
|------|------|---------|
| Display / headlines | **DM Sans** | 300 |
| Wordmark / logo | **Space Grotesk** | 700 |
| Body / all functional UI | **Inter** | 400, 500 |
| Code / technical labels | **JetBrains Mono** | 400 |

## Tokens -- Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Parchment White | `#fdfcfc` | `--color-parchment-white` | Page canvas -- the dominant background behind all sections and nav |
| Warm Sand | `#f5f3f1` | `--color-warm-sand` | Card surfaces, feature tiles, section backgrounds -- one step warmer and darker than canvas |
| Ash Border | `#e5e5e5` | `--color-ash-border` | All hairline borders on buttons, inputs, cards, nav items, dividers |
| Midnight Ink | `#000000` | `--color-midnight-ink` | Primary text, headline text, filled pill button background, icon fills |
| Driftwood | `#777169` | `--color-driftwood` | Secondary body text, muted link text, icon strokes |
| Fog | `#a59f97` | `--color-fog` | Tertiary helper text, light icon strokes |
| Silver Mist | `#b1b0b0` | `--color-silver-mist` | Subtle background washes, mid-level surface dividers |
| Void Violet | `#0447ff` | `--color-void-violet` | Decorative SVG/gradient orb fill and stroke -- the only chromatic element, never a UI state |
| Ember Orange | `#ff4704` | `--color-ember-orange` | Decorative SVG/gradient orb fill and stroke -- paired with Void Violet in gradient orbs |

## Tokens -- Typography

### DM Sans -- display and section headlines exclusively. `--font-display`
- **Weights:** 300
- **Sizes:** 32px, 36px, 48px
- **Line height:** 1.08-1.17
- **Letter spacing:** -0.02em
- **Role:** Display and section headlines only. Weight 300 is anti-convention for a tech aesthetic -- these headlines whisper authority rather than shout it. Tight negative tracking (-0.02em) compresses letterforms for density at large scale. Never use the body face or a heavier weight for display text.

### Space Grotesk -- logo wordmark and brand identifier only. `--font-wordmark`
- **Weights:** 700
- **Sizes:** 14px
- **Line height:** 1.10
- **Letter spacing:** 0.05em
- **Role:** Logo wordmark only. Wide positive tracking (0.05em) at small size creates a tight-but-spaced badge feel distinct from all body text.

### Inter -- all functional UI text: nav, buttons, body copy, labels, inputs, captions, footer. `--font-body`
- **Weights:** 400, 500
- **Sizes:** 10px, 12px, 13px, 14px, 15px, 16px, 18px, 20px
- **Line height:** 1.0-2.06
- **Letter spacing:** 0.01em
- **Role:** All functional text. Weight 400 for body, 500 for emphasis/nav labels. Subtle 0.01em tracking adds microscopic breath to dense functional text.

### JetBrains Mono -- code snippets, API references, technical inline labels. `--font-mono`
- **Weights:** 400
- **Sizes:** 13px
- **Line height:** 1.69
- **Role:** Code and technical labels. Looser line-height (1.69) distinguishes it from body-text rhythm.

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| caption | 10px | 1.4 | 0.1px | `--text-caption` |
| body | 16px | 1.5 | 0.16px | `--text-body` |
| subheading | 18px | 1.44 | 0.18px | `--text-subheading` |
| heading-sm | 20px | 1.4 | 0.2px | `--text-heading-sm` |
| heading | 32px | 1.17 | -0.64px | `--text-heading` |
| heading-lg | 36px | 1.13 | -0.72px | `--text-heading-lg` |
| display | 48px | 1.08 | -0.96px | `--text-display` |

## Tokens -- Spacing & Shapes

**Base unit:** 4px · **Density:** comfortable

### Spacing Scale
4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 160 (px) -- tokens `--spacing-4` … `--spacing-160`.

### Border Radius

| Element | Value |
|---------|-------|
| tabs | 20px |
| tags | 14px |
| cards | 20px |
| pills / buttons | 9999px |
| badges | 18px |
| inputs | 4px |
| tooltips | 8px |
| cardLarge | 24px |

### Shadows

| Name | Value | Token |
|------|-------|-------|
| subtle | `rgba(0,0,0,0.075) 0 0 0 0.5px inset` | `--shadow-subtle` |
| control ring | `rgba(0,0,0,0.06) 0 0 0 1px, rgba(0,0,0,0.04) 0 1px 2px 0, rgba(0,0,0,0.04) 0 2px 4px 0` | `--shadow-subtle-2` |
| elevated card | `rgba(0,0,0,0.4) 0 0 1px 0, rgba(0,0,0,0.04) 0 1px 1px 0, rgba(0,0,0,0.04) 0 2px 4px 0` | `--shadow-subtle-6` |

### Layout
- **Page max-width:** 1200px · **Section gap:** 80-120px · **Card padding:** 16-32px · **Element gap:** 8px

## Components

### Black Filled Pill Button
**Role:** Primary action -- Get started, Continue, Learn more

Background #000000, text #ffffff, border-radius 9999px, padding 0 16px, border 1px solid #e5e5e5. Inter 15px weight 500. The monochrome black-on-white contrast is the only affordance; no color signal is used.

### White Outlined Pill Button
**Role:** Secondary action -- secondary CTA, back

Background #fdfcfc or transparent, text #000000, border-radius 9999px, padding 0 12px, border 1px solid #e5e5e5. Box-shadow rgba(0,0,0,0.06) 0 0 0 1px, rgba(0,0,0,0.04) 0 1px 2px 0. Inter 15px weight 500.

### Ghost Text Button
**Role:** Inline tertiary action -- nav links, read-all links

Background transparent, text #000000, border-radius 9999px, no border, no horizontal padding. Inter 15px weight 400. Hover triggers a color transition. Pure text affordance with no chrome.

### Rounded Tab Badge Button
**Role:** Tabbed view switcher -- e.g. Overview / Details / Pricing

Background transparent, or #ffffff when active, border-radius 18px, padding 8px 12px, border 1px solid #e5e5e5. Inter 14px weight 500. Active state gets a white background with inset shadow rgba(0,0,0,0.075) 0 0 0 0.5px inset, on a #f5f3f1 outer container.

### Warm Sand Feature Card
**Role:** Primary content tile -- feature descriptions, content sections

Background #f5f3f1, border-radius 20px, no shadow, padding 0 32px. No border. Sits directly on #fdfcfc canvas -- surface contrast does all the separation work.

### White Elevated Card
**Role:** Screenshot tiles and floating UI previews

Background #ffffff, border-radius 20px, padding 16px, box-shadow rgba(0,0,0,0.4) 0 0 1px 0, rgba(0,0,0,0.04) 0 1px 1px 0, rgba(0,0,0,0.04) 0 2px 4px 0. The 0.4-opacity hairline creates a sharp definition edge while the micro-blurs add dimensionality.

### Ambient Accent Orb
**Role:** Decorative illustration -- non-interactive visual identity

A circle with a radial gradient blending Void Violet (#0447ff) and Ember Orange (#ff4704) -- the only chromatic element in the UI. A purely decorative accent, never a UI state indicator. Never place text or UI on top of an orb.

### Text Input Field
**Role:** Search and form inputs

Background #ffffff, border-radius 4px (nearly flush), padding 16px 20px, border 1px solid #e5e5e5, text #000000. The near-zero radius distinguishes inputs from pill buttons and rounded cards -- inputs feel editorial/typewritten.

### Logo Wordmark
**Role:** Brand identifier in top-left nav

Space Grotesk weight 700, 14px, letter-spacing 0.05em, #000000. Small size + wide tracking creates a dense, stamp-like mark.

## Do's and Don'ts

### Do
- Use 9999px border-radius on ALL buttons, nav pills, and tags -- no rectangular buttons exist in this system.
- Apply the display face (DM Sans 300) with -0.02em letter-spacing for every headline 32px and above -- never use the body face or a heavier weight for display text.
- Keep all interactive chrome in the #000000 / #fdfcfc / #e5e5e5 axis -- color (#0447ff, #ff4704) is reserved for decorative orbs/illustration only.
- Use #f5f3f1 at 20-24px radius for primary cards; reserve #ffffff elevated cards (with hairline shadow) for screenshots and UI previews only.
- Use surface-color contrast (#fdfcfc → #f5f3f1) as the primary elevation signal -- shadows should be sub-pixel hairlines, never soft blurs.

### Don't
- Never use #0447ff or #ff4704 for button backgrounds, link colors, hover states, or any interactive affordance -- they appear only in decorative gradient orbs.
- Never use the display (DM Sans) or wordmark (Space Grotesk) face for body text, labels, or buttons -- Inter handles all functional text without exception.
- Never apply heavy shadows (blur > 4px or spread > 2px) -- the shadow vocabulary tops out at 4px blur with 0.04 opacity.
- Never use rectangular (0px radius) buttons or fully square cards -- even inputs have at least 4px radius.
- Never introduce color-coded states (green success, red error, blue info) as prominent UI elements -- this system has no semantic color infrastructure at the UI layer.
- Never set Inter below 10px or above 20px for UI text -- display sizes use DM Sans, not Inter at large scale.
- Never place text or UI on top of the gradient orbs -- they are always isolated floating shapes.

## Surfaces

| Level | Name | Value | Purpose |
|-------|------|-------|---------|
| 1 | Canvas | `#fdfcfc` | Page background -- nearly white with a faint warm cast |
| 2 | Card Surface | `#f5f3f1` | Feature cards, tile backgrounds, section insets |
| 3 | Border / Divider | `#e5e5e5` | Hairline borders on all interactive and structural elements |
| 4 | Elevated Card | `#ffffff` | White cards that float above Warm Sand via a subtle ring shadow |

## Imagery

Sunglow uses two visual registers. Explanatory visuals -- screenshots, diagrams, charts -- sit at full fidelity inside white elevated cards (20px radius), cropped and contained rather than full-bleed. The second register is abstract gradient orbs: perfect circles filled with soft radial gradients blending violet (#0447ff) and orange (#ff4704) through pink and peach mid-tones. These orbs are the only chromatic element on the page and function as a purely decorative accent, not as data. No photography. Icons are minimal outlined style at low stroke weight, monochrome (#777169 or #000000), never multicolor. Image density is low -- text dominates, with visuals appearing in contained sections rather than as atmospheric backgrounds.

## Layout

Max-width ~1200px centered on a #fdfcfc canvas. Navigation is a sticky top bar with a full-width background, pill buttons right-aligned, logo left -- very low height (~36px). Heroes are split asymmetrically: a left-aligned oversized DM Sans 300 headline with a black pill CTA below, and a right-aligned body paragraph -- not a centered stack. Below the hero, a rounded-20px card container can house a tab switcher and a decorative orb carousel as a distinct inset panel. Sections alternate between full-width flat layouts (text + visual side by side, 50/50) and centered text blocks. Section vertical rhythm is generous -- ~80-120px between sections. No sidebar; everything is single-column or 2-column max.

## Agent Prompt Guide

**Quick color reference**
- text (primary): #000000 · text (secondary): #777169
- background (canvas): #fdfcfc · background (card): #f5f3f1 · border: #e5e5e5
- accent (decorative only): #0447ff, #ff4704 · primary action: #000000

**Example component prompts**

1. **Hero**: #fdfcfc background. Left column: headline in DM Sans weight 300, 48px, #000000, letter-spacing -0.96px, line-height 1.08. Below: black pill button (bg #000000, text #ffffff, radius 9999px, padding 0 16px, Inter 15px/500) beside a ghost text button (transparent, #000000, same size). Right column: body copy Inter 16px/400 #777169.
2. **Feature card**: bg #f5f3f1, radius 20px, no shadow, no border, padding 0 32px. Title Inter 16px/500 #000000. Body Inter 14px/400 #777169.
3. **Tab switcher**: container radius 20px, bg #f5f3f1. Active tab bg #ffffff, radius 18px, padding 8px 12px, inset shadow rgba(0,0,0,0.075) 0 0 0 0.5px. Inactive tabs transparent. Inter 14px/500 #000000.
4. **Navigation**: bg #fdfcfc, height ~36px, 1px bottom border #e5e5e5. Logo: Space Grotesk 700 14px #000000 letter-spacing 0.05em. Nav links Inter 14px/400 #000000, ghost style. Right side: ghost 'Log in' + black pill 'Sign up'.

## Similar Brands

- **Linear** -- monochrome pill-button system, black filled primary + ghost secondary, no color for interactive states.
- **Vercel** -- black-and-white achromatic UI, near-white warm canvas, color reserved for decorative/illustration contexts.
- **Notion** -- light-weight (300) display face for headlines against a neutral body face, warm off-white surfaces.
- **Perplexity** -- warm parchment-toned canvas with exclusively monochrome UI controls and a typography-first layout.

## Quick Start -- CSS Custom Properties

```css
:root {
  /* Colors */
  --color-parchment-white: #fdfcfc;
  --color-warm-sand: #f5f3f1;
  --color-ash-border: #e5e5e5;
  --color-midnight-ink: #000000;
  --color-driftwood: #777169;
  --color-fog: #a59f97;
  --color-silver-mist: #b1b0b0;
  --color-void-violet: #0447ff;
  --color-ember-orange: #ff4704;

  /* Fonts -- all on Google Fonts (see the <link> above) */
  --font-display: 'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-wordmark: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
  --font-body: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Type scale */
  --text-caption: 10px; --text-body: 16px; --text-subheading: 18px;
  --text-heading-sm: 20px; --text-heading: 32px; --text-heading-lg: 36px; --text-display: 48px;

  /* Weights */
  --font-weight-light: 300; --font-weight-regular: 400; --font-weight-medium: 500; --font-weight-bold: 700;

  /* Spacing (4px base) */
  --spacing-4: 4px; --spacing-8: 8px; --spacing-12: 12px; --spacing-16: 16px; --spacing-20: 20px;
  --spacing-24: 24px; --spacing-32: 32px; --spacing-40: 40px; --spacing-48: 48px; --spacing-64: 64px;
  --spacing-96: 96px; --spacing-160: 160px;

  /* Radius */
  --radius-inputs: 4px; --radius-tooltips: 8px; --radius-tags: 14px; --radius-badges: 18px;
  --radius-cards: 20px; --radius-cardlarge: 24px; --radius-full: 9999px;

  /* Shadows */
  --shadow-subtle: rgba(0,0,0,0.075) 0 0 0 0.5px inset;
  --shadow-control: rgba(0,0,0,0.06) 0 0 0 1px, rgba(0,0,0,0.04) 0 1px 2px 0, rgba(0,0,0,0.04) 0 2px 4px 0;
  --shadow-elevated: rgba(0,0,0,0.4) 0 0 1px 0, rgba(0,0,0,0.04) 0 1px 1px 0, rgba(0,0,0,0.04) 0 2px 4px 0;

  /* Surfaces */
  --surface-canvas: #fdfcfc;
  --surface-card: #f5f3f1;
  --surface-border: #e5e5e5;
  --surface-elevated: #ffffff;

  /* Layout */
  --page-max-width: 1200px;
}
```
