// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

export const SCHEMA_VERSION = 1;

/**
 * Merge metadata carried by every persisted record (PRD §4).
 * @typedef {Object} Meta
 * @property {string} id
 * @property {string} deviceId
 * @property {number} createdAt
 * @property {number} modifiedAt
 * @property {number} schemaVersion
 * @property {number} [deletedAt] Tombstone: set instead of hard-deleting, so deletions merge across devices.
 */

/**
 * @typedef {Object} TabRef
 * @property {string} url
 * @property {string} title
 * @property {string} [favIconUrl]
 * @property {boolean} [pinned]
 * @property {string[]} [labels] P2g-2 (N11/U9): labels at TRUE tab grain. Additive —
 *   refs written before this field simply lack it; item-level `labels` stays valid
 *   as the legacy grain and both grains are counted everywhere.
 * @property {number} [groupIndex] F18: index into its window's group templates
 *   (`Session.groups[windowIndex]`), first-seen tab order. Absent = ungrouped.
 *   Pinned tabs never carry it (Chrome forbids grouping pinned tabs). Additive.
 */

/**
 * F18 — one saved Chrome tab group (per window, first-seen order). All fields are
 * optional: membership rides on `TabRef.groupIndex`, so a group captured without the
 * `tabGroups` permission is an empty `{}` (membership only). Additive.
 * @typedef {Object} GroupTemplate
 * @property {string} [title]
 * @property {string} [color] a Chrome tab-group color name (grey/blue/red/…)
 * @property {boolean} [collapsed]
 */

/** @typedef {"dump" | "auto-archive" | "dedup" | "manual" | "snooze"} InboxSource */

/**
 * Inbox item: a loose tab or a window bundle (PRD §3.3).
 * kind "window" preserves a whole window as a unit; restore opens a new window.
 * archivedAt is set when the item moves Inbox → Archive (M4 expiry).
 * @typedef {Meta & {kind: ("tab"|"window"), tabs: TabRef[], source: InboxSource, labels: string[], windowTitle?: string, archivedAt?: number}} InboxItem
 */

/**
 * @typedef {Meta & {name: string, auto: boolean, windows: TabRef[][], labels: string[], groups?: GroupTemplate[][]}} Session
 * auto=true for periodic snapshots, false for named manual sessions.
 * F18: `groups` is additive and per-window, aligned to `windows` by index —
 * `groups[wi]` holds window `wi`'s saved tab groups in first-seen order. Present
 * only when at least one window had a group; a group-less window is `[]`. Absent
 * on pre-F18 sessions, which therefore restore exactly as before. Stored here
 * (not on a window object) because a session window is a bare `TabRef[]`.
 */

/** @typedef {Meta & {name: string, tabs: TabRef[], labels: string[]}} Collection */

/**
 * F22 — one stable Home shortcut. The id is derived from the canonical URL so
 * two devices starring the same page converge on one Vault record.
 * @typedef {Meta & {url: string, title: string, favIconUrl?: string, position: number}} StarredTab
 */

/**
 * @typedef {Meta & {url: string, title: string, favIconUrl?: string, dueAt: number, tabs?: TabRef[], recurrence?: string, claimedBy?: string, firedAt?: number, sessionId?: string}} Snooze
 * claimedBy is a reserved legacy field for the deferred any-device mode.
 * tabs (P2b-1): full saved TabRefs for a whole-window snooze or a saved single-tab
 * transfer. A window has `title`="Window (N tabs)" and `url`=""; a metadata-carrying
 * single also retains its scalar url/title projection. Scalar single-tab Snoozes
 * (url/title, no tabs) remain a supported record shape.
 * sessionId (P2g-5): a SESSION snooze — a scheduled "Restore all" referencing the
 * session by id (the session is a template: never mutated or consumed; it is read
 * live at fire time). `title` carries the session name at creation for display
 * fallback, `url`="". Additive.
 */

/**
 * Device-local Snooze browser-effect ownership (key `snoozeDeliveryReceipts`).
 * Excluded from Export and Vault. An `effects` phase is persisted before Chrome
 * opens anything; a later worker changes it to `incomplete` rather than replaying
 * an effect whose outcome cannot be observed safely.
 * @typedef {Object} SnoozeDeliveryReceipt
 * @property {string} snoozeId @property {string} claimId
 * @property {string} ownerDeviceId @property {string} ownerInstanceId
 * @property {number} occurrenceDueAt @property {number} sourceModifiedAt
 * @property {number[]} [selectionIndexes] claimed tab occurrences for bulk Wake
 * @property {number} claimedAt
 * @property {"effects"|"complete"|"incomplete"} phase
 * @property {number} [completedAt] @property {number} [opened]
 * @property {"worker-stopped"|"partial-browser-effect"|"ambiguous-browser-effect"|"source-changed"} [reason]
 */

/**
 * Device-local source placement for a single-tab Snooze (key
 * `snoozePlacements`). Excluded from Export and Vault. `peerUrls` identify a
 * restored source window after Chrome replaces numeric window ids.
 * @typedef {Object} SnoozePlacement
 * @property {string} snoozeId @property {number} occurrenceDueAt
 * @property {number} sourceWindowId @property {number} index
 * @property {boolean} pinned @property {string[]} peerUrls
 * @property {string} [browserSessionId] @property {number} capturedAt
 */

/**
 * F8 (Focus Mode) — one blocked-site rule. `domain` is the ASCII canonical
 * hostname used for comparison (leading `www.` stripped, IDN punycoded);
 * `displayDomain` is the safe form shown in the UI. `scope` "focus" guards the
 * site only while a Focus run is active; "always" guards it at all times.
 * Additive: installs without Focus keys simply have an empty `focusSiteRules`.
 * @typedef {Object} FocusSiteRule
 * @property {string} domain
 * @property {string} displayDomain
 * @property {("focus"|"always")} scope
 */

/**
 * F8-R2 (Focus site guard) — device-local operational state. Each of these lives under
 * its OWN `chrome.storage.local` key, never inside `settings`, and is EXCLUDED from vault
 * serialization/export (it holds live tab/window ids and attempted URLs that are local and
 * private). See focus-mode.md §6.2 and `js/lib/focus-guard.js`.
 * @typedef {Object} FocusGuardState the one active site-only run (key `focusGuardState`)
 * @property {string} id
 * @property {number} startedAt
 * @property {number|null} endsAt null = open-ended (no run-end alarm)
 *
 * @typedef {Object} FocusAccessRecord canonical-domain access grant (key `focusTemporaryAccess`)
 * @property {string} domain canonical rule domain (covers its subdomains)
 * @property {number} accessStartedAt preserved across consecutive extensions (cumulative copy)
 * @property {number} expiresAt
 * @property {5|10|15|30} grantedMinutes
 * @property {number} [retryAt] calm retry time after an expiry redirect failure
 * @property {number} [retryCount] bounded-backoff step for that retry
 *
 * @typedef {Object} FocusBlockedAttempt a guard tab's trusted context (key `focusBlockedAttempts`, keyed by tab id)
 * @property {string} id opaque attempt id; the guard URL fragment carries only this
 * @property {string} url the recorded destination (never placed in the guard URL/DOM)
 * @property {string} [returnUrl] a validated previous safe URL for this tab
 * @property {string} domain @property {string} displayDomain
 * @property {("focus"|"always")} ruleScope
 * @property {("initial"|"expired")} reason
 * @property {number} blockedAt @property {number} [accessStartedAt]
 * @property {FocusAccessRecord} [grantProgress] committed grant for navigation-only retry
 * @property {string} [title] @property {string} [favIconUrl]
 * @property {number} [windowId] @property {number} [index]
 */

/**
 * @typedef {Object} Settings
 * @property {boolean} autoArchiveEnabled off by default until the form-input exemption exists (PRD risk)
 * @property {number} autoArchiveDays legacy day-granular threshold; kept written (rounded up from autoDumpAfterMinutes) for back-compat
 * @property {number} [autoDumpAfterMinutes] N3: minute-granular auto-dump threshold; the archive sweep reads this. Derived from autoArchiveDays×1440 when absent (getSettings migration)
 * @property {number} [autoSaveMaxTabs] hard cap: keep at most this many tabs open by saving the longest-idle eligible surplus tabs to Inbox (0 = no cap; additive; works even with the idle timer Off)
 * @property {number} inboxExpiryDays Inbox items this old move to the Archive; 0 = never
 * @property {string[]} archiveWhitelist compatibility alias for the shared automation-protection rules; runtime reads expose the preserved union through both aliases
 * @property {string[]} [suspendWhitelist] compatibility alias for shared automation-protection rules (domain/URL substring or page:-prefixed exact URL; additive; absent = empty)
 * @property {number} [suspendMinTabs] keep this many most-recent awake web tabs outside time-based suspension (0 = no recent floor; additive)
 * @property {number} [suspendMaxTabs] hard cap: keep at most this many tabs awake, suspending the longest-idled beyond it (0 = no cap; additive; works even with the slider Off)
 * @property {number} suspendAfterMinutes
 * @property {boolean} dedupAutoClose
 * @property {number} snapshotEveryMinutes
 * @property {number} snapshotKeep automatic Snapshots retained, newest first. Stored 0 (formerly keep all) and values above SNAPSHOT_KEEP_MAX read as SNAPSHOT_KEEP_MAX; see effectiveSnapshotKeep
 * @property {boolean} suspendEnabled
 * @property {boolean} suspendLazyReload true (default) = custom suspend page, click to reload; false = chrome.tabs.discard, reloads on tab switch
 * @property {boolean} snoozeWakeQuiet RETIRED preference, accepted for settings/Vault back-compat and ignored; snoozes always reopen
 * @property {boolean} dedupIgnoreQuery RETIRED preference, accepted for settings/Vault back-compat and ignored; duplicate matching preserves query strings
 * @property {("dashboard"|"minimal"|"blank")} newTabMode M6/N25: new-tab page shows the full dashboard, a minimal Horizon clock/search/Starred deck, or a nearly-blank page (the closest opt-out of the MV3 new-tab override). The retired "terminal" value remains accepted only by portable validation and normalizes to Dashboard on read.
 * @property {("omnibox"|"search")} newTabFocus F2: on a new tab, leave focus in Chrome's address bar ("omnibox") or autofocus our search ("search")
 * @property {boolean} oneNewTabPerWindow close older unpinned EveryTab New Tabs in the same normal window after a newly created override page mounts
 * @property {boolean} newTabWelcomeEnabled show a personal clock note on Minimal without deleting the saved phrase library
 * @property {string[]} newTabWelcomePhrases up to 100 personal Minimal-only clock notes, each at most 96 Unicode characters; empty keeps the surface unchanged
 * @property {("clock"|"accent")} newTabWelcomeTone Minimal clock-note tone: clock uses the quiet clock color treatment; accent uses the scheme accent at full strength
 * @property {string} uiScheme color scheme id (see js/lib/schemes.js)
 * @property {("system"|"scheme"|"light"|"dark")} uiMode
 * @property {("off"|"open"|"hourly"|"daily")} schemeRotate D3: optional no-repeat color-scheme rotation cadence
 * @property {string[]} schemeFavorites D3: rotation pool; empty means all schemes
 * @property {boolean} uiGradient gradient atmosphere + orbs (a setting, per user decision)
 * @property {boolean} uiQuickTheme RETIRED preference, accepted for settings/Vault back-compat and ignored; quick theme controls are always visible
 * @property {boolean} uiSectionIntros N15: one-line "what is this section" intro under each dashboard section title
 * @property {("bold"|"muted")} uiEmphasis RETIRED D4 preference, accepted for settings/Vault back-compat and ignored; active and selected states always use Bold
 * @property {("round"|"square")} uiCheckboxShape RETIRED preference, accepted for Settings/Vault back-compat and ignored; Interface style owns selection geometry
 * @property {("crisp"|"soft")} uiCornerStyle RETIRED preference, accepted for Settings/Vault back-compat and used only to derive uiInterfaceStyle for profiles created before that setting existed
 * @property {("system"|"en"|"fr")} uiLanguage interface language: "system" follows Chrome's UI language; "en"/"fr" install that packaged catalogue on the next page load. Unknown values read as "system" without rewriting the stored value
 * @property {("soft"|"crisp"|"terminal")} uiInterfaceStyle shared shape, type, shadow, and selection-control presentation; color schemes and behavior stay independent
 * @property {("clean"|"useful"|"detailed")} uiRowInfo D4: amount of secondary information in tab rows
 * @property {("shelf"|"rail"|"compact")} uiUtilityLayout RETIRED F35 preference, accepted for settings/vault back-compat and ignored by F36.
 * @property {("space"|"divider"|"accent-cap")} uiWindowGrouping RETIRED display preference, accepted for vault/settings back-compat and ignored
 * @property {("fine"|"bold")} uiAccentCapStrength RETIRED display preference, accepted for vault/settings back-compat and ignored
 * @property {boolean} uiSidebarCollapsed D4-3a: the user's remembered WIDE-layout navigation choice. true = the 56-64px icon rail, false = the full labelled sidebar. A constrained viewport may force the rail or the anchored header switcher without changing this stored preference.
 * @property {("named"|"icons")} uiActionLabels D4 motion/interaction polish: named row actions on a wide dashboard by default, or the user's clean icon-only preference. Compact and narrow surfaces remain icon-only in either mode.
 * @property {boolean} popupDupHint RETIRED preference, accepted for settings/Vault back-compat and ignored; the per-open dismissible duplicate hint is always enabled (J6)
 * @property {("recent"|"az"|"count")} uiLabelSort L-nav: sort order of the Labels page (persisted)
 * @property {("recent"|"az"|"count")} uiSessionSort N32: sort order of the Sessions page (persisted; parity with the Labels index bar)
 * @property {("duration"|"morning-end"|"day-end"|"manual")} focusDefaultEndMode F8: default Focus run end mode. "duration" = focusDefaultDurationMinutes from start; "morning-end"/"day-end" = next configured wall-clock time; "manual" = open-ended (no end alarm). Stored values are stable — never relabel by changing them.
 * @property {number} focusDefaultDurationMinutes F8: default/custom Focus duration in minutes (used when focusDefaultEndMode is "duration"; 60 = the "1 hour" choice)
 * @property {number} focusMorningEndMinutes F8: "morning ends at" as minutes since local midnight (default 12:00 = 720)
 * @property {number} focusDayEndMinutes F8: "day ends at" as minutes since local midnight (default 18:00 = 1080)
 * @property {boolean} focusMinimizeOtherWindows F8-R1 RETIRED: stored for back-compat, hidden from the Settings UI, and ignored by v0.2 (Workspace Focus was removed). Never delete, rename, or migrate this key.
 * @property {FocusSiteRule[]} focusSiteRules F8: blocked-site rules, one per canonical domain
 * @property {("immediate"|"pause")} focusExceptionStyle F8: requesting access to a blocked site shows the timed choices immediately, or adds a 15-second pause first
 * @property {("next-navigation"|"save-close")} focusTemporaryEndAction F8-R1 RETIRED: stored for back-compat, hidden from the Settings UI, and ignored by v0.2. Never delete, rename, or migrate this key.
 * @property {boolean} [perfHud] E3-0 (MH-settled §8 Q4): HIDDEN dev-only switch — no UI anywhere. Activates the js/lib/perf.js instrumentation on surfaces that can't take `?perf=1` (the real toolbar popup). Set/cleared from the console only; additive, absent = off.
 * @property {boolean} [preserveTabGroups] F18: preference to save/restore Chrome tab groups with sessions and snapshots. Default ON (absent = on). Functionally gated on the optional `tabGroups` permission — group names/colors are only read/recreated when it is granted. Additive.
 * @property {{hostname:string,mode:("include-fragment"|"skip")}[]} [duplicateDomainRules] exact-host duplicate matching exceptions; portable through the existing Settings record so older clients preserve them during rolling updates
 */

/** Settings control bounds for automatic Snapshot retention. */
/** Accepted stored values for Settings.uiLanguage; the first is the default. */
export const UI_LANGUAGE_VALUES = Object.freeze(["system", "en", "fr"]);

export const SNAPSHOT_KEEP_MIN = 1;
export const SNAPSHOT_KEEP_MAX = 1000;

/**
 * Effective automatic-Snapshot retention for a stored `snapshotKeep`. Older
 * profiles may hold 0 (once "keep all") or values above the current maximum;
 * both read as the maximum without rewriting the stored setting. A missing
 * or malformed value reads as the default.
 * @param {unknown} value
 * @returns {number}
 */
export function effectiveSnapshotKeep(value) {
  const keep = Number(value);
  if (!Number.isFinite(keep)) return DEFAULT_SETTINGS.snapshotKeep;
  if (keep <= 0 || keep > SNAPSHOT_KEEP_MAX) return SNAPSHOT_KEEP_MAX;
  return Math.max(SNAPSHOT_KEEP_MIN, Math.floor(keep));
}

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  autoArchiveEnabled: false,
  autoArchiveDays: 7,
  autoSaveMaxTabs: 0,
  inboxExpiryDays: 30,
  archiveWhitelist: [],
  suspendWhitelist: [],
  suspendMinTabs: 0,
  suspendMaxTabs: 0,
  suspendAfterMinutes: 60,
  dedupAutoClose: false,
  snapshotEveryMinutes: 15,
  snapshotKeep: 200,
  suspendEnabled: true,
  suspendLazyReload: true,
  snoozeWakeQuiet: false,
  dedupIgnoreQuery: false,
  newTabMode: "dashboard",
  newTabFocus: "omnibox",
  oneNewTabPerWindow: true,
  newTabWelcomeEnabled: true,
  newTabWelcomePhrases: [],
  newTabWelcomeTone: "clock",
  uiScheme: "ink",
  uiMode: "scheme",
  schemeRotate: "off",
  schemeFavorites: [],
  uiGradient: true,
  uiQuickTheme: true,
  uiSectionIntros: true,
  // D4 Calm Precision presentation preferences. All are additive and
  // normalized on read so older or malformed settings retain safe defaults.
  uiEmphasis: "bold",
  uiCheckboxShape: "round",
  uiCornerStyle: "soft",
  uiInterfaceStyle: "soft",
  // Interface language. Travels with the other appearance keys through Vault
  // sync and portable backups (normalizePortableSettings), so a profile keeps
  // its language choice on every device, like its color scheme and style.
  uiLanguage: "system",
  uiRowInfo: "detailed",
  uiUtilityLayout: "compact",
  uiWindowGrouping: "space",
  uiAccentCapStrength: "bold",
  uiSidebarCollapsed: false,
  uiActionLabels: "icons",
  popupDupHint: true,
  uiLabelSort: "recent",
  uiSessionSort: "recent",
  // F8 (Focus Mode) — additive; stable stored values (see focus-mode.md §5.1).
  focusDefaultEndMode: "duration",
  focusDefaultDurationMinutes: 60,
  focusMorningEndMinutes: 12 * 60,
  focusDayEndMinutes: 18 * 60,
  focusMinimizeOtherWindows: true,   // F8-R1 RETIRED: kept byte-compatible; hidden + ignored by v0.2
  focusSiteRules: [],
  focusExceptionStyle: "immediate",
  focusTemporaryEndAction: "next-navigation",  // F8-R1 RETIRED: kept byte-compatible; hidden + ignored by v0.2
  perfHud: false,  // E3-0: hidden dev-only perf instrumentation switch (no UI; see js/lib/perf.js)
  preserveTabGroups: true,  // F18: save/restore Chrome tab groups (gated on the optional tabGroups permission)
  duplicateDomainRules: []
};

/**
 * Smart view: a stored rule that builds an automatic view (PRD §3.2).
 * pattern is a case-insensitive regex tested against the chosen field.
 * @typedef {Meta & {name: string, field: ("domain"|"url"|"title"), pattern: string, scope: ("open"|"saved"|"all"), builtin?: boolean}} SmartView
 */

/** chrome.storage.local keys for each record map. */
export const STORE_KEYS = {
  inbox: "inbox",
  archive: "archive",
  sessions: "sessions",
  collections: "collections",
  snoozes: "snoozes",
  smartviews: "smartviews",
  starred: "starred",
  customSchemes: "customSchemes",
  organizationGroups: "organizationGroups",
  organizationMemberships: "organizationMemberships"
};

/** @typedef {"label"|"session"} OrganizationKind */

/**
 * P11-14: one optional, one-level navigation group. This is deliberately
 * separate from `Session.groups`, which stores saved Chrome tab-group
 * templates. Groups contain Label or named-Session identities, never tabs.
 * @typedef {Meta & {organizationKind: OrganizationKind, name: string}} OrganizationGroup
 */

/**
 * P11-14: one mergeable zero-to-many membership edge. `id` is the stable,
 * UUID-shaped identity of (format, kind, memberKey, groupId), so concurrent
 * devices add/remove the same logical edge through ordinary record LWW.
 * @typedef {Meta & {organizationKind: OrganizationKind, memberKey: string, groupId: string}} OrganizationMembership
 */

/**
 * One valid user-authored color scheme. Light and Dark contain the complete
 * compiled role maps; Simple sources remain so the friendly editor is lossless.
 * @typedef {Meta & {schemeFormatVersion: 1, validationSeal: string, name: string,
 *   defaultMode: ("light"|"dark"), authoringMode: ("simple"|"advanced"),
 *   simple: Record<"light"|"dark", object>, light: object, dark: object}} CustomScheme
 */

/* ---------- N44 portable Export / Restore contracts ---------- */

/**
 * One user-visible Activity entry. Restore adds checkpoint/status fields to
 * the existing inverse rather than introducing a second activity model.
 * @typedef {Object} JournalEntry
 * @property {string} id
 * @property {number} at
 * @property {string} label
 * @property {string} [actionKind] stable localization identifier for Activity
 * @property {Record<string,string|number>} [actionParams] bounded presentation parameters
 * @property {boolean} [undone]
 * @property {boolean} [auto]
 * @property {string} [category]
 * @property {object[]} [puts]
 * @property {object[]} [dels]
 * @property {TabRef[][]} [reopen]
 * @property {object[]} [moves]
 * @property {string} [restoreCheckpointId]
 * @property {string} [closeDayTransactionId] device-local Close-the-day receipt id
 * @property {"stale"|"unavailable"} [restoreUndoStatus]
 * @property {boolean} [restoreCheckpointAvailable]
 * @property {string[]} [restoreUndoStaleKeys]
 * @property {number} [undoContractVersion] generic stale-safe Undo contract
 * @property {{store:string,id:string,present:boolean,modifiedAt?:number,deletedAt?:number,hash?:string}[]} [undoPostState]
 * @property {"stale"|"unavailable"|"incomplete"} [undoStatus]
 * @property {string[]} [undoStaleStores]
 * @property {{id:string,at:number,phase:"effects"}} [undoClaim]
 * @property {{reopened:number,moved:number,failed:number}} [undoEffectResult]
 * @property {{kind:"close-tabs",status:"pending"|"complete",tabs:{tabId:number,ref:TabRef,windowId?:number,index?:number,pinned?:boolean}[],confirmedTabs?:{tabId:number,ref:TabRef,windowId?:number,index?:number,pinned?:boolean}[],confirmedAt?:number,closedCount?:number}} [forwardReceipt]
 */

/** @typedef {Record<string, Record<string, object>>} PortableRecordFamilies */
/** @typedef {Record<string, number>} PortableLabelMeta */

/**
 * Whole-file validated, normalized Restore input. This shape exists only in
 * memory; no caller may plan or commit from the untrusted JSON object itself.
 * @typedef {Object} ParsedPortableState
 * @property {number} exportVersion
 * @property {boolean} legacy
 * @property {string|null} exportedAt
 * @property {PortableRecordFamilies} records
 * @property {boolean} hasSettings
 * @property {Settings} settings
 * @property {number} settingsCount
 * @property {number} settingsModifiedAt
 * @property {PortableLabelMeta} labelMeta null-prototype safe dictionary
 * @property {string} sourceHash
 */

/**
 * Coherent local snapshot consumed by the pure Restore planner.
 * @typedef {Object} PortableLocalState
 * @property {PortableRecordFamilies} records
 * @property {Record<string, object>} archiveBase physical Archive base
 * @property {Record<string, object>} archiveOverlay physical live-write overlay
 * @property {Record<string, unknown>} settingsRaw exact stored Settings object
 * @property {number} settingsModifiedAt
 * @property {PortableLabelMeta} labelMeta
 */

/**
 * @typedef {Object} PortableRecordCounts
 * @property {number} incoming
 * @property {number} added
 * @property {number} updated
 * @property {number} keptIncoming
 * @property {number} localOnly
 */

/**
 * Public preview/commit summary shown by the Restore workflow.
 * @typedef {Object} PortableRestoreSummary
 * @property {number} exportVersion
 * @property {boolean} legacy
 * @property {string|null} exportedAt
 * @property {string} sourceHash
 * @property {PortableRecordCounts} records
 * @property {{incoming:number, advanced:number, existingAdvanced:number}} labelMeta
 * @property {{available:boolean, enabled:boolean, changed:boolean, count:number}} settings
 * @property {boolean} changed
 * @property {boolean} requiresConfirmation
 * @property {string|null} confirmationToken exact destructive-plan token
 */

/**
 * Pure deterministic Restore plan. Record/label changes carry the exact
 * pre-state needed to construct the selective v2 checkpoint.
 * @typedef {Object} PortableRestorePlan
 * @property {PortableRecordFamilies} records
 * @property {Record<string, Record<string, {beforePresent:boolean, before:object|null, after:object}>>} recordChanges
 * @property {PortableLabelMeta} labelMeta
 * @property {Record<string, {beforePresent:boolean, before:number|null, after:number}>} labelChanges
 * @property {Record<string, unknown>} settings
 * @property {number} settingsModifiedAt
 * @property {Settings} localOrdinarySettings
 * @property {string[]} changedRecordKeys
 * @property {boolean} changedLabelMeta
 * @property {boolean} changedSettings
 * @property {PortableRestoreSummary} summary
 */

/**
 * Sanitized metadata for the user-selected Restore source.
 * @typedef {Object} PortableRestoreSource
 * @property {string} name
 * @property {number} size
 * @property {number} lastModified
 * @property {string|null} exportedAt
 * @property {string} hash
 */

/**
 * @typedef {Object} PortableRestoreOptions
 * @property {boolean} [restoreSettings]
 * @property {string|null} [confirmationToken]
 * @property {Partial<PortableRestoreSource>} [source]
 */

/** @typedef {"restored"|"confirmation-required"|"no-op"} PortableRestoreStatus */
/**
 * @typedef {Object} PortableRestoreResult
 * @property {PortableRestoreStatus} status
 * @property {string|null} checkpointId
 * @property {object|null} journalEntry
 * @property {PortableRestoreSummary} summary
 */

/** @typedef {"undone"|"stale"|"unavailable"} PortableRestoreUndoStatus */
/**
 * @typedef {Object} PortableRestoreUndoResult
 * @property {PortableRestoreUndoStatus} status
 * @property {string} checkpointId
 * @property {string[]} staleKeys
 * @property {boolean} checkpointAvailable
 */

/**
 * Compact expected post-state used for stale-safe selective Undo.
 * @typedef {Object} RestorePostDescriptor
 * @property {boolean} present
 * @property {number} [modifiedAt]
 * @property {number} [schemaVersion]
 * @property {number} [deletedAt]
 * @property {string} [hash]
 */

/**
 * One persisted record change. Archive uses the physical base/overlay fields;
 * other families use beforePresent/before/expected.
 * @typedef {Object} RestoreCheckpointRecordChange
 * @property {boolean} [beforePresent]
 * @property {object|null} [before]
 * @property {RestorePostDescriptor} [expected]
 * @property {boolean} [beforeBasePresent]
 * @property {object|null} [beforeBase]
 * @property {boolean} [beforeOverlayPresent]
 * @property {object|null} [beforeOverlay]
 * @property {RestorePostDescriptor} [expectedBase]
 * @property {RestorePostDescriptor} [expectedOverlay]
 */

/**
 * Persisted singleton selective checkpoint under `restoreCheckpoint`.
 * @typedef {Object} RestoreCheckpoint
 * @property {2} version
 * @property {string} id
 * @property {number} createdAt
 * @property {PortableRestoreSource} source
 * @property {string[]} affected
 * @property {{records: Record<string, Record<string, RestoreCheckpointRecordChange>>,
 *   settings?: {before: Record<string, unknown>, beforeModifiedAt:number,
 *     expected:{modifiedAt:number, hash:string}},
 *   labelMeta?: Record<string, {beforePresent:boolean, before:number|null, expected:number}>}} changes
 * @property {number} [undoneAt]
 */

/**
 * Metadata exposed to the Data route without leaking checkpoint pre-state.
 * @typedef {Object} PortableRestoreCheckpointSummary
 * @property {string} id
 * @property {number} createdAt
 * @property {PortableRestoreSource} source
 * @property {string[]} affected
 * @property {"available"|"stale"|"unavailable"} undoStatus
 * @property {boolean} checkpointAvailable
 */

/**
 * E3 live-write overlay for newly saved Archive copies. It is an internal
 * physical key, not a seventh logical store: all public Archive reads merge it
 * with STORE_KEYS.archive, and any full Archive mutation folds it down
 * atomically. Vault/export continue to expose one logical Archive map.
 */
export const ARCHIVE_OVERLAY_KEY = "archiveOverlay";
