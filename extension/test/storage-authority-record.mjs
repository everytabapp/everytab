import assert from "node:assert/strict";
import {
  createStorageAuthorityRecord, isStorageAuthorityRecord
} from "../js/lib/storage/authority-record.js";

const authority = createStorageAuthorityRecord({
  runId: "installed-run",
  createdAt: 123,
  databases: {
    library: "everytab-library-user-data",
    recovery: "everytab-recovery-user-data"
  },
  snapshotRetention: 200
});
assert.deepEqual(authority, {
  app: "everytab",
  kind: "storage-authority",
  formatVersion: 1,
  runId: "installed-run",
  createdAt: 123,
  databases: {
    library: "everytab-library-user-data",
    recovery: "everytab-recovery-user-data"
  },
  snapshotRetention: 200
});
assert.equal(isStorageAuthorityRecord(authority), true);
assert.equal(isStorageAuthorityRecord({ ...authority, databases: {} }), false);
assert.equal(isStorageAuthorityRecord({ ...authority, snapshotRetention: -1 }), false);

assert.throws(() => createStorageAuthorityRecord({
  runId: "",
  createdAt: 123,
  databases: authority.databases,
  snapshotRetention: 200
}), /valid Storage authority record/);

console.log("PASS: permanent Storage authority preserves exact database identity");
