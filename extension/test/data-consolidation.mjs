import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { sendMessage: async () => ({ ok: false }) },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  }
};

try {
  const {
    createDataHub, dataRoute, nextDataRouteState, ownDataRender
  } = await import("../js/ui/data-hub.js");
  const { createDataSurface } = await import("../js/ui/data-surface.js");
  const { coalesce } = await import("../js/ui/dom.js");

  assert.deepEqual(dataRoute("data"), { page: "data", area: null });
  assert.deepEqual(dataRoute("data:transfer"), { page: "data", area: "transfer" });
  assert.deepEqual(dataRoute("data:vault"), { page: "data", area: "vault" });
  assert.deepEqual(dataRoute("vault"), { page: "data", area: "vault" },
    "the existing Vault hash lands in the consolidated Data destination");
  assert.equal(dataRoute("snapshots"), null);

  const firstVaultRoute = nextDataRouteState({ hash: "#data", generation: 4 }, "#vault");
  const duplicateVaultRoute = nextDataRouteState(firstVaultRoute, "#vault");
  const laterRoute = nextDataRouteState(duplicateVaultRoute, "#settings");
  assert.equal(firstVaultRoute.generation, 5);
  assert.equal(duplicateVaultRoute, firstVaultRoute,
    "the synchronous Vault route and its trailing hashchange share one generation");
  assert.equal(laterRoute.generation, 6,
    "a genuinely later destination invalidates pending Vault details focus");

  const diagnostics = [];
  const failedRender = Promise.reject(new Error("private storage detail"));
  const firstOwnedFailure = ownDataRender(failedRender, "Vault", (message) => diagnostics.push(message));
  const secondOwnedFailure = ownDataRender(failedRender, "Vault", (message) => diagnostics.push(message));
  assert.equal(firstOwnedFailure, secondOwnedFailure,
    "one coalesced render Promise has one diagnostic owner");
  assert.equal(await firstOwnedFailure, false);
  assert.deepEqual(diagnostics, ["EveryTab: Vault render failed [name:Error]"],
    "render rejection is named once without exposing its payload");

  const hostile = {
    get name() { throw new Error("private title in getter"); },
    get message() { throw new Error("message must not be read"); },
    toString() { throw new Error("private URL must not be coerced"); }
  };
  const hostileLogs = [];
  assert.equal(await ownDataRender(Promise.reject(hostile), hostile,
    (...args) => hostileLogs.push(args)), false,
  "hostile error properties and labels cannot interrupt the render owner");
  assert.deepEqual(hostileLogs, [["EveryTab: operation failed [name:UnknownError]"]],
    "unknown labels and throwing error getters emit exactly one safe string");
  assert.equal(await ownDataRender(Promise.reject(new TypeError("private URL")), "Data",
    () => { throw new Error("broken diagnostic sink"); }), false,
  "a broken diagnostic sink does not reject an already owned render failure");

  const queuedDiagnostics = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let attempted = 0;
  const ownedQueuedRender = coalesce(() => {
    attempted += 1;
    return ownDataRender(Promise.reject(new Error(`private failure ${attempted}`)),
      "Data", (message) => queuedDiagnostics.push(message));
  });
  const firstQueued = ownedQueuedRender();
  const replayedQueued = ownedQueuedRender();
  assert.equal(firstQueued, replayedQueued, "a route replay queues behind the active Data render");
  assert.equal(await firstQueued, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(attempted, 2, "the coalesced route replay performs its trailing render");
  assert.deepEqual(queuedDiagnostics,
    ["EveryTab: Data render failed [name:Error]", "EveryTab: Data render failed [name:Error]"],
    "each actual queued render owns its named failure");
  assert.deepEqual(unhandled, [], "a failing queued Data render never rejects unhandled");

  const jumps = [];
  const hub = createDataHub({ onJump: (area) => jumps.push(area) });
  document.body.append(hub.element);
  const surface = createDataSurface({
    getBody: () => hub.coreHost,
    setHeading: () => {},
    onChanged: async () => {}
  });
  await surface.render();

  const recoverArea = document.getElementById("data-area-recover");
  const transferArea = document.getElementById("data-area-transfer");
  const vaultArea = document.getElementById("data-area-vault");
  assert.equal(document.getElementById(`data-area-${dataRoute("data:vault").area}`), vaultArea,
    "the direct Vault route resolves the exact continuously mounted jump target");
  assert.equal(recoverArea.hidden, false);
  assert.equal(transferArea.hidden, false);
  assert.equal(vaultArea.hidden, false);
  assert.match(recoverArea.textContent, /Restore an EveryTab backup/);
  assert.match(recoverArea.textContent, /Check recently closed/);
  assert.match(recoverArea.textContent, /Check automatic snapshots/);
  assert.match(transferArea.textContent, /Download backup/);
  assert.match(transferArea.textContent, /Import shared tabs or another tab tool/);
  assert.equal(hub.nav.getAttribute("role"), "navigation");
  assert.equal(hub.buttons.recover.getAttribute("role"), null,
    "Data chips use ordinary button semantics rather than a hidden tabset");
  assert.equal(hub.element.style.getPropertyValue("--data-nav-h"), "20px",
    "Data publishes its measured jump-nav height on its own workspace");
  assert.equal(document.documentElement.style.getPropertyValue("--settings-toolbar-h"), "",
    "Data measurement never changes Settings' independent sticky clearance");

  await hub.buttons.transfer.dispatch("click");
  assert.deepEqual(jumps, ["transfer"]);

  const importInput = transferArea.querySelector("textarea");
  const importPreview = transferArea.querySelector(".data-import-preview");
  importInput.value = "## Reading\n- [Example](https://example.com/article)";
  await importInput.dispatch("input");
  assert.match(importPreview.textContent, /Links: 1/);

  await surface.render();
  const progress = document.createElement("div");
  progress.textContent = "Syncing Library";
  hub.vaultBody.replaceChildren(progress);
  await surface.render();
  assert.equal(transferArea.querySelector("textarea"), importInput,
    "switching Data areas retains the exact import input node");
  assert.equal(transferArea.querySelector(".data-import-preview"), importPreview,
    "switching Data areas retains the parsed import preview node");
  assert.equal(importInput.value, "## Reading\n- [Example](https://example.com/article)");
  assert.match(importPreview.textContent, /Links: 1/);
  assert.equal(hub.vaultBody.childNodes[0], progress,
    "Vault owns one retained subtree independent of import state");

  const snapshotButton = [...recoverArea.querySelectorAll("button")]
    .find((button) => /Check automatic snapshots/.test(button.textContent));
  assert.equal(snapshotButton?.parentElement?.classList.contains("setrow"), true,
    "automatic snapshot check stays aligned with its own title and description");
  const snapshotRow = snapshotButton?.parentElement;
  assert.equal(snapshotRow?.querySelector(".tw") != null, true);
  const snapshotRowIndex = snapshotRow.parentElement.children.indexOf(snapshotRow);
  assert.equal(snapshotRow.parentElement.children[snapshotRowIndex + 1]
    ?.classList.contains("data-recovery-actions"), true,
    "the later snapshot selector/review row remains separate from the description row");
} finally {
  fixture.restore();
}

const dashboard = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const sidepanel = readFileSync(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
assert.equal((dashboard.match(/createVaultSurface\(/g) ?? []).length, 1,
  "Dashboard creates exactly one Vault sync controller");
assert.match(dashboard, /getBody: \(\) => dataHub\.vaultBody/);
assert.doesNotMatch(dashboard, /navBtn\("vault"/,
  "Vault is no longer a separate sidebar destination");
assert.match(dashboard, /const requestedData = dataRoute\(raw\)/);
assert.match(dashboard, /void renderDataArea\(requestedData\?\.area \?\? null, routeGeneration\)/,
  "the Dashboard routes explicit Data jumps through one post-render anchor path");
assert.match(dashboard, /nextDataRouteState\(dataRouteState, location\.hash\)/,
  "the intentional synchronous-plus-hashchange route pair shares one generation");
assert.match(dashboard, /routeGeneration === dataRouteState\.generation/,
  "an async Data render cannot apply a stale jump after later navigation");
assert.match(dashboard, /const renderData = lazySection\("data", \(\) => ownDataRender\(/,
  "every queued Data render owns its failure at the renderer boundary");
assert.match(dashboard, /const renderVault = coalesce\(async \(\) =>[\s\S]*return ownDataRender\(/,
  "every queued Vault render owns its failure at the renderer boundary");
assert.match(dashboard, /if \(!ready\) return;[\s\S]*settleAnchor/,
  "a failed Data or Vault render cannot apply its pending anchor");
assert.match(dashboard, /if \(currentPage !== "data"\) return false;/,
  "Vault renders whenever the continuous Data page is visible");
assert.doesNotMatch(dashboard, /dataHub\.(?:select|selected|refresh)\(/,
  "obsolete hidden-area selection machinery is gone");
assert.doesNotMatch(dashboard, /target\.closest\?\.\("\.data-nav"\)/,
  "ordinary Data jump buttons no longer reserve Left\/Right as tablist keys");
for (const page of ["activity", "archive", "snapshots", "data", "stats"]) {
  assert.match(sidepanel, new RegExp(`shellNavLabel\\("${page}"\\)`),
    `compact More exposes ${page}`);
}

console.log("PASS: consolidated Data routing, retained state, controls, and single Vault ownership");
