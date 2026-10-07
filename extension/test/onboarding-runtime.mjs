import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const dom = installDomFixture();
const keys = new Set();
document.addEventListener = (_type, listener) => keys.add(listener);
document.removeEventListener = (_type, listener) => keys.delete(listener);
const memory = { settings: { uiScheme: "tide", uiMode: "scheme", uiInterfaceStyle: "soft",
  newTabMode: "dashboard", newTabFocus: "search", suspendEnabled: true } };
let heldSave = null;
let failSave = false;
const writes = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(), runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      async get(requested) {
        const wanted = requested == null ? Object.keys(memory) : [].concat(requested);
        return Object.fromEntries(wanted.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])]));
      },
      async set(values) {
        if (values.settings) {
          if (heldSave) await heldSave;
          if (failSave) throw new Error("fixture save rejected");
        }
        writes.push(structuredClone(values));
        Object.assign(memory, structuredClone(values));
      },
      async remove(requested) { for (const key of [].concat(requested)) delete memory[key]; }
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};
Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name, _options, work) => work() } });
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const tour = await import("../js/ui/onboarding.js");
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const overlay = () => document.querySelector(".ob-overlay");
const step = (index) => overlay().querySelectorAll(".ob-progress-step")[index].dispatch("click");
const skip = () => overlay().querySelector(".ob-head button").dispatch("click");
try {
  await Promise.all([tour.showOnboarding(), tour.showOnboarding()]);
  assert.equal(document.querySelectorAll(".ob-overlay").length, 1, "Concurrent open requests mount once");
  assert.match(overlay().textContent, /Clear the tab clutter/);
  assert.equal(writes.some((value) => value.settings), false, "Opening the tour never writes user preferences");
  await step(1);
  assert.equal(overlay().querySelectorAll(".ob-definitions section").length, 3);
  await step(2);
  assert.equal(overlay().querySelector('[data-automation="suspend"]').checked, true);
  const featureDisclosure = overlay().querySelector(".ob-explore");
  featureDisclosure.open = true;
  await step(3);
  assert.equal(Boolean(featureDisclosure.open), false, "Feature discovery closes on every step change");
  let release;
  heldSave = new Promise((resolve) => { release = resolve; });
  const blank = overlay().querySelector('input[value="blank"]');
  blank.checked = true;
  const saving = blank.dispatch("change");
  const finishing = skip();
  await settle();
  assert.ok(overlay(), "Immediate Skip waits for the choice already enrolled by the radio event");
  assert.equal(memory.onboardingDone, undefined);
  release();
  await Promise.all([saving, finishing]);
  heldSave = null;
  assert.equal(memory.settings.newTabMode, "blank");
  assert.equal(memory.settings.newTabFocus, "search");
  assert.equal(memory.onboardingDone, true);
  assert.equal(memory.onboardingPage, undefined);
  assert.equal(overlay(), null);
  await tour.maybeShowOnboarding();
  assert.equal(overlay(), null, "Completed profiles are not forced through the tour");

  await tour.replayOnboarding();
  await step(4);
  const mountedOverlay = overlay();
  const mountedCard = mountedOverlay.querySelector(".ob-card");
  const mountedBody = mountedOverlay.querySelector(".ob-body-host");
  const mountedAppearance = mountedOverlay.querySelector(".ob-appearance");
  mountedBody.scrollTop = 37;
  failSave = true;
  const warn = console.warn;
  console.warn = () => {};
  try { await overlay().querySelector('[data-style-sample="crisp"]').dispatch("click"); }
  finally { console.warn = warn; }
  assert.equal(memory.settings.uiInterfaceStyle, "soft");
  assert.match(overlay().querySelector(".ob-save-status").textContent, /couldn.t be saved/i);
  assert.equal(overlay().querySelector('[data-style-sample="soft"]').getAttribute("aria-pressed"), "true");
  failSave = false;
  await overlay().querySelector('[data-style-sample="crisp"]').dispatch("click");
  assert.equal(memory.settings.uiInterfaceStyle, "crisp");
  assert.equal(overlay().querySelector(".ob-save-status").classList.contains("bad"), false);
  assert.equal(overlay(), mountedOverlay, "Scheme choices keep the same tour overlay mounted");
  assert.equal(overlay().querySelector(".ob-card"), mountedCard);
  assert.equal(overlay().querySelector(".ob-body-host"), mountedBody);
  assert.equal(overlay().querySelector(".ob-appearance"), mountedAppearance);
  assert.equal(mountedBody.scrollTop, 37, "Scheme choices preserve the current tour scroll position");
  await step(5);
  window.showDirectoryPicker = async () => { throw new DOMException("Cancelled", "AbortError"); };
  await overlay().querySelector(".ob-vault-actions .primary").dispatch("click");
  assert.equal(overlay().querySelector(".ob-vault-status").textContent, "No folder was changed.");
  assert.equal(overlay().querySelectorAll(".ob-vault-actions button").length, 1,
    "Vault keeps only its folder action in the body");
  window.showDirectoryPicker = async () => ({
    async *entries() { yield ["unrelated.txt", { kind: "file" }]; },
    async getDirectoryHandle() {}, async getFileHandle() {}
  });
  await overlay().querySelector(".ob-vault-actions .primary").dispatch("click");
  assert.equal(overlay().querySelector(".ob-vault-status").textContent,
    "Choose an empty folder or an existing EveryTab Vault.",
    "onboarding shares the safe actionable folder rejection guidance");
  const previousIndexedDB = globalThis.indexedDB;
  const persistenceWarnings = [];
  const previousWarn = console.warn;
  window.showDirectoryPicker = async () => ({
    name: "Synthetic empty Vault", async *entries() {},
    async getDirectoryHandle() {}, async getFileHandle() {}
  });
  globalThis.indexedDB = { open() { throw new DOMException("Synthetic private path", "AbortError"); } };
  console.warn = (...args) => persistenceWarnings.push(args);
  try { await overlay().querySelector(".ob-vault-actions .primary").dispatch("click"); }
  finally {
    console.warn = previousWarn;
    if (previousIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDB;
  }
  assert.match(overlay().querySelector(".ob-vault-status").textContent, /couldn.t be connected/,
    "an aborted handle-persistence operation is not picker cancellation");
  assert.deepEqual(persistenceWarnings, [["EveryTab: onboarding Vault connection failed [name:AbortError]"]]);
  assert.equal(overlay().querySelector(".ob-vault-actions .primary").disabled, false);
  const vaultWarnings = [];
  const originalWarn = console.warn;
  window.showDirectoryPicker = async () => {
    throw { get name() { throw new Error("private title"); }, message: "https://private.example" };
  };
  console.warn = (...args) => vaultWarnings.push(args);
  try { await overlay().querySelector(".ob-vault-actions .primary").dispatch("click"); }
  finally { console.warn = originalWarn; }
  assert.deepEqual(vaultWarnings,
    [["EveryTab: onboarding Vault connection failed [name:UnknownError]"]],
    "a hostile picker error emits one sanitized warning and leaves the action usable");
  assert.equal(overlay().querySelector(".ob-vault-actions .primary").disabled, false);
  assert.notEqual(overlay().querySelector(".ob-vault-status").textContent, "No folder was changed.");
  const finish = overlay().querySelector(".ob-foot .primary");
  assert.equal(finish.hidden, false);
  assert.equal(finish.textContent, "Finish");
  await finish.dispatch("click");
  assert.equal(overlay(), null, "The footer Finish action completes the final step");
  assert.equal(keys.size, 0, "Finishing removes the tour keyboard owner");
  console.log("PASS: real onboarding mounts once, preserves preferences, orders saves before Skip, retries failure, and cancels Vault truthfully");
} finally { dom.restore(); }
