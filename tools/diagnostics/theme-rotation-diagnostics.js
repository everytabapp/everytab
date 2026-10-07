/**
 * Privacy-safe, opt-in diagnostics for a profile-specific On-open rotation
 * failure. Nothing is collected until the user expands this control. The
 * active check creates one ordinary New Tab, observes the runtime for
 * five seconds, then removes it only if it is still EveryTab's New Tab.
 */
import { DEFAULT_SETTINGS, STORE_KEYS } from "../../extension/js/lib/types.js";
import { buildSchemeRotationDiagnostics } from "./scheme-rotation-diagnostics.js";
import { getVaultStatus, getVaultSyncMeta } from "../../extension/js/vault/vault.js";
import { readFreshStoreMaps } from "../../extension/js/lib/store.js";
import { el } from "../../extension/js/ui/dom.js";
import {
  themeRotationDiagnosticEvidence, themeRotationDiagnosticStatic,
  themeRotationDiagnosticSummary, themeRotationDiagnosticWatching
} from "./theme-rotation-diagnostics-copy.js";

const STATE_KEY = "schemeRotationState";
const PREPARED_KEY = "schemeRotationPrepared";
const TRACE_ARM_MESSAGE = "scheme-rotation-diagnostics-arm";
const TRACE_READ_MESSAGE = "scheme-rotation-diagnostics";
const OBSERVATION_MS = 5_200;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isEveryTabNewTab(tab, getURL = (path) => chrome.runtime.getURL(path)) {
  const candidate = tab?.pendingUrl ?? tab?.url;
  if (typeof candidate !== "string") return false;
  try {
    const actual = new URL(candidate);
    const expected = new URL(getURL("newtab.html"));
    return actual.protocol === expected.protocol && actual.host === expected.host &&
      actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function paintedSelection() {
  const root = document.documentElement;
  if (root.dataset.scheme === "custom") {
    return root.dataset.customScheme ? `custom:${root.dataset.customScheme}` : "custom:unknown";
  }
  return root.dataset.scheme || null;
}

function readThemeCache() {
  const raw = localStorage.getItem("tvTheme");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "malformed" };
    }
    return {
      schemeRotate: value.schemeRotate,
      selection: value.selection ?? value.scheme ?? null,
      scheme: value.scheme ?? null,
      customScheme: value.customScheme ?? null,
      schemeRotationPoolKey: value.schemeRotationPoolKey ?? null,
      preparedTheme: value.preparedTheme ? {
        selection: value.preparedTheme.selection ?? value.preparedTheme.scheme ?? null,
        scheme: value.preparedTheme.scheme ?? null,
        customScheme: value.preparedTheme.customScheme ?? null
      } : null
    };
  } catch {
    return { corrupt: true };
  }
}

async function runtimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, reason: "message-failed" };
  }
}

async function diagnosticInput(workerTrace = null, expectedHandshake = false, expectedTabId = null) {
  const [stored, vaultStatus, vaultMeta] = await Promise.all([
    readFreshStoreMaps([
      "settings", STORE_KEYS.customSchemes, STATE_KEY, PREPARED_KEY,
      "settingsModifiedAt"
    ]),
    getVaultStatus().catch(() => ({ state: "error" })),
    getVaultSyncMeta().catch(() => null)
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  return {
    settings,
    customRecords: stored[STORE_KEYS.customSchemes] ?? {},
    state: stored[STATE_KEY],
    prepared: stored[PREPARED_KEY],
    cache: readThemeCache(),
    painted: {
      bootSelection: globalThis.__everyTabBootThemeSelection ?? null,
      currentSelection: paintedSelection()
    },
    workerTrace,
    expectedHandshake,
    ...(Number.isInteger(expectedTabId) ? { expectedTabId } : {}),
    context: {
      appVersion: chrome.runtime.getManifest().version,
      protocolVersion: 1,
      extensionIdSuffix: chrome.runtime.id.slice(-6),
      page: location.pathname.split("/").pop() || "extension-page",
      visibility: document.visibilityState,
      settingsModifiedAt: Number(stored.settingsModifiedAt) || 0,
      vault: {
        state: vaultStatus.state,
        lastSyncAt: Number(vaultMeta?.lastSyncAt) || 0,
        ok: vaultMeta?.ok === true,
        pulled: Number(vaultMeta?.pulled) || 0,
        pushed: Number(vaultMeta?.pushed) || 0,
        conflictCopies: Number(vaultMeta?.conflictCopies) || 0
      }
    }
  };
}

function withContext(report, input, check = null) {
  const workerResponse = report.runtime?.trace?.response ?? null;
  const buildMatches = workerResponse?.workerVersion
    ? workerResponse.workerVersion === input.context.appVersion
    : null;
  const protocolMatches = workerResponse?.protocol != null
    ? workerResponse.protocol === input.context.protocolVersion
    : null;
  const mismatchEvidence = [
    ...(buildMatches === false ? ["page-worker-build-mismatch"] : []),
    ...(protocolMatches === false ? ["page-worker-protocol-mismatch"] : [])
  ];
  const workerUnavailable = check?.completed === false &&
    ["trace-unavailable", "message-failed"].includes(check.reason);
  const normalized = {
    ...report,
    ...(workerUnavailable ? {
      verdict: "insufficient-evidence",
      summaryId: "worker-unavailable"
    } : {}),
    evidence: [...new Set([
      ...(report.evidence ?? []),
      ...mismatchEvidence,
      ...(workerUnavailable ? ["diagnostic-worker-unavailable"] : [])
    ])],
    context: {
      ...input.context,
      workerIdentity: {
        version: workerResponse?.workerVersion ?? null,
        protocol: workerResponse?.protocol ?? null,
        buildMatches,
        protocolMatches
      },
      ...(check ? { check } : {})
    }
  };
  return {
    ...normalized,
    summary: themeRotationDiagnosticSummary(
      normalized.summaryId,
      normalized.runtime?.transition
    )
  };
}

export async function readThemeRotationDiagnostics() {
  const worker = await runtimeMessage({ type: TRACE_READ_MESSAGE });
  const input = await diagnosticInput(worker);
  return withContext(buildSchemeRotationDiagnostics(input), input);
}

/**
 * Run the actual profile path once. The temporary tab is the only browser
 * object this function removes; Settings, schemes, tabs already owned by the
 * user, and every saved-data store are untouched.
 */
export async function runThemeRotationDiagnostics(onProgress = () => {}, effects = {}) {
  const armTrace = effects.armTrace ?? (() => runtimeMessage({ type: TRACE_ARM_MESSAGE }));
  const readTrace = effects.readTrace ?? (() => runtimeMessage({ type: TRACE_READ_MESSAGE }));
  const readInput = effects.readInput ?? diagnosticInput;
  const createTab = effects.createTab ?? ((properties) => chrome.tabs.create(properties));
  const getTab = effects.getTab ?? ((tabId) => chrome.tabs.get(tabId));
  const removeTab = effects.removeTab ?? ((tabId) => chrome.tabs.remove(tabId));
  const runtimeGetURL = effects.runtimeGetURL ?? ((path) => chrome.runtime.getURL(path));
  const delay = effects.delay ?? wait;
  const observationMs = Number.isFinite(effects.observationMs)
    ? Math.max(0, effects.observationMs)
    : OBSERVATION_MS;
  const armed = await armTrace();
  if (armed?.ok !== true) {
    const input = await readInput(armed);
    return withContext(buildSchemeRotationDiagnostics(input), input, {
      completed: false, reason: armed?.reason ?? "trace-unavailable"
    });
  }

  let temporaryTab = null;
  let expectedCommitSelection = null;
  let check = { completed: false, reason: "not-created" };
  try {
    // Preserve the exact prepared selection privately before opening the tab.
    // The worker trace deliberately masks custom ids, so this validated local
    // value is what lets the model distinguish custom A from custom B without
    // ever copying either identity into the report.
    const preflightInput = await readInput(armed);
    const preflight = buildSchemeRotationDiagnostics(preflightInput);
    if (preflight.operational?.reservation?.health === "valid" &&
        typeof preflightInput.prepared?.next === "string") {
      expectedCommitSelection = preflightInput.prepared.next;
    }
    onProgress(themeRotationDiagnosticStatic.opening());
    temporaryTab = await createTab({ active: true });
    check = { completed: false, reason: "observing" };
    for (let elapsed = 0; elapsed < observationMs; elapsed += 1_000) {
      const remaining = Math.max(1, Math.ceil((observationMs - elapsed) / 1_000));
      onProgress(themeRotationDiagnosticWatching(remaining));
      await delay(Math.min(1_000, observationMs - elapsed));
    }
    let tabState = "missing";
    try {
      const tab = await getTab(temporaryTab.id);
      tabState = tab.status ?? "present";
    } catch { /* a lifecycle owner may already have removed it */ }
    check = { completed: true, tabState };
    // Read the stored/profile snapshot first, then take the trace last. If a
    // Vault pull lands in this small boundary, the later trace still records
    // the transition instead of freezing the report just before it.
    const input = await readInput(null, true, temporaryTab.id);
    input.workerTrace = await readTrace();
    if (expectedCommitSelection) input.expectedCommitSelection = expectedCommitSelection;
    return withContext(buildSchemeRotationDiagnostics(input), input, check);
  } catch {
    const worker = await readTrace();
    const input = await readInput(worker);
    check = {
      ...check,
      completed: false,
      reason: "check-failed"
    };
    return withContext(buildSchemeRotationDiagnostics(input), input, check);
  } finally {
    if (Number.isInteger(temporaryTab?.id)) {
      try {
        // The user may have taken over the temporary tab during the five-second
        // observation. Re-read its page immediately before cleanup and never
        // equate a surviving tab id with our New Tab still being there.
        const liveTab = await getTab(temporaryTab.id);
        if (isEveryTabNewTab(liveTab, runtimeGetURL)) await removeTab(temporaryTab.id);
      } catch { /* already gone */ }
    }
  }
}

function verdictTone(verdict) {
  if (verdict === "rotation-successful" || verdict === "valid-reservation") return "ok";
  if (verdict === "insufficient-evidence") return "quiet";
  return "warn";
}

export function createThemeRotationDiagnostics() {
  const details = el("details", { class: "setrow theme-rotation-diagnostics" });
  const summary = el("summary", {}, themeRotationDiagnosticStatic.title());
  const status = el("div", { class: "theme-diagnostic-status", role: "status", "aria-live": "polite" },
    themeRotationDiagnosticStatic.initialStatus());
  const result = el("div", { class: "theme-diagnostic-result", hidden: "" });
  const evidence = el("ul", { class: "theme-diagnostic-evidence" });
  const technical = el("pre", { class: "theme-diagnostic-technical" });
  const copy = el("button", { type: "button", class: "mini2", disabled: "" },
    themeRotationDiagnosticStatic.copyReport());
  const refresh = el("button", { type: "button", class: "mini2" },
    themeRotationDiagnosticStatic.refresh());
  const run = el("button", { type: "button" }, themeRotationDiagnosticStatic.run());
  let latest = null;
  let busy = false;

  const render = (report) => {
    latest = report;
    result.hidden = false;
    result.dataset.tone = verdictTone(report.verdict);
    result.querySelector("strong")?.remove();
    result.prepend(el("strong", {}, report.summary || themeRotationDiagnosticStatic.finished()));
    evidence.replaceChildren(...(report.evidence ?? []).map((item) =>
      el("li", {}, themeRotationDiagnosticEvidence(item))));
    technical.textContent = JSON.stringify(report, null, 2);
    copy.disabled = false;
    status.textContent = themeRotationDiagnosticStatic.ready();
  };

  const setBusy = (value) => {
    busy = value;
    run.disabled = value;
    refresh.disabled = value;
    copy.disabled = value || !latest;
    details.setAttribute("aria-busy", String(value));
  };

  refresh.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    status.textContent = themeRotationDiagnosticStatic.reading();
    try { render(await readThemeRotationDiagnostics()); }
    finally { setBusy(false); }
  });

  run.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try { render(await runThemeRotationDiagnostics((message) => (status.textContent = message))); }
    finally { setBusy(false); }
  });

  copy.addEventListener("click", async () => {
    if (!latest) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(latest, null, 2));
      status.textContent = themeRotationDiagnosticStatic.copied();
    } catch {
      status.textContent = themeRotationDiagnosticStatic.copyBlocked();
    }
  });

  details.addEventListener("toggle", () => {
    if (details.open && !latest && !busy) refresh.click();
  });
  details.append(
    summary,
    el("p", { class: "settings-hint" }, themeRotationDiagnosticStatic.usage()),
    el("p", { class: "settings-hint" }, themeRotationDiagnosticStatic.privacy()),
    el("div", { class: "theme-diagnostic-actions" }, run, refresh, copy),
    status,
    result,
    evidence,
    el("details", { class: "theme-diagnostic-raw" },
      el("summary", {}, themeRotationDiagnosticStatic.technicalReport()), technical)
  );
  return details;
}
