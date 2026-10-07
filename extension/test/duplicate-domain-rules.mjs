import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true, writable: true
});

const legacyRule = [{ hostname: "tickets.company", mode: "include-fragment" }];
const storage = createInterleavableStorage({
  deviceId: "duplicate-rules-test",
  duplicateDomainRules: legacyRule
});
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://duplicate-rules/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged }
};

const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

const {
  DUPLICATE_DOMAIN_RULES_KEY,
  DUPLICATE_DOMAIN_RULES_MIGRATION_KEY,
  duplicateUrlKey,
  normalizeDuplicateDomainRules,
  readDuplicateDomainRules,
  setDuplicateDomainRule
} = await import("../js/lib/duplicate-domain-rules.js");
const { findDuplicateGroupsFromTabs } = await import("../js/lib/dedup.js");

const ticketOne = "https://tickets.company/#/ticket/4821";
const ticketTwo = "https://tickets.company/#/ticket/9360";
const tabs = [
  { id: 1, url: ticketOne, active: true, pinned: false, incognito: false },
  { id: 2, url: ticketTwo, active: false, pinned: false, incognito: false }
];

assert.equal(findDuplicateGroupsFromTabs(tabs).length, 1,
  "the unchanged default ignores fragments");
const includeFragment = [{ hostname: "tickets.company", mode: "include-fragment" }];
assert.equal(duplicateUrlKey(ticketOne, includeFragment),
  "https://tickets.company/#/ticket/4821");
assert.equal(findDuplicateGroupsFromTabs(tabs, includeFragment).length, 0,
  "including the fragment separates different ticket routes");
assert.equal(findDuplicateGroupsFromTabs([
  tabs[0], { ...tabs[1], url: ticketOne }
], includeFragment).length, 1,
"including the fragment still groups an identical ticket address");

const skip = [{ hostname: "tickets.company", mode: "skip" }];
assert.equal(duplicateUrlKey(ticketOne, skip), null,
  "Skip removes the exact domain from duplicate identity");
assert.equal(findDuplicateGroupsFromTabs(tabs, skip).length, 0,
  "Skip removes the domain from duplicate groups");
assert.notEqual(duplicateUrlKey("https://admin.tickets.company/#/ticket/4821", skip), null,
  "an exact-domain rule does not affect subdomains");

assert.deepEqual(normalizeDuplicateDomainRules([
  { hostname: "TICKETS.COMPANY.", mode: "include-fragment" },
  { hostname: "tickets.company", mode: "skip" },
  { hostname: "invalid host", mode: "skip" },
  { hostname: "another.company", mode: "standard" }
]), [{ hostname: "tickets.company", mode: "skip" }],
"normalization canonicalizes, validates, deduplicates and omits Standard rules");

assert.deepEqual(await readDuplicateDomainRules(), includeFragment,
  "a legacy exact-domain exception migrates without changing behavior");
const migrated = storage.snapshot();
assert.deepEqual(migrated[DUPLICATE_DOMAIN_RULES_KEY], legacyRule,
  "migration preserves the retired device-local source as recovery data");
assert.equal(migrated[DUPLICATE_DOMAIN_RULES_MIGRATION_KEY]?.version, 1,
  "migration records its one-time portable boundary");
assert.deepEqual(migrated.settings?.duplicateDomainRules, includeFragment,
  "migration adds the exact-host exception to portable Settings");
assert.ok(Number.isFinite(migrated.settingsModifiedAt),
  "migration advances the portable Settings timestamp");
assert.equal(await setDuplicateDomainRule("tickets.company", "skip"), true);
assert.deepEqual(await readDuplicateDomainRules(), skip,
  "a portable Settings update replaces only its exact hostname rule");
assert.deepEqual(storage.snapshot().settings.duplicateDomainRules, skip);
assert.equal(await setDuplicateDomainRule("tickets.company", "standard"), true);
assert.deepEqual(await readDuplicateDomainRules(), [],
  "Standard stores an empty portable list so removal travels to other devices");
assert.deepEqual(storage.snapshot().settings.duplicateDomainRules, []);

console.log("PASS: duplicate domain rules are exact, portable and migration-safe");
