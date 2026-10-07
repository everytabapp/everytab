// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Physical IndexedDB schemas. Product callers never depend on these names. */
export const LIBRARY_DATABASE_NAME = "everytab-library-v2";
export const RECOVERY_DATABASE_NAME = "everytab-recovery-v2";
export const LIBRARY_SCHEMA_VERSION = 2;
export const RECOVERY_SCHEMA_VERSION = 1;

export const LIBRARY_STORES = Object.freeze({
  entities: "entities",
  assets: "assets",
  outbox: "outbox",
  replicas: "replicas",
  meta: "meta",
  // Device-local operational state that must share the same atomic commit as
  // Library mutations (Undo journals, counters, and browser-effect receipts).
  // It is deliberately absent from checkpoints and the Vault protocol.
  local: "local"
});

export const RECOVERY_STORES = Object.freeze({
  snapshots: "snapshots",
  assets: "assets",
  meta: "meta"
});

export const LIBRARY_SCHEMA = Object.freeze({
  name: LIBRARY_DATABASE_NAME,
  version: LIBRARY_SCHEMA_VERSION,
  stores: Object.freeze([
    {
      name: LIBRARY_STORES.entities,
      keyPath: ["family", "id"],
      indexes: Object.freeze([
        { name: "byFamilyLifecycle", keyPath: ["family", "lifecycle"] },
        { name: "byFamily", keyPath: "family" }
      ])
    },
    { name: LIBRARY_STORES.assets, keyPath: "digest", indexes: Object.freeze([]) },
    {
      name: LIBRARY_STORES.outbox,
      keyPath: ["deviceId", "sequence"],
      indexes: Object.freeze([{ name: "byDevice", keyPath: "deviceId" }])
    },
    { name: LIBRARY_STORES.replicas, keyPath: "deviceId", indexes: Object.freeze([]) },
    { name: LIBRARY_STORES.meta, keyPath: "key", indexes: Object.freeze([]) },
    { name: LIBRARY_STORES.local, keyPath: "key", indexes: Object.freeze([]) }
  ])
});

export const RECOVERY_SCHEMA = Object.freeze({
  name: RECOVERY_DATABASE_NAME,
  version: RECOVERY_SCHEMA_VERSION,
  stores: Object.freeze([
    {
      name: RECOVERY_STORES.snapshots,
      keyPath: "id",
      indexes: Object.freeze([{ name: "byCapturedAt", keyPath: "capturedAt" }])
    },
    { name: RECOVERY_STORES.assets, keyPath: "digest", indexes: Object.freeze([]) },
    { name: RECOVERY_STORES.meta, keyPath: "key", indexes: Object.freeze([]) }
  ])
});
