import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const dashboardCss = read("css/dashboard.css");
const primitives = read("css/primitives.css");
const sidepanelCss = read("css/sidepanel.css");
const openSurface = read("js/ui/open-surface.js");
const tabFilterControl = read("js/ui/tab-filter-control.js");
const inboxSurface = read("js/ui/inbox-surface.js");
const sessionsSurface = read("js/ui/sessions-surface.js");
const tabDrag = read("js/ui/tab-drag.js");
const tablist = read("js/ui/tablist.js");
const dashboard = read("js/ui/dashboard.js");
const sidepanel = read("js/ui/sidepanel.js");
const schemes = read("js/lib/schemes.js");
const focusStrip = read("js/ui/focus-strip.js");

const checks = [];
const check = (condition, name) => {
  if (!condition) throw new Error(`FAIL: ${name}`);
  checks.push(name);
};

const openPanelRule = dashboardCss.match(
  /\.hero-panel:has\(\.search-results:not\(:empty\)\):focus-within\s*\{([^}]*)\}/s
)?.[1] ?? "";
check(!openPanelRule.includes("clip-path"),
  "the Search owner does not clip its absolutely positioned results");
check(openSurface.includes("sectionActionHost") &&
  openSurface.includes("createTabFilterControl({") &&
  tabFilterControl.includes('class: "open-filter-control"') &&
  !tabFilterControl.includes('class: "open-filter-toggle"') &&
  !tabFilterControl.includes('tabindex: "-1"') &&
  !openSurface.includes('class: "label-index open-filter section-local-sticky"'),
  "Open filter is one permanently available field in the existing section action lane");
check(dashboard.includes("sectionActionHost: openSec.actions") &&
  sidepanel.includes("sectionActionHost: SECTION_ACTION_HOSTS.open"),
  "both Open hosts inject their stable action lane");
check(dashboardCss.includes(".open-filter-control") && sidepanelCss.includes(".open-filter-control"),
  "compact Open filter geometry is host-audited");
check(tablist.includes("function focusRow(row, options = undefined)") &&
  tablist.includes("focusRow(target, { preventScroll: true })"),
  "post-render row focus cannot move the page");
check(openSurface.includes("createTabDragController") &&
  inboxSurface.includes("createTabDragController") &&
  sessionsSurface.includes("createTabDragController") &&
  tabDrag.includes("delayed destination reveal"),
  "Open, Inbox, and Sessions share one tab-drag gesture controller");
check(inboxSurface.includes("c.dragSelection") && inboxSurface.includes("moveInboxTabs") &&
  sessionsSurface.includes("c.dragSelection") && sessionsSurface.includes("moveSessionTabsWithin") &&
  tablist.includes("windowEndZone"),
  "saved lists drag selected sets atomically and expose explicit terminal window targets");
check(tablist.includes('"data-tip": msg("list_pinned_tab") }, msg("list_pinned"))') &&
  !tablist.includes('icon("pin", 12), "Pinned"'),
  "Pinned is a clear accented word without an ambiguous glyph");
check(/\.hero-panel:has\(\.search-results:not\(:empty\)\) \.hero-search-overlay::after\s*\{[^}]*inset-inline:\s*var\(--cmd-inset\)[^}]*block-size:\s*var\(--bw\)[^}]*background:\s*var\(--border\)/s.test(dashboardCss) &&
  !/\.hero-panel:has\(\.search-results:not\(:empty\)\) \.search-field[^}]*border-bottom: var\(--bw\) solid var\(--border\)/s.test(dashboardCss) &&
  !dashboardCss.includes("clip-path: inset(0 -6px -6px -6px)"),
  "open Search keeps an inset neutral divider clear of the outer contour");
check(/\.search-box:has\(\.search-results:not\(:empty\)\) \.search-results::before\s*\{[^}]*margin-inline:\s*var\(--search-inset, 10px\)[^}]*background:\s*var\(--border\)/s.test(primitives) &&
  /\.search-connected-boundary\s*\{[^}]*block-size:\s*calc\(var\(--search-field-block-size, 0px\) \+[^}]*var\(--search-results-block-size, 0px\)\)[^}]*border:\s*var\(--bw\) solid var\(--border\)[^}]*border-radius:\s*var\(--shape-search\)/s.test(primitives) &&
  /\.search-box:has\(\.search-results:not\(:empty\)\) \.search-results\s*\{[^}]*border-color:\s*transparent[^}]*box-shadow:\s*none/s.test(primitives),
  "every Search host keeps the same neutral input-to-content separator");
check(schemes.includes('dasher:     { label: "Dasher"'),
  "Dasher uses its final product name");
const { SCHEME_GROUPS, SCHEMES, SCHEME_META } = await import("../js/lib/schemes.js");
const groupedSchemeIds = SCHEME_GROUPS.flatMap(({ ids }) => ids);
check(JSON.stringify(SCHEME_GROUPS.map(({ label }) => label)) === JSON.stringify([
  "Light default · Soft", "Light default · Vivid",
  "Dark default · Soft", "Dark default · Vivid"
]) && groupedSchemeIds.length === SCHEMES.length &&
  new Set(groupedSchemeIds).size === SCHEMES.length &&
  groupedSchemeIds.every((id) => SCHEMES.includes(id)) &&
  SCHEME_GROUPS.every((group) =>
    group.ids.every((id) => SCHEME_META[id].defaultMode === group.defaultMode)),
"scheme browsing uses four complete, exclusive Light/Dark default × Soft/Vivid quadrants");
const darkSoft = SCHEME_GROUPS.find(({ id }) => id === "dark-soft")?.ids ?? [];
const darkVivid = SCHEME_GROUPS.find(({ id }) => id === "dark-vivid")?.ids ?? [];
const approvedDarkVivid = ["laser", "cyberwave", "nautilus", "phosphor"];
check(approvedDarkVivid.every((id) => darkVivid.includes(id) && !darkSoft.includes(id)),
  "the four retained high-chroma dark schemes browse under Vivid");
check(primitives.includes(".focus-strip-layout") &&
  primitives.includes("@property --focus-layout-h") &&
  primitives.includes("block-size: var(--focus-layout-h)") &&
  !primitives.includes("focus-strip-content-enter") &&
  !primitives.includes("focus-strip-surface-enter") &&
  !primitives.includes("focus-strip-content-exit") &&
  !primitives.includes("focus-strip-surface-exit") &&
  !primitives.includes("focus-strip-edge-cue") &&
  !primitives.includes(".focus-strip.focus-enter::before") &&
  focusStrip.includes('style.setProperty("--focus-layout-h"') &&
  focusStrip.includes('strip.classList.add("focus-exit")') &&
  /transitionLayout\(false, \(\) => \{\s*strip\.replaceChildren\(\)/.test(focusStrip) &&
  focusStrip.includes("const fromOpacity = presentation.opacity") &&
  focusStrip.includes("const fromClip = presentation.clipPath") &&
  focusStrip.includes("const visual = layoutInner.animate([") &&
  focusStrip.includes("follower.animate([") &&
  focusStrip.includes("Promise.allSettled(layoutAnimations.map((animation) => animation.finished)).then(finish)") &&
  focusStrip.includes('typeof layoutInner.animate !== "function"') &&
  focusStrip.includes('document.visibilityState === "hidden"'),
  "Focus commits its final layout height once, reveals the full band with reversible clip/opacity and follower motion, and clears copy only after exit settles");
check(dashboardCss.includes(".hero .focus-strip-layout-inner::before") &&
  dashboardCss.includes("--focus-recess-bg") &&
  dashboardCss.includes("--focus-recess-ink") &&
  /\.hero \.focus-strip\s*\{[^}]*border-color:\s*transparent[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s.test(dashboardCss) &&
  /\.hero \.focus-strip-layout-inner::before\s*\{[^}]*box-shadow:\s*inset/s.test(dashboardCss),
  "Focus's animated inner band owns its complete borderless recessed material");

console.log(`PASS ${checks.length}: ${checks.join(" | ")}`);
