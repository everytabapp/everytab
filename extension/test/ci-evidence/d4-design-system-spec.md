# D4-1: Calm Precision design-system specification

> **Status: D4-1 APPROVED; D4-2a FOUNDATION + D4-2b SIGNATURE PILOT SHIPPED
> AND USER-VERIFIED; D4-3a DASHBOARD SHELL SHIPPED AND USER-VERIFIED, with its
> guidelines-review findings in v0.8.184 and its live-Chrome iteration pass in
> v0.8.185; D4-3b POPUP + FOCUS GUARD SHIPPED (2026-07-25, current runtime
> v0.8.186); D4-3d POPUP REDESIGN + D4-3c COMPLETE (2026-07-25, current runtime
> v0.8.189); D4-4 MOTION AND VALIDATION SHIPPED (2026-07-25, current runtime
> v0.8.190, MH Chrome eyeball open). **D4 IS COMPLETE.**
> Bold emphasis, round theme-colored checkboxes, square
> rows, ultra-compact density, equal group spacing, and a full-width dashboard Focus
> band are now the target defaults. **Soft** and **Crisp** are confirmed Appearance
> values with distinct selection treatments. Window grouping is confirmed as a
> three-value Appearance setting: **Space**, **Divider**, or **Accent cap**. Accent cap
> reveals a two-value **Fine/Bold** strength suboption.
> The approved foundation and signature list styling are now live; the 23-scheme color
> contract remains unchanged.
>
> Refined target: `campaign-assets/d4-direction-studies-v2.html`
>
> Original comparison, intentionally preserved: `campaign-assets/d4-direction-studies.html`

## 1. Direction

**Calm Precision** combines the Precision Workspace interaction skeleton with the Quiet
Personal Library material layer.

- Dense tab rows remain fast to scan.
- Space separates meaningful objects and sections, not every control.
- Fine dividers and alignment do more work than cards.
- Core row actions are direct on hover, keyboard focus, or selection; the row title keeps
  its normal activation behavior.
- Themes provide personality. Geometry and elevation remain quiet.
- Motion explains a state change and then gets out of the way.

The Contextual Browser Cockpit direction is rejected as the whole-product structure. Its
compact progressive disclosure may be used in the side panel and narrow navigation only.

## 2. Signature

The product signature is the **keeper state transition**, not a repeated decoration:

- saved, selected, snoozed, focused, and restored objects gain a restrained accent-backed
  state at the exact place the change occurred;
- selection uses a full theme-derived surface plus a semantic full-height leading rail;
  the rail is state feedback, not a decorative motif, and never shifts row content;
- bulk selection resolves into a stable keeper dock;
- transient feedback names the destination or result;
- the teal mark remains the only literal stacked-object motif.

No decorative stripe, fake stack, or logo fragment repeats on every card.

## 3. Token architecture

EveryTab already has the correct theme layer. D4 adds structure around it rather than
renaming all scheme values.

### Layer 1: scheme contract, existing

Each scheme/mode continues to provide:

- `--bg-solid`, `--bg-grad`;
- `--surface`, `--surface-2`, `--border`;
- `--ink`, `--ink-2`, `--ink-3`;
- `--accent`, `--accent-ink`, `--accent-strong`, `--accent-strong-ink`;
- `--ok`, `--warn`, `--danger`.

Existing derived semantic roles such as `--accent-soft`, `--focus-ring`, `--danger-bg`,
`--side-bg`, and `--shadow-1` remain the color API. Components do not use raw scheme
values or raw hex.

### Layer 2: system structure

Proposed tokens:

```css
:root {
  /* spacing */
  --sp-1: 2px;
  --sp-2: 4px;
  --sp-3: 6px;
  --sp-4: 8px;
  --sp-5: 10px;
  --sp-6: 12px;
  --sp-8: 16px;
  --sp-10: 20px;
  --sp-12: 24px;
  --sp-16: 32px;

  /* type */
  --text-micro: 10px;
  --text-meta: 11px;
  --text-control: 12px;
  --text-body: 14px;
  --text-section: 18px;
  --text-page: 24px;

  /* shape */
  --shape-row: 0;
  --shape-nav: 3px;       /* Crisp profile */
  --shape-focus: 2px;
  --shape-control: 5px;
  --shape-search: 4px;
  --shape-keeper: 7px;
  --shape-panel: 9px;
  --shape-card: 10px;
  --shape-pill: 999px;

  /* motion */
  --motion-feedback: 80ms;
  --motion-reveal: 140ms;
  --motion-continuity: 180ms;
  --ease-out: cubic-bezier(.2, .8, .2, 1);

  /* density */
  --row-h-ultra: 34px;
  --row-h-tight: 39px;
  --row-h-default: var(--row-h-ultra);
  --control-h-compact: 28px;
  --control-h-default: 34px;
  --search-h: 42px;
}

[data-corner-style="soft"] {
  --shape-nav: 8px;
  --shape-focus: 9px;
  --shape-control: 9px;
  --shape-search: 11px;
  --shape-keeper: 13px;
  --shape-panel: 14px;
  --shape-card: 14px;
}
```

These names are a target API. The foundation batch may map existing tokens to them before
removing obsolete aliases.

### Layer 3: component roles

Components expose their own dimensions only when they intentionally vary:

```css
.tab-row {
  --row-height: var(--row-h-default);
  --row-radius: var(--shape-row);
  --row-gap: 0;
}

[data-row-density="ultra"] .tab-row {
  --row-height: var(--row-h-ultra);
  --row-gap: 0;
}
```

Host styles may choose density and layout. They may not redefine semantic hover, focus,
selected, disabled, danger, or feedback behavior.

## 4. Type system

Keep the system font stack and current mono stack.

| Role | Size | Weight | Use |
|---|---:|---:|---|
| Page title | 24 px | 650 | one per top-level view |
| Section title | 18 px | 650 | Open tabs, Inbox, Sessions |
| Object title | 12-14 px | 550-650 | tab, window, session, setting title |
| Body | 14 px | 400 | descriptions and explanatory copy |
| Control | 12 px | 550 | buttons, switcher, menus |
| Metadata | 11 px | 400 | host, recency, counts |
| Micro | 10 px | 500 | constrained panel metadata only |

Rules:

- use weight and color before shrinking;
- metadata may be mono when the value benefits from alignment;
- uppercase is limited to short structural labels;
- truncate tab titles before action labels;
- 200% zoom validation may raise any minimum size.

## 5. Layout and responsive structure

### Dashboard

- Use one compact sidebar. Do not add a second keeper rail or repeat navigation icons.
- Full sidebar target: 200-210 px.
- The sidebar is manually collapsible and remembers its state.
- Below the measured compact breakpoint, it becomes a 56-64 px icon rail.
- Below the measured phone-like/200%-zoom breakpoint, section navigation becomes an
  anchored header switcher; it does not squeeze a rail beside the list.
- Search remains the first strong control in content.
- The global compact stats line sits directly below search, before section navigation or
  content.
- Focus appears below the stats line only while active, giving the search glow and Focus
  boundary distinct space.
- Page title, result count, group/sort controls, and content follow in that order.
- Keep a compact inline daily summary visible below search, for example
  `24 tabs · 3 windows · 2 duplicates · 4 suspended`; the full Stats section remains.
- Do not add generic Group/Recent controls to the Open heading without a settled product
  behavior; window-level Organize already owns the relevant sorting/gathering actions.
- The space from the section heading to the first window equals the space between window
  groups. Member rows remain contiguous and substantially tighter.
- The content column owns horizontal space; no setting control forces page overflow.

**Breakpoints frozen in D4-3a (v0.8.183): 900 px and 620 px**, exported as
`NAV_COMPACT_MAX` and `NAV_HEADER_MAX` from `js/lib/nav-mode.js` and mirrored by the
pre-paint `js/boot.js`. They were checked against real content rather than adopted by
convention:

- at 900 px the labelled 204 px sidebar leaves a 624 px content column, while the rail
  leaves 768 px, so the switch buys back roughly a quarter of the reading width exactly
  where the list starts to feel squeezed;
- the longest live nav label, `Export / Import`, fits the 204 px sidebar with room to
  spare, and `.navtext` still ellipsizes beyond it, so 204 px does not truncate the
  product's own vocabulary;
- at 620 px a 60 px rail leaves 504 px of content against 596 px for the header
  switcher, and the horizontal switcher still reaches every top-level section;
- 200 % zoom halves the CSS-pixel viewport, so a 1280 px window reports 640 px and lands
  in the rail and a 1100 px window reports 550 px and lands in the header state. No
  zoom-specific branch exists or is needed.

MH's live Chrome pass is the confirming gate; the numbers move only with evidence from
it.

### Side panel

- 320 px is the hard minimum acceptance width.
- Search, active Focus, and section switcher remain sticky.
- Open, Inbox, Sessions, and Labels are direct text tabs; Snoozed remains under More.
- The switcher uses a quiet underline/selected state rather than five pills.
- Rows reveal the complete core action set on hover, row focus, or selection. At 320 px
  these are compact icon controls with accessible names and tooltips.
- Selection uses a bottom keeper dock within the panel gutters.
- Hosts and secondary metadata disappear before tab titles become unusably short.

### Popup

- One default primary journey per group.
- Inline panels reuse the same field, menu, and feedback components.
- Footer navigation is visually separate from tab/window actions.
- The popup remains a task surface, not a miniature dashboard.

### Settings, Data, and Vault

- Setting rows align label/description and control at comfortable widths.
- When the content column cannot keep both usable, the control stacks beneath the text.
- Status and permission-needed feedback use the shared feedback grammar.
- Long paths, filenames, shortcut labels, and permission text wrap without widening the
  page.

### Appearance choices

- **Emphasis:** Bold by default; Muted softens both active Focus and the selected
  navigation section.
- **Checkbox shape:** Round by default; Square is optional. Both shapes use the same
  theme-surface fill when unchecked and accent fill when checked. Checkbox fill is not a
  separate preference.
- **Row information:** Clean, Useful by default, or Detailed, as specified below.
- **Corner style:** Soft and Crisp are both confirmed Appearance values. Crisp is the
  initial production default carried from the approved study. Rows stay
  square in both modes. Soft uses a quiet independent selection wash with no rail and
  no joined multi-row enclosure. Crisp uses the stronger accent-soft selection,
  full-height rail, and joined adjacent selections.
- **Row density:** Ultra-compact by default. Tight remains a system fallback, not a
  second open D4 decision.
- **Focus presentation:** Full-width content band on the Dashboard. The constrained side
  panel retains a contained strip.

## 6. Container rules

Use a container only when it communicates one of these:

1. a meaningful grouped object, such as a Session;
2. a transient floating surface, such as a menu;
3. a selected/active state;
4. a boundary necessary for interaction, such as a field.

Default tab/window lists are flat:

- group headers establish hierarchy;
- rows use alignment and spacing rather than repeated frames or horizontal dividers;
- hover/active material appears locally;
- no shadow on static list groups;
- no nested card inside card.

Cards remain appropriate for Sessions, onboarding choices, status summaries, and empty
states when the object boundary is itself meaningful.

## 7. Action hierarchy

### Levels

1. **Primary:** the likely next action for this object/context.
2. **Secondary:** useful, reversible, less frequent.
3. **Quiet:** navigation, disclosure, or low-emphasis utility.
4. **Danger:** destructive or difficult-to-recover action.

### Row rule

- keep the current core actions direct: Save to Inbox, Label, Snooze, Suspend/Wake, and
  Close;
- show row content alone at rest; reveal the direct action set on hover, row focus, or
  selection without requiring selection;
- Right Arrow from the row enters the action toolbar; Left Arrow walks back and returns
  to the row; Esc returns to the row;
- the direct controls may expose shortcut hints in tooltips when bindings exist, while
  `?` remains the complete reference;
- keep row activation and selection semantics already settled;
- use an overflow only if a future row gains genuinely secondary actions beyond this
  confirmed core set.

### Open-window header rule

- keep four direct actions: Inbox, Session, Copy, and Organize;
- wide layouts use short text labels plus full tooltips;
- the side panel uses the same actions as icons with accessible names and tooltips;
- do not restore the retired window Focus action;
- do not add a header Label action: the whole-window checkbox and bulk Label path own
  whole or partial-window labeling;
- do not add a generic More trigger while the confirmed four actions fit.

### Bulk rule

- selecting one or more rows reveals the keeper dock;
- the dock names the count first;
- the most common bulk actions remain direct;
- Open's dock exposes Inbox, Label, Snooze, Suspend/Wake, Session, and Close;
- bulk Move is removed. Positional movement remains the existing pointer drag and
  keyboard move-handle interaction, never a bulk command;
- overflow contains the rest;
- destructive actions are separated inside overflow;
- the dock never shifts the list layout.

### Button variants

| Variant | Treatment | Use |
|---|---|---|
| Primary | accent or accent-soft according to context | one per local action group |
| Secondary | `surface-2` with border or quiet fill | routine supporting action |
| Quiet | transparent until hover/focus | navigation/disclosure |
| Danger | `danger-bg`, danger indicator + explicit verb | remove/delete/stop when destructive |
| Link | text treatment, no fake button box | navigation in prose or footer |

Default height is 34 px; compact is 28 px. Icon-only controls require an accessible name
and a tooltip, with a minimum 28 px target in compact surfaces.

## 8. Core component specifications

### Search

- 42 px default height; 38 px compact.
- one border, `surface` background, subtle base shadow;
- uses the active corner profile: 4 px Crisp or 11 px Soft, never a pill;
- focus uses the established accent ring;
- the global stats line follows search and creates separation before active Focus;
- scope/filter chips appear inside the search contract only when active;
- result overlay uses Float elevation and no nested card treatment.

### Active Focus

- bold accent fill by default, distinct from the softer selected-row state;
- full-width square band across the Dashboard content pane;
- the side panel keeps a contained strip using the active corner profile;
- Muted emphasis switches to an accent-soft fill without changing geometry;

### Navigation

- current section uses a high-contrast accent fill by default;
- Muted emphasis changes it to accent-soft material plus icon/text state;
- active navigation uses the selected corner profile: 3 px Crisp or 8 px Soft;
- hover is quieter than selected;
- counts use metadata styling and do not become badges unless status needs attention;
- collapsed navigation keeps tooltips and keyboard order;
- section descriptions stay in content, not in the navigation.

### Tab row

Order:

1. selection/move affordance where applicable;
2. favicon;
3. title + the configured metadata line;
4. labels/status if space permits;
5. direct core action toolbar when revealed.

Appearance controls the optional text detail:

- **Clean:** title only;
- **Useful, default:** title plus hostname;
- **Detailed:** title plus hostname and recency;
- labels and pinned/audio/suspended indicators remain visible independently of this
  preference.

States:

- hover: local `surface-2` or subtle accent mix;
- focus-visible: 2 px accent ring with offset;
- selected: a clear theme-derived full-row surface plus a full-height leading rail;
- dragging: reduced opacity; target line remains explicit;
- disabled/stale: maintain readable text and name why the action cannot run.

Geometry:

- selection indicators are absolutely positioned and never shift the checkbox, favicon,
  title, label chips, or actions;
- rows are square and contiguous, like a mail list; adjacent selected rows share their
  horizontal edge and their leading rails join visually;
- round checkboxes are the default; Square is an Appearance alternative. Shape never
  changes position, semantics, or theme-consistent fill;
- row action lanes reserve stable width in wide layouts so label chips do not slide when
  actions reveal;
- window-header and row checkboxes share the same x-axis.

### Group header

- title leads;
- count/meta follows;
- live Open windows use the product's actual naming, `Window 1`, `Window 2`, and so on,
  with `current` carried as metadata rather than invented session-like names;
- Open-window headers keep Inbox, Session, Copy, and Organize direct;
- other group types follow their task-specific direct/bulk contracts; add overflow only
  when actions are truly secondary and no longer fit;
- stronger than rows through weight and spacing, not a card;
- the window title is bold; the first window and subsequent windows use the same
  inter-group space, while member rows are contiguous;
- expand/collapse, drag, and selection affordances remain distinct.

Appearance keeps three window-grouping treatments:

1. **Space:** hierarchy from the confirmed equal group gap alone.
2. **Divider:** a nearly subpixel, low-contrast hairline centered in the inter-window
   gap.
3. **Accent cap:** a slim top accent rule plus a firmer header baseline.

All three preserve checkbox alignment, square member rows, direct window actions, and the
same semantic reading order.

Accent cap strength is a conditional suboption, not a fourth grouping choice:

- **Fine:** 0.5 px;
- **Bold:** 2 px.

The control is shown only while Accent cap is selected. Bold is the initial value carried
from the approved study.

### Chips

- tag: accent-soft, pill permitted;
- scope/filter: quiet pill with selected/removable state;
- status: includes text/icon, never color alone;
- count: plain metadata by default;
- removable chips keep the close target independently focusable.

### Menu and anchored panel

- `surface`, one border, Float shadow, and the active panel radius;
- command label left, shortcut right;
- groups separated by spacing or divider;
- destructive group last;
- opens in 140 ms with opacity + 2-4 px transform;
- focus moves inside and returns to the trigger on Esc/close.

### Keeper dock

- surface background with accent-aware border;
- 42-46 px height;
- wide layouts: anchored within content;
- narrow layouts: fixed to panel gutters;
- count first, routine actions next, More last;
- enters/exits with opacity + small vertical transform, 180 ms maximum;
- reduced motion: instant.

### Feedback

| Role | Visual | Copy |
|---|---|---|
| Neutral notice | surface + border | what changed |
| Success | restrained `ok` indicator | completed verb + destination |
| Warning | `warn` indicator + next step | what needs attention |
| Danger/error | danger indicator + recovery action | what failed and how to recover |
| Empty | no decorative card by default | what belongs here + useful action |
| Loading | preserve layout | specific object/action when possible |

## 9. Motion vocabulary

Allowed:

- color/background/opacity feedback: 80 ms;
- menu, tooltip, anchored panel: 140 ms opacity + 2-4 px transform;
- toast and keeper dock: 180 ms opacity + 4-6 px transform;
- purposeful drag/drop feedback that follows the pointer directly.

Rejected:

- `transition: all`;
- grid-track animation for routine section rendering;
- decorative page entrance;
- ambient movement on daily surfaces;
- staggered list-row reveal;
- motion that delays focus or clickability;
- smooth scrolling that overrides reduced motion or keyboard expectations.

All interaction remains interruptible. Reduced motion collapses the vocabulary to instant
state changes.

## 10. Accessibility contract

- every top-level HTML document declares `lang="en"`;
- every interactive element has a visible focus state;
- focus indication does not rely on color alone;
- every icon-only action has an accessible name;
- semantic buttons remain buttons;
- menus, tablists, comboboxes, listboxes, and selection state retain current ARIA
  contracts;
- text passes 4.5:1, large text and UI boundaries pass 3:1;
- all 46 scheme/mode combinations remain automated;
- 200% zoom has no clipped action, horizontal page scroll, or unreachable content;
- tooltips supplement labels and never carry critical instructions alone.

## 11. Implementation order

### D4-2a: Foundation, no layout redesign

**Shipped 2026-07-25 in v0.8.181.**

- complete structural token API added without remapping legacy aliases;
- shared semantic primitives extracted only where material was already common;
- missing `lang="en"` declarations and source contracts added;
- every `transition: all` replaced with an explicit property list using D4 motion tokens;
- current DOM, host layout, schemes, action behavior, and storage preserved.

### D4-2b: Signature pilot

**Shipped and user-verified 2026-07-25 in v0.8.182 ("All good").**

- Tab Row, group header, direct core row/window hierarchy;
- wide keeper dock;
- side-panel compact direct actions and bottom keeper dock;
- verify dashboard and 320/400/600 px panel together.

Production ownership is `css/tablist-d4.css` plus the shared DOM in
`js/ui/tablist.js`. Appearance values are normalized by `getSettings()`, reflected as
root data attributes by the theme engine, and cached for pre-paint. Open window headers
are Window N plus separate tab/current metadata and direct Inbox, Session, Copy,
Organize actions. Crisp uses an absolute full-height rail; Soft removes the rail and
uses independent washes. The Open keeper is Inbox, Label, Snooze, Suspend/Wake,
Session, Close with no Move. Compact actions remain fully named through `aria-label`
and tooltips while their visible labels collapse to icons.

### D4-3a: Dashboard shell

**Shipped 2026-07-25 in v0.8.183 and user-verified; the Web Interface Guidelines
review findings (skip-to-content control, 24px nav fold-arrow hit target,
`overscroll-behavior-x: contain` on the header switcher) shipped in v0.8.184. The
v0.8.185 live-Chrome pass, run through `extension/tools/shell-harness.html`, then
fixed the collapse control never actually hiding and the icon rail losing its group
boundaries.**

- one navigation model with three presentations, resolved once by the pure
  `js/lib/nav-mode.js` and published as the single `data-nav` root attribute: 204 px
  labelled sidebar, 60 px icon rail, anchored horizontal header switcher;
- the additive strictly-boolean `uiSidebarCollapsed` records only the wide-layout
  choice, is written with `patchSettings`, cached by `theme.js`, and resolved pre-paint
  by `boot.js`, so a forced narrow state never rewrites it and a remembered rail never
  flashes expanded;
- collapsing removes visible text only: complete `aria-label`s, counts in the accessible
  name, `aria-current="page"`, rail-scoped tooltips, unchanged DOM order, and a collapse
  control that withdraws once the viewport decides the presentation;
- hero order is search, global stats, then active Focus; the sticky shell is opaque and
  full-bleeds the content pane through one `--pad-x`, and `measureHero`/`--hero-h` is
  unchanged;
- Dashboard Focus is a full-width square band and active navigation gained the same
  Bold/Muted split, both on contrast-audited pairs;
- New Tab Dashboard verified as the same module, stylesheet, and shell; Minimal and
  Blank untouched.

### D4-3b: Popup and Focus

**Shipped 2026-07-25 in v0.8.186; MH Chrome eyeball open.**

- `primitives.css` owns the semantic button vocabulary (primary, danger, warn, quiet,
  disabled), the link role, the inline P3 panel role, `.sr-only`, and the tooltip;
  both hosts keep only their own density and layout;
- `focus.html` joined the shared layer, so the D4-2a isolated-hosts contract was
  flipped deliberately; both documents declare the appearance attributes their shared
  roles key off and use the 34px default / 28px compact control heights;
- the popup's single accent primary takes a full-width row, `min-width` moved to 380px
  so no action label wraps, and the footer is quiet navigation behind a rule;
- journeys, action ids, message types, disabled/permission gates, the one-open inline
  panel rule, and every settled guard-page behavior are unchanged;
- review findings fixed: confirmations announce politely, group titles are real `h2`s,
  the dismiss target reaches 24px, the guard card's elevation resolves to a real token,
  and its settings link uses the link role rather than the button-only quiet role.

**Deferred with reason:** the search-box family is duplicated across four hosts
including the side panel and the shell. Consolidating it is a whole-product move and
belongs to D4-3c/D4-4, not a popup wave.

### D4-3c: Onboarding, Settings, Data, Vault, secondary states

- responsive setting rows;
- type/status/empty/loading/error grammar;
- shortcut discoverability.

### D4-4: Motion and validation

- apply only the approved vocabulary;
- keyboard/focus/ARIA and 200% zoom;
- all schemes;
- functional regression;
- performance comparison;
- update `DESIGN.md` and `.impeccable/design.json`.

## 12. Approved system gate

MH approved:

- the refined Calm Precision v2 target in Cream light plus a representative dark and
  high-chroma scheme;
- Soft versus Crisp corner style, including search, active navigation, action controls,
  keeper dock, and their deliberately different row-selection treatments;
- Space, very fine Divider, and Accent cap window grouping;
- Fine and Bold Accent-cap strengths as a conditional suboption;
- dashboard/list hierarchy;
- direct row actions on hover, keyboard focus, and selection;
- Inbox/Session/Copy/Organize window actions;
- Clean/Useful/Detailed row information modes;
- flat group containment;
- side-panel switcher and bottom keeper dock;
- responsive navigation plan;
- motion vocabulary.

Already fixed rather than awaiting comparison: selection indicators do not move content;
global stats sit below search and separate it from Focus; Group/Recent mock controls are
removed; window/row checkboxes align; label chips remain stationary when actions appear;
bold emphasis is the default with a Muted alternative; round checkboxes are the default
with a Square alternative; checkbox fill follows the scheme consistently; rows are
square; Crisp uses full-height joined rails while Soft uses independent muted selections;
ultra-compact density and full-width Dashboard Focus are confirmed; the first-window gap
equals subsequent window gaps; window grouping offers Space, Divider, and Accent cap;
and Open's bulk dock
contains Inbox, Label, Snooze, Suspend/Wake, Session, and Close, with no bulk Move.

The system gate, E3 B1-B11 live baseline, and real-Chrome screenshot ledger are closed.
D4-2a shipped as the behavior-preserving foundation in v0.8.181 and D4-2b shipped the
visible Tab Row, group-header, action-hierarchy, and F14 compact signature pilot in
v0.8.182. MH passed the production pilot on 2026-07-25, so D4-3a is unblocked.
