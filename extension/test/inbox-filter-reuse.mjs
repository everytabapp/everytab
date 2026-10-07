/**
 * Typing in the Inbox filter used to re-read and re-clone the whole Inbox,
 * the Session identity index and the automation awareness inputs on every
 * keystroke. A filter-driven render now reuses the last read while every key
 * it came from is unchanged, and reads fresh after any storage change.
 *
 *     node test/inbox-filter-reuse.mjs      (from extension/)
 */
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

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
  runtime: { getURL: (path) => `chrome-extension://inbox-filter/${path}` },
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

Object.assign(mem, buildTierData("t1").payload.data);
mem[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(mem[STORE_KEYS.sessions] ?? {});
const notify = (changes) => { for (const listener of storageListeners) listener(changes, "local"); };
notify(Object.fromEntries(Object.keys(mem).map((key) => [key, { newValue: mem[key] }])));

let cloneCount = 0;
let inboxClones = 0;
const anInboxId = Object.keys(mem[STORE_KEYS.inbox])[0];
globalThis.structuredClone = (value, options) => {
  cloneCount += 1;
  if (value && typeof value === "object" && anInboxId in value) inboxClones += 1;
  return nativeClone(value, options);
};
let renders = 0;
const surface = createInboxSurface({
  rerender: async () => { renders += 1; return surface.render(); },
  shouldRenderBody: () => true,
  filterHost: document.body,
  automationAwareness: { inbox: () => null },
  renderLabels() {}, goToLabel() {}, goToSession() {}, showNotice() {}, showToast() {},
  flashNote() {}, copyRefs() {}, sessionComboboxButton: () => el("span"), cardLabelPanel() {},
  confirmDelete: async () => true, buildSnoozePanel: () => el("div"), openRowLabel() {}
});

async function measured(fn) {
  keyReads = {}; cloneCount = 0; inboxClones = 0;
  const result = await fn();
  return { result, inboxReads: keyReads[STORE_KEYS.inbox] ?? 0, clones: cloneCount, inboxClones };
}

const first = await measured(() => surface.render());
assert.ok(first.result.node, "the Inbox renders its list");
const totalRows = first.result.node.querySelectorAll("[data-tablist-row]").length;
assert.ok(totalRows > 50, `the T1 Inbox renders every row before filtering (${totalRows})`);

// A filter keystroke: the control debounces, then calls rerender().
const input = surface.handleFilterShortcut ? document.querySelector(".open-filter-input") : null;
assert.ok(input, "the Inbox filter is mounted and exposes its shortcut handler");
// The minimal DOM double has no text selection API; the control restores the caret after a render.
input.setSelectionRange ??= () => {};
input.focus ??= () => {};
assert.equal(input.getAttribute("aria-keyshortcuts"), "f", "the Inbox filter advertises F");
const typed = await measured(async () => {
  input.value = "review";
  await input.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 90));
  return renders;
});
assert.equal(typed.result, 1, "the debounced keystroke requested one rerender");
assert.equal(typed.inboxReads, 0, "a filter keystroke reads no Inbox storage");
// Small maps such as Starred still come through the store cache for row state;
// the Inbox map itself is never cloned again for a keystroke.
assert.equal(typed.inboxClones, 0, "a filter keystroke never clones the Inbox map");
// The typed characters hide non-matching mounted rows at once, before the rebuild.
input.value = "zzz-no-such-row";
await input.dispatch("input");
const liveHidden = [...document.querySelectorAll("[data-tablist-row]")].every((row) => row.hidden);
assert.ok(liveHidden, "typing hides non-matching mounted rows immediately, before the debounced rebuild");
input.value = "review";
await input.dispatch("input");
await new Promise((resolve) => setTimeout(resolve, 200));
const filtered = (await surface.render()).node.querySelectorAll("[data-tablist-row]").length;
assert.ok(filtered < totalRows, `the filter narrows the rows (${filtered} of ${totalRows})`);

// A storage change between keystrokes invalidates the reuse.
const inbox = mem[STORE_KEYS.inbox];
const firstId = Object.keys(inbox)[0];
inbox[firstId] = { ...inbox[firstId], labels: ["fresh-label"] };
notify({ [STORE_KEYS.inbox]: { newValue: inbox } });
const afterChange = await measured(async () => {
  input.value = "review docs";
  await input.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 200));
});
assert.ok(afterChange.inboxReads >= 1, "a filter keystroke after a storage change reads fresh Inbox data");

// A non-filter render (data refresh) never reuses the filter path.
const dataRefresh = await measured(() => surface.render());
assert.ok(dataRefresh.result.node, "ordinary renders still build the list");
console.log(`PASS: Inbox filter keystrokes reuse the last read (0 Inbox reads, 0 clones) until storage changes; F shortcut exposed; ${filtered}/${totalRows} rows after filtering`);
