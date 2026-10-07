import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inventoryFiles, readInventory, validateInventory, selectRuns } from "../../tools/testing/inventory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const inventory = readInventory(root);
const coverage = validateInventory(inventory, inventoryFiles(root));
const workflow = readFileSync(new URL("../../.github/workflows/extension-cross-platform.yml", import.meta.url), "utf8");
for (const lane of ["portable", "performance", "browser"]) {
  assert.ok(workflow.includes(`node tools/test.mjs --lane ${lane} --ci`),
    `CI must consume the shared ${lane} execution plan`);
}
assert.ok(workflow.includes('"test-inventory.json"') && workflow.includes('"tools/**"'),
  "inventory and harness changes trigger CI");
assert.doesNotMatch(workflow, /node extension\/test\//,
  "CI must not maintain a second hard-coded suite list");
assert.ok(workflow.includes("github.event_name == 'workflow_dispatch' && inputs.package_checks"));
assert.ok(workflow.includes("--lane package --allow-packaging --ci"));
for (const platform of ["linux", "darwin", "win32"]) {
  const ordinary = selectRuns(inventory, { platform, ci: true });
  assert.ok(ordinary.length > 0);
  assert.ok(ordinary.every((run) => run.lane !== "package"));
  const browser = selectRuns(inventory, { platform, ci: true, lanes: ["browser"] });
  assert.ok(browser.some((run) => run.path.endsWith("theme-on-open-extension.mjs")),
    "the unpacked installed-extension check must remain on every CI platform");
  assert.ok(browser.every((run) => !run.path.includes("cws-package")));
}
console.log(`PASS: ${coverage.files} classified files and one shared execution inventory for local/CI runs`);
