/**
 * E3-0 — dev-only performance instrumentation (e3-performance-pass.md §3.2).
 *
 * Activation (BOTH dev-only; instrumentation never ships enabled):
 *  - `?perf=1` on any extension page URL — synchronous, so it catches the
 *    dashboard's earliest boot spans. Use this for B3/B4/B11 boot numbers.
 *  - hidden `settings.perfHud` (no UI anywhere; flip it from any extension
 *    page's console with the store helper:
 *    `import("./js/lib/store.js").then(m => m.patchSettings({ perfHud: true }))`
 *    — adjust the path per page, e.g. "../lib/store.js" is already imported by
 *    every surface). Read asynchronously at module load, so the first few
 *    milliseconds of a page's spans can be missed; it exists for surfaces that
 *    can't take a URL param (the real toolbar popup). The popup additionally
 *    calls `activateFromSettings` as soon as its own settings read lands.
 *
 * When inactive, every exported call is a guarded no-op: `pspan` returns a
 * shared frozen function and nothing allocates or touches `performance` —
 * zero cost on the prod path. No behavior, timing, or DOM difference either
 * way beyond the marks themselves.
 *
 * Output: `preport()` prints a console.table of spans (+ one of counters) and
 * a copyable JSON blob between `----8<----` markers, so MH can paste results
 * back verbatim (§7 protocol). While active, `globalThis.__etPerf` exposes
 * {report, entries, counts} for ad-hoc console use.
 *
 * This module writes NOTHING to storage (E2-0 §5.4 guardrail-clean: it only
 * ever calls chrome.storage.local.get) and imports nothing, so it is safe to
 * import from any context (dashboard, popup, options, Node tests).
 */

const NOOP = Object.freeze(() => {});

const state = {
  active: false,
  /** @type {{name: string, at: number, ms: number|null, detail?: string}[]} */
  entries: [],
  /** @type {Map<string, {n: number, ms: number}>} */
  counts: new Map()
};

const round = (x) => Math.round(x * 100) / 100;

/** Is instrumentation live? (Callers may gate a `preport()` on this.) */
export function perfActive() {
  return state.active;
}

function publish() {
  try {
    globalThis.__etPerf = { report: preport, entries: state.entries, counts: state.counts };
  } catch {
    /* sandboxed global — reporting still works via the console.table path */
  }
}

/** Turn instrumentation on (idempotent). */
function activate() {
  if (state.active) return;
  state.active = true;
  publish();
}

/**
 * Popup path: the settings object is already in hand right after
 * `getSettings()` — activate synchronously from it instead of racing the
 * module-load storage read. No-op unless `settings.perfHud` is truthy.
 * @param {{perfHud?: boolean}|null|undefined} settings
 */
export function activateFromSettings(settings) {
  if (settings?.perfHud) activate();
}

/**
 * Module-load activation: synchronous `?perf=1` check, then the async hidden
 * `settings.perfHud` upgrade. Exported for tests; runs once at import.
 */
export function initPerf() {
  try {
    if (typeof location !== "undefined" &&
        new URLSearchParams(location.search).get("perf") === "1") {
      activate();
    }
  } catch {
    /* no usable `location` (worker / Node) — the setting check below stands */
  }
  try {
    chrome?.storage?.local?.get("settings")
      .then((r) => activateFromSettings(r?.settings))
      .catch(() => {});
  } catch {
    /* no chrome (Node) — stays off unless a test activates via settings */
  }
}

/**
 * Point-in-time mark (shows in the report with `ms: null`, and as a
 * `performance.mark` for the DevTools timeline).
 * @param {string} name
 */
export function pmark(name) {
  if (!state.active) return;
  try { performance.mark(`et:${name}`); } catch { /* timeline only — optional */ }
  state.entries.push({ name, at: round(performance.now()), ms: null });
}

/**
 * Start a span; returns an end function that records the duration (call it
 * once — extra calls record extra entries by design, so guard multi-path call
 * sites). Inactive → a shared frozen no-op, so call sites never branch.
 * @param {string} name
 * @returns {(detail?: string) => void}
 */
export function pspan(name) {
  if (!state.active) return NOOP;
  const start = performance.now();
  return (detail) => {
    if (!state.active) return;
    const end = performance.now();
    try {
      performance.measure(`et:${name}`, { start, end });
    } catch { /* timeline only — optional */ }
    state.entries.push({
      name, at: round(start), ms: round(end - start),
      ...(detail ? { detail: String(detail) } : {})
    });
  };
}

/**
 * Record an externally-measured duration (e.g. the popup's script-start→filled
 * time, whose start predates activation).
 * @param {string} name @param {number} ms @param {string} [detail]
 */
export function precord(name, ms, detail) {
  if (!state.active) return;
  state.entries.push({
    name, at: round(performance.now()), ms: round(ms),
    ...(detail ? { detail: String(detail) } : {})
  });
}

/**
 * Bump a named counter (onChanged fan-out: render count + total render ms per
 * change event, §3.2).
 * @param {string} name @param {number} [n] @param {number} [ms]
 */
export function pcount(name, n = 1, ms = 0) {
  if (!state.active) return;
  const c = state.counts.get(name) ?? { n: 0, ms: 0 };
  c.n += n;
  c.ms += ms;
  state.counts.set(name, c);
}

/**
 * Print the report: spans table, counters table, then the copyable JSON blob.
 * Returns the blob (null when inactive) so callers/tests can use it directly.
 */
export function preport() {
  if (!state.active) return null;
  const spans = state.entries.filter((e) => e.ms !== null);
  const marks = state.entries.filter((e) => e.ms === null);
  const counters = [...state.counts.entries()]
    .map(([name, c]) => ({ name, n: c.n, totalMs: round(c.ms) }));
  if (spans.length) console.table(spans);
  if (marks.length) console.table(marks);
  if (counters.length) console.table(counters);
  const blob = JSON.stringify({
    at: new Date().toISOString(),
    url: typeof location !== "undefined" ? location.href : "",
    spans, marks, counters
  }, null, 2);
  console.log(`EveryTab perf JSON (copy between the markers):\n----8<----\n${blob}\n---->8----`);
  return blob;
}

initPerf();
