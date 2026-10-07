/** The Vault screen turns allowlisted failure codes and quarantine counts
 * into specific copy and actions. Real surface and receipt writer with a
 * synthetic connected handle; no folder, cloud client or browser profile.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const dom = installDomFixture();
const previousIndexedDB = globalThis.indexedDB;
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const { createVaultSurface, quarantineNotes } = await import("../js/ui/vault-surface.js");
const { recordVaultSyncFailure } = await import("../js/vault/sync.js");
const { VaultSyncError, VAULT_FAILURE_CODES } = await import("../js/vault/failure-codes.js");

const privateText = "Synthetic private path /private-fixture/vault/backups/2026-01-01-x.json";

async function fixture(meta) {
  const mem = meta ? { vaultMetaV2: structuredClone(meta) } : {};
  const handle = {
    name: "Synthetic Vault", kind: "directory",
    async queryPermission() { return "granted"; }
  };
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    tabs: { async getCurrent() { return { id: 7 }; } },
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter((key) => key in mem).map((key) => [key, structuredClone(mem[key])]));
      },
      async set(values) { Object.assign(mem, structuredClone(values)); }
    } }
  };
  installBrowserMapStorageAuthority();
  globalThis.indexedDB = {
    open() {
      const opening = {};
      queueMicrotask(() => {
        opening.result = { close() {}, transaction() {
          const tx = { objectStore() { return { get() {
            const req = {};
            queueMicrotask(() => { req.result = handle; req.onsuccess(); tx.oncomplete?.(); });
            return req;
          } }; } };
          return tx;
        } };
        opening.onsuccess();
      });
      return opening;
    }
  };
  const body = document.createElement("div"), banner = document.createElement("div");
  document.body.replaceChildren(banner, body);
  const notices = [];
  const surface = createVaultSurface({
    getBody: () => body, getBanner: () => banner, setHeading() {}, onStateChange() {},
    showNotice: (...args) => notices.push(args), goToVault() {}
  });
  await surface.render();
  return { body, banner, mem, notices, detail: () => body.querySelector("#vault-sync-details").textContent };
}

const failed = (extra) => ({
  ok: false, lastSyncAt: Date.now() - 60_000, error: "Vault sync failed",
  errorClass: "name:Error", ...extra
});

try {
  await test("update-required says the extension needs updating on this device", async () => {
    const f = await fixture(failed({
      errorClass: "code:vault-update-required",
      failureCode: VAULT_FAILURE_CODES.updateRequired, fileKind: "format"
    }));
    assert.match(f.detail(), /This Vault was written by a newer EveryTab/);
    assert.match(f.detail(), /Update EveryTab on this device, then sync again\./);
    assert.doesNotMatch(f.detail(), /Unknown error|Try Sync now/);
    assert.match(f.banner.textContent, /newer EveryTab\. Your data is safe on this device\./);
    assert.ok([...f.banner.querySelectorAll("button")].some((node) => node.textContent === "Try again"));
  });
  await test("placeholder files point at downloading the folder", async () => {
    const f = await fixture(failed({
      errorClass: "code:vault-placeholder-file",
      failureCode: VAULT_FAILURE_CODES.placeholderFile, fileKind: "transaction"
    }));
    assert.match(f.detail(), /only in the cloud, not on this device/);
    assert.match(f.detail(), /Download the Vault folder on this device .*then sync again\./);
    assert.match(f.banner.textContent, /only in the cloud/);
  });
  await test("a failure without an allowlisted code keeps the generic fallback", async () => {
    const f = await fixture(failed({ failureCode: "vault-made-up" }));
    assert.match(f.detail(), /Unknown error/);
    assert.match(f.detail(), /Try Sync now/);
  });
  await test("a completed sync lists skipped-file counts with an action each", async () => {
    const f = await fixture({
      ok: true, lastSyncAt: Date.now() - 5_000, pulled: 1, pushed: 2, storageVersion: 2,
      quarantined: [
        { code: "vault-damaged-backup", kind: "backup", count: 1 },
        { code: "vault-conflict-copy", kind: "directory", count: 2 },
        { code: "vault-foreign-manifest-unreadable", kind: "manifest", count: 1 },
        { code: "vault-placeholder-file", kind: "manifest", count: 3 },
        { code: "vault-made-up", kind: "backup", count: 9 },
        "junk"
      ]
    });
    const notes = [...f.body.querySelectorAll(".vault-sync-skipped")].map((node) => node.textContent);
    assert.deepEqual(notes, [
      "1 Restore point file could not be read and was skipped. Remove it from the backups folder, or restore it from your cloud file history.",
      "2 sync-service conflict copies were ignored. You can delete them from the Vault folder.",
      "1 other device could not be read and was skipped. Its changes arrive when its files are readable again.",
      "3 Vault files are only in the cloud and were skipped. Download the Vault folder on this device to include them."
    ]);
    assert.match(f.detail(), /pulled 1, pushed 2/);
    assert.doesNotMatch(f.body.textContent, /made-up|junk/);
  });
  await test("the Vault screen states when the Vault is updated", async () => {
    const f = await fixture(null);
    assert.match(f.body.textContent,
      /EveryTab updates the Vault while a Dashboard or New Tab page is open\./);
  });
  await test("Restore listing notes distinguish a still-arriving checkpoint from a damaged file", () => {
    assert.deepEqual(quarantineNotes([
      { code: "vault-damaged-backup", kind: "checkpoint", count: 2 },
      { code: "vault-damaged-backup", kind: "backup", count: 1 }
    ]), [
      "2 Restore points are not complete on this device yet and were skipped. They become available when their files arrive from the cloud.",
      "1 Restore point file could not be read and was skipped. Remove it from the backups folder, or restore it from your cloud file history."
    ]);
    assert.deepEqual(quarantineNotes(undefined), []);
  });
  await test("the failure receipt carries the code and file kind, never the error text", async () => {
    const f = await fixture(null);
    await recordVaultSyncFailure(new VaultSyncError(privateText, {
      code: VAULT_FAILURE_CODES.damagedBackup, kind: "backup"
    }), 1234);
    assert.deepEqual(f.mem.vaultMetaV2, {
      lastSyncAt: 1234, ok: false, error: "Vault sync failed",
      errorClass: "code:vault-damaged-backup",
      failureCode: "vault-damaged-backup", fileKind: "backup"
    });
    await recordVaultSyncFailure(new Error(privateText), 1235);
    assert.deepEqual(f.mem.vaultMetaV2, {
      lastSyncAt: 1235, ok: false, error: "Vault sync failed", errorClass: "name:Error"
    });
    await recordVaultSyncFailure(new Error(privateText), 1236, "timeout", 42);
    assert.deepEqual(f.mem.vaultMetaV2, {
      lastSyncAt: 1236, ok: false, error: "Vault sync stopped responding",
      errorClass: "name:Error", failureCode: "timeout", ownerTabId: 42
    });
    await recordVaultSyncFailure(Object.assign(new Error(privateText), { code: "vault-made-up", fileKind: "x" }), 1237);
    assert.deepEqual(f.mem.vaultMetaV2, {
      lastSyncAt: 1237, ok: false, error: "Vault sync failed", errorClass: "name:Error"
    });
    assert.doesNotMatch(JSON.stringify(f.mem), /private-fixture/);
  });
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
  dom.restore();
}
