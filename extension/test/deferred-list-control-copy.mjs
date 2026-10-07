/** Real list controls defer invisible copy while retaining confirmation/picker behavior. */
import test, { beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { getEnglishMessage } from "./message-fixture.mjs";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const saved = new Map(["chrome", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame",
  "MutationObserver", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const dom = installDomFixture();
const lookups = [], timers = new Map();
let now = 0, sequence = 0, sessionReads = 0;
globalThis.chrome = { i18n: { getMessage(key, substitutions) {
  lookups.push(key); return getEnglishMessage(key, substitutions);
} }, storage: { local: { get: async () => ({}) } } };
window.innerWidth = 400; window.innerHeight = 800;
window.addEventListener = () => {};
window.removeEventListener = () => {};
document.contains = node => document.documentElement.contains(node);
globalThis.MutationObserver = globalThis.ResizeObserver = class {
  observe() {} disconnect() {}
};
globalThis.requestAnimationFrame = () => ++sequence;
globalThis.cancelAnimationFrame = () => {};
// Supply browser selector/attribute operations absent from the small shared DOM
// fixture. These adapters do not replace any list-control or combobox behavior.
const createElement = document.createElement.bind(document);
document.createElement = tag => {
  const node = createElement(tag), queryAll = node.querySelectorAll.bind(node);
  node.hasAttribute = name => node.getAttribute(name) !== null;
  node.querySelectorAll = selector => [...new Set(selector.split(",").flatMap(part => {
    const exclusions = [...part.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
    const base = part.replace(/:not\([^)]+\)/g, "");
    return queryAll(base).filter(found => exclusions.every(excluded => !found.matches(excluded)));
  }))];
  return node;
};
setStorageAuthorityForTests({ readMaps: async keys => {
  sessionReads++;
  assert.deepEqual(keys, ["namedSessionRecords"]);
  return { namedSessionRecords: { named: { id: "named", name: "Existing fixture", auto: false, modifiedAt: 1 } } };
} });
const { confirmDelete, sessionComboboxButton } = await import("../js/ui/list-helpers.js");
const { dismissAnchoredPanel } = await import("../js/ui/tablist.js");
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id;
};
globalThis.clearTimeout = id => timers.delete(id);
function advance(milliseconds) {
  const target = now + milliseconds;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]); next[1].callback();
  }
  now = target;
}
const count = key => lookups.filter(value => value === key).length;
function buttonCopy(button, expected) {
  assert.equal(button.getAttribute("title"), expected);
  assert.equal(button.getAttribute("aria-label"), expected);
  assert.equal(button.querySelector(".action-label").textContent, expected ?? "");
}
beforeEach(() => { lookups.length = 0; sessionReads = 0; timers.clear(); now = 0; document.body.replaceChildren(); });
afterEach(() => { dismissAnchoredPanel(); timers.clear(); document.body.replaceChildren(); });
after(() => {
  setStorageAuthorityForTests(null); dom.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test("creating a Delete control translates only its visible default label", () => {
  const control = confirmDelete(() => assert.fail("creation must not confirm"));
  document.body.append(control);
  buttonCopy(control.querySelector("button"), getEnglishMessage("action_delete"));
  assert.equal(count("action_delete"), 1);
  assert.equal(count("list_delete_question"), 0, "unshown default confirmation question must be deferred");
  assert.equal(count("action_cancel"), 0, "unshown Cancel copy must be deferred");
  assert.equal(control.querySelectorAll("button").length, 1);
  assert.equal(timers.size, 0);
});

test("arming resolves the default question and one shared Cancel string, then focuses confirmation", async () => {
  let confirmed = 0;
  const control = confirmDelete(() => { confirmed++; }); document.body.append(control);
  lookups.length = 0;
  await control.querySelector("button").dispatch("click");
  const [yes, no] = control.querySelectorAll("button");
  buttonCopy(yes, getEnglishMessage("list_delete_question"));
  buttonCopy(no, getEnglishMessage("action_cancel"));
  assert.equal(count("list_delete_question"), 1, "question resolves when it first becomes visible");
  assert.equal(count("action_cancel"), 1, "Cancel title, accessible name and label share one lookup");
  assert.equal(document.activeElement, yes);
  assert.equal(control.classList.contains("armed"), true);
  assert.equal(confirmed, 0);
  assert.deepEqual([...timers.values()].map(timer => timer.at), [4000]);
});

test("explicit confirmation labels preserve null and empty values; only undefined requests defaults", async () => {
  for (const value of [undefined, "", null, "Remove exact fixture?"]) {
    const control = confirmDelete(() => {}, value, value); document.body.append(control);
    buttonCopy(control.querySelector("button"), value === undefined ? getEnglishMessage("action_delete") : value);
    await control.querySelector("button").dispatch("click");
    buttonCopy(control.querySelectorAll("button")[0], value === undefined ? getEnglishMessage("list_delete_question") : value);
    await control.querySelectorAll("button")[1].dispatch("click");
    control.remove();
  }
});

test("four-second reset, cancellation, rearming and confirmation never automatically confirm", async () => {
  let confirmed = 0;
  const control = confirmDelete(() => { confirmed++; }, "Delete fixture", "Delete this fixture?");
  document.body.append(control);
  const ask = control.querySelector("button");
  await ask.dispatch("click");
  advance(3999);
  assert.equal(control.classList.contains("armed"), true); assert.equal(confirmed, 0);
  await control.querySelectorAll("button")[1].dispatch("click");
  assert.equal(control.classList.contains("armed"), false); assert.equal(timers.size, 0);
  assert.equal(control.querySelector("button"), ask);
  advance(2); assert.equal(confirmed, 0);
  await ask.dispatch("click");
  assert.equal(document.activeElement, control.querySelector("button"));
  assert.equal(timers.size, 1);
  advance(3999); assert.equal(control.classList.contains("armed"), true);
  advance(1); assert.equal(control.classList.contains("armed"), false);
  assert.equal(control.querySelector("button"), ask); assert.equal(confirmed, 0);
  await ask.dispatch("click");
  await control.querySelectorAll("button")[0].dispatch("click");
  assert.equal(confirmed, 1, "only the second explicit activation invokes the callback");
  advance(4000); assert.equal(confirmed, 1); assert.equal(control.querySelector("button"), ask);
});

async function openPicker(button, detail = 1) {
  button.focus();
  // detail=0 is the click seam used by native keyboard activation. This fixture
  // does not emulate the browser's Enter/Space default action or OS events.
  await button.dispatch("click", { detail });
  for (let attempt = 0; attempt < 40; attempt++) {
    const input = document.querySelector(".session-picker-field input");
    if (input?.getAttribute("aria-expanded") === "true") return input;
    await Promise.resolve();
  }
  assert.fail("real Session combobox did not finish loading fixture options");
}

test("creating an unopened Session action does not translate default field copy or read options", () => {
  const button = sessionComboboxButton("Save fixture", { allowCreate: false, onPick: () => true });
  document.body.append(button);
  buttonCopy(button, "Save fixture");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(count("list_session_picker_aria"), 0, "unshown field accessible name must be deferred");
  assert.equal(count("list_session_picker_placeholder"), 0, "unshown field placeholder must be deferred");
  assert.equal(sessionReads, 0);
});

test("opening resolves default picker copy and supports field keyboard navigation and Escape focus return", async () => {
  let opened = 0, picked = 0;
  const button = sessionComboboxButton("Save fixture", { allowCreate: false,
    onOpen: () => { opened++; }, onPick: () => { picked++; return true; } });
  document.body.append(button); lookups.length = 0;
  const input = await openPicker(button, 0);
  assert.equal(count("list_session_picker_aria"), 1);
  assert.equal(count("list_session_picker_placeholder"), 1);
  assert.equal(input.getAttribute("aria-label"), getEnglishMessage("list_session_picker_aria"));
  assert.equal(input.getAttribute("placeholder"), getEnglishMessage("list_session_picker_placeholder"));
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, input); assert.equal(sessionReads, 1); assert.equal(opened, 1);
  const arrow = await input.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(document.querySelector(".tagopt").getAttribute("aria-selected"), "true");
  const escape = await input.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.propagationStopped, true);
  assert.equal(document.querySelector(".action-popover"), null);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, button); assert.equal(picked, 0);
});

test("picker explicit field copy preserves empty/null and only undefined uses defaults on each opening", async () => {
  for (const value of [undefined, "", null, "Exact picker copy"]) {
    const button = sessionComboboxButton("Save fixture", { allowCreate: false, ariaLabel: value, placeholder: value,
      onPick: () => assert.fail("opening must not pick") });
    document.body.append(button);
    for (let opening = 0; opening < 2; opening++) {
      const input = await openPicker(button);
      assert.equal(input.getAttribute("aria-label"), value === undefined ? getEnglishMessage("list_session_picker_aria") : value);
      assert.equal(input.getAttribute("placeholder"), value === undefined ? getEnglishMessage("list_session_picker_placeholder") : value);
      await input.dispatch("keydown", { key: "Escape" });
      assert.equal(document.activeElement, button);
    }
    button.remove();
  }
});

test("hidden defaults use the current localization on first opening and reopening while overrides stay exact", async () => {
  const originalLookup = chrome.i18n.getMessage;
  const deferredKeys = new Set(["list_delete_question", "action_cancel",
    "list_session_picker_aria", "list_session_picker_placeholder"]);
  let language = "creation";
  chrome.i18n.getMessage = (key, substitutions) => {
    const value = originalLookup(key, substitutions);
    return deferredKeys.has(key) ? `${language}: ${value}` : value;
  };
  const localized = key => `${language}: ${getEnglishMessage(key)}`;
  try {
    const controls = [
      { confirmation: confirmDelete(() => assert.fail("opening must not confirm")),
        picker: sessionComboboxButton("Save fixture", { allowCreate: false, onPick: () => assert.fail("opening must not pick") }) },
      { confirmation: confirmDelete(() => assert.fail("opening must not confirm"), "Delete exact", "Confirm exact"),
        picker: sessionComboboxButton("Save exact", { allowCreate: false, ariaLabel: "Accessible exact", placeholder: "Placeholder exact",
          onPick: () => assert.fail("opening must not pick") }), custom: true }
    ];
    for (const { confirmation, picker } of controls) document.body.append(confirmation, picker);
    assert.equal([...deferredKeys].reduce((total, key) => total + count(key), 0), 0);
    for (language of ["first opening", "reopening"]) {
      for (const { confirmation, picker, custom } of controls) {
        await confirmation.querySelector("button").dispatch("click");
        const [yes, no] = confirmation.querySelectorAll("button");
        buttonCopy(yes, custom ? "Confirm exact" : localized("list_delete_question"));
        buttonCopy(no, localized("action_cancel"));
        assert.equal(document.activeElement, yes);
        await no.dispatch("click");
        assert.equal(timers.size, 0);
        const input = await openPicker(picker);
        assert.equal(input.getAttribute("aria-label"), custom ? "Accessible exact" : localized("list_session_picker_aria"));
        assert.equal(input.getAttribute("placeholder"), custom ? "Placeholder exact" : localized("list_session_picker_placeholder"));
        await input.dispatch("keydown", { key: "Escape" });
        assert.equal(document.activeElement, picker);
      }
    }
  } finally {
    chrome.i18n.getMessage = originalLookup;
  }
});
