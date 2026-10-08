// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure as diagnosticReportFailure } from "../failure-diagnostic.js";
/** Runtime access to the one permanent IndexedDB authority. */
import { createStorageAuthority } from "./local-authority.js";
import { openLibraryStore } from "./library-store.js";
import { openRecoveryStore } from "./recovery-store.js";
import { LIBRARY_DATABASE_NAME, RECOVERY_DATABASE_NAME } from "./schema.js";
import {
  createStorageAuthorityRecord, isStorageAuthorityRecord, STORAGE_AUTHORITY_KEY
} from "./authority-record.js";
import {
  STORAGE_AUTHORITY_INITIALIZATION_KEY, STORAGE_REVISION_KEY, storageChangedKeys,
  STORAGE_SETTINGS_FAMILY, STORAGE_SINGLETON_ID
} from "./constants.js";

export { storageChangedKeys } from "./constants.js";

let authorityRecordPromise;
let authorityEntry = null;
let testAuthority = null;
let listenedOnChanged = null;
let freshInstallPromise = null;
let revisionRetryTimer = 0;
let pendingRevision = null;
let pendingRevisionAuthority = null;
const STORE_LOCK = "everytab-store";
const INITIALIZATION_POLL_MS = 25;
const INITIALIZATION_WAIT_MS = 15_000;
// A page can load in the moment between installation and the worker's first
// `runtime.onInstalled`, before the initializing marker exists. Failing closed
// there left that first New Tab or Dashboard blank until reloaded. Extension
// pages wait this long for the marker or the authority to appear; the worker,
// which is the initializer, and non-page contexts keep failing closed at once.
const FRESH_INSTALL_PAGE_GRACE_MS = 4_000;

function isExtensionPage() {
  return typeof globalThis.document !== "undefined" &&
    globalThis.location?.protocol === "chrome-extension:";
}
const AUTHORITY_NOT_INITIALIZED_CODE = "storage-authority-not-initialized";

function authorityNotInitializedError() {
  const error = new Error("Storage authority is not initialized");
  error.code = AUTHORITY_NOT_INITIALIZED_CODE;
  return error;
}

function releaseAuthority() {
  const stale = authorityEntry;
  authorityEntry = null;
  pendingRevision = null;
  pendingRevisionAuthority = null;
  if (revisionRetryTimer) clearTimeout(revisionRetryTimer);
  revisionRetryTimer = 0;
  if (stale) void Promise.all([stale.library.close(), stale.recovery.close()]);
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local" ||
      (!changes[STORAGE_AUTHORITY_KEY] && !changes[STORAGE_AUTHORITY_INITIALIZATION_KEY])) return;
  authorityRecordPromise = undefined;
  releaseAuthority();
}

function listen() {
  const source = chrome.storage?.onChanged;
  if (!source?.addListener || source === listenedOnChanged) return;
  listenedOnChanged?.removeListener?.(onStorageChanged);
  // Test fixtures replace the complete Chrome storage source between cases;
  // treating that as the same profile would retain the previous authority.
  authorityRecordPromise = undefined;
  releaseAuthority();
  source.addListener(onStorageChanged);
  listenedOnChanged = source;
}

async function authorityRecord() {
  listen();
  if (!authorityRecordPromise) {
    authorityRecordPromise = (async () => {
      const startedAt = Date.now();
      let stored;
      do {
        stored = await chrome.storage.local.get([
          STORAGE_AUTHORITY_KEY, STORAGE_AUTHORITY_INITIALIZATION_KEY
        ]);
        if (isStorageAuthorityRecord(stored[STORAGE_AUTHORITY_KEY])) {
          return stored[STORAGE_AUTHORITY_KEY];
        }
        if (!stored[STORAGE_AUTHORITY_INITIALIZATION_KEY]) {
          if (!isExtensionPage() || Date.now() - startedAt >= FRESH_INSTALL_PAGE_GRACE_MS) {
            throw authorityNotInitializedError();
          }
          await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_POLL_MS));
          continue;
        }
        if (Date.now() - startedAt >= INITIALIZATION_WAIT_MS) {
          throw new Error("Storage authority initialization did not finish");
        }
        await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_POLL_MS));
      } while (true);
    })();
  }
  return authorityRecordPromise;
}

// Start the one small authority read when the module loads, alongside the
// caller's other boot work. If a worker stopped after publishing the
// fail-closed first-install marker, resume that exact initialization before
// any product read can route elsewhere.
if (globalThis.chrome?.storage?.local) {
  void resumeStorageAuthorityInitialization().catch((error) => {
    // The persisted initialization marker makes this retryable by the next
    // worker. Keep a diagnostic signal instead of silently stranding a fresh
    // profile behind its fail-closed authority marker.
    diagnosticReportFailure("storage-authority-initialization", error);
  });
  void startAuthorityPrewarm().catch((error) => {
    diagnosticReportFailure("storage-authority-prewarm-reporting", error);
  });
}

/**
 * Warm the permanent authority without turning expected pre-install absence
 * into noise. Storage and timeout failures remain visible to diagnostics.
 */
export async function startAuthorityPrewarm({
  readAuthority = authorityRecord,
  reportFailure = (error) => diagnosticReportFailure("storage-authority-prewarm", error)
} = {}) {
  try {
    const authority = await readAuthority();
    return { status: "ready", authority };
  } catch (error) {
    if (error?.code === AUTHORITY_NOT_INITIALIZED_CODE) {
      return { status: "not-initialized" };
    }
    reportFailure(error);
    return { status: "failed", error };
  }
}

/** Exact installed database identity, after any fresh-install setup settles. */
export async function currentStorageAuthorityRecord() {
  return authorityRecord();
}

export async function activeStorageAuthority() {
  if (testAuthority) return testAuthority;
  const selected = await authorityRecord();
  if (authorityEntry?.runId === selected.runId) return authorityEntry.authority;
  releaseAuthority();
  const storedDevice = await chrome.storage.local.get("deviceId");
  const deviceId = storedDevice.deviceId;
  if (typeof deviceId !== "string" || !deviceId) {
    throw new Error("Storage cannot open without a device identity");
  }
  const library = openLibraryStore({
    databaseName: selected.databases.library,
    deviceId
  });
  const recovery = openRecoveryStore({ databaseName: selected.databases.recovery });
  const authority = createStorageAuthority({
    library,
    recovery,
    snapshotRetention: selected.snapshotRetention,
    readBrowserLocal: (keys) => chrome.storage.local.get(keys)
  });
  authorityEntry = { runId: selected.runId, authority, library, recovery };
  // A domain commit and its small chrome.storage notification are deliberately
  // separate failure domains. Replay a durable, unpublished revision under the
  // same cross-context Store lock that orders every initial publication.
  void publishPendingStorageRevision(authority);
  return authority;
}

/**
 * Install an explicit authority adapter in Node tests. Production extension
 * contexts have no `process` global and cannot call this seam.
 */
export function setStorageAuthorityForTests(authority) {
  if (!globalThis.process?.versions?.node) {
    throw new Error("The Storage authority test seam is available only in Node");
  }
  testAuthority = authority || null;
}

/**
 * Start a genuinely new extension origin directly on the stable databases.
 * This is called only for runtime.onInstalled reason=install.
 */
function finishStorageAuthorityInitialization({ deviceId, runId }, {
  openLibrary = openLibraryStore,
  openRecovery = openRecoveryStore,
  now = () => Date.now()
} = {}) {
  return (async () => {
    const library = openLibrary({ databaseName: LIBRARY_DATABASE_NAME, deviceId });
    const recovery = openRecovery({ databaseName: RECOVERY_DATABASE_NAME });
    try {
      // Create and verify both complete schemas before publishing the authority
      // marker. A failed database open therefore leaves no half-active storage route.
      await Promise.all([
        library.readFamily("inbox", { includeDeleted: true }),
        recovery.listSnapshots({ limit: 1 })
      ]);
      // Ask before automatically closing or suspending on a new installation.
      // Publish these defaults before authority becomes visible. Existing
      // preferences, including a resumed initialization, stay untouched.
      const settings = await library.readEntity(STORAGE_SETTINGS_FAMILY,
        STORAGE_SINGLETON_ID, { includeDeleted: true });
      if (!settings) await library.commit({ operations: [{
        type: "put", family: STORAGE_SETTINGS_FAMILY, id: STORAGE_SINGLETON_ID,
        value: { value: { autoArchiveEnabled: false, suspendEnabled: false }, modifiedAt: now() }
      }] });
    } finally {
      await Promise.all([library.close(), recovery.close()]);
    }

    const storageAuthority = createStorageAuthorityRecord({
      runId,
      createdAt: now(),
      databases: {
        library: LIBRARY_DATABASE_NAME,
        recovery: RECOVERY_DATABASE_NAME
      },
      snapshotRetention: 200
    });
    await chrome.storage.local.set({
      deviceId,
      [STORAGE_AUTHORITY_KEY]: storageAuthority
    });
    await chrome.storage.local.remove?.(STORAGE_AUTHORITY_INITIALIZATION_KEY);
    authorityRecordPromise = undefined;
    releaseAuthority();
    return { initialized: true, authority: storageAuthority };
  })();
}

export function initializeStorageAuthority() {
  if (freshInstallPromise) return freshInstallPromise;
  // Publish the initializing marker before the first await. Every other
  // context waits for the final authority instead of opening an empty store.
  const deviceId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const markerWritten = chrome.storage.local.set({
    deviceId,
    [STORAGE_AUTHORITY_INITIALIZATION_KEY]: { deviceId, runId, startedAt: Date.now() }
  });
  freshInstallPromise = (async () => {
    await markerWritten;
    return finishStorageAuthorityInitialization({ deviceId, runId });
  })().finally(() => { freshInstallPromise = null; });
  return freshInstallPromise;
}

/**
 * Resume a first install interrupted by MV3 worker termination. The persisted
 * marker is deliberately sufficient to finish the same empty-database setup;
 * it never selects a database from anything except storageAuthority.
 */
export async function resumeStorageAuthorityInitialization(initializationEffects) {
  if (freshInstallPromise) return freshInstallPromise;
  const stored = await chrome.storage.local.get([
    STORAGE_AUTHORITY_KEY, STORAGE_AUTHORITY_INITIALIZATION_KEY, "deviceId"
  ]);
  if (isStorageAuthorityRecord(stored[STORAGE_AUTHORITY_KEY]) ||
      !stored[STORAGE_AUTHORITY_INITIALIZATION_KEY]) {
    return { initialized: false };
  }
  if (freshInstallPromise) return freshInstallPromise;

  const prior = stored[STORAGE_AUTHORITY_INITIALIZATION_KEY];
  const deviceId = typeof prior?.deviceId === "string" && prior.deviceId
    ? prior.deviceId
    : (typeof stored.deviceId === "string" && stored.deviceId
      ? stored.deviceId : crypto.randomUUID());
  const runId = typeof prior?.runId === "string" && prior.runId
    ? prior.runId : crypto.randomUUID();
  const initialization = {
    deviceId,
    runId,
    startedAt: Number(prior?.startedAt) || Date.now()
  };
  freshInstallPromise = (async () => {
    await chrome.storage.local.set({
      deviceId,
      [STORAGE_AUTHORITY_INITIALIZATION_KEY]: initialization
    });
    return finishStorageAuthorityInitialization({ deviceId, runId }, initializationEffects);
  })().finally(() => { freshInstallPromise = null; });
  return freshInstallPromise;
}

/**
 * Narrow replication projection for the Vault module. Product callers use
 * activeStorageAuthority instead; only sync needs the Library/Recovery
 * interfaces that already hide IndexedDB implementation details.
 */
export async function activeVaultStores() {
  await activeStorageAuthority();
  return authorityEntry
    ? {
      runId: authorityEntry.runId,
      library: authorityEntry.library,
      recovery: authorityEntry.recovery
    }
    : null;
}

/** Background maintenance uses the same Library authority as foreground reads/writes. */
export async function collectUnusedLibraryAssets() {
  const replication = await activeVaultStores();
  return replication ? replication.library.collectUnusedAssets() : null;
}

/**
 * Notify live extension pages after an authoritative commit. Failure cannot
 * turn a successful domain write into a failed user action. The exact bounded
 * revision is durable in IndexedDB and is retried independently.
 */
export function publishStorageRevision(
  revisionOrKeys,
  logicalChanges = {},
  { authority = null, storeLockHeld = false } = {}
) {
  const revision = Array.isArray(revisionOrKeys)
    ? {
      id: crypto.randomUUID(),
      changedKeys: [...new Set(revisionOrKeys)],
      ...(Object.keys(logicalChanges).length > 0
        ? { logicalChanges: structuredClone(logicalChanges) } : {}),
      committedAt: Date.now()
    }
    : structuredClone(revisionOrKeys);
  if (!revision?.id || !Array.isArray(revision.changedKeys)) {
    return Promise.resolve(false);
  }
  pendingRevision = mergeRevisionPulses(pendingRevision, revision);
  if (authority) pendingRevisionAuthority = authority;
  return storeLockHeld
    ? drainRevisionPublications(authority)
    : withRevisionStoreLock(() => drainRevisionPublications(authority));
}

function mergeRevisionPulses(older, newer) {
  if (!older) return newer;
  if (!newer) return older;
  return {
    ...newer,
    changedKeys: [...new Set([...older.changedKeys, ...newer.changedKeys])],
    ...((older.logicalChanges || newer.logicalChanges) ? {
      logicalChanges: {
        ...(older.logicalChanges ?? {}),
        ...(newer.logicalChanges ?? {})
      }
    } : {})
  };
}

function withRevisionStoreLock(work) {
  if (!navigator.locks?.request) {
    return Promise.reject(new Error("Chrome Web Locks are required for revision publication"));
  }
  return navigator.locks.request(STORE_LOCK, { mode: "exclusive" }, work);
}

function scheduleRevisionRetry(authority) {
  if (authority) pendingRevisionAuthority = authority;
  if (revisionRetryTimer) return;
  revisionRetryTimer = setTimeout(() => {
    revisionRetryTimer = 0;
    const selected = pendingRevisionAuthority;
    void withRevisionStoreLock(() => drainRevisionPublications(selected)).catch(() => {
      scheduleRevisionRetry(selected);
    });
  }, 250);
}

async function drainRevisionPublications(authority = null) {
  const selected = authority ?? pendingRevisionAuthority;
  if (typeof selected?.commitLibraryRevision === "function") {
    try {
      await selected.commitLibraryRevision();
    } catch {
      // Reopening a context must repair committed data before announcing it.
      // Keep startup non-blocking; this Store-lock-held drain retries independently.
      scheduleRevisionRetry(selected);
      return false;
    }
  }
  if (selected?.readPendingRevision) {
    try {
      const [durable, stored] = await Promise.all([
        selected.readPendingRevision(),
        chrome.storage.local.get(STORAGE_REVISION_KEY)
      ]);
      if (durable?.id && durable.id === stored[STORAGE_REVISION_KEY]?.id) {
        // Another context already published the newest durable revision while
        // this context was waiting to retry an older pulse.
        pendingRevision = null;
        return true;
      }
      if (durable?.id) pendingRevision = mergeRevisionPulses(pendingRevision, durable);
    } catch {
      // The concrete pending pulse below can still be attempted. A failure is
      // retried from the durable authority again.
      if (!pendingRevision) {
        scheduleRevisionRetry(selected);
        return false;
      }
    }
  }
  if (!pendingRevision) return true;
  const revision = pendingRevision;
  pendingRevision = null;
  try {
    await chrome.storage.local.set({ [STORAGE_REVISION_KEY]: revision });
  } catch {
    pendingRevision = mergeRevisionPulses(revision, pendingRevision);
    scheduleRevisionRetry(selected);
    return false;
  }
  return true;
}

function publishPendingStorageRevision(authority) {
  pendingRevisionAuthority = authority;
  return withRevisionStoreLock(() => drainRevisionPublications(authority)).catch(() => {
    scheduleRevisionRetry(authority);
    return false;
  });
}
