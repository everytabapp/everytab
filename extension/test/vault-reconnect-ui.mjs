/** Mounted Reconnect controls with real Vault/IDB owners and synthetic boundaries.
 * Promise rejection here models the uncaught async DOM listener in Chrome. This
 * does not exercise a native directory picker or operating-system permission UI.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const dom = installDomFixture();
const { createVaultSurface } = await import("../js/ui/vault-surface.js");
const previousIndexedDB = globalThis.indexedDB;
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

async function fixture(control) {
  const mem = {};
  const notices = [];
  let failNextRead = null;
  let persistentReadFailure = null;
  let requestOutcome = "denied";
  let permission = "prompt";
  let permissionRequests = 0;
  let syncAttempts = 0;
  let detailsOpened = 0;
  let storedHandle;
  const handle = {
    name: "Synthetic Vault", kind: "directory",
    async queryPermission(options) {
      assert.deepEqual(options, { mode: "readwrite" });
      return permission;
    },
    async requestPermission(options) {
      permissionRequests++;
      assert.deepEqual(options, { mode: "readwrite" });
      if (requestOutcome instanceof Error) throw requestOutcome;
      permission = requestOutcome;
      return permission;
    }
  };
  storedHandle = handle;
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, "tabvault");
      assert.equal(version, 1);
      const opening = {};
      queueMicrotask(() => {
        opening.result = { close() {}, transaction(store, mode) {
          assert.equal(store, "kv");
          assert.equal(mode, "readonly", "reconnect never replaces the retained handle");
          const tx = { objectStore() { return { get(key) {
            assert.equal(key, "vaultDirV2");
            const request = {};
            const failure = failNextRead ?? persistentReadFailure;
            failNextRead = null;
            queueMicrotask(() => {
              if (failure) {
                request.error = failure;
                request.onerror();
                tx.error = failure;
                tx.onabort?.();
              } else {
                request.result = storedHandle;
                request.onsuccess();
                tx.oncomplete?.();
              }
            });
            return request;
          } }; } };
          return tx;
        } };
        opening.onsuccess();
      });
      return opening;
    }
  };
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    tabs: { async getCurrent() { syncAttempts++; return { id: 17 }; } },
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => key in mem).map(key => [key, structuredClone(mem[key])]));
      },
      async set(values) { Object.assign(mem, structuredClone(values)); }
    } }
  };
  // The permission-granted control reaches production syncNow. This authority
  // deliberately has no Vault replication projection, giving a bounded failure
  // receipt instead of pretending that a synthetic handle proves native sync.
  installBrowserMapStorageAuthority();
  const body = document.createElement("div");
  const banner = document.createElement("div");
  document.body.replaceChildren(banner, body);
  const surface = createVaultSurface({
    getBody: () => body, getBanner: () => banner, setHeading() {}, onStateChange() {},
    showNotice: (...args) => notices.push(args), goToVault: async () => {
      detailsOpened++;
      // Dashboard's Details route renders Vault after navigating to its area.
      await surface.render();
    }
  });
  await surface.render();
  const button = () => [...(control === "hero" ? banner : body).querySelectorAll("button")]
    .find(node => node.textContent === (control === "hero" ? "Reconnect vault" : "Reconnect"));
  assert.ok(button(), "the production surface mounts the requested Reconnect control");
  return {
    body, banner, mem, notices, button, refresh: surface.render, pillState: surface.pillState,
    rejectRead(error) { failNextRead = error; },
    rejectReads(error) { persistentReadFailure = error; },
    outcome(value) { requestOutcome = value; },
    permissionRequests: () => permissionRequests, syncAttempts: () => syncAttempts,
    detailsOpened: () => detailsOpened,
    retained: () => storedHandle === handle
  };
}

try {
  for (const control of ["hero", "inline"]) {
    for (const boundary of ["IndexedDB", "persistent IndexedDB", "permission"]) {
      for (const errorName of ["SecurityError", "AbortError"]) {
        await test(`${control} Reconnect contains ${boundary} ${errorName} and permits retry`, async () => {
          const f = await fixture(control);
          const error = new DOMException("Private fixture path /synthetic/private-vault", errorName);
          if (boundary === "IndexedDB") f.rejectRead(error);
          else if (boundary === "persistent IndexedDB") f.rejectReads(error);
          else f.outcome(error);
          const invokingButton = f.button();
          await assert.doesNotReject(invokingButton.dispatch("click"), "the async click must settle without escaping");
          assert.equal(f.notices.length, 1, "failed reconnect must give visible feedback from either surface");
          assert.equal(f.notices[0][0], "The Vault is not available");
          assert.equal(f.notices[0][2], "Details");
          assert.equal(f.syncAttempts(), 0, "rejected connection must not start sync");
          assert.deepEqual(f.mem, {}, "reconnect failure is not a completed or failed sync receipt");
          assert.equal(f.retained(), true);
          assert.doesNotMatch(f.body.textContent + f.banner.textContent + f.notices[0][0], /private-vault/);
          assert.equal(f.button(), invokingButton, "failure retains the existing safe status and retry control");
          await f.notices[0][1]();
          assert.equal(f.detailsOpened(), 1);
          assert.doesNotMatch(f.body.textContent + f.banner.textContent + JSON.stringify(await f.pillState()),
            /private-vault/, "Details, badge and pill must not expose a persistent storage error payload");
          if (boundary === "persistent IndexedDB") {
            assert.match(f.body.textContent, /Unknown error/,
              "Details honestly reports the unavailable status through localized failure copy");
          }
          f.rejectReads(null);
          await f.refresh();
          f.outcome("denied");
          await f.button().dispatch("click");
          assert.equal(f.notices.length, 1, "denying a retry is not an exception");
          assert.equal(f.syncAttempts(), 0);
          assert.ok(f.button());
          f.outcome("granted");
          await f.button().dispatch("click");
          assert.equal(f.syncAttempts(), 1, "the same failed owner can retry permission and start sync");
          assert.equal(f.mem.vaultMetaV2?.ok, false,
            "the granted retry reaches syncNow's bounded unavailable-authority receipt");
          assert.equal(f.retained(), true);
        });
      }
    }
    await test(`${control} non-granted permission stays retryable without failure`, async () => {
      const f = await fixture(control);
      await f.button().dispatch("click");
      f.outcome("prompt");
      await assert.doesNotReject(f.button().dispatch("click"));
      assert.equal(f.permissionRequests(), 2);
      assert.equal(f.notices.length, 0);
      assert.equal(f.syncAttempts(), 0);
      assert.deepEqual(f.mem, {});
      assert.ok(f.button());
      assert.equal(f.retained(), true);
    });
    await test(`${control} granted permission still reaches the production sync entry`, async () => {
      const f = await fixture(control);
      f.outcome("granted");
      await f.button().dispatch("click");
      assert.equal(f.permissionRequests(), 1);
      assert.equal(f.syncAttempts(), 1);
      assert.equal(f.mem.vaultMetaV2?.ok, false,
        "production syncNow reports the intentionally unavailable replication authority");
      assert.equal(f.mem.vaultMetaV2?.errorClass, "name:Error");
      assert.ok([...f.body.querySelectorAll("button")].some(button => button.textContent === "Sync now"));
      assert.equal(f.retained(), true);
    });
  }
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
  dom.restore();
}
