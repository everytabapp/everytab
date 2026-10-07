import assert from "node:assert/strict";
import {
  CUSTOM_SCHEME_CSS_PROPERTIES,
  MAX_CUSTOM_SCHEME_BYTES,
  availableSchemeIds,
  createCustomSchemeRecord,
  createDefaultCustomSchemeDraft,
  customSchemeCatalogue,
  customSchemeCssProperties,
  customSchemeDraftFromRecord,
  customSchemeFileName,
  customSchemeIdFromRef,
  customSchemeRef,
  duplicateCustomSchemeRecord,
  isRuntimeCustomSchemeRecord,
  normalizeSchemeSelection,
  parseCustomSchemeShare,
  resolveCustomSchemeMode,
  resolveSchemeSelection,
  runtimeCustomSchemeCssProperties,
  serializeCustomSchemeShare,
  validateCustomSchemeRecord
} from "../js/lib/custom-schemes.js";
import { maybeRotateSchemeOnOpen, rotationPool } from "../js/lib/scheme-rotation.js";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const meta = (id, modifiedAt = 10) => ({
  id, deviceId: "device-a", createdAt: 1, modifiedAt, schemaVersion: 1
});

const seed = createDefaultCustomSchemeDraft("Quiet Harbor");
ok(seed.ok && seed.value.roles.light && seed.value.roles.dark,
  "default draft contains complete valid Light and Dark modes");
const created = createCustomSchemeRecord(seed.value, meta(UUID_A));
ok(created.ok && created.value.id === UUID_A && created.value.schemeFormatVersion === 1,
  "valid draft promotes into one mergeable custom-scheme record");
ok(validateCustomSchemeRecord(created.value).ok,
  "the promoted record passes its public record validator");
ok(isRuntimeCustomSchemeRecord(created.value),
  "a strictly validated record carries the cheap runtime integrity seal");
ok(customSchemeDraftFromRecord(created.value).ok,
  "a saved record round-trips back to the editor draft interface");
ok(customSchemeRef(UUID_A) === `custom:${UUID_A}` &&
  customSchemeIdFromRef(`custom:${UUID_A}`) === UUID_A,
"custom identity uses one namespaced UUID reference");
ok(normalizeSchemeSelection("everforest") === "matcha" &&
  normalizeSchemeSelection("perestroika") === "jamon" &&
  normalizeSchemeSelection(`custom:${UUID_A}`) === `custom:${UUID_A}` &&
  normalizeSchemeSelection("not-real") === "cream",
"selection normalization preserves custom ids and built-in compatibility");

const brokenRole = structuredClone(created.value);
brokenRole.light.ink = brokenRole.light.bgSolid;
ok(!validateCustomSchemeRecord(brokenRole).ok,
  "a failing role pairing cannot become a usable record");
ok(!isRuntimeCustomSchemeRecord(brokenRole) && !runtimeCustomSchemeCssProperties(brokenRole, "light").ok,
  "a post-validation colour mutation invalidates the runtime record and paint projection");
const mismatchedSimple = structuredClone(created.value);
mismatchedSimple.light.accent = "#000000";
ok(!validateCustomSchemeRecord(mismatchedSimple).ok,
  "Simple records cannot smuggle roles that differ from their seven source colors");
const unknown = { ...created.value, css: "body{display:none}" };
ok(!validateCustomSchemeRecord(unknown).ok,
  "record validation rejects unknown CSS-shaped fields");

const newerDraft = customSchemeDraftFromRecord(created.value).value;
newerDraft.name = "Newer";
const newer = createCustomSchemeRecord(newerDraft, meta(UUID_B, 20)).value;
const tombstone = { ...created.value, deletedAt: 30, modifiedAt: 30 };
const catalogue = customSchemeCatalogue({ [UUID_A]: tombstone, [UUID_B]: newer, bad: brokenRole });
ok(catalogue.length === 1 && catalogue[0].label === "Newer",
  "catalogue filters tombstones and malformed records");
ok(availableSchemeIds({ [UUID_B]: newer }).length === 37,
  "the valid custom library extends rather than replaces the 36 built-ins");
const resolved = resolveSchemeSelection(`custom:${UUID_B}`, { [UUID_B]: newer });
ok(resolved.kind === "custom" && resolved.record.name === "Newer" &&
  resolveCustomSchemeMode("scheme", resolved) === newer.defaultMode,
"runtime resolution returns the selected valid custom record and its designed mode");
const missing = resolveSchemeSelection(`custom:${UUID_A}`, { [UUID_A]: tombstone });
ok(missing.selection === "cream" && missing.missingCustomRef === `custom:${UUID_A}`,
  "a missing or deleted active custom selection falls back safely to Cream");
ok(resolveCustomSchemeMode("system", resolved, true) === "dark" &&
  resolveCustomSchemeMode("light", resolved, true) === "light",
"forced and system modes remain independent of the scheme default");

const css = customSchemeCssProperties(created.value, "light");
ok(css.ok && CUSTOM_SCHEME_CSS_PROPERTIES.every((key) => key in css.value),
  "runtime CSS projection is complete and allowlisted");
const serialized = serializeCustomSchemeShare(created.value);
ok(serialized.ok && !serialized.text.includes("device-a") && !serialized.text.includes(UUID_A),
  "share files contain portable scheme data but no device or record identity");
const imported = parseCustomSchemeShare(serialized.text, meta(UUID_B));
ok(imported.ok && imported.value.id === UUID_B && imported.value.name === created.value.name,
  "share import always creates the supplied fresh local identity");
ok(customSchemeFileName(created.value) === "quiet-harbor.everytab-scheme.json",
  "share downloads use a bounded readable filename");

const injected = JSON.parse(serialized.text);
injected.scheme.url = "https://example.com/evil.css";
ok(!parseCustomSchemeShare(JSON.stringify(injected), meta(UUID_B)).ok,
  "share import rejects unknown URL or CSS fields");
const future = JSON.parse(serialized.text);
future.formatVersion = 99;
ok(!parseCustomSchemeShare(JSON.stringify(future), meta(UUID_B)).ok,
  "future share formats fail closed");
ok(!parseCustomSchemeShare("x".repeat(MAX_CUSTOM_SCHEME_BYTES + 1), meta(UUID_B)).ok,
  "oversized share files fail before parsing");
const duplicate = duplicateCustomSchemeRecord(created.value, meta(UUID_B));
ok(duplicate.ok && duplicate.value.id === UUID_B && duplicate.value.name === "Quiet Harbor copy",
  "duplicate creates an independent valid record with a fresh identity");

const hundred = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
  const id = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  // Identity and merge metadata are deliberately outside the validation seal.
  return [id, { ...created.value, id, modifiedAt: index + 1 }];
}));
const catalogueStarted = performance.now();
const hundredCatalogue = customSchemeCatalogue(hundred);
const catalogueMs = performance.now() - catalogueStarted;
ok(hundredCatalogue.length === 100,
  "a 100-record custom library remains a bounded pure catalogue operation");
ok(catalogueMs < 100,
  `a 100-record runtime catalogue stays below 100ms (${catalogueMs.toFixed(2)}ms)`);
ok(JSON.stringify(rotationPool([customSchemeRef(UUID_A)], { [UUID_A]: created.value })) ===
  JSON.stringify([customSchemeRef(UUID_A)]),
"custom schemes participate in the rotation favorite pool by namespaced identity");

const { createInterleavableStorage, createMockLockManager } = await import("./e2-mocks.mjs");
const customRefA = customSchemeRef(UUID_A);
const initialMaps = {
  customSchemes: { [UUID_A]: created.value },
  settings: {
    uiScheme: customRefA,
    schemeFavorites: ["tide", customRefA],
    schemeRotate: "open"
  },
  schemeRotationState: { remaining: [customRefA] },
  schemeRotationPrepared: { from: "tide", next: customRefA }
};
const storage = createInterleavableStorage({ deviceId: "custom-scheme-test" });
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const commits = [];
const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "custom-scheme-test",
  onCommit: (event) => commits.push(event)
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
const authority = createStorageAuthority({ library, recovery,
  readBrowserLocal: (keys) => storage.local.get(keys) });
setStorageAuthorityForTests(authority);
await authority.commitMaps(initialMaps);
const {
  deleteCustomSchemeAndRepair, loadCustomSchemeDraft, saveCustomSchemeDraft
} = await import("../js/lib/custom-scheme-store.js");
await saveCustomSchemeDraft({ kind: "editor-test", draft: seed.value });
ok((await loadCustomSchemeDraft()).kind === "editor-test",
  "the one operational editor draft persists locally outside the portable registry");
storage.setLog.splice(0);
commits.splice(0);
ok(await deleteCustomSchemeAndRepair(UUID_A),
  "deleting a custom scheme finds and tombstones the live mergeable record");
const afterDelete = await authority.readMaps(Object.keys(initialMaps));
ok(afterDelete.customSchemes[UUID_A].deletedAt && afterDelete.settings.uiScheme === "cream" &&
  JSON.stringify(afterDelete.settings.schemeFavorites) === JSON.stringify(["tide"]) &&
  afterDelete.schemeRotationState === null && afterDelete.schemeRotationPrepared === null &&
  storage.setLog.length === 1 && commits.length === 1 &&
  commits[0].changes.some(({ entity }) => entity.family === "customSchemes" && entity.lifecycle === "deleted") &&
  commits[0].changes.some(({ entity }) => entity.family === "settings") &&
  commits[0].localKeys.includes("schemeRotationState") &&
  commits[0].localKeys.includes("schemeRotationPrepared"),
"delete, active fallback, favorite cleanup, and rotation invalidation share one atomic commit");
const rotationAfterDelete = await maybeRotateSchemeOnOpen(() => 0.25);
const afterRotation = await authority.readMaps(Object.keys(initialMaps));
ok(rotationAfterDelete?.changed === true &&
  afterRotation.settings.uiScheme === "tide" &&
  afterRotation.schemeRotationState && afterRotation.schemeRotationPrepared,
"the first On-open draw after custom deletion consumes the explicit null invalidation safely");

setStorageAuthorityForTests(null);
await Promise.all([library.close(), recovery.close()]);
console.log(`Custom scheme domain tests passed: ${checks} assertions; 100-record catalogue ${catalogueMs.toFixed(2)}ms.`);
