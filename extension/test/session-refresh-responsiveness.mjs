/**
 * Regression for a mature profile becoming unresponsive immediately after a
 * named Session write. A Session-only storage event must not route through the
 * complete saved-library navigation scan: that path clones and walks every
 * automatic Snapshot even though only Session navigation changed.
 *
 * Run from extension/: node test/session-refresh-responsiveness.mjs
 */
import { performance } from "node:perf_hooks";

const mem = { inbox: {}, archive: {}, archiveOverlay: {}, labelMeta: {} };
for (let snapshot = 0; snapshot < 2_000; snapshot++) {
  const refs = [];
  for (let tab = 0; tab < 72; tab++) {
    refs.push({
      url: `https://snapshot-${snapshot}.example/tab-${tab}`,
      title: `Snapshot ${snapshot} tab ${tab}`,
      labels: []
    });
  }
  mem.sessions ??= {};
  mem.sessions[`snapshot-${snapshot}`] = {
    id: `snapshot-${snapshot}`,
    name: `Snapshot ${snapshot}`,
    auto: true,
    createdAt: snapshot,
    modifiedAt: snapshot,
    windows: [refs],
    labels: []
  };
}
mem.sessions.named = {
  id: "named",
  name: "Current work",
  auto: false,
  createdAt: 3_000,
  modifiedAt: 3_000,
  windows: [[{ url: "https://work.example", title: "Work", labels: [] }]],
  labels: []
};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (key in mem) out[key] = structuredClone(mem[key]);
        }
        return out;
      }
    }
  }
};

const { dashboardTasksForStorage } = await import("../js/ui/refresh-scheduler.js");
const { readLabelNavigationSnapshot } = await import("../js/lib/labels.js");
const { sessionNavigationSnapshot } = await import("../js/lib/session-identity-index.js");

const tasks = dashboardTasksForStorage({ sessions: { newValue: mem.sessions } });
const navigation = sessionNavigationSnapshot(mem.sessions);
const started = performance.now();
if (tasks.includes("nav")) await readLabelNavigationSnapshot();
const elapsed = performance.now() - started;

if (!tasks.includes("navSessions") || tasks.includes("nav") ||
    navigation.namedSessions.length !== 1 || navigation.namedSessions[0].id !== "named" ||
    navigation.snapshotCount !== 2_000 || elapsed > 100) {
  throw new Error(
    `Session-only refresh blocked the UI through full navigation work: ` +
    `${tasks.join(",")} in ${elapsed.toFixed(1)}ms; ` +
    `${navigation.namedSessions.length} named / ${navigation.snapshotCount} snapshots`
  );
}

// The delayed Vault pass writes only vaultMetaV2 after it completes. That status
// event must not turn around and rebuild the complete navigation library: on a
// mature profile the redundant Session/Snapshot clone lands a few seconds after
// the original edit and makes nearby controls appear to freeze again.
const vaultTasks = dashboardTasksForStorage({
  vaultMetaV2: { newValue: { lastSyncAt: 4_000, ok: true, pulled: 0, pushed: 1 } }
});
const vaultStarted = performance.now();
if (vaultTasks.includes("nav")) await readLabelNavigationSnapshot();
const vaultElapsed = performance.now() - vaultStarted;

if (vaultTasks.includes("nav") || vaultElapsed > 100) {
  throw new Error(
    `Vault completion re-entered the full navigation scan: ` +
    `${vaultTasks.join(",")} in ${vaultElapsed.toFixed(1)}ms`
  );
}

console.log(
  `PASS: Session and post-Vault refresh stayed responsive ` +
  `(${elapsed.toFixed(1)}ms / ${vaultElapsed.toFixed(1)}ms)`
);
