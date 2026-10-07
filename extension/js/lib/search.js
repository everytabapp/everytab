// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "./types.js";
import { listSearchItems, readStoreMap } from "./store.js";
import { tabLabels } from "./labels.js";
import { canonicalRef } from "./tabs.js";
import { snoozeRefs } from "./snooze-record.js";
import { normalizeUrl } from "./dedup.js";
import { projectOrganization } from "./organization.js";
import { domainKeyOf } from "./organize.js";
import {
  SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY, isSessionIdentityIndex
} from "./session-identity-index.js";
import { expandStorageChanges } from "./storage/constants.js";

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
 * Label facets are additive AND filters. `scope` remains the one mutually
 * exclusive source/session/domain lens, while `labels` can contain many names.
 * @typedef {Object} SearchFilters
 * @property {SearchScope|null} scope
 * @property {string[]} labels
 * @property {string} query
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
  ...SEARCH_STORE_KEYS, ARCHIVE_OVERLAY_KEY, SESSION_IDENTITY_INDEX_KEY,
  NAMED_SESSION_RECORDS_KEY
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

/** One live tab's Search result, or null when Search never lists it. */
function openSearchResult(tab) {
  if (tab.incognito) return null;
  const ref = canonicalRef(tab);
  if (!ref) return null;
  return {
    type: "open", title: ref.title || ref.url, url: ref.url, tabId: tab.id, windowId: tab.windowId
  };
}

/** @param {Map<string, number>} counts */
function sortedDomainCounts(counts) {
  return [...counts]
    .map(([domain, tabs]) => ({ domain, tabs }))
    .sort((a, b) => b.tabs - a.tabs || a.domain.localeCompare(b.domain));
}

/**
 * Replace only the Open source of a prepared snapshot. Saved sources, label and
 * Session facets are shared with the previous snapshot; domain counts are
 * adjusted for the departing and arriving open tabs. The result is equal to a
 * complete rebuild over the same data because every other field is derived
 * from saved records alone.
 * @param {SearchSnapshot} snapshot
 * @param {any[]} openTabs
 * @returns {SearchSnapshot}
 */
export function searchSnapshotWithOpenTabs(snapshot, openTabs) {
  const counts = new Map(snapshot.domainCounts.map(({ domain, tabs }) => [domain, tabs]));
  const adjust = (result, delta) => {
    const domain = domainKeyOf(result);
    if (!domain) return;
    const next = (counts.get(domain) ?? 0) + delta;
    if (next > 0) counts.set(domain, next);
    else counts.delete(domain);
  };
  for (const item of snapshot.sources.open ?? []) adjust(item.result, -1);
  const open = [];
  for (const tab of openTabs ?? []) {
    const result = openSearchResult(tab);
    if (!result) continue;
    open.push(candidate(result));
    adjust(result, 1);
  }
  return {
    ...snapshot,
    sources: { ...snapshot.sources, open },
    domainCounts: sortedDomainCounts(counts)
  };
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
  const steps = searchSnapshotSteps(data, now);
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

/** Normalize detached completion data in short tasks, without changing candidate order.
 * Callers must keep the input unchanged until the promise settles.
 * Clock checks are amortized across 128 records; the 4 ms budget is cooperative,
 * not a deadline for an individual record or the final facet sort.
 * @param {Parameters<typeof createSearchSnapshot>[0]} data
 * @param {number} [now]
 * @param {{clock?:()=>number, yieldTask?:()=>Promise<void>}} [options]
 * @returns {Promise<SearchSnapshot>}
 */
export async function createSearchSnapshotAsync(data = {}, now = Date.now(), {
  clock = () => performance.now(),
  yieldTask = () => typeof globalThis.scheduler?.yield === "function"
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0))
} = {}) {
  const steps = searchSnapshotSteps(data, now);
  let started = clock();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (clock() - started >= 4) {
      await yieldTask();
      started = clock();
    }
  }
}

/** Both drivers consume this single normalization implementation. */
function* searchSnapshotSteps(data, now) {
  let processed = 0;
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
    if (++processed % 128 === 0) yield;
    const result = openSearchResult(t);
    if (!result) continue;
    addCandidate("open", result);
  }

  for (const item of data.starred ?? []) {
    if (++processed % 128 === 0) yield;
    addCandidate("starred", {
      type: "starred", title: item.title || item.url, url: item.url
    });
  }

  for (const item of data.inbox ?? []) {
    for (const t of item.tabs ?? []) {
      if (++processed % 128 === 0) yield;
      const labels = tabLabels(item, t);
      addCandidate("inbox", { type: "inbox", title: t.title, url: t.url }, labels);
      countLabels(labels);
    }
  }

  for (const snooze of data.snoozes ?? []) {
    for (const ref of snoozeRefs(snooze)) {
      if (++processed % 128 === 0) yield;
      addCandidate("snoozed", {
        type: "snoozed", title: ref.title, url: ref.url
      });
    }
  }

  for (const item of data.archive ?? []) {
    for (const t of item.tabs ?? []) {
      if (++processed % 128 === 0) yield;
      const labels = tabLabels(item, t);
      addCandidate("archive", { type: "archive", title: t.title, url: t.url }, labels);
      countLabels(labels);
    }
  }

  for (const collection of data.collections ?? []) {
    for (const t of collection.tabs ?? []) {
      if (++processed % 128 === 0) yield;
      addCandidate("collections", {
        type: "collection", title: t.title, url: t.url, sourceName: collection.name
      });
    }
  }

  const sessions = data.sessions ?? [];
  for (const session of sessions) {
    if (++processed % 128 === 0) yield;
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
    if (++processed % 128 === 0) yield;
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
        if (++processed % 128 === 0) yield;
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
    domainCounts: sortedDomainCounts(domainCounts),
    sessionNames,
    sessionEntities,
    organizationEntities
  };
}

async function buildCompleteSearchSnapshot(readSessions, normalize = createSearchSnapshot) {
  const [openTabs, starred, inbox, snoozes, archive, collections, sessions,
    organizationGroups, organizationMemberships] =
    await Promise.all([
      chrome.tabs.query({}),
      listSearchItems(STORE_KEYS.starred),
      listSearchItems(STORE_KEYS.inbox),
      listSearchItems(STORE_KEYS.snoozes),
      listSearchItems(STORE_KEYS.archive),
      listSearchItems(STORE_KEYS.collections),
      readSessions(),
      listSearchItems(STORE_KEYS.organizationGroups),
      listSearchItems(STORE_KEYS.organizationMemberships)
    ]);
  return normalize({
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
  return buildCompleteSearchSnapshot(() => listSearchItems(STORE_KEYS.sessions));
}

/** Complete phase for the shared UI. The large Session/Snapshot map and its
 * expanded candidates are released after matching instead of becoming
 * document-lifetime cache entries. */
async function buildTransientSearchSnapshot() {
  return buildCompleteSearchSnapshot(
    () => listSearchItems(STORE_KEYS.sessions, { fresh: true }), createSearchSnapshotAsync
  );
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
      listSearchItems(STORE_KEYS.starred),
      listSearchItems(STORE_KEYS.inbox),
      listSearchItems(STORE_KEYS.snoozes),
      listSearchItems(STORE_KEYS.archive),
      listSearchItems(STORE_KEYS.collections),
      readStoreMap(SESSION_IDENTITY_INDEX_KEY).then((index) =>
        isSessionIdentityIndex(index) ? Object.values(index.sessionsById) : []),
      listSearchItems(STORE_KEYS.organizationGroups),
      listSearchItems(STORE_KEYS.organizationMemberships)
    ]);
  return createSearchSnapshot({
    openTabs, starred, inbox, snoozes, archive, collections, sessionIdentities,
    organizationGroups, organizationMemberships
  });
}

/** Keep only the compact autocomplete projection from a complete transient
 * Search snapshot. The expanded Session/Snapshot candidates remain temporary. */
function searchFacetsFromSnapshot(snapshot) {
  return {
    labelCounts: snapshot.labelCounts,
    domainCounts: snapshot.domainCounts,
    sessionNames: snapshot.sessionNames
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
 * Resolve every leading Search filter against one immutable snapshot. A query
 * may carry any number of `label:` facets plus one ordinary scope in either
 * order. Known multiword names use the same longest-match rule as the original
 * single-scope parser. Unresolved text is left untouched as the search query.
 * @param {string} raw @param {SearchSnapshot} snapshot
 * @returns {SearchFilters}
 */
export function resolveSearchFiltersFromSnapshot(raw, snapshot) {
  let rest = String(raw ?? "");
  /** @type {SearchScope|null} */
  let scope = null;
  const labels = [];
  const seenLabels = new Set();
  const labelNames = (snapshot.labelCounts ?? []).map((item) => item.label);

  while (true) {
    const trimmed = rest.trimStart();
    const prefix = trimmed.match(/^(in|label|session|domain):/i)?.[1]?.toLowerCase();
    if (!prefix) break;

    let resolved = null;
    if (prefix === "in") {
      const parsed = parseScope(trimmed);
      if (parsed.type === "in") {
        resolved = {
          scope: { type: "in", value: parsed.value },
          query: parsed.query
        };
      }
    } else {
      const names = prefix === "label" ? labelNames
        : prefix === "session" ? (snapshot.sessionNames ?? [])
          : (snapshot.domainCounts ?? []).map((item) => item.domain);
      resolved = resolveNamedScope(trimmed, prefix, names);
    }
    if (!resolved) break;

    if (resolved.scope.type === "label") {
      const key = resolved.scope.value.toLocaleLowerCase();
      if (!seenLabels.has(key)) {
        seenLabels.add(key);
        labels.push(resolved.scope.value);
      }
    } else {
      // One source/session/domain lens is intentional. A second ordinary scope
      // stays visible as query text rather than silently replacing the first.
      if (scope) break;
      scope = resolved.scope;
    }
    if (resolved.query === rest) break;
    rest = resolved.query;
  }

  return { scope, labels, query: rest };
}

/**
 * Resolve a scope for a one-shot caller. UI sessions call their snapshot-bound
 * method so resolution and matching never split across two worlds.
 * @param {string} raw @param {SearchSnapshot} [snapshot]
 */
export async function resolveScope(raw, snapshot) {
  return resolveScopeFromSnapshot(raw, snapshot ?? await buildSearchSnapshot());
}

function queryNeedsSnapshot(query, scope, labels = []) {
  const needle = String(query ?? "").trim();
  if (labels.length) return true;
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
 * @param {{includeHistory?: boolean, scope?: SearchScope|null, labels?: string[]}} [opts]
 * @returns {Promise<SearchResult[]>}
 */
export async function matchSearchSnapshot(snapshot, query, opts = {}) {
  let scope, plainQuery, selectedLabels;
  if (opts.scope !== undefined || opts.labels !== undefined) {
    scope = opts.scope;
    plainQuery = String(query ?? "");
    selectedLabels = Array.isArray(opts.labels) ? opts.labels : [];
  } else {
    const resolved = resolveSearchFiltersFromSnapshot(query, snapshot);
    scope = resolved.scope;
    selectedLabels = resolved.labels;
    plainQuery = resolved.query;
  }
  // Backward compatibility for callers which still pass one label as the old
  // exclusive scope. Internally it is the first facet, never a source lens.
  if (scope?.type === "label") {
    selectedLabels = [scope.value, ...(selectedLabels ?? [])];
    scope = null;
  }
  const labelFilters = [...new Set((selectedLabels ?? [])
    .map((label) => String(label).trim().toLocaleLowerCase())
    .filter(Boolean))];
  const needle = plainQuery.trim().toLowerCase();
  const isOneCharacterPlainQuery = needle.length === 1 && !scope && !labelFilters.length;
  const scopedSessionEntity = scope?.type === "session"
    ? (snapshot.sessionEntities ?? []).find((entity) => entity.title === scope.value)
    : null;
  if (needle.length === 1 && !isOneCharacterPlainQuery && !labelFilters.length) {
    return scopedSessionEntity ? [scopedSessionEntity] : [];
  }
  if (needle.length === 0 && !scope && !labelFilters.length) return [];
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

  if (scopedSessionEntity && !labelFilters.length) {
    pushEntity(scopedSessionEntity);
  } else if (!scope && !labelFilters.length && needle.length >= 2) {
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

  const sessionScope = scope?.type === "session" ? scope.value : null;
  const domainScope = scope?.type === "domain" ? scope.value.toLowerCase() : null;
  const labelSources = new Set(["inbox", "archive", "sessions"]);
  const want = (source) =>
    labelFilters.length ? labelSources.has(source) && (!scope ||
      (scope.type === "in" ? scope.value === source :
        sessionScope ? source === "sessions" : domainScope ? source !== "history" : true)) :
      sessionScope ? source === "sessions" :
      domainScope ? source !== "history" :
      !scope || scope.value === source;
  const hasLabel = (item) =>
    labelFilters.every((wanted) => item.labelText.some((label) => label === wanted));
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

  if (!labelFilters.length && want("history") && opts.includeHistory && chrome.history) {
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
 *   buildCompletionSnapshot?: () => Promise<SearchSnapshot>,
 *   readOpenTabs?: () => Promise<any[]>}} [opts] `readOpenTabs` lets a
 *   tab-presentation change replace only the Open source of a cached
 *   snapshot. The default builders read `chrome.tabs.query({})`; injected
 *   builders keep complete invalidation unless they also supply this reader.
 */
export function createSearchSession(opts = {}) {
  const build = opts.buildSnapshot ?? buildSearchSnapshot;
  const buildPrimary = opts.buildPrimarySnapshot ??
    (opts.buildSnapshot ? build : buildPrimarySearchSnapshot);
  const buildCompletion = opts.buildCompletionSnapshot ??
    (opts.buildSnapshot ? build : buildTransientSearchSnapshot);
  const oneSnapshotContract = buildPrimary === build;
  const injectedBuilders = Boolean(
    opts.buildSnapshot || opts.buildPrimarySnapshot || opts.buildCompletionSnapshot
  );
  const readOpenTabs = opts.readOpenTabs ??
    (injectedBuilders ? null : () => chrome.tabs.query({}));
  let generation = 0;
  // Open-source freshness is tracked apart from the complete generation. A
  // snapshot tagged with an older value still holds every saved source; only
  // its open tabs need re-reading before it is used again.
  let openGeneration = 0;
  /** @type {WeakMap<object, number>} */
  const openFreshness = new WeakMap();
  /** @type {WeakMap<object, {gen: number, promise: Promise<SearchSnapshot>}>} */
  const openRefreshes = new WeakMap();
  /** One open-tab read per presentation generation, shared by every cached snapshot. */
  let openTabsRead = null;
  const readOpenTabsFor = (gen) => {
    if (openTabsRead?.gen !== gen) {
      openTabsRead = { gen, promise: Promise.resolve().then(readOpenTabs) };
    }
    return openTabsRead.promise;
  };
  const tagOpen = (snapshot, gen) => {
    if (snapshot && typeof snapshot === "object") openFreshness.set(snapshot, gen);
    return snapshot;
  };
  const buildTagged = (builder) => {
    const openAtStart = openGeneration;
    return Promise.resolve().then(builder).then((snapshot) => tagOpen(snapshot, openAtStart));
  };
  /** Resolve a snapshot whose Open source reflects the latest tab presentation. */
  const withFreshOpen = (snapshot) => {
    if (!readOpenTabs || !snapshot || openFreshness.get(snapshot) === openGeneration) {
      return Promise.resolve(snapshot);
    }
    const target = openGeneration;
    let entry = openRefreshes.get(snapshot);
    if (!entry || entry.gen !== target) {
      entry = {
        gen: target,
        promise: readOpenTabsFor(target)
          .then((tabs) => tagOpen(searchSnapshotWithOpenTabs(snapshot, tabs), target))
      };
      openRefreshes.set(snapshot, entry);
    }
    return entry.promise;
  };
  /**
   * Publish a cached slot with fresh open tabs. Returns null when the caller's
   * loop must re-evaluate: a complete invalidation or a newer build replaced
   * the slot, or the open read failed and retired the cache.
   */
  const settleOpen = async (read, write) => {
    for (;;) {
      const held = read();
      if (!held) return null;
      const startedAt = generation;
      let fresh;
      try {
        fresh = await withFreshOpen(held);
      } catch {
        if (generation === startedAt) retireSnapshots();
        return null;
      }
      if (generation !== startedAt || read() !== held) return null;
      if (fresh !== held) write(fresh);
      if (openFreshness.get(fresh) === openGeneration) return fresh;
    }
  };
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

  const retainCompletionBriefly = (snapshot) => {
    completionCurrent = snapshot;
    clearTimeout(completionReleaseTimer);
    completionReleaseTimer = setTimeout(() => {
      if (completionCurrent === snapshot) completionCurrent = null;
      completionReleaseTimer = 0;
    }, 1_000);
  };

  const getCompletionEntry = (startedAt, deferUntilNextTask = false) => {
    if (completionPending?.generation === startedAt) return completionPending;
    const buildNow = () => buildTagged(buildCompletion);
    const entry = {
      generation: startedAt,
      // Result completion yields so primary rows can paint. Facet completion is
      // already an explicit user request and starts immediately.
      promise: deferUntilNextTask
        ? new Promise((resolve, reject) => {
            setTimeout(() => buildNow().then(resolve, reject), 0);
          })
        : buildNow()
    };
    completionPending = entry;
    return entry;
  };

  const retireSnapshots = () => {
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

  /**
   * Retire cached data. A `tab-presentation` reason (a background tab changed
   * only its title or favicon) keeps every saved source's prepared candidates
   * and marks the Open source stale, so the next read re-queries open tabs and
   * swaps that one source instead of rebuilding the whole snapshot. A URL or
   * structural change, a storage change and reason-less calls retire everything.
   * @param {{kind?: string, repaint?: boolean}} [reason]
   */
  const invalidate = (reason) => {
    const kind = reason?.kind ?? forwardedInvalidation?.kind;
    if (kind === "tab-presentation" && readOpenTabs) {
      openGeneration += 1;
      return;
    }
    retireSnapshots();
  };

  const getSnapshot = async () => {
    while (true) {
      if (current) {
        const settled = await settleOpen(() => current, (snapshot) => { current = snapshot; });
        if (settled) return settled;
        continue;
      }
      const startedAt = generation;
      const entry = pending?.generation === startedAt
        ? pending
        : { generation: startedAt, promise: buildTagged(build) };
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
      if (primaryCurrent) {
        const settled = await settleOpen(
          () => primaryCurrent, (snapshot) => { primaryCurrent = snapshot; }
        );
        if (settled) return settled;
        continue;
      }
      const startedAt = generation;
      const entry = primaryPending?.generation === startedAt
        ? primaryPending
        : { generation: startedAt, promise: buildTagged(buildPrimary) };
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
    const selectedLabels = Array.isArray(searchOpts.labels) ? searchOpts.labels : [];
    if (searchOpts.scope !== undefined &&
        !queryNeedsSnapshot(query, searchOpts.scope, selectedLabels)) return [];
    if (searchOpts.scope === undefined && !selectedLabels.length) {
      const parsed = parseScope(query);
      if (parsed.type === null && !queryNeedsSnapshot(parsed.query, null, [])) return [];
      if (parsed.type === "in" &&
          !queryNeedsSnapshot(parsed.query, { type: "in", value: parsed.value }, [])) return [];
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
            promise: (async () => {
              if (completionCurrent) return searchFacetsFromSnapshot(completionCurrent);
              const completionEntry = getCompletionEntry(startedAt);
              let snapshot;
              try {
                snapshot = await completionEntry.promise;
              } finally {
                if (completionPending === completionEntry) completionPending = null;
              }
              if (generation !== startedAt) return null;
              retainCompletionBriefly(snapshot);
              return searchFacetsFromSnapshot(snapshot);
            })()
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
      if (generation !== startedAt || facetsPending !== entry || !built) continue;
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
   * @param {{includeHistory?: boolean, scope?: SearchScope|null, labels?: string[]}} [searchOpts]
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
    const hasLabelFilters = Array.isArray(searchOpts.labels) && searchOpts.labels.length > 0;
    const completionCanChangeResults = (needleLength !== 1 || hasLabelFilters) &&
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

    const matchCompletionAfterPaint = (snapshot) => new Promise((resolve) => {
      setTimeout(async () => {
        if (acceptedGeneration !== generation) {
          resolve(null);
          return;
        }
        // A background title change since this complete build keeps its saved
        // and Session candidates; only the Open source is read again.
        let fresh;
        try {
          fresh = await withFreshOpen(snapshot);
        } catch {
          resolve(null);
          return;
        }
        if (acceptedGeneration !== generation) {
          resolve(null);
          return;
        }
        retainCompletionBriefly(fresh);
        Promise.resolve(matchSearchSnapshot(fresh, query, searchOpts))
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

    // Cross a task boundary before the large optional read. Returning a Promise
    // alone is insufficient: its microtask can still monopolize the same frame
    // before the primary rows reach the screen.
    const entry = getCompletionEntry(acceptedGeneration, true);
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
    async resolveFilters(raw) {
      const snapshot = await getPrimarySnapshot();
      const primary = resolveSearchFiltersFromSnapshot(raw, snapshot);
      const unresolvedPrefix = parseScope(primary.query).type;
      if (!unresolvedPrefix) return primary;
      const facets = await getFacets();
      return resolveSearchFiltersFromSnapshot(raw, { ...snapshot, ...facets });
    },
    /** Empty Search examples use ordinary sources already needed by primary
     * Search. Opening examples must not hydrate automatic Snapshot tabs. */
    async emptySuggestionFacets() {
      return searchFacetsFromSnapshot(await getPrimarySnapshot());
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
 * The reason of the invalidation currently being delivered. Hosts such as the
 * shared Search box wrap a session and call its `invalidate()` without the
 * reason; the session reads this during that synchronous call so a cosmetic
 * tab update still keeps the saved sources. Null outside a delivery.
 * @type {{kind: string, repaint: boolean}|null}
 */
let forwardedInvalidation = null;

/**
 * Bind exact searched-store and tab/window invalidation. Returns cleanup for
 * tests or a future component disposal path.
 * @param {{invalidate: (reason?: {kind:string,repaint:boolean}) => void}} session
 * @param {typeof chrome} [chromeApi]
 */
export function bindSearchSnapshotInvalidation(session, chromeApi = chrome) {
  const bindings = [];
  const bind = (event, fn) => {
    if (!event?.addListener) return;
    event.addListener(fn);
    bindings.push(() => event.removeListener?.(fn));
  };
  const notify = (reason) => {
    forwardedInvalidation = reason;
    try {
      session.invalidate(reason);
    } finally {
      forwardedInvalidation = null;
    }
  };
  bind(chromeApi.storage?.onChanged, (changes, areaName) => {
    if (areaName !== "local") return;
    changes = expandStorageChanges(changes);
    if (Object.keys(changes).some((key) => SEARCH_STORE_KEY_SET.has(key))) {
      notify({ kind: "storage", repaint: true });
    }
  });
  const structural = () => notify({ kind: "tab-structure", repaint: true });
  for (const event of [
    chromeApi.tabs?.onCreated,
    chromeApi.tabs?.onRemoved,
    chromeApi.tabs?.onMoved,
    chromeApi.tabs?.onAttached,
    chromeApi.tabs?.onDetached,
    chromeApi.tabs?.onReplaced,
    chromeApi.windows?.onCreated,
    chromeApi.windows?.onRemoved
  ]) bind(event, structural);
  bind(chromeApi.tabs?.onUpdated, (_tabId, changeInfo = {}) => {
    // Unread badges and messaging apps frequently change only a background
    // tab's title. Refresh only the Open source for the next interaction, and
    // do not repaint an active Search result set for that cosmetic update. A
    // URL change alters result identity and still reconciles immediately.
    if (typeof changeInfo.url === "string") {
      notify({ kind: "tab-url", repaint: true });
    } else if (typeof changeInfo.title === "string" ||
        typeof changeInfo.favIconUrl === "string") {
      notify({ kind: "tab-presentation", repaint: false });
    }
  });
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
 * @param {{includeHistory?: boolean, scope?: SearchScope|null, labels?: string[]}} [opts]
 */
export async function searchAll(query, opts = {}) {
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  if (opts.scope !== undefined && !queryNeedsSnapshot(query, opts.scope, labels)) return [];
  if (opts.scope === undefined && !labels.length) {
    const parsed = parseScope(query);
    if (parsed.type === null && !queryNeedsSnapshot(parsed.query, null, [])) return [];
    if (parsed.type === "in" &&
        !queryNeedsSnapshot(parsed.query, { type: "in", value: parsed.value }, [])) return [];
  }
  return matchSearchSnapshot(await buildSearchSnapshot(), query, opts);
}
