import assert from "node:assert/strict";
import fs from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";

const fixture = installDomFixture();
const previousChrome = globalThis.chrome;
const messages = JSON.parse(fs.readFileSync(new URL("../_locales/en/messages.json", import.meta.url)));
globalThis.chrome = {
  i18n: { getMessage: (key) => messages[key]?.message ?? "" }
};

const flushUpdates = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

try {
  const { createNewTabChoices } = await import("../js/ui/new-tab-choices.js");
  let settings = { newTabMode: "dashboard", newTabFocus: "omnibox" };
  let sync = null;
  let failNextUpdate = false;
  const patches = [];
  const root = createNewTabChoices({
    readSettings: () => settings,
    update: async (patch) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error("fixture persistence failure");
      }
      patches.push(patch);
      settings = { ...settings, ...patch };
    },
    registerSync: (registered) => { sync = registered; }
  });
  fixture.document.body.append(root);

  const dashboard = root.querySelector('input[value="dashboard"]');
  const minimal = root.querySelector('input[value="minimal"]');
  const blank = root.querySelector('input[value="blank"]');
  const omnibox = root.querySelector('input[value="omnibox"]');
  const search = root.querySelector('input[value="search"]');
  const focusSection = root.querySelector(".new-tab-focus-section");
  const focus = focusSection.querySelector("fieldset.new-tab-focus-choice");
  const status = root.querySelector(".new-tab-choice-status");

  assert.equal(root.querySelectorAll(".new-tab-choice-option").length, 3);
  assert.equal(dashboard.checked, true);
  assert.equal(omnibox.checked, true);
  assert.equal(focusSection.hidden, false);
  assert.ok(focus, "Start typing in remains a semantic fieldset");
  assert.match(root.textContent, /disables the whole EveryTab extension/);
  assert.equal(typeof sync, "function");

  blank.checked = true;
  await blank.dispatch("change");
  await flushUpdates();
  assert.deepEqual(patches.at(-1), { newTabMode: "blank" });
  assert.equal(focusSection.hidden, true);
  assert.equal(settings.newTabFocus, "omnibox", "Blank must preserve the stored focus choice");

  settings = { newTabMode: "minimal", newTabFocus: "search" };
  sync();
  assert.equal(minimal.checked, true);
  assert.equal(search.checked, true);
  assert.equal(focusSection.hidden, false);

  failNextUpdate = true;
  dashboard.checked = true;
  await dashboard.dispatch("change");
  await flushUpdates();
  assert.equal(minimal.checked, true, "A rejected update restores the last displayed choice");
  assert.equal(status.textContent, messages.new_tab_choice_update_failed.message);

  let queuedSettings = { newTabMode: "dashboard", newTabFocus: "omnibox" };
  const waiting = [];
  let queuedSync;
  const queued = createNewTabChoices({
    readSettings: () => queuedSettings,
    registerSync: (sync) => { queuedSync = sync; },
    update: (patch) => new Promise((resolve) => waiting.push((success = true) => {
      if (success) queuedSettings = { ...queuedSettings, ...patch };
      queuedSync();
      resolve(success);
    }))
  });
  const pendingMinimal = queued.querySelector('input[value="minimal"]');
  const pendingSearch = queued.querySelector('input[value="search"]');
  pendingMinimal.checked = true;
  const first = pendingMinimal.dispatch("change");
  assert.equal(waiting.length, 1, "The change event enrolls persistence synchronously before Finish can run");
  pendingSearch.checked = true;
  const second = pendingSearch.dispatch("change");
  waiting[0]();
  await first;
  assert.equal(pendingSearch.checked, true, "Intermediate host sync does not repaint a later optimistic choice");
  waiting[1](false);
  await second;
  assert.equal(pendingMinimal.checked, true);
  assert.equal(queued.querySelector('input[value="omnibox"]').checked, true,
    "A resolved failure reconciles from committed preferences after the batch drains");
  assert.equal(queued.querySelector(".new-tab-choice-status").textContent, messages.new_tab_choice_update_failed.message);

  console.log("New Tab choices contract passed");
} finally {
  fixture.restore();
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
}
