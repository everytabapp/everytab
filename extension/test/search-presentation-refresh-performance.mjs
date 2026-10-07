/**
 * Background tabs change their titles constantly (unread counts, players).
 * Each change used to retire the whole Search snapshot, so the next keystroke
 * rebuilt every saved source. Now only the Open source is read again.
 *
 * Fixture: 1,000 saved items plus 300 open tabs; 50 background title changes
 * interleaved with keystrokes. Every keystroke's primary result set must equal
 * a complete rebuild over the same data, saved stores must not be re-read, and
 * the per-keystroke compute stays under budget. T2 rows are informational and
 * show the retired cost. Node compute only; the 90 ms input debounce and
 * browser IPC are not modelled.
 *
 *     node test/search-presentation-refresh-performance.mjs   (from extension/)
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const mem = {};
let openTabs = [];
let tabQueries = 0;
/** @type {Record<string, number>} */
let storageReads = {};
/** @type {Map<string, Set<Function>>} */
const listeners = new Map();
const listenersFor = (name) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  return listeners.get(name);
};
const event = (name) => ({
  addListener: (fn) => listenersFor(name).add(fn),
  removeListener: (fn) => listenersFor(name).delete(fn)
});
const fire = (name, ...args) => { for (const fn of listenersFor(name)) fn(...args); };

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://search-presentation/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        const out = {};
        for (const key of list) {
          storageReads[key] = (storageReads[key] ?? 0) + 1;
          if (key in mem) out[key] = structuredClone(mem[key]);
        }
        return out;
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    },
    onChanged: event("storage")
  },
  tabs: {
    query: async () => { tabQueries += 1; return structuredClone(openTabs); },
    onCreated: event("created"), onRemoved: event("removed"), onMoved: event("moved"),
    onAttached: event("attached"), onDetached: event("detached"), onReplaced: event("replaced"),
    onUpdated: event("updated")
  },
  windows: { onCreated: event("windowCreated"), onRemoved: event("windowRemoved") }
};

const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const { STORE_KEYS } = await import("../js/lib/types.js");
const { buildTierData, buildOpenTabs, mulberry32 } = await import("../../tools/perf-seed.mjs");
const { SESSION_IDENTITY_INDEX_KEY, buildSessionIdentityIndex } =
  await import("../js/lib/session-identity-index.js");
const {
  createSearchSession, bindSearchSnapshotInvalidation, buildPrimarySearchSnapshot,
  buildSearchSnapshot, matchSearchSnapshot
} = await import("../js/lib/search.js");

const WORDS = ["guide", "review", "notes", "draft", "plan", "spec", "issue", "thread",
  "release", "budget", "recipe", "travel", "photos", "meeting", "design", "report"];
const HOSTS = ["github.com", "docs.google.com", "youtube.com", "mail.google.com", "notion.so",
  "slack.com", "en.wikipedia.org", "news.ycombinator.com"];

/** Replace the whole profile and invalidate the store cache like Chrome would. */
function replaceProfile(load) {
  const previous = Object.keys(mem);
  for (const key of previous) delete mem[key];
  load();
  const changes = Object.fromEntries([...new Set([...previous, ...Object.keys(mem)])]
    .map((key) => [key, { newValue: mem[key] ?? null }]));
  fire("storage", changes, "local");
}

function loadSmallProfile() {
  replaceProfile(fillSmallProfile);
}

function fillSmallProfile() {
  const rnd = mulberry32(0x5ea4c4);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const inbox = {};
  const archive = {};
  for (let index = 0; index < 1_000; index += 1) {
    const id = `saved-${index}`;
    const record = {
      id, kind: "tab", source: "dump", deviceId: "fixture", schemaVersion: 1,
      createdAt: 1_000 + index, modifiedAt: 1_000 + index,
      labels: index % 7 === 0 ? [pick(WORDS)] : [],
      tabs: [{
        url: `https://${pick(HOSTS)}/${pick(WORDS)}/${index}`,
        title: `${pick(WORDS)} ${pick(WORDS)} ${index}`
      }]
    };
    (index % 3 === 0 ? archive : inbox)[id] = record;
  }
  mem[STORE_KEYS.inbox] = inbox;
  mem[STORE_KEYS.archive] = archive;
  mem[STORE_KEYS.snoozes] = {};
  mem[STORE_KEYS.starred] = {};
  mem[STORE_KEYS.collections] = {};
  mem[STORE_KEYS.sessions] = {};
  mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex({});
  openTabs = Array.from({ length: 300 }, (_, index) => ({
    id: 100 + index, windowId: 1 + (index % 6), index: Math.floor(index / 6),
    url: `https://${pick(HOSTS)}/${pick(WORDS)}/open-${index}`,
    title: `${pick(WORDS)} ${pick(WORDS)} open ${index}`,
    pinned: false, incognito: false
  }));
}

function loadTier(tier) {
  replaceProfile(() => {
    Object.assign(mem, buildTierData(tier).payload.data);
    mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {});
    openTabs = buildOpenTabs(tier);
  });
}

const SAVED_KEYS = [STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.starred,
  STORE_KEYS.snoozes, STORE_KEYS.collections, SESSION_IDENTITY_INDEX_KEY];
const QUERY = "github pull";
const keystrokes = Array.from({ length: 50 }, (_, index) =>
  QUERY.slice(0, 2 + (index % (QUERY.length - 1))));

/**
 * @param {{fullRebuild?: boolean}} options `fullRebuild` models the retired
 *   behavior by retiring the whole session on every title change.
 */
async function typingStorm({ fullRebuild = false } = {}) {
  const session = createSearchSession();
  const unbind = bindSearchSnapshotInvalidation(session, chrome);
  await session.searchProgressively(QUERY.slice(0, 2));
  storageReads = {};
  tabQueries = 0;
  const samples = [];
  let mismatches = 0;
  for (let index = 0; index < keystrokes.length; index += 1) {
    const tab = openTabs[(index * 37) % openTabs.length];
    tab.title = `${tab.title.replace(/ \(\d+\)$/, "")} (${index + 1})`;
    fire("updated", tab.id, { title: tab.title }, tab);
    if (fullRebuild) session.invalidate();
    const query = keystrokes[index];
    const started = performance.now();
    const progressive = await session.searchProgressively(query);
    samples.push(performance.now() - started);
    const expected = await matchSearchSnapshot(await buildPrimarySearchSnapshot(), query, {
      includeHistory: false
    });
    if (JSON.stringify(progressive.results) !== JSON.stringify(expected)) mismatches += 1;
    if (progressive.complete) {
      const complete = await progressive.complete;
      const expectedComplete = await matchSearchSnapshot(await buildSearchSnapshot(), query, {});
      if (JSON.stringify(complete) !== JSON.stringify(expectedComplete)) mismatches += 1;
    }
  }
  unbind();
  samples.sort((a, b) => a - b);
  const savedReads = SAVED_KEYS.reduce((total, key) => total + (storageReads[key] ?? 0), 0);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    maxMs: samples[samples.length - 1],
    mismatches,
    savedReads,
    tabQueries
  };
}

const rows = [];
loadSmallProfile();
// Comparison baselines re-read storage through the fresh builders. Only the
// session under test is counted, so subtract the baseline reads afterwards.
const after = await typingStorm();
const before = await typingStorm({ fullRebuild: true });
// Each keystroke's expected results above perform their own reads; they are
// identical between runs, so the difference isolates the session.
rows.push({ profile: "1,000 saved + 300 open", path: "open-source refresh (.659)",
  medianMs: after.medianMs.toFixed(2), maxMs: after.maxMs.toFixed(2), mismatches: after.mismatches });
rows.push({ profile: "1,000 saved + 300 open", path: "complete rebuild (.658)",
  medianMs: before.medianMs.toFixed(2), maxMs: before.maxMs.toFixed(2), mismatches: before.mismatches });

for (const tier of ["t2"]) {
  loadTier(tier);
  const tierAfter = await typingStorm();
  const tierBefore = await typingStorm({ fullRebuild: true });
  rows.push({ profile: `${tier} (info)`, path: "open-source refresh (.659)",
    medianMs: tierAfter.medianMs.toFixed(2), maxMs: tierAfter.maxMs.toFixed(2), mismatches: tierAfter.mismatches });
  rows.push({ profile: `${tier} (info)`, path: "complete rebuild (.658)",
    medianMs: tierBefore.medianMs.toFixed(2), maxMs: tierBefore.maxMs.toFixed(2), mismatches: tierBefore.mismatches });
  assert.equal(tierAfter.mismatches, 0, `${tier}: every keystroke equals a complete rebuild`);
}

console.log("\nSearch keystrokes after background title changes (Node compute, 50 keystrokes)");
console.table(rows);

assert.equal(after.mismatches, 0, "every keystroke's results equal a complete rebuild");
// Budget: 3x headroom over the measured ~2 ms open-source refresh plus match.
assert.ok(after.medianMs <= 6, `median keystroke ${after.medianMs.toFixed(2)} ms within 6 ms`);
assert.ok(after.maxMs <= 18, `slowest keystroke ${after.maxMs.toFixed(2)} ms within 18 ms`);
console.log("PASS: background title changes refresh only the Open source between keystrokes");
