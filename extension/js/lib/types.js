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
 * @typedef {Meta & {url: string, title: string, dueAt: number, tabs?: TabRef[], recurrence?: string, claimedBy?: string, firedAt?: number, sessionId?: string}} Snooze
 * claimedBy is a reserved legacy field for the deferred any-device mode.
 * tabs (P2b-1): a whole-window snooze. When present it holds the window's saveable
 * tabs and `title`="Window (N tabs)", `url`="". Additive — legacy single-tab items
 * (url/title, no tabs) keep working everywhere.
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
 * @property {number} claimedAt
 * @property {"effects"|"complete"|"incomplete"} phase
 * @property {number} [completedAt] @property {number} [opened]
 * @property {"worker-stopped"|"partial-browser-effect"} [reason]
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
 * F8-R1 LEGACY (retirement only) — the device-local operational state of the
 * retired Workspace Focus run. Stored under its OWN `chrome.storage.local` key
 * (`focusState`), never inside `settings`, and excluded from vault serialization.
 * Focus v0.2 NEVER creates this key; it survives only so `js/lib/focus-retirement.js`
 * can drain a pre-v0.2 install (restore the recorded windows, then remove it). The
 * `minimized` recovery ledger is what the drain reads. Do not rename or migrate it.
 * @typedef {Object} FocusState
 * @property {string} id
 * @property {number} startedAt
 * @property {number|null} endsAt null = open-ended (no end alarm)
 * @property {string} label window ordinal ("Window N") or session name, shown in the UI
 * @property {("active"|"ending")} [phase] F8-2r operational phase. "ending" is
 *   persisted before End touches the alarm or any window, so a worker stop
 *   mid-End is resumed by recovery even if `endsAt` is still future. Absent =
 *   "active" (old F8-2 states inherit active safely). Never a setting, never synced.
 * @property {FocusTarget} target
 * @property {Array<{windowId: number, priorState: ("normal"|"maximized"|"fullscreen"), pendingMinimize?: boolean}>} minimized
 *   A RECOVERY LEDGER, not merely windows already minimized: every unrelated window this
 *   run acted on, each with `priorState` (the state to restore it to). F8-2r6/F8-2r7:
 *   `pendingMinimize` marks a candidate whose minimize was ACCEPTED but not yet confirmed
 *   quiescent — a timed-out or in-flight native transition that may still land. Such a
 *   record is persisted BEFORE the native minimize and is never dropped until End proves
 *   it quiescent (a currently-visible pending record is neutralized with a stability
 *   window), so a late commit can never leave an untracked hidden window. Live minimized
 *   status is always derived from actual window state, so a pending record never falsely
 *   claims a window is hidden. Additive and inherited: a record with no `pendingMinimize`
 *   field keeps the old confirmed-record semantics (restore on End, count when minimized).
 *   Never a setting, never synced, never serialized through the vault.
 */

/**
 * @typedef {Object} FocusTarget
 * @property {("window"|"session")} kind
 * @property {string} [sessionId] present when kind is "session"
 * @property {number[]} windowIds the live target window IDs (empty = paused after restart)
 */

/**
 * @typedef {Object} Settings
 * @property {boolean} autoArchiveEnabled off by default until the form-input exemption exists (PRD risk)
 * @property {number} autoArchiveDays legacy day-granular threshold; kept written (rounded up from autoDumpAfterMinutes) for back-compat
 * @property {number} [autoDumpAfterMinutes] N3: minute-granular auto-dump threshold; the archive sweep reads this. Derived from autoArchiveDays×1440 when absent (getSettings migration)
 * @property {number} [autoSaveMaxTabs] hard cap: keep at most this many tabs open by saving the longest-idle eligible surplus tabs to Inbox (0 = no cap; additive; works even with the idle timer Off)
 * @property {number} inboxExpiryDays Inbox items untouched this long move to the Archive; 0 = never
 * @property {string[]} archiveWhitelist domains/URL substrings never auto-archived
 * @property {string[]} [suspendWhitelist] F9: domains/URL substrings the auto-suspend sweep never touches (additive; absent = empty)
 * @property {number} [suspendMinTabs] only auto-suspend when more than this many tabs are open (0 = always; additive)
 * @property {number} [suspendMaxTabs] hard cap: keep at most this many tabs awake, suspending the longest-idled beyond it (0 = no cap; additive; works even with the slider Off)
 * @property {number} suspendAfterMinutes
 * @property {boolean} dedupAutoClose
 * @property {number} snapshotEveryMinutes
 * @property {number} snapshotKeep 0 = keep all; N>0 = prune beyond newest N
 * @property {boolean} suspendEnabled
 * @property {boolean} suspendLazyReload true (default) = custom suspend page, click to reload; false = chrome.tabs.discard, reloads on tab switch
 * @property {boolean} snoozeWakeQuiet RETIRED preference, accepted for settings/Vault back-compat and ignored; snoozes always reopen
 * @property {boolean} dedupIgnoreQuery RETIRED preference, accepted for settings/Vault back-compat and ignored; duplicate matching preserves query strings
 * @property {("dashboard"|"minimal"|"blank")} newTabMode M6/N25: new-tab page shows the full dashboard, a minimal Horizon clock/search/Starred deck, or a nearly-blank page (the closest opt-out of the MV3 new-tab override)
 * @property {("omnibox"|"search")} newTabFocus F2: on a new tab, leave focus in Chrome's address bar ("omnibox") or autofocus our search ("search")
 * @property {boolean} oneNewTabPerWindow close older unpinned EveryTab New Tabs in the same normal window after a newly created override page mounts
 * @property {string} uiScheme color scheme id (see js/lib/schemes.js)
 * @property {("system"|"scheme"|"light"|"dark")} uiMode
 * @property {("off"|"open"|"hourly"|"daily")} schemeRotate D3: optional no-repeat color-scheme rotation cadence
 * @property {string[]} schemeFavorites D3: rotation pool; empty means all schemes
 * @property {boolean} uiGradient gradient atmosphere + orbs (a setting, per user decision)
 * @property {boolean} uiQuickTheme RETIRED preference, accepted for settings/Vault back-compat and ignored; quick theme controls are always visible
 * @property {boolean} uiSectionIntros N15: one-line "what is this section" intro under each dashboard section title
 * @property {("bold"|"muted")} uiEmphasis RETIRED D4 preference, accepted for settings/Vault back-compat and ignored; active and selected states always use Bold
 * @property {("round"|"square")} uiCheckboxShape D4: tab-list checkbox geometry
 * @property {("crisp"|"soft")} uiCornerStyle D4: shared component corner profile
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
 */

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
  oneNewTabPerWindow: false,
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
  preserveTabGroups: true   // F18: save/restore Chrome tab groups (gated on the optional tabGroups permission)
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
 * @property {{kind:"close-tabs",status:"pending"|"complete",tabs:{tabId:number,ref:TabRef,windowId?:number,index?:number,pinned?:boolean}[],closedCount?:number}} [forwardReceipt]
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
 * @typedef {Object} RestoreCheckpointRecordChangeV2
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
 * @typedef {Object} RestoreCheckpointV2
 * @property {2} version
 * @property {string} id
 * @property {number} createdAt
 * @property {PortableRestoreSource} source
 * @property {string[]} affected
 * @property {{records: Record<string, Record<string, RestoreCheckpointRecordChangeV2>>,
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
