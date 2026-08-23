import { DEFAULT_SETTINGS } from "../js/lib/types.js";
import { createBrowserI18nMock } from "./i18n-browser-mock.mjs";

// Headless file pages may throttle rAF indefinitely. Keep the production seam
// (frame then task) deterministic while exercising the real DOM component.
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0);

const resultNode = document.querySelector("#result");
const host = document.querySelector("#host");
const checks = [];

function check(condition, name) {
  if (!condition) throw new Error(name);
  checks.push(name);
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, name, timeout = 1000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(5);
  }
  throw new Error(`Timed out: ${name}`);
}

function summary(token = "risk-1") {
  return {
    exportVersion: 2,
    legacy: false,
    exportedAt: "2026-08-10T10:00:00.000Z",
    sourceHash: "hash128:test",
    records: { incoming: 2, added: 1, updated: 1, keptIncoming: 0, localOnly: 0 },
    labelMeta: { incoming: 0, advanced: 0, existingAdvanced: 0 },
    settings: { available: true, enabled: true, changed: true, count: 3 },
    changed: true,
    requiresConfirmation: true,
    confirmationToken: token
  };
}

let panel = null;
let previewCalls = 0;
let restoreCalls = 0;
let scheduledArm = null;
let scheduledArmDelay = null;
let failCheckpointExport = false;
const downloads = [];
const changes = [];
let browserI18n = null;
let settingsState = { ...DEFAULT_SETTINGS, uiScheme: "cream", newTabMode: "dashboard" };
const storageListeners = new Set();
const chromeFixture = (i18n) => ({
  i18n,
  storage: {
    local: {
      get: async (keys) => {
        const all = { settings: structuredClone(settingsState) };
        if (typeof keys === "string") return keys in all ? { [keys]: all[keys] } : {};
        return Object.fromEntries((keys ?? []).filter((key) => key in all)
          .map((key) => [key, all[key]]));
      },
      set: async () => {},
      remove: async () => {}
    },
    onChanged: {
      addListener: (listener) => storageListeners.add(listener),
      removeListener: (listener) => storageListeners.delete(listener)
    }
  },
  permissions: { contains: async () => false, request: async () => false },
  commands: { getAll: async () => [] },
  tabs: { create: () => {} },
  runtime: { getURL: (path) => path }
});
const effects = {
  readFile: (file) => file.text(),
  preview: async () => {
    previewCalls++;
    const loading = panel.querySelector(".loading-feedback");
    const status = panel.querySelector('[role="status"]');
    check(Boolean(loading) && loading.parentNode?.getAttribute("aria-busy") === "true",
      "Loading is staged before synchronous Restore validation");
    check(getComputedStyle(loading).opacity === "0",
      "fast Restore validation keeps the real Loading visual inside its CSS reveal delay");
    check(status?.textContent === "Checking the whole backup…" && status.getAttribute("aria-live") === "polite",
      "Restore validation retains immediate polite screen-reader status");
    return summary(`risk-${previewCalls}`);
  },
  restore: async (_text, options) => {
    restoreCalls++;
    if (restoreCalls === 1) {
      check(options.confirmationToken === "risk-2", "commit sends the preview confirmation token");
      return { status: "confirmation-required", checkpointId: null, journalEntry: null,
        summary: summary("risk-fresh") };
    }
    check(options.confirmationToken === "risk-fresh",
      "commit-time reconfirmation sends the fresh destructive-plan token");
    return {
      status: "restored", checkpointId: `checkpoint-${restoreCalls}`,
      journalEntry: { id: `journal-${restoreCalls}` }, summary: summary("risk-fresh")
    };
  },
  undo: async (checkpointId) => checkpointId === "checkpoint-2"
    ? { status: "undone", checkpointId, staleKeys: [], checkpointAvailable: false }
    : { status: "stale", checkpointId, staleKeys: ["inbox"], checkpointAvailable: true },
  checkpointExport: async () => {
    if (failCheckpointExport) throw new Error("fixture failure");
    return "{\"recovery\":true}";
  },
  readCheckpoint: async () => null
};

try {
  browserI18n = await createBrowserI18nMock();
  const chromeMock = chromeFixture(browserI18n);
  try { Object.defineProperty(globalThis, "chrome", { value: chromeMock, configurable: true }); }
  catch { Object.assign(globalThis.chrome, chromeMock); }
  const { createRestorePanel } = await import("../js/ui/restore-panel.js");
  panel = createRestorePanel({
    download: (...args) => downloads.push(args),
    onChange: () => changes.push("changed"),
    effects,
    armTimeoutMs: 4000,
    scheduleArm: (callback, delay) => {
      scheduledArm = callback;
      scheduledArmDelay = delay;
      return callback;
    },
    cancelArm: (handle) => {
      if (scheduledArm === handle) scheduledArm = null;
    }
  });
  host.append(panel);

  const choose = panel.querySelector('[data-restore-focus-id="choose-backup"]');
  const input = panel.querySelector('input[type="file"]');
  let delegatedChoose = false;
  input.addEventListener("click", () => { delegatedChoose = true; });
  input.click = () => input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  choose.click();
  check(delegatedChoose, "Choose backup delegates to the mounted file input");

  const transfer = new DataTransfer();
  transfer.items.add(new File(["{}"], "backup.json", {
    type: "application/json", lastModified: 123
  }));
  input.files = transfer.files;
  const previewStartedAt = performance.now();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => panel.querySelector('[data-restore-focus-id="restore-action"]'),
    "backup preview action");
  check(previewCalls === 1 && !panel.querySelector(".loading-feedback") &&
    performance.now() - previewStartedAt < 180,
  "a fast preview removes staged Loading before its visual reveal delay");

  const restoreSettings = panel.querySelector('[data-restore-focus-id="restore-settings"]');
  check(
    panel.querySelectorAll('input[type="checkbox"]').length === 1 &&
      !panel.textContent.includes("Restore saved data"),
    "the preview has one optional Settings choice and no second saved-data Restore control"
  );
  restoreSettings.focus();
  restoreSettings.checked = false;
  restoreSettings.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => previewCalls === 2 && !panel.querySelector(".loading-feedback"),
    "settings preview refresh");
  check(document.activeElement === restoreSettings,
    "Restore settings keeps focus while its preview is replaced");

  const action = () => panel.querySelector('[data-restore-focus-id="restore-action"]');
  const isArmed = () => action()?.getAttribute("aria-label")?.includes("press again");
  const initialRestoreLabel = action().textContent;

  action().focus();
  action().click();
  const armedRestoreLabel = action().textContent;
  check(isArmed() && document.activeElement === action(),
    "P4 first press arms and preserves focus on the replacement action");
  action().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(!isArmed() && document.activeElement === action(),
    "P4 Escape disarms and focuses the equivalent replacement action");

  action().click();
  choose.focus();
  await wait();
  check(!isArmed() && document.activeElement === choose, "P4 blur disarms without stealing focus");

  action().focus();
  action().click();
  const expireArm = scheduledArm;
  check(scheduledArmDelay === 4000, "P4 timeout keeps the accepted four-second window");
  expireArm();
  await waitFor(() => !isArmed(), "P4 timeout", 250);
  check(document.activeElement === action(),
    "P4 timeout disarms and restores focus to the equivalent action");

  action().click();
  action().click();
  await waitFor(() => panel.textContent.includes("Review the fresh summary"),
    "commit-time reconfirmation");
  check(document.activeElement === action() && !isArmed(),
    "commit-time replan returns focus to a fresh unarmed action");

  action().click();
  action().click();
  const undo = await waitFor(() =>
    panel.querySelector('[data-restore-focus-id="restore-undo:checkpoint-2"]'), "success Undo");
  check(document.activeElement === undo && changes.length === 1,
    "Restore success replaces focus with its exact Undo action");
  check(
    initialRestoreLabel === "Restore backup" && armedRestoreLabel === "Confirm Restore" && !action(),
    "Restore is one clearly named two-press action and cannot be repeated after success"
  );
  undo.click();
  await waitFor(() => panel.textContent.includes("Restore undone"), "successful Undo result");
  await waitFor(action, "Restore action returns only after explicit Undo");

  action().click();
  action().click();
  const staleUndo = await waitFor(() =>
    panel.querySelector('[data-restore-focus-id="restore-undo:checkpoint-3"]'), "second success Undo");
  staleUndo.click();
  const recovery = await waitFor(() =>
    panel.querySelector('[data-restore-focus-id="restore-recovery:checkpoint-3"]'), "stale recovery");
  check(document.activeElement === recovery,
    "stale Undo replaces focus with the downloadable recovery action");
  recovery.click();
  await waitFor(() => downloads.length === 1, "recovery download");
  check(downloads[0][1] === "{\"recovery\":true}",
    "stale Restore offers the checkpoint download through the mounted control");

  failCheckpointExport = true;
  recovery.focus();
  recovery.click();
  await waitFor(() => panel.textContent.includes("could not be prepared"),
    "recovery export failure status");
  check(document.activeElement === recovery && downloads.length === 1,
    "a recovery export failure stays handled, visible, and focused");

  resultNode.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
  resultNode.dataset.status = "pass";
} catch (error) {
  resultNode.textContent = `FAIL: ${error?.stack ?? error}\nPANEL: ${panel?.textContent ?? "not mounted"}`;
  resultNode.dataset.status = "fail";
}
