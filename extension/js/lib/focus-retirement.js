/**
 * F8-R1 — Workspace Focus retirement (focus-mode.md §9, §12.1). The v0.1
 * window/session "Workspace Focus" experiment (minimize other windows on start,
 * restore on end) was removed as unreliable on macOS. Focus v0.2 is a
 * distraction-site guard only; this module is what remains of the old coordinator.
 *
 * It is a RESTORATION-ONLY compatibility drain, NOT a hidden feature: it reads a
 * legacy `focusState` if one is still stored, brings the recorded windows back to
 * their prior state, and removes the stale key + alarm once nothing is left
 * minimized or pending. It exposes NO start-window, start-session, switch,
 * hide-again, status, or target API. It never minimizes a window, never creates a
 * run, never restores a session template, never opens a window, and never touches
 * incognito. When no legacy state exists it performs zero window mutation.
 *
 * The old `focusState` key and `focus-end` alarm names are reused unchanged because
 * existing profiles already contain them (additive schema rule — nothing is renamed
 * or migrated).
 */

/** The legacy operational key — never inside `settings`, never synced. */
export const FOCUS_STATE_KEY = "focusState";
/** The legacy end-alarm name, reused as the retirement retry alarm. */
export const FOCUS_ALARM = "focus-end";

/** True for the legacy Focus alarm (routed only to the retirement drain now). */
export function isFocusAlarm(name) {
  return name === FOCUS_ALARM;
}

/* -------------------- native convergence (restore direction only) --------------
 * A resolved `chrome.windows.update(id, {state})` is only an ACCEPTED request, not
 * proof the native window manager finished the transition (on macOS the committed
 * state can lag or a request can be dropped). So restoration re-reads live state on
 * a bounded, batched poll — exactly the accepted F8-2 convergence, kept for the
 * restore path only. `quietPolls` is the stability window used to neutralize a
 * still-in-flight legacy minimize before its recovery record is dropped. */
let convergeConfig = { maxRequests: 3, pollsPerRequest: 4, pollIntervalMs: 250, retryMs: 5000, quietPolls: 3 };
/** Test seam: shrink the poll/retry/quiet windows so the retirement tests run fast. */
export function configureFocusRetirement(cfg) { convergeConfig = { ...convergeConfig, ...cfg }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readWindow = async (id) => { try { return await chrome.windows.get(id); } catch { return null; } };

/**
 * Dispatch a state request for every entry WITHOUT awaiting each — every
 * `chrome.windows.update(...)` is initiated synchronously, then the acknowledgements
 * are settled together, so a slow native ack cannot serialize the rest. A closed
 * window rejects harmlessly (the next read reclassifies it).
 * @param {{id:number, desired:string}[]} reqs
 */
async function dispatchBatch(reqs) {
  if (!reqs.length) return;
  const acks = reqs.map(({ id, desired }) => {
    try { return Promise.resolve(chrome.windows.update(id, { state: desired })).catch(() => {}); }
    catch { return Promise.resolve(); }
  });
  await Promise.allSettled(acks);
}

/**
 * Drive a batch of windows to their desired (RESTORE) state and confirm via re-read.
 * `done(w)` short-circuits a window the user already moved; incognito is never
 * touched. Returns a Map id -> "ok" | "closed" | "timeout".
 * @param {{id:number, desired:string}[]} specs
 * @param {(w: chrome.windows.Window) => boolean} done
 * @returns {Promise<Map<number, "ok"|"closed"|"timeout">>}
 */
async function convergeBatch(specs, done) {
  const { maxRequests, pollsPerRequest, pollIntervalMs } = convergeConfig;
  const result = new Map();
  const sent = new Map();
  const firstRound = [];
  for (const { id, desired } of specs) {
    const w = await readWindow(id);
    if (!w) { result.set(id, "closed"); continue; }
    if (w.incognito) { result.set(id, "ok"); continue; }
    if (done(w)) { result.set(id, "ok"); continue; }
    firstRound.push({ id, desired });
    sent.set(id, { desired, n: 1 });
  }
  await dispatchBatch(firstRound);

  while (sent.size) {
    for (let p = 0; p < pollsPerRequest && sent.size; p++) {
      await sleep(pollIntervalMs);
      for (const id of [...sent.keys()]) {
        const w = await readWindow(id);
        if (!w) { result.set(id, "closed"); sent.delete(id); continue; }
        if (done(w)) { result.set(id, "ok"); sent.delete(id); }
      }
    }
    const retryRound = [];
    for (const id of [...sent.keys()]) {
      const s = sent.get(id);
      if (s.n >= maxRequests) { result.set(id, "timeout"); sent.delete(id); continue; }
      retryRound.push({ id, desired: s.desired });
      s.n += 1;
    }
    await dispatchBatch(retryRound);
  }
  return result;
}

/**
 * Neutralize a set of currently VISIBLE windows that each still carry an accepted-but-
 * uncommitted legacy minimize (a `pendingMinimize` record). One "not minimized" read
 * is not proof, so a corrective request is issued to the window's CURRENT visible
 * state, then `quietPolls` consecutive non-minimized reads are required. If the old
 * minimize lands mid-proof it is observed, restored, and the count restarts (bounded
 * by `maxRequests`). Returns a Map id -> true (proven quiet) | false (unresolved).
 * @param {{id:number, desired:string}[]} recs
 * @returns {Promise<Map<number, boolean>>}
 */
async function quietProof(recs) {
  const { pollIntervalMs, maxRequests, quietPolls } = convergeConfig;
  const result = new Map();
  const active = new Map();
  for (const { id, desired } of recs) active.set(id, { desired, restores: 0, quiet: 0 });
  await dispatchBatch([...active].map(([id, s]) => ({ id, desired: s.desired })));

  const need = Math.max(1, Number(quietPolls) || 1);
  while (active.size) {
    await sleep(pollIntervalMs);
    const reRestore = [];
    for (const [id, s] of [...active]) {
      const w = await readWindow(id);
      if (w === null || w.incognito) { result.set(id, true); active.delete(id); continue; }
      if (w.state === "minimized") {
        s.quiet = 0;
        if (s.restores >= maxRequests) { result.set(id, false); active.delete(id); continue; }
        s.restores += 1;
        reRestore.push({ id, desired: s.desired });
      } else if (++s.quiet >= need) {
        result.set(id, true); active.delete(id);
      }
    }
    await dispatchBatch(reRestore);
  }
  return result;
}

/* ------------------------- serialized transaction queue ------------------------
 * Every retirement trigger (worker spin-up, install/update, alarm, window close,
 * a stale End message) runs through one promise chain so they can never overlap
 * destructively. The chain never rejects the queue itself. */
let queue = Promise.resolve();
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------- state + alarm -------------------------------- */

/** @returns {Promise<import("./types.js").FocusState|null>} */
async function readFocusState() {
  const r = await chrome.storage.local.get(FOCUS_STATE_KEY);
  return r[FOCUS_STATE_KEY] ?? null;
}
async function writeFocusState(state) {
  await chrome.storage.local.set({ [FOCUS_STATE_KEY]: state });
}
async function clearFocusState() {
  await chrome.storage.local.remove(FOCUS_STATE_KEY);
}
async function clearAlarm() {
  await chrome.alarms.clear(FOCUS_ALARM);
}
/** Arm the single calm one-shot retry so an incomplete drain finishes automatically. */
async function armRetry() {
  await chrome.alarms.create(FOCUS_ALARM, { when: Date.now() + (Number(convergeConfig.retryMs) || 5000) });
}

/* --------------------------------- the drain ---------------------------------- */

/**
 * Restoration-only drain of a legacy `focusState`. Idempotent and serialized so
 * overlapping triggers coalesce.
 *
 *  - No legacy state: clear any stale legacy alarm and perform ZERO window mutation.
 *  - Otherwise treat the old run as ending (never honored as an active product
 *    state) and reconcile its recovery ledger, RESTORE direction only:
 *      • a recorded window still minimized → converge it back to its prior state;
 *      • a `pendingMinimize` record still visible → quiet-proof it (a late legacy
 *        minimize is corrected before the record is dropped);
 *      • a recorded window the user already made visible → dropped, never forced back;
 *      • a closed recorded window → pruned;
 *      • incognito → never touched.
 *  - If every record resolves, remove `focusState` and the alarm.
 *  - If some window will not converge, retain ONLY the unresolved records under
 *    `phase:"ending"` and arm exactly one calm retry alarm; a later drain finishes it.
 *
 * Never minimizes a window, never creates a run, never restores a session, never
 * opens a window.
 * @returns {Promise<{complete: boolean, restored: number[], unresolved: number[]}>}
 */
export function drainLegacyFocus() {
  return serialize(async () => {
    const state = await readFocusState();
    if (!state) {
      // No legacy run: the retirement path performs no window mutation. Drop any
      // stale legacy alarm so nothing fires later (focus-mode.md §9.7).
      await clearAlarm();
      return { complete: true, restored: [], unresolved: [] };
    }
    // The old run is always ending — its target is never honored as active again.
    if (state.phase !== "ending") await writeFocusState({ ...state, phase: "ending" });
    await clearAlarm();

    const restoreSpecs = [];
    const neutralizeRecs = [];
    const recById = new Map();
    for (const rec of state.minimized ?? []) {
      let w;
      try {
        w = await chrome.windows.get(rec.windowId);
      } catch {
        continue; // closed → pruned
      }
      if (!w || w.incognito) continue; // incognito never touched
      if (w.state === "minimized") {
        restoreSpecs.push({ id: rec.windowId, desired: rec.priorState });
        recById.set(rec.windowId, rec);
      } else if (rec.pendingMinimize === true) {
        neutralizeRecs.push({ id: rec.windowId, desired: w.state });
        recById.set(rec.windowId, rec);
      }
      // else: confirmed record the user already made visible → resolved, dropped.
    }

    const remaining = [];
    const restored = [];
    if (restoreSpecs.length) {
      const res = await convergeBatch(restoreSpecs, (x) => x.state !== "minimized");
      for (const [id, r] of res) {
        if (r === "timeout") remaining.push(recById.get(id));
        else if (r === "ok") restored.push(id);
      }
    }
    if (neutralizeRecs.length) {
      const proof = await quietProof(neutralizeRecs);
      for (const [id, ok] of proof) if (!ok) remaining.push(recById.get(id));
    }

    if (remaining.length > 0) {
      // Keep ONLY the unresolved records (still `ending`) and schedule one calm
      // retry so recovery is automatic; there is no user-facing stuck control.
      await writeFocusState({ ...state, phase: "ending", minimized: remaining });
      await armRetry();
      return { complete: false, restored, unresolved: remaining.map((m) => m.windowId) };
    }

    await clearFocusState();
    await clearAlarm();
    return { complete: true, restored, unresolved: [] };
  });
}

/**
 * Full browser startup: pre-restart window IDs are meaningless, so they must NEVER
 * drive `chrome.windows.update`. Clear any legacy `focusState` and its alarm without
 * touching a window (a stale stored ID could coincide with a current window's ID).
 */
export function retireFocusFullStart() {
  return serialize(async () => {
    const state = await readFocusState();
    if (!state) { await clearAlarm(); return; }
    await clearAlarm();
    await clearFocusState();
  });
}

/* -------- boot-recovery arbitration --------
 * A genuine full browser start (`runtime.onStartup`) owns boot recovery and clears
 * without restoring; a plain service-worker spin-up defers so it yields to that. */
let fullStartClaimed = false;
/** Called synchronously from `runtime.onStartup` so a deferred worker drain yields. */
export function claimFullStart() {
  fullStartClaimed = true;
}
/**
 * Dispatch the worker-restart drain on a short delay so a full browser start can
 * claim boot recovery first. A plain worker spin-up (no onStartup) still drains.
 * @param {number} [delayMs]
 */
export function scheduleRetirementDrain(delayMs = 1500) {
  setTimeout(() => {
    if (fullStartClaimed) return; // a full browser start already owns boot recovery
    void drainLegacyFocus();
  }, delayMs);
}

/** The legacy `focus-end` alarm now only drives the restoration drain. */
export function handleFocusAlarm() {
  return drainLegacyFocus();
}

/**
 * A window closed: prune it from the legacy recovery ledger; if that empties the
 * ledger, remove `focusState` and the alarm. Serialized, composes with the existing
 * session-binding cleanup in `background.js` (neither races the other).
 * @param {number} windowId
 */
export function onFocusWindowRemoved(windowId) {
  return serialize(async () => {
    const state = await readFocusState();
    if (!state) return;
    const minimized = (state.minimized ?? []).filter((m) => m.windowId !== windowId);
    if (minimized.length === (state.minimized ?? []).length) return; // not a recorded window
    if (minimized.length === 0) {
      await clearFocusState();
      await clearAlarm();
      return;
    }
    await writeFocusState({ ...state, minimized });
  });
}
