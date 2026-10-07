/** Cross-context storage revision publication remains ordered and retryable. */
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";

const writes = [];
let failNext = true;
let holdNext = null;
let durableRevision = null;
let storedRevision = null;
const timers = [];
const originalSetTimeout = globalThis.setTimeout;
const locks = createMockLockManager();
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks }
});

globalThis.setTimeout = (callback, delay) => {
  timers.push({ callback, delay });
  return timers.length;
};
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({
        ...(storedRevision ? { storageV2Revision: structuredClone(storedRevision) } : {})
      }),
      set: async (value) => {
        assert.ok(locks.heldBy("everytab-store"),
          "every initial or retried revision publication holds the Store lock");
        if (holdNext) await holdNext;
        if (failNext) {
          failNext = false;
          throw new Error("injected chrome.storage failure");
        }
        storedRevision = structuredClone(value.storageV2Revision);
        writes.push(structuredClone(storedRevision));
      }
    },
    onChanged: {
      addListener() {},
      removeListener() {}
    }
  }
};

try {
  const { publishStorageRevision } = await import(
    "../js/lib/storage/authority-runtime.js"
  );
  const authority = { readPendingRevision: async () => structuredClone(durableRevision) };
  const first = { id: "first", changedKeys: ["inbox"], committedAt: 1 };
  durableRevision = first;
  assert.equal(await publishStorageRevision(first, {}, { authority }), false,
    "a transient publication failure does not report the domain commit as failed");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  timers.shift().callback();
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
  assert.deepEqual(writes.map(({ id }) => id), ["first"],
    "the exact durable revision is retried independently");

  let releaseHeld;
  holdNext = new Promise((resolve) => { releaseHeld = resolve; });
  durableRevision = { id: "second", changedKeys: ["sessions"], committedAt: 2 };
  const second = publishStorageRevision(durableRevision, {}, { authority });
  durableRevision = { id: "third", changedKeys: ["archive"], committedAt: 3 };
  const third = publishStorageRevision(durableRevision, {}, { authority });
  releaseHeld();
  holdNext = null;
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.deepEqual(writes.map(({ id }) => id), ["first", "second", "third"],
    "a newer revision queued behind an in-flight write is published afterward");

  failNext = true;
  durableRevision = { id: "fourth", changedKeys: ["sessions"], committedAt: 4 };
  assert.equal(await publishStorageRevision(durableRevision, {}, { authority }), false);
  durableRevision = { id: "fifth", changedKeys: ["archive"], committedAt: 5 };
  assert.equal(await publishStorageRevision(durableRevision, {}, { authority }), true);
  assert.deepEqual(writes.at(-1), {
    id: "fifth", changedKeys: ["sessions", "archive"], committedAt: 5
  }, "a newer retry carries every family invalidation missed by the failed pulse");

  console.log("PASS: storage revision publication is retryable and ordered");
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
