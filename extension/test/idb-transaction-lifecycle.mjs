/** Retained-handle transaction ordering with a controlled synthetic IDB boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { idbGet, idbSet, idbDelete } from "../js/lib/idb.js";

const previousIndexedDB = globalThis.indexedDB;
const key = "vaultDirV2";
const oldHandle = { name: "Previously retained synthetic folder" };
const newHandle = { name: "Replacement synthetic folder" };

function fixture({ openError, transactionError, requestSetupError } = {}) {
  const persisted = new Map([[key, oldHandle]]);
  const draft = new Map(persisted);
  let request, transaction, operation, active = false, closeCount = 0;
  let requestResult;
  let ready;
  const requestReady = new Promise(resolve => { ready = resolve; });
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, "tabvault");
      assert.equal(version, 1);
      const opening = {};
      queueMicrotask(() => {
        if (openError) {
          opening.error = openError;
          opening.onerror();
          ready();
          return;
        }
        opening.result = {
          transaction(storeName, mode) {
            assert.equal(storeName, "kv");
            if (transactionError) { ready(); throw transactionError; }
            active = true;
            transaction = {
              error: null,
              objectStore(name) {
                assert.equal(name, "kv");
                const create = (kind, storedKey, value) => {
                  assert.equal(storedKey, key);
                  assert.equal(mode, kind === "get" ? "readonly" : "readwrite");
                  operation = kind;
                  ready();
                  if (requestSetupError) throw requestSetupError;
                  request = {};
                  if (kind === "get") requestResult = draft.get(storedKey);
                  else if (kind === "put") { draft.set(storedKey, value); requestResult = storedKey; }
                  else draft.delete(storedKey);
                  return request;
                };
                return {
                  get: name => create("get", name),
                  put: (value, name) => create("put", name, value),
                  delete: name => create("delete", name)
                };
              },
              abort() { queueMicrotask(() => abort()); }
            };
            return transaction;
          },
          close() {
            assert.equal(active, false, "connection stays open until its transaction settles");
            closeCount++;
          }
        };
        opening.onsuccess();
      });
      return opening;
    }
  };
  function abort(error = null) {
    transaction.error = error;
    active = false;
    transaction.onabort?.();
  }
  return {
    persisted, requestReady, closeCount: () => closeCount,
    requestSuccess() {
      request.result = requestResult;
      request.onsuccess?.();
    },
    requestError(error) {
      request.error = error;
      request.onerror?.();
      transaction.error = error;
      transaction.onerror?.({ target: request });
    },
    abort,
    commit() {
      if (operation !== "get") {
        persisted.clear();
        for (const [name, value] of draft) persisted.set(name, value);
      }
      active = false;
      transaction.oncomplete?.();
    }
  };
}

function settleWithin(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("IDB operation remained pending after transaction settled")), 250);
  })]).finally(() => clearTimeout(timer));
}

const operations = {
  get: () => idbGet(key),
  set: () => idbSet(key, newHandle),
  delete: () => idbDelete(key)
};

try {
  for (const [name, operation] of Object.entries(operations)) {
    await test(`${name}: request success waits for commit and closes its connection once`, async () => {
      const f = fixture();
      let settled = false;
      const pending = operation().finally(() => { settled = true; });
      await f.requestReady;
      f.requestSuccess();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(settled, false, "request success cannot report transaction success");
      assert.equal(f.closeCount(), 0);
      assert.equal(f.persisted.get(key), oldHandle, "request success has not changed durable state");
      f.commit();
      assert.equal(await settleWithin(pending), name === "get" ? oldHandle : undefined);
      assert.equal(f.closeCount(), 1);
      assert.equal(f.persisted.get(key), name === "set" ? newHandle : name === "delete" ? undefined : oldHandle);
    });

    await test(`${name}: abort after request success rejects and rolls back the retained value`, async () => {
      const f = fixture();
      const error = new DOMException("Synthetic transaction aborted", "AbortError");
      const pending = operation();
      await f.requestReady;
      f.requestSuccess();
      f.abort(error);
      await assert.rejects(settleWithin(pending), caught => caught === error);
      assert.equal(f.persisted.get(key), oldHandle);
      assert.equal(f.closeCount(), 1);
    });

    await test(`${name}: explicit abort without an error event still rejects`, async () => {
      const f = fixture();
      const pending = operation();
      await f.requestReady;
      f.abort();
      await assert.rejects(settleWithin(pending), { name: "AbortError" });
      assert.equal(f.persisted.get(key), oldHandle);
      assert.equal(f.closeCount(), 1);
    });

    await test(`${name}: request failure retains its cause and waits for abort before closing`, async () => {
      const f = fixture();
      const error = new DOMException("Synthetic request rejected", "QuotaExceededError");
      const pending = operation();
      await f.requestReady;
      f.requestError(error);
      assert.equal(f.closeCount(), 0);
      f.abort();
      await assert.rejects(settleWithin(pending), caught => caught === error);
      assert.equal(f.persisted.get(key), oldHandle);
      assert.equal(f.closeCount(), 1);
    });

    await test(`${name}: synchronous request failure aborts the transaction and closes`, async () => {
      const error = new DOMException("Synthetic request setup failed", "DataCloneError");
      const f = fixture({ requestSetupError: error });
      await assert.rejects(settleWithin(operation()), caught => caught === error);
      assert.equal(f.persisted.get(key), oldHandle);
      assert.equal(f.closeCount(), 1);
    });
  }

  await test("transaction creation failure still closes the successfully opened connection", async () => {
    const error = new DOMException("Synthetic transaction unavailable", "InvalidStateError");
    const f = fixture({ transactionError: error });
    await assert.rejects(settleWithin(idbGet(key)), caught => caught === error);
    assert.equal(f.closeCount(), 1);
  });

  await test("opening failure rejects without inventing a connection to close", async () => {
    const error = new DOMException("Synthetic database unavailable", "SecurityError");
    const f = fixture({ openError: error });
    await assert.rejects(settleWithin(idbSet(key, newHandle)), caught => caught === error);
    assert.equal(f.closeCount(), 0);
    assert.equal(f.persisted.get(key), oldHandle);
  });
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
}
