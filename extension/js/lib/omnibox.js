// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F20 — Chrome omnibox adapter helpers.
 *
 * This module is DOM/Chrome-free. It owns suggestion escaping/formatting, a stable
 * content identity for selected results, stale-query suppression, and disposition
 * planning/execution through injected effects. The service worker only wires Chrome
 * events and APIs around these helpers.
 */
import { searchResultTarget } from "./search.js";
import { searchResultAction, searchResultMeta } from "./search-copy.js";
import { browserHandoffForInput } from "./search-handoff.js";
import { msg } from "./i18n.js";

export const OMNIBOX_DEFAULT_SUGGESTION =
  msg("omnibox_default_suggestion");

const CONTENT_PREFIX = "everytab-result:";
const MAX_SUGGESTIONS = 10;
const MAX_FILTER_COMPLETIONS = 4;
const FILTER_KINDS = Object.freeze(["in", "label", "session", "domain"]);
function isWebUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isSessionId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isOrganizationTarget(target) {
  return target?.type === "open-organization-group" &&
    ["label", "session"].includes(target.organizationKind) &&
    typeof target.groupId === "string" && target.groupId.trim().length > 0;
}

/** Escape the five predefined XML entities required by Chrome omnibox descriptions. */
export function escapeOmniboxText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Encode an exact target into SuggestResult.content without worker-local memory. */
export function encodeOmniboxTarget(target) {
  if (target?.type === "focus-tab" && Number.isInteger(target.tabId) && target.tabId >= 0 &&
      Number.isInteger(target.windowId) && target.windowId >= 0) {
    return `${CONTENT_PREFIX}focus:${target.tabId}:${target.windowId}`;
  }
  if (target?.type === "open-url" && typeof target.url === "string" && isWebUrl(target.url)) {
    return `${CONTENT_PREFIX}url:${encodeURIComponent(target.url)}`;
  }
  if (target?.type === "activate-starred" &&
      typeof target.url === "string" && isWebUrl(target.url)) {
    return `${CONTENT_PREFIX}star:${encodeURIComponent(target.url)}`;
  }
  if (target?.type === "restore-session" && isSessionId(target.sessionId)) {
    return `${CONTENT_PREFIX}session:${encodeURIComponent(target.sessionId)}`;
  }
  if (isOrganizationTarget(target)) {
    return `${CONTENT_PREFIX}group:${target.organizationKind}:${encodeURIComponent(target.groupId)}`;
  }
  return null;
}

/** Decode SuggestResult.content; raw user queries and malformed identities return null. */
export function decodeOmniboxTarget(content) {
  const text = String(content ?? "");
  if (!text.startsWith(CONTENT_PREFIX)) return null;
  const encoded = text.slice(CONTENT_PREFIX.length);
  const focus = encoded.match(/^focus:(-?\d+):(-?\d+)$/);
  if (focus) {
    const tabId = Number(focus[1]);
    const windowId = Number(focus[2]);
    if (Number.isSafeInteger(tabId) && tabId >= 0 &&
        Number.isSafeInteger(windowId) && windowId >= 0) {
      return { type: "focus-tab", tabId, windowId };
    }
    return null;
  }
  if (encoded.startsWith("session:")) {
    try {
      const sessionId = decodeURIComponent(encoded.slice("session:".length));
      return isSessionId(sessionId) ? { type: "restore-session", sessionId } : null;
    } catch {
      return null;
    }
  }
  const group = encoded.match(/^group:(label|session):(.*)$/);
  if (group) {
    try {
      const groupId = decodeURIComponent(group[2]);
      return groupId.trim()
        ? { type: "open-organization-group", organizationKind: group[1], groupId }
        : null;
    } catch {
      return null;
    }
  }
  const kind = encoded.startsWith("url:") ? "open-url"
    : encoded.startsWith("star:") ? "activate-starred" : null;
  if (!kind) return null;
  try {
    const url = decodeURIComponent(encoded.slice(encoded.indexOf(":") + 1));
    return isWebUrl(url) ? { type: kind, url } : null;
  } catch {
    return null;
  }
}

/** @param {import("./search.js").SearchResult} result */
export function formatOmniboxDescription(result) {
  if (result.type === "session-entity") {
    return `<match>${escapeOmniboxText(searchResultAction(result.type))}</match> ` +
      `${escapeOmniboxText(result.title)} ` +
      `<dim>${escapeOmniboxText(searchResultMeta(result, { context: "omnibox" }))}</dim>`;
  }
  if (result.type === "label-group-entity" || result.type === "session-group-entity") {
    return `<match>${escapeOmniboxText(searchResultAction(result.type))}</match> ` +
      `${escapeOmniboxText(result.title)} ` +
      `<dim>${escapeOmniboxText(searchResultMeta(result, { context: "omnibox" }))}</dim>`;
  }
  const action = searchResultAction(result.type);
  const title = result.title || result.url;
  const source = searchResultMeta(result, { context: "omnibox" });
  return `<match>${escapeOmniboxText(action)}</match> ${escapeOmniboxText(title)} ` +
    `<dim>${escapeOmniboxText(source)}</dim> <url>${escapeOmniboxText(result.url)}</url>`;
}

/** Build one Chrome SuggestResult, or null for a malformed search result. */
export function omniboxSuggestion(result) {
  const content = encodeOmniboxTarget(searchResultTarget(result));
  if (!content) return null;
  return { content, description: formatOmniboxDescription(result) };
}

/**
 * Build up to four actionable, human-readable filter completions. Before the colon,
 * the first unique keyword character is enough (`s` -> real Session names); after
 * it, values are narrowed by prefix. The returned shape is accepted directly by
 * the browser omnibox API while remaining straightforward to unit-test without Chrome.
 * @param {string} text
 * @param {(kind:"in"|"label"|"session"|"domain"|"view") => Promise<string[]>|string[]} scopeNames
 */
export async function omniboxFilterCompletions(text, scopeNames) {
  const query = String(text ?? "").trim();
  let kinds = [];
  let partial = "";
  const keyword = query.match(/^([a-z]+)$/i);
  if (keyword) {
    const typed = keyword[1].toLowerCase();
    kinds = FILTER_KINDS.filter((kind) => kind.startsWith(typed));
  } else {
    const value = query.match(/^(in|label|session|domain|view):(.*)$/i);
    if (!value) return [];
    kinds = [value[1].toLowerCase()];
    partial = value[2].trim().toLowerCase();
  }
  if (!kinds.length) return [];

  const suggestions = [];
  const seen = new Set();
  for (const kind of kinds) {
    let names;
    try {
      names = await scopeNames(kind);
    } catch {
      names = [];
    }
    for (const rawName of Array.isArray(names) ? names : []) {
      const name = String(rawName ?? "").trim();
      if (!name || !name.toLowerCase().startsWith(partial)) continue;
      const content = `${kind}:${name}`;
      const identity = content.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      const action = kind === "session"
        ? msg("search_action_restore") : msg("search_action_filter");
      const label = kind === "in" ? msg("search_filter_kind_in")
        : kind === "label" ? msg("search_filter_kind_label")
        : kind === "session" ? msg("search_filter_kind_session")
        : kind === "domain" ? msg("search_filter_kind_domain")
        : msg("search_filter_kind_view");
      suggestions.push({
        content,
        description: `<match>${escapeOmniboxText(action)}</match> ` +
          `${escapeOmniboxText(content)} <dim>${escapeOmniboxText(label)}</dim>`
      });
      if (suggestions.length === MAX_FILTER_COMPLETIONS) return suggestions;
    }
  }
  return suggestions;
}

/**
 * Create a query controller with one monotonic generation. An older async query returns
 * `accepted:false`, so its Chrome suggest callback can never replace newer results.
 * @param {{search: Function, hasHistory: () => Promise<boolean>|boolean,
 *   scopeNames?: (kind:"in"|"label"|"session"|"domain"|"view") => Promise<string[]>|string[]}} deps
 */
export function createOmniboxQueryController({ search, hasHistory, scopeNames = () => [] }) {
  let generation = 0;
  return {
    cancel() { generation++; },
    async run(text) {
      const current = ++generation;
      const query = String(text ?? "").trim();
      if (!query) return { accepted: current === generation, suggestions: [] };
      try {
        const includeHistory = !!(await hasHistory());
        const completionsPromise = omniboxFilterCompletions(query, scopeNames);
        const results = await search(query, { includeHistory });
        const completions = await completionsPromise;
        if (current !== generation) return { accepted: false, suggestions: [] };
        const completedSessions = new Set(completions
          .map((suggestion) => suggestion.content.match(/^session:(.*)$/i)?.[1]
            ?.trim().toLowerCase())
          .filter(Boolean));
        const ordinary = results
          .filter((result) => result.type !== "session-entity" ||
            !completedSessions.has(String(result.title ?? "").trim().toLowerCase()))
          .map(omniboxSuggestion)
          .filter(Boolean)
          .slice(0, MAX_SUGGESTIONS - completions.length);
        return {
          accepted: true,
          suggestions: [...completions, ...ordinary]
        };
      } catch {
        return { accepted: current === generation, suggestions: [] };
      }
    }
  };
}

/**
 * Resolve selected content exactly, else rerun raw text and take its top result.
 * A raw query with no EveryTab target may hand off to a direct URL or the user's
 * default search provider. The handoff helper deliberately declines one-character,
 * scoped, and partial-filter input so those Search states stay quiet.
 */
export async function omniboxTargetForInput(text, { search, hasHistory }) {
  const selected = decodeOmniboxTarget(text);
  if (selected) return selected;
  const query = String(text ?? "").trim();
  if (!query) return null;
  try {
    const includeHistory = !!(await hasHistory());
    const [first] = await search(query, { includeHistory });
    return first ? searchResultTarget(first) : browserHandoffForInput(query);
  } catch {
    return null;
  }
}

/** Map a target + Chrome disposition to one explicit, Chrome-free execution plan. */
export function omniboxNavigationPlan(target, disposition) {
  if (target?.type === "focus-tab") return { kind: "focus", target };
  if (target?.type === "restore-session" && isSessionId(target.sessionId)) {
    return { kind: "restore", sessionId: target.sessionId };
  }
  if (isOrganizationTarget(target)) {
    return {
      kind: "open-group",
      organizationKind: target.organizationKind,
      groupId: target.groupId
    };
  }
  if (target?.type === "activate-starred" &&
      typeof target.url === "string" && isWebUrl(target.url)) {
    return { kind: "activate", url: target.url };
  }
  if (target?.type === "search-web" && typeof target.text === "string" &&
      target.text.trim()) {
    const text = target.text.trim();
    if (disposition === "currentTab") {
      return { kind: "search", text, disposition: "CURRENT_TAB" };
    }
    if (disposition === "newForegroundTab") {
      return { kind: "search", text, disposition: "NEW_TAB" };
    }
    if (disposition === "newBackgroundTab") {
      return { kind: "search-background", text };
    }
    return null;
  }
  if (target?.type !== "open-url" || typeof target.url !== "string" || !isWebUrl(target.url)) {
    return null;
  }
  if (disposition === "currentTab") return { kind: "reuse", url: target.url };
  if (disposition === "newForegroundTab") {
    return { kind: "create", url: target.url, active: true };
  }
  if (disposition === "newBackgroundTab") {
    return { kind: "create", url: target.url, active: false };
  }
  return null;
}

/**
 * Execute a navigation plan through injected worker effects. Current-tab reuse is
 * limited to a non-incognito normal window; any missing/rejected target falls back to
 * one active new tab. Returns false only for an invalid plan or fully failed effect.
 * @param {ReturnType<typeof omniboxNavigationPlan>} plan
 * @param {{focus:Function, restoreSession?:Function, openOrganizationGroup?:Function, activateStarred?:Function,
 *   getLastFocusedWindow:Function, updateTab:Function, createTab:Function,
 *   searchWeb?: (query:{text:string, disposition?:"CURRENT_TAB"|"NEW_TAB", tabId?:number}) => Promise<unknown>|unknown,
 *   removeTab?: (tabId:number) => Promise<unknown>|unknown}} effects
 */
export async function executeOmniboxPlan(plan, effects) {
  if (!plan) return false;
  try {
    if (plan.kind === "focus") {
      await effects.focus(plan.target);
      return true;
    }
    if (plan.kind === "restore") {
      return (await effects.restoreSession(plan.sessionId)) !== false;
    }
    if (plan.kind === "open-group") {
      if (typeof effects.openOrganizationGroup !== "function") return false;
      return (await effects.openOrganizationGroup(
        plan.organizationKind,
        plan.groupId
      )) !== false;
    }
    if (plan.kind === "activate") {
      await effects.activateStarred(plan.url);
      return true;
    }
    if (plan.kind === "search") {
      if (typeof effects.searchWeb !== "function" || !plan.text?.trim()) return false;
      await effects.searchWeb({ text: plan.text, disposition: plan.disposition });
      return true;
    }
    if (plan.kind === "search-background") {
      if (typeof effects.searchWeb !== "function" || !plan.text?.trim()) return false;
      let tabId = null;
      try {
        const tab = await effects.createTab({ active: false });
        tabId = Number.isInteger(tab?.id) ? tab.id : null;
        if (tabId === null) return false;
        await effects.searchWeb({ text: plan.text, tabId });
        return true;
      } catch {
        if (tabId !== null && typeof effects.removeTab === "function") {
          try { await effects.removeTab(tabId); } catch { /* cleanup is best-effort */ }
        }
        return false;
      }
    }
    if (plan.kind === "create") {
      await effects.createTab({ url: plan.url, active: plan.active });
      return true;
    }
    if (plan.kind !== "reuse") return false;

    let window = null;
    try { window = await effects.getLastFocusedWindow(); } catch { /* fallback below */ }
    const tab = window?.type === "normal" && !window.incognito
      ? (window.tabs ?? []).find((candidate) => candidate.active)
      : null;
    if (tab && Number.isInteger(tab.id)) {
      try {
        await effects.updateTab(tab.id, { url: plan.url, active: true });
        return true;
      } catch { /* create fallback below */ }
    }
    await effects.createTab({ url: plan.url, active: true });
    return true;
  } catch {
    return false;
  }
}
