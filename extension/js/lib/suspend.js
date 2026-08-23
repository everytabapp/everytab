import { getSettings, mutateStores, withStoreLock } from "./store.js";
import { isHttpTab, urlOf, canonicalUrlOf, matchesWhitelist, isOwnSuspendPage } from "./tabs.js";
import { bump } from "./counters.js";

const ACTIVITY_KEY = "tabActivity";
const SUSPEND_REGISTRY_KEY = "suspendedRegistry";

/* ---------- N4: suspended-tab recovery registry ----------
 * Chrome closes every tab showing an extension page when the extension
 * reloads/updates — including our suspend.html tabs (the Great Suspender failure
 * mode). We persist a registry of the suspend.html tabs we create so the worker
 * can recreate them at boot. A user closing a suspended tab fires tabs.onRemoved
 * *while we're alive* → we drop that entry, so a close is never resurrected; a
 * reload kills us first, so those entries survive to be recovered.
 * @typedef {{originalUrl: string, title: string, favIconUrl?: string, windowId: number, index: number, pinned: boolean}} SuspendEntry
 */

/** @returns {Promise<Record<string, SuspendEntry>>} */
export async function getSuspendRegistry() {
  const r = await chrome.storage.local.get(SUSPEND_REGISTRY_KEY);
  return r[SUSPEND_REGISTRY_KEY] ?? {};
}

/** Record a freshly-suspended tab. @param {chrome.tabs.Tab} t @param {string} originalUrl */
export async function registerSuspended(t, originalUrl) {
  if (t.id === undefined) return;
  const entry = {
    originalUrl,
    title: t.title || originalUrl,
    ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {}),
    windowId: t.windowId,
    index: t.index,
    pinned: Boolean(t.pinned)
  };
  // E2-0e: atomic RMW under the store lock — the recovery registry is the
  // "never lose a suspended tab" data, so two concurrent registers must not
  // lose one another.
  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const reg = maps[SUSPEND_REGISTRY_KEY] ?? {};
    reg[t.id] = entry;
    return { [SUSPEND_REGISTRY_KEY]: reg };
  });
}

/** Drop a tab from the registry (woken, or the user closed it). @param {number} tabId */
export async function unregisterSuspended(tabId) {
  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const reg = maps[SUSPEND_REGISTRY_KEY] ?? {};
    if (!(tabId in reg)) return null; // nothing to remove — validated no-op
    delete reg[tabId];
    return { [SUSPEND_REGISTRY_KEY]: reg };
  });
}

/* ---------- N4b: the reload race ----------
 * In a real extension reload the new worker can boot while the old suspend.html
 * tabs are STILL OPEN — they die a beat later, when their renderer notices the
 * extension changed. Sequence that lost tabs in 0.8.8:
 *   boot → recovery sees them live → skips → Chrome closes them → onRemoved
 *   fires in the NEW worker → registry purged → nothing left to recover.
 * Fix: (1) onInstalled opens a GRACE WINDOW during which onRemoved never purges
 * the registry (a close in that window is assumed to be the reload, not the
 * user); (2) recovery re-runs after the dust settles (boot + 2s + 8s + a 30s
 * alarm), serialized so passes can't double-create.
 */
const RECOVERY_GRACE_KEY = "suspendRecoveryGraceUntil";
const RECOVERY_GRACE_MS = 30_000;

/** Open the grace window. Call FIRST in onInstalled, before any async work. */
export async function markRecoveryGrace() {
  // E2-0e: coordinate on the store lock like every other write.
  await withStoreLock(() =>
    chrome.storage.local.set({ [RECOVERY_GRACE_KEY]: Date.now() + RECOVERY_GRACE_MS })
  );
}

/** @returns {Promise<boolean>} true while the post-reload grace window is open */
export async function inRecoveryGrace() {
  const r = await chrome.storage.local.get(RECOVERY_GRACE_KEY);
  return Date.now() < (r[RECOVERY_GRACE_KEY] ?? 0);
}

/**
 * onRemoved handler for the registry: purge on a genuine user close, but keep
 * the entry during the post-reload grace window so recovery can resurrect it.
 * (Cost of the trade-off: a tab the user closes within ~30s of an extension
 * update may come back once. Wrong direction is losing tabs; this errs safe.)
 * @param {number} tabId
 */
export async function unregisterSuspendedOnClose(tabId) {
  if (await inRecoveryGrace()) return;
  await unregisterSuspended(tabId);
}

/** Serialize recovery passes — overlapping passes could double-create. */
let recoveryChain = Promise.resolve(0);
/** @returns {Promise<number>} tabs recovered in this pass */
export function queueRecovery() {
  recoveryChain = recoveryChain.then(() => recoverSuspendedTabs(), () => recoverSuspendedTabs());
  return recoveryChain;
}

/** Keep the last known placement when a partial Chrome test double or a race
 * omits one field; real live values always win. */
function withLivePlacement(info, tab) {
  return {
    ...info,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : info.windowId,
    index: Number.isInteger(tab?.index) ? tab.index : info.index,
    pinned: typeof tab?.pinned === "boolean" ? tab.pinned : Boolean(info.pinned)
  };
}

/**
 * At worker boot: recreate any registered suspend tab that's no longer live.
 * Present tabs (matched by tabId, or by a live suspend page with the same
 * originalUrl — a browser restart's own session-restore) are skipped, not
 * duplicated. The registry is re-keyed to the surviving/created tab ids (stale
 * entries pruned). Runs from background.js `startup()`.
 * @returns {Promise<number>} tabs recovered
 */
export async function recoverSuspendedTabs() {
  const reg = await getSuspendRegistry();
  const entries = Object.entries(reg);
  if (entries.length === 0) return 0;

  const base = chrome.runtime.getURL("suspend.html");
  const tabs = await chrome.tabs.query({});
  /* N4c: the liveness test must ask "is our suspend PAGE still there", not "does
   * a tab with this id still exist". Chrome does not always CLOSE an extension
   * page when the extension reloads — it can leave the tab open and navigate it
   * to the New Tab page (which renders Chrome's own default, because our
   * override is unregistered at that instant). The old test saw the surviving
   * tab id, concluded "still there", and skipped it on that pass and every pass
   * after it: the user's page was silently replaced by a blank new tab, with the
   * registry still pointing at it. */
  const liveById = new Map();
  /** @type {Map<number, {tab: chrome.tabs.Tab, originalUrl: string}>} */
  const liveSuspendById = new Map();
  /** @type {Map<string, chrome.tabs.Tab[]>} */
  const liveSuspendByOriginal = new Map();
  for (const t of tabs) {
    if (t.id !== undefined) liveById.set(t.id, t);
    const raw = t.url || t.pendingUrl || "";
    if (!raw.startsWith(base)) continue;
    try {
      const o = new URL(raw).searchParams.get("originalUrl");
      if (!o || t.id === undefined) continue;
      liveSuspendById.set(t.id, { tab: t, originalUrl: o });
      if (!liveSuspendByOriginal.has(o)) liveSuspendByOriginal.set(o, []);
      liveSuspendByOriginal.get(o).push(t);
    } catch { /* unparsable */ }
  }
  // A browser restart can restore an extension page in the right place under
  // completely new tab and window ids. Match each registry occurrence to one
  // live page, preferring an exact surviving id before URL fallback. The old
  // Set-of-URLs check proved only that *some* copy survived, then retained its
  // stale placement forever; a later extension reload recreated it in Chrome's
  // current window. One-to-one matching also preserves duplicate occurrences.
  const liveMatchByRegistryId = new Map();
  const claimedLiveIds = new Set();
  for (const [idStr, info] of entries) {
    const exact = liveSuspendById.get(Number(idStr));
    if (!exact || exact.originalUrl !== info.originalUrl) continue;
    liveMatchByRegistryId.set(idStr, exact.tab);
    claimedLiveIds.add(exact.tab.id);
  }
  for (const [idStr, info] of entries) {
    if (liveMatchByRegistryId.has(idStr)) continue;
    const candidates = liveSuspendByOriginal.get(info.originalUrl) ?? [];
    const fallback = candidates.find((tab) => !claimedLiveIds.has(tab.id));
    if (!fallback) continue;
    liveMatchByRegistryId.set(idStr, fallback);
    claimedLiveIds.add(fallback.id);
  }
  const wins = await chrome.windows.getAll({});
  const liveWindowIds = new Set(wins.map((w) => w.id));
  // Repairing a surviving tab in place is only safe while we know its page was
  // taken by the reload. Outside that window, a registered tab showing anything
  // else is the user having moved on, and must be left alone.
  const grace = await inRecoveryGrace();

  /** @type {Record<string, SuspendEntry>} */
  const next = {};
  let recovered = 0;
  for (const [idStr, info] of entries) {
    const liveMatch = liveMatchByRegistryId.get(idStr);
    if (liveMatch) {
      next[liveMatch.id] = withLivePlacement(info, liveMatch);
      // Our page is still there — refresh its current identity and placement.
      continue;
    }
    const params = new URLSearchParams({
      originalUrl: info.originalUrl,
      title: info.title || info.originalUrl,
      ...(info.favIconUrl ? { favIconUrl: info.favIconUrl } : {})
    });
    const suspendUrl = `${base}?${params}`;

    const survivor = liveById.get(Number(idStr));
    if (survivor) {
      /* The tab outlived its page. Repair THAT tab rather than creating a second
       * one, so the page comes back in its own window at its own position.
       *
       * Two guards, and both matter more than the repair does. Only inside the
       * grace window do we know a lost page is the reload's doing. And only when
       * the tab is NOT showing a real page: the fingerprint of the teardown is
       * the New Tab page, about:blank, or nothing at all. If a live http page is
       * there, the user is reading something — never navigate that away, whatever
       * the registry believes. */
      const rawUrl = survivor.url || survivor.pendingUrl || "";
      if (!grace || /^https?:/i.test(rawUrl)) continue; // not ours to touch → drop the entry
      try {
        await chrome.tabs.update(Number(idStr), { url: suspendUrl });
        recovered++;
        next[idStr] = withLivePlacement(info, survivor);
      } catch { /* gone between query and update — the next pass recreates it */ }
      continue;
    }

    const props = { url: suspendUrl, active: false, pinned: Boolean(info.pinned) };
    if (info.windowId != null && liveWindowIds.has(info.windowId)) {
      props.windowId = info.windowId;
      if (typeof info.index === "number") props.index = info.index;
    } // else: window gone → current window, appended at the end
    let created;
    try { created = await chrome.tabs.create(props); } catch { continue; }
    recovered++;
    if (created && created.id !== undefined) {
      next[created.id] = withLivePlacement(info, created);
    }
  }
  // E2-0e: authoritative boot rebuild — commit the re-keyed registry under the
  // store lock (recovery is serialized via recoveryChain and runs in the
  // post-reload grace window, so this is the single writer of the whole map).
  await withStoreLock(() => chrome.storage.local.set({ [SUSPEND_REGISTRY_KEY]: next }));
  return recovered;
}

/**
 * Per-tab last-activity map, shared by suspension (M3) and auto-archive (M4).
 * Storage-backed — MV3 worker has no memory.
 * @returns {Promise<Record<number, number>>}
 */
export async function getActivityMap() {
  const r = await chrome.storage.local.get(ACTIVITY_KEY);
  return r[ACTIVITY_KEY] ?? {};
}

/**
 * Whole-map write of the shared activity map (sweep first-sighting stamps).
 * Serialized on the store lock (E2-0e). Used by the suspend + auto-dump sweeps,
 * which read the map, run async tab work, then commit; per-tab touch/forget use
 * the atomic mutateStores helpers below.
 * @param {Record<number, number>} map
 */
export async function saveActivityMap(map) {
  await withStoreLock(() => chrome.storage.local.set({ [ACTIVITY_KEY]: map }));
}

/** Record activity for a tab (atomic RMW under the store lock). */
export async function touchTab(tabId) {
  await mutateStores([ACTIVITY_KEY], (maps) => {
    const map = maps[ACTIVITY_KEY] ?? {};
    map[tabId] = Date.now();
    return { [ACTIVITY_KEY]: map };
  });
}

/** Drop tracking for a closed tab (atomic RMW under the store lock). */
export async function forgetTab(tabId) {
  await mutateStores([ACTIVITY_KEY], (maps) => {
    const map = maps[ACTIVITY_KEY] ?? {};
    if (!(tabId in map)) return null; // validated no-op
    delete map[tabId];
    return { [ACTIVITY_KEY]: map };
  });
}

/**
 * Is this tab exempt from automatic suspension?
 * Active, pinned, audible, grouped, discarded, non-http (including our own
 * suspend page), or matching the never-suspend whitelist (F9).
 * @param {chrome.tabs.Tab} t
 * @param {string[]} [whitelist] settings.suspendWhitelist (F9); omitted = no list
 */
export function isSuspendExempt(t, whitelist) {
  return (
    t.active ||
    t.pinned ||
    t.audible ||
    t.incognito || // never suspend incognito (would write its URL to the registry)
    (t.groupId !== undefined && t.groupId !== -1) ||
    t.discarded ||
    !isHttpTab(t) || // also excludes chrome-extension://…/suspend.html tabs
    matchesWhitelist(canonicalUrlOf(t), whitelist) // F9: never-suspend patterns
  );
}

/**
 * Internal: suspend one tab using the method set in settings.
 *   suspendLazyReload=true (default) → redirect to suspend.html; user clicks to reload.
 *   suspendLazyReload=false          → chrome.tabs.discard(); browser reloads on switch.
 * @param {chrome.tabs.Tab} t
 * @param {import("./types.js").Settings} settings
 */
async function doSuspend(t, settings) {
  bump("tabsSuspended");
  if (!settings.suspendLazyReload) {
    // Discarded tabs are ordinary tabs (they survive an extension reload), so
    // they need no recovery registry entry.
    return chrome.tabs.discard(t.id);
  }
  const base = chrome.runtime.getURL("suspend.html");
  const original = urlOf(t);
  const params = new URLSearchParams({
    originalUrl: original,        // avoid 'url=' — unwrapSuspendedUrl would extract it
    title: t.title || original,
    ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {})
  });
  /* N4c: register BEFORE navigating. The worker can be killed at any await, and
   * between these two lines the tab is already parked on our page with nothing
   * recording where it came from — a reload would then have nothing to recover
   * and the page would be gone for good. Persist first, mutate second, which is
   * the same nothing-lost ordering the save paths use. A failed navigation
   * leaves a harmless entry that the next recovery pass prunes. */
  await registerSuspended(t, original);
  return chrome.tabs.update(t.id, { url: `${base}?${params}` });
}

/**
 * Manually suspend a specific tab. Unlike the auto-sweep, this ignores the
 * "active" exemption (the user asked for it) but still refuses pinned and
 * non-http tabs.
 * @param {number} tabId
 * @returns {Promise<boolean>} true if the tab was suspended
 */
export async function suspendTab(tabId) {
  let t;
  try { t = await chrome.tabs.get(tabId); } catch { return false; }
  if (t.pinned || t.incognito || !isHttpTab(t)) return false; // never suspend incognito
  const settings = await getSettings();
  try {
    await doSuspend(t, settings);
    return true;
  } catch { return false; }
}

/**
 * Wake a tab parked on OUR suspend page: navigate it back to its originalUrl.
 * No-op (returns false) for any tab not on our suspend page. Runs in the worker
 * (navigation is a tab mutation; the popup messages `wake-tab`).
 * @param {number} tabId
 * @returns {Promise<boolean>} true if the tab was woken
 */
export async function wakeTab(tabId) {
  let t;
  try { t = await chrome.tabs.get(tabId); } catch { return false; }
  const base = chrome.runtime.getURL("suspend.html");
  const raw = t.url || t.pendingUrl || "";
  if (!raw.startsWith(base)) return false;
  try {
    const original = new URL(raw).searchParams.get("originalUrl") || "";
    if (!/^https?:/.test(original)) return false;
    await chrome.tabs.update(tabId, { url: original });
    await unregisterSuspended(tabId); // N4: woken → no longer needs recovery
    return true;
  } catch {
    return false;
  }
}

/**
 * The periodic sweep. Two independent passes:
 *   1. time-based (the slider): suspend tabs idle past suspendAfterMinutes,
 *      gated by suspendMinTabs; only runs when suspendEnabled.
 *   2. hard cap (suspendMaxTabs): keep at most N tabs awake, suspending the
 *      longest-idled beyond the cap — regardless of the idle timer, so it works
 *      even with the slider Off.
 * @returns {Promise<number>} tabs suspended
 */
export async function suspendSweep() {
  const settings = await getSettings();
  let suspended = 0;
  if (settings.suspendEnabled) suspended += await suspendIdleSweep(settings);
  const maxTabs = Number(settings.suspendMaxTabs) || 0;
  if (maxTabs > 0) suspended += await capAwakeTabs(settings, maxTabs);
  return suspended;
}

/**
 * Pass 1 — time-based suspension. Tabs never seen before are stamped now (full
 * grace period, no instant discard right after install/restart).
 * @param {import("./types.js").Settings} settings
 * @returns {Promise<number>}
 */
async function suspendIdleSweep(settings) {
  const cutoff = Date.now() - settings.suspendAfterMinutes * 60_000;
  const map = await getActivityMap();
  const tabs = await chrome.tabs.query({});
  // "Only suspend when over N tabs are open" (suspendMinTabs; 0 = always). Keeps a
  // light tab load fully live; the idle cutoff below still picks WHICH tabs go.
  const minTabs = Number(settings.suspendMinTabs) || 0;
  if (minTabs > 0 && tabs.length <= minTabs) return 0;
  let suspended = 0;
  let mapChanged = false;
  for (const t of tabs) {
    if (isSuspendExempt(t, settings.suspendWhitelist)) continue; // F9: never-suspend list
    const last = map[t.id];
    if (last === undefined) {
      map[t.id] = Date.now(); // first sighting: start the clock
      mapChanged = true;
      continue;
    }
    if (last < cutoff) {
      try {
        await doSuspend(t, settings);
        suspended++;
      } catch {
        /* tab may be gone or non-suspendable — skip */
      }
    }
  }
  if (mapChanged) await saveActivityMap(map);
  return suspended;
}

/**
 * Pass 2 — the hard cap: keep at most `maxTabs` tabs awake, suspending the
 * longest-idled ones beyond the cap (by our activity map, falling back to
 * Chrome's `lastAccessed`). "Awake" = a live page still holding memory (not
 * already suspended/discarded). The active/pinned/audible/grouped/whitelisted
 * tabs are never touched (via `isSuspendExempt`), so a cap smaller than the
 * protected set is enforced as far as it can be. Independent of the idle timer.
 * @param {import("./types.js").Settings} settings @param {number} maxTabs
 * @returns {Promise<number>}
 */
async function capAwakeTabs(settings, maxTabs) {
  const tabs = await chrome.tabs.query({});
  const awake = tabs.filter((t) => isHttpTab(t) && !isOwnSuspendPage(t) && !t.discarded);
  const over = awake.length - maxTabs;
  if (over <= 0) return 0;
  const map = await getActivityMap();
  const lastUsed = (t) => map[t.id] ?? t.lastAccessed ?? 0;
  const candidates = awake
    .filter((t) => !isSuspendExempt(t, settings.suspendWhitelist))
    .sort((a, b) => lastUsed(a) - lastUsed(b)); // longest-idled first
  let suspended = 0;
  for (const t of candidates.slice(0, over)) {
    try {
      await doSuspend(t, settings);
      suspended++;
    } catch {
      /* skip */
    }
  }
  return suspended;
}

/**
 * Manual: suspend all eligible tabs in a window except the active one.
 * @param {number} windowId
 * @returns {Promise<number>}
 */
export async function suspendOthers(windowId) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ windowId });
  let suspended = 0;
  for (const t of tabs) {
    if (isSuspendExempt(t)) continue;
    try {
      await doSuspend(t, settings);
      suspended++;
    } catch {
      /* skip */
    }
  }
  return suspended;
}
