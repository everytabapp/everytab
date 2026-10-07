/** Computed-style coverage for the shared Soft/Crisp/Terminal style contract. */
const resultNode = document.querySelector("#result");
const fixtures = document.querySelector("#fixtures");
const params = new URLSearchParams(location.search);
const profile = ["soft", "crisp", "terminal"].includes(params.get("style"))
  ? params.get("style") : "soft";
document.documentElement.dataset.interfaceStyle = profile;

const read = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.text();
};
const inlineStyle = (html) => html.slice(
  html.indexOf("<style>") + "<style>".length,
  html.indexOf("</style>")
);
const sources = await Promise.all([
  read("../css/primitives.css"),
  read("../css/dashboard.css"),
  read("../css/tablist-d4.css"),
  read("../css/sidepanel.css"),
  read("../css/newtab.css"),
  read("../css/settings-schemes.css"),
  read("../css/scheme-editor.css"),
  read("../popup.html"),
  read("../options.html")
]);
const [primitives, dashboard, tablist, sidepanel, newtab, settingsSchemes,
  schemeEditor, popupHtml, settingsHtml] = sources;

function mount(name, css, markup) {
  const host = document.createElement("section");
  host.className = "surface-host";
  host.dataset.fixture = name;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>:host{display:block;min-width:0}*{box-sizing:border-box}${css}</style>${markup}`;
  fixtures.append(host);
  return shadow;
}

const dashboardRoot = mount("dashboard", `${primitives}\n${dashboard}\n${tablist}`, `
  <div class="content" data-workbench="true">
    <nav><button id="d-nav" class="navitem">Open</button></nav>
    <section class="hero"><div id="d-search" class="hero-panel">
      <div class="search-box"><div class="search-field"><input class="search-input"></div></div>
      <div id="d-results" class="hero-search-overlay"><div class="search-results">
        <button id="d-result-row" class="search-row selected">Result</button>
      </div></div>
    </div></section>
    <button id="d-button">Action</button>
    <div id="d-menu" class="tagmenu">Menu</div>
    <div class="tablist"><article class="item">
      <div class="item-head-shell"><header id="d-cap" class="item-head">Window</header></div>
      <div id="d-body" class="item-body-frame"><div id="d-row" class="trow sel">Tab</div></div>
    </article></div>
    <span id="d-chip" class="chip">Label</span>
    <div class="daily-stage"><div id="d-sections" class="sections"><section>Ledger</section></div></div>
    <aside id="d-star" class="starred-edge"><button class="starred-edge-toggle">Starred</button></aside>
  </div>`);

const popupRoot = mount("popup", `${primitives}\n${tablist}\n${inlineStyle(popupHtml)}`, `
  <div id="app">
    <div class="search-box"><div id="p-search" class="search-field"><input class="search-input"></div>
      <div id="p-results" class="search-results"><button id="p-result-row" class="search-row selected">Result</button></div>
    </div>
    <button id="p-button">Action</button>
    <div id="p-panel" class="panel">Panel</div>
    <div id="p-menu" class="tagmenu">Menu</div>
    <span id="p-chip" class="chip">Label</span>
    <div class="tabhead"><img id="p-favicon" class="fav" alt=""></div>
  </div>`);

const sidepanelRoot = mount("sidepanel", `${primitives}\n${sidepanel}\n${tablist}`, `
  <div data-surface="sidepanel" class="sidepanel-shell">
    <div id="s-menu" class="panel-menu"><button id="s-button" class="menu-item">Action</button></div>
    <div class="tablist" data-compact><article class="item">
      <div class="item-head-shell"><header id="s-cap" class="item-head">Window</header></div>
      <div id="s-body" class="item-body-frame"><div id="s-row" class="trow sel">Tab</div></div>
    </article></div>
  </div>`);

const minimalRoot = mount("minimal", `${primitives}\n${newtab}`, `
  <div class="minimal-horizon"><section id="m-card" class="minimal-deck">
    <div class="search-box"><div id="m-search" class="search-field"><input class="search-input"></div>
      <div id="m-results" class="search-results"><button id="m-result-row" class="search-row selected">Result</button></div>
    </div>
    <button id="m-button" class="minimal-launch"><span>Launcher</span></button>
    <img id="m-favicon" class="minimal-fav" alt="">
    <span id="m-chip" class="chip">Label</span>
  </section></div>`);

const settingsRoot = mount("settings", `${settingsSchemes}\n${inlineStyle(settingsHtml)}`, `
  <div id="app"><div class="settings-toolbar">
    <input id="o-field" class="settings-filter">
    <div class="settings-nav"><button id="o-chip" class="settings-nav-chip">Appearance</button></div>
  </div>
  <div id="o-card" class="scheme-favorites"><div id="o-choice" class="scheme-favorite">
    <button id="o-button" class="scheme-apply"><span id="o-swatch" class="scheme-swatch"></span><span>Ink</span></button>
    <button id="o-star-button" class="scheme-star-toggle"><span id="o-star" class="scheme-star">☆</span></button>
  </div></div>
  <select id="o-select"><option>Ink</option></select></div>`);

const editorRoot = mount("scheme-editor", `${primitives}\n${dashboard}\n${tablist}\n${schemeEditor}`, `
  <main class="scheme-editor-page">
    <section class="scheme-editor-inspector">
      <div class="scheme-editor-basics"><input id="e-field" value="#000000"></div>
      <div class="scheme-editor-segmented">
        <button id="e-first">Light</button><button id="e-last">Dark</button>
      </div>
      <button id="e-button" class="scheme-preview-control">Action</button>
      <span id="e-pill" class="scheme-preview-mode-badge">Light</span>
      <span id="e-dot" class="scheme-status-dot"></span>
    </section>
  </main>`);

const roots = { dashboardRoot, popupRoot, sidepanelRoot, minimalRoot, settingsRoot, editorRoot };
const expected = profile === "soft"
  ? { mini: 7, nav: 8, focus: 9, control: 12, search: 18, keeper: 13, panel: 14, card: 14 }
  : profile === "crisp"
    ? { mini: 3, nav: 3, focus: 2, control: 5, search: 4, keeper: 7, panel: 9, card: 10 }
    : { mini: 0, nav: 0, focus: 0, control: 0, search: 0, keeper: 0, panel: 0, card: 0 };
const checks = [];
const check = (condition, name, detail = "") => {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
};
const node = (root, selector) => roots[root].querySelector(selector);
const radius = (root, selector, property = "borderTopLeftRadius") => {
  const element = node(root, selector);
  const value = getComputedStyle(element)[property];
  return { value, number: Number.parseFloat(value) };
};
const expectRadius = (root, selector, value, property = "borderTopLeftRadius") => {
  const actual = radius(root, selector, property);
  check(Math.abs(actual.number - value) <= 0.1,
    `${root} ${selector} uses ${property}=${value}px in ${profile}`,
    actual.value);
};

await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/* Dashboard: one Search silhouette, navigation, controls, Float, and ledger exterior. */
expectRadius("dashboardRoot", "#d-search", expected.search);
expectRadius("dashboardRoot", "#d-results", expected.search, "borderBottomLeftRadius");
expectRadius("dashboardRoot", "#d-nav", expected.nav);
expectRadius("dashboardRoot", "#d-button", expected.control);
expectRadius("dashboardRoot", "#d-menu", expected.control);
expectRadius("dashboardRoot", "#d-cap", expected.panel);
expectRadius("dashboardRoot", "#d-body", expected.panel, "borderBottomLeftRadius");
expectRadius("dashboardRoot", "#d-row", 0);
expectRadius("dashboardRoot", "#d-result-row", 0);

/* Popup: closed/connected Search, ordinary actions, inline panel, and menu. */
expectRadius("popupRoot", "#p-search", expected.search);
expectRadius("popupRoot", "#p-results", expected.search, "borderBottomLeftRadius");
expectRadius("popupRoot", "#p-button", expected.control);
expectRadius("popupRoot", "#p-panel", expected.control);
expectRadius("popupRoot", "#p-menu", expected.control);
expectRadius("popupRoot", "#p-result-row", 0);

/* Side panel: compact actions and the connected cap/body ledger exterior. */
expectRadius("sidepanelRoot", "#s-menu", expected.panel);
expectRadius("sidepanelRoot", "#s-button", expected.control);
expectRadius("sidepanelRoot", "#s-cap", expected.panel);
expectRadius("sidepanelRoot", "#s-body", expected.panel, "borderBottomLeftRadius");
expectRadius("sidepanelRoot", "#s-row", 0);

/* Minimal: deck, Search, launcher, and square connected result band. */
expectRadius("minimalRoot", "#m-card", expected.panel);
expectRadius("minimalRoot", "#m-search", expected.search);
expectRadius("minimalRoot", "#m-results", expected.search, "borderBottomLeftRadius");
expectRadius("minimalRoot", "#m-button", expected.control);
expectRadius("minimalRoot", "#m-result-row", 0);

/* Settings and Scheme Editor consume the same field/control/card profiles. */
expectRadius("settingsRoot", "#o-field", expected.control);
expectRadius("settingsRoot", "#o-choice", expected.control);
expectRadius("settingsRoot", "#o-button", 0);
expectRadius("settingsRoot", "#o-star-button", 0);
expectRadius("settingsRoot", "#o-select", expected.control);
expectRadius("settingsRoot", "#o-card", expected.card);
expectRadius("editorRoot", "#e-field", expected.control);
expectRadius("editorRoot", "#e-button", expected.control);
expectRadius("editorRoot", "#e-first", expected.control);
expectRadius("editorRoot", "#e-last", expected.control, "borderTopRightRadius");
expectRadius("editorRoot", "#e-first", 0, "borderTopRightRadius");
expectRadius("editorRoot", "#e-last", 0, "borderTopLeftRadius");

/* Geometry that encodes meaning or source imagery remains invariant. */
for (const [root, selector] of [
  ["dashboardRoot", "#d-chip"], ["popupRoot", "#p-chip"],
  ["minimalRoot", "#m-chip"], ["settingsRoot", "#o-chip"],
  ["editorRoot", "#e-pill"]
]) {
  const actual = radius(root, selector).number;
  check(actual >= 99, `${root} ${selector} remains a semantic capsule`, String(actual));
}
check(radius("popupRoot", "#p-favicon").number === 4, "Popup favicon crop stays fixed");
check(radius("settingsRoot", "#o-swatch").value === "50%", "scheme swatch stays circular");
const schemeButtonRect = node("settingsRoot", "#o-star-button").getBoundingClientRect();
const schemeStarRect = node("settingsRoot", "#o-star").getBoundingClientRect();
check(Math.abs((schemeButtonRect.top + schemeButtonRect.height / 2) -
  (schemeStarRect.top + schemeStarRect.height / 2)) <= 1,
"scheme favorite star is centered on the control axis");
check(radius("editorRoot", "#e-dot").value === "50%", "status dot stays circular");
check(radius("minimalRoot", "#m-favicon").number === 7,
  "Minimal favicon keeps its fixed crop radius");

if (innerWidth === 800) {
  const sections = node("dashboardRoot", "#d-sections").getBoundingClientRect();
  const closedStar = node("dashboardRoot", "#d-star").getBoundingClientRect();
  check(sections.right <= closedStar.left + 1,
    "compact Dashboard reserves the closed Starred edge lane",
    JSON.stringify({ sectionsRight: sections.right, starLeft: closedStar.left }));
}
if (innerWidth >= 800) {
  node("dashboardRoot", "#d-star").classList.add("is-open");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const sections = node("dashboardRoot", "#d-sections").getBoundingClientRect();
  const openStar = node("dashboardRoot", "#d-star").getBoundingClientRect();
  check(sections.right <= openStar.left + 1,
    "open Starred yields real ledger space instead of covering it",
    JSON.stringify({ sectionsRight: sections.right, starLeft: openStar.left }));
}

const globalCheckbox = document.querySelector("#global-checkbox");
const uncheckedMark = getComputedStyle(globalCheckbox, "::after").content;
if (profile === "terminal") {
  check(Number.parseFloat(getComputedStyle(globalCheckbox).width) === 27,
    "Terminal reserves the bracket-selection lane");
  check(uncheckedMark.includes("[ ]"), "Terminal unchecked selection renders [ ]", uncheckedMark);
  globalCheckbox.checked = true;
  check(getComputedStyle(globalCheckbox, "::after").content.includes("[x]"),
    "Terminal checked selection renders [x]");
  check(getComputedStyle(globalCheckbox, "::after").clipPath === "none",
    "Terminal brackets are not clipped by the wide-row tick mask");
  check(getComputedStyle(document.body).fontFamily.includes("monospace"),
    "Terminal uses the native mono stack");
} else {
  const checkboxRadius = getComputedStyle(globalCheckbox).borderTopLeftRadius;
  check(profile === "soft" ? checkboxRadius === "50%" : Number.parseFloat(checkboxRadius) === 3,
    `${profile} owns checkbox geometry`, checkboxRadius);
  globalCheckbox.checked = true;
  const checkedMark = getComputedStyle(globalCheckbox, "::after");
  check(Number.parseFloat(checkedMark.width) === 15 && Number.parseFloat(checkedMark.height) === 15,
    `${profile} uses the complete centered checkmark`, `${checkedMark.width} × ${checkedMark.height}`);
  check(checkedMark.borderWidth === "0px" && checkedMark.transform === "none" &&
      checkedMark.clipPath === "none" && checkedMark.maskImage !== "none",
    `${profile} checkmark is not mixed with the legacy narrow tick`,
    JSON.stringify({ border: checkedMark.borderWidth, transform: checkedMark.transform,
      clipPath: checkedMark.clipPath, mask: checkedMark.maskImage }));
}

resultNode.dataset.status = "pass";
resultNode.textContent = `PASS: ${profile} ${innerWidth}px (${checks.length} computed checks)`;
