import { createBrowserI18nMock } from "./browser-message-fixture.js";
import { DEFAULT_SETTINGS } from "../js/lib/types.js";

const result = document.querySelector("#result");
const opener = document.querySelector("#opener");
const checks = [];
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const initialSettings = {
  ...DEFAULT_SETTINGS,
  newTabMode: "dashboard",
  newTabFocus: "omnibox",
  uiScheme: "ink",
  uiMode: "scheme",
  uiInterfaceStyle: "soft",
  autoArchiveEnabled: false,
  suspendEnabled: false
};
const memory = {
  deviceId: "onboarding-browser-fixture",
  settings: initialSettings
};
const listeners = new Set();
const stage = (name) => { result.textContent = `RUNNING: ${name}`; };

function selected(keys) {
  if (keys == null) return clone(memory);
  if (typeof keys === "string") return memory[keys] === undefined ? {} : { [keys]: clone(memory[keys]) };
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => memory[key] !== undefined)
    .map((key) => [key, clone(memory[key])]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(memory[key] ?? fallback)]));
}

stage("catalogue");
const i18n = await createBrowserI18nMock();
globalThis.chrome = {
  i18n,
  storage: {
    local: {
      get: async (keys) => selected(keys),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: clone(memory[key]), newValue: clone(value) };
          memory[key] = clone(value);
        }
        queueMicrotask(() => listeners.forEach((listener) => listener(changes, "local")));
      },
      remove: async (keys) => {
        const changes = {};
        for (const key of [].concat(keys)) {
          if (!(key in memory)) continue;
          changes[key] = { oldValue: clone(memory[key]) };
          delete memory[key];
        }
        queueMicrotask(() => listeners.forEach((listener) => listener(changes, "local")));
      }
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  },
  runtime: { getURL: (path) => new URL(`../${path}`, import.meta.url).href }
};
Object.defineProperty(navigator, "locks", { configurable: true, value: {
  request: async (_name, options, callback) => {
    const run = typeof options === "function" ? options : callback;
    return run(options?.ifAvailable ? {} : {});
  }
} });
let pickerCalls = 0;
window.showDirectoryPicker = async () => {
  pickerCalls += 1;
  throw new DOMException("Fixture cancelled", "AbortError");
};

stage("storage authority");
Object.defineProperty(globalThis, "process", {
  configurable: true,
  value: { versions: { node: "browser-fixture" } }
});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

function check(condition, name, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
}
const wait = async (frames = 3) => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
  for (let frame = 0; frame < frames; frame += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};
const buttonNamed = (root, name) => [...root.querySelectorAll("button")]
  .find((button) => button.textContent.trim() === name);

async function checkDisclosureGeometry(overlay) {
  const bands = [".ob-card", ".ob-head", ".ob-progress-line", ".ob-save-status", ".ob-foot"];
  const measure = () => bands.map((selector) => {
    const { top, height } = overlay.querySelector(selector).getBoundingClientRect();
    return { selector, top, height };
  });
  const baseline = measure();
  for (const disclosure of overlay.querySelectorAll(".ob-body-host details")) {
    const summary = disclosure.querySelector("summary");
    for (let toggle = 0; toggle < 2; toggle++) {
      summary.click();
      await wait();
      const current = measure();
      check(current.every((rect, index) =>
        Math.abs(rect.top - baseline[index].top) < 0.5 &&
        Math.abs(rect.height - baseline[index].height) < 0.5),
      `tour bands stay fixed when toggling ${summary.textContent.trim()}`,
      JSON.stringify({ baseline, current }));
    }
  }
}

try {
  stage("import");
  const onboarding = await import("../js/ui/onboarding.js");
  const { getSettings } = await import("../js/lib/store.js");
  stage("show first run");
  await onboarding.showOnboarding();
  stage("first run mounted");
  await wait();
  let overlay = document.querySelector(".ob-overlay");
  check(overlay?.querySelectorAll(".ob-progress-step").length === 6,
    "first run presents exactly six progress steps");
  const firstTitle = overlay.querySelector(".ob-body h2")?.textContent;
  check(firstTitle === "Clear the tab clutter.",
    "first run opens on the approved purpose", firstTitle ?? "missing title");
  check(overlay.querySelectorAll(".ob-benefits li").length === 3 &&
    !overlay.querySelector(".ob-body input, .ob-body select, .ob-body button"),
  "Welcome explains outcomes without an exercise or fake control");
  check(overlay.scrollWidth <= overlay.clientWidth + 1,
    "first-run shell does not overflow the viewport");
  await checkDisclosureGeometry(overlay);

  overlay.querySelectorAll(".ob-progress-step")[1].click();
  stage("save and organize");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay.querySelector(".ob-body h2")?.textContent === "Save now. Sort later." &&
    overlay.querySelectorAll(".ob-definitions section").length === 3,
  "Save and organize introduces Inbox, Sessions, and Labels without an exercise");

  overlay.querySelectorAll(".ob-progress-step")[2].click();
  stage("automation");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  const automationRows = overlay.querySelectorAll(".ob-auto-row");
  await checkDisclosureGeometry(overlay);
  const autoSave = overlay.querySelector('[data-automation="save"]');
  const suspend = overlay.querySelector('[data-automation="suspend"]');
  check(overlay.querySelector(".ob-body h2")?.textContent === "Keep clutter from coming back." &&
    automationRows.length === 2 && !autoSave.checked && !suspend.checked,
  "Automation offers only Auto-save and Suspension and keeps the seeded choices");
  autoSave.click();
  suspend.click();
  await wait();
  let settings = await getSettings();
  check(settings.autoArchiveEnabled && settings.suspendEnabled &&
    overlay.querySelectorAll(".ob-auto-timing select:not([disabled])").length === 2,
  "both automatic choices persist in click order through the storage authority");
  const autoSaveTiming = overlay.querySelector('[data-timing="save"]');
  autoSaveTiming.focus();
  autoSaveTiming.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await wait(1);
  check(overlay.querySelector(".ob-body h2")?.textContent === "Keep clutter from coming back.",
    "tour arrow navigation never steals an interactive control's arrow keys");

  overlay.querySelectorAll(".ob-progress-step")[3].click();
  stage("new tab choices");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  const layoutRadios = overlay.querySelectorAll(".new-tab-layout-choice input[type=radio]");
  await checkDisclosureGeometry(overlay);
  const dashboard = overlay.querySelector('input[value="dashboard"]');
  const minimal = overlay.querySelector('input[value="minimal"]');
  const blank = overlay.querySelector('input[value="blank"]');
  const omnibox = overlay.querySelector('input[value="omnibox"]');
  const search = overlay.querySelector('input[value="search"]');
  const focusChoices = overlay.querySelector(".new-tab-focus-section");
  check(overlay.querySelector(".ob-body h2")?.textContent === "Choose your new tab" &&
    layoutRadios.length === 3 && dashboard.checked && omnibox.checked,
  "New Tab starts from the stored Dashboard and address-bar preferences");
  search.click();
  await wait();
  blank.click();
  await wait();
  settings = await getSettings();
  check(settings.newTabMode === "blank" && settings.newTabFocus === "search" &&
    focusChoices.hidden && search.checked,
  "Blank hides but does not overwrite the stored Search focus preference");
  minimal.click();
  await wait();
  settings = await getSettings();
  check(settings.newTabMode === "minimal" && settings.newTabFocus === "search" &&
    !focusChoices.hidden && search.checked,
  "leaving Blank restores the preserved focus choice");

  overlay.querySelectorAll(".ob-progress-step")[4].click();
  stage("appearance");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  const schemeTiles = overlay.querySelectorAll(".ob-palette");
  await checkDisclosureGeometry(overlay);
  const schemeSwatches = overlay.querySelectorAll(".ob-palette-swatches.scheme-role-scope[data-scheme]");
  const schemeDefault = overlay.querySelector('[data-preference="uiMode"][data-value="scheme"]');
  const styleButtons = overlay.querySelectorAll('[data-preference="uiInterfaceStyle"]');
  const crisp = overlay.querySelector('[data-preference="uiInterfaceStyle"][data-value="crisp"]');
  check(overlay.querySelector(".ob-body h2")?.textContent === "Make yourself at home." &&
    schemeTiles.length === 36 && schemeSwatches.length === 36 &&
    [...schemeSwatches].every((swatch) => ["light", "dark"].includes(swatch.dataset.mode)) &&
    overlay.querySelectorAll('[data-preference="uiMode"]').length === 4 &&
    styleButtons.length === 3 && schemeDefault.getAttribute("aria-pressed") === "true",
  "Appearance offers every scheme plus the complete appearance and style choices");
  check(getComputedStyle(crisp).borderRadius === "5px",
    "Crisp previews its five-pixel geometry before it is selected",
    getComputedStyle(crisp).borderRadius);
  crisp.click();
  overlay.querySelector('[data-scheme-choice="miaminights"]')?.click();
  await wait();
  settings = await getSettings();
  check(settings.uiScheme === "miaminights" && settings.uiInterfaceStyle === "crisp" &&
    overlay.querySelector('[data-scheme-choice="miaminights"]')?.getAttribute("aria-pressed") === "true" &&
    crisp.getAttribute("aria-pressed") === "true",
  "rapid scheme and Interface-style choices both persist and remain selected");

  overlay.querySelectorAll(".ob-progress-step")[5].click();
  stage("optional Vault");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay.querySelector(".ob-body h2")?.textContent === "Your data stays yours." &&
    buttonNamed(overlay.querySelector(".ob-foot"), "Finish")?.classList.contains("primary") &&
    !buttonNamed(overlay.querySelector(".ob-foot"), "Finish")?.hidden,
  "Vault is the last optional step, with an accented footer Finish and no review screen");
  buttonNamed(overlay, "Choose a Vault folder")?.click();
  await wait();
  check(pickerCalls === 1 && overlay.querySelector(".ob-vault-status")?.textContent === "No folder was changed." &&
    document.querySelector(".ob-overlay"),
  "cancelling the native folder picker leaves onboarding open with honest status");
  buttonNamed(overlay.querySelector(".ob-foot"), "Finish")?.click();
  await wait();
  check(memory.onboardingDone === true && !("onboardingPage" in memory) &&
    !document.querySelector(".ob-overlay"),
  "Finish consumes the resume key and completes onboarding");
  await onboarding.maybeShowOnboarding();
  check(!document.querySelector(".ob-overlay"),
    "completed profiles are never forced through first run again");
  settings = await getSettings();
  check(settings.newTabMode === "minimal" && settings.newTabFocus === "search" &&
    settings.uiScheme === "miaminights" && settings.uiInterfaceStyle === "crisp",
  "completion preserves every preference chosen on earlier steps");

  memory.onboardingDone = true;
  memory.onboardingPage = "data";
  stage("replay intro");
  await onboarding.replayOnboarding();
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay?.querySelector(".ob-body h2")?.textContent === "Clear the tab clutter.",
    "Replay intro opens the first step immediately");
  check(memory.onboardingPage === "local",
    "Replay intro replaces stale resume progress with the first step");
  buttonNamed(overlay, "Skip intro")?.click();
  await wait(1);
  check(!document.querySelector(".ob-overlay"),
    "the replayed intro retains the ordinary close path");

  opener.focus();
  stage("help");
  onboarding.openHelp("labels");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  const topicButtons = overlay.querySelectorAll(".ob-help-topic");
  const topicSelect = overlay.querySelector(".ob-help-select");
  check(topicButtons.length === 14 && topicSelect.options.length === 14 &&
    overlay.querySelector(".ob-help-body h2")?.textContent === "Labels and groups",
  "permanent Help opens the exact requested topic in its complete library");
  check(overlay.querySelectorAll(".ob-help-group").length === 4 && topicSelect.querySelectorAll("optgroup").length === 4,
    "Help groups topics by user goal at wide and narrow widths");
  check([...overlay.querySelectorAll(".ob-terms dt")].map((node) => node.textContent).join("|") ===
    "Label groups|Group views" && !overlay.querySelector(".ob-how"),
  "concept Help uses a compact reference instead of a mechanical three-bullet list");
  const narrow = innerWidth <= 560;
  check(narrow
    ? getComputedStyle(topicSelect).display !== "none" && getComputedStyle(overlay.querySelector(".ob-help-nav")).display === "none"
    : getComputedStyle(topicSelect).display === "none" && getComputedStyle(overlay.querySelector(".ob-help-nav")).display !== "none",
  "Help uses the compact topic selector only at narrow width");
  topicSelect.value = "automation";
  topicSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(1);
  check(overlay.querySelector(".ob-help-body h2")?.textContent === "Automation",
    "compact Help selection changes the visible topic");
  check(overlay.querySelectorAll(".ob-terms dt").length === 4 &&
    overlay.querySelectorAll(".ob-how li").length === 0,
  "Automation is a four-term reference rather than generic feature bullets");
  const settingsLinks = [...overlay.querySelectorAll(".ob-help-link")];
  check(settingsLinks.length === 4 &&
    settingsLinks.map((link) => new URL(link.href).hash).join("|") ===
      "#settings:autosave|#settings:suspension|#settings:sessions|#settings:duplicates",
  "Help links each referenced automation area to its exact Settings section");
  topicSelect.value = "close-day";
  topicSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(1);
  overlay = document.querySelector(".ob-overlay");
  check(overlay.querySelectorAll(".ob-steps li").length === 3 &&
    overlay.querySelectorAll(".ob-how li").length === 0,
  "Close the day uses ordered steps because its order matters");
  topicSelect.value = "open";
  topicSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(1);
  check(overlay.querySelectorAll(".ob-how li").length === 4 &&
    [...overlay.querySelectorAll(".ob-how li")].some((node) => node.textContent.includes("Organize")),
  "Open Tabs Help covers filtering, selection, exact drag placement, and Organize");
  overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(1);
  check(!document.querySelector(".ob-overlay") && document.activeElement === opener,
    "Escape closes Help and restores focus to its opener");

  result.dataset.status = "pass";
  result.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack ?? error}`;
}
