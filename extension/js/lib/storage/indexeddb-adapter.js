// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Native IndexedDB adapter used internally by the storage modules. */

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function ensureSchema(database, transaction, schema) {
  for (const descriptor of schema.stores) {
    const store = database.objectStoreNames.contains(descriptor.name)
      ? transaction.objectStore(descriptor.name)
      : database.createObjectStore(descriptor.name, { keyPath: descriptor.keyPath });
    for (const index of descriptor.indexes ?? []) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, index.keyPath, { unique: Boolean(index.unique) });
      }
    }
  }
}

/**
 * The adapter is the only code that knows IndexedDB request mechanics. Its
 * transaction callback may await adapter requests, but no unrelated async work.
 */
export function createIndexedDbAdapter(schema, {
  factory = globalThis.indexedDB,
  databaseName = schema.name
} = {}) {
  if (!factory?.open) throw new Error("IndexedDB is required for Storage");
  let opened = null;

  function database() {
    if (opened) return opened;
    let exposed;
    let failed = false;
    const opening = new Promise((resolve, reject) => {
      const request = factory.open(databaseName, schema.version);
      request.onupgradeneeded = () => ensureSchema(request.result, request.transaction, schema);
      request.onsuccess = () => {
        const connection = request.result;
        if (failed) {
          connection.close();
          return;
        }
        connection.onversionchange = () => {
          connection.close();
          if (opened === exposed) opened = null;
        };
        resolve(connection);
      };
      request.onerror = () => {
        failed = true;
        reject(request.error ?? new Error("IndexedDB could not open"));
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error("IndexedDB upgrade is blocked by another page"));
      };
    });
    exposed = opening.catch((error) => {
      if (opened === exposed) opened = null;
      throw error;
    });
    opened = exposed;
    return opened;
  }

  async function transaction(storeNames, mode, work) {
    const db = await database();
    const native = db.transaction([...new Set(storeNames)], mode);
    const completion = transactionCompletion(native);
    const access = (storeName) => native.objectStore(storeName);
    const context = {
      get: (storeName, key) => requestResult(access(storeName).get(key)),
      getAll: (storeName) => requestResult(access(storeName).getAll()),
      getAllByKeyRange: (storeName, { lower, upper, lowerOpen = false, upperOpen = false }, count) => {
        // `(key, key]` and `[key, key)` are valid empty ranges in the adapter
        // contract, but native IDBKeyRange.bound throws instead of representing
        // them. No-change syncs use this shape, so answer them without issuing
        // an IndexedDB request.
        if ((lowerOpen || upperOpen) && factory.cmp(lower, upper) === 0) {
          return Promise.resolve([]);
        }
        const range = IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
        const request = Number.isSafeInteger(count)
          ? access(storeName).getAll(range, count)
          : access(storeName).getAll(range);
        return requestResult(request);
      },
      getAllByIndex: (storeName, indexName, query) =>
        requestResult(access(storeName).index(indexName).getAll(query)),
      put: (storeName, value) => requestResult(access(storeName).put(value)),
      delete: (storeName, key) => requestResult(access(storeName).delete(key))
    };

    let result;
    try {
      result = await work(context);
    } catch (error) {
      try { native.abort(); } catch { /* transaction already completed */ }
      try { await completion; } catch { /* preserve the work error */ }
      throw error;
    }
    await completion;
    return result;
  }

  return {
    transaction,
    async close() {
      const pending = opened;
      if (!pending) return;
      const db = await pending;
      db.close();
      if (opened === pending) opened = null;
    }
  };
}
