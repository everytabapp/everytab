/**
 * E3-0 — Node micro-bench for the pure/mocked compute paths (e3-performance-
 * pass.md §3.3). SEPARATE command, NOT part of smoke:
 *
 *     node test/perf.mjs           (from extension/)
 *
 * T2-scale fixtures come from the seeder (`tools/perf-seed.mjs` exports
 * `buildTierData`/`buildOpenTabs`, so browser seed and bench share one
 * definition). Deterministic fixtures, 2 warm-up runs, median of 5 timed runs.
 *
 * Budgets — the "3× headroom" rule (§1/§3.3): each pure path gets a target
 * that is its share of the end-to-end budget, then the ASSERTED limit is 3×
 * that target so slow CI machines don't flake while a real regression (an
 * order of magnitude, the usual failure mode) still fails loudly.
 *
 *   searchAll (T2, mocked storage+tabs)   target 50 ms of B7's 100 → assert 150
 *   collectLabels (T2)                    target 30 ms (renderLabels + resolveScope feed) → assert 90
 *   sortLabelGroups (T2, all modes)       target  5 ms → assert 15
 *   mergeMaps (T2 archive, 10k tabs)      target 80 ms (sync merge phase under the vault lock) → assert 240
 *   matchesForView (T2, all-scope)        target 50 ms (search view: scope + ghost-chip warm) → assert 150
 *   cold Open primary library (T2)         target 10 ms (Session identities + bindings) → assert 30
 *   Session identity rebuild (T2)          target 10 ms (named-Session URL projection) → assert 30
 *   cold Open saved-label enrichment (T2)  target 40 ms (deferred, outside first paint) → assert 120
 *
 * T3 rows are printed for information only (§2: T3 must not hang; no budget).
 * Exit code 1 on any failed assertion, so it can gate a manual pre-beta run.
 */

/* ---- chrome mock (storage read-only + tabs.query) BEFORE lib imports ---- */

const mem = {};
const openTabsByTier = { t2: null, t3: null };
let currentOpenTabs = [];

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://perf-test/${p}` },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        const out = {};
        for (const k of Array.isArray(keys) ? keys : Object.keys(keys ?? {})) {
          if (k in mem) out[k] = structuredClone(mem[k]);
        }
        return out;
      },
      set: async (obj) => Object.assign(mem, obj)
    }
  },
  tabs: { query: async () => currentOpenTabs }
};

const { buildTierData, buildOpenTabs } = await import("../tools/perf-seed.mjs");
const { STORE_KEYS } = await import("../js/lib/types.js");
const { searchAll } = await import("../js/lib/search.js");
const { collectLabels, sortLabelGroups } = await import("../js/lib/labels.js");
const { mergeMaps } = await import("../js/lib/merge.js");
const { matchesForView } = await import("../js/lib/smartviews.js");
const { listItems, readStoreMap } = await import("../js/lib/store.js");
const { buildSavedLabelsByUrl } = await import("../js/lib/saved-label-index.js");
const {
  SESSION_IDENTITY_INDEX_KEY, buildSessionIdentityIndex, readSessionIdentities
} = await import("../js/lib/session-identity-index.js");

/* ---- fixtures ---- */

const t2 = buildTierData("t2").payload.data;
const t3 = buildTierData("t3").payload.data;
openTabsByTier.t2 = buildOpenTabs("t2");
openTabsByTier.t3 = buildOpenTabs("t3");

function loadTier(data, tier) {
  for (const k of Object.keys(mem)) delete mem[k];
  Object.assign(mem, data);
  mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(
    mem[STORE_KEYS.sessions] ?? {}
  );
  currentOpenTabs = openTabsByTier[tier];
}

/**
 * Long-lived pre-index profile: only three named Sessions are visible, while
 * unlimited automatic snapshots share the same physical `sessions` map. This
 * is the real profile shape that can push Open past its 180 ms Loading gate.
 */
function loadSnapshotHeavyMatureProfile() {
  for (const k of Object.keys(mem)) delete mem[k];
  const sessions = {};
  for (let s = 0; s < 2_000; s++) {
    const refs = [];
    for (let t = 0; t < 72; t++) {
      refs.push({
        url: `https://example.com/snapshot-${s}/tab-${t}`,
        title: `Saved page ${t}`
      });
    }
    sessions[`auto-${s}`] = {
      id: `auto-${s}`,
      name: `Snapshot ${s}`,
      auto: true,
      modifiedAt: s,
      windows: [refs],
      labels: []
    };
  }
  for (let s = 0; s < 3; s++) {
    sessions[`named-${s}`] = {
      id: `named-${s}`,
      name: `Session ${s + 1}`,
      auto: false,
      modifiedAt: 3_000 + s,
      windows: [[]],
      labels: []
    };
  }
  mem[STORE_KEYS.sessions] = sessions;
  mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(sessions);
  mem.sessionWindows = {};
  currentOpenTabs = [];
}

/** Deterministic "remote" map for mergeMaps: ~10% newer copies + ~5% new ids. */
function remoteVariant(local) {
  const remote = {};
  const ids = Object.keys(local);
  for (let i = 0; i < ids.length; i++) {
    const rec = local[ids[i]];
    if (i % 10 === 0) remote[rec.id] = { ...rec, modifiedAt: rec.modifiedAt + 1000 };
    else if (i % 3 === 0) remote[rec.id] = rec; // identical copy — tie, local wins
    if (i % 20 === 0) {
      const nid = `${rec.id}-remote`;
      remote[nid] = { ...rec, id: nid, modifiedAt: rec.modifiedAt + 5 };
    }
  }
  return remote;
}

/* ---- harness: warm-up ×2, median of 5 ---- */

const { performance } = await import("node:perf_hooks");

async function bench(name, fn, assertMs) {
  for (let i = 0; i < 2; i++) await fn(); // warm-up
  const runs = [];
  let last;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    last = await fn();
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const median = runs[2];
  const ok = assertMs == null || median <= assertMs;
  return {
    name,
    medianMs: Math.round(median * 100) / 100,
    minMs: Math.round(runs[0] * 100) / 100,
    maxMs: Math.round(runs[4] * 100) / 100,
    budgetMs: assertMs ?? "(info)",
    result: assertMs == null ? "-" : ok ? "PASS" : "FAIL",
    outcome: last
  };
}

const rows = [];
let failures = 0;
const record = (r, describe) => {
  rows.push({ ...r, outcome: describe(r.outcome) });
  if (r.result === "FAIL") failures++;
};

/** The pre-N45 cold Open path: clone + sort all Inbox/Archive records, then
 * scan every saved tab even though the first useful paint only needs live
 * windows. Kept here as the mature-profile baseline and regression yardstick. */
async function coldSavedLabelIndex() {
  const [inbox, archive] = await Promise.all([
    listItems(STORE_KEYS.inbox),
    listItems(STORE_KEYS.archive)
  ]);
  return buildSavedLabelsByUrl(inbox, archive);
}

async function coldOpenPrimaryLibrary() {
  const [sessions, bindings] = await Promise.all([
    readSessionIdentities(),
    readStoreMap("sessionWindows")
  ]);
  return { sessions: sessions.length, bindings: Object.keys(bindings).length };
}

/* ---- T2 (budget tier) ---- */

loadTier(t2, "t2");

record(await bench("searchAll T2 'github pull'", () => searchAll("github pull"), 150),
  (r) => `${r.length} results`);
record(await bench("searchAll T2 3-term AND", () => searchAll("guide notes plan"), 150),
  (r) => `${r.length} results`);
record(await bench("collectLabels T2", () => collectLabels(), 90),
  (r) => `${r.length} labels`);
record(await bench("cold Open primary library T2", () => coldOpenPrimaryLibrary(), 30),
  (r) => `${r.sessions} sessions / ${r.bindings} bindings`);
record(await bench("Session identity rebuild T2", () =>
  buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {}), 30),
  (r) => `${Object.keys(r.sessionsById).length} named sessions`);
record(await bench("cold Open saved-label enrichment T2", () => coldSavedLabelIndex(), 120),
  (r) => `${r.size} labeled URLs`);

loadSnapshotHeavyMatureProfile();
record(await bench("cold Open primary mature snapshots", () => coldOpenPrimaryLibrary(), 30),
  (r) => `${r.sessions} sessions / ${r.bindings} bindings`);
loadTier(t2, "t2");

const t2Groups = await collectLabels();
record(await bench("sortLabelGroups T2 ×3 modes", () => {
  sortLabelGroups(t2Groups, "az");
  sortLabelGroups(t2Groups, "count");
  return sortLabelGroups(t2Groups, "recent");
}, 15), (r) => `${r.length} groups`);

const t2Archive = t2[STORE_KEYS.archive];
const t2Remote = remoteVariant(t2Archive);
record(await bench("mergeMaps T2 archive", () => mergeMaps(t2Archive, t2Remote), 240),
  (r) => `${r.pulled.length} pulled / ${r.pushed.length} pushed`);

const prView = { name: "GitHub PRs", field: "url", pattern: "github\\.com/.+/pull/", scope: "all" };
record(await bench("matchesForView T2 (all scope)", () => matchesForView(prView), 150),
  (r) => `${r.length} matches`);

/* ---- T3 (informational — must not hang, no budget) ---- */

loadTier(t3, "t3");

record(await bench("searchAll T3 'github pull' (info)", () => searchAll("github pull"), null),
  (r) => `${r.length} results`);
record(await bench("collectLabels T3 (info)", () => collectLabels(), null),
  (r) => `${r.length} labels`);
record(await bench("cold Open primary library T3 (info)", () => coldOpenPrimaryLibrary(), null),
  (r) => `${r.sessions} sessions / ${r.bindings} bindings`);
record(await bench("Session identity rebuild T3 (info)", () =>
  buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {}), null),
  (r) => `${Object.keys(r.sessionsById).length} named sessions`);
record(await bench("cold Open saved-label enrichment T3 (info)", () => coldSavedLabelIndex(), null),
  (r) => `${r.size} labeled URLs`);
const t3Archive = t3[STORE_KEYS.archive];
const t3Remote = remoteVariant(t3Archive);
record(await bench("mergeMaps T3 archive (info)", () => mergeMaps(t3Archive, t3Remote), null),
  (r) => `${r.pulled.length} pulled / ${r.pushed.length} pushed`);

/* ---- report ---- */

console.log("\nE3-0 micro-bench — pure/mocked compute paths, median of 5 (2 warm-ups)");
console.log("Budgets = 3× headroom over the pure-path targets (see file header).\n");
console.table(rows);

if (failures > 0) {
  console.error(`\n${failures} budget assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll perf budget assertions passed");
