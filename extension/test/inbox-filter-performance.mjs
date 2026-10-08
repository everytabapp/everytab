/**
 * Inbox filter keystroke cost at T2 (1,500 Inbox tabs) and T3 (5,000).
 *   before: the .659 path, which re-read and re-cloned the Inbox, the Session
 *           identity index and the automation awareness inputs per keystroke;
 *   after:  a filter-driven render that reuses the last read.
 * Node compute with the minimal DOM double, no layout or IPC; the seed has no
 * favicon payloads, so the "before" clone cost is a lower bound for a real
 * profile. Budgets are generous multiples of the measured "after" medians.
 *
 *     node test/inbox-filter-performance.mjs      (from extension/)
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { HOSTED_BUDGET_SCALE } from "./hosted-runner.mjs";

const nativeClone = globalThis.structuredClone.bind(globalThis);
const mem = {};
let keyReads = {};
const storageListeners = new Set();
installDomFixture();
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://inbox-filter-perf/${path}` },
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
  tabs: { query: async () => [] },
  windows: { getAll: async () => [] }
};
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const { buildTierData } = await import("../../tools/perf-seed.mjs");
const { STORE_KEYS } = await import("../js/lib/types.js");
const { SESSION_IDENTITY_INDEX_KEY, buildSessionIdentityIndex } =
  await import("../js/lib/session-identity-index.js");
const { createInboxSurface } = await import("../js/ui/inbox-surface.js");
const { el } = await import("../js/ui/dom.js");

function loadTier(tier) {
  const previous = Object.keys(mem);
  for (const key of previous) delete mem[key];
  Object.assign(mem, buildTierData(tier).payload.data);
  mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {});
  const changes = Object.fromEntries([...new Set([...previous, ...Object.keys(mem)])]
    .map((key) => [key, { newValue: mem[key] ?? null }]));
  for (const listener of storageListeners) listener(changes, "local");
}

let cloneCount = 0;
globalThis.structuredClone = (value, options) => { cloneCount += 1; return nativeClone(value, options); };

async function median(fn, runs = 5) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    keyReads = {}; cloneCount = 0;
    const started = performance.now();
    await fn();
    samples.push({ ms: performance.now() - started, inboxReads: keyReads[STORE_KEYS.inbox] ?? 0, clones: cloneCount });
  }
  samples.sort((a, b) => a.ms - b.ms);
  return samples[Math.floor(runs / 2)];
}

const rows = [];
let failures = 0;
for (const [tier, budgetMs] of [["t2", 120], ["t3", 350]]) {
  loadTier(tier);
  const host = el("div");
  document.body.append(host);
  // Time the render the keystroke triggers, not the control's 60 ms debounce.
  let renderMs = 0;
  let renderDone = null;
  const surface = createInboxSurface({
    rerender: () => {
      const started = performance.now();
      const done = surface.render().then((result) => { renderMs = performance.now() - started; return result; });
      renderDone?.(done);
      return done;
    },
    shouldRenderBody: () => true,
    filterHost: host,
    automationAwareness: { inbox: () => null },
    renderLabels() {}, goToLabel() {}, goToSession() {}, showNotice() {}, showToast() {},
    flashNote() {}, copyRefs() {}, sessionComboboxButton: () => el("span"), cardLabelPanel() {},
    confirmDelete: async () => true, buildSnoozePanel: () => el("div"), openRowLabel() {}
  });
  const input = host.querySelector(".open-filter-input");
  input.setSelectionRange ??= () => {};
  input.focus ??= () => {};
  await surface.render();
  input.value = "review";
  // before: an ordinary render with a query set (what every keystroke cost in .659)
  const before = await median(() => surface.render());
  // after: the filter-driven render (the control's debounced commit path)
  const afterSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const triggered = new Promise((resolve) => { renderDone = resolve; });
    keyReads = {}; cloneCount = 0;
    await input.dispatch("input");
    await (await triggered);
    afterSamples.push({ ms: renderMs, inboxReads: keyReads[STORE_KEYS.inbox] ?? 0, clones: cloneCount });
  }
  afterSamples.sort((a, b) => a.ms - b.ms);
  const after = afterSamples[2];
  // The remaining cost is building the matching cards; the reads are gone.
  // A hosted runner enforces the documented multiple of the Mac-calibrated
  // absolute budget; the zero-read and 0.6x-of-before checks are never scaled.
  const enforcedMs = budgetMs * HOSTED_BUDGET_SCALE;
  const ok = after.inboxReads === 0 && after.ms <= enforcedMs && after.ms <= before.ms * 0.6;
  if (ok && after.ms > budgetMs) {
    console.log(`OBSERVATION (hosted runner): Inbox filter ${tier} ${after.ms.toFixed(1)}ms exceeds ` +
      `the local ${budgetMs}ms budget; enforced hosted budget ${enforcedMs}ms`);
  }
  if (!ok) failures += 1;
  rows.push({ tier, beforeMs: before.ms.toFixed(1), beforeClones: before.clones, afterMs: after.ms.toFixed(1), afterInboxReads: after.inboxReads, afterClones: after.clones, budgetMs, enforcedMs, ok });
  host.remove();
}
console.table(rows);
assert.equal(failures, 0, "Inbox filter keystroke stays within budget with zero Inbox reads");
console.log("PASS: Inbox filter keystroke reuses the last read at T2/T3 within budget");
