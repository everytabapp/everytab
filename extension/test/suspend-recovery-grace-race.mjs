import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const mem = {
  suspendedRegistry: {
    801: {
      originalUrl: "https://kept.example/race",
      title: "Kept",
      windowId: 1,
      index: 0,
      pinned: false
    }
  }
};

let releaseGraceSet;
const graceSetReleased = new Promise((resolve) => { releaseGraceSet = resolve; });
let graceSetStarted;
const graceSetReady = new Promise((resolve) => { graceSetStarted = resolve; });

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") {
          return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        }
        return Object.fromEntries(keys.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (value) => {
        if (Object.hasOwn(value, "suspendRecoveryGraceUntil")) {
          graceSetStarted();
          await graceSetReleased;
        }
        Object.assign(mem, structuredClone(value));
      }
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const {
  getSuspendRegistry,
  markRecoveryGrace,
  unregisterSuspendedOnClose
} = await import("../js/lib/suspend.js");

// Exact reload ordering: the new worker starts writing the grace marker, but
// Chrome reports an old suspended page removed before that write has committed.
const marking = markRecoveryGrace();
await graceSetReady;
const removing = unregisterSuspendedOnClose(801);
await Promise.resolve();
releaseGraceSet();
await Promise.all([marking, removing]);

assert.ok(
  Object.hasOwn(await getSuspendRegistry(), "801"),
  "an onRemoved event racing the grace write must not erase the recovery entry"
);

console.log("PASS: reload removal cannot outrun the suspended-tab recovery grace marker");
