/**
 * A Chrome tab event used to schedule the complete navigation and Needs-you
 * refresh, which cloned the Inbox map several times, cloned the Archive map and
 * scanned every saved tab for labels. Tab events now run live-only variants.
 *
 * This fixture seeds the T2 and T3 profiles into the synthetic storage
 * authority, then measures what one tab burst costs beyond the Open rebuild:
 *   before: the saved-library reads the .658 burst performed (nav + attention);
 *   after:  the live-only Needs-you refresh plus the live navigation counts.
 * The "after" path must perform zero saved-family storage reads and zero store
 * clones. Budgets are 3x headroom over the measured Node compute; this is pure
 * compute with a minimal DOM double, not browser layout or IPC.
 *
 *     node test/tab-event-refresh-performance.mjs      (from extension/)
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const nativeClone = globalThis.structuredClone.bind(globalThis);
const mem = {};
/** @type {Record<string, number>} storage reads per key during a phase */
let keyReads = {};
let openTabs = [];
const windowsOf = (tabs) => {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  return [...byWindow].map(([id, windowTabs]) => ({ id, type: "normal", incognito: false, tabs: windowTabs }));
};

/** Store cache invalidation listeners; tier loads notify them like Chrome would. */
const storageListeners = new Set();
const dom = installDomFixture();
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://tab-burst/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        const out = {};
        for (const key of list) {
          keyReads[key] = (keyReads[key] ?? 0) + 1;
          if (key in mem) out[key] = nativeClone(mem[key]);
        }
        return out;
      },
      set: async (value) => Object.assign(mem, nativeClone(value))
    },
    onChanged: { addListener: (listener) => storageListeners.add(listener) }
  },
  tabs: { query: async () => nativeClone(openTabs) },
  windows: { getAll: async () => nativeClone(windowsOf(openTabs)) }
};

const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const { buildTierData, buildOpenTabs } = await import("../../tools/perf-seed.mjs");
const { STORE_KEYS } = await import("../js/lib/types.js");
const { SESSION_IDENTITY_INDEX_KEY, buildSessionIdentityIndex } =
  await import("../js/lib/session-identity-index.js");
const { countInboxTabs, countItems, listItems } = await import("../js/lib/store.js");
const { readLabelNavigationSnapshot } = await import("../js/lib/labels.js");
const { createDisplayTabReads } = await import("../js/ui/display-tab-reads.js");
const { createPageUtilities } = await import("../js/ui/command-box.js");
const {
  TAB_REFRESH_TASKS, LIVE_ONLY_REFRESH_TASKS, withoutSupersededLiveTasks
} = await import("../js/ui/refresh-scheduler.js");

const SAVED_FAMILIES = [
  STORE_KEYS.inbox, STORE_KEYS.archive, "archiveOverlay", STORE_KEYS.snoozes,
  STORE_KEYS.sessions, "journal", "labelMeta"
];

function loadTier(tier) {
  const previous = Object.keys(mem);
  for (const key of previous) delete mem[key];
  Object.assign(mem, buildTierData(tier).payload.data);
  mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {});
  openTabs = buildOpenTabs(tier);
  const changes = Object.fromEntries([...new Set([...previous, ...Object.keys(mem)])]
    .map((key) => [key, { newValue: mem[key] ?? null }]));
  for (const listener of storageListeners) listener(changes, "local");
}

/** The refresh-wide shared reads the Dashboard hands to nav and Needs you. */
function sharedReads() {
  const reads = createDisplayTabReads();
  let inboxRead;
  let snoozeRead;
  return {
    ...reads,
    inboxItems: () => inboxRead ??= listItems(STORE_KEYS.inbox),
    snoozeItems: () => snoozeRead ??= listItems(STORE_KEYS.snoozes)
  };
}

let cloneCount = 0;
globalThis.structuredClone = (value, options) => {
  cloneCount += 1;
  return nativeClone(value, options);
};

async function timed(fn) {
  keyReads = {};
  cloneCount = 0;
  const started = performance.now();
  await fn();
  const ms = performance.now() - started;
  const savedReads = SAVED_FAMILIES.reduce((total, key) => total + (keyReads[key] ?? 0), 0);
  return { ms, savedReads, clones: cloneCount };
}

async function median(fn, runs = 5) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) samples.push(await timed(fn));
  samples.sort((a, b) => a.ms - b.ms);
  return samples[Math.floor(runs / 2)];
}

const rows = [];
let failures = 0;
const utilities = createPageUtilities({ go: () => {} });
dom.document.body.append(utilities.attention);

assert.deepEqual([...TAB_REFRESH_TASKS], ["open", "attentionLive", "duplicates", "navOpen"],
  "tab signals schedule only live-dependent tasks");
assert.deepEqual(LIVE_ONLY_REFRESH_TASKS, { attentionLive: "attention", navOpen: "nav" });
assert.deepEqual(withoutSupersededLiveTasks(["attentionLive", "attention", "navOpen"]),
  ["attention", "navOpen"], "a complete task supersedes its live-only variant in one refresh");

for (const [tier, budgetMs] of [["t2", 30], ["t3", 60]]) {
  loadTier(tier);
  // Warm the per-context store cache exactly as a settled Dashboard has it:
  // every saved family is cached, so the comparison isolates clone and scan
  // work from first-read storage cost.
  await Promise.all([
    countInboxTabs(), countItems(STORE_KEYS.snoozes), readLabelNavigationSnapshot(),
    utilities.refreshAttention(createDisplayTabReads())
  ]);

  // The .658 tab burst: nav re-read Inbox count, Snoozed count and the complete
  // label navigation; Needs you listed Inbox and Snoozed again.
  const before = await median(async () => {
    const reads = createDisplayTabReads();
    await Promise.all([
      reads.tabs(), countInboxTabs(), countItems(STORE_KEYS.snoozes), readLabelNavigationSnapshot()
    ]);
    await reads.groups();
    await utilities.refreshAttention(createDisplayTabReads());
  });

  // The .659 tab burst beyond Open: live navigation counts and live-only
  // Needs you sharing one display snapshot.
  const after = await median(async () => {
    const reads = sharedReads();
    await Promise.all([reads.tabs(), reads.groups()]);
    await utilities.refreshAttention(reads, { liveOnly: true });
  });

  // One storage flush that runs nav and Needs you together. Independent reads
  // cloned Inbox three times (count, label navigation, Needs you) and Snoozed
  // twice; the shared reads clone each once, so exactly three clones disappear.
  const unshared = await timed(async () => {
    await Promise.all([
      countInboxTabs(), countItems(STORE_KEYS.snoozes), readLabelNavigationSnapshot()
    ]);
    await utilities.refreshAttention(createDisplayTabReads());
  });
  const shared = await timed(async () => {
    const reads = sharedReads();
    const [inboxItems, snoozes, library] = await Promise.all([
      reads.inboxItems(), reads.snoozeItems(), readLabelNavigationSnapshot(reads)
    ]);
    assert.ok(inboxItems.length > 0 && snoozes.length > 0 && library.labelGroups.length > 0);
    await utilities.refreshAttention(reads);
  });

  // Three small device-local maps still clone on the live path: Settings for
  // the duplicate rules, Session window bindings and the named-Session identity
  // index for drift. None of them scales with the saved library.
  const ok = after.savedReads === 0 && after.clones <= 3 && after.ms <= budgetMs;
  if (!ok) failures += 1;
  rows.push({
    tier,
    beforeMs: before.ms.toFixed(2), beforeClones: before.clones,
    afterMs: after.ms.toFixed(2), afterClones: after.clones, afterSavedReads: after.savedReads,
    storageFlushMs: `${unshared.ms.toFixed(1)} -> ${shared.ms.toFixed(1)}`,
    storageFlushClones: `${unshared.clones} -> ${shared.clones}`,
    budgetMs, result: ok ? "PASS" : "FAIL"
  });
  assert.equal(after.savedReads, 0, `${tier}: a tab burst performs no saved-family storage read`);
  assert.ok(after.clones <= 3, `${tier}: a tab burst clones no saved-library map (${after.clones})`);
  assert.equal(shared.clones, unshared.clones - 3,
    `${tier}: a shared nav+attention flush removes two Inbox clones and one Snoozed clone`);
}

console.log("\nTab-event burst beyond the Open rebuild (Node compute, median of 5)");
console.table(rows);
if (failures) {
  console.error(`${failures} tab-burst budget assertion(s) FAILED`);
  process.exit(1);
}
dom.restore();
console.log("PASS: tab events refresh live counts without saved-library clones");
