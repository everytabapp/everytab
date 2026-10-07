import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const syncSource = await readFile(new URL("../js/vault/sync.js", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
assert.match(syncSource, /syncVault/,
  "Vault sync must delegate batching to the current incremental protocol");
assert.match(dashboardSource,
  /if \(!vaultPrimaryReady \|\| document\.visibilityState === "hidden"\) \{[\s\S]*vaultSchedulePending = true/,
  "a hidden Dashboard must defer rather than start a competing Vault scan");
assert.match(dashboardSource,
  /document\.visibilityState !== "hidden" && vaultPrimaryReady && vaultSchedulePending[\s\S]*surface\.schedule\(\)/,
  "a deferred Vault scan must resume when its Dashboard becomes visible");

console.log("PASS: hidden Dashboards defer Vault ownership to the current protocol");
