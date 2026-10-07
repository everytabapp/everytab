/** Read-only, privacy-safe steady-state measurement for a Vault. */

const MEBIBYTE = 1024 * 1024;
const RETAINED_BUDGET_BYTES = 100 * MEBIBYTE;
const EXPECTED_TARGET_BYTES = 20 * MEBIBYTE;
const FILE_CONCURRENCY = 4;
const VAULT_LOCK = "everytab-vault-sync";

const AREA_NAMES = Object.freeze([
  "protocol",
  "libraryChanges",
  "recovery",
  "favicons",
  "restorePoints",
  "readableViews",
  "other"
]);

const ZERO_COUNT_FIELDS = Object.freeze([
  "pulled",
  "pushed",
  "chunksRead",
  "chunksWritten",
  "chunksPruned",
  "assetsRead",
  "assetsWritten",
  "recoverySnapshotsWritten",
  "recoveryPacksPruned",
  "backupsPruned",
  "checkpointsPruned",
  "conflictCopies"
]);

const FALSE_FIELDS = Object.freeze([
  "checkpointWritten",
  "checkpointRead",
  "recoveryPackWritten",
  "recoveryCompacted",
  "libraryCompacted",
  "viewsWritten",
  "backedUp"
]);

function emptyArea() {
  return { byteLength: 0, fileCount: 0, directoryCount: 0 };
}

function areaFor(topLevelName) {
  if (topLevelName === "devices") return "libraryChanges";
  if (topLevelName === "recovery") return "recovery";
  if (topLevelName === "assets") return "favicons";
  if (["checkpoints", "backups"].includes(topLevelName)) return "restorePoints";
  if (topLevelName === "format.json") return "protocol";
  if (["library.json", "index.md", "views.json"].includes(topLevelName)) {
    return "readableViews";
  }
  if (topLevelName === "maintenance.json") return "restorePoints";
  return "other";
}

async function mapBounded(values, limit, visit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await visit(values[index], index);
    }
  });
  await Promise.all(workers);
}

/**
 * Measure names only to classify stable protocol areas, then read File.size.
 * The result never contains a folder name, file name, URL, title, or identity.
 */
export async function measureVaultStorage(root) {
  if (!root?.entries) throw new Error("The Vault folder is not available");
  const areas = Object.fromEntries(AREA_NAMES.map((name) => [name, emptyArea()]));
  const files = [];
  const queue = [{ directory: root, topLevelName: null }];
  let directoryCursor = 0;

  while (directoryCursor < queue.length) {
    const { directory, topLevelName } = queue[directoryCursor];
    directoryCursor += 1;
    for await (const [name, handle] of directory.entries()) {
      const top = topLevelName ?? name;
      if (handle?.kind === "directory") {
        areas[areaFor(top)].directoryCount += 1;
        queue.push({ directory: handle, topLevelName: top });
      } else if (handle?.kind === "file") {
        files.push({ handle, area: areaFor(top) });
      }
    }
  }

  await mapBounded(files, FILE_CONCURRENCY, async ({ handle, area }) => {
    const file = await handle.getFile();
    const byteLength = Number(file?.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("A Vault file reported an invalid size");
    }
    areas[area].byteLength += byteLength;
    areas[area].fileCount += 1;
  });

  const totals = Object.values(areas).reduce((result, area) => ({
    byteLength: result.byteLength + area.byteLength,
    fileCount: result.fileCount + area.fileCount,
    directoryCount: result.directoryCount + area.directoryCount
  }), emptyArea());
  return { ...totals, areas };
}

/** A strict receipt check. Missing fields cannot prove that no work occurred. */
export function noChangeVaultSync(syncMeta) {
  return syncMeta?.ok === true && syncMeta.storageVersion === 2 &&
    syncMeta.skipped !== true &&
    ZERO_COUNT_FIELDS.every((field) => syncMeta[field] === 0) &&
    FALSE_FIELDS.every((field) => syncMeta[field] === false);
}

function syncSummary(syncMeta) {
  const fields = [...ZERO_COUNT_FIELDS, ...FALSE_FIELDS];
  return {
    at: Number.isSafeInteger(syncMeta?.lastSyncAt) ? syncMeta.lastSyncAt : null,
    noChange: noChangeVaultSync(syncMeta),
    ...Object.fromEntries(fields.map((field) => [field, syncMeta?.[field] ?? null])),
    skipped: syncMeta?.skipped === true
  };
}

/**
 * Build the report copied by the installed UI. The Vault scan is read-only;
 * browserStorage is an aggregate estimate for this extension origin only.
 */
export async function buildVaultSteadyStateReport(root, {
  syncMeta,
  readSyncMeta = null,
  inspect = null,
  estimateStorage = null,
  lockManager = globalThis.navigator?.locks ?? null,
  now = () => Date.now()
} = {}) {
  const readVaultState = async () => {
    const inspectVault = inspect ??
      (await import("../../extension/js/vault/protocol-sync.js")).inspectVaultRoot;
    const inspection = await inspectVault(root);
    if (inspection?.state !== "ready") {
      throw new Error("The selected folder is not a ready Vault");
    }
    const [measured, currentSyncMeta] = await Promise.all([
      measureVaultStorage(root),
      typeof readSyncMeta === "function" ? readSyncMeta() : syncMeta
    ]);
    return { measured, lastSync: syncSummary(currentSyncMeta) };
  };
  const state = lockManager?.request
    ? await lockManager.request(VAULT_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("A Vault sync is running. Check storage when it finishes");
        return readVaultState();
      })
    : await readVaultState();
  const { measured, lastSync } = state;
  let browserStorage = null;
  if (typeof estimateStorage === "function") {
    try {
      const estimate = await estimateStorage();
      browserStorage = {
        scope: "extension-origin-total",
        usage: Number.isSafeInteger(estimate?.usage) ? estimate.usage : null,
        quota: Number.isSafeInteger(estimate?.quota) ? estimate.quota : null
      };
    } catch {
      browserStorage = { scope: "extension-origin-total", usage: null, quota: null };
    }
  }
  const vault = {
    ...measured,
    withinRetainedBudget: measured.byteLength < RETAINED_BUDGET_BYTES,
    expectedTargetMet: measured.byteLength < EXPECTED_TARGET_BYTES,
    retainedBudgetBytes: RETAINED_BUDGET_BYTES,
    expectedTargetBytes: EXPECTED_TARGET_BYTES
  };
  return {
    app: "everytab",
    kind: "storage-v2-steady-state-report",
    formatVersion: 1,
    status: vault.withinRetainedBudget && lastSync.noChange ? "verified" : "attention",
    createdAt: now(),
    vault,
    lastSync,
    browserStorage
  };
}
