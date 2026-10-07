// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal IndexedDB key-value helper.
 * Needed because FileSystemDirectoryHandle can be structured-cloned into
 * IndexedDB but NOT into chrome.storage.
 */
const DB_NAME = "tabvault";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * One request owns one connection until its transaction commits or aborts.
 * Request success alone is not commitment: a later abort must still reject.
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} createRequest
 * @returns {Promise<unknown>}
 */
async function keyValueRequest(mode, createRequest) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
      try {
        const req = createRequest(tx.objectStore(STORE));
        req.onsuccess = () => { result = req.result; };
        // Keep the request's cause, but leave its default abort behavior intact.
        // Settlement waits for onabort so the connection outlives the transaction.
        req.onerror = () => { failure = req.error; };
      } catch (error) {
        failure = error;
        try { tx.abort(); }
        catch { reject(error); }
      }
    });
  } finally {
    db.close();
  }
}

/** @param {string} key */
export async function idbGet(key) {
  return keyValueRequest("readonly", store => store.get(key));
}

/** @param {string} key @param {unknown} value */
export async function idbSet(key, value) {
  await keyValueRequest("readwrite", store => store.put(value, key));
}

/** Forget one stored value without changing any external resource it references. */
export async function idbDelete(key) {
  await keyValueRequest("readwrite", store => store.delete(key));
}
