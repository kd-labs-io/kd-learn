# Design

Clean editorial minimalism, generous whitespace, soft rounded cards with subtle shadows, serif headings + sans body.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#FAF9F5` cream | Page background |
| `surface` | `#F0EEE6` ivory | Cards, panels |
| `border` | `#E3E0D5` | Dividers, card borders |
| `text` | `#141413` | Body text |
| `text-muted` | `#5E5D59` | Secondary text (AA on `bg`) |
| `text-subtle` | `#87867F` gray | Hints, placeholders, large text only |
| `accent` | `#D97757` terracotta | Highlights, decorative icons, progress fills (never behind text) |
| `accent-strong` | `#A8502F` | Primary button background, links, accent text |
| `on-accent` | `#FFFFFF` | Text on `accent-strong` |
| `success` | `#46704A` | Correct answers, saved |
| `warning` | `#8C6320` | Quota near limit, caution |
| `danger` | `#B53B33` | Errors, destructive actions |
| `info` | `#4A6F94` | Neutral notices |
| `focus-ring` | `#A8502F` | 2px ring, 2px offset |

All text colors except `text-subtle` pass WCAG AA (4.5:1) on both `bg` and `surface`. Status colors have a tinted background variant at ~12% opacity on `bg`.

## Typography

- Headings: **Source Serif 4** (fallback: Georgia, serif)
- Body and UI: **Inter** (fallback: system-ui, sans-serif)
- Code: **JetBrains Mono** (fallback: ui-monospace, monospace)
- All three support Vietnamese. Self-host the fonts (no CDN) so they work offline in Capacitor.

| Step | Size / line height | Use |
| --- | --- | --- |
| xs | 12 / 16 | Labels, captions |
| sm | 14 / 20 | Secondary UI |
| base | 16 / 26 | Body, lesson text |
| lg | 18 / 28 | Lead text |
| xl | 22 / 30 | H3 |
| 2xl | 28 / 36 | H2 |
| 3xl | 36 / 44 | H1 |

Lesson text max width: 68ch.

## Spacing

4px base: `4, 8, 12, 16, 24, 32, 48, 64`. Prefer 24+ between sections.

## Radius

`sm 6px` inputs and chips · `md 10px` buttons · `lg 16px` cards and dialogs · `full` pills and avatars.

## Shadow

Warm and soft, never harsh.

- `sm`: `0 1px 2px rgba(20,20,19,0.06)`
- `md`: `0 4px 12px rgba(20,20,19,0.08)`
- `lg`: `0 12px 32px rgba(20,20,19,0.10)` (dialogs, popovers)

## Themes

This file defines the default theme. The token names above are the contract for all themes, including user-made and imported ones: a theme may change values, not add or rename tokens. Roadmap and rules live in `plan/`.

## Dark mode

Deferred until after the core phases. All colors go through tokens so it can be added without touching components.
