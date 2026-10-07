/** Real folder-selection and UI owners with synthetic picker/IDB boundaries.
 * No native permission dialog, user-owned directory or browser profile is used.
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
const { pickVaultFolder, getVaultHandle } = await import("../js/vault/vault.js");
const privateMessage = "Synthetic private path /private-fixture/vault";
const guidance = "Choose an empty folder or an existing EveryTab Vault.";

function directory(name, files = {}) {
  return {
    name, kind: "directory", files: { ...files }, readFailure: null,
    async queryPermission() { return "granted"; },
    async *entries() {
      if (this.readFailure) throw this.readFailure;
      for (const [filename, text] of Object.entries(this.files)) {
        yield [filename, { kind: "file", async getFile() { return { async text() { return text; } }; } }];
      }
    },
    async getDirectoryHandle() { throw new Error("Selection must not create directories"); },
    async getFileHandle() { throw new Error("Selection must not create files"); }
  };
}

async function fixture() {
  const previous = directory("Previous Vault");
  const selected = directory("Selected Vault");
  let retained = previous;
  let pickerResult = selected;
  let writeFailure = null;
  let syncAttempts = 0;
  let writes = 0;
  const notices = [];
  const meta = { ok: true, lastSyncAt: Date.now(), pulled: 0, pushed: 0 };
  const mem = { vaultMetaV2: structuredClone(meta) };
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    tabs: { async getCurrent() { syncAttempts++; return { id: 29 }; } },
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => key in mem).map(key => [key, structuredClone(mem[key])]));
      },
      async set(values) { Object.assign(mem, structuredClone(values)); }
    } }
  };
  installBrowserMapStorageAuthority();
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, "tabvault"); assert.equal(version, 1);
      const opening = {};
      queueMicrotask(() => {
        opening.result = { close() {}, transaction(store, mode) {
          assert.equal(store, "kv");
          const tx = { objectStore() { return {
            get(key) {
              assert.equal(key, "vaultDirV2"); assert.equal(mode, "readonly");
              const req = {};
              queueMicrotask(() => { req.result = retained; req.onsuccess(); tx.oncomplete?.(); });
              return req;
            },
            put(value, key) {
              assert.equal(key, "vaultDirV2"); assert.equal(mode, "readwrite"); writes++;
              const req = {};
              queueMicrotask(() => {
                if (writeFailure === "error") {
                  req.error = new DOMException(privateMessage, "QuotaExceededError");
                  req.onerror?.(); tx.error = req.error; tx.onerror?.(); tx.onabort?.();
                } else if (writeFailure === "abort") {
                  req.result = key; req.onsuccess?.(); tx.error = null; tx.onabort?.();
                } else {
                  retained = value; req.result = key; req.onsuccess?.(); tx.oncomplete?.();
                }
              });
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
  window.showDirectoryPicker = async options => {
    assert.deepEqual(options, { mode: "readwrite" });
    if (pickerResult instanceof Error) throw pickerResult;
    return pickerResult;
  };
  const body = document.createElement("div"), banner = document.createElement("div");
  document.body.replaceChildren(banner, body);
  const surface = createVaultSurface({
    getBody: () => body, getBanner: () => banner, setHeading() {}, onStateChange() {},
    showNotice: (...args) => notices.push(args), goToVault: () => surface.render()
  });
  await surface.render();
  const button = () => [...body.querySelectorAll("button")].find(node => node.textContent === "Change folder…");
  assert.ok(button());
  return {
    previous, selected, body, banner, meta, mem, notices, button,
    choose(value) { pickerResult = value; }, failWrite(value) { writeFailure = value; },
    retained: () => retained, writes: () => writes, syncAttempts: () => syncAttempts,
    pillState: surface.pillState
  };
}

async function unchanged(f) {
  assert.equal(await getVaultHandle(), f.previous, "previous retained handle remains the exact object");
  assert.equal(await f.previous.queryPermission(), "granted");
  assert.deepEqual(f.mem.vaultMetaV2, f.meta, "selection never fabricates a sync outcome");
  assert.equal(f.syncAttempts(), 0);
  assert.doesNotMatch(f.body.textContent + f.banner.textContent + JSON.stringify(f.notices), /private-fixture/);
}

try {
  await test("picker cancellation has an explicit outcome without replacing a retained handle", async () => {
    const f = await fixture();
    f.choose(new DOMException(privateMessage, "AbortError"));
    assert.deepEqual(await pickVaultFolder(), { state: "cancelled" });
    assert.equal(f.writes(), 0);
    await unchanged(f);
  });
  await test("Dashboard cancellation preserves the connected UI and successful sync receipt", async () => {
    const f = await fixture();
    const button = f.button(), text = f.body.textContent, pill = await f.pillState();
    f.choose(new DOMException(privateMessage, "AbortError"));
    await button.dispatch("click");
    assert.equal(f.button(), button); assert.equal(f.body.textContent, text);
    assert.deepEqual(await f.pillState(), pill);
    assert.equal(f.notices.length, 0); assert.equal(f.writes(), 0);
    await unchanged(f);
  });
  for (const type of ["nonempty", "invalid-format"]) {
    await test(`${type} folder rejection is safe, actionable and leaves both folders unchanged`, async () => {
      const f = await fixture();
      const files = type === "nonempty" ? { "user-file.txt": "Synthetic contents" } : { "format.json": privateMessage };
      const rejected = directory("Unrelated folder", files);
      f.choose(rejected);
      assert.deepEqual(await pickVaultFolder(),
        { state: "rejected", reason: type === "nonempty" ? "unrecognized" : "invalid" });
      await f.button().dispatch("click");
      assert.equal(f.notices[0][0], guidance);
      assert.deepEqual(rejected.files, files); assert.deepEqual(f.previous.files, {});
      assert.equal(f.writes(), 0);
      await unchanged(f);
    });
  }
  for (const boundary of ["picker", "inspection", "write-error", "write-abort"]) {
    await test(`${boundary} failure preserves the old Vault and permits a later selection`, async () => {
      const f = await fixture();
      if (boundary === "picker") f.choose(new DOMException(privateMessage, "SecurityError"));
      else if (boundary === "inspection") f.selected.readFailure = new DOMException(privateMessage, "AbortError");
      else f.failWrite(boundary === "write-error" ? "error" : "abort");
      await f.button().dispatch("click");
      assert.equal(f.notices[0]?.[0], "The Vault is not available",
        "post-picker AbortError is a failed selection, not user cancellation");
      await unchanged(f);
      f.choose(f.selected); f.selected.readFailure = null; f.failWrite(null);
      assert.deepEqual(await pickVaultFolder(), { state: "connected", name: f.selected.name });
      assert.equal(await getVaultHandle(), f.selected);
    });
  }
  for (const type of ["empty", "ready"]) {
    await test(`${type} folder commits its handle before reporting connected`, async () => {
      const f = await fixture();
      if (type === "ready") {
        f.selected.files["format.json"] = JSON.stringify(await seal({
          app: "everytab", kind: "vault-v2-format", formatVersion: 1, storageVersion: 2,
          status: "ready", vaultId: "synthetic-vault", initializer: { deviceId: "fixture", sourceId: "fixture" },
          bootstrap: { checkpointId: "fixture", throughSequence: 0, contentHash: "sha256:" + "0".repeat(64) }
        }));
      }
      const files = { ...f.selected.files };
      assert.deepEqual(await pickVaultFolder(), { state: "connected", name: f.selected.name });
      assert.equal(await getVaultHandle(), f.selected); assert.equal(f.writes(), 1);
      assert.deepEqual(f.selected.files, files); assert.deepEqual(f.mem.vaultMetaV2, f.meta);
    });
  }
  await test("successful Dashboard selection still starts the production sync entry", async () => {
    const f = await fixture();
    await f.button().dispatch("click");
    assert.equal(await getVaultHandle(), f.selected);
    assert.equal(f.syncAttempts(), 1);
    // This synthetic authority intentionally has no replication projection.
    // Its failure receipt proves syncNow ran; native disk sync is a separate test.
    assert.equal(f.mem.vaultMetaV2?.ok, false); assert.equal(f.mem.vaultMetaV2?.errorClass, "name:Error");
  });
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
  dom.restore();
}
