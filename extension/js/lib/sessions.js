import { STORE_KEYS } from "./types.js";
import {
  newMeta, upsertItem, tombstoneItem, getSettings, mutateStores, getFreshItem
} from "./store.js";
import { isSaveableTab, canonicalRef } from "./tabs.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import {
  hasTabGroupsPermission, mapGroupIndexes, fetchGroupTemplates, recreateWindowGroups
} from "./tab-groups.js";

/**
 * F18 — the capture/restore gate for this operation. `preserveEnabled` is the
 * user preference (default ON); `withPermission` is true only when the optional
 * `tabGroups` permission is also granted (needed to read/write names, colors,
 * collapsed). Membership (`groupIndex`) is captured whenever preservation is on;
 * descriptors need the permission.
 * @returns {Promise<{preserveEnabled: boolean, withPermission: boolean}>}
 */
async function groupGate() {
  const settings = await getSettings();
  const preserveEnabled = settings.preserveTabGroups !== false;
  const withPermission = preserveEnabled ? await hasTabGroupsPermission() : false;
  return { preserveEnabled, withPermission };
}

/**
 * F18 — capture one window's saveable refs plus its tab-group templates. Refs are
 * canonical (suspended tabs resolved), each carrying a `groupIndex` when its live
 * tab is grouped; `groups` holds the window's templates in first-seen order
 * (empty when the window has no groups or preservation is off). Membership rides
 * on the refs; descriptors are filled only when the permission is granted.
 * @param {chrome.tabs.Tab[]} windowTabs populated tabs of one window
 * @param {{preserveEnabled: boolean, withPermission: boolean}} gate
 * @returns {Promise<{refs: import("./types.js").TabRef[], groups: import("./types.js").GroupTemplate[]}>}
 */
async function captureWindowRefs(windowTabs, gate) {
  const saveable = (windowTabs ?? []).filter(isSaveableTab);
  const refs = saveable.map(canonicalRef);
  if (!gate.preserveEnabled) return { refs, groups: [] };
  const { groupIndexByPos, groupIds } = mapGroupIndexes(saveable);
  for (let i = 0; i < refs.length; i++) {
    if (groupIndexByPos[i] != null) refs[i].groupIndex = groupIndexByPos[i];
  }
  const groups = await fetchGroupTemplates(groupIds, gate.withPermission);
  return { refs, groups };
}

/**
 * F18 — the `groups` field to store on a session: the per-window templates when
 * at least one window actually had a group, else undefined (so a group-less
 * session stays byte-identical to pre-F18). @param {import("./types.js").GroupTemplate[][]} perWindow
 */
function sessionGroupsField(perWindow) {
  return perWindow.some((g) => g.length > 0) ? { groups: perWindow } : {};
}

/**
 * F18 — recreate a restored window's groups, best-effort. Only pays for the
 * settings/permission read when the window actually carries group membership, and
 * never throws (groups are garnish; a failure must not fail the restore).
 * @param {number} windowId @param {import("./types.js").TabRef[]} refs
 * @param {(number|undefined)[]} tabIds created tab id per ref (aligned)
 * @param {import("./types.js").GroupTemplate[]} [groups]
 */
async function recreateGroupsIfEnabled(windowId, refs, tabIds, groups) {
  try {
    // Only session-window restores pass a `groups` array (even `[]`). A caller
    // that opts out (e.g. the Labels "Open all", which flattens refs from many
    // sources) passes nothing, so mixed `groupIndex` values never get grouped.
    if (groups === undefined) return;
    if (!refs.some((r) => r?.groupIndex != null)) return;
    await recreateWindowGroups(windowId, refs, tabIds, groups, await groupGate());
  } catch {
    /* groups are garnish — never fail a restore */
  }
}

/**
 * E2-0c: commit a manually created session + its undo entry in ONE atomic set
 * (auto-snapshots are not journaled and don't come through here).
 * @param {import("./types.js").Session} session
 */
async function commitCreatedSession(session) {
  const entry = makeJournalEntry(`Created session “${session.name}”`, {
    dels: [{ store: STORE_KEYS.sessions, id: session.id }]
  });
  const now = Date.now();
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.sessions]: {
      ...(maps[STORE_KEYS.sessions] ?? {}),
      [session.id]: { ...session, modifiedAt: now }
    },
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));
  return session;
}

/**
 * E2-0c pure: the sessions map with `session`'s picked refs removed — emptied
 * windows drop, an emptied session tombstones (rule 8). Mirrors
 * removeSessionTabs for use inside a mutateStores mutator.
 * @param {Record<string, import("./types.js").Session>} map
 * @param {import("./types.js").Session} session @param {SessionPick[]} picks
 * @param {number} now
 */
function sessionMapWithTabsRemoved(map, session, picks, now) {
  const drop = new Map(picks.map((p) => [p.windowIndex, new Set(p.indexes)]));
  const windows = session.windows
    .map((w, wi) => w.filter((_, i) => !drop.get(wi)?.has(i)))
    .filter((w) => w.length > 0);
  const next = { ...map };
  if (windows.length === 0) {
    const cur = next[session.id];
    if (cur) next[session.id] = { ...cur, deletedAt: now, modifiedAt: now };
    return { map: next, remainder: null };
  }
  const updated = { ...session, windows, modifiedAt: now };
  next[session.id] = updated;
  return { map: next, remainder: updated };
}

const SNAPSHOT_SIG_KEY = "lastSnapshotSig";

/** @param {Date} d */
function formatStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Current window layout (saveable tabs only, empty windows dropped). Suspended
 * tabs are captured under their underlying URL (canonicalRef), never dropped.
 * F18: also returns per-window tab-group templates, aligned to `windows` by index.
 * @returns {Promise<{windows: import("./types.js").TabRef[][], groups: import("./types.js").GroupTemplate[][]}>} */
async function captureAllWindows() {
  const gate = await groupGate();
  const wins = await chrome.windows.getAll({ populate: true });
  const windows = [];
  const groups = [];
  for (const w of wins) {
    const cap = await captureWindowRefs(w.tabs ?? [], gate);
    if (cap.refs.length === 0) continue; // drop empty windows (same as before)
    windows.push(cap.refs);
    groups.push(cap.groups);
  }
  return { windows, groups };
}

/**
 * Periodic auto-snapshot (crash recovery). Skips if the tab set is unchanged
 * since the last snapshot. Prunes old auto-snapshots beyond settings.snapshotKeep.
 * @returns {Promise<import("./types.js").Session | null>} the created session, or null if skipped
 */
export async function takeSnapshot() {
  const { windows, groups } = await captureAllWindows();
  if (windows.length === 0) return null;

  const sig = JSON.stringify(windows.map((w) => w.map((t) => t.url)));
  const r = await chrome.storage.local.get(SNAPSHOT_SIG_KEY);
  if (r[SNAPSHOT_SIG_KEY] === sig) return null;

  /** @type {import("./types.js").Session} */
  const session = {
    ...(await newMeta()),
    name: `Snapshot ${formatStamp(new Date())}`,
    auto: true,
    windows,
    labels: [],
    ...sessionGroupsField(groups)
  };
  // E2-0c: snapshot + signature + prune are ONE atomic commit (a crash can no
  // longer record the sig without the snapshot, or vice versa); the sig is
  // re-checked under the lock. Prune logic inlined from the former
  // pruneAutoSnapshots, computed on the fresh in-lock map.
  const { snapshotKeep } = await getSettings();
  const now = Date.now();
  let created = null;
  await mutateStores([STORE_KEYS.sessions, SNAPSHOT_SIG_KEY], (maps) => {
    if (maps[SNAPSHOT_SIG_KEY] === sig) return null; // another context won the race
    const map = { ...(maps[STORE_KEYS.sessions] ?? {}) };
    map[session.id] = { ...session, modifiedAt: now };
    // An explicit 0 keeps everything. Fresh profiles default to a bounded 200,
    // while existing profiles that chose 0 remain unlimited.
    if (snapshotKeep && snapshotKeep > 0) {
      const autos = Object.values(map)
        .filter((s) => s.auto && !s.deletedAt)
        .sort((a, b) => b.modifiedAt - a.modifiedAt); // newest first
      for (const old of autos.slice(Math.max(1, snapshotKeep))) {
        map[old.id] = { ...old, deletedAt: now, modifiedAt: now };
      }
    }
    created = session;
    return { [STORE_KEYS.sessions]: map, [SNAPSHOT_SIG_KEY]: sig };
  });
  return created;
}

/**
 * M6 "Open tabs": save a specific selection of tabs as a named session
 * (one window in the session; tabs stay open).
 * @param {number[]} tabIds @param {string} [name]
 * @returns {Promise<import("./types.js").Session | null>}
 */
export async function saveTabsAsSession(tabIds, name) {
  const gate = await groupGate();
  /** @type {chrome.tabs.Tab[]} */
  const tabs = [];
  for (const id of tabIds) {
    try {
      tabs.push(await chrome.tabs.get(id));
    } catch {
      /* gone */
    }
  }
  // The selection becomes one session window; groups among it are captured in
  // first-seen order (a group lives in one window, so ids never collide).
  const { refs, groups } = await captureWindowRefs(tabs, gate);
  if (refs.length === 0) return null;
  /** @type {import("./types.js").Session} */
  const session = {
    ...(await newMeta()),
    name: name?.trim() || `Selection ${formatStamp(new Date())}`,
    auto: false,
    windows: [refs],
    labels: [],
    ...sessionGroupsField([groups])
  };
  return commitCreatedSession(session);
}

/**
 * M6: append windows (TabRef[][]) to an existing session.
 * E2-0c: guard re-reads FRESH under the lock; record + undo entry in one set.
 * F18: optional `groupsPerWindow` (aligned to `windows`) extends the session's
 * `groups`, padding any pre-F18/group-less existing windows so alignment holds.
 * @param {string} sessionId @param {import("./types.js").TabRef[][]} windows
 * @param {import("./types.js").GroupTemplate[][]} [groupsPerWindow]
 */
export async function addWindowsToSession(sessionId, windows, groupsPerWindow) {
  const now = Date.now();
  let updated = null;
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.sessions] ?? {};
    const s = map[sessionId];
    if (!s || s.deletedAt || s.auto) return null; // N8: snapshots are immutable
    // Keep windows and their group templates paired while dropping empty windows.
    const pairs = windows
      .map((w, i) => [w, groupsPerWindow?.[i] ?? []])
      .filter(([w]) => w.length > 0);
    const addWindows = pairs.map(([w]) => w);
    const addGroups = pairs.map(([, g]) => g);
    updated = { ...s, windows: [...s.windows, ...addWindows], modifiedAt: now };
    if (Array.isArray(s.groups) || addGroups.some((g) => g.length > 0)) {
      const base = Array.isArray(s.groups) ? s.groups.slice() : [];
      while (base.length < s.windows.length) base.push([]); // align to existing windows
      updated.groups = [...base, ...addGroups];
    }
    const entry = makeJournalEntry(`Added to session “${s.name}”`,
      { puts: [{ store: STORE_KEYS.sessions, item: s }] });
    return {
      [STORE_KEYS.sessions]: { ...map, [sessionId]: updated },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return updated;
}

/**
 * M6: create a named session from prepared windows (TabRef[][]).
 * @param {import("./types.js").TabRef[][]} windows @param {string} [name]
 */
export async function createSessionFromWindows(windows, name) {
  const session = buildSessionFromWindows(await newMeta(), windows, name);
  if (!session) return null;
  await upsertItem(STORE_KEYS.sessions, session);
  return session;
}

/**
 * MH 2026-07-20 fix — the Open-tabs bulk "→ Session (new)" path: create a
 * session from prepared windows WITH the "Created session" undo entry,
 * committed atomically like every other manual creation path.
 * `createSessionFromWindows` above stays journal-free for composers that
 * record their own inverse (e.g. moveTabsToSession's merge entry).
 * @param {import("./types.js").TabRef[][]} windows @param {string} [name]
 */
export async function createSessionFromWindowsJournaled(windows, name) {
  const session = buildSessionFromWindows(await newMeta(), windows, name);
  if (!session) return null;
  return commitCreatedSession(session);
}

/**
 * E2-0c pure form: build the session record from prepared meta (no I/O), or
 * null when no window has tabs. createSessionFromWindows delegates here;
 * atomic domain commits (moveTabsToSession) embed the result in ONE set.
 * @param {import("./types.js").Meta} meta @param {import("./types.js").TabRef[][]} windows
 * @param {string} [name]
 * @returns {import("./types.js").Session|null}
 */
export function buildSessionFromWindows(meta, windows, name) {
  const clean = windows.filter((w) => w.length > 0);
  if (clean.length === 0) return null;
  return {
    ...meta,
    name: name?.trim() || `Session ${formatStamp(new Date())}`,
    auto: false,
    windows: clean,
    labels: []
  };
}

/**
 * Save one window as a named session.
 * @param {number} windowId
 * @param {string} [name]
 */
export async function saveWindowAsSession(windowId, name) {
  const gate = await groupGate();
  const tabs = await chrome.tabs.query({ windowId });
  const { refs, groups } = await captureWindowRefs(tabs, gate);
  if (refs.length === 0) return null;
  /** @type {import("./types.js").Session} */
  const session = {
    ...(await newMeta()),
    name: name || `Window ${formatStamp(new Date())}`,
    auto: false,
    windows: [refs],
    labels: [],
    ...sessionGroupsField([groups])
  };
  await commitCreatedSession(session);
  await bindWindowToSession(windowId, session.id, 0); // future drift suggestions
  return session;
}

/**
 * Rename a manual session (the popup's "Saved: {name} + Rename" path, J3).
 * Undoable — the inverse restores the previous name.
 * @param {string} id @param {string} name
 * @returns {Promise<import("./types.js").Session | null>}
 */
export async function renameSession(id, name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  // E2-0c: fresh in-lock guard; record + undo entry in one atomic set.
  const now = Date.now();
  let after = null;
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.sessions] ?? {};
    const before = map[id];
    if (!before || before.deletedAt || before.auto) return null; // N8: snapshots can't be renamed
    after = { ...before, name: clean, modifiedAt: now };
    const entry = makeJournalEntry(`Renamed session to “${clean}”`,
      { puts: [{ store: STORE_KEYS.sessions, item: before }] });
    return {
      [STORE_KEYS.sessions]: { ...map, [id]: after },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return after;
}

/**
 * Save all windows as a named session.
 * @param {string} [name]
 */
export async function saveAllWindowsAsSession(name) {
  const { windows, groups } = await captureAllWindows();
  if (windows.length === 0) return null;
  /** @type {import("./types.js").Session} */
  const session = {
    ...(await newMeta()),
    name: name || `All windows ${formatStamp(new Date())}`,
    auto: false,
    windows,
    labels: [],
    ...sessionGroupsField(groups)
  };
  return commitCreatedSession(session);
}

/**
 * P2g-1: append every open window to an existing session (the combobox's
 * "pick an existing session" path of "Save all windows"). Journals via
 * addWindowsToSession.
 * @param {string} sessionId
 */
export async function addAllWindowsToSession(sessionId) {
  const { windows, groups } = await captureAllWindows();
  if (windows.length === 0) return null;
  return addWindowsToSession(sessionId, windows, groups);
}

/**
 * Reopen one window of TabRefs as a new browser window, restoring pinned state.
 * With `bind`, the created window remembers which session/window it came from
 * (drives the M6 drift suggestions in Open tabs).
 * F18: pass the window's `groups` templates to recreate its tab groups after all
 * tabs exist (best-effort; permission-gated; a failure leaves the tabs ungrouped).
 * @param {import("./types.js").TabRef[]} refs
 * @param {{sessionId: string, windowIndex: number}} [bind]
 * @param {import("./types.js").GroupTemplate[]} [groups] this window's group templates
 */
export async function restoreWindowRefs(refs, bind, groups) {
  const urls = refs.map((r) => r.url).filter((u) => /^https?:/.test(u));
  if (urls.length === 0) return null;
  const win = await chrome.windows.create({ url: urls });
  if (!win?.id) return null;
  if (bind) await bindWindowToSession(win.id, bind.sessionId, bind.windowIndex);
  // windows.create may not return populated tabs reliably — query instead.
  const tabs = await chrome.tabs.query({ windowId: win.id });
  tabs.sort((a, b) => a.index - b.index);
  // Capture the created tab ids aligned to refs BEFORE pinning (pinning reorders,
  // but grouping is by id, so the mapping stays valid).
  const tabIds = [];
  for (let i = 0; i < refs.length && i < tabs.length; i++) {
    tabIds[i] = tabs[i]?.id;
    if (refs[i]?.pinned && tabs[i]?.id !== undefined) {
      await chrome.tabs.update(tabs[i].id, { pinned: true });
    }
  }
  await recreateGroupsIfEnabled(win.id, refs, tabIds, groups); // F18: garnish, never fails
  // Returning the created window id is additive: existing callers ignore it, and
  // the F8-2 Focus coordinator needs it to make a freshly restored session its
  // target (restoreSessionWindows below).
  return win.id;
}

/**
 * Restore a full session: every window reopens, bound to its session window.
 * @param {import("./types.js").Session} session
 */
export async function restoreSession(session) {
  for (const [i, refs] of session.windows.entries()) {
    await restoreWindowRefs(refs, { sessionId: session.id, windowIndex: i }, session.groups?.[i]);
  }
}

/**
 * P11-19: restore a Search-selected Session from a fresh store read. Search
 * snapshots are intentionally interaction-local, so the entity the user chose
 * may have been deleted before Enter/click reaches the worker. Never restore an
 * automatic Snapshot through this path and never mutate the Session template.
 * @param {string} sessionId
 * @returns {Promise<boolean>} false when the named Session no longer exists
 */
export async function restoreSessionById(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return false;
  const session = await getFreshItem(STORE_KEYS.sessions, sessionId);
  if (!session || session.deletedAt || session.auto) return false;
  await restoreSession(session);
  return true;
}

/**
 * F8-2 — the narrow session-restore helper the Focus coordinator uses when a
 * session has no live bound window. Reopens the full template (same binding +
 * pinned-state behavior as `restoreSession`) and returns the created normal
 * window IDs so the coordinator can make them the Focus target. The session
 * template is never mutated. Kept separate from `restoreSession` so its current
 * callers keep their exact (void) behavior — this is not a public-seam refactor.
 *
 * F8-2r: returns a STRUCTURED result so the coordinator can decide the switch
 * safely (never half-ending an old run) — `created` are the window IDs that
 * opened, `failedIndexes` are the template-window indices that produced no
 * window (all-non-http refs, or a `windows.create` rejection). A window that
 * fails is simply not opened; nothing partial is left behind for it.
 *
 * F8-2r2 C13: this path is TRANSACTIONAL per window (see `restoreFocusTemplateWindow`).
 * If a post-create step (binding, `tabs.query`, pinning) rejects AFTER a window
 * opened, the window and its binding are rolled back so no orphan window is left
 * open, focused, and untracked. If rollback itself cannot remove a still-live
 * created window, that ID is not hidden as a failure: it is returned as a viable
 * `created` target and its index is reported in the additive `degradedIndexes`.
 * Successful and degraded IDs both become target IDs; `failedIndexes` produced no
 * surviving window. The session template is never mutated.
 *
 * F8-2r4 C21: a degraded survivor is normally still bound to its session (the
 * re-bind in the rollback path succeeds), so a later Focus on the same session
 * reuses it. But when the initial bind AND the re-bind both fail, the survivor is
 * a target with NO session binding — that must not be reported as if it were
 * associated with the session. Such indices are surfaced in the additive
 * `unboundIndexes` (a subset of `degradedIndexes`); callers propagate them so the
 * result never implies a binding that does not exist.
 *
 * F8-2r6 C29: additionally returns `createdMeta` — one `{windowId, templateIndex, bound}`
 * per created window — so a coordinator rollback can confirm removal and honestly keep a
 * bound survivor bound (or re-bind an unbound one at its true template index) instead of
 * unconditionally unbinding. `bound` is true for a cleanly-created window and mirrors the
 * degraded survivor's real binding state otherwise. The session template is never mutated.
 * @param {import("./types.js").Session} session
 * @returns {Promise<{created: number[], createdMeta: {windowId:number, templateIndex:number, bound:boolean}[], failedIndexes: number[], degradedIndexes?: number[], unboundIndexes?: number[]}>}
 */
export async function restoreSessionWindows(session) {
  const created = [];
  const createdMeta = [];
  const failedIndexes = [];
  const degradedIndexes = [];
  const unboundIndexes = [];
  for (let i = 0; i < session.windows.length; i++) {
    const r = await restoreFocusTemplateWindow(session, i);
    if (r.status === "created") {
      created.push(r.id);
      const bound = r.degraded ? (r.bound !== false) : true; // C29: honest per-window binding state
      createdMeta.push({ windowId: r.id, templateIndex: i, bound });
      if (r.degraded) {
        degradedIndexes.push(i);
        if (r.bound === false) unboundIndexes.push(i); // C21: bind + re-bind both failed
      }
    } else {
      failedIndexes.push(i); // "skipped" (all-non-http) or "failed" (created then rolled back)
    }
  }
  const out = { created, createdMeta, failedIndexes };
  if (degradedIndexes.length) out.degradedIndexes = degradedIndexes;
  if (unboundIndexes.length) out.unboundIndexes = unboundIndexes;
  return out;
}

/**
 * F8-2r2 C13: transactionally restore ONE template window for the Focus coordinator.
 * Reopens the window, then binds it, queries its tabs, and applies pinned state. A
 * rejection AFTER `windows.create` succeeded triggers a deterministic rollback of
 * the created window and its binding, so a later failure never leaves an orphan.
 * Kept private and separate from `restoreWindowRefs` so `restoreSession`'s existing
 * (void) callers are unchanged. The session template is never mutated.
 * @param {import("./types.js").Session} session @param {number} windowIndex
 * @returns {Promise<{status:"created", id:number, degraded?:boolean, bound?:boolean}|{status:"skipped"}|{status:"failed"}>}
 */
async function restoreFocusTemplateWindow(session, windowIndex) {
  const refs = session.windows[windowIndex] ?? [];
  const urls = refs.map((r) => r.url).filter((u) => /^https?:/.test(u));
  if (urls.length === 0) return { status: "skipped" }; // reject all-non-http before creating anything

  let win;
  try {
    win = await chrome.windows.create({ url: urls });
  } catch {
    return { status: "failed" }; // create itself failed — nothing was opened, nothing to roll back
  }
  if (!win?.id) return { status: "failed" };
  const id = win.id;

  try {
    await bindWindowToSession(id, session.id, windowIndex);
    // windows.create may not return populated tabs reliably — query instead.
    const tabs = (await chrome.tabs.query({ windowId: id })).sort((a, b) => a.index - b.index);
    const tabIds = [];
    for (let i = 0; i < refs.length && i < tabs.length; i++) {
      tabIds[i] = tabs[i]?.id;
      if (refs[i]?.pinned && tabs[i]?.id !== undefined) {
        await chrome.tabs.update(tabs[i].id, { pinned: true });
      }
    }
    await recreateGroupsIfEnabled(id, refs, tabIds, session.groups?.[windowIndex]); // F18: garnish
    return { status: "created", id };
  } catch {
    // Post-create setup failed. F8-2r3 C18: only drop the binding when removal actually
    // succeeds; a degraded survivor MUST stay bound so a later Focus on the same session
    // reuses it instead of duplicating the template. Removing first then unbinding avoids
    // returning a live window detached from its session.
    try {
      await chrome.windows.remove(id);
      try { await unbindWindow(id); } catch { /* binding may never have been written */ }
      return { status: "failed" };
    } catch {
      // Could not remove — the window survives as a degraded target. Ensure it is bound
      // (re-establish in case the original bind is what failed); if binding is itself
      // unavailable, report the degradation but never claim a binding that does not exist.
      let bound = true;
      try { await bindWindowToSession(id, session.id, windowIndex); } catch { bound = false; }
      return { status: "created", id, degraded: true, bound };
    }
  }
}

/* ---------- P2g-3 (U6): tab-grain selection ops on sessions ---------- */

/**
 * @typedef {{windowIndex: number, indexes: number[]}} SessionPick
 * @typedef {{session: import("./types.js").Session, picks: SessionPick[]}} SessionSelection
 */

/**
 * Remove picked refs from a session (store op only — callers journal the
 * pre-state). Emptied windows drop; an emptied session tombstones (rule 8 of
 * interaction-model.md: a merge/removal that empties a session removes it).
 * @param {import("./types.js").Session} session @param {SessionPick[]} picks
 * @returns {Promise<import("./types.js").Session|null>} the remainder, or null if tombstoned
 */
export async function removeSessionTabs(session, picks) {
  const drop = new Map(picks.map((p) => [p.windowIndex, new Set(p.indexes)]));
  const windows = session.windows
    .map((w, wi) => w.filter((_, i) => !drop.get(wi)?.has(i)))
    .filter((w) => w.length > 0);
  if (windows.length === 0) {
    await tombstoneItem(STORE_KEYS.sessions, session.id);
    return null;
  }
  const updated = { ...session, windows };
  await upsertItem(STORE_KEYS.sessions, updated);
  return updated;
}

/**
 * P2g-5 — the row-level "Remove from session" ×. One tab leaves the session
 * in place; an emptied window collapses, an emptied session tombstones
 * (rule 8). Journaled: undo restores the exact pre-removal session.
 * @param {import("./types.js").Session} session
 * @param {number} windowIndex @param {number} index
 * @returns {Promise<import("./types.js").Session|null>} the remainder, or null
 */
export async function removeSessionTab(session, windowIndex, index) {
  if (session.auto) return null; // N8: snapshots are immutable
  // E2-0c: removal (update or rule-8 tombstone) + undo entry in ONE atomic set.
  const ref = session.windows[windowIndex]?.[index];
  const entry = makeJournalEntry(
    `Removed “${ref?.title || ref?.url || "a tab"}” from session “${session.name}”`,
    { puts: [{ store: STORE_KEYS.sessions, item: session }] });
  const now = Date.now();
  let remainder = null;
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    const r = sessionMapWithTabsRemoved(
      maps[STORE_KEYS.sessions] ?? {}, session, [{ windowIndex, indexes: [index] }], now);
    remainder = r.remainder;
    return { [STORE_KEYS.sessions]: r.map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  return remainder;
}

/**
 * U6 bulk Restore: open the picked tabs — one new browser window per source
 * window slice (structure preserved), a lone pick as a tab. Sessions are
 * templates: the session is NOT mutated, so there is nothing to journal.
 * @param {import("./types.js").Session} session @param {SessionPick[]} picks
 * @returns {Promise<number>} tabs opened
 */
export async function restoreSessionTabs(session, picks) {
  let opened = 0;
  for (const { windowIndex, indexes } of picks) {
    const refs = indexes.map((i) => session.windows[windowIndex]?.[i]).filter(Boolean);
    const urls = refs.map((r) => r.url).filter((u) => /^https?:/.test(u ?? ""));
    if (urls.length === 0) continue;
    if (urls.length > 1) await chrome.windows.create({ url: urls });
    else await chrome.tabs.create({ url: urls[0] });
    opened += urls.length;
  }
  return opened;
}

/**
 * U6 →Session (merge): MOVE the picked tabs out of their sessions into a
 * target session — new ("__new") or existing. One target window per source
 * window slice. A source emptied by the move tombstones; ONE journal entry
 * restores every touched session (and removes a created target). Picks whose
 * source IS the target are skipped (a session can't merge into itself);
 * snapshots are never touched on either side (N8).
 * @param {SessionSelection[]} sources @param {string} targetId session id or "__new"
 * @param {string} [name] name for a new target
 * @returns {Promise<{moved: number, name: string, entry: object|null}|null>}
 */
export async function moveSessionTabs(sources, targetId, name) {
  const movable = sources.filter((s) => !s.session.auto && s.session.id !== targetId);
  const windows = [];
  for (const { session, picks } of movable) {
    for (const p of picks) {
      const refs = p.indexes.map((i) => session.windows[p.windowIndex]?.[i]).filter(Boolean);
      if (refs.length) windows.push(refs);
    }
  }
  if (windows.length === 0) return null;

  // E2-0c: target create/append + every source removal + the undo entry are
  // ONE atomic commit (the cross-session "→Session merge" torn case). The
  // existing-target guard re-reads FRESH under the lock.
  const newTarget = targetId === "__new"
    ? buildSessionFromWindows(await newMeta(), windows, name)
    : null;
  if (targetId === "__new" && !newTarget) return null;

  const puts = [];
  const dels = [];
  let targetName;
  if (newTarget) {
    targetName = newTarget.name;
    dels.push({ store: STORE_KEYS.sessions, id: newTarget.id });
  }
  const now = Date.now();
  let moved = 0;
  let entry = null;
  const committed = await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    let map = { ...(maps[STORE_KEYS.sessions] ?? {}) };
    if (newTarget) {
      map[newTarget.id] = { ...newTarget, modifiedAt: now };
    } else {
      const target = map[targetId];
      if (!target || target.deletedAt || target.auto) return null; // N8
      puts.push({ store: STORE_KEYS.sessions, item: target });
      targetName = target.name;
      map[targetId] = { ...target, windows: [...target.windows, ...windows], modifiedAt: now };
    }
    moved = 0;
    for (const { session, picks } of movable) {
      puts.push({ store: STORE_KEYS.sessions, item: session });
      map = sessionMapWithTabsRemoved(map, session, picks, now).map;
      moved += picks.reduce((n, p) => n + p.indexes.length, 0);
    }
    entry = makeJournalEntry(
      `Merged ${moved} tab${moved === 1 ? "" : "s"} into “${targetName}”`, { puts, dels });
    return { [STORE_KEYS.sessions]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  if (!committed) return null;
  return { moved, name: targetName, entry };
}

/**
 * P2g-4c — the Sessions drag exit: move ONE ref WITHIN a session (drag never
 * crosses sessions — that's the →Session merge). Stale-drop guard + exact
 * one-undo, same contract as `moveInboxTab`.
 *
 * `target` is one of:
 *   {wi, index}  — insert before `index` in window `wi` (-1 = append there)
 *   {newAt}      — a between-blocks zone: new window block at position `newAt`
 *                  (counted in the PRE-move window order; zone after block wi
 *                  passes wi+1)
 * An emptied source window collapses; the session itself can never empty
 * from an internal move. Snapshots refuse (N8). The guard re-reads the
 * session and compares the LIFT-time modifiedAt — on any mismatch nothing is
 * written and the caller shows "List changed — nothing moved".
 *
 * @param {string} sessionId @param {number} fromWi @param {number} fromIndex
 * @param {{wi?: number, index?: number, newAt?: number}} target
 * @param {number} expectModified modifiedAt captured at lift time
 * @returns {Promise<{ok: boolean, stale?: boolean, noop?: boolean, entry?: object}>}
 */
export async function moveSessionTab(sessionId, fromWi, fromIndex, target, expectModified) {
  // E2-0c: guard + write + undo entry are ONE atomic commit; the [AP] stale
  // guard now runs under the store lock AT the commit point (same contract).
  const now = Date.now();
  let result = { ok: false, stale: true };
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.sessions] ?? {};
    const s = map[sessionId];
    if (!s || s.deletedAt || s.auto || s.modifiedAt !== expectModified) {
      result = { ok: false, stale: true };
      return null;
    }
    const ref = s.windows[fromWi]?.[fromIndex];
    if (!ref) {
      result = { ok: false, stale: true };
      return null;
    }

    // mutate a copy; keep original window indices until the final cleanup so
    // `target` positions stay meaningful even when the source window empties
    const windows = s.windows.map((w) => [...w]);
    windows[fromWi].splice(fromIndex, 1);

    if (target.newAt != null) {
      windows.splice(target.newAt, 0, [ref]);
    } else {
      if (!s.windows[target.wi]) {
        result = { ok: false, stale: true };
        return null;
      }
      let at = target.index === -1 ? windows[target.wi].length : Math.min(target.index, windows[target.wi].length);
      if (target.wi === fromWi && target.index !== -1 && fromIndex < target.index) at -= 1; // removal shifted the slot
      if (target.wi === fromWi && at === fromIndex) {
        result = { ok: true, noop: true }; // dropped where it was
        return null;
      }
      windows[target.wi].splice(at, 0, ref);
    }
    const updated = { ...s, windows: windows.filter((w) => w.length > 0), modifiedAt: now };
    const entry = makeJournalEntry(`Moved “${ref.title || ref.url}” in “${s.name}”`,
      { puts: [{ store: STORE_KEYS.sessions, item: s }] });
    result = { ok: true, entry };
    return {
      [STORE_KEYS.sessions]: { ...map, [sessionId]: updated },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return result;
}

/* ---------- M6: window ↔ session bindings (drift suggestions) ----------
 * Per-device (window ids are device-local); NOT synced. */

const BINDINGS_KEY = "sessionWindows";

/** @returns {Promise<Record<number, {sessionId: string, windowIndex: number}>>} */
export async function getSessionBindings() {
  const r = await chrome.storage.local.get(BINDINGS_KEY);
  return r[BINDINGS_KEY] ?? {};
}

/**
 * Pure display snapshot: keep only bindings whose Chrome window still exists.
 * Stale persisted keys are maintenance work and never need to block Open paint.
 * @param {Record<number, {sessionId: string, windowIndex: number}>} bindings
 * @param {number[]} liveWindowIds
 */
export function liveSessionBindings(bindings, liveWindowIds) {
  const live = new Set(liveWindowIds);
  return Object.fromEntries(
    Object.entries(bindings ?? {}).filter(([id]) => live.has(Number(id)))
  );
}

export async function bindWindowToSession(windowId, sessionId, windowIndex) {
  // E2-0e: atomic RMW under the store lock (bindings are single-writer today,
  // but the lock keeps them coordinated with every other store write).
  await mutateStores([BINDINGS_KEY], (maps) => {
    const map = maps[BINDINGS_KEY] ?? {};
    map[windowId] = { sessionId, windowIndex };
    return { [BINDINGS_KEY]: map };
  });
}

export async function unbindWindow(windowId) {
  await mutateStores([BINDINGS_KEY], (maps) => {
    const map = maps[BINDINGS_KEY] ?? {};
    if (!(windowId in map)) return null; // validated no-op
    delete map[windowId];
    return { [BINDINGS_KEY]: map };
  });
}

/** Drop bindings whose window no longer exists (window ids reset on restart). */
export async function pruneSessionBindings(liveWindowIds) {
  let result = {};
  await mutateStores([BINDINGS_KEY], (maps) => {
    const map = maps[BINDINGS_KEY] ?? {};
    result = map;
    let changed = false;
    for (const id of Object.keys(map)) {
      if (!liveWindowIds.includes(Number(id))) {
        delete map[id];
        changed = true;
      }
    }
    return changed ? { [BINDINGS_KEY]: map } : null;
  });
  return result;
}

/**
 * Replace one window of a session with fresh refs (the drift "Update session"
 * action). Returns {before, after} so callers can journal the inverse.
 * @param {string} sessionId @param {number} windowIndex
 * @param {import("./types.js").TabRef[]} refs
 */
export async function updateSessionWindow(sessionId, windowIndex, refs) {
  // E2-0c: fresh in-lock guard; record + undo entry in one atomic set.
  const now = Date.now();
  let out = null;
  await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.sessions] ?? {};
    const before = map[sessionId];
    if (!before || before.deletedAt || before.auto) return null; // N8: snapshots are immutable
    const windows = before.windows.map((w, i) => (i === windowIndex ? refs : w));
    const after = { ...before, windows, modifiedAt: now };
    out = { before, after };
    const entry = makeJournalEntry(`Updated session “${before.name}” from its window`,
      { puts: [{ store: STORE_KEYS.sessions, item: before }] });
    return {
      [STORE_KEYS.sessions]: { ...map, [sessionId]: after },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

/** N32 — pure: total tab count of a session. @param {import("./types.js").Session} s */
export function sessionTabCount(s) {
  return (s.windows ?? []).reduce((n, w) => n + w.length, 0);
}

/**
 * N32 — pure: Sessions-page sort, mirroring the Labels-page modes (L-nav).
 * "az" = name A–Z · "count" = most tabs first · "recent" (default) = latest
 * modified first (createdAt fallback). Ties break alphabetically; the input
 * array is not mutated.
 * @param {import("./types.js").Session[]} sessions
 * @param {("recent"|"az"|"count")} mode
 */
export function sortSessions(sessions, mode) {
  const az = (a, b) => (a.name || "").localeCompare(b.name || "");
  const at = (s) => s.modifiedAt ?? s.createdAt ?? 0;
  const arr = [...sessions];
  if (mode === "az") return arr.sort(az);
  if (mode === "count") return arr.sort((a, b) => sessionTabCount(b) - sessionTabCount(a) || az(a, b));
  return arr.sort((a, b) => at(b) - at(a) || az(a, b));
}
