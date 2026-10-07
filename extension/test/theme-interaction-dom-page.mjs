import { createBrowserI18nMock } from "./i18n-browser-mock.mjs";

const resultNode = document.querySelector("#result");
const host = document.querySelector("#host");
const checks = [];
const runtimeErrors = [];
addEventListener("error", (event) => runtimeErrors.push(String(event.error?.stack ?? event.message)));
addEventListener("unhandledrejection", (event) =>
  runtimeErrors.push(String(event.reason?.stack ?? event.reason)));

function check(condition, name, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, name, timeout = 1500) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(5);
  }
  throw new Error(`Timed out: ${name}`);
}

const listeners = new Set();
const permissionAddedListeners = new Set();
const permissionRemovedListeners = new Set();
let historyPermission = false;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const lockTails = new Map();
const heldLocks = new Set();
let holdNextLock = false;
let releaseHeldLock = null;
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: {
    request: (name, options, callback) => {
      if (options?.ifAvailable) {
        if (heldLocks.has(name)) return Promise.resolve(callback(null));
        heldLocks.add(name);
        return Promise.resolve(callback({ name })).finally(() => heldLocks.delete(name));
      }
      const barrier = name === "everytab-store" && holdNextLock
        ? new Promise((resolve) => {
          holdNextLock = false;
          releaseHeldLock = resolve;
        })
        : Promise.resolve();
      const tail = lockTails.get(name) ?? Promise.resolve();
      const result = tail.then(() => barrier).then(() => callback({ name }));
      lockTails.set(name, result.catch(() => {}));
      return result;
    }
  }
});
const memory = {
  settings: {
    uiScheme: "frozenllama",
    uiMode: "scheme",
    uiGradient: false,
    uiQuickTheme: true,
    schemeFavorites: [],
    schemeRotate: "open",
    archiveWhitelist: ["https://legacy.example/workspace/"],
    suspendWhitelist: [
      "example.com",
      "page:https://permanent.example/article"
    ]
  },
  suspendTemporaryExemptions: {
    "https://temporary.example/read": Date.now() + 23 * 60 * 60_000
  },
  customSchemes: {}
};
const browserI18n = await createBrowserI18nMock();

function selected(keys) {
  if (keys == null) return clone(memory);
  if (typeof keys === "string") return memory[keys] === undefined ? {} : { [keys]: clone(memory[keys]) };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.filter((key) => memory[key] !== undefined)
      .map((key) => [key, clone(memory[key])]));
  }
  return Object.fromEntries(Object.entries(keys)
    .map(([key, fallback]) => [key, clone(memory[key] ?? fallback)]));
}

globalThis.chrome = {
  i18n: browserI18n,
  storage: {
    local: {
      get: async (keys) => selected(keys),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = clone(memory[key]);
          memory[key] = clone(value);
          changes[key] = { oldValue, newValue: clone(value) };
        }
        // Reproduce another EveryTab context briefly owning the shared store
        // immediately after this ordinary Settings save. The selected scheme
        // must paint without waiting for the separate On-open reservation.
        if (values.settings?.uiScheme === "ink") holdNextLock = true;
        queueMicrotask(() => {
          for (const listener of [...listeners]) listener(changes, "local");
        });
      },
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key];
      }
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  },
  permissions: {
    contains: async ({ permissions }) => !permissions?.includes("history") || historyPermission,
    request: async ({ permissions }) => {
      if (!permissions?.includes("history")) return false;
      historyPermission = true;
      for (const listener of permissionAddedListeners) listener({ permissions: ["history"] });
      return true;
    },
    remove: async ({ permissions }) => {
      if (!permissions?.includes("history")) return false;
      historyPermission = false;
      for (const listener of permissionRemovedListeners) listener({ permissions: ["history"] });
      return true;
    },
    onAdded: {
      addListener: (listener) => permissionAddedListeners.add(listener),
      removeListener: (listener) => permissionAddedListeners.delete(listener)
    },
    onRemoved: {
      addListener: (listener) => permissionRemovedListeners.add(listener),
      removeListener: (listener) => permissionRemovedListeners.delete(listener)
    }
  },
  commands: { getAll: async () => [] },
  tabs: { create: () => {} },
  runtime: { getURL: (path) => path }
};
Object.defineProperty(globalThis, "process", {
  configurable: true,
  value: { versions: { node: "browser-fixture" } }
});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

try {
  localStorage.clear();
  const [{ initTheme }, { mountSettingsForm }] = await Promise.all([
    import("../js/ui/theme.js"),
    import("../js/ui/settings-form.js")
  ]);
  initTheme();
  await waitFor(() => document.documentElement.dataset.scheme === "frozenllama",
    "initial stored scheme paints");
  check(getComputedStyle(document.documentElement).getPropertyValue("--bg-solid").trim() === "#39d8d3",
    "initial Frozen Llama token is active",
    getComputedStyle(document.documentElement).getPropertyValue("--bg-solid").trim());

  await mountSettingsForm(host, { listenStorage: false });
  check(host.querySelector(".theme-rotation-diagnostics") === null,
    "temporary theme rotation troubleshooting is absent from Appearance");
  const rowNamed = (name) => [...host.querySelectorAll(".setrow")]
    .find((row) => row.querySelector(".t")?.textContent === name);
  const appearanceRows = [...host.querySelector("#setg-appearance")
    .querySelectorAll(":scope > .setrow")];
  check(appearanceRows[0]?.querySelector(".t")?.textContent === "Interface style",
    "Interface style is the first Appearance decision");
  check(rowNamed("Color scheme") === undefined,
    "the duplicate native color-scheme dropdown is removed");
  const schemeButton = (id) => host.querySelector(
    `.scheme-favorite[data-scheme-id="${id}"] .scheme-apply`);
  const starButton = (id) => host.querySelector(
    `.scheme-favorite[data-scheme-id="${id}"] .scheme-star-toggle`);
  check(schemeButton("frozenllama")?.getAttribute("aria-pressed") === "true" &&
      schemeButton("frozenllama")?.closest(".scheme-favorite")?.classList.contains("is-current"),
    "the combined scheme grid shows the stored current scheme");
  const welcomeEnabled = rowNamed("Show welcome phrases")?.querySelector('input[type="checkbox"]');
  check(welcomeEnabled?.checked === true,
    "Minimal welcome phrases default on independently of their saved library");
  const welcomePhrases = rowNamed("Welcome phrases")?.querySelector("textarea");
  check(welcomePhrases && welcomePhrases.value === "",
    "Minimal welcome phrases start as an empty ordinary setting");
  welcomePhrases.value = "Welcome home\nMemento mori";
  welcomePhrases.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => memory.settings.newTabWelcomePhrases?.length === 2,
    "Settings saves the Minimal welcome phrase library");
  check(memory.settings.newTabWelcomePhrases.join("|") === "Welcome home|Memento mori",
    "the mounted newline editor preserves phrase order");
  welcomeEnabled.checked = false;
  welcomeEnabled.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => memory.settings.newTabWelcomeEnabled === false,
    "Settings saves the Minimal welcome visibility switch");
  check(memory.settings.newTabWelcomePhrases.join("|") === "Welcome home|Memento mori",
    "hiding welcome phrases preserves the saved phrase library");
  const welcomeTone = rowNamed("Phrase tone")?.querySelector("select");
  check(welcomeTone?.value === "clock",
    "Minimal phrase tone defaults to the quiet clock treatment");
  welcomeTone.value = "accent";
  welcomeTone.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => memory.settings.newTabWelcomeTone === "accent",
    "Settings saves the stronger Minimal phrase tone");
  const quadrantLabels = [...host.querySelectorAll(".scheme-category-label")]
    .map((node) => node.textContent);
  const expectedQuadrants = [
    "Light default · Soft", "Light default · Vivid",
    "Dark default · Soft", "Dark default · Vivid"
  ];
  check(JSON.stringify(quadrantLabels) === JSON.stringify(expectedQuadrants),
    "the combined scheme grid keeps the four useful portfolio groups",
    JSON.stringify({ quadrantLabels }));
  const neverSuspend = rowNamed("Protect from automatic actions")?.querySelector("textarea");
  const exceptionRows = [...rowNamed("Temporary domains and pages")
    ?.querySelectorAll(".suspend-page-exception-row") ?? []];
  check(neverSuspend?.value === "https://legacy.example/workspace/\nexample.com\nhttps://permanent.example/article" &&
      exceptionRows.length === 1 && exceptionRows[0]?.textContent.includes("left"),
    "Settings merges both historical lists into one automation-protection list",
    JSON.stringify({ value: neverSuspend?.value, exceptions: exceptionRows.map((row) => row.textContent) }));
  const temporaryRow = exceptionRows.find((row) =>
    row.textContent.includes("temporary.example"));
  temporaryRow?.querySelector("button")?.click();
  await waitFor(() => !memory.suspendTemporaryExemptions?.["https://temporary.example/read"],
    "temporary page exception is removed");
  check(rowNamed("Temporary domains and pages")
    ?.querySelectorAll(".suspend-page-exception-row").length === 0,
  "removing the temporary exception leaves no temporary rows");
  check(neverSuspend?.value.includes("https://permanent.example/article"),
    "removing a temporary exception leaves the permanent rule intact");
  neverSuspend.value = "https://legacy.example/workspace/\nexample.com\nhttps://new-permanent.example/article";
  neverSuspend.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => memory.settings.suspendWhitelist
    ?.includes("page:https://new-permanent.example/article"),
  "complete URL entered in the regular suspension list saves as an exact portable rule");
  check(!memory.settings.suspendWhitelist.includes("page:https://permanent.example/article") &&
      memory.settings.archiveWhitelist.includes("https://legacy.example/workspace/") &&
      !memory.settings.archiveWhitelist.includes("page:https://legacy.example/workspace/") &&
      memory.settings.archiveWhitelist.includes("page:https://new-permanent.example/article") &&
      JSON.stringify(memory.settings.archiveWhitelist) ===
        JSON.stringify(memory.settings.suspendWhitelist) &&
      neverSuspend.value.includes("https://new-permanent.example/article"),
    "editing the shared list preserves legacy broad URLs and writes both compatibility keys");
  const favoritesHelp = host.querySelector(".scheme-favorites .settings-hint");
  const helpHeight = favoritesHelp.getBoundingClientRect().height;
  starButton("frozenllama").click();
  await waitFor(() => memory.settings.schemeFavorites?.includes("frozenllama"),
    "first rotation favorite saves");
  check(favoritesHelp.textContent.startsWith("Favorites:") &&
      Math.abs(favoritesHelp.getBoundingClientRect().height - helpHeight) <= 0.5,
    "starring the first scheme keeps the explanation and layout stable");
  const historyRow = rowNamed("Use browser History");
  const historyAction = historyRow?.querySelector("button");
  await waitFor(() => historyAction?.textContent === "Allow", "History permission renders Off");
  check(historyRow?.textContent.includes("Processed locally and never sent to EveryTab"),
    "History permission explains its local processing boundary beside the action");
  historyAction.click();
  await waitFor(() => historyAction.textContent === "Turn off" && !historyAction.disabled,
    "History permission enables");
  check(historyRow.querySelector(".permission-state")?.textContent === "On",
    "History permission reports On after the direct grant");
  historyAction.click();
  await waitFor(() => historyAction.textContent === "Allow", "History permission revokes");
  check(historyRow.querySelector(".permission-state")?.textContent === "Off",
    "History permission reports Off after Turn off",
    historyRow.textContent);

  // Dashboard names are useful for Starred motion, but scheme changes must
  // capture them below the tour in the root snapshot, not above it as groups.
  const snapshotFixture = document.createElement("div");
  snapshotFixture.innerHTML = `
    <div class="starred-edge">Starred</div>
    <div class="daily-stage"><div class="sections">Open tabs</div></div>
    <div class="page-attention">Activity</div>
    <div class="theme-pop">Schemes</div>
    <div class="ob-overlay"><div class="ob-card" role="dialog" aria-modal="true">Appearance</div></div>`;
  document.body.append(snapshotFixture);
  const namedRegions = [".starred-edge", ".sections", ".page-attention"]
    .map((selector) => snapshotFixture.querySelector(selector));
  const regionNames = namedRegions.map((node) => getComputedStyle(node).viewTransitionName);
  check(regionNames.every((name) => name !== "none"),
    "snapshot fixture contains the real Dashboard transition names");
  document.documentElement.dataset.schemeTransition = "true";
  check(namedRegions.every((node) => getComputedStyle(node).viewTransitionName === "none"),
    "scheme changes keep Dashboard regions below the onboarding modal in the root snapshot");
  const fixturePicker = snapshotFixture.querySelector(".theme-pop");
  check(getComputedStyle(fixturePicker).viewTransitionName === "none",
    "a theme picker behind a modal is not lifted into its own snapshot");
  snapshotFixture.querySelector(".ob-overlay").remove();
  check(getComputedStyle(fixturePicker).viewTransitionName === "everytab-theme-picker",
    "without a modal the theme picker retains its stationary snapshot");
  delete document.documentElement.dataset.schemeTransition;
  check(namedRegions.every((node, index) => getComputedStyle(node).viewTransitionName === regionNames[index]),
    "Starred and Activity transition names return after the scheme change");
  snapshotFixture.remove();

  let sawSchemeTransition = false;
  const transitionObserver = new MutationObserver(() => {
    if (document.documentElement.dataset.schemeTransition === "true") sawSchemeTransition = true;
  });
  transitionObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-scheme-transition"]
  });
  schemeButton("ink").click();
  await waitFor(() => memory.settings.uiScheme === "ink", "Settings saves a selected scheme");
  await waitFor(() => document.documentElement.dataset.scheme === "ink",
    "live theme follows a selected scheme");
  if (typeof document.startViewTransition === "function") {
    await waitFor(() => sawSchemeTransition, "scheme change enters one whole-page transition");
    await waitFor(() => !document.documentElement.dataset.schemeTransition,
      "scheme transition settles without leaving a stale visual state");
  }
  transitionObserver.disconnect();
  check(typeof releaseHeldLock === "function",
    "fixture held only the follow-up On open reservation");
  releaseHeldLock();
  releaseHeldLock = null;
  await wait(80);
  check(memory.settings.uiScheme === "ink" && document.documentElement.dataset.scheme === "ink",
    "selected scheme remains authoritative after On open reservation settles",
    `${memory.settings.uiScheme}/${document.documentElement.dataset.scheme}`);
  check(memory.schemeRotationPrepared?.from === "ink",
    "On open reserves from the newly selected scheme",
    JSON.stringify(memory.schemeRotationPrepared));

  // Reproduce a user comparing schemes faster than asynchronous storage/theme
  // reconciliation can settle. The final click must win in Settings, the live
  // document, the pre-paint cache, and the next-open reservation.
  for (const choice of ["tide", "miaminights", "darling"]) {
    schemeButton(choice).click();
  }
  await waitFor(() => memory.settings.uiScheme === "darling", "rapid final selection saves");
  await waitFor(() => document.documentElement.dataset.scheme === "darling",
    "rapid final selection paints");
  await waitFor(() => memory.schemeRotationPrepared?.from === "darling",
    "rapid final selection reserves from the winner");
  const cached = JSON.parse(localStorage.getItem("tvTheme") || "null");
  check(cached?.selection === "darling",
    "rapid final selection owns the synchronous cache", JSON.stringify(cached));

  resultNode.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
  resultNode.dataset.status = "pass";
} catch (error) {
  resultNode.textContent = `FAIL: ${error?.stack ?? error}\nRUNTIME: ${runtimeErrors.join("\n")}`;
  resultNode.dataset.status = "fail";
}
