/** P11-14 organization domain focused suite. */
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-08-17T10:00:00Z");
const storage = createInterleavableStorage({ deviceId: "organization-test" });
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, writable: true, configurable: true
});

const { STORE_KEYS, ARCHIVE_OVERLAY_KEY } = await import("../js/lib/types.js");
const {
  createOrganizationGroup, deleteNamedSession, deleteOrganizationGroup,
  organizationMembershipId, projectOrganization, readOrganizationState,
  renameOrganizationGroup, replaceGroupMembers, replaceMemberGroups
} = await import("../js/lib/organization.js");
const { renameLabel, deleteLabelEverywhere } = await import("../js/lib/labels.js");
const { buildPortableExport, previewPortableRestore } = await import("../js/lib/portable-state.js");

let failures = 0;
function check(condition, name) {
  if (condition) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}
function meta(id, extra = {}) {
  return {
    id, deviceId: "organization-test", createdAt: T0, modifiedAt: T0,
    schemaVersion: 1, ...extra
  };
}
function session(id, name, auto = false) {
  return meta(id, {
    name, auto, labels: [], windows: [[{ url: `https://${name}.example`, title: name }]]
  });
}

const namedId = ID(1);
const snapshotId = ID(2);
await chrome.storage.local.set({
  [STORE_KEYS.sessions]: {
    [namedId]: session(namedId, "Research"),
    [snapshotId]: session(snapshotId, "Automatic", true)
  }
});

/* deterministic identity is tuple-stable and UUID-shaped */
const edgeA = organizationMembershipId("label", "alpha", ID(9));
check(edgeA === organizationMembershipId("label", "alpha", ID(9)) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(edgeA),
"P11-14 membership identity is deterministic and UUID-shaped");
check(edgeA !== organizationMembershipId("label", "Alpha", ID(9)),
  "P11-14 exact Label identity remains case-sensitive");

const work = await createOrganizationGroup("label", "Work", ["alpha"]);
const personal = await createOrganizationGroup("label", "Personal");
const sessionsGroup = await createOrganizationGroup("session", "Projects", [namedId]);
check(work.ok && personal.ok && sessionsGroup.ok,
  "P11-14 creates typed groups and optional memberships atomically");
check(!(await createOrganizationGroup("label", " work ")).ok &&
  (await createOrganizationGroup("label", "WORK")).reason === "duplicate-name",
  "P11-14 rejects case-insensitive duplicate names after trim");
check((await createOrganizationGroup("label", "Ungrouped")).reason === "reserved-name",
  "P11-14 reserves the projected Ungrouped name only for groups");
check((await createOrganizationGroup("session", "Snapshots", [snapshotId])).reason === "invalid-members",
  "P11-14 automatic Snapshots cannot enter Session groups");

const portable = JSON.parse(await buildPortableExport());
const portableEdgeId = organizationMembershipId("label", "alpha", work.entry.id);
check(portable.data.organizationGroups[work.entry.id]?.name === "Work" &&
  portable.data.organizationMemberships[portableEdgeId]?.memberKey === "alpha",
"P11-14 Export carries group and membership tombstones through registry-owned maps");
const malformedPortable = structuredClone(portable);
malformedPortable.data.organizationMemberships[portableEdgeId].memberKey = "changed";
let malformedRejected = false;
try { await previewPortableRestore(JSON.stringify(malformedPortable)); }
catch { malformedRejected = true; }
check(malformedRejected,
  "P11-14 Restore rejects a membership whose deterministic id does not match its tuple");
const invalidSessionPortable = structuredClone(portable);
const validSessionEdgeId = organizationMembershipId("session", namedId, sessionsGroup.entry.id);
const invalidSessionEdgeId = organizationMembershipId("session", "not-a-uuid", sessionsGroup.entry.id);
invalidSessionPortable.data.organizationMemberships[invalidSessionEdgeId] = {
  ...invalidSessionPortable.data.organizationMemberships[validSessionEdgeId],
  id: invalidSessionEdgeId,
  memberKey: "not-a-uuid"
};
let invalidSessionRejected = false;
try { await previewPortableRestore(JSON.stringify(invalidSessionPortable)); }
catch { invalidSessionRejected = true; }
check(invalidSessionRejected,
  "P11-14 Restore requires a Session membership memberKey to be a UUID");

/* A Vault merge can retain two independently created same-name groups. The
 * read model must choose one deterministic visible identity and retain the
 * union without writing a repair during projection. */
const duplicateGroups = {
  [ID(6)]: meta(ID(6), { organizationKind: "label", name: "WORK", createdAt: T0 + 10 }),
  [ID(7)]: meta(ID(7), { organizationKind: "label", name: "work", createdAt: T0 }),
  [ID(8)]: meta(ID(8), { organizationKind: "label", name: "Work", createdAt: T0 })
};
const duplicateMemberships = {};
for (const [memberKey, groupId] of [["alpha", ID(6)], ["beta", ID(7)], ["gamma", ID(8)]]) {
  const id = organizationMembershipId("label", memberKey, groupId);
  duplicateMemberships[id] = meta(id, {
    organizationKind: "label", memberKey, groupId
  });
}
const writesBeforeConflictProjection = storage.setLog.length;
const conflictProjection = projectOrganization(
  "label",
  [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }],
  { groups: duplicateGroups, memberships: duplicateMemberships }
);
check(conflictProjection.groups.length === 1 && conflictProjection.groups[0].id === ID(7) &&
  conflictProjection.groups[0].aliasIds.join() === [ID(7), ID(8), ID(6)].join() &&
  conflictProjection.groups[0].memberKeys.join() === "alpha,beta,gamma",
"P11-14 duplicate-name Vault groups choose oldest then lexical id and union every alias membership");
check([...conflictProjection.groupIdsByMemberKey.values()].every((ids) =>
  ids.size === 1 && ids.has(ID(7))) && storage.setLog.length === writesBeforeConflictProjection,
"P11-14 duplicate aliases project through the canonical lens without a repair write");

let labelState = await readOrganizationState("label");
let projection = projectOrganization("label", [
  { label: "alpha", tabs: 1 }, { label: "beta", tabs: 1 }, { label: "beta", tabs: 2 }
], labelState);
check(projection.all.length === 2 && projection.ungrouped.map((entry) => entry.key).join() === "beta" &&
  projection.groups.find((group) => group.id === work.entry.id)?.memberKeys.join() === "alpha",
"P11-14 All dedupes members and missing membership projects to Ungrouped without writes");

/* Every public update/delete requires its caller's last projected freshness
 * token. Invalid boundaries must fail before even the device-id/storage read. */
const boundaryReads = storage.getLog.length;
const boundaryWrites = storage.setLog.length;
const invalidRevisionResults = [
  await renameOrganizationGroup("label", work.entry.id, undefined, "Missing revision"),
  await renameOrganizationGroup("label", work.entry.id, "not-a-revision", "Invalid revision"),
  await deleteOrganizationGroup("label", work.entry.id),
  await deleteOrganizationGroup("label", work.entry.id, "not-a-revision"),
  await replaceMemberGroups("label", "alpha", [work.entry.id]),
  await replaceMemberGroups("label", "alpha", [work.entry.id], "not-a-revision"),
  await replaceGroupMembers("label", work.entry.id, ["alpha"]),
  await replaceGroupMembers("label", work.entry.id, ["alpha"], "not-a-revision"),
  await deleteNamedSession(namedId),
  await deleteNamedSession(namedId, Infinity)
];
check(invalidRevisionResults.every((result) =>
  !result.ok && result.reason === "invalid-revision"),
"P11-14 every public mutator rejects missing and malformed freshness tokens");
check(storage.getLog.length === boundaryReads && storage.setLog.length === boundaryWrites,
"P11-14 invalid freshness tokens fail before every storage read and write");

let alphaRevision = projection.memberRevisionByKey.get("alpha");
const beforeConcurrentEdge = storage.snapshot();
const workEdgeId = organizationMembershipId("label", "alpha", work.entry.id);
const concurrentEdgeId = organizationMembershipId("label", "alpha", personal.entry.id);
beforeConcurrentEdge[STORE_KEYS.organizationMemberships][concurrentEdgeId] = meta(concurrentEdgeId, {
  organizationKind: "label", memberKey: "alpha", groupId: personal.entry.id,
  // Equal to the previously visible edge: a max(modifiedAt) revision cannot
  // distinguish this concurrent addition.
  modifiedAt: beforeConcurrentEdge[STORE_KEYS.organizationMemberships][workEdgeId].modifiedAt
});
await chrome.storage.local.set({
  [STORE_KEYS.organizationMemberships]: beforeConcurrentEdge[STORE_KEYS.organizationMemberships]
});
const staleConcurrentReplace = await replaceMemberGroups(
  "label", "alpha", [work.entry.id], alphaRevision
);
check(staleConcurrentReplace.reason === "stale" &&
  !storage.snapshot()[STORE_KEYS.organizationMemberships][concurrentEdgeId].deletedAt,
"P11-14 member revision fingerprints an equal-timestamp concurrent edge before replacement");

labelState = await readOrganizationState("label");
projection = projectOrganization("label", [{ label: "alpha" }, { label: "beta" }], labelState);
alphaRevision = projection.memberRevisionByKey.get("alpha");
const removedConcurrent = await replaceMemberGroups("label", "alpha", [work.entry.id], alphaRevision);
check(removedConcurrent.ok && (await replaceMemberGroups(
  "label", "alpha", [], alphaRevision
)).reason === "stale", "P11-14 member writes reject a stale opaque edge-set revision");

labelState = await readOrganizationState("label");
projection = projectOrganization("label", [{ label: "alpha" }, { label: "beta" }], labelState);
alphaRevision = projection.memberRevisionByKey.get("alpha");
let changed = await replaceMemberGroups(
  "label", "alpha", [work.entry.id, personal.entry.id], alphaRevision
);
check(changed.ok && changed.entry.groupIds.length === 2,
  "P11-14 one Label can belong to multiple groups");

labelState = await readOrganizationState("label");
const inlineProjection = projectOrganization("label", [{ label: "inline-member" }], labelState);
const inlineWrites = storage.setLog.length;
const inlineCreate = await replaceMemberGroups(
  "label", "inline-member", [work.entry.id],
  inlineProjection.memberRevisionByKey.get("inline-member"),
  { createNames: ["Inline group"] }
);
const inlineSnapshot = storage.snapshot();
const inlineGroup = inlineCreate.entry?.createdGroups?.[0];
const inlineEdgeId = organizationMembershipId("label", "inline-member", inlineGroup?.id);
check(inlineCreate.ok && inlineGroup?.name === "Inline group" &&
  inlineSnapshot[STORE_KEYS.organizationGroups][inlineGroup.id]?.name === "Inline group" &&
  !inlineSnapshot[STORE_KEYS.organizationMemberships][inlineEdgeId]?.deletedAt &&
  inlineCreate.entry.groupIds.includes(work.entry.id) &&
  inlineCreate.entry.groupIds.includes(inlineGroup.id) && storage.setLog.length === inlineWrites + 1,
"P11-14 tag-entry Apply creates new groups and complete membership in one atomic commit");

labelState = await readOrganizationState("label");
projection = projectOrganization("label", [{ label: "alpha" }, { label: "beta" }], labelState);
const personalView = projection.groups.find((group) => group.id === personal.entry.id);
changed = await replaceGroupMembers("label", personal.entry.id, ["beta"], personalView.revision);
labelState = await readOrganizationState("label");
projection = projectOrganization("label", [{ label: "alpha" }, { label: "beta" }], labelState);
check(changed.ok && projection.groupIdsByMemberKey.get("alpha")?.has(work.entry.id) &&
  !projection.groupIdsByMemberKey.get("alpha")?.has(personal.entry.id) &&
  projection.groupIdsByMemberKey.get("beta")?.has(personal.entry.id),
"P11-14 inverse group editing changes only that group and preserves other memberships");

const personalProjected = projection.groups.find((group) => group.id === personal.entry.id);
const deletedGroup = await deleteOrganizationGroup(
  "label", personal.entry.id, personalProjected.revision
);
labelState = await readOrganizationState("label");
projection = projectOrganization("label", [{ label: "alpha" }, { label: "beta" }], labelState);
check(deletedGroup.ok && deletedGroup.removedMemberships === 1 &&
  projection.ungrouped.some((entry) => entry.key === "beta") &&
  storage.snapshot()[STORE_KEYS.sessions][namedId].deletedAt === undefined,
"P11-14 deleting a group only removes its membership edges");

const workProjected = projection.groups.find((group) => group.id === work.entry.id);
check((await renameOrganizationGroup("label", work.entry.id, workProjected.revision, "Projects")).ok &&
  (await renameOrganizationGroup("label", work.entry.id, workProjected.revision, "Stale")).reason === "stale",
  "P11-14 group rename is expected-version guarded");

/* Label rename: carriers, recency, Archive fold, memberships and Undo inverse
 * share one locked commit. Rename-onto-existing takes the membership union. */
const inboxId = ID(3);
const archiveId = ID(4);
await chrome.storage.local.set({
  [STORE_KEYS.inbox]: {
    [inboxId]: meta(inboxId, {
      kind: "tab", source: "manual", labels: [],
      tabs: [{ url: "https://alpha.example", title: "Alpha", labels: ["alpha"] }]
    })
  },
  [STORE_KEYS.archive]: {},
  [ARCHIVE_OVERLAY_KEY]: {
    [archiveId]: meta(archiveId, {
      kind: "tab", source: "manual", labels: [], archivedAt: T0,
      tabs: [{ url: "https://saved.example", title: "Saved", labels: ["alpha"] }]
    })
  },
  labelMeta: { alpha: T0 + 1, unrelated: T0 + 2 }
});
storage.setLog.splice(0);
const renamedCount = await renameLabel("alpha", "beta");
const afterRename = storage.snapshot();
const oldEdgeId = organizationMembershipId("label", "alpha", work.entry.id);
const newEdgeId = organizationMembershipId("label", "beta", work.entry.id);
check(renamedCount === 2 && afterRename.labelMeta.unrelated === T0 + 2 &&
  afterRename.labelMeta.beta >= T0 + 1 && afterRename[STORE_KEYS.organizationMemberships][oldEdgeId].deletedAt &&
  !afterRename[STORE_KEYS.organizationMemberships][newEdgeId].deletedAt,
"P11-14 Label rename preserves unrelated recency and atomically migrates membership");
check(Object.keys(afterRename[ARCHIVE_OVERLAY_KEY]).length === 0 &&
  afterRename[STORE_KEYS.archive][archiveId].tabs[0].labels.includes("beta") &&
  storage.setLog.at(-1).includes(STORE_KEYS.organizationMemberships) &&
  storage.setLog.at(-1).includes("labelMeta") && storage.setLog.at(-1).includes("journal"),
"P11-14 Label rename folds Archive overlay and journals every changed domain in one set");

await deleteLabelEverywhere("beta");
const afterLabelDelete = storage.snapshot();
check(afterLabelDelete[STORE_KEYS.organizationMemberships][newEdgeId].deletedAt &&
  !afterLabelDelete[STORE_KEYS.inbox][inboxId].tabs[0].labels.includes("beta"),
"P11-14 Label deletion tombstones membership without deleting carriers");

/* Named Session deletion is one domain operation. */
const sessionProjection = projectOrganization(
  "session", [afterLabelDelete[STORE_KEYS.sessions][namedId]], await readOrganizationState("session")
);
const snapshotMove = await replaceMemberGroups("session", snapshotId, [], edgeA);
check(snapshotMove.reason === "snapshot", "P11-14 membership operations explicitly refuse Snapshots");
storage.setLog.splice(0);
const removedSession = await deleteNamedSession(
  namedId, afterLabelDelete[STORE_KEYS.sessions][namedId].modifiedAt
);
const afterSessionDelete = storage.snapshot();
const sessionEdgeId = organizationMembershipId("session", namedId, sessionsGroup.entry.id);
check(removedSession.ok && afterSessionDelete[STORE_KEYS.sessions][namedId].deletedAt &&
  afterSessionDelete[STORE_KEYS.organizationMemberships][sessionEdgeId].deletedAt &&
  storage.setLog.length === 1 && storage.setLog[0].includes(STORE_KEYS.sessions) &&
  storage.setLog[0].includes(STORE_KEYS.organizationMemberships) && storage.setLog[0].includes("journal"),
"P11-14 named-Session delete tombstones content and memberships in one atomic commit");
check(sessionProjection.groups[0].memberKeys.join() === namedId,
  "P11-14 Session projection contains named Sessions and excludes Snapshots");

/* Visible CRUD owns the complete duplicate-name alias lens. */
const aliasGroupRecords = {
  [ID(6)]: meta(ID(6), { organizationKind: "label", name: "CONFLICT", createdAt: T0 + 10 }),
  [ID(7)]: meta(ID(7), { organizationKind: "label", name: "conflict", createdAt: T0 }),
  [ID(8)]: meta(ID(8), { organizationKind: "label", name: "Conflict", createdAt: T0 })
};
const aliasMembers = [["alias-a", ID(6)], ["alias-b", ID(7)], ["alias-c", ID(8)]];
const aliasEdgeRecords = {};
for (const [memberKey, groupId] of aliasMembers) {
  const id = organizationMembershipId("label", memberKey, groupId);
  aliasEdgeRecords[id] = meta(id, { organizationKind: "label", memberKey, groupId });
}
const beforeAliasSeed = storage.snapshot();
await chrome.storage.local.set({
  [STORE_KEYS.organizationGroups]: {
    ...(beforeAliasSeed[STORE_KEYS.organizationGroups] ?? {}), ...aliasGroupRecords
  },
  [STORE_KEYS.organizationMemberships]: {
    ...(beforeAliasSeed[STORE_KEYS.organizationMemberships] ?? {}), ...aliasEdgeRecords
  }
});
const aliasMemberObjects = aliasMembers.map(([label]) => ({ label }));
let aliasProjection = projectOrganization(
  "label", aliasMemberObjects, await readOrganizationState("label")
);
let aliasLens = aliasProjection.groups.find((group) => group.id === ID(7));
const aliasReplace = await replaceGroupMembers("label", ID(7), ["alias-a"], aliasLens.revision);
let aliasSnapshot = storage.snapshot();
const aliasACanonicalId = organizationMembershipId("label", "alias-a", ID(7));
check(aliasReplace.ok && !aliasSnapshot[STORE_KEYS.organizationMemberships][aliasACanonicalId].deletedAt &&
  aliasSnapshot[STORE_KEYS.organizationMemberships][organizationMembershipId("label", "alias-a", ID(6))].deletedAt &&
  aliasSnapshot[STORE_KEYS.organizationMemberships][organizationMembershipId("label", "alias-b", ID(7))].deletedAt &&
  aliasSnapshot[STORE_KEYS.organizationMemberships][organizationMembershipId("label", "alias-c", ID(8))].deletedAt,
"P11-14 replacing members on a canonical lens normalizes desired edges and removes across every alias");
aliasProjection = projectOrganization("label", aliasMemberObjects, await readOrganizationState("label"));
aliasLens = aliasProjection.groups.find((group) => group.id === ID(7));
check(aliasLens.memberKeys.join() === "alias-a" &&
  aliasProjection.ungrouped.map((entry) => entry.key).join() === "alias-b,alias-c",
"P11-14 alias-wide member replacement leaves the visible lens exactly at the desired set");

const aliasRename = await renameOrganizationGroup(
  "label", ID(7), aliasLens.revision, "Consolidated"
);
aliasSnapshot = storage.snapshot();
check(aliasRename.ok && [ID(6), ID(7), ID(8)].every((id) =>
  aliasSnapshot[STORE_KEYS.organizationGroups][id].name === "Consolidated") &&
  aliasRename.journalEntry.puts.filter((put) => put.store === STORE_KEYS.organizationGroups).length === 3,
"P11-14 renaming the canonical lens renames and journals every hidden alias while preserving ids");

aliasProjection = projectOrganization("label", aliasMemberObjects, await readOrganizationState("label"));
aliasLens = aliasProjection.groups.find((group) => group.id === ID(7));
const aliasDelete = await deleteOrganizationGroup("label", ID(7), aliasLens.revision);
aliasSnapshot = storage.snapshot();
check(aliasDelete.ok && aliasDelete.removedGroups === 3 &&
  [ID(6), ID(7), ID(8)].every((id) => aliasSnapshot[STORE_KEYS.organizationGroups][id].deletedAt) &&
  aliasSnapshot[STORE_KEYS.organizationMemberships][aliasACanonicalId].deletedAt,
"P11-14 deleting the canonical lens tombstones every alias and all surviving alias edges");
aliasProjection = projectOrganization("label", aliasMemberObjects, await readOrganizationState("label"));
check(!aliasProjection.groups.some((group) => group.name.trim().toLowerCase() === "consolidated") &&
  aliasProjection.ungrouped.length === 3,
"P11-14 no hidden alias can reappear after canonical deletion");

/* Projection indexes same-kind edges once. This fixture is deliberately large
 * enough for the former per-member full-map scan to exceed the budget while
 * keeping the linear path comfortably below it on ordinary CI hardware. */
const PERF_MEMBER_COUNT = 4096;
const PERF_GROUP_COUNT = 64;
const perfGroups = {};
const perfMemberships = {};
const perfMembers = [];
const expectedFirstGroupMembers = [];
for (let groupIndex = 0; groupIndex < PERF_GROUP_COUNT; groupIndex++) {
  const groupId = ID(100 + groupIndex);
  perfGroups[groupId] = meta(groupId, {
    organizationKind: "label", name: `Scale ${String(groupIndex).padStart(2, "0")}`,
    createdAt: T0 + groupIndex, modifiedAt: T0 + groupIndex
  });
}
for (let memberIndex = 0; memberIndex < PERF_MEMBER_COUNT; memberIndex++) {
  const memberKey = `scale-${String(memberIndex).padStart(4, "0")}`;
  const groupId = ID(100 + (memberIndex % PERF_GROUP_COUNT));
  perfMembers.push({ label: memberKey, ordinal: memberIndex });
  if (memberIndex % PERF_GROUP_COUNT === 0) expectedFirstGroupMembers.push(memberKey);
  const edgeId = organizationMembershipId("label", memberKey, groupId);
  perfMemberships[edgeId] = meta(edgeId, {
    organizationKind: "label", memberKey, groupId,
    modifiedAt: T0 + memberIndex
  });
}
// Warm the JIT on the real shape without including it in the measurement.
projectOrganization("label", perfMembers.slice(0, 128), {
  groups: perfGroups, memberships: perfMemberships
});
const projectionTimes = [];
let scaleProjection;
for (let run = 0; run < 3; run++) {
  const startedAt = performance.now();
  scaleProjection = projectOrganization("label", perfMembers, {
    groups: perfGroups, memberships: perfMemberships
  });
  projectionTimes.push(performance.now() - startedAt);
}
projectionTimes.sort((a, b) => a - b);
const projectionMedianMs = projectionTimes[1];
const firstScaleGroup = scaleProjection.groups.find((group) => group.id === ID(100));
check(scaleProjection.all.length === PERF_MEMBER_COUNT && scaleProjection.ungrouped.length === 0 &&
  scaleProjection.groups.length === PERF_GROUP_COUNT &&
  firstScaleGroup.memberKeys.join() === expectedFirstGroupMembers.join() &&
  scaleProjection.all[0].member.ordinal === 0 &&
  scaleProjection.all.at(-1).member.ordinal === PERF_MEMBER_COUNT - 1 &&
  scaleProjection.memberRevisionByKey.get("scale-0000") === "657e5101-cee6-51e2-9cbb-ca82f0bc96aa" &&
  firstScaleGroup.revision === "acbe9c7b-c8da-521c-a70d-572f677e25b8",
"P11-14 indexed projection preserves exact member and group output at scale");
console.log(`  diagnostic: indexed ${PERF_MEMBER_COUNT} members/edges in ${projectionMedianMs.toFixed(2)}ms median`);
check(projectionMedianMs < 750,
  "P11-14 4,096-member projection stays within the 750ms linear-path budget");

if (failures) {
  console.error(`\n${failures} organization test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll organization tests passed");
