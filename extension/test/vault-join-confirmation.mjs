/** Joining a different populated Vault needs the user's confirmation.
 * Decision logic is checked directly; the Vault screen flow runs the real
 * surface, picker boundary and retained-handle store with synthetic folders.
 * No native picker, permission dialog or user folder is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";
import { seal } from "../js/vault/protocol-io.js";

const dom = installDomFixture();
const previousIndexedDB = globalThis.indexedDB;
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const { createVaultSurface } = await import("../js/ui/vault-surface.js");
const { pickVaultFolder, getVaultHandle, vaultJoinDecision } = await import("../js/vault/vault.js");

async function formatFile(vaultId) {
  return JSON.stringify(await seal({
    app: "everytab", kind: "vault-v2-format", formatVersion: 1, storageVersion: 2,
    status: "ready", vaultId, initializer: { deviceId: "fixture", sourceId: "fixture" },
    bootstrap: { checkpointId: "fixture", throughSequence: 0, contentHash: "sha256:" + "0".repeat(64) }
  }));
}

function readableView(vaultId, records) {
  return JSON.stringify({
    app: "everytab", kind: "vault-v2-readable-library", formatVersion: 1, vaultId,
    summary: { records, families: { inbox: records } }, families: {}
  });
}

function directory(name, files = {}) {
  const file = (text) => ({ kind: "file", async getFile() { return { async text() { return text; } }; } });
  return {
    name, kind: "directory", files: { ...files },
    async queryPermission() { return "granted"; },
    async *entries() {
      for (const [filename, text] of Object.entries(this.files)) yield [filename, file(text)];
    },
    async getDirectoryHandle() { throw new Error("Selection must not create directories"); },
    async getFileHandle(filename, options = {}) {
      if (options.create) throw new Error("Selection must not create files");
      if (!(filename in this.files)) {
        throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
      return file(this.files[filename]);
    }
  };
}

async function fixture({ previousVaultId = "previous-vault", meta = null } = {}) {
  const previous = directory("Previous Vault", previousVaultId
    ? { "format.json": await formatFile(previousVaultId) } : {});
  let retained = previous;
  let pickerResult = null;
  let writes = 0;
  let syncAttempts = 0;
  const notices = [];
  const mem = meta ? { vaultMetaV2: structuredClone(meta) } : {};
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    tabs: { async getCurrent() { syncAttempts++; return { id: 29 }; } },
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
    open(name) {
      assert.equal(name, "tabvault");
      const opening = {};
      queueMicrotask(() => {
        opening.result = { close() {}, transaction(store, mode) {
          const tx = { objectStore() { return {
            get() {
              const req = {};
              queueMicrotask(() => { req.result = retained; req.onsuccess(); tx.oncomplete?.(); });
              return req;
            },
            put(value) {
              assert.equal(mode, "readwrite");
              writes++;
              const req = {};
              queueMicrotask(() => { retained = value; req.result = "vaultDirV2"; req.onsuccess?.(); tx.oncomplete?.(); });
              return req;
            }
          }; } };
          return tx;
        } };
        opening.onsuccess();
      });
      return opening;
    }
  };
  window.showDirectoryPicker = async () => pickerResult;
  const body = document.createElement("div"), banner = document.createElement("div");
  document.body.replaceChildren(banner, body);
  const surface = createVaultSurface({
    getBody: () => body, getBanner: () => banner, setHeading() {}, onStateChange() {},
    showNotice: (...args) => notices.push(args), goToVault: () => surface.render()
  });
  await surface.render();
  const buttons = () => [...body.querySelectorAll("button")];
  const button = (label) => buttons().find((node) => node.textContent === label);
  return {
    previous, body, notices, mem,
    choose(value) { pickerResult = value; },
    changeFolder: () => button("Change folder…"),
    prompt: () => body.querySelector(".vault-join"),
    joinButton: () => button("Join and merge"),
    cancelButton: () => button("Cancel"),
    retained: () => retained, writes: () => writes, syncAttempts: () => syncAttempts,
    settle: () => new Promise((resolve) => setTimeout(resolve, 20))
  };
}

try {
  await test("decision: same Vault, empty folder and unpopulated device never prompt", () => {
    const ready = { state: "ready", format: { vaultId: "v1" } };
    assert.equal(vaultJoinDecision({ state: "empty" }, { lastVaultId: "v0", localRecords: 50 }), "none");
    assert.equal(vaultJoinDecision(ready, { lastVaultId: "v1", localRecords: 50 }), "none",
      "reconnecting the same Vault is routine");
    assert.equal(vaultJoinDecision(ready, { lastVaultId: null, localRecords: 0 }), "none",
      "a first Vault with nothing local to merge");
    assert.equal(vaultJoinDecision(ready, { lastVaultId: null, localRecords: null }), "none",
      "unknown local count without a previous Vault does not block");
    assert.equal(vaultJoinDecision({ state: "rejected" }, { lastVaultId: "v0" }), "none");
  });
  await test("decision: a different populated Vault, or a first Vault over local records, prompts", () => {
    const ready = { state: "ready", format: { vaultId: "v2" } };
    assert.equal(vaultJoinDecision(ready, { lastVaultId: "v1", localRecords: 0 }), "prompt",
      "a different Vault prompts even when this device holds nothing");
    assert.equal(vaultJoinDecision(ready, { lastVaultId: null, localRecords: 3 }), "prompt");
  });
  await test("picker without a confirmation callback keeps its previous contract", async () => {
    const f = await fixture();
    const other = directory("Other Vault", { "format.json": await formatFile("other-vault") });
    f.choose(other);
    assert.deepEqual(await pickVaultFolder(), { state: "connected", name: "Other Vault" });
    assert.equal(await getVaultHandle(), other);
  });
  await test("a different populated Vault shows the confirmation with both record counts before any write", async () => {
    const f = await fixture({ meta: { ok: true, lastSyncAt: 1, vaultId: "previous-vault" } });
    const other = directory("Other Vault", {
      "format.json": await formatFile("other-vault"),
      "library.json": readableView("other-vault", 12)
    });
    f.choose(other);
    const clicking = f.changeFolder().dispatch("click");
    await f.settle();
    const prompt = f.prompt();
    assert.ok(prompt, "the join question is rendered in the Vault screen");
    assert.equal(prompt.getAttribute("role"), "group");
    assert.equal(document.activeElement, prompt, "focus lands on the question, not on an action");
    assert.match(prompt.textContent, /Join this Vault\?/);
    assert.match(prompt.textContent, /“Other Vault” already contains a Vault with 12 saved records/);
    assert.match(prompt.textContent, /This device has an unknown number of saved records/);
    assert.match(prompt.textContent, /No single device can undo/);
    assert.ok(f.joinButton() && f.cancelButton());
    assert.equal(f.changeFolder().disabled, true, "no second picker while the question is open");
    assert.equal(f.writes(), 0, "the previous handle is still retained");
    assert.equal(await getVaultHandle(), f.previous);

    await f.cancelButton().dispatch("click");
    await clicking;
    await f.settle();
    assert.equal(f.prompt(), null);
    assert.equal(f.writes(), 0);
    assert.equal(await getVaultHandle(), f.previous, "Cancel keeps the previous folder");
    assert.equal(f.syncAttempts(), 0);
    assert.equal(f.notices.length, 0);
    assert.equal(document.activeElement, f.changeFolder(), "focus returns to the opener");
  });
  await test("Escape cancels with keyboard parity", async () => {
    const f = await fixture();
    f.choose(directory("Other Vault", { "format.json": await formatFile("other-vault") }));
    const clicking = f.changeFolder().dispatch("click");
    await f.settle();
    assert.ok(f.prompt());
    await f.prompt().dispatch("keydown", { key: "Escape" });
    await clicking;
    await f.settle();
    assert.equal(f.prompt(), null);
    assert.equal(await getVaultHandle(), f.previous);
    assert.equal(f.writes(), 0);
  });
  await test("Join and merge retains the new folder and starts sync", async () => {
    const f = await fixture();
    const other = directory("Other Vault", { "format.json": await formatFile("other-vault") });
    f.choose(other);
    const clicking = f.changeFolder().dispatch("click");
    await f.settle();
    await f.joinButton().dispatch("click");
    await clicking;
    await f.settle();
    assert.equal(f.prompt(), null);
    assert.equal(await getVaultHandle(), other);
    assert.equal(f.writes(), 1);
    assert.equal(f.syncAttempts(), 1, "the production sync entry runs after confirmation");
  });
  await test("the same Vault chosen again, or an empty folder, connects without a question", async () => {
    const f = await fixture();
    f.choose(directory("Same Vault again", { "format.json": await formatFile("previous-vault") }));
    await f.changeFolder().dispatch("click");
    await f.settle();
    assert.equal(f.prompt(), null);
    assert.equal(f.writes(), 1);
    const g = await fixture();
    g.choose(directory("Empty folder"));
    await g.changeFolder().dispatch("click");
    await g.settle();
    assert.equal(g.prompt(), null);
    assert.equal(g.writes(), 1);
  });
  await test("the last synced Vault identity comes from the receipt before the retained folder", async () => {
    const f = await fixture({ previousVaultId: null, meta: { ok: true, lastSyncAt: 1, vaultId: "other-vault" } });
    f.choose(directory("Other Vault", { "format.json": await formatFile("other-vault") }));
    await f.changeFolder().dispatch("click");
    await f.settle();
    assert.equal(f.prompt(), null, "the receipt identifies this as the same Vault");
    assert.equal(f.writes(), 1);
  });
  await test("an evicted folder is rejected with download guidance, not the empty-folder advice", async () => {
    const f = await fixture();
    const evicted = directory("Evicted Vault", { ".format.json.icloud": "" });
    f.choose(evicted);
    assert.deepEqual(await pickVaultFolder(), { state: "rejected", reason: "placeholder" });
    await f.changeFolder().dispatch("click");
    await f.settle();
    assert.match(f.notices[0][0], /only in the cloud/);
    assert.equal(f.writes(), 0);
  });
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
  dom.restore();
}
