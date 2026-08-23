/**
 * E2-0 test doubles — interleavable chrome.storage.local mock + mock LockManager.
 * Test-only (imported by test/smoke.mjs). See `e2-0-storage-concurrency.md` §5.
 *
 * The interleavable storage lets a test script the exact cross-context
 * interleaving of two read-modify-write sequences (A.get → B.get → A.set →
 * B.set) that real Chrome can produce between any two extension contexts.
 * The mock LockManager is the Node stand-in for `navigator.locks` that batch
 * E2-0b's `withStoreLock` will be tested against (§4.2), including the MV3
 * context-death auto-release that makes Web Locks safe there (§3, option B).
 */

/**
 * A chrome.storage.local double whose get/set calls can be paused and released
 * one at a time (FIFO), so two contexts' RMW sequences interleave
 * deterministically. Unlike the convenience mock in smoke.mjs, values are
 * deep-copied on both get and set — real chrome.storage returns independent
 * deserialized objects, and that independence is exactly what makes
 * whole-map RMW lossy (each context mutates its own stale copy).
 *
 * @param {Record<string, any>} [seed] initial contents
 */
export function createInterleavableStorage(seed = {}) {
  let mem = structuredClone(seed);
  let paused = false;
  /** @type {Array<{kind: "get"|"set", keys: string[], fire: () => void}>} queued ops, FIFO */
  const queue = [];
  /** @type {string[][]} ledger: keys of every set() call, in commit order (§7.3) */
  const setLog = [];
  /** @type {string[][]} ledger: keys of every get() call, in completion order */
  const getLog = [];
  const changeListeners = new Set();
  const pendingChanges = [];
  let changesPaused = false;

  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const doGet = (keys) => {
    getLog.push((typeof keys === "string" ? [keys] : [...keys]).sort());
    if (typeof keys === "string") return keys in mem ? { [keys]: clone(mem[keys]) } : {};
    const out = {};
    for (const k of keys) if (k in mem) out[k] = clone(mem[k]);
    return out;
  };
  const doSet = (obj) => {
    const changes = {};
    for (const [key, value] of Object.entries(obj)) {
      changes[key] = { oldValue: clone(mem[key]), newValue: clone(value) };
    }
    setLog.push(Object.keys(obj).sort());
    Object.assign(mem, clone(obj));
    if (changesPaused) pendingChanges.push(changes);
    else for (const listener of changeListeners) listener(clone(changes), "local");
  };
  const gated = (kind, keys, run) =>
    new Promise((resolve, reject) => {
      const fire = () => {
        try {
          resolve(run());
        } catch (e) {
          reject(e);
        }
      };
      if (paused) queue.push({ kind, keys, fire });
      else fire();
    });
  /** let released ops' continuations (awaits after get/set) run to their next storage call */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  return {
    setLog,
    getLog,
    /** deep-copied view of current contents */
    snapshot: () => structuredClone(mem),
    /** number of storage ops currently blocked awaiting release */
    pending: () => queue.length,
    /** descriptors of the blocked ops, in queue order (for stepAt targeting) */
    pendingOps: () => queue.map(({ kind, keys }) => ({ kind, keys: [...keys] })),
    pause() {
      paused = true;
    },
    /** Hold onChanged delivery after commits, without holding the commits. */
    pauseChanges() {
      changesPaused = true;
    },
    /** Deliver every committed change event in commit order. */
    flushChanges() {
      changesPaused = false;
      while (pendingChanges.length) {
        const changes = pendingChanges.shift();
        for (const listener of changeListeners) listener(clone(changes), "local");
      }
    },
    /** release everything queued (and anything they enqueue) until quiescent */
    async resume() {
      paused = false;
      while (queue.length) queue.shift().fire();
      await settle();
    },
    /** release the single oldest pending op, then settle its continuation */
    async step() {
      if (queue.length) queue.shift().fire();
      await settle();
    },
    /**
     * Release the pending op at queue index i (out-of-order — this is how a
     * test scripts e.g. "the sync's whole-map set lands AFTER the interleaved
     * local upsert committed", the §2.3 R3 ordering).
     */
    async stepAt(i) {
      const [op] = queue.splice(i, 1);
      if (op) op.fire();
      await settle();
    },
    /** drop-in for chrome.storage.local */
    local: {
      get: (keys) => gated("get", typeof keys === "string" ? [keys] : [...keys], () => doGet(keys)),
      set: (obj) => gated("set", Object.keys(obj).sort(), () => doSet(obj))
    },
    onChanged: {
      addListener: (listener) => changeListeners.add(listener),
      removeListener: (listener) => changeListeners.delete(listener)
    }
  };
}

/**
 * Minimal exclusive-mode LockManager double for `navigator.locks` (§4.1/§4.2).
 * Supports: exclusive FIFO queueing per lock name, `ifAvailable` (callback
 * receives null instead of queueing), a `context` tag per request, and
 * `die(context)` — the MV3 auto-release: a dead context's held locks release
 * immediately even though its callback never settles, and its queued waiters
 * are abandoned. Grant hand-off is synchronous (holder assigned before any
 * other microtask can observe the lock free), so tests are deterministic.
 */
export function createMockLockManager() {
  /** @type {Map<string, {holder: {context: string, release: () => void}|null, waiters: Array<{context: string, grant: () => void}>}>} */
  const locks = new Map();
  /** context tag applied to requests that don't pass one — production code
   * never passes a context, so tests set this before driving a code path
   * "from" a given extension context (then die() that context). */
  let defaultContext = "default";
  const entry = (name) => {
    if (!locks.has(name)) locks.set(name, { holder: null, waiters: [] });
    return locks.get(name);
  };
  const mkHolder = (e, context) => {
    let released = false;
    const holder = {
      context,
      release() {
        if (released) return;
        released = true;
        e.holder = null;
        const next = e.waiters.shift();
        if (next) next.grant(); // synchronous hand-off: no observable free gap
      }
    };
    return holder;
  };

  /**
   * @param {string} name
   * @param {{ifAvailable?: boolean, context?: string}|((lock: object|null) => any)} opts
   * @param {(lock: object|null) => any} [cb]
   */
  async function request(name, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const e = entry(name);
    const context = opts.context ?? defaultContext;
    if (e.holder) {
      if (opts.ifAvailable) return cb(null);
      await new Promise((res) => {
        e.waiters.push({
          context,
          grant: () => {
            e.holder = mkHolder(e, context);
            res();
          }
        });
      });
    } else {
      e.holder = mkHolder(e, context);
    }
    const held = e.holder;
    try {
      return await cb({ name, mode: "exclusive" });
    } finally {
      held.release();
    }
  }

  /** Simulate MV3 context death: force-release held locks, abandon queued waits. */
  function die(context) {
    for (const e of locks.values()) {
      e.waiters = e.waiters.filter((w) => w.context !== context);
      if (e.holder?.context === context) e.holder.release();
    }
  }

  return {
    request,
    die,
    setDefaultContext: (name) => (defaultContext = name),
    /** context currently holding the named lock, or null */
    heldBy: (name) => entry(name).holder?.context ?? null,
    queuedCount: (name) => entry(name).waiters.length
  };
}
