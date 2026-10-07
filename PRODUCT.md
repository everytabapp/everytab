# Product

EveryTab uses the pointed teal stack-and-keeper mark and the tagline
"Every tab, kept, organized, local." Current architecture is described in
[ARCHITECTURE.md](ARCHITECTURE.md). Earlier positioning studies are preserved in
[the historical archive](archive/2026-09-10-architecture-cleanup/INDEX.md).

## Register

product

## Users

**The tab hoarder who has been burned.** Power users — developers, researchers, knowledge
workers — who keep 30–100+ tabs open across several projects and have already tried
OneTab, Session Buddy, Toby, or a suspender extension, and either outgrew the single
feature or lost trust in the tool (data loss, abandonment, a malware sale, a paywall).
Many already live in local-first tools like Obsidian and actively prefer the file-vault
model; they will read the data format and expect keyboard control.

Their context: they open the browser to *work*, not to manage tabs. The extension has to
earn attention it isn't asking for — its most-seen surface is the **new-tab page**, which
lands in front of the user dozens of times a day and must feel like home, not a chore.

The job to be done: keep the browser clean and every saved thing findable, without the
user having to think about it — and without ever making them fear they've lost something.

## Product Purpose

One local-first, open-source, free extension that replaces the stack of single-purpose
tools (session saver + suspender + snoozer + dedup) with one coherent tool sharing a
single data model, archive, and search. Tabs flow through a unified **Inbox** (manual save
or idle auto-save). Recoverable closing saves addresses before closing pages;
it cannot preserve unsaved text or every page's application state. The working
library is stored locally in IndexedDB. An optional Vault writes incremental
backup data and readable JSON/Markdown views into a folder the user owns.
There is no EveryTab server, account, or telemetry.

Success looks like: a burned power user installs it, configures a vault, leaves
auto-archive on after 30 days because it reads as relief rather than surprise, and tells
other people "I switched from Toby/OneTab and I trust this one." Ship gate: zero
data-loss bugs; restore works 100% of the time.

**Business-model boundary, settled 2026-08-06:** the complete local product is free,
including every v1 feature, the complete built-in scheme portfolio, and the user graphic configurator.
There is no paid edition, cosmetic entitlement, account, license check, supporter badge,
or preferential product treatment. EveryTab may offer a quiet voluntary support link in
Settings > About and on public project pages, but never interrupt routine use to ask for
money. Adoption, trust, and a strong public product case study are the primary return.
A separate future hosted service may be considered only when it provides genuine ongoing
value and cost; it must not remove or degrade features already delivered by the free local
extension. Before launch, the open-source promise will be completed by publishing the
code under MPL-2.0 from a curated repository whose tags match Store releases. The
EveryTab name, wordmark, pointed teal stack-and-keeper mark, and product icons remain
under a separate friendly trademark policy. Formal trademark registration is optional
and is not assumed before the product demonstrates traction.

## Brand Personality

The product feel, emotional register, and public mark are settled.

**The working feel is precise, fast, keyboard-first — Raycast/Linear energy.** Clean and
beautiful, but *smooth and optimized are the non-negotiables*: nothing over ~200ms, results
render as you type, `/` focuses search, arrows-and-Enter everywhere there's a list. The
tool should disappear into the user's hands.

**The emotional register is "this is yours, and it feels like home."** The scheme
personalization (the full built-in portfolio plus local custom palettes, seen every new tab) is not a gimmick — it's how
the product earns daily affection. The vault-you-own story and the theme-that-follows-you
story are the same story: your data, your look, no one else's.

Voice for comms: lead with **never lose anything** *and*
**a calm, uncluttered space to stay focused** — organization and safety, not feature
count. Confident, plain-spoken, no overpromising ("Ultimate", "Infinity" are banned in the
naming brief for a reason). The name, tagline, and mark are settled. The original
wildcard, ET tile, Tabline, angled Pocket Stack, and flat archive-box alternative were
retired after recognition and Chrome-context comparisons. **v0.8.204 installs MH's
final pointed teal stack-and-keeper mark:** three clear horizontal layers retained by
one pointed body with a white check. At 16–24 px the point provides a memorable
silhouette; under the orange count badge it remains identifiable; at 48–128 px it reads
as tabs gathered and kept rather than a generic completed inbox. Its limited shield
association supports the product's trust and local-safety promise without becoming the
primary reading. The approved `#1E4A49` → `#47ADAA` ramp never follows product schemes,
and the supplied 1024 square canvas is preserved. See [brainstorm-d2-logo.md](archive/2026-09-10-architecture-cleanup/brainstorm-d2-logo.md) v16 and
`campaign-assets/restart-logo-studies.md`.

## Anti-references

- **The Great Suspender** — the malware-sale cautionary tale. We are the opposite: open
  source, readable data, no telemetry. Never look opaque or ownerless.
- **Toby / Workona** — cloud workspaces with lock-in and reported data losses. Never a
  server-backed account product; never make the user's data feel like it lives on someone
  else's machine.
- **OneTab-era stagnation** — a single dumb list that never grew up. We're coherent and
  searchable, not a flat pile.
- **The kitchen-sink extension** — bolting unrelated features together with mismatched UIs.
  Everything shares one data model, one archive, one search, one structure.
- Visually: no SaaS-dashboard cliché (hero-metric tiles, big numbers on the main page),
  no clutter. Stats live on their own page; the daily view stays light.

## Design Principles

1. **Reversible, never lossy.** Every automatic action (auto-archive, dedup, suspend) is
   undoable and lands somewhere searchable. Nothing is ever silently deleted. This trust
   contract is expressed *in the UI*, not just the docs — restore is always one click,
   always visible.
2. **Structure fixed, skin free.** One identical structure — layout, hierarchy, density,
   keyboard behavior, component anatomy — across every theme. Skins are total (color, type,
   radius, motion, character) but never move things. You always know where everything is.
3. **Colorful like an editor theme, quiet like a good tool.** Multiple accent hues are
   welcome — schemes may pair and play colors the way syntax themes do (Laser's
   magenta + cyan, Godspeed's orange + blue) — but every hue has a *role*, the way syntax
   tokens do. What stays quiet is the noise: big numbers off the main page, no clutter,
   automatic features tuned so they're discovered as relief, not experienced as surprise.
4. **Speed is a feature.** No transition above ~200ms, hover instant, search renders as you
   type, fully keyboard-navigable. Smooth and optimized are ship-blocking, not polish.
5. **Feels like home.** The most-seen surface (new tab) and the scheme personalization are
   how the product earns daily affection. Personalization is a first-class feature, not a
   setting buried in options.

## Accessibility & Inclusion

- **WCAG AA contrast in every scheme and mode** (currently 36 built-ins × light/dark) — verified per
  combination, not assumed. Muted `--ink-3` text must still clear its threshold on tinted
  surfaces.
- **Keyboard-first throughout**: visible 2px accent focus rings, arrows + Enter in every
  list, `/` to focus search, hit targets ≥ 28px.
- **`prefers-reduced-motion` respected everywhere** — gradient orbs and all animation have
  a reduced-motion path (already wired in `tokens.css`).
- Color never carries meaning alone; status is reinforced by label/icon. Schemes span warm
  and cool so users aren't forced into a palette that fails their vision needs.
