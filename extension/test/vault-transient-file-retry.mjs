import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  retryTransientVaultFileOperation, VAULT_TRANSIENT_RETRY_DELAY_MS
} from "../js/vault/transient-file-retry.js";

const syncSource = await readFile(new URL("../js/vault/sync.js", import.meta.url), "utf8");
assert.match(syncSource,
  /retryTransientVaultFileOperation\([\s\S]*syncVault/,
  "the installed Vault sync must retry the filesystem operation before publishing failure");

let attempts = 0;
const waits = [];
const recovered = await retryTransientVaultFileOperation(async () => {
  attempts += 1;
  if (attempts === 1) {
    throw new DOMException(
      "The requested file could not be read after a reference was acquired",
      "NotReadableError"
    );
  }
  return "synced";
}, {
  wait: async (delayMs) => { waits.push(delayMs); }
});
assert.equal(recovered, "synced",
  "a one-off Chrome file-read race must recover without reaching the error UI");
assert.equal(attempts, 2,
  "a transient Vault file-read failure receives one retry");
assert.deepEqual(waits, [VAULT_TRANSIENT_RETRY_DELAY_MS],
  "the retry must yield briefly instead of immediately contending for the same file again");

const secondFailure = new DOMException("still unreadable", "NotReadableError");
attempts = 0;
await assert.rejects(
  retryTransientVaultFileOperation(async () => {
    attempts += 1;
    if (attempts === 1) throw new DOMException("temporarily unreadable", "NotReadableError");
    throw secondFailure;
  }, { wait: async () => {} }),
  (error) => error === secondFailure,
  "a repeated file-read failure must reach the existing honest recovery UI"
);
assert.equal(attempts, 2,
  "a repeated NotReadableError must not start an unbounded retry loop");

for (const error of [
  new DOMException("permission denied", "NotAllowedError"),
  new DOMException("operation aborted", "AbortError"),
  new Error("Vault data is invalid")
]) {
  attempts = 0;
  await assert.rejects(
    retryTransientVaultFileOperation(async () => {
      attempts += 1;
      throw error;
    }, { wait: async () => {} }),
    (thrown) => thrown === error,
    `${error.name} must retain its original failure`
  );
  assert.equal(attempts, 1,
    `${error.name} must not be hidden behind a filesystem retry`);
}

console.log("PASS: Vault retries one transient Chrome file-read failure without hiding persistent errors");
