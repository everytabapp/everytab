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
    schemeRotate: "open"
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
  const scheme = rowNamed("Color scheme")?.querySelector("select");
  check(scheme?.value === "frozenllama", "Settings reflects the stored scheme");
  const quadrantLabels = [...host.querySelectorAll(".scheme-category-label")]
    .map((node) => node.textContent);
  const selectGroups = [...scheme.querySelectorAll("optgroup")].map((node) => node.label);
  const expectedQuadrants = [
    "Light default · Soft", "Light default · Vivid",
    "Dark default · Soft", "Dark default · Vivid"
  ];
  check(JSON.stringify(quadrantLabels) === JSON.stringify(expectedQuadrants) &&
      JSON.stringify(selectGroups) === JSON.stringify(expectedQuadrants),
    "the mounted native selector and favorites share the four scheme quadrants",
    JSON.stringify({ quadrantLabels, selectGroups }));
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

  scheme.value = "ink";
  scheme.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => memory.settings.uiScheme === "ink", "Settings saves a selected scheme");
  await waitFor(() => document.documentElement.dataset.scheme === "ink",
    "live theme follows a selected scheme");
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
    scheme.value = choice;
    scheme.dispatchEvent(new Event("change", { bubbles: true }));
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
