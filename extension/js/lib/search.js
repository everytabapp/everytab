import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "./types.js";
import { listItems, readFreshStoreMap, readStoreMap } from "./store.js";
import { tabLabels } from "./labels.js";
import { canonicalRef } from "./tabs.js";
import { normalizeUrl } from "./dedup.js";
import { projectOrganization } from "./organization.js";
import { domainKeyOf } from "./organize.js";
import {
  SESSION_IDENTITY_INDEX_KEY, isSessionIdentityIndex
} from "./session-identity-index.js";

/**
 * @typedef {Object} SearchResult
 * @property {"open"|"starred"|"inbox"|"snoozed"|"archive"|"collection"|"session"|"session-entity"|"label-group-entity"|"session-group-entity"|"history"} type
 * @property {string} title
 * @property {string} [url]
 * @property {string} [sourceName]
 * @property {number} [sourceCreatedAt]
 * @property {boolean} [snapshot]
 * @property {number} [tabId]
 * @property {number} [windowId]
 * @property {string} [sessionId]
 * @property {number} [windowCount]
 * @property {number} [tabCount]
 * @property {string} [groupId]
 * @property {"label"|"session"} [organizationKind]
 * @property {number} [memberCount]
 * @property {number} [lastVisitTime]
 */

/**
 * @typedef {Object} SearchScope
 * @property {"in"|"label"|"session"|"domain"} type
 * @property {string} value
 */

/**
 * @typedef {Object} SearchCandidate
 * @property {SearchResult} result
 * @property {string[]} labels
 * @property {string} titleText
 * @property {string} urlText
 * @property {string[]} labelText
 * @property {string} wordStartTitleText
 */

/**
 * @typedef {Object} SearchSnapshot
 * @property {Record<string, SearchCandidate[]>} sources
 * @property {{label: string, tabs: number}[]} labelCounts
 * @property {string[]} sessionNames
 * @property {{domain: string, tabs: number}[]} domainCounts
 * @property {SearchResult[]} sessionEntities
 * @property {SearchResult[]} organizationEntities
 */

const URL_RESULT_TYPES = new Set([
  "starred", "inbox", "snoozed", "archive", "collection", "session", "history"
]);

/** Search's saved sources. A change to any one invalidates the interaction snapshot. */
export const SEARCH_STORE_KEYS = Object.freeze([
  STORE_KEYS.inbox,
  STORE_KEYS.snoozes,
  STORE_KEYS.archive,
  STORE_KEYS.collections,
  STORE_KEYS.sessions,
  STORE_KEYS.starred,
  STORE_KEYS.organizationGroups,
  STORE_KEYS.organizationMemberships
]);
const SEARCH_STORE_KEY_SET = new Set([
  ...SEARCH_STORE_KEYS, ARCHIVE_OVERLAY_KEY, SESSION_IDENTITY_INDEX_KEY
]);

/** E3-5 / B8: measured from the input event to query start. */
export const SEARCH_DEBOUNCE_MS = 90;

/**
 * F14/F20 seam: map a search result to the existing background message that opens it.
 * @param {SearchResult|unknown} result
 * @returns {{type:"focus-tab", tabId:number, windowId:number}|
 *   {type:"open-url"|"activate-starred", url:string}|
 *   {type:"restore-session", sessionId:string}|
 *   {type:"open-organization-group", organizationKind:"label"|"session", groupId:string}|null}
 */
export function searchResultTarget(result) {
  if (!result || typeof result !== "object") return null;
  if (result.type === "open") {
    if (!Number.isInteger(result.tabId) || !Number.isInteger(result.windowId)) return null;
    return { type: "focus-tab", tabId: result.tabId, windowId: result.windowId };
  }
  if (result.type === "session-entity") {
    if (typeof result.sessionId !== "string" || !result.sessionId.trim()) return null;
    return { type: "restore-session", sessionId: result.sessionId };
  }
  if (result.type === "label-group-entity" || result.type === "session-group-entity") {
    const organizationKind = result.type === "label-group-entity" ? "label" : "session";
    if (result.organizationKind !== organizationKind ||
        typeof result.groupId !== "string" || !result.groupId.trim()) return null;
    return { type: "open-organization-group", organizationKind, groupId: result.groupId };
  }
  if (!URL_RESULT_TYPES.has(result.type) ||
      typeof result.url !== "string" || !result.url.trim()) return null;
  if (result.type === "starred") return { type: "activate-starred", url: result.url };
  return { type: "open-url", url: result.url };
}

export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const HISTORY_FETCH_LIMIT = 20;
export const HISTORY_UNSCOPED_LIMIT = 5;

/** S4 — the source ids an `in:` scope can name. */
export const IN_SCOPES = ["open", "starred", "inbox", "snoozed", "archive", "sessions", "history"];

/**
 * Parse a leading in:/label:/session:/domain: token without reading.
 * @param {string} raw
 */
export function parseScope(raw) {
  const s = String(raw ?? "");
  const m = s.match(/^\s*(in|label|session|domain):(\S+)\s*(.*)$/i);
  if (!m) return { type: null, value: "", query: s };
  const kind = m[1].toLowerCase();
  const value = m[2];
  const rest = m[3] ?? "";
  if (kind === "in") {
    if (IN_SCOPES.includes(value.toLowerCase())) {
      return { type: "in", value: value.toLowerCase(), query: rest };
    }
    return { type: null, value: "", query: s };
  }
  return { type: kind, value, query: rest };
}

function candidate(result, labels = []) {
  const cleanLabels = [...new Set(labels ?? [])];
  return {
    result,
    labels: cleanLabels,
    titleText: (result.title ?? "").toLowerCase(),
    urlText: (result.url ?? "").toLowerCase(),
    labelText: cleanLabels.map((label) => label.toLowerCase()),
    // Result titles deliberately fall back to URLs for presentation. Keep a
    // separate title-only field so the one-character navigation pass never
    // turns a URL prefix into a result.
    wordStartTitleText: result.title === result.url ? "" : (result.title ?? "").toLowerCase()
  };
}

/**
 * Pure snapshot normalization. This is the one source-assembly seam shared by
 * UI interaction sessions and one-shot callers such as the omnibox worker.
 * @param {{
 *   openTabs?: any[], starred?: any[], inbox?: any[], snoozes?: any[], archive?: any[],
 *   collections?: any[], sessions?: any[], sessionIdentities?: any[],
 *   organizationGroups?: any[], organizationMemberships?: any[]
 * }} data
 * @param {number} [now]
 * @returns {SearchSnapshot}
 */
export function createSearchSnapshot(data = {}, now = Date.now()) {
  /** @type {Record<string, SearchCandidate[]>} */
  const sources = {
    open: [], starred: [], inbox: [], snoozed: [], archive: [], collections: [], sessions: []
  };
  /** @type {Map<string, number>} */
  const labelCounts = new Map();
  const domainCounts = new Map();
  /** @type {string[]} */
  const sessionNames = [];
  /** @type {SearchResult[]} */
  const sessionEntities = [];
  const organizationEntities = [];
  const seenSessionNames = new Set();
  const seenSessionIds = new Set();
  const countLabels = (labels) => {
    for (const label of new Set(labels ?? [])) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  };
  const countDomain = (result) => {
    const domain = domainKeyOf(result);
    if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  };
  const addCandidate = (source, result, labels = []) => {
    sources[source].push(candidate(result, labels));
    countDomain(result);
  };

  for (const t of data.openTabs ?? []) {
    if (t.incognito) continue;
    const ref = canonicalRef(t);
    if (!ref) continue;
    const title = ref.title || ref.url;
    addCandidate("open", {
      type: "open", title, url: ref.url, tabId: t.id, windowId: t.windowId
    });
  }

  for (const item of data.starred ?? []) {
    addCandidate("starred", {
      type: "starred", title: item.title || item.url, url: item.url
    });
  }

  for (const item of data.inbox ?? []) {
    for (const t of item.tabs ?? []) {
      const labels = tabLabels(item, t);
      addCandidate("inbox", { type: "inbox", title: t.title, url: t.url }, labels);
      countLabels(labels);
    }
  }

  for (const snooze of data.snoozes ?? []) {
    if (Array.isArray(snooze.tabs) && snooze.tabs.length) {
      for (const t of snooze.tabs) {
        addCandidate("snoozed", { type: "snoozed", title: t.title, url: t.url });
      }
    } else {
      addCandidate("snoozed", {
        type: "snoozed", title: snooze.title, url: snooze.url
      });
    }
  }

  for (const item of data.archive ?? []) {
    for (const t of item.tabs ?? []) {
      const labels = tabLabels(item, t);
      addCandidate("archive", { type: "archive", title: t.title, url: t.url }, labels);
      countLabels(labels);
    }
  }

  for (const collection of data.collections ?? []) {
    for (const t of collection.tabs ?? []) {
      addCandidate("collections", {
        type: "collection", title: t.title, url: t.url, sourceName: collection.name
      });
    }
  }

  const sessions = data.sessions ?? [];
  for (const session of sessions) {
    const named = typeof session.name === "string" && Boolean(session.name.trim());
    if (!session.auto && named && !seenSessionNames.has(session.name)) {
      seenSessionNames.add(session.name);
      sessionNames.push(session.name);
    }
    // Search entities identify concrete records rather than deduplicated
    // names, so a repeated display name may still be represented here.
    if (session.auto || !named ||
        typeof session.id !== "string" || !session.id.trim() ||
        seenSessionIds.has(session.id)) continue;
    seenSessionIds.add(session.id);
    const windows = Array.isArray(session.windows) ? session.windows : [];
    sessionEntities.push({
      type: "session-entity",
      title: session.name,
      sessionId: session.id,
      windowCount: windows.length,
      tabCount: windows.reduce((total, refs) =>
        total + (Array.isArray(refs) ? refs.length : 0), 0)
    });
  }
  // The primary Search phase reads the compact named-Session identity index,
  // never the potentially enormous store shared with automatic Snapshots.
  // Full snapshots pass concrete Sessions above and therefore add nothing here.
  for (const identity of data.sessionIdentities ?? []) {
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";
    if (!name || typeof identity?.id !== "string" || !identity.id.trim()) continue;
    if (!seenSessionNames.has(identity.name)) {
      seenSessionNames.add(identity.name);
      sessionNames.push(identity.name);
    }
    if (seenSessionIds.has(identity.id)) continue;
    seenSessionIds.add(identity.id);
    const windows = Array.isArray(identity.windowUrls) ? identity.windowUrls : [];
    sessionEntities.push({
      type: "session-entity",
      title: identity.name,
      sessionId: identity.id,
      windowCount: windows.length,
      tabCount: windows.reduce((total, urls) =>
        total + (Array.isArray(urls) ? urls.length : 0), 0)
    });
  }
  for (const session of [
    ...sessions.filter((item) => !item.auto),
    ...sessions.filter((item) => item.auto)
  ]) {
    const isSnapshot = Boolean(session.auto);
    const sourceName = isSnapshot ? undefined : session.name;
    for (const windowRefs of session.windows ?? []) {
      for (const t of windowRefs) {
        const labels = t.labels ?? [];
        addCandidate("sessions", {
          type: "session", title: t.title, url: t.url, sourceName,
          ...(isSnapshot ? { sourceCreatedAt: Number(session.createdAt) || now } : {}),
          ...(isSnapshot ? { snapshot: true } : {})
        }, labels);
        if (!isSnapshot) countLabels(labels);
      }
    }
  }

  // P11-14: groups are navigation entities only. Their records are tiny and
  // independent of Label carriers / Session contents; membership counts are
  // projected against the already-built snapshot so orphans and Snapshots
  // never become searchable group members.
  const organizationState = {
    groups: Object.fromEntries((data.organizationGroups ?? [])
      .filter((record) => record && typeof record.id === "string")
      .map((record) => [record.id, record])),
    memberships: Object.fromEntries((data.organizationMemberships ?? [])
      .filter((record) => record && typeof record.id === "string")
      .map((record) => [record.id, record]))
  };
  const organizationProjections = [
    projectOrganization("label",
      [...labelCounts].map(([label, tabs]) => ({ label, tabs })),
      organizationState),
    projectOrganization("session", sessionEntities, organizationState,
      { memberKey: (entity) => entity.sessionId })
  ];
  for (const projection of organizationProjections) {
    for (const group of projection.groups) {
      organizationEntities.push({
        type: projection.kind === "label" ? "label-group-entity" : "session-group-entity",
        title: group.name.trim(),
        groupId: group.id,
        organizationKind: projection.kind,
        memberCount: group.members.length
      });
    }
  }

  return {
    sources,
    labelCounts: [...labelCounts].map(([label, tabs]) => ({ label, tabs }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    domainCounts: [...domainCounts]
      .map(([domain, tabs]) => ({ domain, tabs }))
      .sort((a, b) => b.tabs - a.tabs || a.domain.localeCompare(b.domain)),
    sessionNames,
    sessionEntities,
    organizationEntities
  };
}

async function buildCompleteSearchSnapshot(readSessions) {
  const [openTabs, starred, inbox, snoozes, archive, collections, sessions,
    organizationGroups, organizationMemberships] =
    await Promise.all([
      chrome.tabs.query({}),
      listItems(STORE_KEYS.starred),
      listItems(STORE_KEYS.inbox),
      listItems(STORE_KEYS.snoozes),
      listItems(STORE_KEYS.archive),
      listItems(STORE_KEYS.collections),
      readSessions(),
      listItems(STORE_KEYS.organizationGroups),
      listItems(STORE_KEYS.organizationMemberships)
    ]);
  return createSearchSnapshot({
    openTabs, starred, inbox, snoozes, archive, collections, sessions,
    organizationGroups, organizationMemberships
  });
}

/**
 * Read every source concurrently, then normalize once. One-shot callers keep
 * the established interaction-local store cache.
 * @returns {Promise<SearchSnapshot>}
 */
export function buildSearchSnapshot() {
  return buildCompleteSearchSnapshot(() => listItems(STORE_KEYS.sessions));
}

/** Complete phase for the shared UI. The large Session/Snapshot map and its
 * expanded candidates are released after matching instead of becoming
 * document-lifetime cache entries. */
async function buildTransientSearchSnapshot() {
  return buildCompleteSearchSnapshot(async () => {
    const sessionMap = await readFreshStoreMap(STORE_KEYS.sessions);
    return Object.values(sessionMap ?? {})
      .filter((item) => !item?.deletedAt)
      .sort((a, b) => (b?.modifiedAt ?? 0) - (a?.modifiedAt ?? 0));
  });
}

/**
 * First-use Search snapshot. It contains every ordinary source plus named
 * Session navigation entities, while automatic Snapshot tabs stay behind the
 * slower completion phase. This is the B8 interaction seam.
 * @returns {Promise<SearchSnapshot>}
 */
export async function buildPrimarySearchSnapshot() {
  const [openTabs, starred, inbox, snoozes, archive, collections,
    sessionIdentities, organizationGroups, organizationMemberships] =
    await Promise.all([
      chrome.tabs.query({}),
      listItems(STORE_KEYS.starred),
      listItems(STORE_KEYS.inbox),
      listItems(STORE_KEYS.snoozes),
      listItems(STORE_KEYS.archive),
      listItems(STORE_KEYS.collections),
      readStoreMap(SESSION_IDENTITY_INDEX_KEY).then((index) =>
        isSessionIdentityIndex(index) ? Object.values(index.sessionsById) : []),
      listItems(STORE_KEYS.organizationGroups),
      listItems(STORE_KEYS.organizationMemberships)
    ]);
  return createSearchSnapshot({
    openTabs, starred, inbox, snoozes, archive, collections, sessionIdentities,
    organizationGroups, organizationMemberships
  });
}

/** Build the small autocomplete projection without expanding Session tabs into
 * Search candidates. Automatic Snapshots contribute domains exactly as before;
 * only named Sessions contribute labels and names. */
async function buildSearchFacets(primary) {
  const labelCounts = new Map(
    (primary.labelCounts ?? []).map(({ label, tabs }) => [label, tabs])
  );
  const domainCounts = new Map(
    (primary.domainCounts ?? []).map(({ domain, tabs }) => [domain, tabs])
  );
  const sessionNames = [...(primary.sessionNames ?? [])];
  const seenSessionNames = new Set(sessionNames);
  const sessionMap = await readFreshStoreMap(STORE_KEYS.sessions);
  for (const session of Object.values(sessionMap ?? {})) {
    if (!session || session.deletedAt) continue;
    if (!session.auto && typeof session.name === "string" && session.name.trim() &&
        !seenSessionNames.has(session.name)) {
      seenSessionNames.add(session.name);
      sessionNames.push(session.name);
    }
    for (const refs of session.windows ?? []) {
      for (const ref of refs ?? []) {
        const domain = domainKeyOf(ref);
        if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
        if (session.auto) continue;
        for (const label of new Set(tabLabels(session, ref))) {
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
      }
    }
  }
  return {
    labelCounts: [...labelCounts].map(([label, tabs]) => ({ label, tabs }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    domainCounts: [...domainCounts].map(([domain, tabs]) => ({ domain, tabs }))
      .sort((a, b) => b.tabs - a.tabs || a.domain.localeCompare(b.domain)),
    sessionNames
  };
}

/**
 * Resolve a snapshot-backed named scope without changing parseScope's
 * intentionally token-sized public contract. Full leading names win, longest
 * first, before the legacy exact-token then prefix-token fallback.
 * @param {string} raw
 * @param {"label"|"session"|"domain"} type
 * @param {string[]} names
 * @returns {{scope: SearchScope, query: string}|null}
 */
function resolveNamedScope(raw, type, names) {
  const match = String(raw ?? "").match(/^\s*(label|session|domain):(.*)$/is);
  if (!match || match[1].toLowerCase() !== type) return null;
  const body = match[2].trimStart();
  if (!body) return null;
  const lowerBody = body.toLowerCase();
  const available = names
    .filter((name) => typeof name === "string" && name.length)
    .map((name, index) => ({ name, index, lower: name.toLowerCase() }));

  const leading = available
    .filter(({ lower }) => lowerBody === lower ||
      (lowerBody.startsWith(lower) && /\s/u.test(body.charAt(lower.length))))
    .sort((a, b) => b.lower.length - a.lower.length || a.index - b.index)[0];
  if (leading) {
    return {
      scope: { type, value: leading.name },
      query: body.slice(leading.name.length).trimStart()
    };
  }

  const tokenMatch = body.match(/^(\S+)\s*(.*)$/s);
  if (!tokenMatch) return null;
  const needle = tokenMatch[1].toLowerCase();
  const name = available.find((item) => item.lower === needle)?.name ??
    available.find((item) => item.lower.startsWith(needle))?.name;
  if (!name) return null;
  return { scope: { type, value: name }, query: tokenMatch[2] ?? "" };
}

/**
 * Resolve a raw scope token solely against one snapshot.
 * @param {string} raw @param {SearchSnapshot} snapshot
 * @returns {{scope: SearchScope|null, query: string}}
 */
export function resolveScopeFromSnapshot(raw, snapshot) {
  const parsed = parseScope(raw);
  if (parsed.type === "in") {
    return { scope: { type: "in", value: parsed.value }, query: parsed.query };
  }
  if (parsed.type === "label") {
    const resolved = resolveNamedScope(raw, "label",
      snapshot.labelCounts.map((item) => item.label));
    if (resolved) return resolved;
    return { scope: null, query: String(raw ?? "") };
  }
  if (parsed.type === "session") {
    const resolved = resolveNamedScope(raw, "session", snapshot.sessionNames ?? []);
    if (resolved) return resolved;
    return { scope: null, query: String(raw ?? "") };
  }
  if (parsed.type === "domain") {
    const resolved = resolveNamedScope(raw, "domain",
      (snapshot.domainCounts ?? []).map((item) => item.domain));
    if (resolved) return resolved;
    return { scope: null, query: String(raw ?? "") };
  }
  return { scope: null, query: parsed.query };
}

/**
 * Resolve a scope for a one-shot caller. UI sessions call their snapshot-bound
 * method so resolution and matching never split across two worlds.
 * @param {string} raw @param {SearchSnapshot} [snapshot]
 */
export async function resolveScope(raw, snapshot) {
  return resolveScopeFromSnapshot(raw, snapshot ?? await buildSearchSnapshot());
}

function queryNeedsSnapshot(query, scope) {
  const needle = String(query ?? "").trim();
  // Session scopes always need their restore entity, even when their tab
  // portion is blank or deliberately suppressed at one character.
  if (scope?.type === "session") return true;
  // One-character plain search is a deliberately narrow navigation pass. A
  // scoped one-character query keeps the prior blank result behavior.
  if (needle.length === 1) return !scope;
  if (needle.length === 0 && !scope) return false;
  return true;
}

const escapePattern = (value) => value.replace(/[\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * Session-name matches are intentionally independent of URL/tab matching.
 * @param {SearchResult[]} entities @param {string} needle @param {string[]} terms
 */
function matchingNamedEntities(entities, needle, terms, limit = 3) {
  const ranked = [[], [], []];
  for (const entity of entities ?? []) {
    const title = String(entity.title ?? "").toLowerCase();
    let rank = -1;
    if (title === needle) {
      rank = 0;
    } else if (terms.every((term) => new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapePattern(term)}`, "u"
    ).test(title))) {
      rank = 1;
    } else if (terms.every((term) => title.includes(term))) {
      rank = 2;
    }
    if (rank >= 0) ranked[rank].push(entity);
  }
  return ranked.flat().slice(0, limit);
}

/**
 * Pure saved/live matching plus query-driven optional History. All saved/live
 * fields are already lowercase and normalized in the snapshot.
 * @param {SearchSnapshot} snapshot
 * @param {string} query
 * @param {{includeHistory?: boolean, scope?: SearchScope|null}} [opts]
 * @returns {Promise<SearchResult[]>}
 */
export async function matchSearchSnapshot(snapshot, query, opts = {}) {
  let scope, plainQuery;
  if (opts.scope !== undefined) {
    scope = opts.scope;
    plainQuery = String(query ?? "");
  } else {
    const resolved = resolveScopeFromSnapshot(query, snapshot);
    scope = resolved.scope;
    plainQuery = resolved.query;
  }
  const needle = plainQuery.trim().toLowerCase();
  const isOneCharacterPlainQuery = needle.length === 1 && !scope;
  const scopedSessionEntity = scope?.type === "session"
    ? (snapshot.sessionEntities ?? []).find((entity) => entity.title === scope.value)
    : null;
  if (needle.length === 1 && !isOneCharacterPlainQuery) {
    return scopedSessionEntity ? [scopedSessionEntity] : [];
  }
  if (needle.length === 0 && !scope) return [];
  const terms = needle.split(/\s+/).filter(Boolean);

  /** @type {SearchResult[]} */
  const results = [];
  const seenUrls = new Set();
  const seenEntities = new Set();
  const pushEntity = (result) => {
    const identity = result.type === "session-entity" && result.sessionId
      ? `session:${result.sessionId}`
      : (result.type === "label-group-entity" || result.type === "session-group-entity") && result.groupId
        ? `${result.type}:${result.groupId}` : null;
    if (!identity || seenEntities.has(identity)) return;
    seenEntities.add(identity);
    results.push(result);
  };
  const push = (result) => {
    if (!result.url) return;
    const key = normalizeUrl(result.url);
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    results.push(result);
  };
  const matches = (item) => terms.every((term) =>
    item.titleText.includes(term) ||
    item.urlText.includes(term) ||
    item.labelText.some((label) => label.includes(term))
  );

  if (isOneCharacterPlainQuery) {
    // P11-18: a single character is useful only when it provides a confident
    // navigation shortcut. Do not search URL/label text or saved sources.
    const wordStart = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${needle.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`,
      "u"
    );
    const startsTitleWord = (item) => wordStart.test(item.wordStartTitleText);
    for (const source of ["open", "starred"]) {
      for (const item of snapshot.sources[source]) {
        if (startsTitleWord(item)) push(item.result);
      }
    }
    return results.slice(0, 8);
  }

  if (scopedSessionEntity) {
    pushEntity(scopedSessionEntity);
  } else if (!scope && needle.length >= 2) {
    const organizationMatches = matchingNamedEntities(
      snapshot.organizationEntities ?? [], needle, terms, 2
    );
    const namedMatches = matchingNamedEntities([
      ...(snapshot.sessionEntities ?? []),
      ...(snapshot.organizationEntities ?? [])
    ], needle, terms, 4);
    // P11-14 group names are a promised navigation route from two characters.
    // A large Session library must not consume every named-entity slot before
    // a matching Label/Session group can be shown.
    for (const group of [...organizationMatches].reverse()) {
      if (namedMatches.some((entity) => entity.type === group.type && entity.groupId === group.groupId)) continue;
      const replaceAt = namedMatches.findLastIndex((entity) =>
        entity.type !== "label-group-entity" && entity.type !== "session-group-entity");
      if (replaceAt >= 0) namedMatches.splice(replaceAt, 1, group);
      else if (namedMatches.length < 4) namedMatches.push(group);
    }
    for (const entity of namedMatches) pushEntity(entity);
  }

  const labelScope = scope?.type === "label" ? scope.value.toLowerCase() : null;
  const sessionScope = scope?.type === "session" ? scope.value : null;
  const domainScope = scope?.type === "domain" ? scope.value.toLowerCase() : null;
  const labelSources = new Set(["inbox", "archive", "sessions"]);
  const want = (source) =>
    labelScope ? labelSources.has(source) : sessionScope ? source === "sessions" :
      domainScope ? source !== "history" :
      !scope || scope.value === source;
  const hasLabel = (item) =>
    !labelScope || item.labelText.some((label) => label === labelScope);
  const hasSession = (item) =>
    !sessionScope || (!item.result.snapshot && item.result.sourceName === sessionScope);
  const hasDomain = (item) => !domainScope || domainKeyOf(item.result) === domainScope;
  const addSource = (source) => {
    if (!want(source)) return;
    for (const item of snapshot.sources[source] ?? []) {
      if (hasLabel(item) && hasSession(item) && hasDomain(item) && matches(item)) push(item.result);
    }
  };

  addSource("open");
  addSource("starred");
  addSource("inbox");
  addSource("snoozed");
  addSource("archive");
  addSource("collections");
  addSource("sessions");

  if (want("history") && opts.includeHistory && chrome.history) {
    try {
      const history = await chrome.history.search({
        text: needle,
        startTime: Date.now() - HISTORY_WINDOW_MS,
        maxResults: HISTORY_FETCH_LIMIT
      });
      let added = 0;
      const historyLimit = scope?.type === "in" && scope.value === "history"
        ? HISTORY_FETCH_LIMIT
        : HISTORY_UNSCOPED_LIMIT;
      for (const item of history) {
        const before = results.length;
        push({
          type: "history",
          title: item.title || item.url,
          url: item.url,
          lastVisitTime: Number(item.lastVisitTime) || 0
        });
        if (results.length > before) added += 1;
        if (added === historyLimit) break;
      }
    } catch {
      /* permission revoked mid-flight */
    }
  }
  return results.slice(0, 50);
}

/**
 * One interaction-local snapshot with a generation guard. `invalidate()` drops
 * both a published snapshot and an in-flight build; a stale build is never
 * returned and cannot refill the session.
 * @param {{buildSnapshot?: () => Promise<SearchSnapshot>,
 *   buildPrimarySnapshot?: () => Promise<SearchSnapshot>,
 *   buildCompletionSnapshot?: () => Promise<SearchSnapshot>}} [opts]
 */
export function createSearchSession(opts = {}) {
  const build = opts.buildSnapshot ?? buildSearchSnapshot;
  const buildPrimary = opts.buildPrimarySnapshot ??
    (opts.buildSnapshot ? build : buildPrimarySearchSnapshot);
  const buildCompletion = opts.buildCompletionSnapshot ??
    (opts.buildSnapshot ? build : buildTransientSearchSnapshot);
  const oneSnapshotContract = buildPrimary === build;
  let generation = 0;
  /** @type {SearchSnapshot|null} */
  let current = null;
  /** @type {{generation: number, promise: Promise<SearchSnapshot>}|null} */
  let pending = null;
  /** @type {SearchSnapshot|null} */
  let primaryCurrent = null;
  /** @type {{generation: number, promise: Promise<SearchSnapshot>}|null} */
  let primaryPending = null;
  /** @type {{generation: number, promise: Promise<SearchSnapshot>}|null} */
  let completionPending = null;
  /** @type {SearchSnapshot|null} */
  let completionCurrent = null;
  let completionReleaseTimer = 0;
  let facetsCurrent = null;
  let facetsPending = null;

  const invalidate = () => {
    generation += 1;
    current = null;
    pending = null;
    primaryCurrent = null;
    primaryPending = null;
    completionPending = null;
    completionCurrent = null;
    clearTimeout(completionReleaseTimer);
    completionReleaseTimer = 0;
    facetsCurrent = null;
    facetsPending = null;
  };

  const getSnapshot = async () => {
    while (true) {
      if (current) return current;
      const startedAt = generation;
      const entry = pending?.generation === startedAt
        ? pending
        : { generation: startedAt, promise: Promise.resolve().then(build) };
      pending = entry;
      let built;
      try {
        built = await entry.promise;
      } catch (error) {
        if (generation !== startedAt || pending !== entry) continue;
        if (pending === entry) pending = null;
        throw error;
      }
      if (generation !== startedAt || pending !== entry) continue;
      current = built;
      pending = null;
      return current;
    }
  };

  const getPrimarySnapshot = async () => {
    if (oneSnapshotContract) return getSnapshot();
    while (true) {
      if (primaryCurrent) return primaryCurrent;
      const startedAt = generation;
      const entry = primaryPending?.generation === startedAt
        ? primaryPending
        : { generation: startedAt, promise: Promise.resolve().then(buildPrimary) };
      primaryPending = entry;
      let built;
      try {
        built = await entry.promise;
      } catch (error) {
        if (generation !== startedAt || primaryPending !== entry) continue;
        if (primaryPending === entry) primaryPending = null;
        throw error;
      }
      if (generation !== startedAt || primaryPending !== entry) continue;
      primaryCurrent = built;
      primaryPending = null;
      return primaryCurrent;
    }
  };

  const noReadResult = (query, searchOpts) => {
    if (searchOpts.scope !== undefined &&
        !queryNeedsSnapshot(query, searchOpts.scope)) return [];
    if (searchOpts.scope === undefined) {
      const parsed = parseScope(query);
      if (parsed.type === null && !queryNeedsSnapshot(parsed.query, null)) return [];
      if (parsed.type === "in" &&
          !queryNeedsSnapshot(parsed.query, { type: "in", value: parsed.value })) return [];
    }
    return null;
  };

  const getFacets = async () => {
    if (oneSnapshotContract) {
      const snapshot = await getSnapshot();
      return {
        labelCounts: snapshot.labelCounts,
        domainCounts: snapshot.domainCounts,
        sessionNames: snapshot.sessionNames
      };
    }
    while (true) {
      if (facetsCurrent) return facetsCurrent;
      const startedAt = generation;
      const entry = facetsPending?.generation === startedAt
        ? facetsPending
        : {
            generation: startedAt,
            promise: getPrimarySnapshot().then(buildSearchFacets)
          };
      facetsPending = entry;
      let built;
      try {
        built = await entry.promise;
      } catch (error) {
        if (generation !== startedAt || facetsPending !== entry) continue;
        if (facetsPending === entry) facetsPending = null;
        throw error;
      }
      if (generation !== startedAt || facetsPending !== entry) continue;
      facetsCurrent = built;
      facetsPending = null;
      return facetsCurrent;
    }
  };

  const search = async (query, searchOpts = {}) => {
    // Preserve the old zero-read fast exits when this interaction has not
    // already warmed a snapshot and no data-backed scope needs resolving.
    const noRead = noReadResult(query, searchOpts);
    if (noRead) return noRead;
    while (true) {
      const acceptedGeneration = generation;
      const snapshot = await getSnapshot();
      const result = await matchSearchSnapshot(snapshot, query, searchOpts);
      if (acceptedGeneration === generation) return result;
    }
  };

  /**
   * Return the useful ordinary-source result first, plus an optional exact
   * completion Promise that includes named Session tabs and automatic
   * Snapshots. The complete snapshot is coalesced across concurrent keystrokes
   * but deliberately not retained after matching.
   * @param {string} query
   * @param {{includeHistory?: boolean, scope?: SearchScope|null}} [searchOpts]
   * @returns {Promise<{results: SearchResult[], complete: Promise<SearchResult[]|null>|null}>}
   */
  const searchProgressively = async (query, searchOpts = {}) => {
    const noRead = noReadResult(query, searchOpts);
    if (noRead) return { results: noRead, complete: null };
    if (oneSnapshotContract || current) {
      return { results: await search(query, searchOpts), complete: null };
    }

    const acceptedGeneration = generation;
    const primary = await getPrimarySnapshot();
    if (acceptedGeneration !== generation) return searchProgressively(query, searchOpts);
    const results = await matchSearchSnapshot(primary, query, {
      ...searchOpts,
      // History belongs in the complete phase so URL precedence and the
      // universal 50-result cap remain byte-for-byte equivalent to search().
      includeHistory: false
    });
    if (acceptedGeneration !== generation) return searchProgressively(query, searchOpts);
    const needleLength = String(query ?? "").trim().length;
    const explicitScope = searchOpts.scope;
    const completionCanChangeResults = needleLength !== 1 &&
      !(explicitScope?.type === "in" &&
        explicitScope.value !== "sessions" &&
        !(explicitScope.value === "history" && searchOpts.includeHistory));
    // One-character matching is deliberately Open/Starred-only (or empty for
    // an active scope). A non-Session in: scope also cannot gain anything from
    // the complete Session store. Fifty primary rows already consume the exact
    // source-ordered cap before Sessions/History are reached.
    if (!completionCanChangeResults || results.length === 50) {
      return { results, complete: null };
    }

    const retainCompletionBriefly = (snapshot) => {
      completionCurrent = snapshot;
      clearTimeout(completionReleaseTimer);
      completionReleaseTimer = setTimeout(() => {
        if (completionCurrent === snapshot) completionCurrent = null;
        completionReleaseTimer = 0;
      }, 1_000);
    };
    const matchCompletionAfterPaint = (snapshot) => new Promise((resolve) => {
      setTimeout(() => {
        if (acceptedGeneration !== generation) {
          resolve(null);
          return;
        }
        retainCompletionBriefly(snapshot);
        Promise.resolve(matchSearchSnapshot(snapshot, query, searchOpts))
          .then((finalResults) => resolve(
            acceptedGeneration === generation ? finalResults : null
          ), () => resolve(null));
      }, 0);
    });
    if (completionCurrent) {
      return {
        results,
        complete: matchCompletionAfterPaint(completionCurrent)
      };
    }

    const entry = completionPending?.generation === acceptedGeneration
      ? completionPending
      : {
          generation: acceptedGeneration,
          // Cross a task boundary before the large optional read. Returning a
          // Promise alone is insufficient: its microtask can still monopolize
          // the same frame before the primary rows reach the screen.
          promise: new Promise((resolve, reject) => {
            setTimeout(() => {
              Promise.resolve().then(buildCompletion).then(resolve, reject);
            }, 0);
          })
        };
    completionPending = entry;
    const complete = (async () => {
      try {
        const snapshot = await entry.promise;
        if (acceptedGeneration !== generation) return null;
        return await matchCompletionAfterPaint(snapshot);
      } catch {
        // Secondary Snapshot matching is additive. A primary result remains
        // valid if a large optional completion read fails or is invalidated.
        return null;
      } finally {
        if (completionPending === entry) completionPending = null;
      }
    })();
    return { results, complete };
  };

  return {
    getSnapshot,
    getPrimarySnapshot,
    invalidate,
    search,
    searchProgressively,
    async resolveScope(raw) {
      const snapshot = await getPrimarySnapshot();
      const primary = resolveScopeFromSnapshot(raw, snapshot);
      if (primary.scope || !parseScope(raw).type) return primary;
      const facets = await getFacets();
      return resolveScopeFromSnapshot(raw, { ...snapshot, ...facets });
    },
    async labelCounts() {
      return (await getFacets()).labelCounts;
    },
    async scopeNames(kind) {
      if (kind === "in") return IN_SCOPES;
      const facets = await getFacets();
      if (kind === "session") return facets.sessionNames ?? [];
      if (kind === "domain") return (facets.domainCounts ?? []).map((item) => item.domain);
      return facets.labelCounts.map((group) => group.label);
    }
  };
}

/**
 * Bind exact searched-store and tab/window invalidation. Returns cleanup for
 * tests or a future component disposal path.
 * @param {{invalidate: () => void}} session
 * @param {typeof chrome} [chromeApi]
 */
export function bindSearchSnapshotInvalidation(session, chromeApi = chrome) {
  const bindings = [];
  const bind = (event, fn) => {
    if (!event?.addListener) return;
    event.addListener(fn);
    bindings.push(() => event.removeListener?.(fn));
  };
  bind(chromeApi.storage?.onChanged, (changes, areaName) => {
    if (areaName !== "local") return;
    if (Object.keys(changes).some((key) => SEARCH_STORE_KEY_SET.has(key))) {
      session.invalidate();
    }
  });
  const invalidate = () => session.invalidate();
  for (const event of [
    chromeApi.tabs?.onCreated,
    chromeApi.tabs?.onUpdated,
    chromeApi.tabs?.onRemoved,
    chromeApi.tabs?.onMoved,
    chromeApi.tabs?.onAttached,
    chromeApi.tabs?.onDetached,
    chromeApi.tabs?.onReplaced,
    chromeApi.windows?.onCreated,
    chromeApi.windows?.onRemoved
  ]) bind(event, invalidate);
  return () => {
    for (const remove of bindings.splice(0)) remove();
  };
}

/**
 * Tiny pure run gate. Searchbox owns one instance and checks it after every
 * async boundary so an older query cannot replace newer rows or ARIA state.
 */
export function createRunGeneration() {
  let generation = 0;
  return {
    next() {
      const mine = ++generation;
      return { isCurrent: () => mine === generation };
    },
    invalidate() {
      generation += 1;
    }
  };
}

/**
 * One-shot universal search for worker/omnibox and legacy callers. UI search
 * uses `createSearchSession` so later keystrokes reuse the first snapshot.
 * @param {string} query
 * @param {{includeHistory?: boolean, scope?: SearchScope|null}} [opts]
 */
export async function searchAll(query, opts = {}) {
  if (opts.scope !== undefined && !queryNeedsSnapshot(query, opts.scope)) return [];
  if (opts.scope === undefined) {
    const parsed = parseScope(query);
    if (parsed.type === null && !queryNeedsSnapshot(parsed.query, null)) return [];
    if (parsed.type === "in" &&
        !queryNeedsSnapshot(parsed.query, { type: "in", value: parsed.value })) return [];
  }
  return matchSearchSnapshot(await buildSearchSnapshot(), query, opts);
}
