---
name: EveryTab
description: Local-first tab manager — one fixed structure, 36 editor-grade color schemes, crisp and instant.
colors:
  # ROLE TOKENS — the normative layer. Every scheme redefines these same ~14 roles;
  # components only ever reference roles, never raw values. Values below are the
  # Cream light remains the design-system reference map. Fresh profiles select
  # Ink with Scheme default, whose canonical presentation is light.
  bg: "#f5efe3"
  surface: "#fffdf6"
  surface-2: "#efe8d8"
  border: "#e2d8c0"
  ink: "#3d3629"
  ink-2: "#6b6350"
  ink-3: "#6f6756"
  accent: "#bc5f3c"
  accent-ink: "#0b0604"
  accent-strong: "#a44f2f"
  accent-strong-ink: "#944b2e"
  accent-soft: "#bc5f3c1f"
  ok: "#5f7d43"
  warn: "#9a6b12"
  danger: "#a83f2e"
  # FIXED BRAND TOKENS - public identity, never redefined by a scheme.
  brand-cream: "#f4f2ed"
  brand-edge: "#d8d4cc"
  brand-ink: "#26221c"
  brand-accent: "#1e4a49"
  brand-ember: "var(--brand-accent)" # historical compatibility alias
typography:
  display:
    fontFamily: "system-ui, 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "system-ui, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.03em"
  body:
    fontFamily: "system-ui, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.4
rounded:
  mini: "7px"
  mark: "10px"
  btn: "12px"
  row: "12px"
  card: "14px"
  search: "18px"
  pill: "99px"
components:
  button-default:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
    padding: "6px 13px"
  button-default-hover:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-strong-ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.btn}"
    padding: "6px 13px"
  nav-item:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.btn}"
    padding: "7px 10px"
  nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-strong-ink}"
  search-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.search}"
    padding: "14px 20px"
  chip:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-strong-ink}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  card-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
---

# Design System: EveryTab

## 1. Overview

**Creative North Star: "The Editor Theme"**

EveryTab is styled the way a great code editor is: the layout, keybindings, density, and
component anatomy are fixed and learnable once — and the *color scheme* is yours. The
color system is a strict two-axis architecture: `data-scheme` (36 palettes, from Cream and
Solarized to Laser, Nautilus, and Metropolis) × `data-mode` (light/dark). A separate
`data-interface-style` axis selects Soft, Crisp, or Terminal without changing color,
information architecture, or behavior. All three are applied on `<html>`, with one
optional atmosphere flag (`body.gradient` adds a soft gradient background and two blurred
accent orbs). Every scheme redefines the same ~14 role tokens; every component is written
once against those roles and never hard-codes a color. Like a syntax theme, multiple
accent hues are welcome — Laser pairs magenta with cyan, Godspeed orange with blue — but
every hue has a *role*, the way syntax tokens do.

The working feel is precise, fast, keyboard-first — Raycast/Linear energy on a warm-paper
default. Density is moderate: 13–14px UI text, 6–10px row padding, hairline borders doing
the structural work. What this system explicitly rejects (from PRODUCT.md): the
SaaS-dashboard cliché — hero-metric tiles and big numbers on the main page (stats live on
their own page); the kitchen-sink extension with mismatched UIs; anything that looks
opaque or ownerless. Personalization is a first-class feature — the scheme picker is a
product surface users are meant to enjoy, because this UI is their new-tab page and it
should feel like home.

**Key Characteristics:**
- One fixed structure and behavior, with Soft, Crisp, and Terminal presentations, 36 total-swap built-ins, and local custom schemes
- All color flows through role tokens; soft tints, focus rings, and shadows are *derived* via `color-mix`, never hand-picked per scheme
- One fixed public identity layer (supplied deep-teal stack mark) stays recognizable across every product scheme
- Crisp and instant: three motion roles only, 80/140/180ms, hover reveals actions, tabular numerals on every count
- Borders and surface tints carry depth; real shadows mean "this floats"
- System font stack only — zero webfont latency, native feel on every OS

## 2. Colors

A role-token system: ~14 roles per scheme, everything else derived. The frontmatter shows
Cream light as the stable reference map; the other 34 built-ins live in `extension/css/tokens.css`
and reinterpret the same roles. Fresh profiles select Ink with Scheme default,
whose canonical presentation is light.

The portfolio is Cream, Candy, Solarized, Laser, Godspeed, Cyberwave, Sunset Surf,
Nautilus, Easter, Ink, Ember, Phosphor, Tide, Meadow, Forest, Nord, Gruvbox,
Matcha, Dracula, Tokyo Night, One, Miami Nights, Darling, Red Samurai, `/dev/tty`,
Frozen Llama, Good Night, Oblivion, Chocolatier, Metropolis,
Hiney Beige, Taiga, Bushido, Dasher, and Jamón. Each declares a
canonical light or dark presentation. Appearance offers System, Scheme default, Light,
and Dark; Scheme default uses that canonical presentation without changing the stored
mode when the scheme changes. Optional open/hourly/daily rotation uses a no-repeat
shuffle bag, constrained to starred favorites when any exist.

### Primary
- **Accent** (`--accent`, Cream: #bc5f3c terracotta): the interactive voice — primary
  buttons, focus rings, selection rails, and active states. Always
  paired with `--accent-ink` for text on top of it.
- **Accent Strong** (`--accent-strong`, Cream: #a44f2f): the accent's counterpart, used as a
  **fill/decoration** hue — atmosphere orbs and other scheme-owned fills. **In many schemes this is a second
  hue entirely** (Laser: cyan against magenta; Godspeed: blue against orange). It is a role,
  not a shade, and it is free to stay vivid because it is not required to be readable as text.
- **Accent Strong Ink** (`--accent-strong-ink`, Cream: #944b2e): the *text* counterpart
  for accent links and interactive names on neutral materials. It never becomes text on
  its own accent tint because several schemes intentionally use a second hue.
- **Accent Text** (`--accent-text`): the primary authored accent corrected only toward
  the mode's contrast pole, 40% black in Light and 20% white in Dark. Use it when visible
  command copy must retain the scheme's primary accent hue on a neutral material while
  clearing 4.5:1. It is not text placed on an accent tint.
- **Accent Soft Ink** (`--accent-soft-ink`): readable text and icons on `--accent-soft`.
  It follows the primary ink in Light and receives one shared contrast-pole lift in Dark,
  so chips, active stars, and muted navigation remain readable without changing a palette's
  authored body copy or second accent.
- **Focus Accent** (`--focus-accent`): the authored accent moved 36% toward primary ink.
  This preserves the scheme hue while giving pale accents a visible ≥3:1 focus boundary.

### Secondary
- **Status trio** — **Ok** (#5f7d43), **Warn** (#9a6b12), **Danger** (#a83f2e): meaning
  colors. Vault pill states, status pills, duplicate warnings, destructive buttons. Each
  has a derived soft background (`--ok-bg` etc., ~13% tint) for pill/badge fills. A status
  hue used as a graphic or boundary clears 3:1; status text clears 4.5:1. Small text on a
  status tint uses `--ink`; small semantic dots retain their fill and use the shared
  `--status-marker-outline` to remain distinguishable from that tint.

### Neutral
- **Bg** (`--bg-solid`, #f5efe3): the page. Schemes may swap in `--bg-grad` when the
  gradient atmosphere is on.
- **Surface** (#fffdf6) / **Surface-2** (#efe8d8): cards, inputs, popovers / secondary
  fills, default buttons, unset pills. The sidebar sits on a derived mix of the two.
- **Border** (#e2d8c0): the structural workhorse — 1px hairlines on cards, inputs, rows,
  section dividers.
- **Ink ramp** — **Ink** (#3d3629) primary text; **Ink-2** (#6b6350) secondary text and
  nav items; **Ink-3** (#6f6756) metadata, counts, placeholders, empty states. Every ink
  role per scheme is tuned to clear WCAG AA (≥4.5:1) against its **worst-case** surface —
  the one it has the *least* contrast with (for dark text that is `surface-2`, not
  `surface`) — so metadata stays legible on row-hover and `.unset` badges too.

### Fixed brand identity

The public mark sits outside the scheme axis. Four canonical `:root` tokens never change:
`--brand-cream` (#f4f2ed porcelain; the token name is historical),
`--brand-edge` (#d8d4cc), `--brand-ink` (#26221c), and
`--brand-accent` (#1e4a49 deep teal). `--brand-ember` remains a historical compatibility
alias to `--brand-accent`. This is a deliberate exception to total-swap theming:
the interface is personal, while repeated brand recognition stays fixed.

The v0.8.105 V4b tab/wildcard construction failed human recognition and is retired.
v0.8.115 installs a reversible **tight Wordmark A** trial: separate Terracotta E/T
letters on a porcelain tile at 16/24/32/48/128 px, plus the matching filled ET on
product surfaces. Compact and display sizes are separately drawn. The source is
`campaign-assets/make-wordmark-a-icons.py`; the prior `make-icons.py` family remains
historical. Canonical restart boards, contrast values, and test scripts live in
`campaign-assets/restart-logo-studies.md` and [brainstorm-d2-logo.md](archive/2026-09-10-architecture-cleanup/brainstorm-d2-logo.md) v15. The historical
toolbar context shows ET reading as a file-type/acronym badge and losing its T under
Chrome's count badge. The v0.8.119 letter-free study fixes Terracotta and compares
Stack, Keeper, and Convergence on a solid field. The v0.8.121 Pocket Stack pass was
rejected after its angled layers read as a pile of rocks at 16 px. The v0.8.122
source-faithful correction locks the original body/check and tests only straight
cards, sheets, and indexed tabs; none beats the source control. v0.8.125 completes
the responsive study: the source stays unchanged as favicon/display mark and the
recommended large lockup adds only two short offset rules beneath the `Tab` suffix
(**Stacked underline**). Stacked corners and selected-tab framing are rejected as
diagrammatic/UI-like. v0.8.128 superseded those studies with MH's supplied teal
stack/keeper mark, and v0.8.130 applied its micro-adjusted source. D2d then compared
three revisions and a final pointed-versus-flat pair in native Chrome contexts.
**v0.8.204 settles the pointed keeper:** `#1E4A49`, `#286766`, `#378A89`,
`#47ADAA`, and a `#FEFEFE` check on the supplied 1024 square canvas. The mark is
not recolored by product schemes. Canonical source and QA live in
`campaign-assets/everytab-final-source-teal.svg` and
`campaign-assets/everytab-final-icon-qa.svg`.

### Named Rules
**The Scheme Contract Rule.** Components never hard-code a color value — only the ~13 role
tokens. Tints, readable tint ink, focus boundaries, rings, and glows are derived with
`color-mix` from roles (`--accent-soft` = accent 12%, `--focus-accent` = accent 64% plus
ink 36%, `--focus-ring` = focus accent 30%, `--nav-hover` = ink 7%). A new scheme is ~10
lines; if a component needs an 11th color decision, the component is wrong. Fixed
`--brand-*` tokens are reserved for the EveryTab identity and are never redefined per scheme.

**The Syntax Token Rule.** Multiple hues are welcome — this is an editor theme, not a
monochrome brand system — but every hue must hold a role. Accent acts, accent-strong
responds, ok/warn/danger mean. No hue is ever decoration-only in structure.

**The AA Everywhere Rule.** Every scheme × mode combination must hold WCAG AA. `--ink-3`
metadata is the weak point — verify it against `--bg-solid`, `--surface`, and `--surface-2`
in every new scheme, don't assume. Status graphics/boundaries clear 3:1 and status text
clears 4.5:1. `campaign-assets/check-d3-contrast.mjs` remains the established shipped
portfolio gate. The unlinked P11 Scheme Lab and
`campaign-assets/run-p11-scheme-qa.mjs --strict` extend that contract to exact
component, status, material, and Workbench states. That expanded gate must be green and
its 62 wide/narrow maps manually reviewed before public screenshots; a red expanded
ledger is recorded work to repair, never permission to weaken a threshold. v0.8.302
closes the automated gate at 2,691/2,691 pairings without per-palette exceptions; the
v0.8.303 source-bound contact-sheet pass records all 46 maps at 1280px and 400px plus
four 320px pressure cases as green. Any fingerprinted visual-input change makes that
durable approval stale. Installed-surface sampling remains part of the later release
sweep, while user-authored scheme persistence is now unblocked.

**The Custom Scheme Boundary.** v0.8.304 exposes the Scheme Lab compiler through
Appearance without widening the visual system. Guided authoring owns exactly seven
source colors per Light/Dark mode; Advanced owns the existing production color
roles and gradient geometry. It never accepts CSS, fonts, images, layout, motion,
shape, or brand-token overrides. A record enters **Yours** only after both modes
pass the same strict component ledger as built-ins. One failing draft may persist
locally for recovery but is not portable or usable. Saved schemes are independent
UUID records; their Settings identity is `custom:<uuid>`. Runtime paint accepts
only the 15 allowlisted scheme properties after a structure and validation-seal
check. Missing active records resolve to Cream, never to partially trusted color
data. Share files contain scheme data only and import as a fresh local copy.

**The Scheme Editor Boundary.** v0.8.305 keeps scheme authoring on a dedicated
page, while Appearance remains the compact library and entry point. Editor chrome
uses the currently applied EveryTab theme; only the nested preview receives draft
tokens. Desktop uses three independent panes for colors, a complete component
atlas, and validation. Narrow windows preserve the same order in one column. A
built-in source opens as its exact Advanced role map and can only save as a new
custom record. Choosing Guided requires explicit confirmation because it
re-derives roles. Each source supports a native picker plus an editable hex field.
Temporary use highlighting distinguishes direct roles with a solid outline from
derived roles with a dashed outline, clears after three seconds, and never changes
the saved draft.

**The Candidate Scheme Boundary.** v0.8.306 adds an editor-only source group for
palette studies. A candidate can load, validate, preview, and save as a normal
custom copy, but it never enters Settings, rotation, cold paint, portable built-in
identity, or public portfolio counts until explicitly promoted into the canonical
built-in files. The first candidate set contains fourteen keyboard-inspired studies.
It is intentionally interpretive rather than a claim of official reproduction.
Catppuccin and Rosé Pine are retired from the visible pre-launch portfolio because
they overlap Dracula; compatibility aliases resolve old beta selections to Dracula.
The canonical library is now 21 built-ins / 42 mode maps. Sunset Surf's v0.8.306
roles are the user-supplied orange, teal, cream, and aubergine maps.

v0.8.307 promotes Chocolatier, Perestroika, Metropolis, Hiney Beige, Taiga,
Bushido, Dasher, and Jamón into the canonical library. Chocolatier is Dark by
default. Seven sources remain candidates for another installed comparison:
Miami Nights, Red Samurai, `/dev/tty`, Frozen Llama, Darling, Good Night, and
Oblivion. The canonical library is now 29 built-ins / 58 mode maps; all 3,393
exact production pairings pass and all 25 source-bound contact sheets are
current, visually reviewed, and overflow-free. Inside the editor atlas only,
window caps scroll normally rather than applying production page stickiness.

v0.8.308 promotes Miami Nights and Darling, bringing the canonical library to
31 built-ins / 62 mode maps. Visible names no longer carry a `GMK` prefix. The
five remaining directions each expose two clearly named editor variants: Red
Samurai compares a crimson field with a black frame; `/dev/tty` compares white
and silver; Frozen Llama compares aqua dominance with a stronger blue edge;
Good Night compares pastel keys with a lavender frame; and Oblivion compares
soft grey with blue grey. All use the supplied photographs as the hierarchy
reference while the Scheme Contract controls exact readable role values. The
expanded ledger passes 3,627/3,627 exact production pairings, and all 27 current
wide, compact, and pressure sheets are source-bound and overflow-free.

v0.8.309 promotes Red Samurai's crimson-field composition, `/dev/tty` White,
and Frozen Llama Aqua. The canonical library is now 34 built-ins / 68 mode maps;
all 3,978 production pairings pass and 29 source-bound sheets are reviewed with
zero overflow. Good Night and Oblivion remain editor-only and now expose four
materially different studies each. Good Night keeps an off-white key field,
pastel teal, yellow, blue, and purple, with a cleaner yellow interaction role.
Oblivion removes the rejected orange completely and explores blue, green,
violet, and slate legends over cool light-grey keyboard materials.

v0.8.310 promotes Good Night **Pastel keys** and Oblivion **Frost + blue**, so
the editor-only candidate shelf is empty. The canonical library is now 36
built-ins / 72 mode maps; all 4,212 exact production pairings pass and all 31
source-bound sheets are reviewed with zero overflow. Scheme names stay on one
ellipsized selector line beside a fixed star lane; the complete name remains in
the tooltip, and custom names retain the existing 64-character data boundary.

v0.8.413 retires Perestroika because its direction is too close to Jamón. Old
stored Perestroika selections remain compatible and resolve to Jamón before the
first paint. The current library is 35 built-ins / 70 mode maps; all 4,095
exact production pairings pass and the 29 source-bound capture routes cover the
current portfolio.

v0.8.417 promotes the accepted Crimson Peach direction as **Aladdin**, defaults
it to Light, and closes the temporary candidate shelf. The current library is
36 built-ins / 72 mode maps; all 4,212 exact production pairings pass and the
31 source-bound capture routes cover the current portfolio.

## 3. Typography

**Display Font:** system-ui ("Segoe UI" fallback) at weight 800, letter-spacing -0.03em
**Body Font:** system-ui — 14px/1.5
**Mono Font:** ui-monospace ("SF Mono", Menlo) — exports, code-ish metadata

**Character:** One family, two personalities: heavy tight display headings give the bold
form its voice; regular-weight body stays quiet underneath. No webfonts — instant render
and OS-native feel are part of "speed is a feature."

### Hierarchy
- **Display / h1** (800, 24px, -0.03em): page titles. One per page, in the sticky hero.
- **Title / h2** (800, 16px, -0.03em): section headings ("Inbox", "Sessions"); on the
  Overview page they're also the collapse controls.
- **Label / h3** (700, 11–12px, +0.06–0.08em, uppercase): sidebar group labels and
  sub-section headers. The *only* place uppercase tracking is permitted.
- **Body** (400, 13.5–14px, 1.5): rows, descriptions, list items.
- **Meta** (400, 11–12.5px, `--ink-3`): hosts, counts, timestamps, chip text.

### Named Rules
**The Tabular Count Rule.** Every number that can change — sidebar counts, stats line,
item meta — sets `font-variant-numeric: tabular-nums`. Counts must never make the layout
breathe.

**The Native Type Rule.** V1 uses only the system sans and native mono stacks. The
semantic section role is 16px/800/-0.03em; compact hosts may retain documented
host-specific sizes. No remote font, bundled display face, or user font picker enters
v1 without post-beta evidence and a new cross-platform metric audit.

## 4. Elevation

Borders first, shadows for floating. Surfaces at rest are flat: 1px `--border` hairlines
and surface-tint steps (`bg → surface → surface-2`) carry all structural depth, plus one
whisper shadow on cards (`--shadow-1`, derived from ink at 8%). A visible shadow is a
*statement*: this element has left the page plane. Only overlays earn one — the theme
popover, tag menus, toasts (`0 14px 38px`), and the onboarding dialog (`0 30px 90px`,
over an ink-tinted backdrop with 4px blur). The optional gradient atmosphere (`body.gradient`)
adds two blurred accent orbs behind everything at `z-index: -1` — atmosphere, never elevation.

### Shadow Vocabulary
- **Whisper** (`--shadow-1`: `0 1px 3px color-mix(in srgb, var(--ink) 8%, transparent)`):
  cards, search input at rest. Derived from ink so it deepens naturally in dark modes.
- **Float** (`0 10px 28px rgba(0,0,0,.22)` / `0 14px 38px rgba(0,0,0,.28)`): popovers,
  dropdown menus, toasts. Anything that overlaps other content.
- **Modal** (`0 30px 90px rgba(0,0,0,.4)`): the onboarding card, full-attention overlays.
- **Button glow** (`--btn-glow`: `0 4px 14px` accent at 30%): primary buttons only — an
  accent-colored signature, not a gray shadow.

### Named Rules
**The Float Rule.** If it doesn't overlap other content, it doesn't get a shadow beyond
the whisper. Depth is information: shadow = floating.

## 5. Components

Character line for everything: **immediate input, quiet visual continuity.**

**The motion vocabulary is closed (D4-4, v0.8.190; purposeful-interaction
amendment v0.8.207, installed-feedback repair v0.8.209, and pending-work
refinement v0.8.286).** Three interaction roles ship:

| Role | Duration | Properties | Use |
|---|---:|---|---|
| Immediate feedback | `--motion-feedback` 80ms | colour, background, opacity, filter | hover, press, selected, focus ring |
| Component reveal | `--motion-reveal` 140ms | opacity + a 2-4px transform | menu, tooltip, anchored panel, disclosure glyph |
| State continuity | `--motion-continuity` 180ms | opacity + a 4-6px transform | toast, keeper dock, overlay entrance |

All three use `--ease-out: cubic-bezier(.2,.8,.2,1)`. Interactive transitions
finish within 180ms. A destination-only locator may compose the continuity
token up to three times when its state change has already completed and the
extra time makes the destination easier to find. Shared Loading feedback stages
before work, waits 180ms to avoid a fast-operation flash, then uses the 80ms
opacity role once. It stays solid and still; there is no ambient pending loop.

**Motion follows purpose.** State, focus, routing, and clickability always
change before a cue finishes. Workflow palettes and a manual left-pane resize
may animate for pointer or keyboard activation because the motion explains the
same spatial relationship. Pointer-only press and selection cues remain
pointer-only. Keyboard label/session jumps stay uncued because focus already
identifies the destination.

**Rejected, and enforced by `test/smoke.mjs`:** `transition: all`; animating a layout
property (`grid-template-rows`, width, height, margin, padding, offsets) for routine
rendering; ambient or looping motion on a daily surface; decorative page entrance;
staggered list reveal; motion that delays focus or clickability; and programmatic
smooth scrolling, because a JS `behavior: "smooth"` argument beats the global
reduced-motion CSS rule and so escapes the user's preference.

The user's manual 204px ↔ 60px Dashboard left-pane toggle publishes its final
layout once. A transient `nav-morphing` state animates only a flat sidebar
material edge, the content pane's translation, and the native-size final
sidebar's opacity over the reveal/continuity tokens. Navigation icons and text
are never captured or scaled, and the grid track is not recalculated on each
animation frame. Boot, viewport-driven changes, settings reconciliation,
routing, and list rendering remain instant.

The September 12–13 user-directed delight passes add bounded exceptions to the
former instant-only presentation policy:

- Pending Dashboard count slots show a decorative digit reel, with no ellipsis.
  The 0–9 strip cycles once per five continuity tokens while its source is pending;
  hidden pages pause it and reduced motion uses a neutral bar. These decorative
  digits never enter accessible count text. The real value updates synchronously
  and enters with a 180ms roll/fade from the current reel offset. No minimum wait
  is imposed, and routine count updates do not replay the cue. Selected counts
  inherit selected text ink. The Open heading has two compact clipped numeric
  slots; its words and parentheses stay on their normal baseline.
- The first visible Open-window render commits the complete list before motion
  begins. One list-level clip-path animation reveals the final layout from top to
  bottom with the balanced `.45,0,.55,1` spatial curve. Search's compact-shell
  `.32,0,.2,1` curve front-loads this much taller travel, so it is not reused
  here. The reveal travels only through the visible viewport; releasing the
  already off-screen remainder cannot change the current picture. Duration is
  three to six continuity tokens, chosen from visible pixel travel, so a tall
  first window cannot sweep past the whole viewport near-instantly. The animation
  has one continuous interpolation, with no per-card effects, transforms or
  internal easing stops. The section separator stays hidden and geometrically
  fixed until the reveal settles. Rows retain native text geometry. Input settles
  the sequence immediately. Data enrichment and viewport changes update the
  running effect's keyframes at its current eased progress, preserving the
  visible edge, curve and original deadline without a restart. Ordinary
  live-data refreshes do not replay a settled entrance. Activity uses its 140ms
  reveal.
- Manual navigation and card folds may animate their measured block size over
  the continuity token. They start from current visual geometry, remain
  interruptible, and keep hidden content out of keyboard/accessibility reach.
  Bulk/routing/initial reconciliation stays instant.
- Active Dashboard and Minimal Search use a pointer-transparent, theme-derived
  backdrop. Search remains in its original DOM with unchanged dismissal, focus,
  and click behavior. The tint is visual emphasis, not a modal focus trap.
  The absolute Dashboard results shell may grow over 180ms while retaining its
  rounded contour and opaque material. Minimal measures both axes for the same
  brief expansion. Result arrival retargets the original deadline; neither
  transition owns query state.
- Focus commits its final band height once, then reveals the complete material
  while the following Dashboard content translates to its new position. No
  inherited height variable animates through the page on each frame.
- In-page notices rise/fade on arrival and fade on departure. Browser-owned
  system notification appearance cannot be customized by EveryTab.
- Tooltips use a short initial delay and immediate adjacent discovery; keyboard
  discovery is immediate and touch does not trigger hover hints.
- Gradient-enabled Minimal moves its fully visible existing atmosphere once over
  4600ms, from viewport-relative offsets to the unchanged resting positions.
  This background-only exception neither loops nor moves the clock/content.
  An initially hidden tab waits for its first visible frame. Hiding after movement
  starts cancels it without replay; reduced motion skips it. Stronger glows live
  at the lower edges, behind a fixed soft mask that keeps the clock clear for the
  whole path, not just at rest.

Dashboard's appearance controls and Minimal's Focus control belong to the initial
shell. Later settings/status reads update their state without replacing a focused
button. Minimal keeps its Focus behavior module optional; an early click is
retained until that owner can resolve the correct action. MORE follows SAVED with
the same section spacing as SAVED follows NOW, rather than consuming spare height.
Dashboard warms empty Search examples after its first paint from the compact
primary model. Domain/label examples and the Recent shelf publish together; late
label recency or full autocomplete data cannot append another row to the opening.
Typing stays available during a genuinely cold primary read.

Reduced motion resolves all these cues immediately. No new whole-page loading
screen, forced wait, perpetual background drift, or animation library is introduced. The general prohibitions above remain for unrelated
surfaces; these requested exceptions are scoped to their owners.

Approved continuity examples: Label, Snooze, and Organize use one 140ms
top-layer anchored palette, so no list row moves and nested menus cannot fall
behind later rows. While focus is in it, the source row/card retains a
non-selection context state. The three workflows share one header, type scale,
spacing, field, option, help, close, and primary-action system. A pointer
label/session jump uses a three-token (540ms) complete inset Ring and Wash after
the instant anchor, with a 4px compositor settle and brief title emphasis; the
keeper dock uses a 180ms opacity plus 6px entrance only
when pointer selection crosses zero; and the manual left navigation toggle
moves its flat material edge and translates content over 180ms while the final
navigation crossfades at native size. Pointer button presses move 1px over 80ms.

Wide Dashboard rows show named actions by default. The `uiActionLabels`
preference may choose icons-only for a cleaner wide row. Compact side-panel
lists and Dashboard containers at or below 720px always use icons. Mutually
exclusive state actions such as Suspend/Wake reserve one stable slot.

### Buttons
- **Shape:** `--shape-control`, 12px in Soft, 5px in Crisp, and square in Terminal, with a 1px border
- **Default:** `--surface-2` fill, `--ink` text, `--border` border (6px 13px padding)
- **Hover:** shifts to the accent voice — `--accent-soft` fill, `--accent-soft-ink` text
- **Primary:** `--accent` fill, `--accent-ink` text, accent-colored glow (`--btn-glow`);
  hover brightens 8%
- **Danger:** default anatomy with `--danger` text; hover fills `--danger-bg`
- **Mini / Mini2:** compact inline variants (11–12px text); mini2 is borderless-transparent
  until hover

### Chips
- **Meaning boundary:** reserve the full-round pill for a persistent noun or
  state: an applied user label, ambient status, or Vault state. A command,
  result outcome, filter example, or navigation action is not a chip.
- **Style:** full-round pills (99px), `--accent-soft` fill, `--accent-soft-ink` text, 11px
- **Status pills:** same anatomy in meaning colors — ok/warn fills from the derived
  `-bg` tints; "unset" falls back to `--surface-2` + `--ink-3`
- **Vault pill (signature):** sidebar-foot sync status — 6px `currentColor` dot + label in
  a pill; ok/warn/unset states. The trust contract, ambient and always visible.

**The Interface Style Contract.** `uiInterfaceStyle` owns structural shape,
typography, resting elevation, and selection-control grammar through shared
tokens and one final presentation stylesheet. Soft uses mini/nav/focus/control/
search/keeper/panel/card radii of 7/8/9/12/18/13/14/14px with round selection
controls. Crisp uses 3/3/2/5/4/7/9/10px with square selection controls. Terminal
uses the native monospace stack, square structural roles, no resting shadow or
glow, and `[ ]`, `[x]`, and `[-]` selection controls. Search, fields, controls,
menus, popovers, panels, cards, Settings, Minimal, popup, side panel, and Scheme
Editor all consume the same contract. Connected rows, selection bands, and
internal seams remain square in every style. Label and status capsules, status
dots, swatches, slider thumbs, and favicon crops retain their semantic form.

### Cards / Containers
- **Interface style:** `--shape-card`, 14px in Soft, 10px in Crisp, and square in Terminal
- **Background:** `--surface` on `--bg-solid`, 1px `--border`, whisper shadow
- **Internal padding:** 10px 12px; 8px stack gap between cards
- **Selected:** accent border + 5% accent-tinted fill — selection is a color shift, not a lift

### Inputs / Fields
- **Style:** `--surface` fill, 1px `--border`, `--shape-control`, 13px text (6px 9px padding)
- **Focus:** border turns `--accent` + 3px `--focus-ring` halo (derived, 26% accent)
- **Hero search (signature):** 16px text in a `--shape-search` field, 18px in Soft,
  4px in Crisp, and square in Terminal, max 680px
  on utility pages and 1080px across the daily Home/collection canvas, top-center and
  sticky; focus ring grows to 4px. The most important element on the page.
- **Search completion order:** a matching `in:`, `label:`, `session:`, or `view:`
  completion paints immediately but never suppresses ordinary matches. Completion
  rows lead, then one quiet hairline begins the Results group; arrows and Enter
  traverse both labelled option groups as one list. The visual Search surface is
  neutral: only its inner actionable-row element is a listbox, and filter suggestions,
  empty states, and recovery buttons sit outside it.
- **Search visual vocabulary:** the dropdown is one continuous command ledger.
  Rows have square inner corners (`--shape-row`), a neutral hover band, and one
  complete `--accent-soft` selection band. Content reads title, bounded
  source/context, then a right-aligned plain-text outcome. Switch, Open, Launch,
  Restore, Search web, and Open site are never pills or nested-looking controls.
- **Search filter syntax:** focused-empty filter examples keep 28px targets but
  are borderless and transparent at rest. Their quiet mono prefix (`in:`,
  `label:`, `session:`, `view:`) and normal-weight value form one wrapping
  syntax strip with an 8px gap. Only hover/focus paints a local background.
  The applied removable scope is the sole persistent Search token and uses the
  compact 7px structural radius, not the full pill silhouette.
- **Search compact contract:** an active scope may use at most 56% or 240px of
  the field. Its label ellipsizes with full title/accessibility text while its
  remove action remains fixed and the input keeps a usable lane. Descriptive
  result metadata gets a bounded ellipsis lane; Session window/tab counts never
  truncate. Empty/retry actions and ghost chips use shared 28px targets.
- **Search focus/status:** the open Dashboard keeps a 3px inset focus cue around
  the input row, not the complete dropdown. One separate atomic polite status
  announces result counts and empty outcomes; the listbox itself is not live.
- **Dashboard Search terminal boundary:** every visible Dashboard dropdown ends
  in one quiet 30px footer above a hairline and tighter contact shadow. With
  History available it shows the result or recent-tab count plus compact keyboard
  guidance; without History, the existing permission invitation occupies that
  same row. This footer is visual help only, while the separate polite status
  remains the assistive-technology source of truth. Do not solve this boundary by
  recoloring Search, dimming the page, rounding result rows, or adding another card.
- **Minimal Search footer:** Dashboard and Settings are a bottom safe-area
  footer. Minimal Search measures the real field-to-footer clearance after
  localized layout and on resize, then caps only that result list so neither
  browser zoom nor a short window can cover navigation.
- **Session restore result:** from two typed characters, up to three matching named
  Sessions lead ordinary tab matches in exact, word-start, then partial order. The
  row says Restore, preserves the full name through title/accessibility text, and
  shows window and tab counts. A `session:` scope keeps that Restore row first and
  excludes automatic Snapshots. Activation rereads the Session by id before using
  the existing all-window restore behavior; a stale result reports that the Session
  no longer exists.
- **`et` filter completion:** Chrome's omnibox has no chip or inert-divider state.
  Up to four real `in:`, `label:`, `session:`, or `view:` values therefore lead the
  ten-row suggestion budget, with ordinary Switch/Open results filling the rest.
  Completion content stays readable so typing can continue; accepting a Session
  value resolves its first-class Restore result.
- **No-result handoff:** after a successful unscoped local miss of at least two
  characters, render one ordinary result row labelled Search web with the query
  and “Default search engine”; conservative HTTP(S)/host input uses Open site and
  “Website”. The row shares pointer, arrows, Enter, selection, and focus anatomy
  with local results. One-character, filter, and local-failure states never show
  it. A provider failure keeps the query visible and replaces the action with a
  polite inline Try again state.
- **Tag input:** chips grow inline inside the field; focus ring on the whole box;
  suggestion menu floats below with the Float shadow

### Navigation
- **Sidebar:** 248px, sticky full-height, on a derived side tint; 13.5px medium rows,
  12px radius
- **States:** rest `--ink-2` → hover `--nav-hover` (ink 7%) + `--ink` → active
  `--accent-soft` + `--accent-soft-ink` semibold. Tabular counts right-aligned in `--ink-3`
- **Groups:** disclosure twist rotates 90° (`--dur`); subnav animates open via
  `grid-template-rows: 0fr → 1fr` — the house collapse move, used for sections, smart
  views, and window blocks alike

### Brand mark
- **Public color mark:** final pointed teal stack/keeper mark, exact approved geometry and fills
- **Responsive reduction:** supplied square master rendered to transparent 16/24/32/48/128 PNGs
- **Runtime asset:** v0.8.204 final pointed source; no letter tile or scheme recoloring
- **Production source:** `campaign-assets/everytab-final-source-teal.svg` and
  `campaign-assets/make-final-source-icons.mjs`

### Tab Row (signature)
Every full Dashboard collection uses the compact ledger row with five stable lanes:
selection, a 24px favicon tile, stacked primary/secondary copy, labels, and actions.
The title is one-line ellipsized; host and optional context sit together beneath it in
`--ink-3`. Actions sit at `opacity: 0` until row hover or focus, without changing the
grid. Hover uses a clear accent tint. Selection keeps a stronger tint, adds a 4px accent
rail, and fills the checkbox with a bold keeper-style check. Drag uses 45% opacity plus
an accent insertion line. Every top-level live window or saved bundle owns one
softly bounded ledger with a quiet header. Inbox and Archive single tabs use a
one-row ledger. Sessions and Snapshots preserve the session as the outer object
and place each saved window in a neutral sub-ledger rather than flattening it.
Dark mode strengthens its token-derived border and dividers and lifts header/row
surfaces through the Workbench component roles: row is 4% toward ink from
`--surface-2`, window header is 14%, and hover mixes 14% accent over the row.
Keyboard roving follows those same lanes: ArrowRight moves from checkbox to
the primary title/URL, then labels, then actions. Enter on the focused title
uses the row's normal open, switch, or restore behavior. ArrowUp/ArrowDown
carry the active lane into the next row when that lane exists, with the normal
checkbox entry point as a quiet fallback. A focused title is treated as a link,
not a capsule control: use a flat accent wash and crisp accent underline rather
than the generic rounded focus treatment, keeping the text lane visually calm
while still making keyboard focus unmistakable.
Supporting copy uses the corresponding dark readable role, 65% toward `--ink`
from `--ink-2`. The component-level contrast audit covers every dark built-in;
light mode keeps the original quieter separation. The compact side panel keeps
its denser anatomy. The retired Space, Divider, and Accent-cap settings remain
accepted in stored data only and have no rendering effect.

Window/group headers and empty states share `--workbench-header`. Hover uses
`--workbench-hover`; accents are reserved for active, selected, and kept-copy
feedback.

**Folded summaries:** a folded card constructs no body rows and displays at most
eight favicon identities. The cap is fixed for comprehension and DOM bounds, not
expanded from measured free space. At the established compact pressure state the
same summary becomes a tabular text count so the title, fold control, and complete
action lane remain reachable. This fallback is deterministic CSS, never a resize
observer or render-time geometry branch.

**Whole-window Close:** every live Open-window header ends with the same danger
action on Dashboard and side panel. Its first activation temporarily gives the
header to one P4 decision rather than opening a modal or squeezing permanent
warning copy into the action lane. The decision names the exact tab total and
any pinned, current-EveryTab, or last-Chrome-window consequence; the primary says
`Close N tabs` beside Cancel. At compact widths, copy takes the first line and
the two choices align below it. Escape, blur, Cancel, and the four-second timeout
disarm. Other header content/actions are hidden only while armed, then return
unchanged. The worker's exact stale check and best-effort recovery boundary are
behavioral requirements, not presentation variants.

**Focus access expiry:** the two-minute heads-up is a native system notification,
not an EveryTab modal, toast, or injected website surface. It uses one calm title
and points to EveryTab because the operating system may collapse its standard
**Add 5 minutes** action. When native macOS UI omits that custom action, the
clearly worded notification body performs the same extension. Trusted EveryTab surfaces carry the dependable control:
one flat status band with domain, tabular exact countdown, and plain-text
**Stop** and **Add 5 min** actions. Stop is neutral and visually secondary; Add
retains the accent emphasis. They share one trailing action lane and wrap only
when compact width requires it. This is a status row, not a chip, card, alert
color, or floating panel. Add may be repeated; the clock itself is never an
`aria-live` region.
At expiry, only a deferred current page receives the second calm notification.
Notification delivery remains advisory: the interaction contract keeps the current
page live, guards background matches, and waits for navigation or deliberate
reactivation. Dark accent bands use `--accent-ink`; no countdown drama or repeated
per-tab notification is added.

F39 refines F38's four utility roles in the fluid workspace. Search is one
left-aligned 760px sticky row sharing the collection's
left edge; suggestions and the optional History grant retain F37's connected
absolute overlay and never enter measured hero geometry. Focus is the first
navigation action with no count, and the same button reads Start Focus or End
Focus and performs that action; active Focus alone retains the sticky status
strip. Needs you has no fallback row: at 1600px and wider it occupies genuine
free space to Search's right, aligns to the 18-28px utility edge, and remains
fixed there while the document scrolls; below that it is absent. Collections
have no 1080px cap. One page-owned 20px shelf matches Search's upper breathing
room and covers the exact sticky offset so passing
rows cannot appear between Search and a window cap. The filled-star Starred
launcher begins on the sticky-window axis as a flush-right edge tab; at
1280px and wider its shadow-free 280px flat ledger pushes rows inward with 20px
separation, while narrower screens use an overlay fallback. The old and new
workspace states animate for 180ms through compositor snapshots, never through
per-frame layout. Its rows use collection seams plus equal Rename/Unstar
controls. The left-pane manual morph reads the same 180ms continuity and
ease-out tokens, including its pane-edge, content-translation, and crossfade
layers. A direct Starred reorder commits the saved order, rendered order, and
stable-id focus first, then displaced rows alone settle from their previous
positions for the same 180ms. Rapid reversals serialize, external writes still
reconcile, and reduced-motion mode is instant. F40 completes this stack with the
chosen **Canvas line**. Section title
and one-line explanation share a 34px identity row plus 10px breathing room
directly on the page material. That line is sticky and opaque without gaining
a visible container. Sessions and Labels add one compact sticky local strip
beneath it: filter/sort on the first line and visible label shortcuts on the
second, with no redundant Jump to caption. Ten shortcuts are offered first;
`+N more` expands them into a bounded wrapping area and becomes Show less.
The active section publishes the measured identity
and local-strip heights, and collection caps, Starred, card jumps, and keyboard
scroll margins all read the same lower edge. Starred therefore aligns to the
first collection header, not to the section title. The Canvas line owns the
entire 44px painted height; scrolling content has no upper inset. Resting,
sticky, and occlusion boundaries are therefore the same physical edge. Heights
retain fractional CSS pixels so zoom cannot open a subpixel seam. The
index reserves reduced Starred's 58px edge plus 8px breathing room. Sessions'
Save open windows action lives at the right side of the identity line. Canonical detail and the
rejected alternatives are in [f40-stable-section-header-options.md](archive/2026-09-10-architecture-cleanup/f40-stable-section-header-options.md); F39 owns the edge geometry;
F38 owns the fluid axis and transition, and F37 owns Search-overlay correctness.

P11-25 defines the information contract inside that fixed **Needs you** line.
It is a bounded queue of at most three direct entries, never a count launcher or
another chip family. Unresolved actionables precede recent automatic actions;
their words carry the meaning without a parallel coloured-dot legend, while
automatic entries show age and a separate exact Undo. At 1600-1919px the oldest
automatic entry yields before any actionable. Resolved work disappears and **All
activity** names the durable-history route. Periodic automatic snapshots never
appear in either surface.

These four rules are normative and shipped in v0.8.216:

- **Overflow disclosure is a row.** “N more” and “Show fewer” render as
  `button.disclosure-row`, full width, activated anywhere along the row, taking
  row hover and focus rather than a chip highlight, and publishing
  `aria-expanded` plus `aria-controls` when they reveal one named container.
- **A connected ledger cell owns its whole fill.** Starred and What’s happening
  cells paint hover and focus across the complete square cell. A nested button
  must not introduce an inner rounded patch, which means explicitly resetting
  the generic `button` radius and `button:hover` wash, since both outrank a
  bare class. Keyboard focus is an inset accent outline, not the shared offset
  ring. A deliberate secondary affordance such as Unstar keeps its own smaller
  hover.
- **Consecutive selections form one band.** Suppress only the seam between a
  selected row and the selected row immediately after it. The run’s outer
  boundary, the accent wash, the continuous rail, the bold checkbox check,
  keyboard focus, and independent row semantics all remain. Do this with CSS
  adjacency, never by merging DOM or adding selection state.
- **Floating is claimed, never inferred.** A floating selection keeper and its
  palette slot carry their own structural classes
  (`.bulk-bar.has-selection`, `.keeper-panel-slot`). Never infer a floating
  panel from “the next non-empty div”: static list toolbars also use
  `.bulk-bar`, and that inference pinned the first Duplicates group to the
  viewport.

Implementation and acceptance details live in [home-surface-spec.md](archive/2026-09-10-architecture-cleanup/home-surface-spec.md) §23.

Eight further rules shipped in v0.8.217 through v0.8.220:

- **A control only becomes a square when it has an icon to show instead of its
  label.** Icons-only and compact presentations collapse `button:has(>
  .action-icon)`; a control whose only content is a word keeps its width.
  Keeper buttons centre their content like every other action lane.
- **The pane footer is a sibling, not an overlay.** Vault, appearance, and
  Settings sit below a hairline outside the scrolling navigation region, so
  they are always reachable and need no opaque patch on a translucent
  background.
- **An icon must not mean the opposite of its action.** A close action never
  wears the duplicates glyph; danger actions fall through to the shared `×`.
  Accent stays reserved for selected, active, and kept-copy state, so the
  Duplicates survivor takes the solid `--accent`/`--accent-ink` pair while its
  window origin is a neutral chip.
- **Duplicate identity is the address, not Chrome's title cache.** Each
  Duplicates card leads with its canonical address while each copy row keeps
  Chrome's own title, Keep state, Window context, and tab position. If the row
  titles disagree, one quiet ledger note explains that Chrome may retain an
  older title for a background tab until it is opened. Detection and survivor
  choice remain URL-based and outside presentation.
- **The sticky shell is opaque and quiet; one panel carries the elevation.**
  The shell paints the page's OWN background anchored to the viewport, so it is
  opaque enough to hide scrolled rows yet leaves no visible band. It stops at
  the command box's lower edge; the panel shadow is the only depth cue. No
  divider under the hero, and none inside the panel: its rows separate with
  their own hairlines, size, and colour.
- **A sticky local rail owns its silhouette and its occlusion.** Open-window
  headers keep only the panel's upper radius while stuck and rest 12px below
  the command box. Their lower edge stays square because they cap a connected
  ledger. Boundary ownership is structural: the scrolling card owns no border,
  outline, fill, or shadow;
  the sticky cap owns the complete upper frame, and one lower wrapper around
  banners, panels, and rows owns the connected side/bottom frame. A
  single page-material shelf extends `--sp-10` below the higher-z command shell
  and covers the entire gap once for the page; individual cards never carry
  full-width upper curtains. The sticky element is a neutral wrapper: two tiny
  page-material squares sit behind its upper corners, while the real rounded
  cap sits above them and draws a literal one-pixel border on every edge. The
  squares appear only through the cap's transparent outer cutouts, so no mask
  can erase or alias against the curved stroke. Content beneath therefore cannot
  defeat the visible radius. Every ancestor up to the viewport uses `overflow: clip`, never
  `hidden`, so it does not accidentally become the sticky element's scroll
  container. Non-visual helper slots do not participate in collection-grid
  rhythm while empty: the keeper-panel slot is removed from layout until it
  contains the fixed selection panel. A zero-height grid child still owns a gap
  and can otherwise offset the first sticky cap from its declared coordinate.
- **A panel that owns the boundary owns it alone.** Every descendant that can
  draw a border, radius, or elevation of its own must be neutralized inside it,
  including focus states. Shared field components carry their own frame for the
  hosts that use them bare, so wrapping one without neutralizing it puts a
  second frame inside the first. Search and the global counts share a single
  floating panel that owns the boundary, the radius, the shadow, and the focus
  ring; the field inside keeps only its layout, and the counts are the panel's
  plain-text footer row above a hairline, never chips. The panel takes the same
  working axis as `.sections`, so scrolled collections pass under an edge that
  lines up with them. Its results overlay drops below the whole panel.
- **Depth cues point the right way.** The left pane's edge shadow is inset,
  falling inside its own boundary, so the content column reads as the nearer
  surface and the pane as the recess behind it. A pane that casts outward
  claims to float above the page, which is the opposite of what it is. It is
  faint by design: a hint of recess, not a rendered edge.
- **Elevation is anchored to `--shadow-ink`, never to `--ink`.** `--ink` is
  near-white in a dark scheme, so a shadow mixed from it glows instead of
  darkening. `--shadow-ink` is `--ink` in light and black in dark. A dark
  scheme also needs more of it: the same surface takes a materially stronger
  shadow and a firmer border there, and steps up one material (`--surface`
  becomes `--surface-2`) when it has to read as floating over the page.
  Elevation changes stay inside audited surfaces so text pairings never move.

### Daily collection navigation
- Left-pane navigation is orienting: it aligns the inline collection navigator
  immediately below the sticky Search shell and never restores old section scroll.
- Inline collection tabs are replacing: they preserve the viewport while swapping
  only the mounted collection below.
- The selected inline tab is bold text with a 3px accent underline, never a second
  contained-button treatment.
- Sticky offsets include both Search and the measured navigator. Short collections
  provide bottom runway so every route can reach the same entrance.

### Toast (signature)
Bottom-left undo toast: surface + border + Float shadow, 220ms slide-in. Every
destructive or automatic action offers its undo here — "reversible, never lossy" is a
component, not a promise.

## 6. Do's and Don'ts

### Do:
- **Do** route every color decision through the ~14 role tokens and derive tints with
  `color-mix` — a new scheme must cost ~10 lines and zero component edits.
- **Do** use the fixed `--brand-*` tokens for public EveryTab identity surfaces; keep
  scheme accents for product interaction.
- **Do** pick one of the three motion roles above. A duration that is not
  `--motion-feedback`, `--motion-reveal`, or `--motion-continuity` fails smoke,
  except the explicitly scoped pending-count and Minimal atmosphere rules above.
- **Don't** add layout animation or loops outside the scoped rules above, or pass
  `behavior: "smooth"` to `scrollIntoView`. One global
  `prefers-reduced-motion` rule in `tokens.css` collapses everything else.
- **Do** keep the structure identical across all built-in and custom schemes: layout, density, hierarchy,
  and keyboard behavior never move when the palette changes.
- **Do** give every list keyboard access (arrows + Enter, `/` focuses search) and every
  focusable a visible ring (`--focus-ring`, 3–4px). Hit targets ≥ 28px.
- **Do** use `font-variant-numeric: tabular-nums` on every count, and verify `--ink-3`
  contrast in both modes whenever a scheme is added or touched.
- **Do** express trust in components: undo toast on every automatic action, vault pill
  always visible, restore always one click.

### Don't:
- **Don't** build hero-metric tiles or put big numbers on the main page — the statsline is
  one quiet 12.5px line; the stat grid exists *only* on the dedicated Stats page
  (PRODUCT.md: "no SaaS-dashboard cliché").
- **Don't** hard-code a color in a component, define per-scheme tints, or introduce an
  11th color decision — that breaks the Scheme Contract.
- **Don't** recolor the public toolbar/store mark to match a product scheme; recognition
  is the mark's job, personalization is the interface's job.
- **Don't** use shadows for at-rest hierarchy. If it doesn't float above other content,
  it gets a hairline and at most the whisper.
- **Don't** add webfonts, gradient text (`background-clip: text`), or decorative
  glassmorphism. The onboarding backdrop blur is the one sanctioned blur; the gradient
  atmosphere is an opt-in setting, not a default.
- **Don't** use uppercase tracked labels anywhere except the h3/sidebar label role — never
  as eyebrows above headings.
- **Don't** use a pill as the default treatment for a command, Search outcome,
  filter example, or navigation action. Shape must predict whether something is
  persistent state or an immediate action.
- **Don't** let a hue exist without a role, and never signal state with color alone —
  status pills carry text, the vault pill carries a label, danger buttons say what they do.
- **Don't** ship a scheme that fails AA in either mode, and never move UI elements between
  schemes — "the user's look follows them, the structure never leaves."
