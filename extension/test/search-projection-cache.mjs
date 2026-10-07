/** Search projections and complete mutation records never share cached payloads. */
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: changes => { for (const fn of listeners) fn(changes, "local"); } };
};
let changed = event();
let state = { inbox: { one: { id: "one", modifiedAt: 1, labels: [],
  tabs: [{ title: "Original", url: "https://fixture.invalid/one", favIconUrl: "data:image/png;base64,AQ==" }] } } };
let reads = [];
let delayNext = null;
let rejectNext = false;
const project = value => JSON.parse(JSON.stringify(value), (key, child) => key === "favIconUrl" ? undefined : child);
const authority = {
  async readMaps(keys, { includeFavicons = true } = {}) {
    reads.push({ keys, includeFavicons });
    const value = Object.fromEntries(keys.map(key => [key, structuredClone(state[key] ?? {})]));
    if (rejectNext) { rejectNext = false; throw new Error("Synthetic read failure"); }
    if (delayNext) { const wait = delayNext; delayNext = null; await wait(); }
    return includeFavicons ? value : project(value);
  },
  async commitMaps(sets) { Object.assign(state, structuredClone(sets)); return { revision: null }; }
};
setStorageAuthorityForTests(authority);
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: { get: async () => ({ deviceId: "fixture" }) }, onChanged: changed }
};
Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: createMockLockManager() });
const store = await import("../js/lib/store.js");
const icon = state.inbox.one.tabs[0].favIconUrl;
const first = await store.listSearchItems("inbox");
assert.equal(first[0].tabs[0].favIconUrl, undefined);
first[0].tabs[0].title = "Caller mutation";
assert.equal((await store.listSearchItems("inbox"))[0].tabs[0].title, "Original");
assert.equal(reads.filter(read => read.keys.includes("inbox")).length, 1);
assert.equal((await store.listItems("inbox"))[0].tabs[0].favIconUrl, icon);
assert.equal(reads.filter(read => read.keys.includes("inbox")).length, 2, "full reads cannot reuse a projected cache");
assert.equal((await store.listItems("inbox"))[0].tabs[0].title, "Original");

// A local writer must evict both caches before any Chrome event is delivered.
await store.mutateStores(["inbox"], maps => {
  assert.equal(maps.inbox.one.tabs[0].favIconUrl, icon);
  maps.inbox.one.tabs[0].title = "Committed";
  return maps;
});
assert.equal(state.inbox.one.tabs[0].favIconUrl, icon);
assert.equal((await store.listSearchItems("inbox"))[0].tabs[0].title, "Committed");
assert.equal((await store.listItems("inbox"))[0].tabs[0].title, "Committed");

// A notification arriving during a projected read cannot populate a stale cache.
changed.fire({ inbox: {} });
let release;
let started;
const entered = new Promise(resolve => { started = resolve; });
delayNext = () => { started(); return new Promise(resolve => { release = resolve; }); };
const pending = store.listSearchItems("inbox");
await entered;
state.inbox.one.tabs[0].title = "Newer revision";
changed.fire({ inbox: {} });
release();
assert.equal((await pending)[0].tabs[0].title, "Newer revision");
assert.equal((await store.listItems("inbox"))[0].tabs[0].title, "Newer revision");

// Small cross-context revision pulses evict both representations, too.
const { STORAGE_REVISION_KEY } = await import("../js/lib/storage/constants.js");
state.inbox.one.tabs[0].title = "Published revision";
changed.fire({ [STORAGE_REVISION_KEY]: { newValue: { changedKeys: ["inbox"] } } });
assert.equal((await store.listSearchItems("inbox"))[0].tabs[0].title, "Published revision");
assert.equal((await store.listItems("inbox"))[0].tabs[0].title, "Published revision");
state.inbox.one.tabs[0].title = "Newer revision";

// Failed projection reads are retryable; full reads remain complete.
changed.fire({ inbox: {} }); rejectNext = true;
await assert.rejects(store.listSearchItems("inbox"), /Synthetic read failure/);
assert.equal((await store.listSearchItems("inbox"))[0].tabs[0].title, "Newer revision");
assert.equal((await store.listItems("inbox"))[0].tabs[0].favIconUrl, icon);

// Eviction must include keys present ONLY in the projection cache.
state.starred = { star: { id: "star", modifiedAt: 1, title: "Before replacement" } };
await store.listSearchItems("starred");
state.starred.star.title = "New authority";
changed.fire({ storageAuthority: {} });
assert.equal((await store.listSearchItems("starred"))[0].title, "New authority");
state.starred.star.title = "New event source";
changed = event(); chrome.storage.onChanged = changed;
assert.equal((await store.listSearchItems("starred"))[0].title, "New event source");

// Composite aliases evict the same projected logical map as full readers.
state.archive = { archived: { id: "archived", modifiedAt: 1, tabs: [] } };
await store.listSearchItems("archive");
state.archive.archived.modifiedAt = 3;
const { ARCHIVE_OVERLAY_KEY } = await import("../js/lib/types.js");
changed.fire({ [ARCHIVE_OVERLAY_KEY]: {} });
assert.equal((await store.listSearchItems("archive"))[0].modifiedAt, 3);
const { NAMED_SESSION_RECORDS_KEY } = await import("../js/lib/session-identity-index.js");
state.sessions = { session: { id: "session", modifiedAt: 1, windows: [] } };
await store.listSearchItems("sessions");
state.sessions.session.modifiedAt = 4;
changed.fire({ [NAMED_SESSION_RECORDS_KEY]: {} });
assert.equal((await store.listSearchItems("sessions"))[0].modifiedAt, 4);

// Fresh completion is transient and retains its legacy missing-time ordering.
state.sessions = { legacy: { id: "legacy", windows: [] }, newer: { id: "newer", modifiedAt: 8, windows: [] } };
const beforeFresh = reads.length;
assert.deepEqual((await store.listSearchItems("sessions", { fresh: true })).map(item => item.id), ["newer", "legacy"]);
await store.listSearchItems("sessions", { fresh: true });
assert.equal(reads.length, beforeFresh + 2);
console.log("PASS isolated Search/full caches, writer eviction, stale-read retry, failures, aliases and authority replacement");
