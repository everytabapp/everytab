// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
/**
 * F8-R2/P11-17 — distraction-site Focus coordinator (focus-mode.md v0.3 §6-§9). Owns the
 * site-only run and all reactive guarding: device-local operational state, the run-end
 * and access-expiry alarms, tab redirection to the EveryTab guard page, temporary
 * access, expiry, save-before-close return, and guard-reload recovery.
 *
 * PRIVACY / PLATFORM (hard constraints): uses only the already-held `tabs` permission
 * and `chrome.tabs.onUpdated` URL metadata. No host permissions, content scripts, DNR,
 * webNavigation, or page-content access. This is a REACTIVE guard (Chrome may begin a
 * load before EveryTab observes the URL); it never claims network prevention. Only
 * normal, non-incognito HTTP(S) tabs are ever recorded, redirected, saved, or closed.
 * `background.js` is a thin event/message layer over this module; UI surfaces
 * only render status and send messages.
 */
import {
  resolveEndChoice, siteFocusStatus, matchingRule, hostMatchesDomain, hostnameOfUrl,
  isGuardableUrl, isValidGrantMinutes, accessUnlocked, pauseRemainingMs, ruleApplies,
  GRANT_MINUTES, ACCESS_PAUSE_MS
} from "./focus.js";
import { getSettings } from "./store.js";
import { saveRefToInbox } from "./actions.js";
import { sameLiveTabCloseIdentity } from "./live-close.js";
import { dashboardHref } from "./newtab-focus.js";
import { formatNumber, msg } from "./i18n.js";

/* ------------------------------- local-only keys ------------------------------- */
/** null | { id, startedAt, endsAt: number|null } — the one active site-only run. */
export const GUARD_STATE_KEY = "focusGuardState";
/**
 * Record<canonicalDomain, {
 *   domain, accessStartedAt, expiresAt, grantedMinutes,
 *   warnedForExpiresAt?: number,
 *   deferredTabId?: number,
 *   deferredAt?: number,
 *   retryAt?: number,
 *   retryCount?: number
 * }>
 */
export const ACCESS_KEY = "focusTemporaryAccess";
/** Record<tabId, BlockedAttempt> — the guard tab's trusted context, keyed by tab id. */
export const ATTEMPTS_KEY = "focusBlockedAttempts";
/** Record<tabId, { url }> — the last safe (non-guarded) HTTP(S) URL seen per tab. */
export const RETURN_URLS_KEY = "focusReturnUrls";
/** Record<tabId, { attemptId, windowId, index }> — guard tabs, for reload recovery. */
export const GUARD_REGISTRY_KEY = "focusGuardRegistry";
/** Grace deadline during which a guard-tab close is treated as reload fallout. */
export const GUARD_GRACE_KEY = "focusGuardGraceUntil";

/** Current Focus run-end alarm. */
export const GUARD_END_ALARM = "focus-guard-end";
/** Single earliest-access warning, expiry, or retry alarm. */
export const ACCESS_ALARM = "focus-guard-expiry";

const GRACE_MS = 30_000;
const ACCESS_WARNING_MS = 2 * 60_000;
const ACCESS_NOTIFICATION_EXTENSION_MS = 5 * 60_000;
const EXPIRY_RETRY_BASE_MS = 5_000;
const EXPIRY_RETRY_MAX_MS = 60_000;
const ACCESS_WARNING_NOTIFICATION_PREFIX = "focus-access-warning:";
const ACCESS_ENDED_NOTIFICATION_PREFIX = "focus-access-ended:";

/* ------------------------------- serialized queue ------------------------------ */
let queue = Promise.resolve();
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/* ---------------------------------- storage ------------------------------------ */
async function readKey(key, dflt) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? dflt;
}
const readState = () => readKey(GUARD_STATE_KEY, null);
const writeState = (s) => chrome.storage.local.set({ [GUARD_STATE_KEY]: s });
const clearState = () => chrome.storage.local.remove(GUARD_STATE_KEY);
const readAccess = () => readKey(ACCESS_KEY, {});
const writeAccess = (m) => chrome.storage.local.set({ [ACCESS_KEY]: m });
const readAttempts = () => readKey(ATTEMPTS_KEY, {});
const writeAttempts = (m) => chrome.storage.local.set({ [ATTEMPTS_KEY]: m });
const readReturnUrls = () => readKey(RETURN_URLS_KEY, {});
const writeReturnUrls = (m) => chrome.storage.local.set({ [RETURN_URLS_KEY]: m });
const readRegistry = () => readKey(GUARD_REGISTRY_KEY, {});
const writeRegistry = (m) => chrome.storage.local.set({ [GUARD_REGISTRY_KEY]: m });

/* ---------------------------------- chrome edge -------------------------------- */
const guardUrl = () => chrome.runtime.getURL("focus.html");
const guardHashUrl = (attemptId) => `${guardUrl()}#${attemptId}`;
const dashboardUrl = () => dashboardHref();
/** An EveryTab-owned extension page (focus.html, dashboard, suspend, options, …). */
const isOwnPage = (url) => typeof url === "string" && url.startsWith(chrome.runtime.getURL(""));
/** The opaque attempt id carried by a focus.html tab's live URL, or "". */
const guardAttemptIdOfUrl = (url) => {
  const u = typeof url === "string" ? url : "";
  return u.startsWith(guardUrl() + "#") ? u.slice(guardUrl().length + 1) : "";
};

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}
async function normalWindowForTab(tab) {
  if (!tab || tab.incognito || tab.windowId == null) return null;
  try {
    const win = await chrome.windows.get(tab.windowId);
    return win?.type === "normal" && !win.incognito ? win : null;
  } catch {
    return null;
  }
}
/** Live normal, non-incognito tabs (any URL). */
async function liveNormalTabs() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  return tabs.filter((t) => !t.incognito);
}

/** Chrome's documented approximation of the tab the person is currently using. */
async function currentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab && await normalWindowForTab(tab) ? tab : null;
  } catch {
    return null;
  }
}

function accessWarningNotificationId(domain, expiresAt) {
  return `${ACCESS_WARNING_NOTIFICATION_PREFIX}${expiresAt}:${encodeURIComponent(domain)}`;
}
function accessEndedNotificationId(domain, expiresAt, tabId) {
  return `${ACCESS_ENDED_NOTIFICATION_PREFIX}${expiresAt}:${tabId}:${encodeURIComponent(domain)}`;
}
function parseAccessWarningNotificationId(id) {
  if (typeof id !== "string" || !id.startsWith(ACCESS_WARNING_NOTIFICATION_PREFIX)) return null;
  const raw = id.slice(ACCESS_WARNING_NOTIFICATION_PREFIX.length);
  const split = raw.indexOf(":");
  if (split < 1) return null;
  const expiresAt = Number(raw.slice(0, split));
  let domain = "";
  try { domain = decodeURIComponent(raw.slice(split + 1)); } catch { return null; }
  return Number.isFinite(expiresAt) && domain ? { domain, expiresAt } : null;
}
async function clearNotification(id) {
  try { await chrome.notifications.clear(id); } catch { /* best effort */ }
}
async function clearAccessNotifications(rec) {
  if (!rec?.domain || !Number.isFinite(rec.expiresAt)) return;
  await clearNotification(accessWarningNotificationId(rec.domain, rec.expiresAt));
  if (rec.deferredTabId != null) {
    await clearNotification(accessEndedNotificationId(rec.domain, rec.expiresAt, rec.deferredTabId));
  }
}
async function notifyAccessWarning(rec, displayDomain, now) {
  const remainingMinutes = Math.max(1, Math.ceil((rec.expiresAt - now) / 60_000));
  const id = accessWarningNotificationId(rec.domain, rec.expiresAt);
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: remainingMinutes === 1
        ? msg("focus_notification_access_ends_one")
        : msg("focus_notification_access_ends_other", [formatNumber(remainingMinutes)]),
      message: msg("focus_notification_access_warning", [displayDomain]),
      buttons: [{ title: msg("focus_notification_add_five") }]
    });
  } catch (e) {
    reportFailure("focus-access-warning", e);
  }
}
async function notifyAccessEnded(rec) {
  const id = accessEndedNotificationId(rec.domain, rec.expiresAt, rec.deferredTabId);
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: msg("focus_notification_access_ended_title"),
      message: msg("focus_notification_access_ended_body")
    });
  } catch (e) {
    reportFailure("focus-access-expiry-notification", e);
  }
}

/**
 * F8-R2r C10: an opaque id alone is not proof. A page-originated guard action (or a
 * context rebind) is honored only when the LIVE sender tab is normal, non-incognito, and
 * is actually this extension's `focus.html#<attemptId>` (accepting `pendingUrl` while Chrome
 * is still committing the navigation). A dashboard/options/other-extension/other page, an
 * incognito tab, or a wrong hash is rejected — a stolen id cannot act on someone's attempt.
 * @param {number} senderTabId @param {string} attemptId
 */
async function liveGuardTab(senderTabId, attemptId) {
  if (senderTabId == null || !attemptId) return null;
  const tab = await getTab(senderTabId);
  if (!(await normalWindowForTab(tab))) return null;
  const want = guardHashUrl(attemptId);
  // A still-visible guard already navigating elsewhere cannot authorize a
  // destructive action on its pending destination.
  if (tab.pendingUrl && tab.pendingUrl !== want) return null;
  return tab.url === want || tab.pendingUrl === want ? tab : null;
}

async function runIsActive(state) {
  const s = state ?? (await readState());
  if (!s) return false;
  return !(s.endsAt != null && s.endsAt <= Date.now());
}

/* ------------------------------------ alarms ----------------------------------- */
async function armEndAlarm(state) {
  await chrome.alarms.clear(GUARD_END_ALARM);
  if (state?.endsAt != null) await chrome.alarms.create(GUARD_END_ALARM, { when: state.endsAt });
}
/* Packed extensions cannot create an alarm under 30 s. Access expiry and its
   warning are often due sooner than that, so near-term work runs on a retained
   timer in this worker and the alarm remains the fallback for a worker that
   stops first. The timer calls the same expiry pass the alarm would. */
let accessTimer = 0;
const PROMPT_WINDOW_MS = 30_000;
function armAccessTimer(delayMs) {
  clearTimeout(accessTimer);
  accessTimer = setTimeout(() => {
    accessTimer = 0;
    void handleAccessAlarm().catch(() => {});
  }, Math.max(0, delayMs));
}
async function rearmAccessAlarm(access) {
  await chrome.alarms.clear(ACCESS_ALARM);
  clearTimeout(accessTimer);
  accessTimer = 0;
  const now = Date.now();
  const times = Object.values(access ?? {}).map((r) => {
    if (r.retryAt != null) return r.retryAt;
    if (r.deferredTabId != null) return null;
    if (!Number.isFinite(r.expiresAt)) return null;
    if (r.expiresAt <= now) return now + 250;
    if (r.warnedForExpiresAt !== r.expiresAt) {
      return Math.max(now + 250, r.expiresAt - ACCESS_WARNING_MS);
    }
    return r.expiresAt;
  }).filter(Number.isFinite);
  if (times.length) {
    const due = Math.max(now + 250, Math.min(...times));
    if (due - now < PROMPT_WINDOW_MS) armAccessTimer(due - now);
    // alarm-fallback: the retained timer above owns prompt expiry; the alarm
    // only matters if this worker stops before it fires.
    await chrome.alarms.create(ACCESS_ALARM, { when: due });
  }
}
/** True for either current site-guard alarm. */
export function isGuardAlarm(name) {
  return name === GUARD_END_ALARM || name === ACCESS_ALARM;
}

/* ------------------------------------ status ----------------------------------- */
async function status(settings) {
  const s = settings ?? (await getSettings());
  return siteFocusStatus(await readState(), s.focusSiteRules ?? [], Date.now());
}
/**
 * Read-only temporary-access rows for trusted EveryTab surfaces. Expired records are
 * exposed only while they own the active-tab deferral; ordinary overdue/retry records
 * remain worker-internal. The exact boundary lets a rendered Add 5 action be stale-safe.
 */
async function accessStatus(settings, state) {
  const s = settings ?? (await getSettings());
  const runActive = await runIsActive(state ?? (await readState()));
  const now = Date.now();
  const access = await readAccess();
  const accesses = [];
  for (const rec of Object.values(access)) {
    if (!rec?.domain || (!Number.isFinite(rec.expiresAt))) continue;
    if (rec.expiresAt <= now && rec.deferredTabId == null) continue;
    const rule = (s.focusSiteRules ?? []).find((candidate) =>
      candidate.domain === rec.domain && ruleApplies(candidate, runActive));
    if (!rule) continue;
    accesses.push({
      domain: rec.domain,
      displayDomain: rule.displayDomain || rule.domain,
      accessStartedAt: rec.accessStartedAt,
      expiresAt: rec.expiresAt,
      expired: rec.expiresAt <= now,
      deferred: rec.deferredTabId != null
    });
  }
  accesses.sort((a, b) => a.expiresAt - b.expiresAt || a.domain.localeCompare(b.domain));
  return { accesses };
}

/** Read-only current site-only Focus status plus temporary access (no lock). */
export async function getGuardStatus() {
  const settings = await getSettings();
  const state = await readState();
  return {
    ...siteFocusStatus(state, settings.focusSiteRules ?? [], Date.now()),
    ...(await accessStatus(settings, state))
  };
}

/** Read-only temporary access for popup/new-tab/shared UI tests and consumers. */
export async function getFocusAccessStatus() {
  return accessStatus();
}
async function fail(reason, settings) {
  return { ok: false, reason, status: await status(settings) };
}

/* ------------------------------- start / end run ------------------------------- */
/**
 * Start a site-only Focus run. Requires at least one During Focus rule. Persists the
 * run before arming its alarm, then sweeps already-open eligible tabs.
 * @param {{endChoice?: import("./focus.js").FocusEndChoice}} [args]
 */
export function startFocus({ endChoice } = {}) {
  return serialize(async () => {
    const settings = await getSettings();
    const rules = settings.focusSiteRules ?? [];
    if (!rules.some((r) => r.scope === "focus")) return fail("no-during-rules", settings);
    const end = resolveEndChoice(endChoice, settings, Date.now());
    if (!end.ok) return fail("invalid-end", settings);
    const state = { id: crypto.randomUUID(), startedAt: Date.now(), endsAt: end.endsAt };
    await writeState(state);        // persist BEFORE arming the alarm (focus-mode.md §8.1)
    await armEndAlarm(state);
    await sweepOpenTabs(state, settings);
    return { ok: true, status: await status(settings) };
  });
}

/** The end transaction (not self-serialized). Clears the alarm + run, drops access
 *  grants that only existed because of a During Focus rule, leaves All the time grants. */
async function endInternal(settings) {
  await chrome.alarms.clear(GUARD_END_ALARM);
  await clearState();
  const rules = settings.focusSiteRules ?? [];
  const access = await readAccess();
  let changed = false;
  for (const dom of Object.keys(access)) {
    const rule = rules.find((r) => r.domain === dom);
    if (!rule || rule.scope !== "always") {
      await clearAccessNotifications(access[dom]);
      delete access[dom]; changed = true;
    } // moot once unguarded
  }
  if (changed) await writeAccess(access);
  await rearmAccessAlarm(await readAccess());
  // Do NOT navigate, close, or reopen any tab merely because the run ended (§8.1).
}

/** End the active run (idempotent). */
export function endFocus() {
  return serialize(async () => {
    const settings = await getSettings();
    await endInternal(settings);
    return { ok: true, status: await status(settings) };
  });
}

/** The run-end alarm fired: end an overdue run, re-arm an early one, ignore a stale one. */
export function handleGuardEndAlarm() {
  return serialize(async () => {
    const state = await readState();
    if (!state) { await chrome.alarms.clear(GUARD_END_ALARM); return; }
    if (state.endsAt == null) { await chrome.alarms.clear(GUARD_END_ALARM); return; } // open-ended
    if (state.endsAt > Date.now()) { await armEndAlarm(state); return; } // early
    await endInternal(await getSettings());
  });
}

/* --------------------------------- return URLs --------------------------------- */
async function setReturnUrl(tabId, url) {
  if (!isGuardableUrl(url)) return;
  const map = await readReturnUrls();
  if (map[tabId]?.url === url) return;
  map[tabId] = { url };
  await writeReturnUrls(map);
}

/* --------------------------- attempt + redirect (guard) ------------------------ */
/**
 * Record a blocked attempt and navigate the tab to the guard page. The guard URL
 * carries ONLY the opaque attempt id in its fragment — never the destination URL,
 * title, or domain.
 *
 * F8-R2r C1: an existing attempt for this tab whose destination + domain still match is
 * REUSED (same opaque id), so pressing Back / revisiting the same restricted site re-guards
 * without churning ids. F8-R2r C2: the redirect is transactional — if the navigation to
 * `focus.html` fails, the just-written attempt/registry entry is rolled back so it never
 * suppresses the next guard attempt (the tab may be gone, or Chrome refused the update).
 * @param {number} tabId @param {chrome.tabs.Tab} tab @param {string} url
 * @param {import("./types.js").FocusSiteRule} rule
 * @param {("initial"|"expired")} reason @param {number} [accessStartedAt]
 * @param {import("./types.js").FocusBlockedAttempt} [reuseAttempt] preserve Back/revisit semantics
 * @returns {Promise<boolean>} whether the redirect succeeded
 */
async function recordAttemptAndRedirect(tabId, tab, url, rule, reason, accessStartedAt, reuseAttempt) {
  const attemptId = reuseAttempt?.id ?? crypto.randomUUID();
  const returnUrls = await readReturnUrls();
  const safe = returnUrls[tabId]?.url;
  const attempts = await readAttempts();
  attempts[tabId] = {
    id: attemptId,
    url,
    ...(reuseAttempt?.returnUrl
      ? { returnUrl: reuseAttempt.returnUrl }
      : safe && isGuardableUrl(safe) && safe !== url ? { returnUrl: safe } : {}),
    domain: rule.domain,
    displayDomain: rule.displayDomain,
    ruleScope: rule.scope,
    reason: reuseAttempt?.reason ?? reason,
    blockedAt: reuseAttempt?.blockedAt ?? Date.now(),
    ...((reuseAttempt?.accessStartedAt ?? accessStartedAt) != null
      ? { accessStartedAt: reuseAttempt?.accessStartedAt ?? accessStartedAt } : {}),
    ...(reuseAttempt?.grantProgress ? { grantProgress: reuseAttempt.grantProgress } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    ...(tab.windowId != null ? { windowId: tab.windowId } : {}),
    ...(tab.index != null ? { index: tab.index } : {})
  };
  await writeAttempts(attempts);
  const reg = await readRegistry();
  reg[tabId] = { attemptId, windowId: tab.windowId, index: tab.index };
  await writeRegistry(reg);
  let ok = false;
  try { await chrome.tabs.update(tabId, { url: guardHashUrl(attemptId) }); ok = true; } catch { ok = false; }
  if (!ok) {
    // C2: roll back so no leftover state suppresses the next guard attempt for this tab.
    const a2 = await readAttempts();
    if (a2[tabId]?.id === attemptId) { delete a2[tabId]; await writeAttempts(a2); }
    const r2 = await readRegistry();
    if (r2[tabId]?.attemptId === attemptId) { delete r2[tabId]; await writeRegistry(r2); }
  }
  return ok;
}

/** Should this tab, at this URL, be guarded right now? Returns the matching rule or null. */
async function guardableRuleFor(url, tab, settings, state) {
  if (!(await normalWindowForTab(tab))) return null;
  if (!isGuardableUrl(url) || isOwnPage(url)) return null;
  const host = hostnameOfUrl(url);
  const rule = matchingRule(settings.focusSiteRules ?? [], host, await runIsActive(state));
  if (!rule) return null;
  const access = await readAccess();
  const rec = access[rule.domain];
  if (rec && rec.expiresAt > Date.now()) return null; // covered by an unexpired grant
  if (rec?.deferredTabId === tab.id) return null;     // active expiry grace owns this tab
  return rule;
}

/** Guard a live tab that is (again) on an applicable restricted URL. F8-R2r C1: the ONLY
 *  thing ever skipped is an EveryTab own-page URL (so we never loop on `focus.html`). If a
 *  live normal tab is back on the destination — e.g. Browser Back from the guard, or a
 *  duplicate update — re-guard it, reusing the existing attempt id when it still matches. */
async function guardTabAt(tabId, tab, url, rule) {
  const attempts = await readAttempts();
  const existing = attempts[tabId];
  const reuseAttempt = existing && existing.url === url && existing.domain === rule.domain
    ? existing : undefined;
  return recordAttemptAndRedirect(tabId, tab, url, rule, "initial", undefined, reuseAttempt);
}

/** Reactive entry from `chrome.tabs.onUpdated` (URL changes only). */
export function onTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo || !changeInfo.url) return Promise.resolve();
  return serialize(async () => {
    const live = (await getTab(tabId)) ?? tab;
    if (!live) return;
    const url = live.url || changeInfo.url;
    const deferred = await finishDeferredTab(tabId);
    if (deferred === "guarded" || deferred === "failed") return;
    // Never re-enter on our own guard page (no loop); own pages carry no destination.
    if (isOwnPage(url)) return;
    const settings = await getSettings();
    const rule = await guardableRuleFor(url, live, settings, null);
    if (!rule) {
      if (isGuardableUrl(url)) await setReturnUrl(tabId, url);
      return;
    }
    await guardTabAt(tabId, live, url, rule);
  });
}

/** Sweep already-open eligible tabs once (start of a run, or a rule change). */
async function sweepOpenTabs(state, settings) {
  const tabs = await liveNormalTabs();
  for (const t of tabs) {
    const url = t.url || "";
    if (isOwnPage(url)) continue;
    const rule = await guardableRuleFor(url, t, settings, state);
    if (!rule) {
      if (isGuardableUrl(url)) await setReturnUrl(t.id, url);
      continue;
    }
    await guardTabAt(t.id, t, url, rule);
  }
}

/** A rule/scope change: sweep newly-applicable tabs. Removed rules simply stop guarding
 *  (future navigations no longer match; existing guards degrade to "no longer blocked"). */
export function onRulesChanged() {
  return serialize(async () => {
    const settings = await getSettings();
    const state = await readState();
    const runActive = await runIsActive(state);
    const access = await readAccess();
    let changed = false;
    for (const [domain, rec] of Object.entries(access)) {
      const rule = (settings.focusSiteRules ?? []).find((candidate) =>
        candidate.domain === domain && ruleApplies(candidate, runActive));
      if (!rule) {
        await dropAccessRecord(access, domain);
        changed = true;
      }
    }
    if (changed) {
      await writeAccess(access);
      await rearmAccessAlarm(access);
    }
    await sweepOpenTabs(state, settings);
  });
}

/* --------------------------------- guard context ------------------------------- */
/**
 * The trusted context for a guard tab, resolved by its live `sender.tab.id` plus the
 * opaque attempt id. Never trusts a URL from the page. A missing/forged attempt is a
 * safe "missing" state (the page offers the dashboard), never an open redirect. After a
 * browser restart Chrome may reopen focus.html itself, so an attempt is re-keyed to the
 * new sender tab id when only its opaque id survives.
 * @param {number} senderTabId @param {string} attemptId
 */
export function guardContext(senderTabId, attemptId) {
  return serialize(async () => {
    // C10: only a live, normal, non-incognito `focus.html#<attemptId>` sender may resolve
    // or rebind an attempt. A dashboard/options/other page cannot read someone's context.
    if (!(await liveGuardTab(senderTabId, attemptId))) return { kind: "not-guard" };
    const attempts = await readAttempts();
    let a = attempts[senderTabId];
    if (!a || a.id !== attemptId) {
      // Rebind a restored focus.html tab (new tab id, same opaque attempt id) — once.
      const priorId = Object.keys(attempts).find((k) => attempts[k]?.id === attemptId);
      if (priorId == null) return { kind: "missing" };
      a = attempts[priorId];
      delete attempts[priorId];
      attempts[senderTabId] = a;
      await writeAttempts(attempts);
      const reg = await readRegistry();
      if (reg[priorId]) {
        reg[senderTabId] = { ...reg[priorId], attemptId };
        delete reg[priorId];
        await writeRegistry(reg);
      }
    }
    const settings = await getSettings();
    const state = await readState();
    const runActive = await runIsActive(state);
    const host = hostnameOfUrl(a.url);
    const rules = settings.focusSiteRules ?? [];
    // C6: describe the rule that APPLIES NOW (the same `matchingRule` navigation uses), not
    // the scope/domain captured when the attempt began. With overlapping parent/child rules
    // of opposite scope, this shows the one actually guarding the site now.
    const current = matchingRule(rules, host, runActive);
    const base = {
      displayDomain: current?.displayDomain ?? a.displayDomain,
      ruleScope: current?.scope ?? a.ruleScope,
      runActive,
      exceptionStyle: settings.focusExceptionStyle,
      pauseUnlockAt: a.blockedAt + ACCESS_PAUSE_MS,
      pauseRemainingMs: pauseRemainingMs(a.blockedAt, Date.now(), settings.focusExceptionStyle),
      grantMinutes: GRANT_MINUTES,
      hasSafeReturn: !!a.returnUrl
    };
    const access = await readAccess();
    const rec = access[current?.domain ?? a.domain];
    if (rec && rec.expiresAt > Date.now()) return { kind: "allowed", ...base };
    if (!current) {
      // No rule applies now: is there any rule for this host at all (ended) or none (unblocked)?
      const anyRule = rules.find((r) => hostMatchesDomain(host, r.domain));
      return { kind: anyRule ? "ended" : "unblocked", ...base };
    }
    return { kind: a.reason, ...base, ...(a.reason === "expired" ? { accessStartedAt: a.accessStartedAt } : {}) };
  });
}

/* --------------------------------- guard actions ------------------------------- */
async function attemptFor(senderTabId, attemptId) {
  const attempts = await readAttempts();
  const a = attempts[senderTabId];
  return a && a.id === attemptId ? { attempts, a } : null;
}
/**
 * C10 + attempt resolution for a page-originated action: the sender must be a live guard
 * tab AND own the attempt. Returns `{attempts, a}` or a stable failure reason.
 */
async function resolveAction(senderTabId, attemptId) {
  const tab = await liveGuardTab(senderTabId, attemptId);
  if (!tab) return { fail: "not-guard" };
  const found = await attemptFor(senderTabId, attemptId);
  if (!found) return { fail: "invalid" };
  return { ...found, tab };
}
async function dropAttempt(attempts, senderTabId) {
  delete attempts[senderTabId];
  await writeAttempts(attempts);
  const reg = await readRegistry();
  if (reg[senderTabId]) { delete reg[senderTabId]; await writeRegistry(reg); }
}
/** Re-read the current attempts map + drop this tab's attempt (used after a navigation
 *  succeeds, so we consume the CURRENT map rather than a stale snapshot). */
async function consumeAttempt(senderTabId) {
  const attempts = await readAttempts();
  await dropAttempt(attempts, senderTabId);
}
async function navigateTab(tabId, url) {
  try { await chrome.tabs.update(tabId, { url }); return true; } catch { return false; }
}

/**
 * Grant temporary access to the CURRENT applicable rule's canonical domain and reopen the
 * recorded destination in the acted tab. Preserves `accessStartedAt` (cumulative) and never
 * shortens a longer existing grant made from another tab.
 *
 * F8-R2r C6: revalidate the current settings/run first — if the site is no longer blocked,
 * do not create a stale grant; just open the recorded site. F8-R2r C2: create the access
 * record, NAVIGATE, then consume the attempt; a failed navigation returns a stable failure
 * and leaves the guard usable (attempt + access intact).
 * @param {number} senderTabId @param {string} attemptId @param {number} minutes
 */
export function grantAccess(senderTabId, attemptId, minutes) {
  return serialize(async () => {
    const found = await resolveAction(senderTabId, attemptId);
    if (found.fail) return { ok: false, reason: found.fail };
    if (!isValidGrantMinutes(minutes)) return { ok: false, reason: "invalid-minutes" };
    const dest = found.a.url;
    if (found.a.grantProgress) {
      // The grant already committed. A retry is navigation-only, even if the user presses
      // a duration again after an earlier navigation failure.
      const progress = found.a.grantProgress;
      const access = await readAccess();
      const currentAccess = access[progress.domain];
      if (!currentAccess || currentAccess.expiresAt < progress.expiresAt) {
        access[progress.domain] = { ...progress };
        await writeAccess(access);
        if (currentAccess) await clearAccessNotifications(currentAccess);
      }
      await rearmAccessAlarm(access);
      if (isGuardableUrl(dest) && !(await navigateTab(senderTabId, dest))) {
        return { ok: false, reason: "nav-failed" };
      }
      await consumeAttempt(senderTabId);
      return { ok: true };
    }
    const settings = await getSettings();
    const state = await readState();
    const runActive = await runIsActive(state);
    const host = hostnameOfUrl(dest);
    const current = matchingRule(settings.focusSiteRules ?? [], host, runActive);
    if (!current) {
      // C6: no longer blocked — never write a stale access record; just open the site.
      if (isGuardableUrl(dest)) {
        if (!(await navigateTab(senderTabId, dest))) return { ok: false, reason: "nav-failed" };
      }
      await consumeAttempt(senderTabId);
      return { ok: true, notBlocked: true };
    }
    if (!accessUnlocked(found.a.blockedAt, Date.now(), settings.focusExceptionStyle)) {
      return { ok: false, reason: "locked" };
    }
    const now = Date.now();
    const access = await readAccess();
    const prev = access[current.domain];
    const accessStartedAt = prev?.accessStartedAt ?? found.a.accessStartedAt ?? now; // cumulative
    const base = Math.max(prev && prev.expiresAt > now ? prev.expiresAt : now, now); // never shorten
    const grantProgress = {
      domain: current.domain, accessStartedAt,
      expiresAt: base + Number(minutes) * 60000, grantedMinutes: Number(minutes)
    };
    const priorNotification = prev && prev.expiresAt !== grantProgress.expiresAt ? prev : null;
    access[current.domain] = grantProgress;
    found.attempts[senderTabId] = { ...found.a, grantProgress };
    // The access record and its attempt-level progress commit together. Once this write is
    // visible, every retry is navigation-only and preserves the exact expiry.
    await chrome.storage.local.set({ [ACCESS_KEY]: access, [ATTEMPTS_KEY]: found.attempts });
    if (priorNotification) await clearAccessNotifications(priorNotification);
    await rearmAccessAlarm(access);
    if (isGuardableUrl(dest) && !(await navigateTab(senderTabId, dest))) {
      return { ok: false, reason: "nav-failed" };
    }
    await consumeAttempt(senderTabId);
    return { ok: true };
  });
}

/** True when a notification belongs to the Focus temporary-access warning flow. */
export function isAccessNotification(id) {
  return typeof id === "string" &&
    (id.startsWith(ACCESS_WARNING_NOTIFICATION_PREFIX) ||
      id.startsWith(ACCESS_ENDED_NOTIFICATION_PREFIX));
}

/**
 * Add five minutes to a live access record from its current boundary. The expected
 * boundary belongs to the rendered control: if another surface extended first, this
 * request returns stale instead of replaying an old click. Calling again with the new
 * boundary is intentional and may be repeated without a fixed cap.
 */
async function extendFocusAccessInternal(domain, expectedExpiresAt) {
  const access = await readAccess();
  const rec = typeof domain === "string" ? access[domain] : null;
  if (!rec || !Number.isFinite(rec.expiresAt)) return { ok: false, reason: "missing" };
  if (!Number.isFinite(expectedExpiresAt) || rec.expiresAt !== expectedExpiresAt) {
    return { ok: false, reason: "stale", expiresAt: rec.expiresAt };
  }
  const settings = await getSettings();
  const runActive = await runIsActive(await readState());
  const rule = (settings.focusSiteRules ?? []).find((candidate) =>
    candidate.domain === domain && ruleApplies(candidate, runActive));
  if (!rule) {
    await clearAccessNotifications(rec);
    delete access[domain];
    await writeAccess(access);
    await rearmAccessAlarm(access);
    return { ok: false, reason: "unblocked" };
  }
  const now = Date.now();
  const {
    warnedForExpiresAt: _warned,
    deferredTabId: _deferredTab,
    deferredAt: _deferredAt,
    retryAt: _retryAt,
    retryCount: _retryCount,
    ...stable
  } = rec;
  const next = {
    ...stable,
    expiresAt: Math.max(now, rec.expiresAt) + ACCESS_NOTIFICATION_EXTENSION_MS,
    grantedMinutes: 5
  };
  access[domain] = next;
  await writeAccess(access); // state before notification cleanup / alarm effects
  await clearAccessNotifications(rec);
  await rearmAccessAlarm(access);
  return { ok: true, expiresAt: next.expiresAt };
}

export function extendFocusAccess(domain, expectedExpiresAt) {
  return serialize(() => extendFocusAccessInternal(domain, Number(expectedExpiresAt)));
}

/**
 * End one rendered temporary-access grant deliberately. Unlike automatic expiry, this
 * explicit action has no foreground deferral: every live matching tab is returned to the
 * existing expired-access guard with its cumulative access origin. State is revoked before
 * navigation side effects, so a worker interruption cannot leave a continuing grant.
 */
async function stopFocusAccessInternal(domain, expectedExpiresAt) {
  const access = await readAccess();
  const rec = typeof domain === "string" ? access[domain] : null;
  if (!rec || !Number.isFinite(rec.expiresAt)) return { ok: false, reason: "missing" };
  if (!Number.isFinite(expectedExpiresAt) || rec.expiresAt !== expectedExpiresAt) {
    return { ok: false, reason: "stale", expiresAt: rec.expiresAt };
  }
  const settings = await getSettings();
  const state = await readState();
  const runActive = await runIsActive(state);
  const rule = (settings.focusSiteRules ?? []).find((candidate) =>
    candidate.domain === domain && ruleApplies(candidate, runActive));

  delete access[domain];
  await writeAccess(access); // revoke first; redirect effects are best effort
  await rearmAccessAlarm(access);
  await clearAccessNotifications(rec);
  if (!rule) return { ok: true, guardedCount: 0, failedCount: 0 };

  let guardedCount = 0;
  let failedCount = 0;
  for (const tab of await liveNormalTabs()) {
    const url = tab.url || "";
    if (!isGuardableUrl(url) || isOwnPage(url) ||
        !hostMatchesDomain(hostnameOfUrl(url), domain)) continue;
    const redirected = await recordAttemptAndRedirect(
      tab.id, tab, url, rule, "expired", rec.accessStartedAt);
    if (redirected) guardedCount += 1; else failedCount += 1;
  }
  return { ok: true, guardedCount, failedCount };
}

export function stopFocusAccess(domain, expectedExpiresAt) {
  return serialize(() => stopFocusAccessInternal(domain, Number(expectedExpiresAt)));
}

async function extendAccessFromWarning(notificationId) {
  const parsed = parseAccessWarningNotificationId(notificationId);
  if (!parsed) return { handled: false };
  const result = await extendFocusAccessInternal(parsed.domain, parsed.expiresAt);
  if (!result.ok) {
    await clearNotification(notificationId);
    return { handled: true, extended: false, reason: result.reason };
  }
  return { handled: true, extended: true, expiresAt: result.expiresAt };
}

/**
 * The warning's one action adds five minutes to the exact access period represented by
 * the notification. A stale notification cannot extend a newer period. The extension is
 * domain-wide, preserves the cumulative access origin, and also releases a deferred live
 * tab if the click arrives just after expiry.
 */
export function onAccessNotificationButton(notificationId, buttonIndex) {
  return serialize(async () => {
    if (buttonIndex !== 0) return { handled: false };
    return extendAccessFromWarning(notificationId);
  });
}

/** Native macOS notifications may omit Chrome's custom button. The warning copy names
 * this explicit fallback, so activating the non-button body performs the same exact,
 * stale-safe extension instead of silently opening Settings. */
export function onAccessNotificationClicked(notificationId) {
  return serialize(() => extendAccessFromWarning(notificationId));
}

/** Initial guard's safe return: navigate to the validated previous URL, else the dashboard.
 *  C2: navigate first; only consume the attempt after the navigation succeeds. */
export function safeReturn(senderTabId, attemptId) {
  return serialize(async () => {
    const found = await resolveAction(senderTabId, attemptId);
    if (found.fail) return { ok: false, reason: found.fail };
    const dest = found.a.returnUrl && isGuardableUrl(found.a.returnUrl) ? found.a.returnUrl : dashboardUrl();
    if (!(await navigateTab(senderTabId, dest))) return { ok: false, reason: "nav-failed" };
    await consumeAttempt(senderTabId);
    return { ok: true };
  });
}

/** "Continue to site" for an ended/unblocked/allowed guard: navigate to the destination.
 *  C2: navigate first; only consume the attempt after the navigation succeeds. */
export function continueToSite(senderTabId, attemptId) {
  return serialize(async () => {
    const found = await resolveAction(senderTabId, attemptId);
    if (found.fail) return { ok: false, reason: found.fail };
    const dest = isGuardableUrl(found.a.url) ? found.a.url : dashboardUrl();
    if (!(await navigateTab(senderTabId, dest))) return { ok: false, reason: "nav-failed" };
    await consumeAttempt(senderTabId);
    return { ok: true };
  });
}

/** Close the guard tab; if it is the last tab in its window, replace it with the
 *  dashboard so the window never disappears. */
async function closeOrReplace(expectedTab) {
  const wtabs = await chrome.tabs.query({ windowId: expectedTab.windowId });
  if (!(await normalWindowForTab(expectedTab))) return false;
  // Saving and querying the window both yield to navigation. Check the exact
  // sender snapshot after those awaits, for removal and last-tab replacement.
  const current = await getTab(expectedTab.id);
  if (!current) return true; // already gone
  if (!sameLiveTabCloseIdentity(expectedTab, current)) return false;
  if (wtabs.length <= 1) return navigateTab(current.id, dashboardUrl());
  try { await chrome.tabs.remove(current.id); return true; } catch { return false; }
}

/** After a domain's guard tab leaves, drop its access record if no matching tab remains.
 *  F8-R2r C4: NEVER clear a still-live grant (`expiresAt > now`) from stale cleanup — an old
 *  guard closing or an old `onRemoved` event must not destroy a newer grant while its
 *  destination tab is still navigating or momentarily on the guard page. A live grant that
 *  outlives its tabs is harmless: the expiry pass removes it (with no tab) at its due time. */
async function cleanupAccessIfNoTabs(domain) {
  const access = await readAccess();
  const rec = access[domain];
  if (!rec) return;
  if (rec.expiresAt > Date.now()) return; // C4: live grant — leave it to the expiry alarm
  const tabs = await liveNormalTabs();
  const stillOn = tabs.some((t) => hostMatchesDomain(hostnameOfUrl(t.url || ""), domain));
  if (!stillOn) {
    await dropAccessRecord(access, domain);
    await writeAccess(access);
    await rearmAccessAlarm(access);
  }
}

/**
 * The Return/Leave decision. `save` false = explicit discard (zero Inbox writes).
 * `save` true = save the recorded destination to Inbox, and ONLY then close. A failed
 * save keeps the guard open. Nothing is ever saved or closed automatically.
 *
 * F8-R2r C3: the save is idempotent per attempt. The stable inbox item id is the attempt's
 * own opaque id, and `saveRefToInbox` is a no-op when that item already exists. So a retry
 * after a Save-succeeded-but-Close-failed (or a failure between the Inbox write and the
 * acknowledgement) reuses the SAME item — never a second item, journal entry, or counter
 * effect. A failed save keeps the guard open and never falls back to close-without-saving.
 * @param {number} senderTabId @param {string} attemptId @param {boolean} save
 */
export function returnAndClose(senderTabId, attemptId, save) {
  return serialize(async () => {
    const found = await resolveAction(senderTabId, attemptId);
    if (found.fail) return { ok: false, reason: found.fail };
    const a = found.a;
    if (save) {
      if (!isGuardableUrl(a.url)) return { ok: false, reason: "unsaveable" };
      try {
        // C3: attempt id doubles as the stable, idempotent inbox item id for this save.
        await saveRefToInbox({ url: a.url, title: a.title || a.url, favIconUrl: a.favIconUrl }, { id: a.id });
      } catch {
        return { ok: false, reason: "save-failed" }; // keep the guard open, never close after a failed save
      }
    }
    const closed = await closeOrReplace(found.tab);
    if (!closed) return { ok: false, reason: "close-failed", saved: !!save };
    await consumeAttempt(senderTabId);
    await cleanupAccessIfNoTabs(a.domain);
    return { ok: true, saved: !!save };
  });
}

/* ----------------------- warning, expiry, and active deferral ------------------ */
async function dropAccessRecord(access, domain) {
  const rec = access[domain];
  if (!rec) return;
  await clearAccessNotifications(rec);
  delete access[domain];
}

/**
 * Complete a deferred expiry when its tab is activated or navigates. The live URL and
 * current rule are revalidated. Leaving the domain simply retires the deferral; remaining
 * on it creates the normal expired guard attempt with cumulative access copy.
 * @returns {Promise<"none"|"cleared"|"guarded"|"failed">}
 */
async function finishDeferredTab(tabId) {
  const access = await readAccess();
  const found = Object.entries(access).find(([, rec]) => rec.deferredTabId === tabId);
  if (!found) return "none";
  const [domain, rec] = found;
  const tab = await getTab(tabId);
  const url = tab?.url || tab?.pendingUrl || "";
  const settings = await getSettings();
  const runActive = await runIsActive(await readState());
  const rule = matchingRule(settings.focusSiteRules ?? [], hostnameOfUrl(url), runActive);
  const stillDeferred = !!tab && !!(await normalWindowForTab(tab)) &&
    isGuardableUrl(url) && !isOwnPage(url) && rule?.domain === domain &&
    rec.expiresAt <= Date.now();
  if (!stillDeferred) {
    await dropAccessRecord(access, domain);
    await writeAccess(access);
    await rearmAccessAlarm(access);
    return "cleared";
  }
  const redirected = await recordAttemptAndRedirect(
    tabId, tab, url, rule, "expired", rec.accessStartedAt);
  if (!redirected) return "failed"; // keep the live page; never retry over active typing
  await dropAccessRecord(access, domain);
  await writeAccess(access);
  await rearmAccessAlarm(access);
  return "guarded";
}

/** A deferred page is guarded only when the person deliberately activates it again. */
export function onTabActivated(tabId) {
  return serialize(() => finishDeferredTab(tabId));
}

/**
 * One access alarm owns the warning boundary, exact expiry, and bounded background retry.
 * The currently used matching tab is never navigated at expiry. It remains represented by
 * the expired record until activation/navigation completes the deferred guard.
 */
async function processAccessTimeline() {
  const now = Date.now();
  const access = await readAccess();
  const settings = await getSettings();
  const runActive = await runIsActive(await readState());
  let changed = false;
  const dueWarnings = [];
  const dueEnded = [];

  // First retire grants whose rule no longer applies and publish due warnings. Mark a
  // warning attempted even when the OS suppresses it, so a failed notification cannot
  // spin the one alarm and delay the real expiry.
  for (const [domain, rec] of Object.entries(access)) {
    const anyRule = (settings.focusSiteRules ?? []).find((r) => r.domain === rec.domain);
    const stillGuarded = anyRule && ruleApplies(anyRule, runActive);
    if (!stillGuarded) {
      await dropAccessRecord(access, domain);
      changed = true;
      continue;
    }
    if (rec.expiresAt > now && rec.warnedForExpiresAt !== rec.expiresAt &&
        rec.expiresAt - now <= ACCESS_WARNING_MS) {
      access[domain] = { ...rec, warnedForExpiresAt: rec.expiresAt };
      dueWarnings.push({ rec: access[domain], displayDomain: anyRule.displayDomain || rec.domain });
      changed = true;
    }
  }

  const expired = Object.values(access).filter((rec) =>
    rec.expiresAt <= now && (rec.retryAt == null || rec.retryAt <= now));
  if (expired.length === 0) {
    if (changed) await writeAccess(access);
    for (const warning of dueWarnings) {
      await notifyAccessWarning(warning.rec, warning.displayDomain, now);
    }
    await rearmAccessAlarm(access);
    return;
  }

  const tabs = await liveNormalTabs();
  const foreground = await currentTab();
  for (const original of expired) {
    const rec = access[original.domain];
    if (!rec || rec.expiresAt !== original.expiresAt) continue;
    const anyRule = (settings.focusSiteRules ?? []).find((r) => r.domain === rec.domain);
    const stillGuarded = anyRule && ruleApplies(anyRule, runActive);
    if (!stillGuarded) {
      await dropAccessRecord(access, rec.domain);
      changed = true;
      continue;
    }

    const matches = (tab) => {
      const url = tab?.url || "";
      return isGuardableUrl(url) && !isOwnPage(url) &&
        hostMatchesDomain(hostnameOfUrl(url), rec.domain);
    };
    const previousDeferred = rec.deferredTabId;
    let deferredTabId = previousDeferred != null && matches(tabs.find((t) => t.id === previousDeferred))
      ? previousDeferred : null;
    if (previousDeferred != null && deferredTabId == null) {
      await clearNotification(accessEndedNotificationId(rec.domain, rec.expiresAt, previousDeferred));
    }
    // Only the first expiry decision may select a foreground exception. A retry cannot
    // move the exception to whichever tab happens to be foreground later.
    if (previousDeferred == null && foreground && matches(foreground)) {
      deferredTabId = foreground.id;
    }

    let needsRetry = false;
    for (const t of tabs) {
      if (!matches(t) || t.id === deferredTabId) continue;
      const redirected = await recordAttemptAndRedirect(
        t.id, t, t.url, anyRule, "expired", rec.accessStartedAt);
      if (!redirected) {
        const live = await getTab(t.id);
        if (live && await normalWindowForTab(live) && matches(live)) {
          needsRetry = true;
        }
      }
    }

    await clearNotification(accessWarningNotificationId(rec.domain, rec.expiresAt));
    const next = {
      domain: rec.domain,
      accessStartedAt: rec.accessStartedAt,
      expiresAt: rec.expiresAt,
      grantedMinutes: rec.grantedMinutes,
      warnedForExpiresAt: rec.expiresAt,
      ...(deferredTabId != null
        ? { deferredTabId, deferredAt: rec.deferredAt ?? now }
        : {})
    };
    if (needsRetry) {
      const retryCount = Number(rec.retryCount ?? 0) + 1;
      const delay = Math.min(EXPIRY_RETRY_MAX_MS,
        EXPIRY_RETRY_BASE_MS * (2 ** Math.min(retryCount - 1, 4)));
      next.retryCount = retryCount;
      next.retryAt = now + delay;
    }
    if (deferredTabId != null || needsRetry) {
      access[rec.domain] = next;
      if (previousDeferred == null && deferredTabId != null) dueEnded.push(next);
    } else {
      delete access[rec.domain]; // the attempt carries accessStartedAt for cumulative copy
    }
    changed = true;
  }
  if (changed) await writeAccess(access);
  for (const warning of dueWarnings) {
    await notifyAccessWarning(warning.rec, warning.displayDomain, now);
  }
  for (const ended of dueEnded) await notifyAccessEnded(ended);
  await rearmAccessAlarm(access);
}

/** The access warning/expiry/retry alarm fired. */
export function handleAccessAlarm() {
  return serialize(processAccessTimeline);
}

/* ------------------------------ tab-removed cleanup ---------------------------- */
/** A tab closed: drop its attempt/return-url/registry (unless within the reload grace),
 *  and drop the domain's access if no matching tab remains. */
export function onTabRemoved(tabId) {
  // Capture the synchronous lifecycle claim at event delivery. Persisted grace may still
  // be waiting on storage when Chrome tears down the old extension page.
  const teardownClaimed = hasLifecycleClaim();
  return serialize(async () => {
    const returnUrls = await readReturnUrls();
    if (returnUrls[tabId]) { delete returnUrls[tabId]; await writeReturnUrls(returnUrls); }
    const access = await readAccess();
    const deferred = Object.entries(access).find(([, rec]) => rec.deferredTabId === tabId);
    if (deferred) {
      await dropAccessRecord(access, deferred[0]);
      await writeAccess(access);
      await rearmAccessAlarm(access);
    }
    if (teardownClaimed || await inGuardGrace()) return;
    const attempts = await readAttempts();
    const a = attempts[tabId];
    if (a) {
      delete attempts[tabId];
      await writeAttempts(attempts);
      const reg = await readRegistry();
      if (reg[tabId]) { delete reg[tabId]; await writeRegistry(reg); }
      await cleanupAccessIfNoTabs(a.domain);
    }
  });
}

/* ------------------------------- reload / recovery ----------------------------- */
/**
 * F8-R2r C5: lifecycle arbitration. `onInstalled` (reload/install) and `onStartup` (full
 * browser start) claim recovery SYNCHRONOUSLY so the deferred generic worker-spin recovery
 * yields and can never prune an attempt that reload/full-start recovery can still rebind or
 * recreate.
 */
let lifecycleClaimUntil = 0;
function hasLifecycleClaim() { return Date.now() < lifecycleClaimUntil; }
export function claimGuardLifecycle() { lifecycleClaimUntil = Date.now() + GRACE_MS; }
/** Deferred generic worker recovery: yields if a reload/startup claim has fired. */
export function scheduleGuardWorkerRecovery(delayMs = 1500) {
  setTimeout(() => { if (!hasLifecycleClaim()) void recoverGuard(); }, delayMs);
}

/** Open the guard-recovery grace window. Separate from the suspend registry/grace. */
export async function markGuardGrace() {
  await chrome.storage.local.set({ [GUARD_GRACE_KEY]: Date.now() + GRACE_MS });
  lifecycleClaimUntil = 0; // persisted grace now owns teardown protection
}
async function inGuardGrace() {
  if (hasLifecycleClaim()) return true;
  const until = await readKey(GUARD_GRACE_KEY, 0);
  return Date.now() < until;
}

/** Opaque attempt ids carried by LIVE, non-incognito focus.html tabs (any tab id). */
function liveGuardAttempts(tabs) {
  const m = new Map();
  for (const t of tabs) {
    if (t.incognito) continue;
    const aid = guardAttemptIdOfUrl(t.url) || guardAttemptIdOfUrl(t.pendingUrl);
    if (aid) m.set(aid, t);
  }
  return m;
}

/**
 * C5: a full browser restart brings our `focus.html#<id>` tabs back with NEW tab ids.
 * Re-key each attempt/registry entry to the live tab that carries the same opaque id — once,
 * with no duplicate — BEFORE any prune, so generic recovery cannot drop a rebindable record.
 */
async function reconcileLiveGuards() {
  const tabs = await liveNormalTabs();
  const liveByAttempt = liveGuardAttempts(tabs);
  if (liveByAttempt.size === 0) return;
  const attempts = await readAttempts();
  const reg = await readRegistry();
  let ca = false; let cg = false;
  for (const oldId of Object.keys(attempts)) {
    const a = attempts[oldId];
    const t = liveByAttempt.get(a?.id);
    if (!t || t.id === Number(oldId)) continue;
    if (attempts[t.id]?.id !== a.id) { attempts[t.id] = a; }
    delete attempts[oldId]; ca = true;
    reg[t.id] = { attemptId: a.id, windowId: t.windowId, index: t.index };
    if (reg[oldId] && Number(oldId) !== t.id) { delete reg[oldId]; }
    cg = true;
  }
  if (ca) await writeAttempts(attempts);
  if (cg) await writeRegistry(reg);
}

/** Prune records for genuinely dead tabs. C5: keeps returnUrls harmless; keeps any attempt
 *  whose opaque id still identifies a LIVE guard tab (full-restart survivor), and skips
 *  attempt/registry pruning entirely during the reload grace (recovery may recreate them). */
async function pruneStale() {
  const allTabs = await chrome.tabs.query({});
  const tabs = await liveNormalTabs();
  const liveAll = new Set(allTabs.map((t) => t.id));
  const live = new Set(tabs.map((t) => t.id));
  const returnUrls = await readReturnUrls();
  let cr = false;
  for (const id of Object.keys(returnUrls)) if (!liveAll.has(Number(id))) { delete returnUrls[id]; cr = true; }
  if (cr) await writeReturnUrls(returnUrls);
  if (await inGuardGrace()) return; // reload/full-start recovery may still rebind/recreate
  const liveAttemptIds = new Set(liveGuardAttempts(tabs).keys());
  const attempts = await readAttempts();
  const reg = await readRegistry();
  let ca = false; let cg = false;
  for (const id of Object.keys(attempts)) {
    if (!live.has(Number(id)) && !liveAttemptIds.has(attempts[id]?.id)) { delete attempts[id]; ca = true; }
  }
  for (const id of Object.keys(reg)) {
    if (!live.has(Number(id)) && !liveAttemptIds.has(reg[id]?.attemptId)) { delete reg[id]; cg = true; }
  }
  if (ca) await writeAttempts(attempts);
  if (cg) await writeRegistry(reg);
}

/** Is this attempt still guardable now (rule applies + not covered by a live grant)? */
async function attemptStillApplicable(a, settings, runActive, access) {
  const host = hostnameOfUrl(a?.url || "");
  const rule = matchingRule(settings.focusSiteRules ?? [], host, runActive);
  if (!rule) return false;                                  // rule removed / During-Focus run ended
  const rec = access[rule.domain];
  if (rec && rec.expiresAt > Date.now()) return false;      // now covered by a live grant
  return true;
}

/**
 * Recreate guard tabs that Chrome closed during an extension RELOAD. Only runs inside the
 * reload grace (C5: never recreate a guard the user closed themselves). For each registry
 * entry whose tab is gone and whose opaque id is not already live, recreate ONLY when the
 * attempt is still applicable (rule applies now, no live grant) and its window survives and
 * is NORMAL + NON-INCOGNITO; otherwise drop it. Re-keys to the new tab id. Serialized +
 * idempotent over the immediate / 2s / 8s passes.
 */
export function recoverGuardTabs() {
  return serialize(async () => {
    if (!(await inGuardGrace())) return; // recreation is a reload-only decision
    await reconcileLiveGuards();         // rebind full-restart survivors first (no duplicate)
    const reg = await readRegistry();
    const attempts = await readAttempts();
    const tabs = await liveNormalTabs();
    const live = new Set(tabs.map((t) => t.id));
    const liveAttemptIds = new Set(liveGuardAttempts(tabs).keys());
    const normalWins = new Set(
      (await chrome.windows.getAll({})).filter((w) => !w.incognito && w.type === "normal").map((w) => w.id)
    );
    const settings = await getSettings();
    const runActive = await runIsActive(await readState());
    const access = await readAccess();
    for (const oldId of Object.keys(reg)) {
      const entry = reg[oldId];
      if (live.has(Number(oldId))) continue;                  // still open
      if (liveAttemptIds.has(entry.attemptId)) continue;      // already restored elsewhere
      const a = attempts[oldId];
      if (!a || a.id !== entry.attemptId) { delete reg[oldId]; continue; } // nothing to restore
      // C5: drop (never recreate) a guard whose rule was removed / run ended / is now allowed,
      // or whose target window is gone or incognito.
      const applicable = await attemptStillApplicable(a, settings, runActive, access);
      if (!applicable || entry.windowId == null || !normalWins.has(entry.windowId)) {
        delete reg[oldId]; delete attempts[oldId]; continue;
      }
      let created;
      try {
        created = await chrome.tabs.create({
          url: guardHashUrl(entry.attemptId),
          windowId: entry.windowId,
          ...(entry.index != null ? { index: entry.index } : {}),
          active: false
        });
      } catch { continue; }
      delete reg[oldId];
      delete attempts[oldId];
      if (created?.id != null && !created.incognito) {
        reg[created.id] = { attemptId: entry.attemptId, windowId: created.windowId, index: created.index };
        attempts[created.id] = a;
      }
    }
    await writeRegistry(reg);
    await writeAttempts(attempts);
  });
}

/* --------------------------------- messaging ---------------------------------- */
/**
 * Route the F8-R2 site-guard messages. All page-originated actions (context/grant/
 * safe-return/continue/return-close) are keyed to the live `sender.tab.id` plus the
 * opaque attempt id, so a cross-tab or forged request is rejected. Returns true when it
 * handled the message (a response is pending). Every path resolves a stable shape.
 * @param {any} msg @param {chrome.runtime.MessageSender} sender @param {(r:any)=>void} sendResponse
 */
export function handleFocusGuardMessage(msg, sender, sendResponse) {
  const tabId = sender?.tab?.id;
  const settle = (p) => { p.then(sendResponse, () => sendResponse({ ok: false, reason: "unavailable" })); return true; };
  const needTab = (fn) => {
    if (tabId == null) { sendResponse({ ok: false, reason: "no-tab" }); return true; }
    return settle(fn(tabId));
  };
  switch (msg?.type) {
    case "focus-guard-status":
      return settle(getGuardStatus().then((s) => ({ ok: true, status: s })));
    case "focus-guard-start":
      return settle(startFocus({ endChoice: msg.endChoice }));
    case "focus-guard-end":
      return settle(endFocus());
    case "focus-guard-extend-access":
      return settle(extendFocusAccess(msg.domain, msg.expectedExpiresAt));
    case "focus-guard-stop-access":
      return settle(stopFocusAccess(msg.domain, msg.expectedExpiresAt));
    case "focus-guard-context":
      return needTab((id) => guardContext(id, msg.attemptId).then((ctx) => ({ ok: true, context: ctx })));
    case "focus-guard-grant":
      return needTab((id) => grantAccess(id, msg.attemptId, msg.minutes));
    case "focus-guard-safe-return":
      return needTab((id) => safeReturn(id, msg.attemptId));
    case "focus-guard-continue":
      return needTab((id) => continueToSite(id, msg.attemptId));
    case "focus-guard-return-close":
      return needTab((id) => returnAndClose(id, msg.attemptId, !!msg.save));
    default:
      return false;
  }
}

/**
 * Worker restart / extension reload / full browser start recovery: repair a missing
 * run-end alarm (or end an overdue run), reconcile the access warning/expiry timeline,
 * and prune stale operational records. Open-ended runs stay active; an overdue timed run
 * ends. Serialized and idempotent.
 */
export function recoverGuard() {
  return serialize(async () => {
    const state = await readState();
    if (state) {
      if (state.endsAt != null && state.endsAt <= Date.now()) await endInternal(await getSettings());
      else await armEndAlarm(state);
    }
    await processAccessTimeline();
    await reconcileLiveGuards();  // C5: rebind full-restart survivors BEFORE any prune
    await pruneStale();
  });
}
