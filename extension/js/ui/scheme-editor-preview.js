/** Complete production-anatomy specimen atlas for the dedicated scheme editor. */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createTabList } from "./tablist.js";

const roles = (direct = [], derived = []) => ({
  "data-scheme-roles": direct.join(" "),
  "data-scheme-derived": derived.join(" ")
});

function section(title, note, ...children) {
  return el("section", { class: "scheme-atlas-section" },
    el("header", { ...roles(["surface2", "border", "ink", "ink3"]) },
      el("div", {}, el("h2", {}, title), el("p", {}, note))),
    el("div", { class: "scheme-atlas-body" }, ...children));
}

function inertAction(id, label, options = {}) {
  return { id, label, run: () => {}, ...options };
}

function createListSpecimen() {
  const list = createTabList({
    section: "scheme-editor-preview",
    groups: [{
      id: "preview-window",
      title: "This window",
      meta: "4 tabs · current window",
      chips: ["work"],
      refs: [
        { url: "https://everytab.app", title: "EveryTab product planning", labels: ["work"] },
        { url: "https://developer.chrome.com/docs/extensions/", title: "Chrome Extensions reference", labels: ["reference"] },
        { url: "https://example.com/selected", title: "Selected tab with useful metadata", labels: ["research"] },
        { url: "https://example.com/long", title: "A deliberately long tab title that yields to its actions at narrow widths", labels: [] }
      ]
    }],
    selectable: "tab",
    foldable: true,
    onChipOpen: () => {},
    rowActions: [
      inertAction("star", "Star", { icon: "star" }),
      inertAction("label", "Label", { icon: "labels" }),
      inertAction("remove", "Remove", { danger: true, glyph: "×" })
    ],
    groupActions: [
      inertAction("save", "Save to Inbox", { shortLabel: "Inbox" }),
      inertAction("session", "Save as Session", { shortLabel: "Session" }),
      inertAction("close", "Close", { danger: true })
    ]
  });
  const rows = [...list.querySelectorAll("[data-tablist-row]")];
  rows[1]?.classList.add("lab-force-hover", "kbd-reveal");
  rows[2]?.classList.add("sel", "kbd-reveal");
  const star = rows[2]?.querySelector('[data-action-id="star"]');
  star?.classList.add("star-action", "is-starred");
  for (const node of list.querySelectorAll(".item-head-shell")) {
    Object.assign(node.dataset, { schemeRoles: "surface2 border ink ink3", schemeDerived: "workbenchMaterials" });
  }
  for (const node of list.querySelectorAll("[data-tablist-row]")) {
    Object.assign(node.dataset, { schemeRoles: "ink border", schemeDerived: "workbenchMaterials" });
  }
  for (const node of list.querySelectorAll(".item-meta, .tm, .tmeta")) {
    Object.assign(node.dataset, { schemeRoles: "ink3", schemeDerived: "workbenchMaterials" });
  }
  for (const node of list.querySelectorAll(".chip")) {
    Object.assign(node.dataset, { schemeRoles: "ink", schemeDerived: "accentSoft accentSoftInk workbenchMaterials" });
  }
  for (const node of list.querySelectorAll(".tacts")) {
    Object.assign(node.dataset, { schemeRoles: "ink border", schemeDerived: "accentSoft accentSoftInk workbenchMaterials" });
  }
  return list;
}

function navigationSpecimen() {
  return el("div", { class: "scheme-preview-navigation", ...roles(["surface2", "border"], ["sideBg"]) },
    el("div", { class: "scheme-preview-brand", ...roles(["ink"]) },
      icon("mark", 22), el("strong", {}, "EveryTab")),
    el("nav", { class: "nav", "aria-label": "Navigation preview" },
      el("button", { type: "button", class: "navitem active",
        ...roles(["accent", "accentInk"], ["accentSoft", "accentSoftInk"]) },
      icon("open", 15), el("span", { class: "navtext" }, "Open tabs"), el("span", { class: "n" }, "54")),
      el("button", { type: "button", class: "navitem", ...roles(["ink", "ink3"], ["navHover"]) },
        icon("inbox", 15), el("span", { class: "navtext" }, "Inbox"), el("span", { class: "n" }, "12")),
      el("button", { type: "button", class: "navitem", ...roles(["ink", "ink3"], ["navHover"]) },
        icon("sessions", 15), el("span", { class: "navtext" }, "Sessions"), el("span", { class: "n" }, "3")),
      el("button", { type: "button", class: "navitem", disabled: "", ...roles(["ink3"]) },
        icon("snapshots", 15), el("span", { class: "navtext" }, "Disabled"))),
    el("div", { class: "scheme-preview-vault", ...roles(["ink"], ["sideBg", "statusTints", "statusMarkerOutline"]) },
      el("span", { class: "scheme-status-dot is-ok", ...roles(["ok"], ["statusTints", "statusMarkerOutline"]) }),
      "Vault connected"));
}

function searchSpecimen() {
  return el("div", { class: "search-box scheme-preview-search-stack" },
    el("label", { class: "search-field scheme-preview-search is-focused",
      ...roles(["surface", "border", "ink", "accent"], ["focusAccent"]) },
      el("input", { class: "search-input", type: "text", value: "project",
        "aria-label": "Search preview", readonly: "" })),
    el("div", { class: "search-results scheme-preview-results", ...roles(["surface", "border"]) },
      el("div", { class: "search-option-list", role: "listbox", "aria-label": "Search results preview" },
        el("div", { class: "search-row selected", role: "option", "aria-selected": "true",
          ...roles(["ink", "ink3"], ["accentSoft", "accentSoftInk", "workbenchMaterials"]) },
        el("span", { class: "rtitle" }, "Project notes"),
        el("span", { class: "rmeta" }, "open · example.com"),
        el("span", { class: "rtype" }, "Switch")),
        el("div", { class: "search-row", role: "option", "aria-selected": "false",
          ...roles(["ink", "ink3"], ["workbenchMaterials"]) },
        el("span", { class: "rtitle" }, "Project session"),
        el("span", { class: "rmeta rmeta-count" }, "3 windows · 18 tabs"),
        el("span", { class: "rtype rtype-session-entity" }, "Restore")))));
}

function controlsSpecimen() {
  return el("div", { class: "scheme-preview-control-grid" },
    el("button", { type: "button", class: "primary", ...roles(["accent", "accentInk"]) }, "Primary action"),
    el("button", { type: "button", ...roles(["surface", "border", "ink"]) }, "Secondary"),
    el("button", { type: "button", class: "danger", ...roles(["danger", "ink"], ["statusTints"]) }, "Delete"),
    el("button", { type: "button", disabled: "", ...roles(["surface2", "border", "ink3"]) }, "Disabled"),
    el("button", { type: "button", class: "focus-demo", ...roles(["surface", "border", "ink", "accent"], ["focusAccent"]) }, "Keyboard focus"),
    el("span", { class: "scheme-preview-chip", ...roles(["ink"], ["accentSoft", "accentSoftInk"]) }, "Label chip"),
    el("a", { href: "#", onclick: (event) => event.preventDefault(), ...roles(["accentStrongInk"]) }, "Accent link"));
}

function statusSpecimen() {
  return el("div", { class: "scheme-preview-statuses" },
    el("div", { class: "ok", ...roles(["ink", "ok"], ["statusTints", "statusMarkerOutline"]) }, el("span", {}), el("strong", {}, "Synced"), el("small", {}, "Everything is up to date")),
    el("div", { class: "warn", ...roles(["ink", "warn"], ["statusTints", "statusMarkerOutline"]) }, el("span", {}), el("strong", {}, "Needs attention"), el("small", {}, "Review one saved item")),
    el("div", { class: "danger", ...roles(["ink", "danger"], ["statusTints", "statusMarkerOutline"]) }, el("span", {}), el("strong", {}, "Could not sync"), el("small", {}, "Your local data is safe")));
}

/** Build once; draft tokens are projected only onto this isolated root. */
export function createSchemeEditorPreview() {
  const root = el("div", {
    class: "scheme-editor-preview scheme-role-scope",
    "data-mode": "light",
    "data-gradient": "true"
  },
  el("span", { class: "orb o1", ...roles([], ["gradientAtmosphere", "gradientStops"]) }),
  el("span", { class: "orb o2", ...roles([], ["gradientAtmosphere", "gradientStops"]) }),
  el("div", { class: "scheme-preview-shell", ...roles(["bgSolid"], ["gradientAtmosphere"]) },
    navigationSpecimen(),
    el("main", { class: "scheme-preview-canvas" },
      el("div", { class: "scheme-preview-page-head", ...roles(["ink", "ink2", "accentStrongInk"]) },
        el("div", {}, el("p", {}, "Component atlas"), el("h1", {}, "See every color in context"),
          el("span", {}, "The preview scrolls independently. Your active EveryTab theme stays outside it.")),
        el("span", { class: "scheme-preview-mode-badge", ...roles(["surface2", "border", "ink"]) }, "Draft preview")),
      section("Search and commands", "Focus, results, selection, metadata, and actions.", searchSpecimen()),
      section("Open tabs", "Real shared window and row anatomy, including hover and selected states.", createListSpecimen()),
      section("Controls and labels", "Primary, secondary, danger, disabled, link, focus, and chip states.", controlsSpecimen()),
      section("Status and feedback", "Success, warning, and danger treatments on their real tints.", statusSpecimen()),
      section("Typography and surfaces", "Page, raised surface, body copy, muted copy, and code.",
        el("div", { class: "scheme-preview-type", ...roles(["surface", "border", "ink", "ink2", "ink3"]) },
          el("h3", {}, "A clear section heading"),
          el("p", {}, "Primary body copy remains calm and easy to scan."),
          el("small", {}, "Tertiary metadata · updated just now"),
          el("code", {}, "label:research"))))));
  return root;
}

export function highlightPreviewDependencies(root, dependencies) {
  const direct = new Set(dependencies.direct ?? []);
  const derived = new Set(dependencies.derived ?? []);
  let directCount = 0;
  let derivedCount = 0;
  for (const node of root.querySelectorAll("[data-scheme-roles], [data-scheme-derived]")) {
    node.classList.remove("scheme-highlight-direct", "scheme-highlight-derived");
    const owned = new Set((node.dataset.schemeRoles ?? "").split(/\s+/).filter(Boolean));
    const computed = new Set((node.dataset.schemeDerived ?? "").split(/\s+/).filter(Boolean));
    const isDirect = [...direct].some((role) => owned.has(role));
    const isDerived = !isDirect && (
      [...direct].some((role) => computed.has(role)) ||
      [...derived].some((role) => owned.has(role) || computed.has(role))
    );
    if (isDirect) {
      node.classList.add("scheme-highlight-direct");
      directCount++;
    } else if (isDerived) {
      node.classList.add("scheme-highlight-derived");
      derivedCount++;
    }
  }
  return { directCount, derivedCount };
}

export function clearPreviewHighlights(root) {
  for (const node of root.querySelectorAll(".scheme-highlight-direct, .scheme-highlight-derived")) {
    node.classList.remove("scheme-highlight-direct", "scheme-highlight-derived");
  }
}
