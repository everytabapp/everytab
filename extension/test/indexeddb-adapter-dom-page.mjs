import { openLibraryStore } from "../js/lib/storage/library-store.js";
import { openRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";

const resultNode = document.querySelector("#result");
const suffix = new URLSearchParams(location.search).get("run") ?? crypto.randomUUID();
const libraryName = `everytab-library-v2-test-${suffix}`;
const recoveryName = `everytab-recovery-v2-test-${suffix}`;
const remoteLibraryName = `everytab-library-v2-remote-test-${suffix}`;
const favicons = Array.from(
  { length: 40 },
  (_, index) => `data:image/png;base64,${btoa(`native-favicon-${index}`)}`
);
const favicon = favicons[0];

function removeDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not remove ${name}`));
    request.onblocked = () => reject(new Error(`Removal of ${name} was blocked`));
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

let library;
let recovery;
let remoteLibrary;
try {
  library = openLibraryStore({
    databaseName: libraryName,
    deviceId: "native-browser",
    now: () => 1_000
  });
  const committed = await library.transact([
    {
      type: "put",
      family: "inbox",
      id: "first",
      value: {
        id: "first",
        tabs: favicons.map((favIconUrl, index) => ({
          url: `https://one.example/${index}`,
          title: `One ${index}`,
          favIconUrl
        })),
        labels: ["work"]
      }
    },
    {
      type: "put",
      family: "inbox",
      id: "second",
      value: {
        id: "second",
        tabs: [{ url: "https://two.example", title: "Two", favIconUrl: favicon }]
      }
    }
  ]);
  check(committed.throughSequence === 2, "native transaction did not allocate two changes");
  check((await library.readFamily("inbox")).length === 2,
    "native transaction did not persist both records");
  const hydratedFirst = await library.readEntity("inbox", "first");
  check(hydratedFirst.value.tabs.every((tab, index) => tab.favIconUrl === favicons[index]),
    "native read did not hydrate all content-addressed favicons");
  check((await library.readSyncBatch()).assets.length === favicons.length,
    "native store did not retain the unique favicon set");
  const noChangeBatch = await library.readSyncBatch({
    afterSequence: committed.throughSequence,
    throughSequence: committed.throughSequence
  });
  check(noChangeBatch.changes.length === 0,
    "native no-change sync did not return an empty batch");
  await library.commit({
    operations: [{
      type: "put", family: "inbox", id: "third",
      value: { id: "third", tabs: [], labels: [] }
    }],
    localSets: { journal: { entries: ["third"] } }
  });
  check((await library.readLocal(["journal"])).journal.entries[0] === "third",
    "native combined entity and local commit did not persist its companion state");

  let rejected = false;
  try {
    await library.transact([
      { type: "put", family: "inbox", id: "must-rollback", value: { title: "Rollback" } },
      { type: "unsupported", family: "inbox", id: "invalid" }
    ]);
  } catch {
    rejected = true;
  }
  check(rejected, "invalid native transaction did not reject");
  check(await library.readEntity("inbox", "must-rollback") === null,
    "native IndexedDB transaction was not atomic");

  await library.close();
  library = openLibraryStore({
    databaseName: libraryName,
    deviceId: "native-browser",
    now: () => 1_001
  });
  check((await library.readFamily("inbox")).length === 3,
    "native records did not survive a database reopen");

  const restorePoint = await library.createExactCheckpoint();
  await library.transact([{
    type: "put", family: "inbox", id: "after-restore-point",
    value: {
      id: "after-restore-point",
      tabs: [{ url: "https://after-restore-point.example", title: "After Restore point" }],
      labels: []
    }
  }]);
  const preview = await library.previewExactRestore(restorePoint);
  check(preview.removed === 1 && preview.pendingRestore === false,
    "native exact Restore preview did not identify the later record");
  const restored = await library.replaceFromCheckpoint(restorePoint, {
    expectedSequence: preview.currentSequence,
    expectedRestoreEpoch: preview.restoreEpoch,
    expectedStateHash: preview.currentStateHash,
    restoreId: "native-restore"
  });
  check(restored.status === "restored" &&
    await library.readEntity("inbox", "after-restore-point") === null &&
    (await library.readPendingRestore())?.id === "native-restore",
  "native exact Restore did not atomically replace the Library and retain its safety point");
  await library.undoExactRestore("native-restore");
  check((await library.readEntity("inbox", "after-restore-point"))?.value?.tabs?.[0]?.url ===
    "https://after-restore-point.example" && await library.readPendingRestore() === null,
  "native exact Restore Undo did not recover the pre-Restore Library");

  const beforeRemote = await library.previewExactRestore(restorePoint);
  remoteLibrary = openLibraryStore({
    databaseName: remoteLibraryName,
    deviceId: "native-remote",
    now: () => 2_000
  });
  await remoteLibrary.transact([{
    type: "put", family: "inbox", id: "remote-after-preview",
    value: { id: "remote-after-preview", tabs: [{ url: "https://remote-after-preview.example" }] }
  }]);
  await library.applyRemoteBatch(await remoteLibrary.readSyncBatch());
  const afterRemote = await library.previewExactRestore(restorePoint);
  check(afterRemote.currentSequence === beforeRemote.currentSequence &&
    afterRemote.restoreEpoch === beforeRemote.restoreEpoch,
  "the native fixture must reproduce remote changes invisible to the old freshness counters");
  let staleRejected = false;
  try {
    await library.replaceFromCheckpoint(restorePoint, {
      expectedSequence: beforeRemote.currentSequence,
      expectedRestoreEpoch: beforeRemote.restoreEpoch,
      expectedStateHash: beforeRemote.currentStateHash,
      restoreId: "native-stale-remote"
    });
  } catch (error) {
    staleRejected = /changed after this Restore was reviewed/i.test(error.message);
  }
  check(staleRejected && await library.readEntity("inbox", "remote-after-preview") &&
    await library.readPendingRestore() === null,
  "native Restore must reject a stale remote preview without deleting the new record");
  const freshRemoteRestore = await library.replaceFromCheckpoint(restorePoint, {
    expectedSequence: afterRemote.currentSequence,
    expectedRestoreEpoch: afterRemote.restoreEpoch,
    expectedStateHash: afterRemote.currentStateHash,
    restoreId: "native-reviewed-remote"
  });
  check(freshRemoteRestore.status === "restored" &&
    await library.readEntity("inbox", "remote-after-preview") === null,
  "native Restore must accept a fresh preview after the remote merge");
  await library.undoExactRestore("native-reviewed-remote");
  check(await library.readEntity("inbox", "remote-after-preview"),
    "native Undo must recover the reviewed remote record");

  let snapshotId = 0;
  recovery = openRecoveryStore({
    databaseName: recoveryName,
    now: () => 2_000 + snapshotId,
    createId: () => `snapshot-${++snapshotId}`
  });
  const arrangement = (url) => ({
    windows: [favicons.map((favIconUrl, index) => ({
      url: `${url}/${index}`,
      favIconUrl
    }))]
  });
  await recovery.captureSnapshot(arrangement("https://one.example"), { retention: 2 });
  await recovery.captureSnapshot(arrangement("https://two.example"), { retention: 2 });
  const captured = await recovery.captureSnapshot(
    arrangement("https://three.example"), { retention: 2 }
  );
  check(captured.pruned.length === 1 && captured.pruned[0] === "snapshot-1",
    "native Recovery retention did not prune the oldest snapshot");
  const pack = await recovery.exportRecoveryPack();
  check(pack.snapshots.length === 2, "native Recovery pack has the wrong snapshot count");
  check(pack.assets.length === favicons.length,
    "native Recovery did not deduplicate retained assets");
  check(await recovery.deleteSnapshot("snapshot-2") === true,
    "native Recovery did not delete an explicit Snapshot");
  check((await recovery.exportRecoveryPack()).assets.length === favicons.length,
    "native Recovery collected an asset that still had one reference");
  check(await recovery.deleteSnapshot("snapshot-3") === true,
    "native Recovery did not delete its final Snapshot");
  check((await recovery.exportRecoveryPack()).assets.length === 0,
    "native Recovery retained an unreferenced private asset");

  await remoteLibrary.transact([{ type: "put", family: "sessions", id: "native-repair-session",
    value: { id: "native-repair-session", name: "Native repaired Session", auto: false,
      windows: [[{ url: "https://native-repair.example" }]], labels: [] } }]);
  let nativeRepairFailed = false;
  const nativeCommit = library.commit;
  library.commit = async options => {
    if (options.localSets?.storageV2DurableRevision) throw new Error("injected native revision failure");
    return nativeCommit(options);
  };
  await navigator.locks.request("everytab-store", async () => {
    await library.applyRemoteBatch(await remoteLibrary.readSyncBatch());
    try {
      await createStorageAuthority({ library, recovery }).commitLibraryRevision(["sessions"]);
    } catch (error) {
      nativeRepairFailed = /injected native revision failure/.test(error.message);
    }
  });
  check(nativeRepairFailed, "the native repair fixture did not inject its post-commit failure");
  await library.close();
  library = openLibraryStore({ databaseName: libraryName, deviceId: "native-browser", now: () => 3_000 });
  check((await library.readLocal(["storageV2PendingLibraryRevision"]))
    .storageV2PendingLibraryRevision.includes("sessions"),
  "the remote commit's repair intent did not survive native database reopen");
  const reopenedAuthority = createStorageAuthority({ library, recovery });
  await navigator.locks.request("everytab-store", () => reopenedAuthority.commitLibraryRevision());
  const repairedLocal = await library.readLocal(["storageV2PendingLibraryRevision", "sessionIdentityIndex"]);
  check(repairedLocal.storageV2PendingLibraryRevision === undefined &&
    repairedLocal.sessionIdentityIndex.sessionsById["native-repair-session"].name === "Native repaired Session",
  "native no-change repair did not atomically rebuild the index and retire its intent");
  check((await reopenedAuthority.readPendingRevision()).changedKeys.includes("sessions"),
    "native repair did not retain a publishable durable revision");

  resultNode.dataset.status = "pass";
  resultNode.textContent = "PASS: native IndexedDB Library and Recovery stores";
} catch (error) {
  resultNode.dataset.status = "fail";
  resultNode.textContent = error?.stack ?? String(error);
} finally {
  await library?.close();
  await recovery?.close();
  await remoteLibrary?.close();
  for (const name of [libraryName, recoveryName, remoteLibraryName]) {
    await removeDatabase(name).catch(() => {});
  }
}
