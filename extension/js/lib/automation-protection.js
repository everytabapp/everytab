// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Shared protection scopes for EveryTab's automatic Suspend and Auto-save
 * effects. Permanent page/site rules reuse the portable Settings list. A
 * browser-scoped tab rule lives in device-local operational storage so it
 * follows that browser tab through navigation and extension reloads. Browser
 * startup clears the map before automatic work can consume reused numeric ids.
 */

import {
  getFreshSettings, patchSettings, readFreshStoreMap, mutateStores
} from "./store.js";
import {
  canonicalUrlOf, exactAutomationPageRule, exactAutomationPageUrl,
  exactAutomationSiteHostname, exactAutomationSiteRule, matchesAutomationExclusion,
  matchesWhitelist, TEMPORARY_AUTOMATION_EXEMPTIONS_KEY, unifiedAutomationExclusions
} from "./tabs.js";

export const TAB_PROTECTIONS_KEY = "automationTabProtections";
export const TAB_PROTECTION_MS = 24 * 60 * 60_000;
const SUSPEND_RECOVERY_GRACE_KEY = "suspendRecoveryGraceUntil";
const SUSPEND_REGISTRY_KEY = "suspendedRegistry";
const MAX_EXPIRED_TAB_PROTECTION_RECORDS = 256;
const VALID_SCOPES = new Set(["tab", "site", "page"]);
const VALID_DURATIONS = new Set(["day", "always"]);
const AUTOMATION_PROTECTION_LOCK = "everytab-automation-protection-effect";
let fallbackProtectionLock = Promise.resolve();

function withProtectionLock(mode, work) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(AUTOMATION_PROTECTION_LOCK, { mode }, work);
  }
  const run = () => work();
  const task = fallbackProtectionLock.then(run, run);
  fallbackProtectionLock = task.catch(() => {});
  return task;
}

/** Serialize a protection mutation against the final automatic browser effect. */
export function withAutomationProtectionWrite(work) {
  return withProtectionLock("exclusive", work);
}

/** Settings-owned protection edits must share the automatic-effect boundary. */
export function patchAutomationProtectionSettings(mutator) {
  return withAutomationProtectionWrite(() => patchSettings(mutator));
}

/**
 * Hold a stable protection snapshot through an automatic browser mutation.
 * Multiple independent effects may share the read side; a user write waits or
 * wins before the final revalidation as one linearizable ordering.
 */
export function withAutomationProtectionEffect(work) {
  return withProtectionLock("shared", work);
}

function normalizedPage(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanTabProtectionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const records = {};
  for (const [rawId, raw] of Object.entries(value)) {
    const tabId = Number(rawId);
    const permanent = raw?.permanent === true || raw?.duration === "always";
    const expiresAt = Number(raw?.expiresAt);
    if (!Number.isInteger(tabId) || tabId < 0 ||
        (!permanent && !Number.isFinite(expiresAt))) continue;
    records[tabId] = {
      tabId,
      createdAt: Number.isFinite(Number(raw?.createdAt))
        ? Number(raw.createdAt)
        : (permanent ? 0 : expiresAt - TAB_PROTECTION_MS),
      ...(permanent
        ? { permanent: true, duration: "always", expiresAt: null }
        : { duration: "day", expiresAt }),
      ...(typeof raw?.url === "string" ? { url: raw.url } : {}),
      ...(typeof raw?.hostname === "string" ? { hostname: raw.hostname } : {})
    };
  }
  return records;
}

let browserStartReset = null;

function mutateTabProtections(mutator) {
  let result = null;
  return mutateStores([TAB_PROTECTIONS_KEY], (maps) => {
    const current = cleanTabProtectionMap(maps[TAB_PROTECTIONS_KEY]);
    const next = mutator(current);
    result = next ?? current;
    return next ? { [TAB_PROTECTIONS_KEY]: next } : null;
  }).then(() => result ?? {});
}

/**
 * Clear browser-scoped tab identities. Final automatic effects queue behind
 * this lock; suspended-tab recovery and unrelated startup work stay prompt.
 */
export function beginTabProtectionBrowserSession() {
  if (browserStartReset) return browserStartReset;
  browserStartReset = withAutomationProtectionWrite(() => (
    mutateStores([TAB_PROTECTIONS_KEY], (maps) => (
      Object.keys(maps[TAB_PROTECTIONS_KEY] ?? {}).length
        ? { [TAB_PROTECTIONS_KEY]: {} }
        : null
    ))
  ));
  return browserStartReset;
}

/** Read the raw temporary tab records. Expired rows remain available to UI. */
export async function readTabProtections() {
  return cleanTabProtectionMap(await readFreshStoreMap(TAB_PROTECTIONS_KEY));
}

/**
 * Pure status resolver used by awareness surfaces and automatic-effect guards.
 * The caller supplies already-read state, so one sweep can evaluate many tabs
 * without one storage read per candidate.
 */
export function protectionStatus(
  tab, settings = {}, temporaryURL = {}, tabProtections = {}, now = Date.now()
) {
  const url = canonicalUrlOf(tab);
  const page = normalizedPage(url);
  const hostname = page?.hostname.toLowerCase() ?? "";
  const base = { url: page?.href ?? (url || null), hostname };
  const record = tab?.id === undefined ? null : tabProtections?.[tab.id];
  if (record?.permanent === true || record?.duration === "always") {
    return {
      protected: true,
      kind: "tab",
      scope: "tab",
      duration: "always",
      permanent: true,
      expiresAt: null,
      ...base
    };
  }
  const expiresAt = Number(record?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return {
      protected: true,
      kind: "tab",
      scope: "tab",
      duration: "day",
      permanent: false,
      ...base,
      expiresAt
    };
  }

  if (page) {
    const rules = unifiedAutomationExclusions(settings);
    const pageRule = rules.find((rule) => exactAutomationPageUrl(rule) === page.href);
    if (pageRule) return {
      protected: true, kind: "page", scope: "page", duration: "always", ...base, rule: pageRule
    };

    const siteRule = rules.find((rule) => {
      const site = exactAutomationSiteHostname(rule);
      return site && (hostname === site || hostname.endsWith(`.${site}`));
    });
    if (siteRule) {
      return {
        protected: true,
        kind: "site",
        scope: "site",
        duration: "always",
        ...base,
        rule: siteRule,
        siteHostname: exactAutomationSiteHostname(siteRule)
      };
    }

    const broadRule = rules.find((rule) =>
      !exactAutomationPageUrl(rule) && !exactAutomationSiteHostname(rule) &&
      matchesWhitelist(page.href, [rule]));
    if (broadRule) {
      return {
        protected: true, kind: "rule", scope: "rule", duration: "always", ...base, rule: broadRule
      };
    }

    const temporaryExpiry = Number(temporaryURL?.[page.href]);
    if (Number.isFinite(temporaryExpiry) && temporaryExpiry > now) {
      return {
        protected: true,
        kind: "temporary-page",
        scope: "page",
        duration: "day",
        ...base,
        expiresAt: temporaryExpiry
      };
    }
    const temporarySite = Object.entries(temporaryURL ?? {}).find(([rule, rawExpiry]) => {
      const expiry = Number(rawExpiry);
      if (!Number.isFinite(expiry) || expiry <= now) return false;
      const site = exactAutomationSiteHostname(rule);
      return site && (hostname === site || hostname.endsWith(`.${site}`));
    });
    if (temporarySite) {
      const [rule, rawExpiry] = temporarySite;
      return {
        protected: true,
        kind: "temporary-site",
        scope: "site",
        duration: "day",
        ...base,
        rule,
        siteHostname: exactAutomationSiteHostname(rule),
        expiresAt: Number(rawExpiry)
      };
    }
  }

  if (Number.isFinite(expiresAt)) {
    return {
      protected: false, kind: "expired", scope: "tab", duration: "day", ...base, expiresAt
    };
  }
  return { protected: false, kind: "none", ...base };
}

/** Resolve one live tab against fresh portable, URL-local, and tab-local state. */
export async function readProtectionStatus(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch {
    return { protected: false, kind: "none", url: null, hostname: "" };
  }
  const [settings, temporaryURL, tabProtections] = await Promise.all([
    getFreshSettings(),
    readFreshStoreMap(TEMPORARY_AUTOMATION_EXEMPTIONS_KEY),
    readTabProtections()
  ]);
  return protectionStatus(tab, settings, temporaryURL, tabProtections);
}

function defaultDuration(scope) {
  return scope === "tab" ? "day" : "always";
}

function setArguments(scope, durationOrExpected, expected) {
  if (VALID_DURATIONS.has(durationOrExpected)) {
    return { duration: durationOrExpected, expected };
  }
  if (typeof durationOrExpected === "string") {
    return { duration: null, expected };
  }
  return { duration: defaultDuration(scope), expected: durationOrExpected ?? expected };
}

function normalizedHostname(value) {
  try {
    return exactAutomationSiteHostname(exactAutomationSiteRule(value));
  } catch {
    return null;
  }
}

function boundedTabProtectionMap(next, now) {
  const rank = (record) => record.permanent === true || record.duration === "always"
    ? Number.POSITIVE_INFINITY
    : Number(record.expiresAt) || 0;
  const ordered = Object.values(next).sort((a, b) => rank(b) - rank(a));
  const active = ordered.filter((record) =>
    record.permanent === true || record.duration === "always" || record.expiresAt > now);
  const expired = ordered.filter((record) =>
    record.permanent !== true && record.duration !== "always" && record.expiresAt <= now)
    .slice(0, MAX_EXPIRED_TAB_PROTECTION_RECORDS);
  return Object.fromEntries([...active, ...expired]
    .map((record) => [record.tabId, record]));
}

async function writeValidatedProtections(targets, scope, duration, now = Date.now()) {
  const uniqueRules = new Set();
  if (scope === "tab") {
    await mutateTabProtections((current) => {
      const next = { ...current };
      for (const { tab, page } of targets) {
        const candidate = {
          tabId: tab.id,
          createdAt: now,
          ...(duration === "always"
            ? { permanent: true, duration: "always", expiresAt: null }
            : { duration: "day", expiresAt: now + TAB_PROTECTION_MS }),
          url: page.href,
          hostname: page.hostname.toLowerCase()
        };
        const existing = current[tab.id];
        const existingPermanent = existing?.permanent === true || existing?.duration === "always";
        const keepExisting = existingPermanent || (
          duration === "day" && Number(existing?.expiresAt) >= candidate.expiresAt
        );
        next[tab.id] = keepExisting ? existing : candidate;
        uniqueRules.add(String(tab.id));
      }
      return boundedTabProtectionMap(next, now);
    });
  } else {
    for (const { page } of targets) {
      uniqueRules.add(scope === "site"
        ? exactAutomationSiteRule(page.hostname)
        : (duration === "day" ? page.href : exactAutomationPageRule(page.href)));
    }
    if (duration === "day") {
      await mutateStores([TEMPORARY_AUTOMATION_EXEMPTIONS_KEY], (maps) => {
        const next = { ...(maps[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY] ?? {}) };
        for (const rule of uniqueRules) {
          next[rule] = Math.max(Number(next[rule]) || 0, now + TAB_PROTECTION_MS);
        }
        return { [TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]: next };
      });
    } else {
      await patchSettings((current) => {
        const rules = unifiedAutomationExclusions(current);
        const next = [...new Set([...rules, ...uniqueRules])];
        return next.length === rules.length ? null : {
          archiveWhitelist: next,
          suspendWhitelist: next
        };
      });
    }
  }
  return {
    ok: true,
    scope,
    duration,
    protectedTabCount: targets.length,
    uniqueRuleCount: uniqueRules.size
  };
}

/** Add one scoped 24-hour or permanent protection. */
export async function setProtection(
  tabId, scope, durationOrExpected = null, expected = null
) {
  if (!Number.isInteger(tabId) || tabId < 0 || !VALID_SCOPES.has(scope)) {
    return { ok: false, reason: "invalid" };
  }
  const args = setArguments(scope, durationOrExpected, expected);
  if (!VALID_DURATIONS.has(args.duration)) return { ok: false, reason: "invalid" };
  const result = await withAutomationProtectionWrite(async () => {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, reason: "gone" }; }
    const page = normalizedPage(canonicalUrlOf(tab));
    if (!page || tab.incognito) return { ok: false, reason: "unavailable" };

    const frozen = args.expected;
    if (scope === "page" && frozen != null) {
      const expectedUrl = typeof frozen === "string" ? frozen : frozen.url;
      if (expectedUrl != null && normalizedPage(expectedUrl)?.href !== page.href) {
        return { ok: false, reason: "changed", url: page.href, hostname: page.hostname };
      }
    }
    if (scope === "site" && frozen != null) {
      const expectedHostname = typeof frozen === "string" ? frozen : frozen.hostname;
      if (expectedHostname != null &&
          normalizedHostname(expectedHostname) !== page.hostname.toLowerCase()) {
        return { ok: false, reason: "changed", url: page.href, hostname: page.hostname };
      }
    }
    return writeValidatedProtections([{ tab, page }], scope, args.duration);
  });
  if (!result.ok) return result;
  return { ...result, ...(await readProtectionStatus(tabId)) };
}

/**
 * Atomically protect a frozen tab/window selection. Every target is validated
 * before the one scope-specific write; one stale or closed tab aborts all.
 */
export async function setProtections(targets, scope, duration = defaultDuration(scope)) {
  if (!Array.isArray(targets) || targets.length === 0 || !VALID_SCOPES.has(scope) ||
      !VALID_DURATIONS.has(duration)) return { ok: false, reason: "invalid" };
  return withAutomationProtectionWrite(async () => {
    const liveTargets = [];
    for (const frozen of targets) {
      if (!Number.isInteger(frozen?.tabId) || frozen.tabId < 0) {
        return { ok: false, reason: "invalid" };
      }
      let tab;
      try { tab = await chrome.tabs.get(frozen.tabId); }
      catch { return { ok: false, reason: "gone", tabId: frozen.tabId }; }
      const page = normalizedPage(canonicalUrlOf(tab));
      const expectedPage = normalizedPage(frozen.url);
      const expectedHostname = normalizedHostname(frozen.hostname);
      if (!page || !expectedPage || !expectedHostname || tab.incognito ||
          page.href !== expectedPage.href ||
          page.hostname.toLowerCase() !== expectedHostname) {
        return { ok: false, reason: "changed", tabId: frozen.tabId };
      }
      liveTargets.push({ tab, page });
    }
    return writeValidatedProtections(liveTargets, scope, duration);
  });
}

/** Remove only the temporary tab record for an exact tab id. */
export async function removeTemporaryTabProtection(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  let removed = false;
  await withAutomationProtectionWrite(() => mutateTabProtections((current) => {
    if (!(tabId in current)) return null;
    const next = { ...current };
    delete next[tabId];
    removed = true;
    return next;
  }));
  return removed;
}

/**
 * tabs.onRemoved cleanup with the suspended-page reload grace in the same
 * Store transaction. A real close removes promptly; Chrome's reload teardown
 * preserves the old id long enough for suspended recovery to transfer it.
 */
export async function removeTemporaryTabProtectionOnClose(tabId, now = Date.now()) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  let removed = false;
  await withAutomationProtectionWrite(() => mutateStores([
    TAB_PROTECTIONS_KEY, SUSPEND_RECOVERY_GRACE_KEY, SUSPEND_REGISTRY_KEY
  ], (maps) => {
    const duringReload = now < Number(maps[SUSPEND_RECOVERY_GRACE_KEY] ?? 0);
    const registeredSuspendedSource = Boolean(maps[SUSPEND_REGISTRY_KEY]?.[tabId]);
    if (duringReload && registeredSuspendedSource) return null;
    const current = cleanTabProtectionMap(maps[TAB_PROTECTIONS_KEY]);
    if (!(tabId in current)) return null;
    const next = { ...current };
    delete next[tabId];
    removed = true;
    return { [TAB_PROTECTIONS_KEY]: next };
  }));
  return removed;
}

/**
 * Remove explicit protection layers applying to this tab. Legacy broad rules
 * are deliberately Settings-only because removing one can affect other pages.
 */
export async function removeProtection(tabId, expected = null) {
  const result = await withAutomationProtectionWrite(async () => {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch {
      let removed = false;
      await mutateTabProtections((current) => {
        if (!(tabId in current)) return null;
        const next = { ...current };
        delete next[tabId];
        removed = true;
        return next;
      });
      return { ok: removed, gone: true };
    }
    const [settings, temporaryURL, tabProtections] = await Promise.all([
      getFreshSettings(),
      readFreshStoreMap(TEMPORARY_AUTOMATION_EXEMPTIONS_KEY),
      readTabProtections()
    ]);
    const status = protectionStatus(
      tab, settings, temporaryURL, tabProtections
    );
    if (expected) {
      const sameKind = expected.kind === status.kind;
      const sameRule = expected.rule === undefined || expected.rule === status.rule;
      const sameUrl = expected.url === undefined || status.kind === "tab" ||
        expected.url === status.url;
      const sameExpiry = expected.expiresAt === undefined ||
        Number(expected.expiresAt) === Number(status.expiresAt);
      const sameDuration = expected.duration === undefined ||
        expected.duration === status.duration;
      if (!sameKind || !sameRule || !sameUrl || !sameExpiry || !sameDuration) {
        return { ok: false, reason: "changed", ...status };
      }
    }
    if (status.kind === "tab" || status.kind === "expired") {
      await mutateTabProtections((current) => {
        if (!(tabId in current)) return null;
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    } else if (status.kind === "page" || status.kind === "site") {
      const exactRule = status.rule;
      await patchSettings((current) => {
        const rules = unifiedAutomationExclusions(current);
        const next = rules.filter((rule) => rule !== exactRule);
        return next.length === rules.length ? null : {
          archiveWhitelist: next,
          suspendWhitelist: next
        };
      });
    } else if (["temporary-page", "temporary-site"].includes(status.kind)) {
      const temporaryKey = status.kind === "temporary-site" ? status.rule : status.url;
      await mutateStores([TEMPORARY_AUTOMATION_EXEMPTIONS_KEY], (maps) => {
        const current = maps[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY] ?? {};
        if (!temporaryKey || !(temporaryKey in current)) return null;
        const next = { ...current };
        delete next[temporaryKey];
        return { [TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]: next };
      });
    } else {
      // Legacy broad rules can cover many tabs and remain Settings-only.
      return { ok: false, ...status };
    }
    return { ok: true, gone: false };
  });
  if (!result.ok || result.gone) return result;
  return { ok: true, ...(await readProtectionStatus(tabId)) };
}

/** Settings view of tab-local protections, retaining expired rows while live. */
export async function listTemporaryTabProtections(now = Date.now()) {
  const [records, tabs] = await Promise.all([
    readTabProtections(),
    chrome.tabs.query({})
  ]);
  const live = new Map(tabs.filter((tab) => Number.isInteger(tab.id))
    .map((tab) => [tab.id, tab]));
  const rows = Object.values(records).filter((record) => live.has(record.tabId))
    .map((record) => {
      const tab = live.get(record.tabId);
      const page = normalizedPage(canonicalUrlOf(tab));
      return {
        tabId: record.tabId,
        url: page?.href ?? record.url ?? null,
        title: tab?.title || page?.href || record.url || "",
        hostname: page?.hostname.toLowerCase() ?? record.hostname ?? "",
        expiresAt: record.expiresAt,
        duration: record.permanent === true || record.duration === "always" ? "always" : "day",
        permanent: record.permanent === true || record.duration === "always",
        expired: record.permanent !== true && record.duration !== "always" && record.expiresAt <= now
      };
    }).sort((a, b) => {
      const aExpiry = a.permanent ? Number.POSITIVE_INFINITY : a.expiresAt;
      const bExpiry = b.permanent ? Number.POSITIVE_INFINITY : b.expiresAt;
      return aExpiry - bExpiry || a.tabId - b.tabId;
    });

  return rows;
}
