---
version: alpha
name: Realtime examples
description: Shared visual system for the Cloudflare Realtime example apps. Matches the video room blueprint in calls-examples so the examples read as one family.
colors:
  primary: 'oklch(55.3% 0.195 38.402)'
  primary-hover: 'oklch(47% 0.157 37.304)'
  primary-soft: 'oklch(98% 0.016 73.684)'
  primary-on-dark: 'oklch(70.5% 0.213 47.604)'
  on-primary: '#ffffff'
  neutral: 'oklch(97% 0.001 106.424)'
  surface: '#ffffff'
  surface-muted: 'oklch(98.5% 0.001 106.423)'
  border: 'oklch(92.3% 0.003 48.717)'
  border-strong: 'oklch(86.9% 0.005 56.366)'
  border-input: 'oklch(55.3% 0.013 58.071)'
  text: 'oklch(21.6% 0.006 56.043)'
  text-secondary: 'oklch(37.4% 0.01 67.558)'
  text-muted: 'oklch(44.4% 0.011 73.639)'
  text-subtle: 'oklch(55.3% 0.013 58.071)'
  text-disabled: 'oklch(70.9% 0.01 56.259)'
  stage: 'oklch(21.6% 0.006 56.043)'
  stage-tile: 'oklch(26.8% 0.007 34.298)'
  stage-chip: 'oklch(14.7% 0.004 49.25)'
  on-stage: 'oklch(98.5% 0.001 106.423)'
  on-stage-muted: 'oklch(70.9% 0.01 56.259)'
  focus: 'oklch(58.8% 0.158 241.966)'
  success: 'oklch(50.8% 0.118 165.612)'
  warning: 'oklch(55.5% 0.163 48.998)'
  danger: 'oklch(50.5% 0.213 27.518)'
  danger-hover: 'oklch(44.4% 0.177 26.899)'
typography:
  headline-lg:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.025em
  headline-md:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.025em
  title-sm:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: ui-sans-serif, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  mono-sm:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  base: 16px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  panel-max-width: 72rem
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    typography: '{typography.label-md}'
    rounded: '{rounded.md}'
    height: 44px
    padding: 16px
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    typography: '{typography.label-md}'
    rounded: '{rounded.md}'
    height: 44px
    padding: 16px
  button-danger:
    backgroundColor: '{colors.danger}'
    textColor: '{colors.on-primary}'
    rounded: '{rounded.md}'
    height: 44px
  button-danger-hover:
    backgroundColor: '{colors.danger-hover}'
  button-quiet:
    backgroundColor: transparent
    textColor: '{colors.text-muted}'
    rounded: '{rounded.md}'
    height: 44px
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    typography: '{typography.body-md}'
    rounded: '{rounded.md}'
    height: 44px
    padding: 14px
  panel:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.lg}'
  stage:
    backgroundColor: '{colors.stage}'
    rounded: '{rounded.lg}'
    padding: 16px
  stage-tile:
    backgroundColor: '{colors.stage-tile}'
    textColor: '{colors.on-stage}'
    rounded: '{rounded.md}'
  tile-chip:
    backgroundColor: '{colors.stage-chip}'
    textColor: '{colors.on-primary}'
    typography: '{typography.label-sm}'
    rounded: '{rounded.sm}'
  status-bar:
    backgroundColor: '{colors.surface-muted}'
    textColor: '{colors.text-muted}'
    typography: '{typography.body-sm}'
    height: 48px
---

# Realtime examples design system

## Overview

The Realtime examples are small, complete applications that developers read as
much as they use. The interface should feel professional and approachable:
calm, well spaced, and clearly Cloudflare through a single orange accent, never
a wall of brand color. One white panel holds the whole task; dark media areas
sit inside it as insets rather than taking over the page.

Every value here is a Tailwind CSS v4 default (the `stone`, `orange`, `sky`,
`emerald`, `amber`, and `red` palettes, the default type and radius scales).
Write styles with Tailwind utilities; do not add custom theme colors or fonts.
The same system is used by the video room blueprint in `calls-examples`.

## Colors

The palette is stone neutrals with one accent.

- **Primary (orange-700):** the only accent. Use it for the single primary
  action on a screen, the brand icon tile (orange-700 on orange-50), and the
  assistant's name in the transcript. On dark stage surfaces use orange-500 for
  live indicators: the voice orb's rim, ticks, and center icon during a call,
  and the microphone level bars.
- **Neutral (stone-100):** page background. Panels are white with stone-200
  borders; the status bar and notes use stone-50.
- **Text:** stone-900 for primary text, stone-600 for secondary and helper
  text, stone-500 for subtle labels. Do not go lighter than stone-500 for text
  on white.
- **Stage:** stone-900 with stone-800 tiles and stone-950 at 80% opacity for
  chips over media. Light text on the stage is stone-50 with stone-400 for
  secondary lines.
- **Status tones:** emerald-700 (ok), amber-700 (warning), red-700 (error),
  applied to both the status marker and the message text. Destructive buttons
  are solid red-700.
- **Focus:** sky-600, a 2px outline with 3px offset on every focusable element.

## Typography

System fonts only: Tailwind's default `font-sans` stack for text and
`font-mono` for identifiers such as room IDs, agent names in the header, call
timers, and measurements.

- **Headlines:** `text-2xl`, `text-3xl` on larger screens, semibold, tight
  tracking. One per screen, stating the current state or task plainly ("Join
  room-3b43177f", "Matt is speaking").
- **Body and UI text:** `text-sm` (14px) with `leading-6` for paragraphs;
  inputs use `text-base` (16px) so phones do not zoom on focus.
- **Labels and captions:** `text-xs` (12px) is the floor for anything a person
  reads, including speaker labels, badges, chips, and footnotes. Do not use 10
  or 11px text.
- Sentence case everywhere. No uppercase tracked labels, no kicker lines above
  headings, and no italic display type.

## Layout

A single centered column, `max-w-6xl`, with `px-4` on phones and `px-6` from
the `sm` breakpoint. The header and main panel share one rounded outline:
`rounded-t-xl` header, `rounded-b-xl` main, 1px stone-200 borders.

Inside the panel, content areas use `p-3` on phones and `p-5` or `p-6` from
`sm`. Dark stages are inset with `p-3` to `p-4` of their own. Related controls
sit in one row with `gap-2`; separate groups are divided by a 1px border, not
by extra containers. Two-column layouts collapse to a single column below `lg`.

Touch targets are at least 44px tall (`min-h-11`), 48px for primary form
actions on the lobby.

## Elevation & Depth

Depth comes from tonal layers: stone-100 page, white panel, stone-50 status
bar, stone-900 stage, stone-800 tiles. Shadows are minimal and neutral:
`shadow-sm` on the main panel and `shadow-xs` on buttons and inputs. Never use
colored glows, zero-offset halos, or large soft shadows. The voice orb's rim
glow is the one exception; it is drawn on the stage canvas and stays there.

Avoid nesting bordered containers. A tile inside a stage inside the panel is
the deepest stack; transcript entries, notes, and tool rows are flat text with
spacing or a single divider.

## Shapes

- `rounded-xl` (12px): header, main panel, dark stage.
- `rounded-lg` (8px): buttons, inputs, tiles, the brand icon tile.
- `rounded-md` (6px): chips and labels over media.
- `rounded-full`: status markers, count badges, participant-count pills.

Corner radii step down as elements get smaller. Do not round small cards into
pills or mix sharp and rounded corners in one view.

## Components

- **Buttons:** 44px tall, `rounded-lg`, `text-sm font-medium`. Primary is solid
  orange-700 with white semibold text and a trailing arrow when it moves the
  person forward. Secondary is white with a stone-300 border. Danger is solid
  red-700. Quiet buttons have no border and gain a stone-100 background on
  hover. Disabled buttons fade to a pale tint of their own color (orange-50
  with orange-800 text, red-50 with red-800 text, lighter gray for neutral and
  quiet) rather than opacity, so the label stays legible on any background.
- **Inputs:** 44px tall, `rounded-lg`, stone-500 border darkening to stone-600
  on hover, `text-base`. Labels are `text-sm font-medium` above the field;
  helper and error text is `text-sm` below it, red-700 for errors.
- **Header:** brand icon tile (`size-9 rounded-lg bg-orange-50 text-orange-700`),
  "Realtime", a stone-300 slash, then a mono identifier. Utilities live on the
  right as quiet or secondary buttons.
- **Stage and tiles:** stone-900 inset with stone-800 tiles bordered in
  white/10. Each tile carries a bottom-left chip naming the participant and,
  for the voice agent, what they are doing ("Matt · speaking"). Timers and
  counts are mono chips or pills on the right.
- **Voice stage:** the tile's centerpiece is a dotted globe drawn on a canvas
  with a thin orange-500 rim and a ring of fine ticks outside it that open
  into an equalizer with the call audio. It is decorative: the controls stay
  in the row under the stage, and a sound-wave icon at its center turns
  orange-500 during a call. The globe rests on a still frame and only animates
  while a call is live. The canvas takes its colors from the palette through
  the custom properties in `styles.css` and renders a still frame under
  `prefers-reduced-motion`.
- **Status bar:** the panel's last row, stone-50 with a top border, a 2px
  colored marker, the word "Status", and one sentence. The marker pulses only
  while work is in flight. Errors replace the routine message and turn the bar
  red; they do not add a second bar.
- **Tabs:** text buttons with a 2px underline in orange-700 for the active tab
  and a count badge in stone-100 when useful.
- **Transcript:** speaker label in `text-xs font-medium` (stone-500 for the
  person, orange-700 for the assistant) above `text-sm leading-6` text. Tool
  calls are one row: icon, action, and a status word.

## Do's and Don'ts

- Do keep one primary action per view and reserve orange for it and the brand.
- Do say what happens next in plain words ("Enter your name, then allow camera
  and microphone access.").
- Do show one status message at a time, in the status bar.
- Don't use cream or beige backgrounds, gradients, glass effects, or glows
  outside the voice stage.
- Don't add kicker labels above headings or text below 12px.
- Don't animate layout properties; use transforms for level meters and rings,
  and respect `prefers-reduced-motion`.
- Don't place cards inside cards; use spacing and dividers instead.
