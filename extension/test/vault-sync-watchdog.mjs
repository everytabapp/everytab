import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  restartStalledVaultSync, runVaultSyncWithDeadline, VaultSyncTimeoutError
} from "../js/ui/vault-sync-watchdog.js";
import { createMockLockManager } from "./e2-mocks.mjs";

const surfaceSource = await readFile(new URL("../js/ui/vault-surface.js", import.meta.url), "utf8");
const copySource = await readFile(new URL("../js/ui/vault-copy.js", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const vaultSyncSource = await readFile(new URL("../js/vault/sync.js", import.meta.url), "utf8");
assert.match(surfaceSource,
  /runVaultSyncWithDeadline\(\{[\s\S]*sync: \(heartbeat\) => syncNow\(\{ onProgress: heartbeat \}\)/,
  "the Vault surface must feed real filesystem progress into the tested watchdog");
assert.match(surfaceSource,
  /syncButton\.disabled = syncing \|\| following \|\| restarting[\s\S]*syncButton\.textContent = vaultSyncAction/,
  "the manual action must visibly disable while sync or restart work is already running");
assert.match(surfaceSource,
  /error instanceof VaultSyncTimeoutError[\s\S]{0,100}vaultSyncStopped\(progress\?\.target\)[\s\S]*failureCode: "timeout"/,
  "a timeout must become a visible retryable Vault outcome");
assert.match(surfaceSource,
  /syncDetail && syncDetail\.textContent !== nextText/,
  "mature scans must not rewrite identical progress text for every Vault file");
assert.match(surfaceSource,
  /function updateProgressDetail\(\)[\s\S]{0,180}vaultProgressText\([\s\S]*setInterval\(updateProgressDetail, 1_000\)/,
  "a long uncounted Vault phase must advance a visible elapsed-time heartbeat every second");
assert.match(surfaceSource, /clearInterval\(progressTimer\)/,
  "a completed or abandoned Vault attempt must release its presentation heartbeat");
assert.match(copySource,
  /progress\?\.stage === "reading"[\s\S]{0,320}progress\.completed[\s\S]{0,160}progress\.total/,
  "a mature Vault scan must show bounded numerical progress instead of an apparently frozen phase");
assert.match(surfaceSource, /stalled[\s\S]*vaultStatic\.restartSync\(\)|vaultSyncAction\(\{[\s\S]{0,80}stalled/,
  "a timed-out sync must expose a truthful restart action");
assert.match(surfaceSource, /restartStalledVaultSync/,
  "the retry action must destroy the context that still owns the Vault lock");
assert.match(surfaceSource,
  /recordVaultSyncFailure\([\s\S]{0,180}failure\.failureCode \?\? null/,
  "the Vault surface must delegate timeout receipts to the Vault storage authority");
assert.doesNotMatch(surfaceSource, /chrome\.storage\.local\.set/,
  "the Vault surface must not become a second storage authority");
assert.match(dashboardSource,
  /const hero = el\([\s\S]{0,500}reconnectBanner,[\s\S]{0,120}focusStrip/,
  "the Vault banner must live inside the measured sticky hero so it cannot be cropped beneath it");
assert.doesNotMatch(dashboardSource,
  /const dailyStage = el\("div", \{ class: "daily-stage" \},\s*reconnectBanner/,
  "the Vault banner must not be inserted into scrolling content above the active section");
assert.match(surfaceSource, /id: "vault-sync-details"/,
  "the Vault details action must have an exact focus and scroll destination");
assert.match(dashboardSource,
  /getElementById\("vault-sync-details"\)[\s\S]{0,180}scrollIntoView[\s\S]{0,120}focus/,
  "Details must reveal and focus the exact Vault status instead of being a no-op");
assert.match(surfaceSource,
  /if \(syncing\) return \{ ok: true, busy: true, local: true, progress \}/,
  "a current attempt must hide the stale failure receipt it is replacing");
assert.match(surfaceSource,
  /if \(outcome\?\.report\?\.skipped\) \{\s*following = true;\s*followStartedAt = attemptStartedAt;/,
  "a page that loses sync ownership must follow the owner instead of reporting an error");
assert.doesNotMatch(surfaceSource,
  /transientFailure = \{[\s\S]{0,160}Another EveryTab tab is already syncing/,
  "a legitimate owner in another page must not be stored as a failure");
assert.match(surfaceSource, /ownerTabId: attemptOwnerTabId/,
  "a timeout receipt must identify the tab that owns the lock");
assert.match(surfaceSource, /restartStalledVaultSync\(\{ tabId: ownerTabId \}\)/,
  "Restart must target the exact owning tab recorded by the timeout");
assert.match(surfaceSource,
  /Date\.now\(\) - followStartedAt >= VAULT_OWNER_PROBE_MS[\s\S]{0,160}void run\(\)/,
  "a follower must retest the Web Lock if an owning page disappears without a receipt");
assert.doesNotMatch(surfaceSource, /v2-setup|Storage V2 prepared|previous Vault|legacy Vault/i,
  "the installed Vault surface must expose only the current product path");
assert.doesNotMatch(vaultSyncSource, /syncWithHandle|currentStorageGeneration|v1/i,
  "the installed sync boundary must not retain the retired engine or a generation branch");
assert.match(vaultSyncSource,
  /syncVault\(handle, \{[\s\S]{0,160}library: replication\.library,[\s\S]{0,80}recovery: replication\.recovery/,
  "production Vault sync must publish both the Library and bounded Recovery store");

const NEVER = new Promise(() => {});
const result = await Promise.race([
  runVaultSyncWithDeadline({
    sync: () => NEVER,
    timeoutMs: 20
  }).then(
    () => ({ state: "resolved" }),
    (error) => ({ state: "rejected", error })
  ),
  new Promise((resolve) => setTimeout(() => resolve({ state: "stuck" }), 80))
]);

assert.equal(result.state, "rejected",
  "a stalled Vault operation must release the UI instead of leaving it on syncing forever");
assert.match(String(result.error), /timed out/i,
  "a stalled Vault operation must explain that it timed out");
assert.ok(result.error instanceof VaultSyncTimeoutError,
  "the UI must be able to distinguish a timeout from an ordinary sync failure");

let progressTicks = 0;
const progressing = await runVaultSyncWithDeadline({
  sync: async (heartbeat) => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12));
      progressTicks += 1;
      heartbeat();
    }
    return "slow but healthy";
  },
  timeoutMs: 20
});
assert.equal(progressing, "slow but healthy",
  "a healthy mature Vault scan must not time out while it is still making progress");
assert.equal(progressTicks, 5,
  "the watchdog must allow the complete progressing scan to finish");

const locks = createMockLockManager();
locks.setDefaultContext("stalled-page");
const lockOwningSync = () => locks.request(
  "everytab-vault-sync",
  { ifAvailable: true },
  async (lock) => lock === null ? { skipped: true } : new Promise(() => {})
);

await assert.rejects(
  runVaultSyncWithDeadline({ sync: lockOwningSync, timeoutMs: 20 }),
  VaultSyncTimeoutError,
  "the first lock-owning attempt must time out"
);
assert.equal(locks.heldBy("everytab-vault-sync"), "stalled-page",
  "a presentation timeout alone leaves the abandoned page owning the real sync lock");
restartStalledVaultSync({ reload: () => locks.die("stalled-page") });
assert.equal(locks.heldBy("everytab-vault-sync"), null,
  "destroying the stalled page context must release its Web Lock");
locks.setDefaultContext("fresh-page");
const retried = await runVaultSyncWithDeadline({
  sync: () => locks.request(
    "everytab-vault-sync",
    { ifAvailable: true },
    async (lock) => lock === null
      ? { skipped: true }
      : { skipped: false, synced: true }
  ),
  timeoutMs: 20
});
assert.deepEqual(retried, { skipped: false, synced: true },
  "Restart sync must release the abandoned context so the next load can really sync");

const remoteOwnerLocks = createMockLockManager();
remoteOwnerLocks.setDefaultContext("real-owner");
await assert.rejects(
  runVaultSyncWithDeadline({
    sync: () => remoteOwnerLocks.request(
      "everytab-vault-sync",
      { ifAvailable: true },
      async (lock) => lock === null ? { skipped: true } : new Promise(() => {})
    ),
    timeoutMs: 20
  }),
  VaultSyncTimeoutError
);
let wrongPageReloaded = false;
await restartStalledVaultSync({
  tabId: 47,
  reloadTab: async (tabId) => {
    assert.equal(tabId, 47, "the recorded owning tab must be the restart target");
    remoteOwnerLocks.die("real-owner");
  },
  reload: () => { wrongPageReloaded = true; }
});
assert.equal(wrongPageReloaded, false,
  "Restart sync must not reload whichever Dashboard happened to show the shared error");
assert.equal(remoteOwnerLocks.heldBy("everytab-vault-sync"), null,
  "restarting from another Dashboard must release the actual owner's lock");

let clearedTimer = null;
const successful = await runVaultSyncWithDeadline({
  sync: async () => "synced",
  timeoutMs: 20_000,
  setTimer: () => 42,
  clearTimer: (timer) => { clearedTimer = timer; }
});
assert.equal(successful, "synced", "a normal sync result must pass through unchanged");
assert.equal(clearedTimer, 42, "a completed sync must remove its watchdog timer");

// The durable failure receipt is shared by sync and UI timeout paths. It must
// never persist the error payload, even when property/coercion access is hostile.
const { recordVaultSyncFailure } = await import("../js/vault/sync.js");
const previousChrome = globalThis.chrome;
const receipts = [];
try {
  globalThis.chrome = { storage: { local: { set: async (value) => receipts.push(value) } } };
  const secret = "Synthetic private title https://synthetic.invalid/secret";
  const privateFailure = Object.assign(new Error(secret), { code: secret, name: "NetworkError" });
  await recordVaultSyncFailure(privateFailure, 123, "timeout", 47);
  assert.deepEqual(receipts.pop(), { vaultMetaV2: {
    lastSyncAt: 123, ok: false, error: "Vault sync stopped responding",
    errorClass: "name:NetworkError", failureCode: "timeout", ownerTabId: 47
  } }, "timeout identity and restart ownership survive without private error text");
  const hostile = new Proxy({}, { get() { throw new Error(secret); } });
  await recordVaultSyncFailure(hostile, 124, secret, secret);
  assert.deepEqual(receipts.pop(), { vaultMetaV2: {
    lastSyncAt: 124, ok: false, error: "Vault sync failed", errorClass: "name:UnknownError"
  } }, "hostile errors and arbitrary failure codes cannot enter the persisted receipt");
  await recordVaultSyncFailure(secret, secret);
  const generic = receipts.pop().vaultMetaV2;
  assert.equal(generic.errorClass, "name:UnknownError");
  assert.ok(Number.isFinite(generic.lastSyncAt));
  assert.ok(!JSON.stringify(generic).includes(secret));
} finally {
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
}

console.log("PASS: Vault progress extends the inactivity watchdog and a genuine stall can restart its owner");
