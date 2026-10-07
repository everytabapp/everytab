/** Native IDB + production authority/Store/Searchbox. Chrome API transport is synthetic. */
import { makeFixture, SCENARIOS } from "./native-storage-benchmark-page.mjs";
import { openLibraryStore } from "../js/lib/storage/library-store.js";
import { createStorageAuthorityRecord } from "../js/lib/storage/authority-record.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";
import { QUERY, expectedSearchRows, assertSearchResults, domRowsMatch, assertPhaseCache, observeFrame, assertWarmCadence } from "./native-search-oracles.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: (...args) => { for (const fn of listeners) fn(...args); } };
};
const assert = (condition, label) => { if (!condition) throw new Error(label); };
const storageChanged = event();
const query = new URLSearchParams(location.search);
const scenario = SCENARIOS[Number(query.get("scenario"))];
const round = Number(query.get("round"));
const databases = { library: `everytab-search-library-${crypto.randomUUID()}`,
  recovery: `everytab-search-recovery-${crypto.randomUUID()}` };
window.benchmarkState = { status: "running", progress: { ...scenario, round, phase: "seed" } };
let seed;
let runtime;
let trace = null;
const restores = [];
let failed = false;
let result;
let errorClass;
let failureCode;
let failedPhase;

function observeMethod(owner, key, label) {
  const original = owner[key];
  owner[key] = async function (...args) {
    const recording = trace;
    const started = performance.now();
    try { return await original.apply(this, args); }
    finally {
      if (recording) recording.calls.push({ label, ms: performance.now() - started,
        ...(key === "readFamily" ? { family: args[0] } : {}) });
    }
  };
  restores.push(() => { owner[key] = original; });
}

function countNativeRequests() {
  for (const [prototype, methods] of [[IDBObjectStore.prototype, ["get", "getAll", "put"]],
    [IDBIndex.prototype, ["getAll"]]]) {
    for (const key of methods) {
      const original = prototype[key];
      prototype[key] = function (...args) {
        if (trace) {
          const store = this.objectStore?.name ?? this.name;
          const label = `${store}.${key}`;
          trace.requests[label] = (trace.requests[label] ?? 0) + 1;
        }
        return original.apply(this, args);
      };
      restores.push(() => { prototype[key] = original; });
    }
  }
}

async function removeDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(new Error("Database cleanup failed"));
    request.onblocked = () => reject(new Error("Database cleanup blocked"));
  });
}

try {
  assert(scenario && round >= 1 && round <= 3, "Invalid trial");
  const values = makeFixture(scenario);
  values[0].tabs[0].title = expectedSearchRows()[0].title;
  seed = openLibraryStore({ databaseName: databases.library, deviceId: "synthetic-search" });
  for (let offset = 0; offset < values.length; offset += 100) {
    await seed.transact(values.slice(offset, offset + 100).map(value => ({ type: "put", family: "inbox", id: value.id, value })));
  }
  // One distinct Session tab makes completion observably different from primary.
  const secondary = expectedSearchRows(false, true)[1];
  await seed.transact([{ type: "put", family: "sessions", id: "secondary-session", value: {
    id: "secondary-session", name: "Saved bundle", createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000, windows: [[{ title: secondary.title, url: secondary.url }]]
  } }]);
  await seed.close();
  seed = null;
  const browserLocal = {
    deviceId: "synthetic-search",
    storageAuthority: createStorageAuthorityRecord({ runId: crypto.randomUUID(), databases })
  };
  globalThis.chrome = {
    i18n: await createBrowserI18nMock(),
    permissions: { contains: async () => false, onAdded: event(), onRemoved: event() },
    runtime: { getURL: path => new URL(`../${path}`, import.meta.url).href, sendMessage: async () => ({ ok: true }) },
    storage: { onChanged: storageChanged, local: {
      get: async keys => Object.fromEntries((keys == null ? Object.keys(browserLocal) :
        typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys))
        .filter(key => Object.hasOwn(browserLocal, key)).map(key => [key, structuredClone(browserLocal[key])])),
      set: async sets => {
        const changes = {};
        for (const [key, value] of Object.entries(sets)) {
          changes[key] = { oldValue: structuredClone(browserLocal[key]), newValue: structuredClone(value) };
          browserLocal[key] = structuredClone(value);
        }
        queueMicrotask(() => storageChanged.fire(changes, "local"));
      }
    } },
    tabs: { query: async () => [], onCreated: event(), onUpdated: event(), onRemoved: event(),
      onMoved: event(), onAttached: event(), onDetached: event(), onReplaced: event() },
    windows: { getAll: async () => [], onCreated: event(), onRemoved: event() }
  };
  runtime = await import("../js/lib/storage/authority-runtime.js");
  const authority = await runtime.activeStorageAuthority();
  const stores = await runtime.activeVaultStores();
  const { createSearchSession, buildPrimarySearchSnapshot } = await import("../js/lib/search.js");
  const { createSearchBox } = await import("../js/ui/searchbox.js");
  const { upsertItem } = await import("../js/lib/store.js");
  observeMethod(stores.library, "readFamily", "libraryFamilyRead");
  observeMethod(authority, "readMaps", "authorityMapRead");
  countNativeRequests();
  const searchSession = createSearchSession({ buildPrimarySnapshot: async () => {
    const current = trace;
    const start = performance.now();
    try { return await buildPrimarySearchSnapshot(); }
    finally { if (current) current.calls.push({ label: "primarySnapshotBuild", ms: performance.now() - start }); }
  } });
  let sample = null;
  let edited = false;
  const realProgressive = searchSession.searchProgressively;
  searchSession.searchProgressively = async (...args) => {
    const current = sample;
    assert(current, "Unexpected Search run outside sample");
    current.searchCalls += 1;
    const start = performance.now();
    const progressive = await realProgressive(...args);
    assertSearchResults(progressive.results, expectedSearchRows(edited));
    current.primaryResolvedMs = performance.now() - current.started;
    current.progressivePrimaryMs = performance.now() - start;
    assert(progressive.complete, "Completion missing from selective query");
    progressive.complete.then(rows => {
      try {
        assertSearchResults(rows, expectedSearchRows(edited, true));
        current.completionResolvedMs = performance.now() - current.started;
      } catch (error) { current.failure = error; }
    }, error => { current.failure = error; });
    return progressive;
  };
  const box = createSearchBox({ searchSession, preloadEmptySuggestions: false });
  document.querySelector("#fixture").append(box);
  const input = box.querySelector("input");
  await wait(30); // settle metadata readiness; no focus/empty-suggestion prewarming

  const rowsNow = () => [...box.querySelectorAll(".search-result-group .search-row")];
  const describe = rows => rows.map(row => ({ title: row.querySelector(".rtitle")?.textContent,
    type: [...(row.querySelector(".rtype")?.classList ?? [])].find(name => name.startsWith("rtype-"))?.slice(6),
    role: row.getAttribute("role") }));
  let lastCompletionAt = null;
  async function measureInput(phase) {
    window.benchmarkState.progress = { ...scenario, round, phase };
    const priorNodes = new Set(rowsNow());
    const current = { phase, started: performance.now(), searchCalls: 0, calls: [], requests: {} };
    const frameChecks = [];
    sample = current;
    trace = current;
    const inspect = () => {
      const rows = rowsNow();
      if (!rows.length || rows.some(row => priorNodes.has(row))) return;
      for (const [label, complete] of [["primary", false], ["completion", true]]) {
        if (current[`${label}DomReadyMs`] !== undefined || current[`${label}ResolvedMs`] === undefined ||
            !domRowsMatch(describe(rows), expectedSearchRows(edited, complete))) continue;
        assert(box.querySelector('[role="listbox"]')?.contains(rows[0]), "Result outside listbox");
        assert(input.getAttribute("aria-activedescendant") === rows[0].id, "Selection identity mismatch");
        current[`${label}DomReadyMs`] = performance.now() - current.started;
        const frame = observeFrame(() => {
          current[`${label}FrameOpportunityMs`] = performance.now() - current.started;
          current[`${label}RowsStillCurrentAtFrame`] = rowsNow().every((row, index) => row === rows[index]) && rowsNow().length === rows.length;
        });
        // Attach rejection immediately, before awaiting DOM completion.
        frameChecks.push(frame.catch(error => { current.failure = error; }));
      }
    };
    const observer = new MutationObserver(() => { try { inspect(); } catch (error) { current.failure = error; } });
    observer.observe(box, { childList: true, subtree: true, characterData: true });
    try {
      // Focus would trigger a separate immediate search and prewarm the first trial.
      // Synthetic input follows the real 90ms input-listener path without that setup.
      current.started = performance.now();
      current.sincePreviousCompletionMs = lastCompletionAt === null ? null : current.started - lastCompletionAt;
      assertWarmCadence(phase, current.sincePreviousCompletionMs);
      input.value = QUERY;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const deadline = performance.now() + 15_000;
      while (current.completionDomReadyMs === undefined) {
        if (current.failure) throw current.failure;
        if (performance.now() >= deadline) throw new Error("Search DOM receipt timed out");
        await wait(5);
      }
      await Promise.all(frameChecks);
      if (current.failure) throw current.failure;
      lastCompletionAt = current.started + current.completionResolvedMs;
      assert(current.primaryDomReadyMs !== undefined && current.searchCalls === 1, "Search phase ordering mismatch");
      const rows = rowsNow();
      assert(domRowsMatch(describe(rows), expectedSearchRows(edited, true)), "Final DOM mismatch");
      assert(rows.every(row => row.getBoundingClientRect().height > 0), "Results have no layout");
      assert(!box.querySelector(".rtype-open-url,.rtype-search-web"), "Unexpected browser handoff");
      assertPhaseCache(phase, current.calls);
      assert((current.requests["assets.get"] ?? 0) === 0, "Search hydrated favicon assets");
      const { started, failure, ...receipt } = current;
      return receipt;
    } finally { observer.disconnect(); sample = null; trace = null; }
  }
  const phases = [await measureInput("first")];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    await wait(50);
    phases.push(await measureInput("warm-immediate"));
  }
  await wait(1_100); // deliberate expiry of the production 1s completion cache
  phases.push(await measureInput("warm-expired"));
  const updateTrace = { calls: [], requests: {} };
  trace = updateTrace;
  const updated = { ...values[0], tabs: [{ ...values[0].tabs[0], title: expectedSearchRows(true)[0].title }] };
  const updateStart = performance.now();
  await upsertItem("inbox", updated);
  const editMs = performance.now() - updateStart;
  trace = null;
  edited = true;
  await wait(0); // deliver the synthetic Chrome revision event before the next input
  const committedTab = (await stores.library.readEntity("inbox", updated.id)).value.tabs[0];
  assert(committedTab.title === updated.tabs[0].title, "Committed edit missing");
  assert(committedTab.favIconUrl === updated.tabs[0].favIconUrl, "Committed favicon changed");
  phases.push(await measureInput("after-edit"));
  result = { ...scenario, round, phases, edit: { ms: editMs, ...updateTrace },
    fixture: { inboxTabs: scenario.records, secondarySessionTabs: 1, chromeTabs: 0, historyAccess: false } };
} catch (error) {
  failed = true;
  errorClass = error?.name ?? "Error";
  failureCode = ["frame-timeout", "cache-phase", "warm-cadence"].includes(error?.code) ? error.code : "fixture-contract";
  failedPhase = window.benchmarkState.progress.phase;
  // All thrown labels here are fixture-owned. Avoid exporting arbitrary native errors.
  window.benchmarkState.progress = { ...scenario, round, phase: "failed" };
} finally {
  trace = null;
  for (const restore of restores.reverse()) restore();
  try {
    await seed?.close();
    if (runtime) {
      const stores = await runtime.activeVaultStores();
      await stores?.library.close();
      await stores?.recovery.close();
    }
    await removeDatabase(databases.library);
    await removeDatabase(databases.recovery);
  } catch { failed = true; errorClass = "CleanupError"; }
}
window.benchmarkState = failed
  ? { status: "fail", error: `Native Search measurement failed (${errorClass})`, failureCode, failedPhase }
  : { status: "pass", report: { result, cleanup: { deletedDatabases: 2 } } };
document.querySelector("#result").textContent = failed ? window.benchmarkState.error : "PASS";
