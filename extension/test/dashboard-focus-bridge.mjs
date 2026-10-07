import { installDomFixture } from "./dom-fixture.mjs";
import { readFileSync } from "node:fs";

const checks = [];
const check = (condition, name) => {
  if (!condition) throw new Error(name);
  checks.push(name);
};

const fixture = installDomFixture();
try {
  const { createDashboardFocusBridge } = await import("../js/ui/dashboard-focus-bridge.js");
  const sidebar = document.createElement("aside");
  const open = document.createElement("button");
  open.className = "navitem active";
  open.setAttribute("data-page", "open");
  const inbox = document.createElement("button");
  inbox.className = "navitem";
  inbox.setAttribute("data-page", "inbox");
  const settings = document.createElement("button");
  settings.className = "gear navitem";
  settings.setAttribute("data-page", "settings");
  sidebar.append(open, inbox, settings);
  const content = document.createElement("main");
  const first = document.createElement("button");
  const later = document.createElement("button");
  content.append(first, later);
  document.body.append(sidebar, content);

  let page = "open";
  let entered = null;
  const bridge = createDashboardFocusBridge({
    sidebar,
    content,
    getCurrentPage: () => page,
    activatePage: (next) => { page = next; },
    enterContent: () => { entered = first; first.focus(); },
    isContentLeftEdge: (target) => target === first || target === later
  });

  later.focus();
  await content.dispatch("keydown", { key: "ArrowLeft", target: later });
  check(document.activeElement === open, "Left enters the active sidebar item");
  await sidebar.dispatch("keydown", { key: "ArrowRight", target: open });
  check(document.activeElement === later, "Right returns to the exact prior content position");

  later.focus();
  await content.dispatch("keydown", { key: "ArrowLeft", target: later });
  await sidebar.dispatch("keydown", { key: "ArrowDown", target: open });
  check(document.activeElement === inbox, "Down roves through visible sidebar destinations");
  await sidebar.dispatch("keydown", { key: "ArrowRight", target: inbox });
  check(page === "open" && document.activeElement === later,
    "Right returns to the active section without activating a highlighted destination");

  await content.dispatch("keydown", { key: "ArrowLeft", target: later });
  await sidebar.dispatch("keydown", { key: "ArrowDown", target: open });
  await sidebar.dispatch("keydown", { key: "Enter", target: inbox });
  check(page === "inbox" && document.activeElement === first && entered === first,
    "entering another section resets content focus to its first position");

  page = "open";
  first.focus();
  await content.dispatch("keydown", { key: "ArrowLeft", target: first });
  await sidebar.dispatch("keydown", { key: "ArrowUp", target: open });
  check(document.activeElement === settings,
    "Up wraps from the first section to the bottom Settings destination");
  await sidebar.dispatch("keydown", { key: "Enter", target: settings });
  check(page === "settings" && document.activeElement === first,
    "Enter activates bottom Settings and resets content focus");

  page = "open";
  later.removeAttribute("hidden");
  later.focus();
  await content.dispatch("keydown", { key: "ArrowLeft", target: later });
  later.setAttribute("hidden", "");
  await sidebar.dispatch("keydown", { key: "ArrowRight", target: open });
  check(document.activeElement === first,
    "Right falls back to visible content when a retained Data-area target is hidden");

  bridge.destroy();
} finally {
  fixture.restore();
}

const dashboard = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const orderedCalls = (source) => [...source.matchAll(/nav(?:Btn|Group)\(\s*"([^"]+)"/g)]
  .map((match) => match[1]);
const between = (start, end) => dashboard.slice(dashboard.indexOf(start), dashboard.indexOf(end));
const replaceCall = (source, target) => {
  const start = source.indexOf(`${target}.replaceChildren(`);
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] !== ")") continue;
    depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return "";
};
const shell = between("function renderNavShell()", "async function readNavLibraryData()");
const shellMain = replaceCall(shell, "navMain");
const shellSaved = replaceCall(shell, "navLib");
const shellMore = replaceCall(shell, "navMore");
check(orderedCalls(shellMain).join() === "open,snooze,duplicates",
  "first-paint Now navigation is Open tabs, Snoozed, Duplicates");
check(orderedCalls(shellSaved).join() === "inbox,sessions,labels",
  "first-paint Saved navigation is Inbox, Sessions, Labels");
check(orderedCalls(shellMore).join() === "activity,archive,snapshots,data,stats",
  "first-paint More navigation keeps recovery and utility routes in the settled order");

const hydrated = between("function replaceNavLibrary(", "const renderNavLibrary");
check(orderedCalls(hydrated).join() === "sessions,labels" &&
  !hydrated.includes("replaceChildren"),
  "hydration replaces only the dynamic Sessions and Labels branches");
check(!dashboard.includes('navBtn("settings"') &&
  (dashboard.match(/"data-page": "settings"/g) ?? []).length === 1 &&
  dashboard.includes('class: "gear navitem"'),
  "Settings has one navigation destination in the persistent footer");

const hydrationFixture = installDomFixture();
let startupArrival;
try {
  const { createStartupArrival } = await import("../js/ui/startup-arrival.js");
  startupArrival = createStartupArrival();
  const updateSource = between("function updateNavCount(", "/**\n * Nav group:");
  const replaceSource = between("function replaceNavLibrary(", "const renderNavLibrary");
  const fixtureEl = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "class") node.className = value;
      else node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  };
  const button = (page) => fixtureEl("button", { class: "navitem", "data-page": page },
    fixtureEl("span", { class: "navtext" }, page));
  const branch = (page) => fixtureEl("div", { class: "navgroup" }, button(page));
  const navLib = fixtureEl("nav");
  const navMore = fixtureEl("nav");
  const replaceNavLibrary = new Function(
    "navLib", "navMore", "navGroup", "shellNavLabel", "sortLabelGroups", "el", "navName", "startupArrival", `
    let navLibrarySnapshot = null;
    ${updateSource}
    ${replaceSource}
    return replaceNavLibrary;
  `)(
    navLib,
    navMore,
    (_id, _icon, _label, page) => branch(page),
    (id) => id,
    (groups) => groups,
    fixtureEl,
    (label, count) => `${label}, ${count}`,
    startupArrival
  );
  const buttons = Object.fromEntries(
    ["inbox", "activity", "archive", "snapshots", "data", "stats"]
      .map((page) => [page, button(page)]));
  // The first hydration upgrades the shell's direct buttons; later hydrations
  // replace the expanded navgroup branches those first replacements created.
  navLib.append(buttons.inbox, button("sessions"), button("labels"));
  navMore.append(...["activity", "archive", "snapshots", "data", "stats"]
    .map((page) => buttons[page]));
  document.body.append(navLib, navMore);

  const hydrate = ({ inboxCount, archiveCount, snapshotCount }) =>
    replaceNavLibrary({
      inboxCount,
      archiveCount,
      snapshotCount,
      namedSessions: [],
      labelGroups: []
    });
  const inboxIdentity = buttons.inbox;
  const dataIdentity = buttons.data;
  inboxIdentity.setAttribute("aria-label", "inbox");
  inboxIdentity.dataset.tip = "inbox";
  hydrate({ archiveCount: 8, snapshotCount: 2 });
  check(!inboxIdentity.querySelector(".n") &&
    inboxIdentity.getAttribute("aria-label") === "inbox" &&
    inboxIdentity.dataset.tip === "inbox",
  "an early library-only hydration does not paint an undefined Inbox count");
  inboxIdentity.focus();
  hydrate({ inboxCount: 4, archiveCount: 9, snapshotCount: 3 });
  check(document.activeElement === inboxIdentity && inboxIdentity.isConnected,
    "library hydration preserves the focused Inbox button identity");
  check(inboxIdentity.querySelector(".n")?.textContent === "4" &&
    inboxIdentity.getAttribute("aria-label") === "inbox, 4" &&
    inboxIdentity.dataset.tip === "inbox, 4" &&
    buttons.archive.querySelector(".n")?.textContent === "9" &&
    buttons.snapshots.querySelector(".n")?.textContent === "3",
  "library hydration updates persistent counts and accessible names in place");

  dataIdentity.focus();
  hydrate({ inboxCount: 5, archiveCount: 10, snapshotCount: 4 });
  check(document.activeElement === dataIdentity && dataIdentity.isConnected,
    "repeated library hydration preserves the focused More destination identity");
  const route = (node) => node.dataset.page ?? node.querySelector("[data-page]")?.dataset.page;
  check(navLib.children.map(route).join() === "inbox,sessions,labels" &&
    navMore.children.map(route).join() === "activity,archive,snapshots,data,stats",
  "repeated hydration preserves Saved and More route order");
} finally {
  startupArrival?.destroy();
  hydrationFixture.restore();
}

console.log(`PASS ${checks.length}: ${checks.join(" | ")}`);
