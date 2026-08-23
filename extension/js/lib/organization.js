/**
 * P11-14 organization domain.
 *
 * Label groups and Session groups are one-level navigation facets. They do not
 * contain tabs and they do not reuse `Session.groups` (saved Chrome tab-group
 * templates). Existing members need no migration: no live edge means the
 * projected Ungrouped bucket.
 */
import { SCHEMA_VERSION, STORE_KEYS } from "./types.js";
import { getDeviceId, mutateStores, newMeta, readStoreMap } from "./store.js";
import { JOURNAL_KEY, appendedJournal, makeJournalEntry } from "./journal.js";

export const ORGANIZATION_KINDS = Object.freeze(["label", "session"]);
export const ORGANIZATION_MEMBERSHIP_FORMAT = 1;
export const UNGROUPED_LENS = "ungrouped";
export const ALL_LENS = "all";

const RESERVED_GROUP_NAMES = new Set([UNGROUPED_LENS]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} kind @returns {kind is import("./types.js").OrganizationKind} */
export function isOrganizationKind(kind) {
  return ORGANIZATION_KINDS.includes(kind);
}

function cleanName(value) {
  return String(value ?? "").trim();
}

function cleanMemberKey(kind, value) {
  if (!isOrganizationKind(kind)) return "";
  const raw = String(value ?? "");
  if (!raw.trim()) return "";
  // Labels are identified by their exact stored string. Session ids are
  // machine identities and may safely reject accidental surrounding space.
  return kind === "label" ? raw : raw.trim();
}

function normalizedName(value) {
  return cleanName(value).toLowerCase();
}

function live(record) {
  return record && typeof record === "object" && !record.deletedAt;
}

function recordsOf(map, predicate) {
  return Object.values(map ?? {}).filter((record) => record && predicate(record));
}

function revisionOf(records) {
  return records.reduce((max, record) => Math.max(max, Number(record?.modifiedAt) || 0), 0);
}

function nextTime(records = []) {
  return Math.max(Date.now(), revisionOf(records) + 1);
}

/* cyrb128 produces four stable 32-bit words synchronously. Record identity is
 * not a security boundary; this gives the tuple a deterministic 128-bit name
 * while keeping the zero-build browser module synchronous and Unicode-stable. */
function hash128(value) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function wordsToUuid(words) {
  const bytes = [];
  for (const word of words) {
    bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID v5-shaped deterministic name
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable identity shared by every device for one logical membership edge. */
export function organizationMembershipId(kind, memberKey, groupId) {
  const tuple = JSON.stringify([
    ORGANIZATION_MEMBERSHIP_FORMAT,
    String(kind ?? ""),
    String(memberKey ?? ""),
    String(groupId ?? "")
  ]);
  return wordsToUuid(hash128(tuple));
}

function edgeFor(existing, kind, memberKey, groupId, deviceId, now) {
  const id = organizationMembershipId(kind, memberKey, groupId);
  const { deletedAt: _deletedAt, ...prior } = existing ?? {};
  return {
    ...prior,
    id,
    deviceId,
    createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
    modifiedAt: now,
    schemaVersion: SCHEMA_VERSION,
    organizationKind: kind,
    memberKey,
    groupId
  };
}

function tombstone(record, now) {
  return { ...record, deletedAt: now, modifiedAt: now };
}

function failure(reason, entry = null) {
  return { ok: false, reason, entry };
}

function success(reason, entry, extra = {}) {
  return { ok: true, reason, entry, ...extra };
}

function groupRecords(map, kind) {
  return recordsOf(map, (record) => record.organizationKind === kind);
}

function membershipRecords(map, kind) {
  return recordsOf(map, (record) => record.organizationKind === kind);
}

/** One same-kind pass shared by projection's member and group views. */
function indexMemberships(map, kind) {
  const records = [];
  const edgesByMemberKey = new Map();
  const edgesByGroupId = new Map();
  for (const edge of Object.values(map ?? {})) {
    if (!edge || edge.organizationKind !== kind) continue;
    records.push(edge);
    const memberEdges = edgesByMemberKey.get(edge.memberKey) ?? [];
    memberEdges.push(edge);
    edgesByMemberKey.set(edge.memberKey, memberEdges);
    const groupEdges = edgesByGroupId.get(edge.groupId) ?? [];
    groupEdges.push(edge);
    edgesByGroupId.set(edge.groupId, groupEdges);
  }
  return { records, edgesByMemberKey, edgesByGroupId };
}

function findDuplicateGroup(map, kind, name, exceptId = "") {
  const normalized = normalizedName(name);
  return groupRecords(map, kind).find((group) =>
    live(group) && group.id !== exceptId && normalizedName(group.name) === normalized) ?? null;
}

function validGroupIds(map, kind) {
  return new Set(groupRecords(map, kind).filter(live).map((group) => group.id));
}

function memberRevisionFromEdges(edges = []) {
  const edgeParts = edges
    .map((edge) => [edge.id, edge.modifiedAt, edge.deletedAt ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return wordsToUuid(hash128(JSON.stringify(edgeParts)));
}

function memberRevision(map, kind, memberKey) {
  return memberRevisionFromEdges(indexMemberships(map, kind).edgesByMemberKey.get(memberKey));
}

function canonicalGroupOrder(a, b) {
  const aCreated = Number.isFinite(a?.createdAt) ? a.createdAt : Infinity;
  const bCreated = Number.isFinite(b?.createdAt) ? b.createdAt : Infinity;
  return aCreated - bCreated || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function aliasGroupsFor(map, kind, group) {
  if (!live(group) || group.organizationKind !== kind) return [];
  const name = normalizedName(group.name);
  return groupRecords(map, kind)
    .filter((candidate) => live(candidate) && normalizedName(candidate.name) === name)
    .sort(canonicalGroupOrder);
}

/** Opaque stale token for the complete visible lens, including hidden aliases. */
function projectedGroupRevisionFromIndex(groups, edgesByGroupId) {
  const groupParts = groups.map((group) => [
    group.id, group.createdAt, group.modifiedAt, group.deletedAt ?? null
  ]);
  const edgeParts = groups
    .flatMap((group) => edgesByGroupId.get(group.id) ?? [])
    .map((edge) => [edge.id, edge.modifiedAt, edge.deletedAt ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return wordsToUuid(hash128(JSON.stringify([groupParts, edgeParts])));
}

function projectedGroupRevision(groups, memberships) {
  return projectedGroupRevisionFromIndex(
    groups,
    indexMemberships(memberships, groups[0]?.organizationKind).edgesByGroupId
  );
}

function validRevisionToken(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function validDesiredIds(value) {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
}

function uniqueStrings(value) {
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function uniqueMemberKeys(kind, value) {
  return [...new Set(value.map((item) => cleanMemberKey(kind, item)).filter(Boolean))];
}

function inverseFromChanges(changes) {
  return {
    puts: changes.filter((change) => change.before).map((change) => ({
      store: STORE_KEYS.organizationMemberships,
      item: change.before
    })),
    dels: changes.filter((change) => !change.before).map((change) => ({
      store: STORE_KEYS.organizationMemberships,
      id: change.after.id
    }))
  };
}

function replaceMemberEdges(map, kind, memberKey, desiredGroupIds, deviceId, now) {
  const next = { ...(map ?? {}) };
  const desired = new Set(desiredGroupIds);
  const changes = [];
  for (const edge of membershipRecords(map, kind)) {
    if (edge.memberKey !== memberKey || !live(edge) || desired.has(edge.groupId)) continue;
    const after = tombstone(edge, now);
    next[edge.id] = after;
    changes.push({ before: edge, after });
  }
  for (const groupId of desired) {
    const id = organizationMembershipId(kind, memberKey, groupId);
    const before = next[id];
    if (live(before) && before.organizationKind === kind &&
        before.memberKey === memberKey && before.groupId === groupId) continue;
    const after = edgeFor(before, kind, memberKey, groupId, deviceId, now);
    next[id] = after;
    changes.push({ before: before ?? null, after });
  }
  return { map: next, changes, inverse: inverseFromChanges(changes) };
}

/**
 * Pure label-identity migration used in the same commit as carrier rename.
 * Zero-to-many membership means rename-onto-existing takes the set union.
 */
export function renameLabelOrganizationMemberships(map, from, to, { now, deviceId }) {
  const source = cleanMemberKey("label", from);
  const target = cleanMemberKey("label", to);
  const next = { ...(map ?? {}) };
  const changes = [];
  if (!source || !target || source === target) return { map: next, changes, inverse: inverseFromChanges(changes) };

  for (const edge of membershipRecords(map, "label")) {
    if (!live(edge) || edge.memberKey !== source) continue;
    const sourceAfter = tombstone(edge, now);
    next[edge.id] = sourceAfter;
    changes.push({ before: edge, after: sourceAfter });

    const targetId = organizationMembershipId("label", target, edge.groupId);
    const targetBefore = next[targetId];
    if (live(targetBefore)) continue;
    const targetAfter = edgeFor(targetBefore, "label", target, edge.groupId, deviceId, now);
    next[targetId] = targetAfter;
    changes.push({ before: targetBefore ?? null, after: targetAfter });
  }
  return { map: next, changes, inverse: inverseFromChanges(changes) };
}

/** Pure tombstoning helper used when a Label or named Session is deleted. */
export function deleteOrganizationMembershipsForMember(map, kind, memberKey, { now }) {
  const key = cleanMemberKey(kind, memberKey);
  const next = { ...(map ?? {}) };
  const changes = [];
  if (!key) return { map: next, changes, inverse: inverseFromChanges(changes) };
  for (const edge of membershipRecords(map, kind)) {
    if (!live(edge) || edge.memberKey !== key) continue;
    const after = tombstone(edge, now);
    next[edge.id] = after;
    changes.push({ before: edge, after });
  }
  return { map: next, changes, inverse: inverseFromChanges(changes) };
}

/** Read both portable maps without creating any migration records. */
export async function readOrganizationState(kind) {
  if (!isOrganizationKind(kind)) return { kind, groups: {}, memberships: {} };
  const [groups, memberships] = await Promise.all([
    readStoreMap(STORE_KEYS.organizationGroups),
    readStoreMap(STORE_KEYS.organizationMemberships)
  ]);
  return {
    kind,
    groups: Object.fromEntries(Object.entries(groups).filter(([, group]) => group?.organizationKind === kind)),
    memberships: Object.fromEntries(Object.entries(memberships).filter(([, edge]) => edge?.organizationKind === kind))
  };
}

function defaultMemberKey(kind, member) {
  if (kind === "label") return cleanMemberKey(kind, typeof member === "string" ? member : member?.label);
  return cleanMemberKey(kind, member?.id);
}

/**
 * Pure one-lens projection. All is deduped by member identity; Ungrouped is
 * absence of a live edge to a live same-kind group. Orphans and wrong-kind
 * records are ignored, and automatic Snapshots never enter Session grouping.
 */
export function projectOrganization(kind, members, state, { memberKey } = {}) {
  const empty = {
    kind, groups: [], all: [], ungrouped: [], groupById: new Map(),
    memberByKey: new Map(), membersByGroupId: new Map(),
    groupIdsByMemberKey: new Map(), memberRevisionByKey: new Map(),
    groupRevisionById: new Map(), aliasToGroupId: new Map()
  };
  if (!isOrganizationKind(kind) || !Array.isArray(members)) return empty;
  const groupsMap = state?.groups ?? {};
  const membershipsMap = state?.memberships ?? {};
  const liveGroups = groupRecords(groupsMap, kind).filter(live);
  const duplicateBuckets = new Map();
  for (const group of liveGroups) {
    const key = normalizedName(group.name);
    const bucket = duplicateBuckets.get(key) ?? [];
    bucket.push(group);
    duplicateBuckets.set(key, bucket);
  }
  const aliasesByGroupId = new Map();
  const aliasToGroupId = new Map();
  const groups = [];
  for (const bucket of duplicateBuckets.values()) {
    bucket.sort(canonicalGroupOrder);
    const canonical = bucket[0];
    const aliasIds = bucket.map((group) => group.id);
    groups.push(canonical);
    aliasesByGroupId.set(canonical.id, aliasIds);
    for (const aliasId of aliasIds) aliasToGroupId.set(aliasId, canonical.id);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const membersByGroupId = new Map(groups.map((group) => [group.id, []]));
  const groupIdsByMemberKey = new Map();
  const membershipIndex = indexMemberships(membershipsMap, kind);
  for (const edge of membershipIndex.records) {
    const visibleGroupId = aliasToGroupId.get(edge.groupId);
    if (!live(edge) || !visibleGroupId) continue;
    const set = groupIdsByMemberKey.get(edge.memberKey) ?? new Set();
    set.add(visibleGroupId);
    groupIdsByMemberKey.set(edge.memberKey, set);
  }
  const groupOrder = new Map(groups.map((group, index) => [group.id, index]));

  const memberByKey = new Map();
  const all = [];
  const ungrouped = [];
  const memberRevisionByKey = new Map();
  for (const member of members) {
    if (kind === "session" && member?.auto) continue;
    const key = cleanMemberKey(kind, memberKey ? memberKey(member) : defaultMemberKey(kind, member));
    if (!key || memberByKey.has(key)) continue;
    const groupIds = [...(groupIdsByMemberKey.get(key) ?? [])]
      .sort((a, b) => (groupOrder.get(a) ?? 0) - (groupOrder.get(b) ?? 0));
    const view = {
      key,
      member,
      groupIds,
      revision: memberRevisionFromEdges(membershipIndex.edgesByMemberKey.get(key))
    };
    memberByKey.set(key, view);
    memberRevisionByKey.set(key, view.revision);
    all.push(view);
    if (groupIds.length === 0) ungrouped.push(view);
    for (const groupId of groupIds) membersByGroupId.get(groupId)?.push(view);
  }

  const groupRevisionById = new Map();
  const projectedGroups = groups.map((group) => {
    const aliasIds = aliasesByGroupId.get(group.id) ?? [group.id];
    const revision = projectedGroupRevisionFromIndex(
      aliasIds.map((id) => groupsMap[id]).filter(Boolean), membershipIndex.edgesByGroupId
    );
    groupRevisionById.set(group.id, revision);
    const projectedMembers = membersByGroupId.get(group.id) ?? [];
    return {
      id: group.id,
      name: group.name,
      group,
      aliasIds,
      members: projectedMembers,
      memberKeys: projectedMembers.map((entry) => entry.key),
      revision
    };
  });
  return {
    kind, groups: projectedGroups, all, ungrouped, groupById, memberByKey,
    membersByGroupId, groupIdsByMemberKey, memberRevisionByKey, groupRevisionById,
    aliasToGroupId
  };
}

export async function createOrganizationGroup(kind, name, memberKeys = []) {
  if (!isOrganizationKind(kind)) return failure("invalid-kind");
  const clean = cleanName(name);
  if (!clean) return failure("invalid-name");
  if (RESERVED_GROUP_NAMES.has(normalizedName(clean))) return failure("reserved-name");
  if (!Array.isArray(memberKeys)) return failure("invalid-members");
  const desiredMembers = uniqueMemberKeys(kind, memberKeys);

  const meta = await newMeta();
  const group = { ...meta, organizationKind: kind, name: clean };
  let out = failure("not-committed");
  const keys = [STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, JOURNAL_KEY];
  if (kind === "session") keys.push(STORE_KEYS.sessions);
  await mutateStores(keys, (maps) => {
    const groups = maps[STORE_KEYS.organizationGroups] ?? {};
    if (kind === "session" && desiredMembers.some((id) => {
      const session = maps[STORE_KEYS.sessions]?.[id];
      return !live(session) || session.auto;
    })) {
      out = failure("invalid-members");
      return null;
    }
    if (findDuplicateGroup(groups, kind, clean)) {
      out = failure("duplicate-name");
      return null;
    }
    const now = nextTime([...Object.values(groups), ...Object.values(maps[STORE_KEYS.organizationMemberships] ?? {})]);
    const createdGroup = { ...group, createdAt: now, modifiedAt: now };
    const memberships = { ...(maps[STORE_KEYS.organizationMemberships] ?? {}) };
    const createdEdges = [];
    for (const memberKey of desiredMembers) {
      const edge = edgeFor(null, kind, memberKey, createdGroup.id, createdGroup.deviceId, now);
      memberships[edge.id] = edge;
      createdEdges.push(edge);
    }
    const entry = makeJournalEntry(`Created ${kind} group “${clean}”`, {
      dels: [
        { store: STORE_KEYS.organizationGroups, id: createdGroup.id },
        ...createdEdges.map((edge) => ({ store: STORE_KEYS.organizationMemberships, id: edge.id }))
      ]
    });
    out = success("created", createdGroup, { journalEntry: entry });
    return {
      [STORE_KEYS.organizationGroups]: { ...groups, [createdGroup.id]: createdGroup },
      [STORE_KEYS.organizationMemberships]: memberships,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

export async function renameOrganizationGroup(kind, groupId, expectedGroupRevision, name) {
  if (!isOrganizationKind(kind)) return failure("invalid-kind");
  const clean = cleanName(name);
  if (!clean) return failure("invalid-name");
  if (RESERVED_GROUP_NAMES.has(normalizedName(clean))) return failure("reserved-name");
  if (!validRevisionToken(expectedGroupRevision)) return failure("invalid-revision");
  let out = failure("not-found");
  await mutateStores([
    STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, JOURNAL_KEY
  ], (maps) => {
    const groups = maps[STORE_KEYS.organizationGroups] ?? {};
    const before = groups[groupId];
    if (!live(before) || before.organizationKind !== kind) return null;
    const memberships = maps[STORE_KEYS.organizationMemberships] ?? {};
    const aliases = aliasGroupsFor(groups, kind, before);
    const revision = projectedGroupRevision(aliases, memberships);
    if (aliases[0]?.id !== groupId || expectedGroupRevision !== revision) {
      out = failure("stale", { groupId: aliases[0]?.id ?? groupId, revision });
      return null;
    }
    const aliasIds = new Set(aliases.map((group) => group.id));
    const duplicate = groupRecords(groups, kind).find((group) =>
      live(group) && !aliasIds.has(group.id) && normalizedName(group.name) === normalizedName(clean));
    if (duplicate) {
      out = failure("duplicate-name", before);
      return null;
    }
    if (aliases.every((group) => group.name === clean)) {
      out = success("unchanged", before, { aliasIds: [...aliasIds], revision });
      return null;
    }
    const relatedEdges = Object.values(memberships)
      .filter((edge) => aliasIds.has(edge?.groupId));
    const now = nextTime([...aliases, ...relatedEdges]);
    const nextGroups = { ...groups };
    for (const group of aliases) {
      nextGroups[group.id] = { ...group, name: clean, modifiedAt: now };
    }
    const after = nextGroups[groupId];
    const entry = makeJournalEntry(`Renamed ${kind} group to “${clean}”`, {
      puts: aliases.map((group) => ({ store: STORE_KEYS.organizationGroups, item: group }))
    });
    out = success("renamed", after, {
      aliasIds: [...aliasIds],
      revision: projectedGroupRevision(aliases.map((group) => nextGroups[group.id]), memberships),
      journalEntry: entry
    });
    return {
      [STORE_KEYS.organizationGroups]: nextGroups,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

export async function deleteOrganizationGroup(kind, groupId, expectedGroupRevision) {
  if (!isOrganizationKind(kind)) return failure("invalid-kind");
  if (!validRevisionToken(expectedGroupRevision)) return failure("invalid-revision");
  let out = failure("not-found");
  await mutateStores([
    STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, JOURNAL_KEY
  ], (maps) => {
    const groups = maps[STORE_KEYS.organizationGroups] ?? {};
    const before = groups[groupId];
    if (!live(before) || before.organizationKind !== kind) return null;
    const memberships = maps[STORE_KEYS.organizationMemberships] ?? {};
    const aliases = aliasGroupsFor(groups, kind, before);
    const revision = projectedGroupRevision(aliases, memberships);
    if (aliases[0]?.id !== groupId || expectedGroupRevision !== revision) {
      out = failure("stale", { groupId: aliases[0]?.id ?? groupId, revision });
      return null;
    }
    const aliasIds = new Set(aliases.map((group) => group.id));
    const affected = membershipRecords(memberships, kind)
      .filter((edge) => live(edge) && aliasIds.has(edge.groupId));
    const now = nextTime([...aliases, ...affected]);
    const after = tombstone(before, now);
    const nextGroups = { ...groups };
    for (const group of aliases) nextGroups[group.id] = tombstone(group, now);
    const nextMemberships = { ...memberships };
    for (const edge of affected) nextMemberships[edge.id] = tombstone(edge, now);
    const entry = makeJournalEntry(`Deleted ${kind} group “${before.name}”`, {
      puts: [
        ...aliases.map((group) => ({ store: STORE_KEYS.organizationGroups, item: group })),
        ...affected.map((edge) => ({ store: STORE_KEYS.organizationMemberships, item: edge }))
      ]
    });
    out = success("deleted", after, {
      journalEntry: entry,
      removedGroups: aliases.length,
      removedMemberships: affected.length
    });
    return {
      [STORE_KEYS.organizationGroups]: nextGroups,
      [STORE_KEYS.organizationMemberships]: nextMemberships,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

export async function replaceMemberGroups(kind, memberKey, desiredGroupIds, expectedMemberRevision,
  { createNames: requestedCreateNames = [] } = {}) {
  if (!isOrganizationKind(kind)) return failure("invalid-kind");
  const key = cleanMemberKey(kind, memberKey);
  if (!key) return failure("invalid-member");
  if (!validDesiredIds(desiredGroupIds)) return failure("invalid-groups");
  if (!validRevisionToken(expectedMemberRevision)) return failure("invalid-revision");
  if (!Array.isArray(requestedCreateNames)) return failure("invalid-name");
  const createNames = requestedCreateNames.map(cleanName);
  if (createNames.some((name) => !name)) return failure("invalid-name");
  if (createNames.some((name) => RESERVED_GROUP_NAMES.has(normalizedName(name)))) {
    return failure("reserved-name");
  }
  if (new Set(createNames.map(normalizedName)).size !== createNames.length) {
    return failure("duplicate-name");
  }
  const requested = uniqueStrings(desiredGroupIds);
  const deviceId = await getDeviceId();
  const createMetas = await Promise.all(createNames.map(() => newMeta()));
  let out = failure("not-committed");
  const keys = [STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, JOURNAL_KEY];
  if (kind === "session") keys.push(STORE_KEYS.sessions);
  await mutateStores(keys, (maps) => {
    if (kind === "session") {
      const session = maps[STORE_KEYS.sessions]?.[key];
      if (!live(session) || session.auto) {
        out = failure(session?.auto ? "snapshot" : "invalid-member");
        return null;
      }
    }
    const groups = maps[STORE_KEYS.organizationGroups] ?? {};
    const duplicateName = createNames.find((name) => findDuplicateGroup(groups, kind, name));
    if (duplicateName) {
      out = failure("duplicate-name");
      return null;
    }
    const valid = validGroupIds(groups, kind);
    if (requested.some((id) => !valid.has(id))) {
      out = failure("invalid-groups");
      return null;
    }
    const memberships = maps[STORE_KEYS.organizationMemberships] ?? {};
    const revision = memberRevision(memberships, kind, key);
    if (expectedMemberRevision !== revision) {
      out = failure("stale", { memberKey: key, revision });
      return null;
    }
    const related = membershipRecords(memberships, kind).filter((edge) => edge.memberKey === key);
    const now = nextTime([...Object.values(groups), ...Object.values(memberships)]);
    const createdGroups = createMetas.map((meta, index) => ({
      ...meta,
      organizationKind: kind,
      name: createNames[index],
      createdAt: now + index,
      modifiedAt: now + index
    }));
    const desired = [...requested, ...createdGroups.map((group) => group.id)];
    const changed = replaceMemberEdges(memberships, kind, key, desired, deviceId, now);
    if (changed.changes.length === 0 && createdGroups.length === 0) {
      out = success("unchanged", { memberKey: key, groupIds: desired, revision });
      return null;
    }
    const inverse = changed.inverse;
    inverse.dels = [
      ...(inverse.dels ?? []),
      ...createdGroups.map((group) => ({ store: STORE_KEYS.organizationGroups, id: group.id }))
    ];
    const entry = makeJournalEntry(`Updated groups for ${kind} “${key}”`, inverse);
    const nextRevision = memberRevision(changed.map, kind, key);
    const nextGroups = createdGroups.length === 0 ? groups : {
      ...groups,
      ...Object.fromEntries(createdGroups.map((group) => [group.id, group]))
    };
    out = success("updated", {
      memberKey: key, groupIds: desired, revision: nextRevision, createdGroups
    }, { journalEntry: entry });
    return {
      ...(createdGroups.length > 0 ? { [STORE_KEYS.organizationGroups]: nextGroups } : {}),
      [STORE_KEYS.organizationMemberships]: changed.map,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

export async function replaceGroupMembers(kind, groupId, desiredMemberKeys, expectedGroupRevision) {
  if (!isOrganizationKind(kind)) return failure("invalid-kind");
  if (!Array.isArray(desiredMemberKeys)) return failure("invalid-members");
  if (!validRevisionToken(expectedGroupRevision)) return failure("invalid-revision");
  const desired = uniqueMemberKeys(kind, desiredMemberKeys);
  const deviceId = await getDeviceId();
  let out = failure("not-found");
  const keys = [STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, JOURNAL_KEY];
  if (kind === "session") keys.push(STORE_KEYS.sessions);
  await mutateStores(keys, (maps) => {
    const groups = maps[STORE_KEYS.organizationGroups] ?? {};
    const group = groups[groupId];
    if (!live(group) || group.organizationKind !== kind) return null;
    if (kind === "session" && desired.some((id) => {
      const session = maps[STORE_KEYS.sessions]?.[id];
      return !live(session) || session.auto;
    })) {
      out = failure("invalid-members", group);
      return null;
    }
    const memberships = maps[STORE_KEYS.organizationMemberships] ?? {};
    const aliases = aliasGroupsFor(groups, kind, group);
    const revision = projectedGroupRevision(aliases, memberships);
    if (aliases[0]?.id !== groupId || expectedGroupRevision !== revision) {
      out = failure("stale", { groupId: aliases[0]?.id ?? groupId, revision });
      return null;
    }
    const aliasIds = new Set(aliases.map((alias) => alias.id));
    const desiredSet = new Set(desired);
    const relatedEdges = membershipRecords(memberships, kind)
      .filter((edge) => aliasIds.has(edge.groupId));
    const now = nextTime([...aliases, ...relatedEdges]);
    const next = { ...memberships };
    const allChanges = [];
    // An explicit edit of the visible lens is also a safe normalization point:
    // desired members live on the canonical edge, and every hidden-alias edge
    // is tombstoned. No unrelated group's membership is touched.
    for (const edge of relatedEdges) {
      if (!live(edge)) continue;
      if (edge.groupId === groupId && desiredSet.has(edge.memberKey)) continue;
      const after = tombstone(edge, now);
      next[edge.id] = after;
      allChanges.push({ before: edge, after });
    }
    for (const memberKey of desired) {
      const id = organizationMembershipId(kind, memberKey, groupId);
      const before = next[id];
      if (live(before) && before.organizationKind === kind &&
          before.memberKey === memberKey && before.groupId === groupId) continue;
      const after = edgeFor(before, kind, memberKey, groupId, deviceId, now);
      next[id] = after;
      allChanges.push({ before: before ?? null, after });
    }
    if (allChanges.length === 0) {
      out = success("unchanged", { groupId, memberKeys: desired, revision }, {
        aliasIds: [...aliasIds]
      });
      return null;
    }
    const inverse = inverseFromChanges(allChanges);
    const entry = makeJournalEntry(`Updated members in ${kind} group “${group.name}”`, inverse);
    const nextRevision = projectedGroupRevision(aliases, next);
    out = success("updated", { groupId, memberKeys: desired, revision: nextRevision }, {
      aliasIds: [...aliasIds], journalEntry: entry
    });
    return {
      [STORE_KEYS.organizationMemberships]: next,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}

/** Atomic named-Session deletion including every organization membership edge. */
export async function deleteNamedSession(sessionId, expectedModifiedAt) {
  const id = cleanMemberKey("session", sessionId);
  if (!id) return failure("invalid-member");
  if (typeof expectedModifiedAt !== "number" || !Number.isFinite(expectedModifiedAt)) {
    return failure("invalid-revision");
  }
  let out = failure("not-found");
  await mutateStores([
    STORE_KEYS.sessions, STORE_KEYS.organizationMemberships, JOURNAL_KEY
  ], (maps) => {
    const sessions = maps[STORE_KEYS.sessions] ?? {};
    const before = sessions[id];
    if (!live(before)) return null;
    if (before.auto) {
      out = failure("snapshot", before);
      return null;
    }
    if (expectedModifiedAt !== before.modifiedAt) {
      out = failure("stale", before);
      return null;
    }
    const memberships = maps[STORE_KEYS.organizationMemberships] ?? {};
    const affected = deleteOrganizationMembershipsForMember(memberships, "session", id, {
      now: nextTime([before, ...membershipRecords(memberships, "session").filter((edge) => edge.memberKey === id)])
    });
    const now = affected.changes[0]?.after.modifiedAt ?? nextTime([before]);
    const after = tombstone(before, now);
    const entry = makeJournalEntry(`Deleted session “${before.name}”`, {
      puts: [
        { store: STORE_KEYS.sessions, item: before },
        ...affected.inverse.puts
      ],
      dels: affected.inverse.dels
    });
    out = success("deleted", after, { journalEntry: entry });
    return {
      [STORE_KEYS.sessions]: { ...sessions, [id]: after },
      [STORE_KEYS.organizationMemberships]: affected.map,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return out;
}
