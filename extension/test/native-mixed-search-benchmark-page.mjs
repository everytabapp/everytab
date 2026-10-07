/** Mixed native storage workloads. Query input is mounted; facet timing is API-only. */
import { MIXED_SCENARIOS, WORKLOADS, makeMixedFixture, queryFor, editedNamedRecord,
  expectedMixedRows, expectedMixedDomRows, expectedMixedFacets, assertMixedRows, assertMixedFacets, assertMixedCache } from "./native-mixed-search-fixture.mjs";
import { canonicalJson } from "../js/lib/storage/canonical.js";
import { openLibraryStore } from "../js/lib/storage/library-store.js";
import { openRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthorityRecord } from "../js/lib/storage/authority-record.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";
import { domRowsMatch, observeFrame, assertWarmCadence } from "./native-search-oracles.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: (...args) => { for (const fn of listeners) fn(...args); } };
};
const assert = (condition, label) => { if (!condition) throw new Error(label); };
const storageChanged = event();
const query = new URLSearchParams(location.search);
const scenario = MIXED_SCENARIOS[Number(query.get("scenario"))];
const workload = query.get("workload");
const round = Number(query.get("round"));
const databases = { library: `everytab-mixed-search-library-${crypto.randomUUID()}`,
  recovery: `everytab-mixed-search-recovery-${crypto.randomUUID()}` };
window.benchmarkState = { status: "running", progress: { ...scenario, workload, round, phase: "seed" } };
let seed;
let recoverySeed;
let searchSession;
let unbindFacets;
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
  assert(scenario && WORKLOADS.includes(workload) && round >= 1 && round <= 3, "Invalid trial");
  const fixture = makeMixedFixture(scenario);
  const fixtureBytes = new TextEncoder().encode(JSON.stringify(fixture)).length;
  seed = openLibraryStore({ databaseName: databases.library, deviceId: "synthetic-mixed-search" });
  recoverySeed = openRecoveryStore({ databaseName: databases.recovery });
  const operations = [
    ...fixture.inbox.map(value => ({ type: "put", family: "inbox", id: value.id, value })),
    ...fixture.named.map(value => ({ type: "put", family: "sessions", id: value.id, value }))
  ];
  for (let offset = 0; offset < operations.length; offset += 100) {
    await seed.transact(operations.slice(offset, offset + 100));
  }
  for (const value of fixture.snapshots) await recoverySeed.captureSnapshot(value);
  await seed.close(); seed = null;
  await recoverySeed.close(); recoverySeed = null;
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
  // Populate the production compact identity index before timed reads. This is
  // seeding, not startup timing; raw record writes alone do not publish the index.
  await authority.commitLibraryRevision(["inbox", "sessions"]);
  const { createSearchSession, buildPrimarySearchSnapshot, bindSearchSnapshotInvalidation } =
    await import("../js/lib/search.js");
  const { upsertItem } = await import("../js/lib/store.js");
  observeMethod(stores.library, "readFamily", "libraryFamilyRead");
  observeMethod(stores.recovery, "listSnapshots", "recoverySnapshotRead");
  observeMethod(authority, "readMaps", "authorityMapRead");
  countNativeRequests();
  searchSession = createSearchSession({ buildPrimarySnapshot: async () => {
    const current = trace;
    const start = performance.now();
    try { return await buildPrimarySearchSnapshot(); }
    finally { if (current) current.calls.push({ label: "primarySnapshotBuild", ms: performance.now() - start }); }
  } });
  let sample = null;
  let edited = false;
  const expectedRows = complete => expectedMixedRows(scenario, { workload, edited, complete });
  const expectedDomRows = complete => expectedMixedDomRows(scenario, { workload, edited, complete });
  let box, input;
  const setupTrace = { calls: [], requests: {} };
  trace = setupTrace;
  if (workload === "facets") {
    unbindFacets = bindSearchSnapshotInvalidation(searchSession);
  } else {
    const { createSearchBox } = await import("../js/ui/searchbox.js");
    const realProgressive = searchSession.searchProgressively;
    searchSession.searchProgressively = async (...args) => {
      const current = sample;
      assert(current, "Unexpected Search run outside sample");
      current.searchCalls += 1;
      const start = performance.now();
      const progressive = await realProgressive(...args);
      assertMixedRows(progressive.results, expectedRows(false));
      current.primaryResultCount = progressive.results.length;
      current.completionResultCount = null;
      current.primaryResolvedMs = performance.now() - current.started;
      current.progressivePrimaryMs = performance.now() - start;
      assert(Boolean(progressive.complete) === (workload === "selective"), "Unexpected completion path");
      if (progressive.complete) progressive.complete.then(rows => {
        try {
          assertMixedRows(rows, expectedRows(true));
          current.completionResultCount = rows.length;
          current.completionResolvedMs = performance.now() - current.started;
        } catch (error) { current.failure = error; }
      }, error => { current.failure = error; });
      return progressive;
    };
    box = createSearchBox({ searchSession, preloadEmptySuggestions: false });
    document.querySelector("#fixture").append(box);
    input = box.querySelector("input");
  }
  await wait(30);
  assert(!setupTrace.calls.some(call => ["primarySnapshotBuild", "libraryFamilyRead", "recoverySnapshotRead"].includes(call.label)) &&
    (setupTrace.requests["assets.get"] ?? 0) === 0, "Setup prewarmed Search");
  trace = null;

  const rowsNow = () => [...box.querySelectorAll(".search-result-group .search-row")];
  const describe = rows => rows.map(row => ({ title: row.querySelector(".rtitle")?.textContent,
    type: [...(row.querySelector(".rtype")?.classList ?? [])].find(name => name.startsWith("rtype-"))?.slice(6),
    role: row.getAttribute("role") }));
  let lastCompletionAt = null;
  async function measure(phase) {
    window.benchmarkState.progress = { ...scenario, workload, round, phase,
      visibility: document.visibilityState, focused: document.hasFocus() };
    const current = { phase, started: performance.now(), calls: [], requests: {} };
    const startSample = () => {
      current.started = performance.now();
      current.sincePreviousCompletionMs = lastCompletionAt === null ? null : current.started - lastCompletionAt;
      assertWarmCadence(phase, current.sincePreviousCompletionMs);
    };
    trace = current;
    sample = current;
    try {
      if (workload === "facets") {
        startSample();
        const [labels, sessions, domains] = await Promise.all([
          searchSession.labelCounts(), searchSession.scopeNames("session"), searchSession.scopeNames("domain")
        ]);
        current.resolvedMs = performance.now() - current.started;
        lastCompletionAt = current.started + current.resolvedMs;
        assertMixedFacets({ labels, sessions, domains }, expectedMixedFacets(scenario, edited));
        current.counts = { labels: labels.length, sessions: sessions.length, domains: domains.length };
      } else {
        const priorNodes = new Set(rowsNow());
        const frameChecks = [];
        current.searchCalls = 0;
        if (workload === "broad") Object.assign(current, {
          completionResolvedMs: null, completionDomReadyMs: null, completionFrameOpportunityMs: null
        });
        const inspect = () => {
          const rows = rowsNow();
          if (!rows.length || rows.some(row => priorNodes.has(row))) return;
          for (const label of workload === "selective" ? ["primary", "completion"] : ["primary"]) {
            if (current[`${label}DomReadyMs`] !== undefined || current[`${label}ResolvedMs`] === undefined ||
                !domRowsMatch(describe(rows), expectedDomRows(label === "completion"))) continue;
            assert(box.querySelector('[role="listbox"]')?.contains(rows[0]), "Result outside listbox");
            assert(input.getAttribute("aria-activedescendant") === rows[0].id, "Selection identity mismatch");
            current[`${label}DomReadyMs`] = performance.now() - current.started;
            frameChecks.push(observeFrame(() => {
              current[`${label}FrameOpportunityMs`] = performance.now() - current.started;
              current[`${label}RowsStillCurrentAtFrame`] = rowsNow().length === rows.length &&
                rowsNow().every((row, index) => row === rows[index]);
            }).catch(error => { current.failure = error; }));
          }
        };
        const observer = new MutationObserver(() => { try { inspect(); } catch (error) { current.failure = error; } });
        observer.observe(box, { childList: true, subtree: true, characterData: true });
        try {
          input.value = queryFor(workload);
          startSample();
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const finalLabel = workload === "selective" ? "completion" : "primary";
          const deadline = performance.now() + 20_000;
          while (current[`${finalLabel}DomReadyMs`] === undefined) {
            if (current.failure) throw current.failure;
            if (performance.now() >= deadline) throw new Error("Search DOM receipt timed out");
            await wait(5);
          }
          await Promise.all(frameChecks);
          if (current.failure) throw current.failure;
          assert(current.primaryDomReadyMs !== undefined && current.searchCalls === 1, "Search phase ordering mismatch");
          const rows = rowsNow();
          assert(domRowsMatch(describe(rows), expectedDomRows(workload === "selective")), "Final DOM mismatch");
          assert(rows.every(row => row.getBoundingClientRect().height > 0), "Results have no layout");
          assert(!box.querySelector(".rtype-open-url,.rtype-search-web"), "Unexpected browser handoff");
          current.domResultCount = rows.length;
          lastCompletionAt = current.started + current[`${finalLabel}ResolvedMs`];
        } finally { observer.disconnect(); }
      }
      assertMixedCache(workload, phase, current);
      assert(current.calls.filter(call => call.label === "libraryFamilyRead" && call.family === "sessions").length <= 1,
        "Search read named records twice");
      const { started, failure, ...receipt } = current;
      return receipt;
    } finally { sample = null; trace = null; }
  }
  const phases = [await measure("first")];
  for (let repeat = 0; repeat < 3; repeat++) { await wait(50); phases.push(await measure("warm-immediate")); }
  await wait(1_100);
  phases.push(await measure("warm-expired"));
  const update = editedNamedRecord(fixture);
  const editTrace = { calls: [], requests: {} };
  trace = editTrace;
  const editStart = performance.now();
  await upsertItem("sessions", update);
  const editMs = performance.now() - editStart;
  trace = null;
  assert(editTrace.calls.filter(call => call.label === "libraryFamilyRead" && call.family === "sessions").length === 2,
    "Generic edit duplicated named reads");
  edited = true;
  await wait(0);
  const committed = (await stores.library.readEntity("sessions", update.id)).value;
  assert(Number.isFinite(committed.modifiedAt) && committed.modifiedAt >= update.modifiedAt,
    "Committed Session revision missing");
  const { modifiedAt: committedTime, ...committedPayload } = committed;
  const { modifiedAt: fixtureTime, ...expectedPayload } = update;
  assert(canonicalJson(committedPayload) === canonicalJson(expectedPayload), "Committed Session payload changed");
  phases.push(await measure("after-edit"));
  // The generic upsert above is a stress path, not the UI's named-only rename.
  // Measure the real domain operation separately after every Search sample.
  window.benchmarkState.progress = { ...scenario, workload, round, phase: "rename" };
  const { renameSession } = await import("../js/lib/sessions.js");
  const renameTrace = { calls: [], requests: {} };
  const renamedName = "Renamed synthetic bundle";
  trace = renameTrace;
  const renameStart = performance.now();
  const renamed = await renameSession(update.id, renamedName);
  const renameMs = performance.now() - renameStart;
  trace = null;
  assert(renamed?.name === renamedName, "Domain rename did not commit");
  assert(!renameTrace.calls.some(call => call.label === "recoverySnapshotRead") &&
    !Object.keys(renameTrace.requests).some(key => key.startsWith("snapshots.")),
    "Named rename loaded automatic Snapshots");
  const renamedStored = (await stores.library.readEntity("sessions", update.id)).value;
  const { modifiedAt: renamedTime, ...renamedPayload } = renamedStored;
  assert(canonicalJson(renamedPayload) === canonicalJson({ ...expectedPayload, name: renamedName }),
    "Domain rename changed retained payload");
  const journal = (await authority.readMaps(["journal"])).journal;
  assert(journal.some(entry => entry.puts?.some(put =>
    put.store === "sessions" && put.item?.id === update.id && put.item.name === update.name)),
    "Domain rename Undo missing");
  const sessionNames = await searchSession.scopeNames("session");
  assert(sessionNames[0] === renamedName && !sessionNames.includes(update.name), "Rename facets stayed stale");
  result = { ...scenario, workload, round, phases,
    edit: { ms: editMs, operation: "generic-session-upsert", ...editTrace },
    rename: { ms: renameMs, operation: "renameSession", ...renameTrace },
    fixture: { bytes: fixtureBytes, chromeTabs: 0, historyAccess: false, windowsPerSession: 2 }, setup: setupTrace };
} catch (error) {
  failed = true;
  errorClass = error?.name ?? "Error";
  failureCode = ["frame-timeout", "cache-phase", "warm-cadence"].includes(error?.code) ? error.code : "fixture-contract";
  failedPhase = window.benchmarkState.progress.phase;
} finally {
  trace = null;
  unbindFacets?.();
  searchSession?.invalidate();
  for (const restore of restores.reverse()) restore();
  try {
    await seed?.close();
    await recoverySeed?.close();
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
  ? { status: "fail", error: `Mixed Search measurement failed (${errorClass})`, failureCode, failedPhase }
  : { status: "pass", report: { result, cleanup: { deletedDatabases: 2 } } };
document.querySelector("#result").textContent = failed ? window.benchmarkState.error : "PASS";
