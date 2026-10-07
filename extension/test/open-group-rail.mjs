import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://everytab/${path}` },
  i18n: createChromeI18nMock(),
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {}, removeListener() {} }
  }
};
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

try {
  const { fromOpenWindows, createTabList } = await import("../js/ui/tablist.js");
  const { buildOpenListConfig } = await import("../js/ui/list-configs.js");
  const details = new Map([
    [12, { title: "Launch research", color: "blue" }],
    [19, { title: "", color: "yellow" }]
  ]);
  const [group] = fromOpenWindows([{ id: 7, focused: true, tabs: [
    { id: 101, windowId: 7, index: 0, url: "https://one.test", title: "One", groupId: 12 },
    { id: 102, windowId: 7, index: 1, url: "https://two.test", title: "Two", groupId: 12 },
    { id: 103, windowId: 7, index: 2, url: "https://loose.test", title: "Loose", groupId: -1 },
    { id: 104, windowId: 7, index: 3, url: "https://three.test", title: "Three", groupId: 19 }
  ] }], null, 7, null, null, null, details);

  if (group.live[0].tabGroup?.title !== "Launch research" ||
      group.live[0].tabGroup?.color !== "blue" ||
      group.live[2].tabGroup !== undefined ||
      group.live[3].tabGroup?.color !== "yellow") {
    throw new Error("Open projection did not preserve live group identity and optional metadata");
  }

  const common = {
    data: {
      groups: [group], bindings: {}, sessionsById: new Map(), simpleWindows: [],
      groupsUnpreserved: true, currentWindowId: 7, browserWindowCount: 1
    },
    rowCap: 50, initialRowBudget: 300,
    msg: async () => ({}), renderOpen: () => {}, renderArchive: () => {}, renderLabels: () => {},
    goToLabel: () => {}, goToSession: () => {}, mark: (node) => node,
    cardLabelPanel: () => document.createElement("div"),
    buildOpenSnooze: () => document.createElement("div"),
    buildProtectionPanel: () => document.createElement("div"),
    idleNudge: null,
    sessionComboboxButton: (label) => {
      const button = document.createElement("button"); button.textContent = label; return button;
    },
    copyRefs: () => {}, buildOrganizePanel: () => document.createElement("div"),
    driftBanner: () => null,
    groupAccessAction: (candidate, unpreserved) => {
      if (!unpreserved || candidate.named) return null;
      const button = document.createElement("button");
      button.className = "open-tab-group-access";
      button.textContent = "Show group names";
      return button;
    },
    openRowDrag: {}, newWindowZone: () => null, endWindowZone: () => null,
    flashNote: () => {}, showNotice: () => {}
  };
  const dashboardConfig = buildOpenListConfig(common);
  const compactConfig = buildOpenListConfig({ ...common, presentation: "compact" });
  if (typeof dashboardConfig.rowGroup !== "function" || compactConfig.rowGroup !== null) {
    throw new Error("Live group hierarchy must be Dashboard-only");
  }

  const root = createTabList(dashboardConfig);
  const headers = [...root.querySelectorAll(".open-tab-group-head")];
  if (headers.length !== 2 || !headers[0].textContent.includes("Tab group: Launch research") ||
      !headers[0].textContent.includes("2 tabs") || !headers[1].textContent.includes("Tab group")) {
    throw new Error(`Unexpected group headers: ${headers.map((node) => node.textContent).join(" | ")}`);
  }
  if (headers[0].querySelector("button, input, a") ||
      headers[1].querySelectorAll(".open-tab-group-access").length !== 1) {
    throw new Error("Only an unnamed group may carry its contextual group-access action");
  }
  if (headers.some((header) => header.querySelector(".open-tab-group-dot, .open-tab-group-rule"))) {
    throw new Error("Live group headers must not carry a color dot or horizontal rule");
  }
  const blueRows = root.querySelectorAll('[data-live-tab-group="12"].trow');
  const looseRow = root.querySelector('[data-tablist-row="t103"]');
  if (blueRows.length !== 2 || looseRow?.getAttribute("data-live-tab-group") != null) {
    throw new Error("The rail did not stay scoped to the grouped tabs");
  }

  const css = readFileSync(new URL("../css/tablist-d4.css", import.meta.url), "utf8");
  const openSurface = readFileSync(new URL("../js/ui/open-surface.js", import.meta.url), "utf8");
  if (!css.includes("background: var(--accent)") ||
      !css.includes("inset-inline-end: 8px") ||
      css.includes('[data-tab-group-color="blue"]') ||
      css.includes("--live-tab-group-edge") ||
      /open-tab-group[^{}]*\{[^}]*border-(?:left|right)\s*:\s*[2-9]/s.test(css)) {
    throw new Error("The rail must be a single theme accent in the right edge lane");
  }
  if (!openSurface.includes('localeMessage("list_show_group_names")') ||
      !/function groupAccessAction\([\s\S]*const granted = await ensureTabGroupsPermission\(\);[\s\S]*if \(!granted\)[\s\S]*return;[\s\S]*patchSettings\(\{ preserveTabGroups: true \}\)/.test(openSurface)) {
    throw new Error("The in-row group-name permission action must stay explicit and retryable after denial");
  }

  console.log("PASS: Dashboard Open groups use aligned accent rails and contextual group access");
} finally {
  fixture.restore();
}
