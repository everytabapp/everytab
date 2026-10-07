/** Production-rendered Scheme Lab list anatomy and its host selector contract. */
import { createTabList } from "../extension/js/ui/tablist.js";

export const SPECIMEN_SELECTOR_CONTRACT = Object.freeze([
  "body.gradient .orb",
  "body.gradient .hero",
  'body[data-workbench="true"] .section-lead',
  'body.gradient[data-workbench="true"] .section-lead',
  'body[data-workbench="true"] .section-local-sticky',
  'body.gradient[data-workbench="true"] .section-local-sticky',
  "body.gradient .tablist:not([data-compact]) > .item > .item-head-shell::before",
  ".panel-chrome > .search-box",
  "body.gradient .panel-chrome",
  ".panel-section-lead",
  "body.gradient .panel-section-lead",
  '[data-surface="sidepanel"] .section-local-sticky',
  'body.gradient[data-surface="sidepanel"] .section-local-sticky',
  '[data-surface="sidepanel"] .tablist[data-compact] > .item > .item-head-shell',
  'body.gradient[data-surface="sidepanel"] .tablist[data-compact] > .item > .item-head-shell::before',
  ".navitem.active",
  '.switch-tab[aria-selected="true"]::after',
  '[data-surface="sidepanel"] .tablist[data-compact]',
  '[data-surface="sidepanel"] .tablist[data-compact] > .item > .item-head-shell',
  '[data-surface="sidepanel"] .tablist[data-compact] > .item > .item-body-frame',
  '[data-surface="sidepanel"] .tablist[data-compact] .tacts',
  '[data-surface="sidepanel"] .tablist[data-compact] .tacts::before'
]);

export function specimenSurfaceContract(width) {
  const compact = Number(width) <= 400;
  return Object.freeze({
    width: Number(width),
    surface: compact ? "sidepanel" : "dashboard",
    presentation: compact ? "compact" : "default",
    hasCompactAttribute: compact
  });
}

function inertAction(id, label, options = {}) {
  return { id, label, run: () => {}, ...options };
}

function specimenGroups() {
  return [{
    id: "scheme-lab-window",
    title: "Window 1",
    meta: "9 tabs · current window",
    chips: ["planning"],
    refs: [
      {
        url: "https://example.com/product-strategy",
        title: "Normal row: EveryTab product strategy",
        labels: ["planning"]
      },
      {
        url: "https://example.com/component-contrast",
        title: "Hover row: component contrast worksheet",
        labels: ["research"]
      },
      {
        url: "https://developer.chrome.com/docs/extensions/",
        title: "Focus row: keyboard state stays unmistakable",
        labels: ["reference"]
      },
      {
        url: "https://example.com/long-selected-row",
        title: "Selected row with a deliberately long title that yields before every required compact action",
        labels: ["very long label name"]
      }
    ]
  }];
}

/** Mount the real shared list renderer, then pin named visual states for QA. */
export function createProductionListSpecimen({ width, instanceId }) {
  const contract = specimenSurfaceContract(width);
  const list = createTabList({
    section: `scheme-lab-${instanceId}`,
    presentation: contract.presentation,
    groups: specimenGroups(),
    selectable: "tab",
    foldable: true,
    onChipOpen: () => {},
    rowActions: [
      inertAction("move", "Move", { glyph: "⠿" }),
      inertAction("star", "Star", { icon: "star" }),
      inertAction("label", "Label", { icon: "labels" }),
      inertAction("remove", "Remove", { danger: true, glyph: "×" })
    ],
    groupActions: [
      inertAction("dump-window", "Save to Inbox", { shortLabel: "Inbox" }),
      inertAction("save-session", "Save as Session", { shortLabel: "Session" }),
      inertAction("label-window", "Label", { shortLabel: "Label", icon: "labels" }),
      inertAction("copy", "Copy links", { shortLabel: "Copy", icon: "copy" }),
      inertAction("organize", "Organize"),
      inertAction("snooze-window", "Snooze window", { shortLabel: "Snooze", icon: "snooze" }),
      inertAction("close-window", "Close", { danger: true })
    ]
  });
  const rows = [...list.querySelectorAll("[data-tablist-row]")];
  rows[1]?.classList.add("lab-force-hover", "kbd-reveal");
  rows[2]?.classList.add("lab-force-row-focus", "kbd-reveal");
  rows[3]?.classList.add("sel", "kbd-reveal");
  const star = rows[3]?.querySelector('[data-action-id="star"]');
  star?.classList.add("star-action", "is-starred");
  list.dataset.labRenderer = "createTabList";
  return list;
}

/** Runtime anatomy assertion used by the Lab and the Node DOM contract test. */
export function inspectProductionListSpecimen(root, contract) {
  const compact = root.hasAttribute("data-compact");
  return {
    renderer: root.dataset.labRenderer,
    compact,
    surface: root.closest("[data-surface]")?.dataset.surface ?? null,
    cards: root.querySelectorAll(":scope > .item").length,
    headShells: root.querySelectorAll(":scope > .item > .item-head-shell").length,
    bodyFrames: root.querySelectorAll(":scope > .item > .item-body-frame").length,
    rows: root.querySelectorAll("[data-tablist-row]").length,
    actionTrays: root.querySelectorAll(".tacts").length,
    ok: root.dataset.labRenderer === "createTabList" &&
      compact === contract.hasCompactAttribute &&
      root.querySelectorAll(":scope > .item > .item-head-shell").length === 1 &&
      root.querySelectorAll(":scope > .item > .item-body-frame").length === 1 &&
      root.querySelectorAll("[data-tablist-row]").length === 4 &&
      root.querySelectorAll(".tacts").length === 4
  };
}

function directChild(parent, child) {
  return Boolean(parent && child && (child.parentElement ?? child.parentNode) === parent);
}

function styleValue(style, camel, kebab = camel.replace(/[A-Z]/g, (letter) =>
  `-${letter.toLowerCase()}`)) {
  return style?.[camel] || style?.getPropertyValue?.(kebab) || "";
}

function hasGradient(style) {
  const image = styleValue(style, "backgroundImage");
  return Boolean(image && image !== "none");
}

/**
 * Inspect connected host anatomy and resolved styles. The Lab calls this only
 * after a specimen is mounted, with the browser's getComputedStyle. Tests may
 * inject a style reader, but cannot satisfy the contract with source strings.
 */
export function inspectProductionShellSpecimen(root, contract, readStyle = globalThis.getComputedStyle) {
  const compact = contract.surface === "sidepanel";
  const shell = root.querySelector(".lab-production-shell");
  const orb = root.querySelector(".orb");
  const list = root.querySelector(".tablist");
  const cap = list?.querySelector(":scope > .item > .item-head-shell") ?? null;
  const panelChrome = root.querySelector(".panel-chrome");
  const panelSearch = panelChrome?.querySelector(".search-box") ?? null;
  const panelLead = root.querySelector(".panel-section-lead");
  const hero = root.querySelector(".hero");
  const sectionLead = root.querySelector(".section-lead");
  const local = root.querySelector(".section-local-sticky");
  const resolved = (node, pseudo) => node && typeof readStyle === "function"
    ? readStyle(node, pseudo)
    : null;
  const orbStyle = resolved(orb);
  const capStyle = resolved(cap);
  const capPatchStyle = resolved(cap, "::before");
  const stickyNode = compact ? panelChrome : hero;
  const stickyLead = compact ? panelLead : sectionLead;
  const stickyStyle = resolved(stickyNode);
  const leadStyle = resolved(stickyLead);
  const localStyle = resolved(local);
  const gradientActive = !contract.gradient || (
    hasGradient(stickyStyle) &&
    hasGradient(leadStyle) &&
    hasGradient(localStyle) &&
    hasGradient(capPatchStyle)
  );
  const atmosphereActive = contract.gradient
    ? styleValue(orbStyle, "display") === "block" &&
      styleValue(orbStyle, "position") === "fixed"
    : styleValue(orbStyle, "display") === "none";
  const anatomyActive = compact
    ? shell?.classList.contains("sidepanel-shell") &&
      directChild(panelChrome, panelSearch) && Boolean(panelLead && local)
    : shell?.classList.contains("app") && Boolean(hero && sectionLead && local);
  const stylesActive =
    atmosphereActive &&
    styleValue(stickyStyle, "position") === "sticky" &&
    styleValue(leadStyle, "position") === "sticky" &&
    styleValue(localStyle, "position") === "sticky" &&
    styleValue(capStyle, "position") === "sticky" &&
    styleValue(capPatchStyle, "position") === "absolute" &&
    gradientActive;
  return {
    surface: contract.surface,
    compact,
    anatomyActive,
    stylesActive,
    gradientActive,
    searchInsidePanelChrome: directChild(panelChrome, panelSearch),
    stickyShell: compact ? "panel-chrome" : "hero",
    stickyLead: compact ? "panel-section-lead" : "section-lead",
    ok: anatomyActive && stylesActive
  };
}
