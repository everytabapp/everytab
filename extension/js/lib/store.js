import {
  SCHEMA_VERSION, DEFAULT_SETTINGS, STORE_KEYS, ARCHIVE_OVERLAY_KEY
} from "./types.js";
import { normalizeSchemeSelection } from "./custom-schemes.js";
import { pspan } from "./perf.js";
import {
  SESSION_IDENTITY_INDEX_KEY, buildSessionIdentityIndex, isSessionIdentityIndex
} from "./session-identity-index.js";
import { sealJournalCommit } from "./journal-state.js";

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
/** @type {Map<string, number>} */
const readGenerations = new Map();
let listenedOnChanged = null;

const cloneSnapshot = (value) => structuredClone(value);
const generationOf = (key) => readGenerations.get(key) ?? 0;

function invalidateReadCache(keys) {
  const expanded = new Set(keys);
  // Archive is one logical map backed by a base + small live-write overlay.
  // Either physical key invalidates the same composite read snapshot.
  if (expanded.has(ARCHIVE_OVERLAY_KEY)) expanded.add(STORE_KEYS.archive);
  for (const key of expanded) {
    readGenerations.set(key, generationOf(key) + 1);
    readCache.delete(key);
  }
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local") return;
  invalidateReadCache(Object.keys(changes));
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
  invalidateReadCache(readCache.keys());
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

async function getFreshMaps(keys) {
  const physicalKeys = [...new Set(keys)];
  const wantsArchive = physicalKeys.includes(STORE_KEYS.archive);
  if (wantsArchive && !physicalKeys.includes(ARCHIVE_OVERLAY_KEY)) {
    physicalKeys.push(ARCHIVE_OVERLAY_KEY);
  }
  const maps = await chrome.storage.local.get(physicalKeys);
  if (wantsArchive) {
    // Restore checkpoints need the exact physical base as well as the logical
    // Archive view. Keep it on a non-enumerable symbol so ordinary mutators
    // cannot accidentally persist this adapter detail by spreading `maps`.
    Object.defineProperty(maps, ARCHIVE_BASE_SNAPSHOT, {
      value: maps[STORE_KEYS.archive] ?? {},
      enumerable: false
    });
    maps[STORE_KEYS.archive] = mergeArchiveMaps(
      maps[STORE_KEYS.archive],
      maps[ARCHIVE_OVERLAY_KEY]
    );
  }
  return maps;
}

async function getFreshMap(key) {
  const r = await getFreshMaps([key]);
  return r[key] ?? {};
}

async function getMap(key) {
  if (!cacheAvailable()) return getFreshMap(key);

  while (true) {
    const generation = generationOf(key);
    const cached = readCache.get(key);
    if (cached?.generation === generation) {
      const value = cached.value ?? await cached.pending;
      if (generation === generationOf(key)) return cloneSnapshot(value);
      continue;
    }

    const pending = getFreshMap(key);
    const entry = { generation, pending };
    readCache.set(key, entry);
    let value;
    try {
      value = await pending;
    } catch (error) {
      if (readCache.get(key) === entry) readCache.delete(key);
      throw error;
    }
    if (generation !== generationOf(key) || readCache.get(key) !== entry) continue;
    // chrome.storage already returned an object owned by this module. Keep it
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
  // A writer that replaces the logical Archive has read base + overlay under
  // the lock. Persist that merged snapshot and clear the overlay in the SAME
  // atomic set so no record can be duplicated, hidden, or dropped.
  if (STORE_KEYS.archive in committed && !(ARCHIVE_OVERLAY_KEY in committed)) {
    committed[ARCHIVE_OVERLAY_KEY] = {};
  }
  // N46/N46r: every canonical Session commit carries its compact named-Session
  // identity + drift-membership read model in the same atomic storage set.
  // Automatic snapshots remain untouched in the full map but never re-enter
  // Open's first-paint path.
  if (STORE_KEYS.sessions in committed) {
    committed[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(
      committed[STORE_KEYS.sessions]
    );
  }
  await chrome.storage.local.set(committed);
  invalidateReadCache(Object.keys(committed));
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
  return navigator.locks.request("everytab-store", { mode: "exclusive" }, fn);
}

/**
 * Additive one-time backfill for profiles created before the named-Session
 * identity index. It never rewrites or removes Session/snapshot data. The
 * shared store lock prevents a concurrent Session mutation from being followed
 * by a stale projection.
 */
export async function ensureSessionIdentityIndex() {
  const existing = await chrome.storage.local.get(SESSION_IDENTITY_INDEX_KEY);
  if (isSessionIdentityIndex(existing[SESSION_IDENTITY_INDEX_KEY])) {
    return existing[SESSION_IDENTITY_INDEX_KEY];
  }

  return withStoreLock(async () => {
    const current = await chrome.storage.local.get(SESSION_IDENTITY_INDEX_KEY);
    if (isSessionIdentityIndex(current[SESSION_IDENTITY_INDEX_KEY])) {
      return current[SESSION_IDENTITY_INDEX_KEY];
    }
    const stored = await chrome.storage.local.get(STORE_KEYS.sessions);
    const index = buildSessionIdentityIndex(stored[STORE_KEYS.sessions] ?? {});
    await chrome.storage.local.set({ [SESSION_IDENTITY_INDEX_KEY]: index });
    return index;
  });
}

/**
 * Atomic batch: read the named keys FRESH under the lock, hand them to a pure
 * mutator, and commit every produced key in ONE chrome.storage.local.set —
 * a single atomic commit point, so a crash either committed the whole intent
 * or none of it (E2-0c converts the multi-set domain sequences to this).
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
      await commitStores(sets); // ONE set = the atomic commit point
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
 * E3-2: how many live records a store holds, without materialising or sorting
 * them. The navigation counts only ever wanted `.length`, and paying for a
 * full array plus a sort per count is the kind of work that shows up as boot
 * time on a large profile.
 * @param {string} key @returns {Promise<number>}
 */
export async function countItems(key) {
  const map = await getMap(key);
  let n = 0;
  for (const id in map) if (!map[id].deletedAt) n += 1;
  return n;
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
  const map = await getFreshMap(key);
  return map[id] ?? null;
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
  // N3 migration (additive): derive the new minute-granular auto-dump threshold
  // from the legacy day value when it's absent, so existing installs keep their
  // threshold. `autoArchiveDays` stays written for back-compat.
  if (stored.autoDumpAfterMinutes == null) {
    s.autoDumpAfterMinutes = Math.max(1, Number(s.autoArchiveDays) || 7) * 1440;
  }
  // D3 permanent read alias: pre-beta installs that selected Everforest keep
  // their choice after the canonical key/display name became Matcha.
  s.uiScheme = normalizeSchemeSelection(s.uiScheme);
  s.oneNewTabPerWindow = typeof stored.oneNewTabPerWindow === "boolean"
    ? stored.oneNewTabPerWindow
    : DEFAULT_SETTINGS.oneNewTabPerWindow;
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
 * @param {Partial<import("./types.js").Settings>} patch
 */
export async function patchSettings(patch) {
  await withStoreLock(async () => {
    const s = { ...settingsFromStored(await getFreshMap(SETTINGS_KEY)), ...patch };
    await commitStores({ [SETTINGS_KEY]: s, settingsModifiedAt: Date.now() });
  });
}
