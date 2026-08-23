import { createBrowserI18nMock } from "./browser-message-fixture.js";

const result = document.querySelector("#result");
const opener = document.querySelector("#opener");
const checks = [];
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const memory = {};
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
  request: async (_name, options, callback) => callback(options?.ifAvailable ? {} : {})
} });

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

try {
  stage("import");
  const onboarding = await import("../js/ui/onboarding.js");
  stage("show first run");
  await onboarding.showOnboarding();
  stage("first run mounted");
  await wait();
  let overlay = document.querySelector(".ob-overlay");
  check(overlay?.querySelectorAll(".ob-progress-step").length === 6,
    "first run presents exactly six progress steps");
  const firstTitle = overlay.querySelector(".ob-body h2")?.textContent;
  check(firstTitle === "Every tab, kept, organized, local.",
    "first run opens on the settled trust outcome", firstTitle ?? "missing title");
  check(overlay.querySelectorAll(".ob-terms dt").length === 3 &&
    overlay.querySelector(".ob-terms")?.textContent.includes("Focus"),
  "the opening step plants a compact map of the complete product");
  check(overlay.scrollWidth <= overlay.clientWidth + 1,
    "first-run shell does not overflow the viewport");

  overlay.querySelectorAll(".ob-progress-step")[1].click();
  stage("new tab choice");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay.querySelector(".ob-body h2")?.textContent === "Choose your new tab",
    "progress navigation opens the requested first-run step");
  check(overlay.querySelector('[data-mode="dashboard"]')?.getAttribute("aria-pressed") === "true",
    "fresh first run selects Dashboard by default");
  overlay.querySelector('[data-mode="minimal"]')?.click();
  await wait();
  check(memory.settings?.newTabMode === "minimal" &&
    overlay.querySelector('[data-mode="minimal"]')?.getAttribute("aria-pressed") === "true",
  "new-tab choice persists through the real shared Settings store",
  `${memory.settings?.newTabMode ?? "missing"}/${overlay.querySelector('[data-mode="minimal"]')?.getAttribute("aria-pressed")}`);

  overlay.querySelectorAll(".ob-progress-step")[2].click();
  stage("automation");
  await wait(5);
  overlay = document.querySelector(".ob-overlay");
  const tune = overlay.querySelector("details.ob-tune");
  check(tune && !tune.open && overlay.querySelectorAll(".ob-threshold-row").length === 8,
    "Tune automation is collapsed and contains all eight approved shared thresholds");
  const automationLink = overlay.querySelector(".ob-more-settings");
  check(automationLink?.textContent === "Review all automation settings" && !tune.contains(automationLink),
    "the complete automation control stays visible while thresholds are collapsed");
  check(automationLink.tagName === "BUTTON" && !automationLink.hasAttribute("href"),
    "Review automation stays inside the introduction instead of navigating away");
  automationLink.click();
  await wait(1);
  check(tune.open && !automationLink.isConnected,
    "Review automation unfolds the shared thresholds and consumes the one-use action");
  const maxTabs = [...tune.querySelectorAll('input[type="number"]')]
    .find((input) => input.getAttribute("aria-label") === "Keep at most N tabs open");
  maxTabs.value = "75";
  maxTabs.dispatchEvent(new Event("change", { bubbles: true }));
  await wait();
  check(memory.settings?.autoSaveMaxTabs === 75,
    "onboarding threshold writes the same setting as Settings");
  maxTabs.focus();
  maxTabs.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await wait(1);
  check(overlay.querySelector(".ob-body h2")?.textContent === "Save now. Sort later.",
    "tour arrow navigation never steals an interactive control's arrow keys");

  overlay.querySelectorAll(".ob-progress-step")[4].click();
  stage("scheme");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay.querySelector(".ob-body h2")?.textContent === "Choose your colors" &&
    overlay.querySelectorAll(".ob-scheme-choice").length === 36 &&
    overlay.querySelectorAll(".ob-scheme-group").length === 4,
  "the color step offers every built-in through the shared four-quadrant model");
  const schemeChoice = overlay.querySelector(".ob-scheme-choice");
  const schemeSwatch = schemeChoice?.querySelector(".ob-scheme-swatch");
  const choiceRect = schemeChoice?.getBoundingClientRect();
  const swatchRect = schemeSwatch?.getBoundingClientRect();
  check(choiceRect && swatchRect &&
    Math.abs((choiceRect.top + choiceRect.height / 2) - (swatchRect.top + swatchRect.height / 2)) <= 1,
  "the color dot is vertically centered in every introductory scheme choice",
  JSON.stringify({ choice: choiceRect ? [choiceRect.top, choiceRect.height] : null,
    swatch: swatchRect ? [swatchRect.top, swatchRect.height] : null }));
  overlay.querySelector('[data-scheme="miaminights"]')?.click();
  await wait();
  check(memory.settings?.uiScheme === "miaminights" &&
    overlay.querySelector('[data-scheme="miaminights"]')?.getAttribute("aria-pressed") === "true",
  "a first-run color choice persists and becomes the selected scheme immediately");

  overlay.querySelectorAll(".ob-progress-step")[5].click();
  stage("finish");
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(buttonNamed(overlay.querySelector(".ob-foot"), "Explore full Help") &&
    !buttonNamed(overlay.querySelector(".ob-foot"), "Explore full Help").hidden,
  "the final step offers a direct route into full Help");
  const settingsLink = overlay.querySelector(".ob-final-settings .ob-more-settings");
  check(settingsLink?.textContent === "Open Settings" && settingsLink.href.endsWith("dashboard.html#settings"),
    "the final step reminds users that every choice remains editable in Settings");
  buttonNamed(overlay, "Later")?.click();
  buttonNamed(overlay.querySelector(".ob-foot"), "Finish")?.click();
  await wait();
  check(memory.onboardingDone === true && !("onboardingPage" in memory) &&
    !document.querySelector(".ob-overlay"),
  "Finish consumes the resume key and marks first run complete");
  await onboarding.maybeShowOnboarding();
  check(!document.querySelector(".ob-overlay"),
    "completed profiles are never forced through first run again");

  memory.onboardingDone = true;
  memory.onboardingPage = "data";
  stage("replay intro");
  await onboarding.replayOnboarding();
  await wait();
  overlay = document.querySelector(".ob-overlay");
  check(overlay?.querySelector(".ob-body h2")?.textContent === "Every tab, kept, organized, local.",
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
