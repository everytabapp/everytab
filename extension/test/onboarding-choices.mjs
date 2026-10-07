import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const dom = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock(), runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
const { createOnboardingAutomation, createOnboardingAppearance } = await import("../js/ui/onboarding-choices.js");
const { HELP_TOPICS, ONBOARDING_FEATURES, ONBOARDING_PAGES } = await import("../js/lib/onboarding-copy.js");
const { icon } = await import("../js/ui/icons.js");
const { SCHEME_LABELS, SCHEMES } = await import("../js/lib/schemes.js");
const { SUSPEND_STOPS, AUTO_DUMP_MINUTES } = await import("../js/ui/slider.js");
let settings = { autoArchiveEnabled: false, autoDumpAfterMinutes: 123,
  suspendEnabled: true, suspendAfterMinutes: 47, autoSaveMaxTabs: 1200, suspendMaxTabs: 18,
  snapshotKeep: 200, uiScheme: "ink", uiMode: "scheme", uiInterfaceStyle: "soft" };
let syncers = [];
const patches = [];
let failUpdate = false;
const dependencies = {
  readSettings: () => settings,
  registerSync: (sync) => syncers.push(sync),
  update: async (patch) => {
    patches.push(patch);
    if (failUpdate) {
      for (const sync of syncers) sync();
      return false;
    }
    settings = { ...settings, ...patch };
    for (const sync of syncers) sync();
    return true;
  }
};
try {
  const automation = createOnboardingAutomation(dependencies);
  document.body.append(automation);
  assert.equal(patches.length, 0, "Opening a step never changes existing settings");
  assert.equal(automation.querySelectorAll('input[type="checkbox"]').length, 2);
  assert.equal(automation.querySelectorAll("select").length, 2, "Only save and suspension timers belong in this tour");
  assert.ok([60, 240, 720].every((minutes) => SUSPEND_STOPS.includes(minutes)));
  assert.ok([10080, 20160, 43200].every((minutes) => AUTO_DUMP_MINUTES.includes(minutes)),
    "Every introductory timing has an exact Settings slider position");
  const save = automation.querySelector('[data-automation="save"]');
  const suspend = automation.querySelector('[data-automation="suspend"]');
  assert.equal(save.checked, false);
  assert.equal(suspend.checked, true, "Keep the installed user's current automation");
  assert.equal(automation.querySelector('[data-timing="save"]').value, "123");
  assert.equal(automation.querySelector('[data-timing="suspend"]').value, "47");
  assert.equal(automation.querySelector('[data-timing="save"]').disabled, true);
  assert.match(automation.textContent, /Automatically close unused tabs after saving them to Inbox/);
  const limits = automation.querySelector(".ob-tab-limits");
  assert.equal(Boolean(limits.open), false, "Count limits start collapsed");
  const autoLimit = automation.querySelector('[data-tab-limit="autoSaveMaxTabs"]');
  const suspendLimit = automation.querySelector('[data-tab-limit="suspendMaxTabs"]');
  assert.equal(autoLimit.value, "1200", "An imported cap above the editing range is displayed exactly");
  assert.equal(autoLimit.max, "1200");
  autoLimit.value = "1199";
  await autoLimit.dispatch("change");
  assert.deepEqual(patches.at(-1), { autoSaveMaxTabs: 1199 },
    "Editing an imported limit respects the maximum displayed by the input");
  assert.equal(suspendLimit.value, "18");
  assert.match(limits.textContent, /Too many tabs\? Set a limit/);
  assert.match(limits.textContent, /Enter 0 for Off/);
  assert.equal(automation.querySelectorAll(".ob-protection details").length, 0);
  assert.equal(automation.querySelectorAll(".ob-protection a").length, 0);
  assert.match(automation.querySelector(".ob-protection").textContent, /shield action button/);
  assert.match(automation.querySelector(".ob-protection").textContent, /does not read or save unsaved text/);
  save.checked = true;
  await save.dispatch("change");
  assert.deepEqual(patches.at(-1), { autoArchiveEnabled: true, autoDumpAfterMinutes: 123, autoArchiveDays: 1 });
  suspend.checked = false;
  await suspend.dispatch("change");
  assert.deepEqual(patches.at(-1), { suspendEnabled: false });
  assert.equal(settings.suspendAfterMinutes, 47, "Off retains a custom timing for next time");
  assert.equal(settings.snapshotKeep, 200);
  autoLimit.value = "84.8";
  await autoLimit.dispatch("change");
  assert.deepEqual(patches.at(-1), { autoSaveMaxTabs: 84 });
  suspendLimit.value = "-3";
  await suspendLimit.dispatch("change");
  assert.deepEqual(patches.at(-1), { suspendMaxTabs: 0 });
  autoLimit.value = "9999";
  await autoLimit.dispatch("change");
  assert.deepEqual(patches.at(-1), { autoSaveMaxTabs: 999 });
  failUpdate = true;
  autoLimit.focus();
  autoLimit.value = "30";
  await autoLimit.dispatch("change");
  assert.equal(autoLimit.value, "999", "A rejected focused edit rolls back to the stored cap");
  failUpdate = false;
  assert.equal(settings.autoArchiveEnabled, true, "Editing a cap never changes the timer flag");
  assert.equal(settings.suspendEnabled, false, "Editing a cap never changes the timer flag");

  assert.equal(ONBOARDING_FEATURES.length, HELP_TOPICS.length);
  assert.ok(ONBOARDING_FEATURES.some((feature) => feature.id === "import"));
  assert.ok(!ONBOARDING_FEATURES.some((feature) => feature.id === "history"));
  assert.ok(HELP_TOPICS.some((topic) => topic.id === "history"), "Permanent Help keeps History and permissions");
  const sessionIcon = ONBOARDING_PAGES[1].definitions[1][0];
  assert.equal(sessionIcon, "sessions");
  assert.equal(icon(sessionIcon).innerHTML, icon("sessions").innerHTML);

  syncers = [];
  const appearancePatchCount = patches.length;
  const appearance = createOnboardingAppearance(dependencies);
  document.body.append(appearance);
  assert.equal(appearance.querySelectorAll(".ob-palette").length, 36);
  const schemeChoices = [...appearance.querySelectorAll(".ob-palette")];
  assert.deepEqual(schemeChoices.slice(0, 8).map((button) => button.dataset.schemeChoice),
    ["aladdin", "laser", "sunset", "frozenllama", "matcha", "devtty", "dracula", "hineybeige"]);
  assert.deepEqual(new Set(schemeChoices.map((button) => button.dataset.schemeChoice)), new Set(SCHEMES),
    "Featured order retains the complete 36-scheme catalogue");
  assert.equal(SCHEME_LABELS.hineybeige, "Hineybeige");
  assert.equal(patches.length, appearancePatchCount, "Opening Appearance never changes the stored Ink default");
  assert.equal(appearance.querySelector('[data-scheme-choice="ink"]').getAttribute("aria-pressed"), "true");
  assert.equal(appearance.querySelector(".ob-more-palettes").open, true,
    "A selected non-featured scheme is revealed without changing it");
  const schemeDefault = appearance.querySelector('[data-preference="uiMode"][data-value="scheme"]');
  assert.equal(schemeDefault.getAttribute("aria-pressed"), "true");
  assert.match(schemeDefault.textContent, /Scheme default/i);
  const crisp = appearance.querySelector('[data-style-sample="crisp"]');
  assert.equal(crisp.getAttribute("aria-pressed"), "false");
  const css = readFileSync(new URL("../css/onboarding.css", import.meta.url), "utf8");
  assert.match(css, /\.ob-segment\[data-style-sample="crisp"\]\s*\{[^}]*border-radius: 5px/,
    "Crisp samples have crisp geometry before selection");
  await crisp.dispatch("click");
  assert.deepEqual(patches.at(-1), { uiInterfaceStyle: "crisp" });
  assert.equal(crisp.getAttribute("aria-pressed"), "true");
  await appearance.querySelector('[data-scheme-choice="miaminights"]').dispatch("click");
  assert.equal(settings.uiScheme, "miaminights");
  assert.equal(appearance.querySelector(".ob-more-palettes").open, true);
  settings = { ...settings, uiScheme: "custom:mine" };
  syncers.forEach((sync) => sync());
  assert.equal(appearance.querySelector(".ob-note").hidden, false, "A current custom scheme is retained and explained");
  assert.equal(appearance.querySelectorAll('.ob-palette[aria-pressed="true"]').length, 0);

  let raceSettings = { ...settings, autoSaveMaxTabs: 42 };
  const raceSyncers = [];
  let settleFailedEdit;
  const racing = createOnboardingAutomation({
    readSettings: () => raceSettings,
    registerSync: (sync) => raceSyncers.push(sync),
    update: () => new Promise((resolve) => {
      settleFailedEdit = () => { raceSyncers.forEach((sync) => sync()); resolve(false); };
    })
  });
  document.body.append(racing);
  const racingLimit = racing.querySelector('[data-tab-limit="autoSaveMaxTabs"]');
  racingLimit.focus();
  racingLimit.value = "51";
  const rejected = racingLimit.dispatch("change");
  racingLimit.value = "52";
  await racingLimit.dispatch("input");
  settleFailedEdit();
  await rejected;
  assert.equal(racingLimit.value, "52", "An older failed save never clobbers newer typing");
  console.log("PASS: first-run automation, custom timings, real Session glyph, 36 schemes, Scheme default and independent style samples");
} finally { dom.restore(); }
