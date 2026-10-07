// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  SCHEMA_VERSION, DEFAULT_SETTINGS, STORE_KEYS, ARCHIVE_OVERLAY_KEY,
  UI_LANGUAGE_VALUES, effectiveSnapshotKeep
} from "./types.js";
import { normalizeSchemeSelection } from "./custom-schemes.js";
import { normalizeWelcomePhrases } from "./welcome-phrases.js";
import { pspan } from "./perf.js";
import {
  SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY,
  buildSessionIdentityIndex, buildNamedSessionRecords,
  isSessionIdentityIndex, isNamedSessionRecords
} from "./session-identity-index.js";
import { sealJournalCommit } from "./journal-state.js";
import { unifiedAutomationExclusions } from "./tabs.js";
import {
  activeStorageAuthority, publishStorageRevision, storageChangedKeys
} from "./storage/authority-runtime.js";
import { STORAGE_AUTHORITY_KEY } from "./storage/authority-record.js";

const DEVICE_ID_KEY = "deviceId";
const SETTINGS_KEY = "settings";
const ARCHIVE_BASE_SNAPSHOT = Symbol("archive-base-snapshot");

/* ---------- E3-3: per-context read cache ----------
 * chrome.storage returns independent structured clones. Keep that contract on
 * both cache misses and hits: callers may sort or mutate their snapshot without
 * changing what another caller sees. Write read-modify-write paths bypass this
 * cache and keep reading fresh under the store lock.
 *
 * A generation closes the in-flight race: if storage changes while a get is
 * pending, that result is discarded and retried instead of repopulating the
 * cache with the pre-change value.
 */

/** @type {Map<string, {generation: number, value?: object, pending?: Promise<object>}>} */
const readCache = new Map();
// Search owns a display-only projection. It must never populate the complete
// record cache read by editors, restore/export, or read-modify-write operations.
/** @type {Map<string, {generation: number, value?: object, pending?: Promise<object>}>} */
const searchReadCache = new Map();
const cachedKeys = () => new Set([...readCache.keys(), ...searchReadCache.keys()]);
/** @type {Map<string, number>} */
const readGenerations = new Map();
let listenedOnChanged = null;

const cloneSnapshot = (value) => structuredClone(value);
const generationOf = (key) => readGenerations.get(key) ?? 0;
/**
 * Current read generation of one store key in this context. It advances on
 * every invalidation for that key, so a caller can tell whether data it read
 * earlier is still the data the cache would return now. It is not a lock and
 * never reads storage.
 * @param {string} key
 */
export function readGeneration(key) {
  return generationOf(key);
}

function invalidateReadCache(keys) {
  const expanded = new Set(keys);
  // Archive is one logical map backed by a base + small live-write overlay.
  // Either physical key invalidates the same composite read snapshot.
  if (expanded.has(ARCHIVE_OVERLAY_KEY)) expanded.add(STORE_KEYS.archive);
  // Named Session writes live in a small derived physical map, but every
  // ordinary reader still consumes the complete logical Session view.
  if (expanded.has(NAMED_SESSION_RECORDS_KEY)) expanded.add(STORE_KEYS.sessions);
  for (const key of expanded) {
    readGenerations.set(key, generationOf(key) + 1);
    readCache.delete(key);
    searchReadCache.delete(key);
  }
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local") return;
  if (changes[STORAGE_AUTHORITY_KEY]) {
    invalidateReadCache(cachedKeys());
  }
  invalidateReadCache([...Object.keys(changes), ...storageChangedKeys(changes)]);
}

/**
 * Tests replace chrome.storage doubles between cases. Register lazily so the
 * cache follows the active event source; real extension contexts register once.
 * Without an onChanged source caching is unsafe, so fall back to fresh reads.
 */
function cacheAvailable() {
  const onChanged = chrome.storage?.onChanged;
  if (!onChanged?.addListener) return false;
  if (onChanged === listenedOnChanged) return true;
  listenedOnChanged?.removeListener?.(onStorageChanged);
  invalidateReadCache(cachedKeys());
  onChanged.addListener(onStorageChanged);
  listenedOnChanged = onChanged;
  return true;
}

export function mergeArchiveMaps(base = {}, overlay = {}) {
  const merged = { ...base };
  for (const [id, item] of Object.entries(overlay)) {
    const current = merged[id];
    if (!current || (item?.modifiedAt ?? 0) >= (current?.modifiedAt ?? 0)) {
      merged[id] = item;
    }
  }
  return merged;
}

async function getFreshMaps(keys, { includeFavicons = true } = {}) {
  const requested = [...new Set(keys)];
  const physical = [...requested];
  const wantsArchive = requested.includes(STORE_KEYS.archive);
  const wantsSessions = requested.includes(STORE_KEYS.sessions);
  if (wantsArchive && !physical.includes(ARCHIVE_OVERLAY_KEY)) {
    physical.push(ARCHIVE_OVERLAY_KEY);
  }
  if (wantsSessions && !physical.includes(NAMED_SESSION_RECORDS_KEY)) {
    physical.push(NAMED_SESSION_RECORDS_KEY);
  }
  const maps = await (await activeStorageAuthority()).readMaps(physical, { includeFavicons });
  if (wantsArchive) {
    Object.defineProperty(maps, ARCHIVE_BASE_SNAPSHOT, {
      value: maps[STORE_KEYS.archive] ?? {},
      enumerable: false
    });
    maps[STORE_KEYS.archive] = mergeArchiveMaps(
      maps[STORE_KEYS.archive], maps[ARCHIVE_OVERLAY_KEY]
    );
  }
  if (wantsSessions) {
    maps[STORE_KEYS.sessions] = mergeSessionMaps(
      maps[STORE_KEYS.sessions], maps[NAMED_SESSION_RECORDS_KEY]
    );
  }
  return maps;
}

/**
 * Logical Session view used by both storage adapters. Full named records in
 * the small projection win by merge timestamp, so named writes stay
 * proportional to named Sessions rather than the Snapshot history.
 */
export function mergeSessionMaps(base = {}, named = {}) {
  const merged = { ...base };
  for (const [id, item] of Object.entries(named ?? {})) {
    const current = merged[id];
    if (!current || (item?.modifiedAt ?? 0) >= (current?.modifiedAt ?? 0)) {
      merged[id] = item;
    }
  }
  return merged;
}

async function getFreshMap(key, options) {
  const r = await getFreshMaps([key], options);
  return r[key] ?? {};
}

async function getMap(key, { includeFavicons = true } = {}) {
  const cache = includeFavicons ? readCache : searchReadCache;
  const read = () => getFreshMap(key, { includeFavicons });
  if (!cacheAvailable()) return read();

  while (true) {
    const generation = generationOf(key);
    const cached = cache.get(key);
    if (cached?.generation === generation) {
      const value = cached.value ?? await cached.pending;
      if (generation === generationOf(key)) return cloneSnapshot(value);
      continue;
    }

    const pending = read();
    const entry = { generation, pending };
    cache.set(key, entry);
    let value;
    try {
      value = await pending;
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
    if (generation !== generationOf(key) || cache.get(key) !== entry) continue;
    // Storage already returned an object owned by this module. Keep it
    // private as the cache snapshot and clone only at the caller boundary.
    entry.value = value;
    delete entry.pending;
    return cloneSnapshot(entry.value);
  }
}

/**
 * Read one arbitrary local map through the same invalidated per-context cache
 * as the typed list helpers. Used by display-only composite snapshots whose
 * auxiliary map is not one of STORE_KEYS (for example sessionWindows).
 */
export async function readStoreMap(key) {
  return getMap(key);
}

/** Fresh logical map for lock-held merge/import paths that must bypass cache. */
export async function readFreshStoreMap(key) {
  return getFreshMap(key);
}

/**
 * Read device-local scalar or nullable state without changing a missing value
 * into an empty record map. Record families should continue to use
 * readStoreMap/readFreshStoreMap.
 */
export async function readStoreValue(key) {
  const values = await getFreshMaps([key]);
  return values[key];
}

/**
 * Fresh coherent logical values for Export, Restore, and other lock-held
 * boundaries that span more than one family.
 */
export async function readFreshStoreMaps(keys) {
  return getFreshMaps(keys);
}

/**
 * Exact physical Archive base captured by a mutateStores read. The mutator
 * still receives `maps[STORE_KEYS.archive]` as the merged logical map.
 * @param {Record<string, any>} maps
 */
export function archiveBaseFromMutationMaps(maps) {
  return maps?.[ARCHIVE_BASE_SNAPSHOT] ?? maps?.[STORE_KEYS.archive] ?? {};
}

/**
 * The writing context cannot wait for its own onChanged delivery: once set()
 * resolves, the commit is visible and its cached keys are dropped immediately.
 */
async function commitStores(sets) {
  const committed = { ...sets };
  // Archive callers supply one logical map. The authority translates the
  // legacy overlay-shaped input into entity operations in the Library commit.
  if (STORE_KEYS.archive in committed && !(ARCHIVE_OVERLAY_KEY in committed)) {
    committed[ARCHIVE_OVERLAY_KEY] = {};
  }
  // Named Session records and their identity/membership projection share the
  // Library transaction. Automatic Snapshots are routed separately to Recovery.
  if (STORE_KEYS.sessions in committed) {
    committed[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(
      committed[STORE_KEYS.sessions]
    );
    // Full logical Session writes also carry the named-only projection used
    // by fast edits. The authority requires both supplied maps to agree.
    committed[NAMED_SESSION_RECORDS_KEY] = buildNamedSessionRecords(
      committed[STORE_KEYS.sessions]
    );
  }
  const authority = await activeStorageAuthority();
  let result;
  try {
    result = await authority.commitMaps(committed);
  } finally {
    // The IndexedDB commit is authoritative, and it may have completed even
    // when a later ordered Recovery effect rejects. Invalidate this writer
    // before the separately fallible cross-context notification; publication
    // retries from the durable revision and can never make this successful
    // write look lost.
    invalidateReadCache(Object.keys(committed));
  }
  if (result.revision) {
    await publishStorageRevision(result.revision, {}, {
      authority,
      storeLockHeld: true
    });
  }
}

/** @returns {Promise<string>} */
export async function getDeviceId() {
  const r = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (r[DEVICE_ID_KEY]) return r[DEVICE_ID_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  return id;
}

/**
 * Fresh merge metadata for a new record.
 * @returns {Promise<import("./types.js").Meta>}
 */
export async function newMeta() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    deviceId: await getDeviceId(),
    createdAt: now,
    modifiedAt: now,
    schemaVersion: SCHEMA_VERSION
  };
}

/* ---------- E2-0b: cross-context write coordination (e2-0-storage-concurrency.md §4) ----------
 * All storage read-modify-write goes through ONE exclusive Web Lock,
 * "everytab-store", shared by every extension context (pages + the MV3 service
 * worker share the chrome-extension://<id> origin — live-verified §4.6). The
 * lock auto-releases if a context dies, so a killed worker can never wedge the
 * store. Locks are NOT reentrant: never call a lock-taking function from
 * inside another one's critical section (see undoActionResult in journal.js for the
 * hoisting pattern). Reads for display take no lock — they are snapshots and
 * the UI re-renders on storage.onChanged.
 */

/**
 * Exclusive cross-context write gate. No feature detection: navigator.locks
 * exists in every extension context on Chrome ≥ 69; a missing API must throw
 * loudly rather than silently skip coordination. (Node tests install a mock
 * LockManager on globalThis.navigator before importing this module.)
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withStoreLock(fn) {
  return navigator.locks.request("everytab-store", { mode: "exclusive" }, () => fn());
}

/** Called only while holding Store; older map-shaped test adapters have no repair work. */
async function publishLibraryRevision(authority, families = []) {
  const commitRevision = authority?.commitLibraryRevision ?? authority?.commitRemoteRevision;
  if (typeof commitRevision !== "function") return;
  const revision = await commitRevision(families);
  if (!revision) return;
  invalidateReadCache(revision.changedKeys);
  await publishStorageRevision(revision, {}, { authority, storeLockHeld: true });
}

/**
 * Commit a Library mutation initiated outside the ordinary map-shaped product
 * API (currently Vault pull and exact Restore). The caller must already hold
 * the Vault lock, establishing the sole Vault -> Store lock order. Filesystem
 * work stays outside this seam: `apply` may touch only the local Library.
 *
 * The Library result supplies either remote `changedFamilies` or exact-Restore
 * `changes`. Rebuild and durably store the exact logical revision, then publish
 * it before releasing the Store lock so cross-context pulses cannot overtake
 * the commits they describe.
 *
 * @template T
 * @param {() => Promise<T>} apply
 * @param {{authority?: ReturnType<typeof import("./storage/local-authority.js").createStorageAuthority>}} [options]
 * @returns {Promise<T>}
 */
export async function commitLibraryChange(apply, { authority = null } = {}) {
  if (typeof apply !== "function") throw new Error("A Storage Library change is required");
  return withStoreLock(async () => {
    const selected = authority ?? await activeStorageAuthority();
    const commitRevision = selected?.commitLibraryRevision ?? selected?.commitRemoteRevision;
    if (typeof commitRevision !== "function") {
      throw new Error("The Storage authority is required for a Library change");
    }
    const result = await apply();
    const changedFamilies = [...new Set([
      ...(Array.isArray(result?.changedFamilies) ? result.changedFamilies : []),
      ...(Array.isArray(result?.changes)
        ? result.changes.map((change) => change?.entity?.family) : [])
    ].filter((family) => typeof family === "string" && family))];
    // The Library commit already succeeded. Never retain a pre-commit snapshot
    // in this context even if revision construction or publication later fails.
    invalidateReadCache(changedFamilies);
    // A replayed batch may have no changes because its cursor already committed.
    // The authority also consumes durable repair intent from that earlier apply.
    await publishLibraryRevision(selected, changedFamilies);
    return result;
  });
}

/**
 * Additive one-time backfill for profiles created before the named-Session
 * identity index. It never rewrites or removes Session/snapshot data. The
 * shared store lock prevents a concurrent Session mutation from being followed
 * by a stale projection.
 */
export async function ensureSessionIdentityIndex() {
  const existing = await getFreshMaps([
    SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY
  ]);
  if (isSessionIdentityIndex(existing[SESSION_IDENTITY_INDEX_KEY]) &&
      isNamedSessionRecords(existing[NAMED_SESSION_RECORDS_KEY])) {
    return existing[SESSION_IDENTITY_INDEX_KEY];
  }

  return withStoreLock(async () => {
    const current = await getFreshMaps([
      SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY
    ]);
    if (isSessionIdentityIndex(current[SESSION_IDENTITY_INDEX_KEY]) &&
        isNamedSessionRecords(current[NAMED_SESSION_RECORDS_KEY])) {
      return current[SESSION_IDENTITY_INDEX_KEY];
    }
    const stored = await getFreshMaps([STORE_KEYS.sessions]);
    const sessions = stored[STORE_KEYS.sessions] ?? {};
    const index = isSessionIdentityIndex(current[SESSION_IDENTITY_INDEX_KEY])
      ? current[SESSION_IDENTITY_INDEX_KEY]
      : buildSessionIdentityIndex(sessions);
    const named = isNamedSessionRecords(current[NAMED_SESSION_RECORDS_KEY])
      ? current[NAMED_SESSION_RECORDS_KEY]
      : buildNamedSessionRecords(sessions);
    await commitStores({
      [SESSION_IDENTITY_INDEX_KEY]: index,
      [NAMED_SESSION_RECORDS_KEY]: named
    });
    return index;
  });
}

/**
 * Read named keys fresh under the Store lock, then commit a pure mutation.
 * Portable records and local companion state share one Library transaction.
 * Recovery Snapshot writes are separate, ordered effects; cross-context
 * notification happens after persistence and can retry independently.
 * Keys absent from storage are absent from `maps` — the mutator defaults them.
 * @param {string[]} keys store keys the mutator may read and write
 * @param {(maps: Record<string, any>) => (Record<string, any>|null)} mutate
 *   pure; builds puts/tombstones/journal/counters; null = validated no-op
 * @returns {Promise<boolean>} false = no-op
 */
export async function mutateStores(keys, mutate) {
  const detail = keys.join(",");
  const endLockWait = pspan("store:lock-wait");
  return withStoreLock(async () => {
    endLockWait(detail);
    await publishLibraryRevision(await activeStorageAuthority());
    const endRead = pspan("store:locked-read");
    let maps;
    try {
      maps = await getFreshMaps(keys);
    } finally {
      endRead(detail);
    }
    const endMutate = pspan("store:mutate");
    let sets;
    try {
      sets = mutate(maps);
    } finally {
      endMutate(detail);
    }
    if (!sets) return false;
    sets = sealJournalCommit(maps, sets);
    const endCommit = pspan("store:commit");
    try {
      await commitStores(sets);
    } finally {
      endCommit(Object.keys(sets).join(","));
    }
    return true;
  });
}

/**
 * Atomic named-Session mutation without loading or writing automatic
 * Snapshots. Callers receive the usual logical `maps.sessions` interface, but
 * it is backed by the complete derived named-record map. Journal post-state
 * sealing therefore stays unchanged, while the physical commit contains only
 * named records plus the compact identity projection.
 *
 * Automatic Snapshot code must continue through `mutateStores`.
 * @param {string[]} keys must include STORE_KEYS.sessions
 * @param {(maps: Record<string, any>) => (Record<string, any>|null)} mutate
 */
export async function mutateNamedSessionStores(keys, mutate) {
  if (!keys.includes(STORE_KEYS.sessions)) {
    throw new TypeError("Named Session mutation requires the sessions store");
  }
  await ensureSessionIdentityIndex();
  const physicalKeys = keys.map((key) =>
    key === STORE_KEYS.sessions ? NAMED_SESSION_RECORDS_KEY : key
  );
  const detail = keys.join(",");
  const endLockWait = pspan("store:lock-wait");
  return withStoreLock(async () => {
    endLockWait(detail);
    await publishLibraryRevision(await activeStorageAuthority());
    const endRead = pspan("store:locked-read");
    let maps;
    try {
      maps = await getFreshMaps(physicalKeys);
      maps[STORE_KEYS.sessions] = maps[NAMED_SESSION_RECORDS_KEY] ?? {};
    } finally {
      endRead(detail);
    }
    const endMutate = pspan("store:mutate");
    let sets;
    try {
      sets = mutate(maps);
    } finally {
      endMutate(detail);
    }
    if (!sets) return false;
    sets = sealJournalCommit(maps, sets);
    if (STORE_KEYS.sessions in sets) {
      const named = sets[STORE_KEYS.sessions] ?? {};
      if (!isNamedSessionRecords(named)) {
        throw new TypeError("Named Session mutation produced an automatic or malformed record");
      }
      delete sets[STORE_KEYS.sessions];
      sets[NAMED_SESSION_RECORDS_KEY] = named;
      sets[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(named);
    }
    const endCommit = pspan("store:commit");
    try {
      await commitStores(sets);
      invalidateReadCache([STORE_KEYS.sessions]);
    } finally {
      endCommit(Object.keys(sets).join(","));
    }
    return true;
  });
}

/**
 * Live (non-tombstoned) items, newest first.
 * @param {string} key
 */
export async function listItems(key) {
  const map = await getMap(key);
  return Object.values(map)
    .filter((i) => !i.deletedAt)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Detached Search-only records, with favicon payloads omitted at storage read.
 * The projection cache shares revision generations with complete reads but never
 * supplies them. Completion uses fresh Sessions so large Snapshot maps are transient.
 * @param {string} key
 * @param {{fresh?: boolean}} [options]
 */
export async function listSearchItems(key, { fresh = false } = {}) {
  const map = fresh
    ? await getFreshMap(key, { includeFavicons: false })
    : await getMap(key, { includeFavicons: false });
  // Transient completion has historically treated missing legacy timestamps
  // as zero. Ordinary source ordering retains listItems' existing behavior.
  const items = Object.values(map);
  return fresh
    ? items.filter((item) => !item?.deletedAt)
      .sort((a, b) => (b?.modifiedAt ?? 0) - (a?.modifiedAt ?? 0))
    : items.filter((item) => !item.deletedAt)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Named Sessions only, without opening or cloning the Recovery Snapshot store.
 */
export async function listNamedSessions() {
  const map = await getMap(NAMED_SESSION_RECORDS_KEY);
  return Object.values(map)
    .filter((session) => session && !session.deletedAt && !session.auto)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Named Session records plus a count-only automatic-Snapshot projection. */
export async function readSessionNavigationData() {
  return (await activeStorageAuthority()).readSessionNavigation();
}

/**
 * Live record count without materialising or sorting a list. Bundles count as
 * one record here; callers that display saved tab totals use countInboxTabs.
 * @param {string} key @returns {Promise<number>}
 */
export async function countItems(key) {
  const map = await getMap(key);
  let n = 0;
  for (const id in map) if (!map[id].deletedAt) n += 1;
  return n;
}

/**
 * Saved tab occurrences in one live Inbox record.
 * @param {import("./types.js").InboxItem|null|undefined} item
 * @returns {number}
 */
export function inboxItemTabCount(item) {
  return item && !item.deletedAt && Array.isArray(item.tabs) ? item.tabs.length : 0;
}

/**
 * Saved tab occurrences in live Inbox records. Both single-tab saves and window
 * bundles carry tabs; an empty bundle contributes zero, not one saved tab.
 * @returns {Promise<number>}
 */
export async function countInboxTabs() {
  const map = await getMap(STORE_KEYS.inbox);
  let count = 0;
  for (const id in map) {
    count += inboxItemTabCount(map[id]);
  }
  return count;
}

/** One item by id (including tombstoned), or null. @param {string} key @param {string} id */
export async function getItem(key, id) {
  const map = await getMap(key);
  return map[id] ?? null;
}

/**
 * Command-time item lookup that deliberately bypasses the read cache. Use this
 * only when acting on an id carried by an older UI snapshot and stale acceptance
 * would perform the wrong mutation or browser action.
 * @param {string} key @param {string} id
 */
export async function getFreshItem(key, id) {
  return (await activeStorageAuthority()).readItem(key, id);
}

/** @param {string} key @param {import("./types.js").Meta} item */
export async function upsertItem(key, item) {
  await withStoreLock(async () => {
    const map = await getFreshMap(key);
    map[item.id] = { ...item, modifiedAt: Date.now() };
    await commitStores({ [key]: map });
  });
}

/** Soft-delete: tombstone so the deletion merges across devices. */
export async function tombstoneItem(key, id) {
  await withStoreLock(async () => {
    const map = await getFreshMap(key);
    const item = map[id];
    if (!item) return;
    const now = Date.now();
    map[id] = { ...item, deletedAt: now, modifiedAt: now };
    await commitStores({ [key]: map });
  });
}

/** @returns {Promise<import("./types.js").Settings>} */
export async function getSettings() {
  return settingsFromStored(await getMap(SETTINGS_KEY));
}

/** Fresh settings for a mutation boundary that must not trust a context cache. */
export async function getFreshSettings() {
  return settingsFromStored(await getFreshMap(SETTINGS_KEY));
}

export function settingsFromStored(stored) {
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // The two pre-unification keys remain stored for portable compatibility.
  // Runtime reads expose their union through both aliases, so neither an old
  // Auto-save nor Suspension protection can be lost and every effect sees the
  // same list. The next ordinary patch persists the non-destructive union.
  const automationExclusions = unifiedAutomationExclusions(s);
  s.archiveWhitelist = automationExclusions;
  s.suspendWhitelist = automationExclusions;
  // N3 migration (additive): derive the new minute-granular auto-dump threshold
  // from the legacy day value when it's absent, so existing installs keep their
  // threshold. `autoArchiveDays` stays written for back-compat.
  if (stored.autoDumpAfterMinutes == null) {
    s.autoDumpAfterMinutes = Math.max(1, Number(s.autoArchiveDays) || 7) * 1440;
  }
  // D3 permanent read alias: pre-beta installs that selected Everforest keep
  // their choice after the canonical key/display name became Matcha.
  s.uiScheme = normalizeSchemeSelection(s.uiScheme);
  // Command Deck was a pre-launch New Tab experiment. Preserve its stored value
  // in backups/Vault for compatibility, but retire it safely at the runtime
  // boundary so an existing profile opens the ordinary Dashboard immediately.
  if (s.newTabMode === "terminal") s.newTabMode = "dashboard";
  // Snapshot retention is bounded at read time. A stored 0 (once "keep all")
  // or a value above the maximum stays in the record but reads as the maximum.
  s.snapshotKeep = effectiveSnapshotKeep(s.snapshotKeep);
  s.oneNewTabPerWindow = typeof stored.oneNewTabPerWindow === "boolean"
    ? stored.oneNewTabPerWindow
    : DEFAULT_SETTINGS.oneNewTabPerWindow;
  s.newTabWelcomeEnabled = typeof stored.newTabWelcomeEnabled === "boolean"
    ? stored.newTabWelcomeEnabled
    : DEFAULT_SETTINGS.newTabWelcomeEnabled;
  s.newTabWelcomePhrases = normalizeWelcomePhrases(s.newTabWelcomePhrases);
  s.newTabWelcomeTone = ["clock", "accent"].includes(stored.newTabWelcomeTone)
    ? stored.newTabWelcomeTone
    : DEFAULT_SETTINGS.newTabWelcomeTone;
  // Interface style supersedes the two pre-launch geometry controls. Derive
  // only when the canonical field is absent so existing Soft/Crisp profiles
  // keep their appearance without rewriting portable legacy data.
  if (!Object.prototype.hasOwnProperty.call(stored, "uiInterfaceStyle")) {
    s.uiInterfaceStyle = stored.uiCornerStyle === "crisp" ? "crisp" : "soft";
  }
  return normalizeAppearanceSettings(s);
}

/**
 * D4 additive appearance normalization. Kept pure/exported so the read
 * contract is directly testable without a storage fixture.
 * @param {import("./types.js").Settings} settings
 * @returns {import("./types.js").Settings}
 */
export function normalizeAppearanceSettings(settings) {
  const s = { ...settings };
  const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  s.uiEmphasis = choice(s.uiEmphasis, ["bold", "muted"], DEFAULT_SETTINGS.uiEmphasis);
  s.uiCheckboxShape = choice(s.uiCheckboxShape, ["round", "square"], DEFAULT_SETTINGS.uiCheckboxShape);
  s.uiCornerStyle = choice(s.uiCornerStyle, ["crisp", "soft"], DEFAULT_SETTINGS.uiCornerStyle);
  s.uiInterfaceStyle = choice(
    s.uiInterfaceStyle, ["soft", "crisp", "terminal"], DEFAULT_SETTINGS.uiInterfaceStyle
  );
  // A language this build does not package reads as "system"; the stored
  // value stays untouched so a newer build that adds it can honor it.
  s.uiLanguage = choice(s.uiLanguage, UI_LANGUAGE_VALUES, DEFAULT_SETTINGS.uiLanguage);
  s.uiRowInfo = choice(s.uiRowInfo, ["clean", "useful", "detailed"], DEFAULT_SETTINGS.uiRowInfo);
  s.uiUtilityLayout = choice(
    s.uiUtilityLayout, ["shelf", "rail", "compact"], DEFAULT_SETTINGS.uiUtilityLayout
  );
  s.uiWindowGrouping = choice(
    s.uiWindowGrouping, ["space", "divider", "accent-cap"], DEFAULT_SETTINGS.uiWindowGrouping
  );
  s.uiAccentCapStrength = choice(
    s.uiAccentCapStrength, ["fine", "bold"], DEFAULT_SETTINGS.uiAccentCapStrength
  );
  s.uiActionLabels = choice(
    s.uiActionLabels, ["named", "icons"], DEFAULT_SETTINGS.uiActionLabels
  );
  // D4-3a: the remembered wide-layout navigation choice is a strict boolean, so
  // a malformed stored value ("true", 1, null) reads as the expanded default.
  s.uiSidebarCollapsed = typeof s.uiSidebarCollapsed === "boolean"
    ? s.uiSidebarCollapsed
    : DEFAULT_SETTINGS.uiSidebarCollapsed;
  return s;
}

/**
 * @param {import("./types.js").Settings} s
 * settingsModifiedAt drives whole-object LWW against the vault's
 * settings.json (M5) — settings have no per-record merge metadata.
 * Whole-form write: last write wins the whole object by design. For patching
 * individual fields use patchSettings, which cannot clobber other surfaces.
 */
export async function saveSettings(s) {
  await withStoreLock(() =>
    commitStores({ [SETTINGS_KEY]: s, settingsModifiedAt: Date.now() })
  );
}

/**
 * E2-0b (§4.3): patch individual settings fields without the stale-base
 * clobber of saveSettings({...await getSettings(), patch}) — reads fresh
 * under the lock, shallow-merges, commits settings + settingsModifiedAt in
 * one set. Call sites migrate in E2-0e.
 * @param {Partial<import("./types.js").Settings>|((current: import("./types.js").Settings) => Partial<import("./types.js").Settings>|null)} patch
 */
export async function patchSettings(patch) {
  return withStoreLock(async () => {
    const stored = await getFreshMap(SETTINGS_KEY);
    const current = settingsFromStored(stored);
    const nextPatch = typeof patch === "function"
      ? patch(structuredClone(current))
      : patch;
    if (!nextPatch) return false;
    await commitStores({
      [SETTINGS_KEY]: {
        ...current,
        // Snapshot retention is bounded at read time only. An unrelated patch
        // must not rewrite a stored legacy value; only an explicit patch may.
        ...(Object.hasOwn(stored, "snapshotKeep") ? { snapshotKeep: stored.snapshotKeep } : {}),
        ...nextPatch
      },
      settingsModifiedAt: Date.now()
    });
    return true;
  });
}
