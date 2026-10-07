/**
 * A named Session edit must not serialize the complete automatic-Snapshot
 * history through chrome.storage. Real Chrome clones whole-map get/set values
 * and the old/new onChanged payload for every listening extension context.
 *
 * Run from extension/: node test/session-write-responsiveness.mjs
 */
import { performance } from "node:perf_hooks";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const sessions = {};
for (let snapshot = 0; snapshot < 2_000; snapshot++) {
  const id = `snapshot-${snapshot}`;
  sessions[id] = {
    id,
    deviceId: "mature-device",
    schemaVersion: 1,
    name: `Snapshot ${snapshot}`,
    auto: true,
    createdAt: snapshot + 1,
    modifiedAt: snapshot + 1,
    labels: [],
    windows: [[...Array(72)].map((_, tab) => ({
      url: `https://snapshot-${snapshot}.example/tab-${tab}`,
      title: `Snapshot ${snapshot} tab ${tab}`,
      labels: []
    }))]
  };
}
sessions.named = {
  id: "named",
  deviceId: "mature-device",
  schemaVersion: 1,
  name: "Before",
  auto: false,
  createdAt: 3_000,
  modifiedAt: 3_000,
  labels: [],
  windows: [[{ url: "https://work.example", title: "Work", labels: [] }]]
};

const storage = createInterleavableStorage({
  deviceId: "mature-device",
  sessions,
  journal: []
});
// A real Dashboard receives the complete old/new change payload even when its
// callback does no work. The storage double clones that payload like Chrome.
storage.onChanged.addListener(() => {});
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const {
  renameSession, createSessionFromWindowsJournaled
} = await import("../js/lib/sessions.js");
const { ensureSessionIdentityIndex, mergeSessionMaps } = await import("../js/lib/store.js");

// The worker performs this additive backfill after the first useful paint. It
// may pay for one legacy read, but it writes only the small named projection;
// every later user edit must stay independent from Snapshot history.
await ensureSessionIdentityIndex();

let lastHeartbeat = performance.now();
let longestGap = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  longestGap = Math.max(longestGap, now - lastHeartbeat);
  lastHeartbeat = now;
}, 10);
await new Promise((resolve) => setTimeout(resolve, 0));
const started = performance.now();
const renamed = await renameSession("named", "After");
const created = await createSessionFromWindowsJournaled(
  [[{ url: "https://new.example", title: "New", labels: [] }]],
  "New project"
);
const elapsed = performance.now() - started;
await new Promise((resolve) => setTimeout(resolve, 0));
longestGap = Math.max(longestGap, performance.now() - lastHeartbeat);
clearInterval(heartbeat);

const after = storage.snapshot();
const logicalSessions = mergeSessionMaps(after.sessions, after.namedSessionRecords);
if (!renamed || !created || logicalSessions.named.name !== "After" ||
    logicalSessions[created.id]?.name !== "New project") {
  throw new Error("Mature-profile Session rename/create did not commit");
}
if (Object.keys(logicalSessions).length !== 2_002 ||
    logicalSessions["snapshot-1999"]?.windows?.[0]?.length !== 72) {
  throw new Error("Mature-profile Session rename lost automatic Snapshots");
}
if (longestGap > 100) {
  throw new Error(
    `Named Session writes starved input for ${longestGap.toFixed(1)}ms ` +
    `(${elapsed.toFixed(1)}ms total) by rewriting the complete Snapshot map`
  );
}

console.log(
  `PASS: named Session rename/create kept input gaps to ${longestGap.toFixed(1)}ms ` +
  `(${elapsed.toFixed(1)}ms total)`
);
