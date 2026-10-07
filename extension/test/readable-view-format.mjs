import assert from "node:assert/strict";
import {
  buildReadableIndex,
  buildReadableLibrary
} from "../js/vault/readable-views.js";

const base = {
  contentHash: "sha256:content",
  assets: [],
  entities: []
};

const entity = (family, id, value, lifecycle = "live") => ({
  family,
  id,
  lifecycle,
  ...(lifecycle === "live" ? { value } : {}),
  assetDigests: []
});

const build = (entities) => buildReadableLibrary({ ...base, entities }, {
  vaultId: "vault",
  inputHash: "sha256:input",
  generatedAt: Date.UTC(2026, 8, 10)
});

assert.throws(
  () => build([entity("futureFamily", "removed", undefined, "deleted")]),
  /Unsupported saved-data family/
);
assert.throws(
  () => build([entity("futureFamily", "future", { schemaVersion: 1 })]),
  /Unsupported saved-data family/
);
assert.throws(
  () => build([entity("inbox", "future", { schemaVersion: 2 })]),
  /Unsupported saved-data version/
);

assert.doesNotThrow(() => build([entity("inbox", "unversioned", { kind: "tab", tabs: [] })]));

assert.throws(
  () => buildReadableIndex({
    generatedAt: Date.UTC(2026, 8, 10),
    inputHash: "sha256:input",
    families: { futureFamily: {} }
  }),
  /Unsupported saved-data family/
);
assert.throws(
  () => buildReadableIndex({
    generatedAt: Date.UTC(2026, 8, 10),
    inputHash: "sha256:input",
    families: { inbox: { future: { schemaVersion: 2 } } }
  }),
  /Unsupported saved-data version/
);

console.log("PASS: readable Vault views reject unsupported record formats");
