# Changelog

Development build history. Check `extension/manifest.json` or
`chrome://extensions` to confirm the loaded version. An entry does not imply a
Store release. Current verification and next work are in `handoff-prompt.md`;
detailed receipts are in `review-evidence/`.

## 1.0.0 - 2026-10-08

First public release. Changes since the 0.8.632 closed beta, for users:

- French is available. Settings > Appearance > Language offers System,
  English and Français; the browser's language is the default.
- Snapshots to keep is now 1 to 1,000 (default 200) and the Recovery
  database honors it.
- Vault: damaged backups, files from other devices that cannot be read, sync
  service conflict copies and iCloud placeholder files are set aside and named
  instead of stopping sync; a damaged Restore point no longer hides the
  others; choosing a different populated Vault asks before merging; the Vault
  screen says when EveryTab updates it.
- Chrome updates no longer trigger the extension-reload recovery, and the
  restarting notice appears only when suspended tabs are actually recovered.
- Faster: typing in the Inbox filter, opening and closing tabs with a large
  library, and Search while background tabs change their titles.
- Inbox filter has the `f` shortcut; automatic Activity entries list their
  tabs; the Starred rail opens and closes with a designed motion.
- The source code is published under MPL-2.0 (see README).

Development history for the beta builds follows.

## 0.8.666 - 2026-10-08

- Open-source preparation. Every runtime, stylesheet and maintained tool
  file carries the MPL-2.0 header with the copyright holder. LICENSE ships in
  the Store package. New repository files: CONTRIBUTING, SECURITY, TRADEMARKS,
  CODE_OF_CONDUCT, .gitignore, .nvmrc, issue and PR templates, an outsider
  README. `tools/export-public-repo.mjs` builds the curated public tree from an
  allowlist and refuses on sensitive content; two suites skip private inputs
  explicitly. Hard-coded personal cache paths in tools are an environment
  variable now. Evidence: `review-evidence/open-source-0.8.666/`. Nothing pushed.
- No release package or Store publication was performed.

## 0.8.665 - 2026-10-07

- Starred rail: the open and close motion is redesigned within the house
  vocabulary. The star and the count glide from the toggle to their places in
  the panel header and back; the panel unfolds from the right edge with a
  short slide and fade; the label appears once the star has arrived. Reduced
  motion disables it. Filmstrip in `review-evidence/starred-rail-0.8.664/`.
- No release package or Store publication was performed.

## 0.8.664 - 2026-10-07

- Starred rail: opening or closing no longer scales the star and count to the
  panel width mid-transition. The view-transition snapshots keep their natural
  size, anchored to the rail's right edge. Evidence with frozen mid-transition
  frames in `review-evidence/starred-rail-0.8.664/`.
- No release package or Store publication was performed.

## 0.8.663 - 2026-10-07

- Language setting. Settings > Appearance > Language offers System (default,
  the browser's language), English and Français. The chosen catalogue is
  loaded by the extension itself with Chrome-compatible placeholder
  substitution, falls back to the browser's language and then English for any
  missing key, and drives dates, numbers and plurals too. It takes effect when
  a page is next opened; the background worker follows it for notifications.
  The extension's name, description and command names in Chrome's own UI
  still follow the browser language. Verified in an English Chrome: Dashboard,
  Settings, Side Panel and Popup render in French after switching.
- No release package or Store publication was performed.

## 0.8.662 - 2026-10-07

- French locale. `_locales/fr` translates all 2,056 catalogue messages with
  the settled glossary (Inbox and Focus kept, libellé, mettre en attente,
  coffre, instantané, Fin de journée, favoris, À traiter). Chrome picks it
  when its UI language is French. A completeness test keeps the two
  catalogues in step (keys, placeholders, punctuation, glossary).
- 161 remaining user-facing strings moved into the English catalogue
  (Activity, Dashboard, Duplicates, Needs you, Starred, Stats, Snooze
  notifications, Close the day locked reasons, toasts), wording unchanged,
  with a source guard against new literals. The color scheme editor is a
  later slice.
- Layout fixes from the French pass: the Dashboard Focus control sizes to its
  widest label; the popup session action is shorter in French; the Vault pill
  no longer mounts with a literal placeholder.
- Evidence: `review-evidence/french-locale/`. No release package or Store
  publication was performed.

## 0.8.661 - 2026-10-07

- Inbox filter typing no longer freezes on a large Inbox. Each cached
  automation awareness trigger was re-sampled with a computed-style read
  between paints of the others on every Inbox render, forcing a style recalc
  of the whole page per trigger: 1.2 s per keystroke at 400 saved tabs. The
  Inbox build now samples every trigger once before any write, as the Open
  list already did. Measured in the installed Dashboard: awareness cost per
  typing session 8.8 s to 20 ms; input-to-frame latency per key up to 1.8 s
  to 15 ms. Evidence in `review-evidence/inbox-filter-0.8.661/`.
- No release package or Store publication was performed.

## 0.8.660 - 2026-10-07

- Inbox filter: `f` focuses and selects it in Dashboard and Side Panel, like
  the Open filter. Typing no longer re-reads and re-clones the Inbox, the
  Session identity index and the automation inputs on every keystroke: a filter
  keystroke reuses the last read while those keys are unchanged, hides or shows
  the mounted rows immediately, and a large Inbox waits 160 ms for the typing
  burst to end before one rebuild. Measured keystroke cost 176 ms to 68 ms at
  1,500 Inbox tabs and 574 ms to 173 ms at 5,000 (Node compute, no layout).
- New portable and performance suites cover the reuse, the fresh read after a
  storage change, the instant in-place filtering and the shortcut.
- No release package or Store publication was performed.

## 0.8.659 - 2026-10-06

Pre-launch hardening batch from the six-axis review at 0.8.658
(`review-evidence/full-review-0.8.658/`). Data contracts, database names,
stored keys and Vault discriminators are unchanged; a 0.8.632 install upgrades
without migration (new upgrade test).

- Lifecycle: `onInstalled` now branches on its reason. Chrome updates and
  shared-module updates no longer run the extension-reload recovery cycle
  during Chrome's own session restore; a launch-time extension update yields to
  the startup path. The "EveryTab is restarting" notification appears only when
  suspended tabs are actually being recovered and is cleared when the receipt
  settles. Work due in under 30 seconds runs on retained worker timers with the
  alarm as fallback, because packed builds clamp alarms to 30 seconds; a source
  guard now checks every alarm site.
- Safety: Snooze wake refuses non-http(s) addresses like every other reopen
  path. A failed commit after the Library write now still drops the writer's
  read cache. Snapshot retention: the Settings control is 1 to 1,000 (default
  200), "0 = keep all" is withdrawn, stored 0 or larger values read as 1,000,
  and the Recovery database honors the setting.
- Vault: routine pruning keeps young checkpoints from other devices; the
  Restore list skips and reports a damaged point instead of failing entirely.
  Damaged backups, unreadable foreign device manifests, sync-service conflict
  copies and iCloud placeholder files are quarantined and counted, never
  deleted, and the Vault screen names the file kind and the next step with
  allowlisted failure codes, including "update EveryTab on this device".
  Choosing a different populated Vault asks for confirmation with both record
  counts. The Vault screen states that EveryTab updates the Vault while a
  Dashboard or New Tab page is open.
- Performance: tab open/close signals refresh only live-tab dependent parts
  and share one saved read per refresh instead of re-cloning the library four
  times (tab burst beyond Open: 24 ms to 0.5 ms at T2, 96 ms to 1.3 ms at T3).
  Background title or favicon changes refresh only the Open Search source
  (next keystroke 29 ms to 1.8 ms at T2). Locale and Intl formatters are
  memoized, icons clone templates, Archive formats only the visible page.
- Activity: an entry with recorded tabs is one ledger cell; the disclosure is
  the entry's third line with the house chevron, reads "1 tab" or "N tabs",
  and each tab shows title and address on single truncated lines.
- Tests: 234 portable suites and 10 performance suites pass; inventory 463
  files. Browser lane results are in the hardening evidence.
- No release package or Store publication was performed.

## 0.8.658 - 2026-10-05

- Add F to focus and select the Open tabs filter in Dashboard and Side Panel,
  with a tooltip and shortcut reference. Typing, IME, menus and dialogs keep
  their keyboard input; browser shortcuts are unchanged.
- Add expandable affected-tab lists to automatic save/archive Activity entries,
  showing recorded titles and addresses in order, including repeated addresses.
  Expansion and summary focus survive refresh; missing history is explained.
- The user confirmed .657 fixes the Dashboard blinking. Preserve that correction.
- No release package or Store publication was performed.

## 0.8.657 - 2026-10-04

- Let replacement Open rows settle their highlight, actions and automation text
  without replaying hover transitions under a stationary pointer. Normal pointer
  and keyboard feedback resumes after mounting.
- Add native row-replacement coverage across all interface styles, selection and
  reduced motion, plus independent lifecycle regressions. The user's exact
  previous/next-tab shortcut sequence remains an acceptance check.
- No release package or Store publication was performed.

## 0.8.656 - 2026-10-04

- Prevent an Open or Inbox refresh from reviving automation text that is already
  fading away after pointer departure. Preserve active hover, focus and keyboard reveal.
- Add recording-matched native CSS fade regression and controller intent cases;
  preserve batched drag rendering and stationary-pointer remount handling.
- No release package or Store publication was performed.

## 0.8.655 - 2026-10-04

- Report completed Vault directory scans, format validation and early manifest
  checks so a slow but progressing folder does not falsely hit the inactivity timeout.
- Preserve the 30-second deadline for genuinely blocked operations, with regression
  coverage for partial progress, malformed files and incomplete publication.
- Keep the confirmed .654 Dashboard blink report open; no speculative UI change.
- No release package or Store publication was performed.

## 0.8.654 - 2026-10-04

- Let Restart sync reach the recorded Vault owner without first waiting for
  folder-dependent settings rendering. Keep immediate action feedback and retries.
- Add mounted recovery-action regressions for stalled Vault presentation reads.
- Record successful delivery of the user's 31-tab recovery summary separately
  from unresolved macOS banner presentation and Dashboard blink acceptance.
- No release package or Store publication was performed.

## 0.8.653 - 2026-10-04

- Prevent automation text fading out when a Dashboard drop moves another row
  under a stationary pointer. Preserve batched rendering, normal hover and focus.
- Add frame-by-frame installed-browser continuity checks and remount lifecycle
  regressions.
- Replace the opaque recovery diagnostic with a pasteable tool that reports
  sanitized per-step status. The missing macOS summary remains under investigation.
- No release package or Store publication was performed.

## 0.8.652 - 2026-10-04

- Batch automation-indicator continuity reads before rebuilding Open rows,
  avoiding repeated layout work when dragging tabs with Auto-save indicators.
- Extend the installed fixture to execute Dashboard drag handlers, distinguish
  browser-move and DOM-update timing, and cover grouped windows with timers.
- Keep the missing visible reload summary under investigation; capture safe
  delivery counts before further notification changes.
- No release package or Store publication was performed.

## 0.8.651 - 2026-10-03

- Reuse mounted Dashboard rows for eligible same-window tab reorders, preserving
  selection, focus, scroll and fresh action indexes. Keep full rendering for
  groups, filters, capped/folded lists and structural or metadata changes.
- Complete reload summaries when pre-existing suspended pages are already ready
  before repair. Report ready pages separately from actual browser repairs and
  exclude newly suspended or no-longer-valid occurrences.
- Add retained-row interaction regressions and an installed Chrome already-ready
  summary case. Native notification acceptance remains distinct from OS banners.
- No release package or Store publication was performed.

## 0.8.650 - 2026-10-03

- Read Dashboard scroll position before updating the Open heading, avoiding an
  extra synchronous layout pass while retaining scroll correction and picker holds.
- Add production-caller scroll regressions and native scrolled-move qualification.
  Extend safe profiling with source coordinates and layout-read timing.
- Strengthen native recovery checks for distinct retained starting/final notification
  identities. Missing operating-system banners remain an acceptance investigation.
- No release package or Store publication was performed.

## 0.8.649 - 2026-10-03

- Pause automatic Inbox capture and tab closure during the existing 60-second
  reload recovery grace, including sweeps already planning or awaiting closure.
  Retain configured Auto-save rules after grace expires.
- Give Open refreshes one shared frame queue independent of slower sidebar and
  saved-library refreshes, including coalesced foreground reconciliation.
- Cover recovery races and blocked refresh queues; extend installed fixtures to
  reload with both Auto-save controls enabled and measure larger tab sets.
- No release package or Store publication was performed.

## 0.8.648 - 2026-10-03

- Reconcile Open on the next available frame after a browser tab move, attach or
  detach. Preserve hidden-page deferral, active picker holds and the existing
  trailing refresh for counts and other surfaces.
- Mark repeated exact saved addresses in Inbox and within each Named Session.
  Keep every saved occurrence and the existing removal actions; preserve distinct
  query strings, fragments, window structure and immutable Snapshots.
- Add caller-level refresh timing, saved-duplicate rendering and worker-start
  Auto-save safety coverage, with installed synthetic browser qualification.
- No release package or Store publication was performed.

## 0.8.647 - 2026-10-01

- Resolve each card's initial action definitions once for both keyboard shortcut
  discovery and rendering. Keep filtering and control creation at their existing
  boundaries, with fresh definitions on later folds and list rebuilds.
- Add actual-list regressions for initial work, pointer/keyboard action routing,
  capped/immutable shortcut discovery, selection context and later-render freshness.
- No release package or Store publication was performed.

## 0.8.646 - 2026-10-01

- Build Delete confirmation controls and resolve their hidden text when armed.
  Resolve Session-picker defaults when opened. Keep visible labels, custom copy,
  focus, cancellation, confirmation callbacks and automatic reset unchanged.
- Add regression tests for deferred copy, timer/reopen behavior and explicit
  overrides, plus native interaction checks and safe message-caller diagnostics.
- No release package or Store publication was performed.

## 0.8.645 - 2026-10-01

- Skip decorative startup-counter style reads when reduced motion is enabled.
  Counts still settle immediately with truthful text and accessible content;
  normal-motion reels keep their existing position and animation deadline.
- Add regression coverage for preference changes, cleanup and animation ordering,
  plus optional numeric-only installed Inbox work probes.
- No release package or Store publication was performed.

## 0.8.644 - 2026-10-01

- Read named Session records once when a storage request needs both the complete
  Session map and its named-only view. Keep the returned maps independently editable.
- Retain fresh reads across calls, complete favicon payloads by default, Snapshot
  precedence and the existing commit/invalidation behavior.
- Add alias isolation, concurrent read, rejection/retry and retained-data regressions.
  Native measurements distinguish the generic upsert from the UI's named-only rename.
- No release package or Store publication was performed.

## 0.8.643 - 2026-10-01

- Build Search records without loading favicon assets from Library or Recovery.
  Preserve matching, labels, facets, Session ordering and result actions.
- Keep lighter Search records in a separate cache with the same invalidation and
  stale-read protection. Editing, restore and sync retain complete favicon data.
- Add storage, cache-race and full-result parity regressions, plus native Chrome
  assertions for zero Search asset reads and favicon preservation after editing.
- No release package or Store publication was performed.

## 0.8.642 - 2026-09-30

- Keep Close-the-day Undo pending until browser effects settle. Recover an
  interrupted Undo as incomplete without replaying uncertain tab creation or
  repeating saved-data changes; keep Activity and the domain receipt consistent.
- Prevent duplicate fallback tabs after successful window creation when later
  inspection fails. Report confirmed, failed and uncertain reopen outcomes.
- Gate Close-the-day requests on startup recovery and show incomplete results
  without offering a misleading repeat Undo.
- Add production-storage and installed-worker interruption regressions, including
  repeated URL occurrences and preservation of later saved edits.
- No release package or Store publication was performed.

## 0.8.641 - 2026-09-30

- Keep cancelling Vault folder selection separate from failed sync. Reject
  unrelated folders with safe guidance while preserving the prior connection;
  report post-selection storage failures honestly in Dashboard and onboarding.
- Settle retained-handle IndexedDB operations only when their transaction commits
  or aborts, and close their owned connections. An aborted save preserves the
  previous handle instead of leaving selection pending.
- Allow the production Vault sync entry to run without a progress callback,
  including an explicit null observer.
- Add independently reviewed folder/transaction regressions and a native Chrome
  handle fixture covering persistence, reload/restart, no-change files, abort
  rollback and missing directories. Native picker/cloud acceptance remains separate.
- No release package or Store publication was performed.

## 0.8.640 - 2026-09-30

- Handle rejected Vault reconnect requests in both controls, keeping retry
  available and showing localized feedback without exposing raw error details.
- Classify Vault status errors before rendering Details, badges or banners, so
  persistent storage failures cannot expose raw exception text.
- Add regression coverage for permission and retained-handle failures, ordinary
  denial and successful permission retry. A failed reconnect does not create
  a misleading failed-sync receipt.
- No release package or Store publication was performed.

## 0.8.639 - 2026-09-30

- Keep deliberately closed suspended tabs closed after browser restart and a
  later extension reload. Cleanup retires every registry alias of the exact
  occurrence; pending close receipts also protect aliases during failed writes
  and concurrent recovery. Separate tabs sharing a URL remain independent.
- Strengthen installed restart checks to tie each occurrence to its window and
  exercise a real close after restart and natural reload-grace expiry.
- Ensure recovery UI fixtures clean owned resources even if evidence writing
  fails, and preserve the original test failure. Add fault-injection coverage
  and explicit no-change Vault publication assertions.
- Incorporate independent standards, behavior and test-coverage reviews.
  No release package or Store publication was performed.

## 0.8.638 - 2026-09-30

- Preserve suspended tabs in their restored windows when an extension reload
  follows a browser restart. Prefer registry placement in a current window
  when collapsing stale records for the same saved occurrence.
- Refresh Dashboard Snoozed cards when their source Session changes, so repaired
  Sessions no longer retain a stale missing-source message.
- Keep composing keys with the input method when a shared name field sits inside
  a list header; preserve ordinary keyboard navigation after composition ends.
- Add installed Chrome checks for navigation during saves and suspension, Undo
  after interrupted Close-the-day, and recovery controls. Record native lifecycle,
  Vault and input-method limitations separately from simulated regression tests.
- No release package or Store publication was performed.

## 0.8.637 - 2026-09-29

- Make the shared list's synchronous selection commit explicit: update rows,
  owning headers and the cross-group toolbar together. Centralize action-lane
  availability and document the retained header-control contracts.
- Clarify window and Snapshot recovery receipts with named counts and documented
  browser evidence. Preserve all result fields, optional omissions, side effects
  and legacy restore behavior; expand exact-outcome regression coverage.
- Document both flows in the architecture guide. No user journey, saved-data
  format, release package or Store publication changed in this batch.

## 0.8.636 - 2026-09-28

- Count saved tabs in the Inbox sidebar badge and section heading, including every tab inside a
  saved window. A group containing 33 tabs now displays 33 instead of 1.
- Preserve saved groups, records and other navigation counts. Add focused
  coverage for mixed groups, repeated URLs, empty and deleted records.
- No release package or Store publication was performed.

## 0.8.635 - 2026-09-27

- Route worker, domain and UI failure logs through shared fixed operation labels
  and allowlisted error classes. Keep private messages, stacks, record identities
  and arbitrary titles out of diagnostic output, even with hostile error getters.
- Remove page URLs and free-form details from opt-in performance reports while
  retaining known timing labels and numeric measurements.
- Store safe Vault sync failure receipts while preserving localized failure copy,
  timeout classification and the exact tab used by Restart sync.
- Add regression checks for private payloads, hostile values and broken log sinks.
  No release package or Store publication was performed.

## Test infrastructure - 2026-09-27 (runtime remains 0.8.634)

- Classify every maintained test/tool file in one shared inventory used by the
  local runner and CI, including flags, platform restrictions and manual checks.
- Repair seven stale test fixtures and preserve their originals. Keep scheme
  fixture generation in disposable directories instead of historical campaigns.
- Expand the local gate to 188 suites and keep packaging explicitly opt-in.
  Runtime source is unchanged; no release package was created.

## 0.8.634 - 2026-09-27

- Preserve durable repair intent when remote Library or Restore data commits
  before its Session indexes and change notification. Retry the remaining work
  after failures and reopen without replaying saved-data changes.
- Bound Recovery's published-asset receipt cache and repair older oversized
  receipts while retaining the actual favicon files.
- Keep row actions available after multi-selection refresh and deselection.
  Leave composition keys with the input method and require a distinct press
  to confirm destructive keyboard actions.
- Give Import one pending operation with captured source/options, accurate
  completion counts, retained newer drafts and visible failure/retry feedback.
- Retain unavailable Session Snoozes without false wake success. Snapshot
  recovery distinguishes confirmed tabs, known failures and uncertain effects.
- Add transition/failure regression coverage and disposable browser fixtures.
  No Store ZIP or release package was created for this source version.

## 0.8.633 - 2026-09-26

- Clear affected saved selections when their target order or identity changes.
  Keep unaffected saved groups and stable live-tab selections.
- Reject a Vault Restore preview after remote saved-data changes, including a
  change arriving immediately before the replacement transaction.
- Recheck Focus and suspension tab identity after awaited persistence/query work
  so a newly navigated page is not closed or replaced using the old address.
  Serialize suspension per tab so concurrent cleanup preserves recovery.
- Preserve the settled close ledger when undoing interrupted Close the day;
  claim that ledger with the inverse write to prevent duplicate complete Undo.
- Add regression cases to the portable gate and native IndexedDB/DOM fixtures.
  Save the beginner guide and searchable file explorer at the project root.
- No Store ZIP or release package was created for this source version.

## 0.8.632 - 2026-09-25

- Restored Shift+Click and Shift+X range selection after 0.8.631's mounted-list
  optimization. The visual row order is now resolved lazily when a range gesture
  first needs it, including when the anchor was created after initial render.
- A same-window selected-set toolbar now refreshes its small action lane whenever
  that window's selection changes. Session, Label, Snooze, protection, Copy,
  Suspend/Wake and Close therefore receive the complete current selection rather
  than the first selected tab.
- The fast regression now drives real Shift+Click, Shift+X and a mounted Session
  action. The mounted Chrome fixture repeats the same contracts and retains the
  90-window/300-row performance boundary.
- A deterministic Chrome Web Store candidate was created as
  `dist/everytab-0.8.632.zip`. Its SHA-256 is
  `7e532d66104dae64c6e1b9619936d075a7f65f914dc357cb33514135c7528fd7`.
  Packaging includes 255 verified runtime files and excludes development files.

## 0.8.631 - 2026-09-25

- Selection no longer rebuilds the visible list. Rows paint immediately and a
  small local reconciler updates only checkboxes, action ownership and the bulk
  dock, while existing rows and automation indicators remain mounted.
- The mounted large-profile fixture now covers 90 window headers and 300 visible
  rows. First selection completed in 0.9 ms or less across Cream, Tide and
  Nautilus on the recorded host, down from the reproduced 20.3 ms cold path.
- Open and Snoozed Wake actions now use distinct message keys. Open selection
  says “Wake selected suspended tabs”; the partial-Snooze explanation remains
  only in Snoozed.
- The optional group-access action now sits at the right of the affected unnamed
  tab-group row. Selecting a tab leaves that row mounted, so no notice vanishes
  and no list content jumps.
- Group headings and tab titles share the same interface-style-aware grid column,
  including Terminal's wider checkbox lane.
- No Store ZIP or release package was created for this source version.

## 0.8.630 - 2026-09-24

- Selection-only changes now update the row, owning window header and
  cross-window action dock in one synchronous local transaction. They no longer
  start a Chrome/storage refresh, eliminating the delayed handoff and second
  automation-indicator blink across Dashboard and Side Panel.
- The mounted-browser regression covers the full 300-row Dashboard budget. The
  recorded three-theme runs committed the complete selection UI in 21.4 ms or
  less, while the focused two-row cases completed in 0.7 ms or less.
- Open-tab group headings align with the shared title/URL lane. The contextual
  permission notice now explicitly explains that granting optional tab-group
  access reveals Chrome's group names, and a denied prompt remains retryable.
- Multi-tab Open selections now include Copy, with the shared immediate
  “Copy the selected tabs as a Markdown link list (C)” tooltip and shortcut.
- No Store ZIP or release package was created for this source version.

## 0.8.629 - 2026-09-24

- Dashboard Open-tab groups now use one scheme-accent rail in the right edge
  lane, running from the group heading through the final member tab. Chrome
  group colors, the former left-side node and the decorative horizontal rule
  are removed.
- A named heading now reads “Tab group: Name” followed by the tab count and
  aligns with the titles beneath it. Unnamed or permission-free groups retain
  the concise “Tab group” fallback.
- Selecting or deselecting a tab now paints the mounted row and checkbox in the
  same pointer or keyboard interaction. The asynchronous canonical rerender
  continues behind that immediate acknowledgement instead of delaying it.
- No Store ZIP or release package was created for this source version.

## 0.8.628 - 2026-09-24

- Dashboard Open tabs now show live Chrome tab groups as quiet, action-free
  subheaders with a continuous accent rail through their member tabs. Group
  names and tab counts make the structure understandable without relying on
  color.
- The rail retains Chrome's group hue so adjacent groups remain identifiable.
  A second edge mixed toward the active theme's ink keeps the hue distinct on
  similar schemes, including a blue group on blue-based light and dark themes.
- Profiles without the optional Tab groups permission still show group
  membership with a neutral theme-safe rail and “Tab group” label. Granting the
  permission adds Chrome's group name and color. The narrow Side Panel remains
  intentionally flat.
- Group membership, name and color changes refresh the Dashboard. No Store ZIP
  or release package was created for this source version.

## 0.8.627 - 2026-09-24

- Creating a named Session from selected Open tabs now omits absent optional
  favicon metadata. Tabs that Chrome has not given a favicon can no longer make
  the canonical storage commit reject the complete Session.
- Existing favicon values are preserved, and the shared Open adapter fixes the
  path used by Dashboard and Side Panel without changing tab-group behavior.
- Three read-only Dashboard concepts for visualizing live Chrome tab groups are
  available under `docs/prototypes/open-tab-groups/`. They are mockups only and
  are not linked to, loaded by, or packaged with the extension.
- No Store ZIP or release package was created for this source version. The
  existing 0.8.626 candidate remains preserved but is superseded by source.

## 0.8.626 - 2026-09-24

- Background title and favicon changes, including unread-message notifications,
  now retire Search's cached data without repainting the focused result list.
  The next interaction reads fresh data; URL and structural tab changes still
  reconcile immediately.
- The fix lives in the shared Search component used by Dashboard, Popup, Side
  Panel and Minimal, so the field and its highlighted result stay continuous on
  every visual Search surface.
- Exact-domain duplicate matching rules now travel through the existing portable
  Settings record and the user-owned Vault. Existing 0.8.624 and 0.8.625 local
  rules migrate once, while their original local copy remains as recovery data.
- The existing Settings family keeps Vault sync compatible with the published
  0.8.622 client. Like other Settings, simultaneous edits on separate devices
  use whole-settings last-write-wins behavior.
- The verified Chrome Web Store package is `dist/everytab-0.8.626.zip`.

## 0.8.625 - 2026-09-24

- Move and the other selected-set actions now use the same immediate themed
  tooltip as row and window actions instead of Chrome's delayed native title.
- A revealed automation indicator stays visible across the row-shell handoff
  caused by both selection and deselection. The existing control, text and
  progress remain mounted and do not fade out between the old and new row.
- Duplicates keeps “Not the same page?” on the same line as the matching address.
  At narrow widths the quiet label yields before the address or action moves to
  another row.
- Exact-domain duplicate rules remain device-local pending an explicit decision
  about placing hostnames in portable settings and the user-owned Vault.
- No Store ZIP or release package was created for this source version.

## 0.8.624 - 2026-09-24

- Open window headers now follow the row action order: Inbox, Session, Label,
  Snooze and Protect. Selected-set actions use the same sequence, followed by
  Suspend or Wake, Move and Close. Move now explains that it moves selected tabs
  to another window.
- Selecting or deselecting an Open row preserves the existing automation status
  element. Its “Auto-save after” copy and progress bar no longer restart their
  presentation during a selection render.
- Duplicates supports device-local, exact-domain matching rules. A domain can use
  Standard matching, include its URL `#` section, or be excluded from duplicate
  matching. Rules are created from a flagged group, previewed before saving and
  managed from the Duplicates page.
- Dashboard, popup, badge, manual closing and automatic closing now share the
  same duplicate-specific identity rules. The final close guard rereads current
  rules before changing tabs.
- No Store ZIP or release package was created for this source version.

## 0.8.623 - 2026-09-23

- Inbox and Open headers no longer resize when selection grows. A selection
  contained by one card keeps its actions in that card; the fixed action dock
  appears only when selected tabs span cards or windows.
- The cross-card dock enters with a quick 140ms lift and fade after pointer
  selection. Keyboard entry stays still, and reduced-motion preferences remain
  respected.
- The shield action is now named “Protect” in rows, window headers, selected-set
  actions and the shortcut guide. Tooltips explain that it prevents automatic
  suspension and Auto-save to Inbox for the relevant scope.
- No Store ZIP or release package was created for this source version.

## 0.8.622 - 2026-09-18

- Reload recovery now treats a suspended tab's stable recovery occurrence ID as
  its duplication boundary. If Chrome exposes an old suspended page after its
  replacement has mounted, EveryTab keeps one live page instead of registering
  both tab IDs.
- A recovery safety pass also repairs profiles where that timing race already
  left two registry entries for one occurrence. Intentional suspended copies of
  the same URL remain separate because their occurrence IDs differ.
- Automatic Snapshots remain outside reload reconstruction. They are consulted
  only to backfill missing suspended-page titles or favicons.

## 0.8.621 - 2026-09-18

- Named Session results in visual Search now identify themselves as “Session”
  before their window and tab counts. The title and Restore action remain
  unchanged, and the Chrome omnibox keeps its compact count-only metadata.
- Extension reload and update recovery now gives the immediate explanation and
  final recovered-tab receipt separate notification identities. A fast recovery
  can no longer replace the starting message before the operating system shows
  it, and completion creates a new banner instead of relying on an in-place
  update that Chrome may not surface.
- Notification retries continue to reuse the final receipt identity, preventing
  duplicate completion banners while retaining worker-restart recovery.

## 0.8.620 - 2026-09-18

- Minimal mode keeps each user's regional time convention instead of forcing a
  24-hour clock. In 12-hour locales, AM or PM is a smaller companion at the
  clock's logical outer edge, leaving the numerals large and centered.
- The 12-hour clock now reserves enough inline room from large laptop layouts
  through narrow screens. Locales without a day period retain the accepted
  24-hour scale.
- The complete localized time remains one accessible timer label. Locale parts
  control only the visual treatment, including locales whose day period appears
  before the numerals and right-to-left layouts.

## 0.8.619 - 2026-09-18

- Ordinary Chrome startup now leaves suspended-tab and window restoration to
  Chrome. EveryTab reconstruction runs only for an extension install, update or
  reload, so relaunch cannot remove, recreate or duplicate restored suspended
  pages.
- Reload recovery carries a browser-session claim. A delayed recovery alarm
  from an earlier Chrome session is retired without changing tabs, while an
  interrupted extension reload can still finish in the same session.
- Browser startup no longer records an automatic Snapshot while Chrome may
  still be restoring only part of the previous session. The periodic Snapshot
  alarm remains active.
- Automatic Snapshots now include normal local `file://` pages, and Snapshot
  review/recovery can identify and reopen them. Incognito and internal browser
  pages remain excluded.
- Recently closed suspended-page recovery deduplicates the same stable tab
  occurrence when it is already open or appears more than once, without
  collapsing intentional duplicate URLs.

## 0.8.618 - 2026-09-18

- Side Panel selected-card actions and the cross-card selection dock now wrap
  into clean rows at narrow widths instead of overlapping their count or title.
- “Keep N recent tabs awake” now reserves the N most recently used awake web
  tabs from time-based Suspension. At nine tabs with a value of eight, only the
  oldest eligible tab is suspended.
- Large duplicate cleanup closes in 20-tab batches with a short event-loop pause
  between batches, retaining exact-identity checks and one Undo receipt.
- Dashboard Open navigation and the Open page now count the same ordinary,
  non-private Chrome windows. Popup and app windows no longer inflate the rail.
- Fresh profiles keep one unpinned EveryTab New Tab per window by default.
  Existing profiles retain an explicit off choice.
- Focus settings put the blocked-site list first and explain the behavior as
  preventing navigation to selected sites while the user stays on task.

## 0.8.617 - 2026-09-18

- Open-row Label, Session, Snooze, protection, and related pickers now hold live
  list refreshes while an interaction is active. Incoming signals reconcile once
  after the picker closes instead of replacing its anchor during typing.
- Live title changes patch only their matching Open row. Tab load completion no
  longer rebuilds the complete Open list when no displayed state changed.
- URL, pinned, tab-structure, and window changes retain a complete refresh, with
  the same interaction hold in Dashboard and Side Panel.

## 0.8.616 - 2026-09-16

- Popup arrows now move spatially through visible actions. Escape from Search
  returns to the last popup action, or the first action when navigation has not
  started yet.
- Save Window to Inbox uses Control+Shift+I on macOS, and the Side Panel uses
  Control+Shift+S. Platform-safe Alt+Shift equivalents are suggested elsewhere.
- The Side Panel shortcut now preserves Chrome's command gesture, focuses its
  section navigation for immediate arrow entry, and toggles the panel closed on
  a second press where Chrome's current close API is available.
- Side Panel Up/Down navigation enters and traverses its current list, remembers
  logical position across rerenders, and resumes there after leaving Search.

## 0.8.615 - 2026-09-16

- The toolbar popup again reserves a synchronous intrinsic height, preventing
  Chrome from freezing it into a blank 25px strip. Its adaptive compact fit is
  retained for shorter effective popup viewports and saved Label metadata.
- The launch library refreshes Minimal Search from a large-screen viewport with
  the complete clock visible, and adds full-browser popup and Side Panel views
  over a deterministic public-page fixture.

## 0.8.614 - 2026-09-16

- Close the day now supports Shift-click range selection and its keyboard mirror,
  Shift+X. Row and window actions expose consistent mnemonic shortcuts.
- The popup calls the current-tab action “Save in Session” and binds it to `T`,
  matching the shared Dashboard and Side Panel Open-row shortcut.
- The popup sizes to Chrome's effective content height and compacts ordinary
  spacing before allowing a scrollbar, so saved Label metadata no longer causes
  a clipped footer or incidental few-pixel scroll.

## 0.8.613 - 2026-09-16

- Extension reload and update recovery shows its explanatory notification
  before reload-grace storage work begins.
- Missing suspended tabs are recreated concurrently while Chrome still receives
  their placement requests in visual order. A fixed 40-tab fixture with 18 ms
  browser effects fell from about 839 ms to about 45 ms.
- The launch screenshot workflow now captures two Minimal schemes with distinct
  welcome phrases, all 36 built-in schemes, and an active Focus run.

## 0.8.612 - 2026-09-16

- Minimal reserves the exact space above its hydrated command deck for the
  clock, welcome line and date. The complete composition scales from that
  remaining height, keeping the date visible on laptops while still filling
  large displays.
- Escape now follows the same Search exit path when keyboard focus is on a
  domain, Label or other suggestion chip as when focus remains in the input.

## 0.8.611 - 2026-09-15

- Star uses `b` on focused rows. Open-tab Close uses `w`, retaining its
  two-step safety check for keyboard activation.
- List arrows resume from the last focused row or card after an action loses
  focus. Horizontal arrows reach group and window header controls.
- Several selected rows or groups show only their selected-set actions, not
  competing individual action buttons. Close-the-day reviews follow the same
  rule and expose window bulk controls from the header select-all checkbox.
- Command/Control+R on a suspended page wakes the original tab.
- Pending Session and Label names are suggested again during Close the day,
  including the bulk Session picker. They are created only on commit.
- Minimal's clock scales with large-screen height while retaining the compact
  layout and Search geometry.

## 0.8.610 - 2026-09-15

- Open-window motion settles immediately if a live card or tab disappears while
  the list is revealing. Additive label enrichment retains its continuous reveal.
- Popup and Minimal Search grant enough result height to show ten recent tabs
  when the viewport has room. The popup navigation footer now dims with the
  surrounding controls while active Search remains clickable.
- The Search shortcut focuses an already-open popup through an explicit
  request. A new popup exposes Search during hydration so the first shortcut
  press can focus it; the ordinary popup shortcut remains unfocused.

## 0.8.609 - 2026-09-14

- Empty Search now offers up to ten recent tabs on every host, with scrolling
  preserving access when a compact surface has less room.
- Active Search dims the popup and side panel as well as Dashboard and Minimal.
  Minimal removes its redundant outer deck boundary while results are open.
- Search and the ordinary popup now have separate browser shortcuts. Search
  waits for the mounted popup and verifies focus after Chrome's initial pass.
- The side panel omits Dashboard automation awareness and hides redundant row
  label chips in Labels, preserving those details on the full Dashboard.
- Extension reload recovery immediately explains that suspended tabs will
  reopen, then updates that same notification with the recovered count.

## 0.8.608 - 2026-09-14

- The accepted spring Open-window reveal is about 10% faster without changing
  its curve or moving any row. The normal 674px viewport now completes in about
  243ms; duration remains travel-aware from roughly 203ms to 251ms.

## 0.8.607 - 2026-09-14

- The Open-window curtain now uses a restrained back-out curve for a quicker,
  springier reveal without moving or staggering individual cards.
- Duration now scales continuously from 225ms to 279ms with visible travel. The
  common 674px viewport completes in about 270ms instead of 360ms.
- Reload, reduced-motion, enrichment, resize and immediate interruption behavior
  remain unchanged from .606.

## 0.8.606 - 2026-09-14

- The Open-window entrance now moves one background-matched curtain over the
  already-composed list. Rows and cards no longer belong to the animated paint
  tree, removing the heavy clip that could look slow or stepped.
- Visible travel now finishes in two to four continuity tokens. The common
  674px viewport case completes in 360ms while keeping one balanced,
  top-to-bottom interpolation with no stagger.
- A Dashboard page reload skips the decorative entrance, so an already-visible
  list cannot flash fully, disappear and reveal again.
- Suspended-tab recovery now claims startup before retained-close cleanup and
  runs independently from it. A slow cleanup can no longer postpone the first
  reload-recovery pass.

## 0.8.605 - 2026-09-14

- The continuous Open-window entrance now travels only to the bottom of the
  visible viewport before releasing content that is already off-screen. A tall,
  tab-heavy first window can no longer consume the visible reveal near-instantly
  while the clip continues through unseen rows.
- Duration follows visible pixel travel, from three to six continuity tokens,
  rather than the total number of window cards. The complete list still commits
  before motion, and one balanced list-level clip remains the only effect.
- Enrichment and viewport changes update that effect's keyframes at its current
  eased progress instead of restarting the animation. Warm startup therefore
  keeps one clock, one curve and one original deadline through geometry changes.

## 0.8.604 - 2026-09-14

- Open-window rendering now commits the complete list before motion begins, then
  reveals the composed list through one continuous clip-path animation. A
  balanced spatial curve keeps the long top-to-bottom travel perceptible instead
  of front-loading it like a compact Search shell.
- The spatial reveal now budgets at least three continuity tokens, with one extra
  token for each body-bearing window beyond two, so short lists do not appear as
  an instantaneous block.
- The section separator stays hidden while the list is revealed and returns only
  after the final frame. Enrichment retargets from the current visible edge and
  preserves the original completion deadline without per-card effects.

## 0.8.603 - 2026-09-14

- Open-window cards reserve their complete geometry once, then reveal a
  contained body surface from the header without reflowing the section frame.
- Following cards move with compositor transforms while their serial entrance
  waits for the preceding card's full 180ms deadline.
- The section separator stays hidden and geometrically fixed until the queue
  settles, then returns with the final card boundaries.
- Optional enrichment remains continuous and coalesces geometry retargets to
  one frame.

## 0.8.602 - 2026-09-14

- Open-window entrances keep their temporary outline's lower edge quiet while a
  card grows, so the settled body frame reveals one final boundary at completion.
- Geometry changes from optional enrichment are coalesced per frame before a
  running entrance is retargeted, avoiding visible intermediate steps.

## 0.8.601 - 2026-09-14

- Open-window cards now expand as a serial top-to-bottom queue. Each card waits
  for the preceding card to finish its 180ms growth, removing overlapping
  headers and the resulting layout jitter. Counts, input, enrichment, reduced
  motion and interruption behavior remain independent.

## 0.8.600 - 2026-09-13

- Open counts use the selected text color. The Dashboard heading keeps its words
  still while two compact numeric slots settle as soon as their values are ready.
- Window cards begin expanding from top to bottom with a short capped stagger.
  Counts and input remain available independently of the sequence.
- Dashboard appearance controls and Minimal's Focus button render with the initial
  shell. Settings and Focus status update the existing controls afterward.
- MORE follows SAVED with matching section spacing instead of sitting at the bottom.
- Minimal's moving glows stay along the lower edges and clear of the clock.
- Dashboard prepares Search examples from its compact primary data; examples and
  Recent tabs appear together without waiting for optional completion or recency.

## 0.8.599 - 2026-09-13

- Pending Dashboard counts now cycle through digits instead of an ellipsis, then
  roll into the real value. Hidden tabs pause the reels; reduced motion uses a
  neutral bar. Known data is never delayed to manufacture an animation.
- Open-window cards expand from their visible headers to their full height,
  including a rounded moving lower edge. Data enrichment continues the same
  entrance; input and reduced motion settle it immediately.
- Minimal's fully visible gradient travels farther over 4.6 seconds before
  resting. A tab opened in the background now begins on its first visible frame.
  Hiding it after movement starts cancels the effect without replay.
- Accepted Search, Focus, folds, notices, tooltips and clock behavior are retained.

## 0.8.598 - 2026-09-12

- Dashboard counts roll through a full text line with an outgoing pending mark.
  First window contents uncover from top to bottom; data and input stay ready.
- Search uses stronger surrounding dimming and a measured opening. Dashboard's
  rounded shell grows with its results, including arrivals during the transition;
  Minimal moves smoothly between its resting and expanded positions.
- Focus commits its layout once and animates the complete band and following
  content, removing the inherited height animation that reflowed the Dashboard.
- Minimal's gradient orbs are now above the opaque background, where they can
  actually be seen. They settle once over 2.2 seconds. Reduced motion stays
  static and backgrounding cancels the movement.
- Temporary Search dimensions release immediately if reduced motion is enabled.

## 0.8.597 - 2026-09-12

- Dashboard counts show a neutral pending mark, then settle with a short vertical
  roll and fade. Initial window groups and the first Activity summary arrive
  together without delaying data or replaying on routine refreshes.
- Active Search gently dims its surroundings on Dashboard and Minimal while
  preserving keyboard navigation, Escape behavior, and outside clicks.
- Session and Label disclosures expand and shrink smoothly, including rapid
  reversals. Hidden contents become inert immediately and focus stays usable.
- Shared notices animate on arrival and dismissal. Repeated Undo clicks and late
  responses cannot overwrite newer feedback. Tooltips appear sooner, with
  immediate keyboard and adjacent-target feedback.
- Minimal corrects the clock's optical centering and narrow-screen overflow.
  Its existing gradient settles once on arrival, then rests. All new motion
  respects reduced motion; backgrounded Minimal stops its atmosphere animation.

## 0.8.596 - 2026-09-11

- Minimal reads Starred while its interface modules load, so available pages
  appear with the first useful frame instead of expanding the deck afterward.
  A slow saved-data read still leaves Search and navigation immediately usable.
- Dashboard keeps its More navigation steady while saved branches load. It also
  reserves space for the closed Starred control at wider window sizes, including
  the 1280-pixel Store screenshot viewport. Lists can shrink correctly beside an
  open Starred panel at compact widths.
- Automation protection links use the existing themed link treatment.
- Favicons display from embedded images or Chrome's local cache instead of
  requesting saved or imported remote icon URLs. Stored records are unchanged.
- Revised English extension description and Store copy lead with the benefits
  of organizing tabs and returning to projects. The local screenshot set shows
  Crisp, Soft, Terminal, active Focus, and automation, with Inbox/Tour alternates.

## 0.8.595 - 2026-09-11

- Search keeps its complete findings visible while `in`, `label`, `session`,
  and `domain` keyword suggestions are prepared. The combined replacement
  arrives at once instead of briefly shrinking to one row on every letter.
- Suspended-tab recovery now carries a stable occurrence identity in its page
  URL. If Chrome reveals an old extension tab after its replacement is live,
  EveryTab removes that late copy instead of registering another occurrence.
- Intentional suspended copies of the same page remain separate.
- Browser QA pages now use the same explicit storage-authority test boundary as
  current source, and relocated Scheme tools resolve from their maintained
  project-level location. This is test infrastructure only.

## 0.8.594 - 2026-09-11

- A primary Search miss now offers Chrome's default Search action immediately
  after the normal input debounce instead of waiting seconds for optional
  Session, Snapshot, and History completion.
- Deeper matching results can still arrive afterward, while the already-shown
  web Search action remains available.

## 0.8.593 - 2026-09-11

- A transient failure in Search's optional full-library completion can no
  longer leave the previous matching result visible and inactive forever. The
  current primary miss now settles to Chrome's default Search action.

## 0.8.592 - 2026-09-11

- Minimal Search gives its complete six-item initial suggestion set enough room
  when the viewport permits, so neither the first nor last result needs a
  compensating scroll.
- Open-window idle context keeps its quiet four-hour appearance threshold but
  now reports the oldest idle tab's real age in hours or days.

## 0.8.591 - 2026-09-11

- Search keeps the last complete surface visible but inactive while a new query
  resolves, removing Dashboard flashes without allowing stale actions.
- A local miss offers Chrome's default Search, and Minimal Search opens without
  scrolling past its leading suggestions.
- Open-window idle context is quieter, and Data names Chrome bookmark HTML
  imports explicitly without adding a permission.

## 0.8.590 - 2026-09-11

- Removed obsolete Workspace Focus recovery and Collections conversion from
  startup, alarms and window cleanup after their installed ledgers were confirmed
  empty. Original source and tests are preserved in the archive.
- Current Focus protection, suspended-tab recovery and saved-data format readers
  are unchanged. No user records are deleted or converted.

## 0.8.589 - 2026-09-11

- Temporary recovery timing modules, probes and their test are archived outside
  the extension. The full-worker recovery regression test remains active.
- Recovery scheduling is unchanged. Memory-only reloads were accepted; the
  final uninstrumented installed check remains open.

## 0.8.588 - 2026-09-11

- Startup diagnostics now collect timings in memory only, with no diagnostic
  Chrome API calls or persistence tasks during recovery. This comparison checks
  whether saving the reports influenced the three fast installed reloads.
- Recovery behavior and scheduling remain unchanged; the earlier delay is not
  yet considered explained or repaired.

## 0.8.587 - 2026-09-11

- Temporary, bounded startup timing reports help investigate delayed suspended-tab
  recovery. Reports contain phase names, timings and counts, not page information.
- Recovery scheduling is unchanged. This is a diagnostic build, not a confirmed
  repair of the installed delay.

## 0.8.586 - 2026-09-10

- Storage interfaces now reject incomplete adapters before writes; existing
  database and Vault formats remain unchanged.
- Background failure reports retain useful error classes without raw error text.
- Current architecture, engineering, and test guides replace accumulated setup
  history. Previous files and a complete extension baseline are preserved with
  verified hashes.
- Developer tools and unused diagnostic modules now live outside the extension.
  Retired Smart View creation code is archived; existing saved data remains readable.

## 0.8.585 - 2026-09-10

- Search builds large Snapshot completion results in short tasks, allowing input
  to be processed between chunks. Results and their ordering remain unchanged.

## 0.8.584 - 2026-09-10

- Dashboard navigation, status, and Duplicates share one tab read during each
  scheduled refresh. Rescan still reads fresh tabs; later refreshes do too.

## 0.8.583 - 2026-09-10

- Dashboard navigation uses one live-tab snapshot for its Open and duplicate
  counts, avoiding a second full-tab query on each navigation refresh.

## 0.8.582 - 2026-09-10

- Side Panel list and Focus-status refreshes wait while its document is hidden,
  then reconcile on return. A visible panel keeps updating while you use the
  browser page beside it.

## 0.8.581 - 2026-09-10

- Inactive Dashboards defer periodic status refreshes and Session-change
  prewarming until you return. Repeated changes are combined into one refresh batch.

## 0.8.580 - 2026-09-10

- The popup reuses its Inbox data when finding the active page's labels.
  Label refreshes read Inbox and Archive together instead of one after the other.

## 0.8.579 - 2026-09-10

- Vault sync can retire this device's obsolete transaction files after seven days,
  once a verified checkpoint covers their saved data. Offline devices catch up
  from that checkpoint. Shared favicons and Restore points are unchanged.

## 0.8.578 - 2026-09-10

- Vault sync can recover within the same run when another device replaces the
  manifest and checkpoint being read. Retries are bounded and resume from saved
  progress. Unchanged corruption and local storage failures still stop safely.

## 0.8.577 - 2026-09-10

- Unused local favicons can now be cleaned up after a seven-day grace period.
  Saved data, pending sync changes, Undo and Restore references remain protected.
  Vault files are unchanged.

## 0.8.576 - 2026-09-10

- Local sync history now stays bounded, including while offline or without a
  connected Vault. Saved pages, labels and Undo remain intact. When older change
  entries are trimmed, Vault sync catches up from the current saved data.

## 0.8.575 - 2026-09-10

- A Library whose older changes were already synced elsewhere can now join an
  existing Vault using its current saved data. Interrupted checkpoint publication
  can retry without losing pending edits. Storage limits are unchanged.

## 0.8.574 - 2026-09-10

- Snapshot capture, Restore, deletion and retention reject unsupported record
  versions without changing saved data. Opaque backups remain available.
- Readable Vault views refuse unsupported records instead of presenting an
  incomplete or misleading index. Current-format output is unchanged.

## 0.8.573 - 2026-09-10

- Library sync and Restore reject unsupported record formats without applying
  part of the data or consuming its sync position. Existing unsupported records
  cannot be edited or deleted by this version; exact backups preserve them.

## 0.8.572 - 2026-09-10

- Labels selections now offer the shared Label picker, including combined-label
  results. Apply labels to several saved entries with one Activity Undo.
- Save-to-Inbox Undo uses the exact save receipt, so another action completing
  at the same time cannot redirect the keyboard or popup Undo to the wrong item.

## 0.8.571 - 2026-09-10

- Snoozed selection controls use the shared action icons, including icons-only mode.
- Select multiple entries in Labels to remove their displayed labels together.
  Saved pages and other labels stay intact; one Activity Undo restores the edit.
- Inbox archive timing appears on hover or keyboard focus, without shifting
  the header. Touch devices keep it visible.
- Grouped lists no longer double the bottom row separator. End-position drag
  indicators remain available.

## 0.8.570 - 2026-09-10

- Snoozed actions refuse stale selections instead of overwriting newer changes
  or opening old addresses. Cancel and selected Wake keep exact Undo records.
- Manual and automatic Wake share one background owner. Uncertain browser
  results retain the saved Snooze and cannot silently trigger a duplicate retry.
- Refused actions keep selection and show feedback; rescheduling updates the
  saved schedule before the alarm. No new permissions or visual redesign.

## 0.8.569 - 2026-09-10

- Live Snooze saves its Undo receipt before closing tabs. Its message and
  keyboard Undo actions cannot accidentally target a newer, unrelated action.
- Session pickers apply group changes only after the save succeeds. Refused
  Inbox moves keep the selection intact.
- Snoozing saved tabs and moving Inbox tabs to Sessions preserves their labels
  and supported tab details, including labels applied to the whole Inbox item.
- Completed design prototypes are preserved outside the extension. Further
  Snoozed-section safety, performance and cleanup work remains in progress.

## 0.8.568 - 2026-09-10

- Deleting an automatic Snapshot can now be undone. Later changes or another
  deletion cannot be overwritten by an older Undo.
- Inbox and Session dragging checks the complete saved records, so a concurrent
  change cannot move the wrong tab. Last-position and multi-selection moves remain.
- Save-and-close actions recheck live tabs after saving. Tabs that navigated,
  moved windows or changed protection-relevant identity are left open.
- Close receipts record the tabs actually closed, including partial failures.
  Close the day and whole-window closing receive the same final checks.

## 0.8.567 - 2026-09-10

- Inbox Restore checks the current saved tabs before opening and again before
  removing them from Inbox. Changes made during opening remain saved.
- Failed or unconfirmed opens stay in Inbox. If only part of a Restore works,
  confirmed opens are recorded with Undo before the error is shown.
- Repeated Restore clicks no longer open the same unchanged selection twice.
  Archive's Open action is unchanged.

## 0.8.566 - 2026-09-10

- Snooze and Move to Session now check selected Inbox tabs against the current
  saved record. Old selections cannot erase newer tabs or revive deleted items.
- Repeated selections count once and retain source order. Existing Sessions
  keep their current windows and details when selected tabs are appended.
- Undo uses the saved state immediately before the move. Snooze alarms are
  created only after the source, destination and Undo commit successfully.
- Restore safety and the remaining review findings are still queued. No release
  candidate or package was generated.

## 0.8.565 - 2026-09-10

- Archiving or deleting selected saved tabs now checks the current record
  before making changes. An old selection cannot erase tabs added afterward.
- Archive preserves newer labels and saved details. Repeated selections are
  counted once, and changed or missing records are left untouched.
- Undo for new Library-backed deletions now matches the deletion actually
  stored. This also fixes Archive followed by Undo and repeated Archive/Undo.
- Restore, saved Snooze and automatic Snapshot Undo repairs remain separate
  follow-ups. No release candidate or package was generated.

## 0.8.564 - 2026-09-10

- Label edits in Inbox, Archive and named Sessions now preserve newer labels
  and saved details. Editing an item from an old view cannot bring back a
  deleted item.
- If saved tabs have moved or changed since selection, the label edit leaves
  that item unchanged. Duplicate rows remain editable from a fresh view.
- Undo restores the saved state immediately before the label change. Bulk
  selections count and journal only the tabs actually changed.
- Other saved-tab action safety repairs remain queued separately. No release
  candidate or package was generated.

## 0.8.563 - 2026-09-10

- Added clearance around Session names so letters such as the initial j in
  "job search" can retain their full shape. Long-name truncation and row
  height are unchanged. Installed visual confirmation is still needed.
- No release candidate or package was generated.

## 0.8.562 - 2026-09-10

- Tour disclosures now grow in the scrollable body without compressing the
  header, progress strip, save status, or footer.
- Expanded sidebar items use consistent 32px rows, with more separation above
  SAVED and MORE. Settings stays labelled and pinned in the footer.
- Open and Inbox filters use the shared inset focus cue, keeping the halo
  inside the field instead of letting the sticky header crop it.
- Session-link clipping remains under clarification; its styling is unchanged.
- No release candidate or package was generated.

## 0.8.561 - 2026-09-10

- Featured introduction schemes are Aladdin, Laser, Sunset Surf, Frozen Llama,
  Matcha, /dev/tty, Dracula, and Hineybeige. All 36 remain available and saved
  choices are unchanged. Hineybeige now uses its one-word display name.
- Removed the extra Blank-page sentence from the shared New Tab explanation.
- Settings now uses a shared line-cog icon. Sidebar keyboard focus is inset,
  with four extra pixels above SAVED and MORE in the expanded sidebar.
- The reported filter and Session-link clipping await the missing screenshots.
- No release candidate or package was generated.

## 0.8.560 - 2026-09-10

- Restored the Search and Vault folder icons in the introduction.
- Tightened feature-list spacing, close the list when changing steps, and
  introduce importing from other tab tools in place of the permissions entry.
- Made automatic closing explicit, simplified protection guidance, and added
  optional tab limits directly in the Automation step.
- Fixed the New Tab typing-choice divider and clarified that Chrome's
  "Change it back" option disables the whole extension.
- Scheme previews keep Dashboard regions beneath the tour instead of putting
  them in separate animation layers. Installed visual confirmation is pending.
- Finish is accented and stays in the same footer position as Next.
- No release candidate or package was generated.

## 0.8.559 - 2026-09-09

- Settings and first run share an illustrated Dashboard, Minimal, and Blank
  New Tab chooser. Blank keeps the saved typing preference for other layouts.
- The introduction now has six concise screens: purpose, saving and organizing,
  automation, New Tab, appearance, and optional Vault. No practice tasks or
  final review. Full Help remains available from a collapsed feature guide.
- Automation copy explicitly names automatic saving and closing. Protection
  explains how to keep important tabs open, including the unsaved-text limit.
- Appearance offers all 36 schemes, Scheme default, Light, Dark, System, and
  Soft/Crisp/Terminal samples. Choices update the real interface; Crisp has its
  own shape before selection. Sessions uses the regular Save-as-Session icon.
- New installations start with automatic saving and suspension off. Existing
  preferences are unchanged. Settings supports the same timing choices as the tour.
- Save ordering, failed-choice retry, and Vault cancellation are covered by
  focused tests. Installed visual/keyboard confirmation is still needed.
- No release candidate or package was generated.

## 0.8.558 - 2026-09-09

- This tab now says: "Stays protected when you navigate to other pages in this
  tab." Behaviour is unchanged.

## 0.8.557 - 2026-09-09

- The protection picker groups the active status and its scope explanation under
  Current protection, separate from the available choices.
- This tab now explains that protection continues when you open other pages in
  the same tab. Protection rules and lifetimes are unchanged.

## 0.8.556 - 2026-09-09

- Automation protection offers 24 hours or no timer for each tab, domain, and
  exact page. The tab option is called Until closed: both tab options end when
  the tab or browser closes, while extension reloads retain them.
- Open window headers, selected tabs, and the popup's This window section share
  the protection picker. Window choices cover the current web tabs, with repeated
  domains and addresses saved only once. Future tabs are not individually protected.
- P opens protection from an Open row or window header and respects an existing
  selection. In the popup, P opens protection for This tab. Inline status stays
  outside keyboard navigation and now has a visible hover underline.
- Settings lists protected tabs and temporary domains/pages with removal controls.
  Permanent domain/page rules remain in the shared protection list.
- No release candidate or package was generated.

## 0.8.555 - 2026-09-09

- Open rows now have a shield action for automation protection. The popup and
  row action share one picker, with 24-hour tab, permanent website, and exact-page
  choices. Website scope includes subdomains and is shown before saving.
- Temporary tab protection follows navigation in that tab, including checkout
  on another website. It ends on close, expiry, or browser restart. Extension
  reloads retain it; separately opened tabs do not inherit it.
- Protected status remains visible alongside Active. Inline status underlines
  on hover but is not a keyboard stop. The shield action remains keyboard-accessible.
- Settings has a dedicated Automation protection section. Existing rules remain
  intact, and removing one protection does not remove another underlying rule.
- Manual Save and Suspend remain available. Release packaging remains paused.

## 0.8.554 - 2026-09-08

- Automation status and tracks open details only when clicked or activated with
  the keyboard. Details use the shared Label/Snooze picker, with its anchor
  notch and neutral close control. Hovering alone stays quiet.
- One Protected pages list now covers automatic suspension and Auto-save.
  Existing rules from both lists are retained. Popup protection, including
  the 24-hour option, covers both actions and links to Settings for management.
- Manual Save and Suspend remain available. Suspended-tab recovery is unchanged.
- No release candidate was generated. New Tab UX is the next prototype.

## 0.8.553 - 2026-09-08

- Detailed Open rows reveal the next automatic action and a compact 48px time
  track on hover or keyboard focus. Protected and untimed states use words only.
- Inbox headers explain when saved tabs move to Archive. Hover or activate the
  status for details and a direct link to the relevant Settings section.
- Row heights and action lanes stay unchanged. Narrow rows hide the track first.
  Automatic actions, saved data, and suspended-tab recovery are unchanged.
- No release candidate was generated. New Tab UX is the next prototype.

## 0.8.552 - 2026-09-08

- Removed temporary reload timing probes, the periodic report writer, and its
  diagnostic-only test after the first .551 installed capture passed.
- Startup prioritization, Undo preflight, recovery safety, and their regression
  tests remain. No saved data or Vault files were changed.
- Automation-awareness integration is next, as a separate UI pass. No release
  candidate was generated.

## 0.8.551 - 2026-09-08

- Reload now pauses optional Session indexing immediately, before asynchronous
  initialization and recovery preparation. This closes a timing gap in .550
  when preparation lasted longer than the index timer.
- Failed preparation releases the pause. Browser recovery still waits for its
  safety preparation, and notification behavior is unchanged. The local trace
  remains for installed comparison; packaging stays paused.

## 0.8.550 - 2026-09-08

- Optional Session indexing now waits for initial suspended-tab reload recovery
  as well as its ordinary one-second delay. Empty and failed recovery release it
  once; ordinary worker starts keep their existing delay.
- This isolates one remaining startup-work overlap seen in the slow installed
  capture. Recovery safety and notification behavior are unchanged. The local
  timing trace remains for comparison; release packaging stays paused.

## 0.8.549 - 2026-09-08

- On extension reload, startup Snapshot and Inbox maintenance wait for the
  initial suspended-tab recovery pass instead of competing for storage first.
  Empty and failed recovery still release that maintenance.
- Startup skips the exclusive journal repair transaction when no interrupted
  Undo needs repair. Actual repairs still recheck fresh state under the lock.
- Recovery safety and notification timing are unchanged. The local timing trace
  remains for an installed comparison; awareness integration and packaging stay paused.

## 0.8.548 - 2026-09-08

- Temporary, user-authorized local timing trace for the unresolved suspended-tab
  reload delay. Captures startup tasks, storage contention, activity and recovery
  queues, browser operations, timer lateness, and notification delivery.
- Stores one bounded report in Chrome session storage, with no URLs, titles,
  record bodies, or error messages. No telemetry, Vault writes, or new permissions.
- Diagnostic build only: does not claim to fix the delay or change recovery
  behaviour. Awareness integration and release packaging remain paused.

## 0.8.547 - 2026-09-08

- Removes unnecessary suspended-registry reads from activity startup and tab
  cleanup, so they no longer hold up the first tabs returning after reload.
- Real tab departures still preserve their recovery timestamps atomically.
  Recovery safety, notification scheduling, and automation settings are unchanged.
- The approved automation indicators remain a separate upcoming UI pass.
  No release package was generated.

## 0.8.546 - 2026-09-08

- Automatic suspension and saving now count time from when you leave a tab,
  including when you switch windows or leave Chrome. Time spent reading the
  active tab no longer uses up that waiting period.
- Internal suspension and suspended-tab recovery preserve the time-away clock.
  Unknown tabs get a fresh waiting period. A full browser restart clears old
  numeric tab identities; an ordinary background-worker restart does not.
- Keeps existing timer settings, tab-count limits, exclusions, permissions,
  and the Inbox-to-Archive saved-date rule. No new automation is enabled.
- The approved 48px indicators are the next separate UI pass. Their mockup
  explanations now use plain language about the action and destination.
- Review and verification are recorded in `automation-timing-review-v0.8.546.md`.
  Installed confirmation is open. No release package was generated.

## 0.8.545 - 2026-09-08

- Data now follows Settings: Recover, Import and export, and Vault sync are
  visible in one scrolling page, with sticky shortcut chips to jump between
  them. Existing Vault deep links still land directly at the relevant area.
- Aligns Check automatic snapshots with its description. The later snapshot
  selector and review action keep their own responsive row.
- Import drafts and recovery reviews remain mounted during navigation. Delayed
  jumps cannot pull the page back after another destination is chosen.
- The automation-awareness comparison is a separate sample-data prototype;
  it does not change automation, settings, or saved data. The approved timing
  correction remains the next small implementation pass.
- Focused, 120 mounted Chrome, Smoke, Vault, and localization checks pass.
  The bounded review is saved in `data-layout-review-v0.8.545.md`.
  Installed confirmation is open. No release package was generated.

## 0.8.544 - 2026-09-08

- Data is the single destination for Recover, Import and export, and Vault
  sync. Existing Vault links still open its area directly. Compact More also
  exposes Activity, Archive, Snapshots, Data, and Stats.
- Switching Data areas retains prepared imports and recovery workflows. Vault
  keeps its existing independent controller and progress updates. Local area
  navigation supports keyboard arrows without losing sidebar return focus.
- Repairs Open's optional hostless filter rendering and its stale ownership
  test. Both ordinary Dashboard and Side Panel filtering stay unchanged.
- Focused tests, 116 mounted Chrome checks, Smoke, Vault, and localization pass.
  The bounded independent review is recorded in
  `data-consolidation-review-v0.8.544.md`. Installed confirmation is open.
  No release package was generated and no automation policy changed.

## 0.8.543 - 2026-09-08

- Simplifies the sidebar: Now holds Open tabs, Snoozed, and Duplicates; Saved
  holds Inbox, Sessions, and Labels; More holds Activity, Archive, Snapshots,
  Data, Vault sync, and Stats. Settings remains once in the footer, including
  keyboard navigation. Background library updates retain Inbox/More focus.
- Removes the visible Needs you heading while retaining its useful facts,
  links, and All activity route beside Search.
- Archive now offers Open and Open all without removing saved copies. Row,
  selected-set, and whole-card opens preserve labels and metadata even after
  partial browser-opening failure. Inbox Restore remains consuming with Undo.
- Focused navigation/Archive tests, 115 mounted Chrome checks, Smoke, Vault,
  localization, and syntax pass. A pre-existing hostless Open-filter defect and
  stale broader polish assertion are recorded for a separate small repair.
  Installed confirmation is open. No release package was generated.

## 0.8.542 - 2026-09-08

- Corrects Minimal's installed Escape handoff. Search now closes onto a neutral
  keyboard boundary; the next Down or Right enters the first Starred launcher,
  or the first footer destination when Starred is empty.
- Gives the resting Minimal module more room below the date through one bounded
  composition inset. Search expansion and cold-hydration motion are unchanged.
- The exact installed sequence was red under the previous direct-focus model.
  Focused and mounted Chrome regressions, Smoke, Vault, syntax, and manifest
  gates pass. Installed confirmation is open; release packaging remains paused.

## 0.8.541 - 2026-09-08

- Empty Minimal Search now hands Escape directly to the first Starred launcher,
  where arrows continue through Starred and footer destinations and Enter
  activates the focused destination.
- Dashboard Right always returns to the active section and its remembered
  position. Only Enter or Space activates a different highlighted sidebar
  destination.
- Removes the standalone `/` keycap from Search while retaining `/` as the
  universal keyboard shortcut. Focused and mounted Chrome regressions, Smoke,
  Vault, syntax, and manifest gates pass. Installed confirmation is open;
  release packaging remains paused.

## 0.8.540 - 2026-09-07

- Restores Minimal Search keyboard traversal: Down now enters its visible Recent
  tabs instead of leaving Search for Starred. Every shared Search field also
  advertises the `/` focus shortcut in a quiet right-aligned keycap.
- Adds a deliberate Dashboard content-to-sidebar keyboard bridge. Left from a
  content boundary enters the active navigation item, Up and Down move through
  destinations, Right returns to the prior content position, and choosing a new
  section starts at its first control.
- Gives Inbox the same focus-stable Filter tabs control as Open. Filtering keeps
  original saved-tab indexes, so row and bulk actions still target the exact
  records shown.
- Removes the inherited top padding that left Session window-header color short
  of its rounded block. Focused interaction, filter, presentation, Smoke, Vault,
  localization, syntax, workflow-inventory, and manifest gates pass. Installed
  confirmation is open; release packaging remains paused.

## 0.8.539 - 2026-09-07

- Completes the worker composition cleanup. `background.js` now contains
  dependency composition and Chrome-boundary registration, with no remaining
  domain operation, timer state, or inline message-handler toolkit.
- Removes three imports made obsolete by the extracted scheduler and corrects
  stale ownership comments.
- Removes five deleted transition-era tests from CI and adds a permanent check
  that every workflow test reference exists. The complete non-packaging CI
  inventory, Smoke, Vault, performance, localization, production syntax, and
  manifest JSON gates pass. Release packaging remains paused.

## 0.8.538 - 2026-09-07

- Moves ordinary worker-start maintenance and deferred initialization out of
  the composition root into one focused startup owner.
- Preserves independent task launch, lifecycle claim ordering, Session-index
  deferral, Snooze recovery, Inbox maintenance, and suspended-tab recovery.
- Adds direct coverage for the complete startup task set, reload context, and
  named failure containment. Complete lifecycle, scheduler, Smoke, Vault, JSON,
  and syntax gates pass. Release packaging remains paused.

## 0.8.537 - 2026-09-07

- Moves recurring maintenance cadences and the open-tab cap debounce into one
  focused scheduler instead of keeping timer state in the worker root.
- Preserves the 5-minute suspension cadence, 15-minute Inbox cadence,
  authoritative Snapshot reconciliation, and 900 ms cap consolidation.
- Adds direct cadence, cancellation, disabled-cap, and failure-containment
  coverage. Complete scheduler, owner, Smoke, Vault, JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.536 - 2026-09-07

- Moves Search and omnibox browser effects out of the worker composition root
  behind one shared navigation action interface.
- Preserves wake-before-focus behavior, canonical Starred matching, stale
  Session feedback, and organization deep links.
- Replaces worker-source behavior checks with direct tests for focus ordering,
  canonical reuse, missing targets, notification cleanup, and invalid routes.
  Complete Search, Smoke, Vault, package-source, JSON, and syntax gates pass.
  Release packaging remains paused.

## 0.8.535 - 2026-09-07

- Moves live tab and window Snooze capture out of the worker composition root
  behind one shared action interface used by messages, context menus, and
  keyboard commands.
- Preserves capture provenance, suspended-page identity, favicon and recurrence
  data, placement, last-window protection, persist-before-close ordering, and
  Undo records.
- Replaces worker-source inspection with direct incognito, eligibility,
  ordering, partial-close, and empty-window behavior coverage. Complete Snooze,
  incognito, Smoke, Vault, localization, package-source, manifest JSON, and
  syntax gates pass. Release packaging remains paused.

## 0.8.534 - 2026-09-07

- Moves Search-result focus, Session restore, organization navigation, URL and
  web-search launch, Starred activation, and switch-to-existing behavior behind
  one focused descriptor interface.
- Preserves sender-proven current-tab search, safe source-tab retirement,
  suspended-tab wake, badge reconciliation, and stale Session outcomes.
- Adds direct validation, provenance, routing, ordering, fallback, and
  rejection coverage; removes the final inline worker handler toolkit and the
  remaining restore-route source assertion. Complete Search, navigation,
  Smoke, Vault, localization, package-source, manifest JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.533 - 2026-09-07

- Moves explicit duplicate closing behind a focused descriptor interface.
- Preserves interrupted-action recovery ordering, canonical-key or tab
  targeting, and badge reconciliation after a successful close.
- Adds direct validation, ordering, result, badge, and rejection coverage.
  Complete duplicate, Smoke, Vault, localization, package-source, manifest
  JSON, and syntax gates pass. Release packaging remains paused.

## 0.8.532 - 2026-09-07

- Moves Undo and Activity clearing behind one focused action-journal descriptor
  interface.
- Preserves interrupted-action recovery ordering, latest-or-explicit Undo
  selection, exact status and entry projection, and safe clearing behavior.
- Adds direct ordering, validation, outcome, and rejection coverage. Complete
  journal, Smoke, Vault, localization, package-source, manifest JSON, and
  syntax gates pass. Release packaging remains paused.

## 0.8.531 - 2026-09-07

- Moves tab and window Snooze creation plus manual Snooze delivery behind one
  focused descriptor interface.
- Preserves Chrome tab lookup, interrupted-delivery recovery ordering,
  recurrence, successful-create Undo identities, window counts, and result
  shapes.
- Adds direct validation, ordering, no-op, result, and rejection coverage.
  Complete Snooze, Smoke, Vault, localization, package-source, manifest JSON,
  and syntax gates pass. Release packaging remains paused.

## 0.8.530 - 2026-09-07

- Moves the complete ten-message Close-the-day review, decision, commit,
  resume, Undo, and status protocol behind one focused descriptor interface.
- Preserves protected-tab provenance, draft and transaction validation, domain
  effects, and the existing concise resume and Undo result projections.
- Adds direct coverage across every route, invalid requests, sender identity,
  result shaping, and rejection containment. Complete Close-the-day, Smoke,
  Vault, localization, package-source, manifest JSON, and syntax gates pass.
  Release packaging remains paused.

## 0.8.529 - 2026-09-07

- Moves Open-tab single and selected-set movement, window sorting, domain
  gathering, and new-window placement behind one focused descriptor interface.
- Preserves the older single-tab compatibility route, append positioning,
  domain-owned movement and Undo planning, and existing result shapes.
- Adds direct validation, routing, argument, result, and rejection coverage;
  removes two background-source assertions. Complete movement, organization,
  Smoke, Vault, localization, package-source, manifest JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.528 - 2026-09-07

- Moves recoverable tab closing, unsaveable-page closing, and guarded
  whole-window closing behind one focused descriptor interface.
- Preserves interrupted-action recovery ordering, exact reviewed window
  identity, direct unsaveable-page behavior, and every public result shape.
- Adds direct validation, ordering, routing, identity, and rejection coverage;
  removes the related whole-window worker-source assertion and an unused
  worker validator. Complete close, Smoke, Vault, localization,
  package-source, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.527 - 2026-09-07

- Moves explicit Inbox capture for a tab, selected tabs, or a window behind
  one focused descriptor interface.
- Preserves persist-before-close domain behavior, optional tab-set labels,
  newest Undo identities for single-target captures, and existing result
  shapes.
- Adds direct validation, route, response-lifetime, Undo, no-op, and rejection
  coverage; removes the remaining source-text assertion for this route family.
  Complete Inbox, saved-data workflow, Smoke, Vault, localization,
  package-source, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.526 - 2026-09-07

- Moves saved-Session creation, existing-Session membership, and rename
  messages behind one focused descriptor interface.
- Preserves tab and window create-versus-add behavior, organization assignment,
  normalized Session identity results, and rename outcomes.
- Adds direct validation, routing, response-shaping, and rejection coverage.
  Complete Session, saved-data workflow, Smoke, Vault, localization,
  package-source, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.525 - 2026-09-07

- Moves the six direct suspended-tab lifecycle messages behind one focused
  descriptor interface, separate from reload recovery.
- Preserves explicit and sender-owned wake, mounted-page adoption, single-tab
  and rest-of-window suspension, and the accepted 24-hour or permanent
  automatic-suspension exceptions.
- Adds direct provenance, validation, result-shaping, and rejection coverage;
  removes the associated background-source assertions. Complete suspension,
  popup, lifecycle, Smoke, Vault, localization, package-source, manifest JSON,
  and syntax gates pass. Release packaging remains paused.

## 0.8.524 - 2026-09-07

- Moves the five recently closed and automatic Snapshot recovery messages
  behind one focused Data recovery descriptor interface.
- Keeps the explicit 25-entry recently closed limit, non-empty Snapshot
  selection, 1,000-entry Snapshot limit, domain effects, and safe failure
  responses unchanged.
- Adds direct validation, routing, response-lifetime, and rejection coverage;
  removes the old background-source assertions. Complete Data recovery, Smoke,
  Vault, localization, package-source, manifest JSON, and syntax gates pass.
  Release packaging remains paused.

## 0.8.523 - 2026-09-07

- Moves suspended-tab reload recovery cycles, prompt notification ownership,
  durable delivery receipts, retry identity, and late metadata repair behind
  one three-operation state owner.
- Keeps the accepted 180 ms, 650 ms, 2 second, 8 second, and 31 second safety
  schedule unchanged. The alarm dispatcher now delegates complete recovery
  tails without knowing the stored cycle shape.
- Replaces inline source-shape assertions with direct state-owner behavior
  coverage. Complete recovery, alarm, Smoke, Vault, localization,
  package-source, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.522 - 2026-09-07

- Moves mounted New Tab creation order and retirement into one focused
  singleton owner shared by runtime reset, tab lifecycle, and mounted-page
  message routing.
- Keeps the feature default-Off, preserves the active startup fallback, and
  revalidates every planned target's window, pin, privacy, activity, and URL
  immediately before removal. Closed targets and partial Chrome removal
  failures remain safely contained.
- Adds direct owner coverage and removes redundant source-text route checks.
  Complete Smoke, New Tab, Vault, localization, package-source, manifest JSON,
  and syntax gates pass. Release packaging remains paused.

## 0.8.521 - 2026-09-07

- Moves the New Tab rotation task and its handled and in-flight identities into
  one focused state owner. Its small interface now serves both message routing
  and tab-removal cleanup.
- Directly verifies one draw per tab, concurrent readiness coalescing,
  diagnostic capture, masked completion records, retry after failure, and
  state cleanup. An older task can no longer erase a newer task when Chrome
  reuses a numeric tab ID.
- Removes the remaining rotation source-text assertions. Complete Smoke, New
  Tab, Vault, localization, package-source, manifest JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.520 - 2026-09-07

- Moves the five New Tab rotation, diagnostics, and mounted-page messages behind
  one focused handler-descriptor interface while preserving the worker's single
  shared Chrome message listener.
- Adds a direct contract for current diagnostic counts, selection masking,
  sender validation, exact tab routing, asynchronous response lifetime, and
  rejected retirement work. Obsolete source-text route assertions are removed.
- Complete Smoke, message registry, rotation diagnostics, Vault, localization,
  manifest JSON, package-source, and syntax gates pass. Release packaging
  remains paused.

## 0.8.519 - 2026-09-07

- Moves the worker's bounded, privacy-safe New Tab rotation trace from an
  inline `background.js` test seam into one focused pure module. Rotation
  execution, message routing, diagnostic leases, masking, and report shapes are
  unchanged.
- Replaces source extraction and VM evaluation with a direct module contract
  covering arming, expiry, bounded retention, immutable reports, and redaction
  of custom scheme identities and filesystem details.
- Adds that direct contract to the hosted cross-platform matrix. Complete
  Smoke, rotation diagnostics, Vault, localization, manifest JSON, and syntax
  gates pass. Release packaging remains paused.

## 0.8.518 - 2026-09-07

- Moves extension install, update, and browser-start routing into one focused
  runtime lifecycle owner. Existing storage authority, recovery, Focus, menu,
  Dashboard, and worker-start operations remain in their domain modules.
- Establishes storage authority and suspended-tab grace before product-state
  reads, preserves synchronous browser-start identity claims, and retains
  asynchronous lifecycle work until settlement. Independent menu repair and
  the bounded 2-second and 8-second Focus safety passes remain intact.
- Adds a direct event contract covering install/update branching, ordering,
  task lifetime, delayed recovery, first-install Dashboard behavior, and
  failure containment. Active contributor guidance and hosted CI now name the
  current Vault V2 suite instead of the removed historical filename. Map-shaped
  recovery fixtures explicitly install the existing test-only V2 adapter, so
  the CI net no longer depends on a retired runtime storage fallback. Package
  validation now recognizes Chrome's permission-backed `/_favicon/` endpoint
  as browser-provided instead of mistaking it for a missing local asset.
  Complete Smoke, Vault, localization, manifest JSON, and syntax gates pass.
  Release packaging remains paused.

## 0.8.517 - 2026-09-07

- Consolidates Undo, Focus-access button, Focus-access body-click, and dismissal
  handling under one notification owner with exactly one listener per Chrome
  notification event.
- Keeps Undo receipts private and single-use, gives an exact registered receipt
  precedence over prefix routing, and retains asynchronous Undo and Focus work
  until settlement. Notification creation and automatic-archive registration
  keep the same small interface.
- Adds a direct event contract covering creation, receipt consumption,
  dismissal, task lifetime, Focus routing, collision precedence, and failure
  isolation. Complete Smoke, Focus, Vault, localization, manifest JSON, and
  syntax gates pass. Release packaging remains paused.

## 0.8.516 - 2026-09-07

- Moves default suggestion setup and all three Chrome omnibox events into one
  focused background owner. Existing Search ranking, stale-query suppression,
  target identity, and navigation planning remain in the Chrome-free omnibox
  module.
- Keeps accepted suggestions, cancellation, exact saved targets, typed URLs,
  default-provider searches, Sessions, organization groups, and Starred actions
  on their established paths. Suggestion and Enter tasks now remain retained
  until their asynchronous work settles.
- Adds a direct event contract covering every listener, late-query rejection,
  navigation lifetime, typed-address reuse, provider search, and saved-entity
  actions. Complete Smoke, Vault, localization, manifest JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.515 - 2026-09-07

- Moves Chrome window-removal routing into one focused background owner while
  leaving Session binding and Focus cleanup behavior in their existing domain
  modules.
- Starts both independent cleanups together, retains the event task until both
  settle, and prevents either failure from suppressing the other cleanup.
- Adds a direct event contract covering registration, concurrent start,
  slow-task lifetime, and domain-labelled failure isolation. Complete Smoke,
  Vault, localization, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.514 - 2026-09-07

- Moves activated, updated, created, and removed tab-event routing into one
  focused background owner while leaving activity, New Tab, suspension, Focus,
  duplicate, badge, and automatic-save operations in their domain modules.
- Coalesces burst badge work and retains every routed asynchronous effect until
  settlement. One failed cleanup or delayed badge refresh cannot block sibling
  lifecycle work or escape as an unhandled rejection.
- Adds a direct event contract covering all four Chrome tab events, web and
  non-web navigation, New Tab reconciliation, duplicate grace, cleanup
  isolation, and badge coalescing. Complete Smoke, Vault, localization,
  manifest JSON, and syntax gates pass. Release packaging remains paused.

## 0.8.513 - 2026-09-07

- Moves all Chrome alarm recognition and routing into one focused background
  owner while leaving Snapshot, suspension, recovery, Focus, archive, rotation,
  Snooze, and duplicate operations in their existing domain modules.
- Retains every recognized asynchronous alarm until its work settles and gives
  each domain one named failure boundary. The previously unretained automatic
  suspension sweep now has the same MV3 lifetime protection as the other work.
- Adds a direct event contract covering every alarm route, recovery ordering,
  reload-only repair, Snooze readiness, the duplicate preference, inert unknown
  alarms, and failure containment. Complete Smoke, Vault, localization,
  manifest JSON, and syntax gates pass. Release packaging remains paused.

## 0.8.512 - 2026-09-07

- Moves Storage V2 change expansion and the complete local Settings-change
  policy into one focused background owner.
- Repairs Snapshot cadence only when cadence changes, runs auto-save and Inbox
  expiry work only when their thresholds change, and preserves archive,
  rotation, badge, diagnostics, and Focus-rule reconciliation.
- Adds a direct event contract covering ordinary writes, value-free V2 pulses,
  unchanged and changed thresholds, non-local changes, and contained repair
  failures. Complete Smoke, Vault, localization, manifest JSON, and syntax
  gates pass. Release packaging remains paused.

## 0.8.511 - 2026-09-07

- Moves Chrome keyboard-command recognition, active-tab selection, side-panel
  window selection, Search-popup handoff, and feedback shaping into one focused
  background owner.
- Keeps the existing save, snooze, suspend, Dashboard, and Undo operations
  unchanged. Unknown commands now avoid an unnecessary tab query, and the side
  panel is never targeted at an ineligible popup or incognito window.
- Adds a direct command-event contract covering every route, no-op outcomes,
  Search fallback cleanup, side-panel fallback and failure, and notifications.
  Complete Smoke, Vault, localization, manifest JSON, and syntax gates pass.
  Release packaging remains paused.

## 0.8.510 - 2026-09-07

- Moves page context-menu replacement, localized creation, and click routing
  into one focused background owner.
- Keeps the existing save and snooze operations unchanged and delegates only
  their tab or window identities and preset due times.
- Adds a direct lifecycle contract covering all four commands, removal before
  recreation, and inert unknown or incomplete clicks. Complete Smoke, Vault,
  localization, manifest JSON, and syntax gates pass. Release packaging
  remains paused.

## 0.8.509 - 2026-09-07

- Moves Undo-bearing command notification creation, receipt ownership, button
  consumption, and dismissal cleanup into one focused background module.
- Automatic archive and Inbox-expiry notifications register their existing
  journal receipts with that same owner. Focus access and reload-recovery
  notifications retain their independent routes.
- Replaces the former background source-shape assertion with a direct event
  contract covering single-use Undo, unrelated buttons, dismissal, and notices
  without Undo. Complete Smoke, Vault, localization, JSON, and syntax gates
  pass. Release packaging remains paused.

## 0.8.508 - 2026-09-07

- Gives recently closed and automatic Snapshot recovery one shared selection
  controller for checked candidates, pending controls, retry state, result
  acknowledgement, and post-action refresh.
- Keeps each recovery source, candidate presentation, worker message, and
  result wording separate, so this maintainability pass changes no recovery or
  storage behavior.
- Adds a direct controller contract alongside the mounted Data recovery flow.
  Focused recovery, complete Smoke, Vault, localization, manifest JSON, and
  syntax gates pass. Release packaging remains paused.

## 0.8.491 - 2026-09-06

- Makes the shared canonical address the heading of every Duplicates group,
  while retaining Chrome's per-tab title in each copy row.
- When those row titles differ, adds one quiet explanation that Chrome may keep
  an older title for a background tab until the user switches to it.
- Keeps URL-based detection, survivor choice, Window context, Keep state, and
  every close path unchanged. Focused presentation checks, the mounted
  98-check Dashboard gate, and the complete Smoke suite pass. Release
  packaging remains paused.

## 0.8.483 - 2026-09-05

- Caps each device's active Vault transaction manifest at 128 incremental
  descriptors, then replaces them with one verified replication base.
- Publishes rollover through two alternating base slots: the inactive base
  settles before the manifest advances, so an interrupted write leaves the
  previously referenced state intact without accumulating checkpoint copies.
- Keeps immutable transaction history untouched, preserves zero-write
  no-change syncs, and lets a new or lagging device hydrate the verified base
  before reading only later chunks. Interruption, tamper, continuation, Vault,
  Storage V2, concurrency, favicon-scale, Loading, portable-state, Smoke, and
  syntax gates pass. Release packaging remains paused.

## 0.8.482 - 2026-09-05

- Shares one complete transient Session/Snapshot read between Search facets and
  deferred results in the same interaction generation.
- Keeps the ordinary-source primary result progressive, retains only compact
  counts and names after the short reuse window, and invalidates reuse on every
  relevant saved-data or browser change.
- The permanent 2,000 Snapshot by 72-tab regression now requires one
  authoritative Session-family read instead of two. Search scope, Label,
  invalidation, keyboard, mature-profile, Smoke, and storage-concurrency gates
  pass. Release packaging remains paused.

## 0.8.481 - 2026-09-05

- Retains the captured favicon when a single tab is Snoozed from any creation
  path, including Inbox triage and Close the day.
- Uses Chrome's local favicon cache for older saved web rows with no stored
  icon. Failed captured sources retry the cache, then site initials and distinct
  browser/file glyphs provide a stable fallback instead of an empty block.
- Adds Chrome's Favicon API permission. Because EveryTab already requests the
  broader `tabs` permission, this introduces no additional installation warning
  and does not contact the website.
- The mounted 97-check Dashboard test, Snooze ownership and placement, Storage
  V2, Vault, portable state, performance, Loading, Smoke, native IndexedDB, and
  syntax gates pass. Release packaging remains paused.

## 0.8.471 - 2026-09-05

- Absorbs one transient Chrome File System Access `NotReadableError` inside the
  Vault operation before any failed-sync receipt or disruptive banner is
  published.
- Retries once after a short yield. Repeated read failures still reach the
  existing recovery UI, while permission denial, cancellation, invalid data,
  and stalled operations are never retried or hidden.
- The exact fail-once/succeed-once regression, persistent and non-transient
  failure cases, Vault protocol, storage authority, Smoke, performance,
  Loading, package reachability, and syntax gates pass. Release packaging
  remains paused.

## 0.8.470 - 2026-09-05

- Introduces one permanent `storageAuthority` record for the exact active
  Library and Recovery databases. Runtime selection no longer exposes a
  conversion receipt to the installed Store boundary.
- Promotes the accepted installed profile deterministically without opening,
  copying, renaming, or deleting either database. The previous pointer remains
  intact for this one installed confirmation build.
- Starts fresh profiles with the same permanent record and invalidates live
  read caches if the authority changes.
- Exact-identity, installed-promotion, fresh-install race, Store, Vault,
  package, exact temporary-package Chrome, Smoke, performance, Loading, syntax,
  and native IndexedDB gates pass. Release packaging remains paused.

## 0.8.469 - 2026-09-05

- Removes the completed one-time Storage conversion, cutover, rollback, and
  browser-retirement framework. Its unlinked setup page and tests that existed
  only for that journey are gone as well.
- Narrows the real-Chrome IndexedDB contract to the installed Library and
  Recovery interfaces: atomic transactions, durable reopen, exact Restore and
  Undo, Snapshot retention, and content-addressed favicon reuse.
- Removes obsolete transition writers from the storage-policy and package
  inventories. The packaged runtime now resolves to 188 reachable files.
- Native IndexedDB, Vault protocol, storage authority, package, Smoke,
  performance, Loading, and syntax gates pass. No release archive was kept.

## 0.8.468 - 2026-09-05

- Makes the installed Vault boundary single-path. Folder selection, permission,
  status, metadata, and manual or automatic sync now use only the current
  incremental Vault protocol.
- Removes the complete retired sync engine, its runtime generation switch,
  staged-setup UI, old folder test write, and three tests that exercised only
  that deleted implementation.
- Moves concurrent-sync coverage to the actual incremental protocol and keeps
  the no-folder-access guarantee when another page owns the sync lock.
- Removes transition language from the Vault page. The page now explains only
  the current user-owned folder, incremental changes, Recovery, favicons, and
  readable views.
- Vault protocol, timeout recovery, storage authority, session responsiveness,
  Smoke, performance, Loading, portable-state, presentation, and syntax gates
  pass. Release packaging remains paused.

## 0.8.467 - 2026-09-04

- Presents permanent page protection from the popup inside the ordinary
  **Never suspend these** list. Exact pages appear as readable complete URLs;
  their internal portable encoding never appears in Settings.
- Reserves the separate structured list for device-local 24-hour exceptions.
- Keeps the popup action highlighted for every matching protection source:
  exact page, broader domain or URL-fragment rule, and temporary exception.
  Each state includes a direct link to Suspension Settings.
- Adds mounted coverage for editing an exact page in the ordinary blacklist
  without changing temporary exceptions. Smoke, Vault, storage authority,
  popup keyboard, Search, presentation, Loading, suspended recovery,
  performance, localization, portable-state, syntax, and real Chrome Settings
  gates pass. No release archive was generated.

## 0.8.466 - 2026-09-04

- Keeps temporary and permanent automatic-suspension exceptions visible every
  time the popup opens, including the remaining time for a 24-hour exception.
- Adds a direct Suspension Settings route plus a structured page-exception list
  where temporary or permanent exact-page protection can be removed.
- Keeps broad domain and URL-fragment rules in their existing editor while
  hiding internal `page:` encoding from the user-facing field.
- Shares one tested status and removal model between the popup and Settings.
- Smoke, mounted Chrome Settings, popup keyboard, Search, Vault, performance,
  syntax, locale JSON, and 320px Settings pressure checks pass. No release
  archive was generated.

## 0.8.465 - 2026-09-04

- Restores fast suspended-tab recovery without weakening the close-versus-
  recovery safeguards. One reload pass now reads its recovery cycle once and
  records all completed occurrences in one durable commit instead of claiming
  and completing every tab separately.
- Keeps retained close intents in memory after their one durable read. Source
  ownership is still checked before and after every Chrome tab effect, but no
  longer rereads the cleanup ledger for each tab.
- Adds a deterministic 40-tab latency regression. With simulated 3 ms storage
  operations, recovery falls from 248 operations and about 939 ms to 11
  operations and about 30 ms. All suspended recovery, race, conservation,
  Smoke, Vault, Loading, and performance gates pass.
- This remains an installed test build. No release archive was generated.

## 0.8.464 - 2026-09-04

- Fixes a native IndexedDB no-change sync failure. Equal lower and upper keys
  with one open bound describe an empty adapter range, but Chrome rejects that
  shape in `IDBKeyRange.bound`. The adapter now returns the empty result before
  issuing an IndexedDB request.
- Adds the exact native Chrome regression through the production Library sync
  path. Native Storage V2, focused Vault V2, full Vault, and syntax gates pass.
- This is an installed test build. Release-candidate packaging is paused until
  the remaining installed feedback is resolved and explicitly accepted.

## 0.8.463 - 2026-09-04

- Adds **Never suspend for 24 hours** and **Never suspend this page** to the
  popup's current-tab actions. The temporary choice stays device-local; the
  permanent exact-page rule is portable with Settings.
- Renames the Settings section to **Snapshots and Sessions**, updates the
  Session navigation count immediately after a new Session is saved, and shows
  up to 50 tabs per Open window before the accented **Show more** control.
- Consolidates suspended-tab reload recovery into one notification and one
  receipted recovery cycle. A durable user-close intent now wins over recovery,
  so a transient registry failure cannot recreate a deliberately closed tab.
  Cleanup receipts identify the exact suspended occurrence rather than Chrome's
  reusable tab id. Recovery revalidates before and after browser effects and
  removes a replacement page if a concurrent close wins.
- Makes first-install Storage V2 initialization resumable after MV3 worker
  termination and reports retryable initialization failures instead of
  swallowing them. Background startup tasks now own and report rejections.
- Keeps Session navigation, Stats, and retained Smart View compatibility off
  the automatic Snapshot payload path under Storage V2. This also restores the
  correct Snapshot count in navigation without cloning Snapshot contents.
- Completes three independent final reviews for correctness, performance, and
  human maintainability. No P0 or P1 release blocker remains. The accepted P2
  scalability and refactoring work is recorded in `pre-beta-code-review.md`.
- Smoke, Vault, Storage V2, suspended-tab recovery, Session responsiveness,
  Search performance, Loading, mounted Dashboard and side-panel, package, and
  isolated Chrome-for-Testing gates pass. The reproducible Store archive
  contains 189 verified runtime files and an exact SHA-256 receipt.

## 0.8.462 - 2026-09-04

- Reconciles the manifest-backed Chrome Web Store description with Storage V2.
  It no longer implies that an optional plain-file Vault is EveryTab's primary
  store, and now states the no-account, no-server, no-telemetry model directly.
- Rewrites the Store listing, permission justifications, reviewer instructions,
  landing page, and privacy policy against the final 36-scheme product and the
  August 2026 Chrome Web Store disclosure rules. Local handling of tab titles,
  addresses, and user organization is now explicit while developer collection
  remains accurately stated as none.
- Adds a permanent brand contract for Chrome's 132-character description limit
  and the Storage V2 wording. Runtime behavior, permissions, data, and Vault
  formats are unchanged.
- Adds a reproducible Chrome Web Store packaging tool. It copies only the 202
  runtime files, verifies every local import and resource, rejects remote or
  dynamically evaluated code, keeps `manifest.json` at the archive root, and
  writes a SHA-256 inventory receipt beside the ZIP. Tests, prototypes, and
  development metadata cannot enter the upload package.
- Removes three obsolete English catalogue entries and makes the localization
  audit name any future dead keys directly.

## 0.8.461 - 2026-09-04

- Fixes the false `latest-local-data-synced` Phase A blocker. The old check
  compared a completed sync timestamp with the latest UI revision pulse, even
  though that pulse can arrive after already-synced data or represent
  device-local companion state.
- Every successful V2 sync now receipts the exact Library and Recovery sequence
  heads actually published to the Vault. Retirement compares those heads with
  the current IndexedDB heads under its existing locks.
- A real Library edit or automatic Snapshot after Sync still blocks Phase A.
  Late notifications and local-only writes no longer do. Older sync receipts
  fail closed and require one new **Sync now** before retirement.
- Adds a publication-race regression proving that work created after Vault
  publication remains pending rather than being falsely receipted. Retirement,
  Vault V1/V2, Smoke, portable-state, Loading, mature performance, syntax, and
  native Chrome IndexedDB gates pass. The installed Phase A receipt is accepted:
  all 186,919,646 targeted legacy browser bytes were reclaimed, the old folder
  permission and 18 inactive databases were removed, both active V2 databases
  were preserved, and no external Vault file changed.

## 0.8.460 - 2026-09-04

- Adds the explicit Phase A action for the sole pre-release profile. It removes
  only the exact obsolete V1 record maps from Chrome, forgets only the old V1
  folder permission, and removes disposable V2 staging and Restore-rehearsal
  databases. The active V2 Library, Recovery store, V2 Vault permission,
  operational state, open tabs, and every external Vault file remain untouched.
- Rechecks all eight readiness safeguards under the Vault and Store locks before
  writing a durable receipt. The latest no-change sync must cover the latest
  local V2 commit, closing the final change-after-sync gap.
- Makes cleanup crash-resumable and idempotent. Any interruption permanently
  closes Return to V1, preserves the exact target plan, and exposes **Continue
  Phase A cleanup** until verification completes.
- Removes large V1 Chrome records one at a time and suppresses their physical
  deletion events as product mutations. This bounds one-time event memory and
  prevents mature-profile list rebuilds or a temporary default-settings paint.
- The cleanup path contains no external-file write or delete primitive. Its
  memory interruption suite, real Chrome and IndexedDB cleanup gate, full Smoke,
  Vault V1/V2, portable-state, Loading, and mature performance gates pass.
  Installed completion was accepted with v0.8.461's exact sync-head repair.

## 0.8.459 - 2026-09-04

- Adds one read-only, fail-closed **Retire old storage** check for the sole
  pre-release profile. It requires the active V2 authority to match its exact
  conservation receipt, the separate V2 Vault to be connected, and the latest
  sync to report no changes.
- Measures the complete V2 Vault under the sync lock, then completely reads and
  verifies the newest sealed Restore point, including its checkpoint, records,
  and favicon digests. A missing or concurrent state blocks readiness.
- Measures the remaining V1 browser data without loading its large record maps
  and reports whether the old folder handle is retained. The check does not
  open the old Vault, change the authority marker, remove browser data, delete
  databases, or write to either Vault.
- Adds **Review old storage** after a verified Storage check and keeps the
  existing V1 rollback available until a separate explicit cleanup decision.
- Adds the retirement contract to the hosted Windows, macOS, and Linux matrix.
  Storage V2, conservation, Restore, Vault V1/V2, Loading, Smoke, mature
  performance, and native Chrome IndexedDB gates pass. The installed
  first-publication favicon phase is accepted at under about one second.

## 0.8.458 - 2026-09-04

- Speeds up first publication of a large Storage V2 favicon set. One bounded
  eight-worker asset writer now owns the complete sync, so the bootstrap
  Library checkpoint and first Recovery pack share successful work instead of
  probing and reading the same files again.
- Treats a newly verified empty Vault as empty during that first publication,
  removing one guaranteed-missing lookup per asset while preserving the
  write-before-manifest crash boundary.
- Adds a sealed Recovery asset receipt. Later Snapshot increments and bounded
  compaction reuse assets that the same Recovery history already published;
  older manifests remain valid and gain the receipt on their next change.
- Reads independent favicon assets with the same bounded concurrency during
  bootstrap and exact Restore while preserving manifest order and digest
  verification.
- Adds 40-asset read/write and full 400-asset bootstrap plus Recovery-compaction
  performance gates to the permanent Linux matrix. Under the slow-folder
  fixture, 400 shared Library and Recovery favicons fall from more than five
  seconds and 2,400 operations to about 1.5 seconds and the 1,200 operations
  needed to create 400 files. The 40-asset read path completes in about 95 ms.
- Smoke, Vault V1/V2, Storage V2 authority, staging, exact Restore, watchdog,
  Loading, mature responsiveness, syntax, and native Chrome IndexedDB gates
  pass. Existing V1 and V2 data remain untouched.

## 0.8.457 - 2026-09-04

- Adds a read-only **Storage check** to the connected Storage V2 Vault page.
  It measures the complete selected folder by file metadata and reports total
  bytes, files, directories, and stable protocol areas without exposing folder
  names, file names, identities, URLs, titles, labels, or Session names.
- Verifies the latest sync receipt strictly. A no-change result requires zero
  pulled records, pushed records, transaction reads and writes, favicon reads
  and writes, Recovery work, Restore-point work, view writes, pruning, and
  conflicts. If the last sync included work, the UI asks for one more sync
  before measuring again.
- Runs the scan under the same non-blocking Vault lock as sync, so its size and
  receipt cannot be mixed with a concurrent write. File metadata reads use a
  fixed four-worker pool and the feature performs no work until explicitly
  requested.
- Adds a copyable privacy-safe report and explicit checks against the 20 MiB
  expected target and 100 MiB retained-data budget. No V1 or V2 data is moved,
  archived, rewritten, or deleted.
- Storage-audit, Smoke, Vault V1/V2, native Chrome IndexedDB, watchdog, Loading,
  syntax, and mature Vault responsiveness gates pass. Chrome 152's separate
  fresh-profile unpacked-extension gate did not expose its worker or extension
  storage; installed Storage-check confirmation remains open.

## 0.8.456 - 2026-09-03

- Repairs new Session creation from tab and window actions. An ungrouped new
  Session now omits the optional Group assignment instead of sending a null
  value that the background worker rejected. Creating inside a Group and adding
  to an existing Session remain unchanged.
- Makes the worker accept the older null form from an already-open extension
  page during a reload, so the repair is safe across mixed live contexts.
- After choosing or naming a Session, focus now moves to **Save as Session**.
  Pressing Enter a second time completes the save; **Organize** remains an
  optional action on the same screen.
- Adds a focused regression covering an ungrouped new Session payload and final
  action focus. Smoke, Vault, popup keyboard, worker registry, syntax, and
  mature-profile Vault Session responsiveness gates pass.

## 0.8.455 - 2026-09-03

- Adds exact Restore from the seven verified daily Storage V2 Vault points.
  The Vault surface first previews live records that will be added, replaced,
  or removed, then requires a separate explicit replacement action.
- Verifies the sealed backup reference, complete checkpoint, every entity, and
  every favicon digest before changing local data. A stale preview or an
  interrupted transaction changes nothing.
- Restores the selected Library state as newer atomic mutations, so the chosen
  older point cannot be defeated by newer bad edits or deletions and can sync
  normally to another device. Open Chrome tabs and automatic Recovery
  snapshots remain unchanged.
- Retains one complete pre-Restore safety point locally. The Vault page keeps
  **Undo Restore** and **Keep restored data** available across reloads; Undo
  refuses to overwrite edits made after Restore.
- Adds memory, real IndexedDB, Vault protocol, tamper, stale-preview,
  interruption, Recovery-separation, and mature-profile performance coverage.
  The mature exact Restore takes about 449 ms with a 91 ms maximum input gap
  and emits only the one logical record mutation in the measured scenario.

## 0.8.454 - 2026-09-03

- Adds one verified Storage V2 Library restore point per UTC day when saved
  data changed. An unchanged day reuses the latest checkpoint and writes only
  a small sealed reference instead of serializing the Library again.
- Keeps the newest seven daily references. Checkpoints no longer referenced by
  those days are removed only after the replacement reference is durable;
  the permanent bootstrap checkpoint remains available.
- Writes `maintenance.json` last. If Chrome or a cloud folder interrupts the
  operation, the next sync adopts a completed immutable reference or safely
  resumes maintenance without advertising partial work.
- Keeps same-day and ordinary no-change syncs free of checkpoint exports,
  backup scans, and Vault writes. The mature profile projects to 32.06 MiB for
  seven Library restore points plus retained Recovery, compared with the old
  1.40 GiB Vault.
- Adds protocol coverage for same-day suppression, unchanged-day reuse,
  retention, bounded reference size, and interrupted receipt recovery. Full
  Storage V2, Vault V2, legacy Vault, watchdog, staging, mature performance,
  Loading, and Smoke gates pass.

## 0.8.453 - 2026-09-03

- Adds two generated, non-authoritative views at the Storage V2 Vault root.
  `library.json` is a complete self-contained projection of live saved data,
  with embedded favicons restored. `index.md` is a concise overview of counts,
  Label and Session groups, named Sessions, Collections, and Starred pages.
- Keeps automatic Snapshots, tombstones, replication receipts, and transaction
  history out of both views. On the mature fixture, the readable Library is
  1.89 MiB despite 200 retained 72-tab automatic Snapshots.
- Writes a small sealed `views.json` completion receipt only after both derived
  files settle. Missing or interrupted files regenerate on the next sync. A
  current receipt makes a no-change sync skip the complete Library export and
  all view writes; a Recovery-only change also leaves the views untouched.
- Adds pure content, missing-file repair, interrupted-write recovery, and
  mature-size gates. Smoke, legacy Vault, Vault V2, watchdog, Storage V2,
  staging, Snapshot scheduler, Loading, and performance suites pass.

## 0.8.452 - 2026-09-03

- Speeds up a Vault sync that needs to add many new favicon assets. The former
  path awaited every independent File System Access lookup and write in series,
  multiplying cloud-folder latency by the number of unique favicons.
- Uses a fixed pool of four asset writers. Each content-addressed file still
  verifies any existing exact content, every write finishes before its manifest
  can be published, and one failed asset stops new assignments and fails the
  complete sync.
- Adds a latency regression with 40 unique assets and simulated slow folder
  operations. It fails with serial concurrency of one and passes at bounded
  concurrency four in roughly 360-420 ms, compared with about 1.3 seconds for the
  modeled serial path. Vault V2, watchdog, Storage V2, staging, Loading, mature
  performance, Smoke, legacy Vault, and syntax gates pass.

## 0.8.451 - 2026-09-03

- Repairs automatic Snapshots after the Storage V2 cutover. Live tabs without
  favicons no longer place an `undefined` optional field in their durable tab
  reference, which previously caused the complete Recovery capture to fail.
- Keeps the MV3 alarm alive until the Snapshot is durable and contains startup
  failures instead of leaving detached rejected work. Changing another Setting
  no longer restarts and postpones an already-correct Snapshot alarm.
- Adds direct scheduler coverage plus a real Chrome and IndexedDB gate that
  creates consecutive automatic Snapshots with and without favicons, retains
  only the configured count, skips an unchanged arrangement, and publishes the
  Session revision used by the interface.
- Leaves open tabs device-local. A changed arrangement is captured on the next
  Snapshot check; unchanged arrangements do not create duplicate Snapshots.
  Library `pushed` counts remain separate from Recovery Snapshot publication.

## 0.8.450 - 2026-09-03

- Adds bounded device-scoped Recovery replication to the Storage V2 Vault. The
  first sync packages the retained automatic Snapshots once in a compressed
  immutable pack; ordinary later syncs package only new or changed Snapshots.
- Keeps routine work proportional to change. A no-change sync reads only the
  small local Recovery ledger and device manifest, exports no Snapshot bodies,
  enumerates no pack directory, and writes nothing. A retention-only change can
  advance the manifest without rewriting surviving Snapshot payloads.
- Shares content-addressed favicon assets with the Library instead of embedding
  the same image in every Snapshot. At sixteen incremental packs, the next
  Snapshot creates one compact replacement pack and removes obsolete packs only
  after the new manifest is durable.
- Separates Vault filesystem primitives, Library replication, and Recovery
  replication into focused modules. Protocol coverage includes no-change I/O,
  incremental writes, retention cleanup, bounded compaction, and a mature
  200-Snapshot by 72-tab fixture. Smoke, legacy Vault, Storage V2, watchdog,
  loading, performance, and native Chrome/IndexedDB gates pass.

## 0.8.449 - 2026-09-03

- Fixes the installed V2 transition state exposed by the 0.8.448 Vault check.
  A verified staging copy was still `v2-staged`, so the Vault surface presented
  the previous V1 folder and began its 174-file scan instead of asking for the
  remaining explicit activation.
- Represents that state as **Storage V2 prepared** with one **Continue V2
  setup** action. It no longer exposes or starts the legacy Vault from this
  transition screen. The old folder and local V1 records remain untouched.
- Keeps the safety boundary explicit: only **Start V2 local trial** changes the
  authority marker. After that succeeds, Vault shows the separate unset V2
  destination and **Connect new folder…**.
- Extends the real Chrome IndexedDB gate through both visible Vault routes:
  staged selects setup without a V1 handle, while active selects the separate
  V2 handle after the authority change.

## 0.8.448 - 2026-09-03

- Adds the first incremental Storage V2 Vault gate behind the already accepted
  explicit local V2 trial. V2 uses a separate stored folder handle and sync
  receipt, so the previous V1 Vault is never opened, scanned, or changed.
- Accepts only a new empty folder or an existing verified V2 Vault. The first
  sync writes one exact Library checkpoint with content-addressed favicons;
  later local changes publish bounded immutable per-device transaction chunks
  and advance that device's manifest only after the chunk is durable.
- Adds source-bound manifests, durable remote cursors, content-hash validation,
  whole-record conflict resolution, and a verified bootstrap path for a second
  device joining a populated Vault. A replaced local Library cannot continue
  an older device sequence by accident.
- Makes steady-state work proportional to change. A no-change sync enumerates
  only the Vault root and device manifest directory, reads the small format and
  manifests, and writes nothing. Assets are opened directly by digest rather
  than scanning the asset directory. Long favicon transfers report progress so
  the inactivity watchdog does not mistake useful work for a stalled sync.
- Adds protocol tests for initialization, checkpoint import, two-device
  convergence, deletion and favicon fidelity, idempotence, no-change I/O,
  source replacement, and legacy-folder isolation. Recovery packs, generated
  readable views, daily checkpoint references, and Vault Restore remain the
  next V2-4 slice.

## 0.8.447 - 2026-09-03

- Adds the explicit local V2 trial gate to the unlinked staging tool. It first
  compares every current logical V1 Library record and retained Recovery
  Snapshot with the staged databases, using the same aggregate hashes as the
  verified conservation report.
- Holds the Vault lock and Store lock through the final comparison and marker
  write. A current-data change cannot fit between freshness verification and
  activation. A stale family, changed retained Snapshot, missing database, or
  mismatched receipt leaves V1 authoritative and asks for a fresh staging run.
- Starts V2 only after a separate user click. During the trial, the legacy Vault
  is paused and V1 record maps remain untouched. The same tool can return to V1
  immediately; trial writes remain preserved in the V2 databases.
- Extends memory and real browser-backed IndexedDB coverage for fresh and stale
  staging, atomic activation, V2 product mutations, frozen V1 state, explicit
  rollback, and its retained trial receipt. This build does not activate the
  current profile automatically or modify either Vault folder.

## 0.8.446 - 2026-09-03

- Records the successful installed staging baseline: every Library and Recovery
  conservation check passed, including empty-database Restore and exact favicon
  reconstruction. The current profile's 200 retained automatic Snapshots and
  7,529 Snapshot URL occurrences produce a 7,365,286-byte V2 backup instead of
  the copied 1.40 GB V1 Vault layout.
- Adds one reversible logical storage boundary for the future local cutover.
  The current map-shaped product interface can read and mutate the split V2
  Library and Recovery databases without exposing their physical schemas to
  features. Small Archive writes, named Sessions, automatic Snapshots, Settings,
  Undo history, and device-local state all cross this same boundary.
- Sends small revision pulses to live extension pages instead of copying large
  record maps through Chrome storage. Settings retain exact old/new event values,
  and cross-page Undo notices fetch the current small journal when needed.
- Keeps `v2-staged` dormant and V1 authoritative. V2 opens only behind the
  explicit `v2` generation plus a verified receipt; returning to `v2-staged`
  immediately restores the untouched V1 route. Legacy Vault sync refuses to
  write while V2 is authoritative, preventing split authority before Vault V2.
- Extends memory, native Chrome, Vault, portable-state, performance, and Smoke
  gates for the authority route and its rollback. This build does not activate
  V2, modify current V1 records, or change either Vault folder.

## 0.8.445 - 2026-09-03

- Fixes the mature-profile V2-2 Inbox conservation failure without weakening
  exact verification. Two different favicon data URL representations can
  decode to the same image bytes. The first staging build used only those
  decoded bytes for asset identity, collapsed both representations, and could
  not reconstruct the original record exactly.
- Content-addresses the complete embedded favicon representation. Exact repeats
  still deduplicate, while differently encoded values remain distinct and
  restore byte-for-byte.
- Adds the minimized two-tab regression that fails on v0.8.444 and passes on
  this build. A privacy-safe replay of the copied mature Vault also conserves
  all 174 Inbox records: 55 live records plus 119 compact deletions. No current
  v1 data, browser tabs, or Vault files were changed.

## 0.8.444 - 2026-09-03

- Adds the explicit one-user storage v2 staging converter. It reads one coherent
  logical v1 snapshot, routes named Sessions into the synced Library, and routes
  only the newest configured automatic Snapshots into the separate local
  Recovery database. Deleted automatic-Snapshot payloads do not enter either.
- Adds verified empty-database Restore primitives for Library checkpoints and
  Recovery packs. Hashes, record identities, lifecycles, versions, asset
  references, and favicon digests are validated before one atomic seed into a
  genuinely empty database; the operation refuses to overlay existing data.
- Produces a privacy-safe aggregate conservation report covering every portable
  family, URL occurrence and Label-assignment counts, compact deletions,
  retained Snapshots, resolved favicon assets, and the exact Restore rehearsal.
  It contains no URL, title, Label, Session name, record id, or favicon value.
- Adds an unlinked development staging page that runs only after an explicit
  click and holds the Vault sync lock for the conversion. A successful run
  records the verified database pointers as `v2-staged`; ordinary product reads
  still use v1, and no v1 data or Vault file is changed or deleted.
- Adds memory, native Chrome, three-OS CI, and mature-shape performance gates.
  The 3,574-Archive / 55-Inbox / seven-Session / 200-Snapshot / 446-old-tombstone
  fixture produces a 4.96 MiB staged backup in about 3.3 seconds locally. The
  real current-profile staging run remains the next explicit verification.

## 0.8.443 - 2026-09-03

- Adds the shadow-only storage v2 local foundation. One deep Library module now
  owns atomic record transactions, hybrid logical versions, compact deletions,
  content hashes, content-addressed favicon assets, replication cursors, and a
  bounded durable outbox behind one interface.
- Adds a physically separate Recovery module for automatic browser-arrangement
  Snapshots. Retention is hard-bounded, pruning hard-deletes old Snapshots, and
  reference-counted favicon assets are removed when their last retained
  Snapshot disappears.
- Provides both the production IndexedDB adapter and a transactional in-memory
  adapter. Interface-level tests cover rollback, clock reversal, remote replay,
  corrupt and incomplete batches, asset deduplication, deletion propagation,
  recovery pruning, and asset collection. The real Chrome gate passes locally
  and now runs on all three hosted operating systems.
- Keeps the new path completely disconnected from the extension runtime. This
  build does not create or read the v2 databases, convert data, switch storage
  authority, change Vault sync, or touch the current local store and copied
  1.40 GB Vault. The one-user staging conversion is next.

## 0.8.442 - 2026-09-03

- Fixes a split-authority durability gap for named Sessions. Vault sync and
  manual Export now read the same logical Session view as the interface, so a
  compact rename or edit cannot leave an older Session in the Vault or backup.
- Adds focused regressions that failed on the previous code and prove both
  portable Export and Vault push retain compact named-Session edits.
- Records the storage v2 contract accepted after three independent architecture
  reviews. IndexedDB becomes the local library authority, automatic Snapshots
  move to a separate bounded recovery database, and Vault v2 uses immutable
  incremental transaction chunks plus generated readable views.
- Uses a one-user, side-by-side conversion instead of a permanent legacy
  migration framework. Current Chrome storage and the copied 1.40 GB Vault stay
  untouched until exact URL, Label, Session, recovery, asset, backup, reload,
  and sync verification passes.

## 0.8.441 - 2026-09-02

- Adds a privacy-safe, read-only Vault health analyzer before any storage
  migration or cleanup. It reports counts, lifecycle state, byte totals,
  repeated embedded-favicon cost, backup size, and Restore-limit failures
  without exposing ids, filenames, titles, URLs, Labels, Session names, or
  other values.
- The copied mature Vault is now a deterministic red-capable baseline: 1.40 GB
  total, including 1.22 GB across seven daily backups and 179.15 MB across 678
  Session records.
- Confirms the main amplification chain: 200 live and 446 deleted automatic
  Snapshots contain 168.21 MB of repeated embedded favicons, although their 176
  unique images total only 3.88 MB. Every current daily backup exceeds the
  128 MiB Restore limit.
- Records the safety-first redesign in `vault-storage-redesign.md`. No Vault,
  browser, saved-data, sync, backup, or cleanup behavior changes in this build.
- The privacy fixture and copied mature-Vault size guard pass as designed.

## 0.8.440 - 2026-09-02

- Fixes the installed **Syncing Inbox…** stall at the data boundary. A mature
  Vault can retain many historical tombstone files even when only a few Inbox
  items are visible; those cloud-backed files were being opened and read one
  after another.
- Reads per-record Vault files through a bounded eight-request pool. Result
  order and merge semantics remain deterministic, while providers no longer
  multiply one-file latency by the complete directory size.
- Shows bounded file counts during mature directory scans, so a long operation
  visibly advances instead of presenting one unchanged phase.
- The new delayed 128-file Inbox regression fell from 1,833.4 ms to 270.5 ms.
  Vault merge, conflict, tombstone, lock, storage-concurrency, responsiveness,
  Smoke, Loading, mature Search, performance, and syntax gates pass.

## 0.8.439 - 2026-09-02

- Fixes the mature Vault retry loop at its source. The watchdog now measures
  inactivity rather than total sync duration, and real folder progress resets
  it. A large healthy scan can therefore finish without being falsely marked
  as stalled.
- Shows the current Vault phase while a sync runs and immediately hides the
  stale failure it is replacing.
- Makes secondary Dashboard tabs follow the active sync owner instead of
  storing **another tab is already syncing** as a new error.
- Records the owning EveryTab tab only for a genuine stall. **Restart sync**
  reloads that exact owner to release its Web Lock, including when the action
  is clicked from another Dashboard.
- Keeps the Vault warning inside the measured sticky header, and makes
  **Details** reveal and focus the exact Vault status.
- The progressive-sync, inactive-folder, remote-owner restart, sticky-banner,
  Vault, Smoke, Loading, mature responsiveness, performance, syntax, and real
  Chrome UI gates pass.

## 0.8.438 - 2026-09-02

- Prevents a mature Vault scan from stretching into minutes behind another tab
  or window. Current Chrome now resumes each cooperative batch with prioritized
  scheduling rather than a throttled timer.
- Keeps hidden Dashboard tabs from starting redundant Vault scans until they
  become visible.
- Replaces the ineffective post-timeout retry with **Restart sync**. It reloads
  the page that owns the abandoned task, safely releases its Web Lock, and lets
  the fresh page perform a real sync.
- Reports a legitimate sync in another EveryTab tab instead of treating the
  skipped attempt as a successful click.
- The two-attempt lock recovery, throttled-continuation, Vault, mature-profile
  responsiveness, Smoke, Loading, performance, and syntax gates pass.

## 0.8.437 - 2026-09-02

- Stops a stalled browser folder operation from leaving Vault controls on
  **Syncing…** indefinitely. After 20 seconds the interface reports a clear,
  retryable failure and restores **Sync now**.
- Keeps the underlying merge safe: the timeout does not cancel or duplicate
  it, the existing cross-context lock remains authoritative, and a later
  successful completion replaces the temporary failure receipt.
- Adds the never-settling Vault regression and mature-profile responsiveness
  checks to the three-OS portable matrix. Vault, Smoke, Loading, performance,
  responsiveness, and syntax gates pass.

## 0.8.432 - 2026-09-01

- Makes a Needs you Activity link keep its exact arrival highlight through a
  concurrently queued Activity refresh, including the first visit from another
  Dashboard section.
- Names a representative affected link in every new automatic Inbox save and
  expiry entry. Multi-item events name the first link and state how many more
  were affected, with shorter matching copy in Needs you. Earlier entries use
  their existing Undo payload to gain the same detail without a data migration.
- Rebuilds expanded Search as two matching halves of one focus contour and
  insets its neutral separator away from the rounded edge.
- Renames the Labels prompt to **Filter by labels…**, keeps its focus contour
  inside the control, and leaves enough room before the top-layer suggestions.
- The exact coalesced-render race, automatic-event copy and metadata, mounted
  Search/Labels geometry, Smoke, Vault, Loading, localization, and mature
  Search performance gates pass. Installed confirmation remains open.

## 0.8.431 - 2026-09-01

- Moves named Session context into the same row metadata line as **This tab**
  and **Pinned**, while keeping each Session name linked to its exact card.
- Keeps the open scheme catalogue fully opaque above the page crossfade, so
  old page text cannot flash through the picker during a preview.
- Removes both remaining drag-start layout shifts. Window-end bars are
  non-load-bearing overlays, and each full new-window destination is anchored
  to a zero-height boundary between cards.
- The real Dashboard fixture proves a 0px drag-start shift, an opaque picker
  transition, linked Session placement, and a full correctly positioned
  new-window target. Close-the-day at 320/800/1280px, theme interaction,
  Label entry, selected drag, Smoke, Vault, performance, and Loading gates pass.
  The standalone side-panel fixture rendered its first 320px case as passing
  but its owned Chrome process did not exit; installed compact confirmation
  remains open with the three requested checks.

## 0.8.430 - 2026-09-01

- Replaces Session pills on Open, Inbox, Archive, and Close-the-day rows with
  distinct **In Session:** text. Each Session name is a direct link to its exact
  highlighted card in the Sessions section.
- Keeps the scheme picker on its fixed plane during previews and lengthens the
  coherent whole-page crossfade slightly, without affecting first paint or
  reduced-motion mode.
- Makes drag destinations overlap their insertion boundary instead of entering
  document flow, so beginning a drag no longer moves the rows underneath it.
- Prevents a Chromium event-order edge from adding both an existing Label and
  the stale one-letter query used to find it.
- Label-entry, drag, Close-the-day, theme, 320/800/1280px mounted interaction,
  Smoke, Vault, performance, Loading, localization, and syntax gates pass.
  Installed confirmation remains open.

## 0.8.429 - 2026-09-01

- Adds the complete shared Snooze picker to Close the day at row, window, and
  selected-tab level. A reviewed Snooze is stored and scheduled before its tabs
  close, and Undo cancels it before restoring the tabs.
- Replaces the ambiguous confirmation with an exact action count and clearer
  **Before closing** and **Tabs to close** summaries.
- Shows both Labels and named Session memberships on Open, Inbox, Archive, and
  Close-the-day rows. Session markers use a separate color and the compact
  Session identity index, so automatic Snapshots never enter these render paths.
- Makes visible scheme changes one short whole-page crossfade when the browser
  supports View Transitions. Initial paint and reduced-motion mode remain
  instant, and individual components no longer repaint at different speeds.
- Preserves the saved order when multiple suspended tabs are reconstructed on
  extension reload. Immediate Undo after saving selected tabs to Inbox now
  restores each tab to its original window, index, and pinned state.
- Corrects same-window drag insertion for Chrome's remove-before-insert index
  shift, so the visible destination line is the actual landing position.
- Smoke, Close-the-day domain and 320/800/1280px mounted interaction, theme
  interaction, Vault, portable-state, performance, Loading, placement,
  conservation, and syntax gates pass. Installed confirmation remains open.

## 0.8.428 - 2026-09-01

- Removes the literal `null` that appeared when the optional Group organizer
  had no secondary action. Its introduction now explains that Groups organize
  Labels or Sessions and that membership can be changed later in the matching
  section.
- Brings the same inline **Organize…** flow to Close the day. Label and Session
  targets remain visible in their original picker, Group choices remain part
  of the review draft, and nothing is created while the user is still deciding.
- Resolves newly created Sessions to their committed identity, saves the Group
  plan before closing any browser tab, and records resumable completion in the
  existing Close-the-day receipt.
- Close-the-day domain and 320/800/1280px mounted interaction gates, Smoke,
  Vault, portable-state, organization, performance, Loading, localization, and
  syntax checks pass. Installed confirmation remains open.

## 0.8.427 - 2026-09-01

- Keeps every chosen Label or Session in its original picker and reveals one
  inline **Organize…** disclosure below it. The same flow now works for new and
  existing targets, with no second screen and no full Group catalogue outside
  the searchable field.
- Edits one selected member exactly. Multiple selected members start with one
  safe shared addition that preserves every existing membership; **Set groups
  separately** reveals one exact input per Label or Session. Suggestions are
  bounded to five matches and unmatched text creates a Group on Apply.
- Commits the complete Group plan atomically with stale-revision protection.
  A new Group used by several members is created once, automatic Snapshots stay
  excluded, and a concurrent membership change prevents the entire exact plan
  from writing.
- Organization, UI-policy, Search, Popup-keyboard, Smoke, Vault, Restore,
  performance, Loading, and syntax gates pass. The mounted page completed all
  35 wide interaction checks before the owned Chrome process missed teardown;
  compact and installed visual confirmation remain open.

## 0.8.426 - 2026-09-01

- Adds one optional Groups step only when a picker creates a new Label or
  Session. Existing targets still save immediately. The same step can select
  existing groups, create new groups, or continue with no group.
- Shares the flow across Popup, Dashboard, and side-panel Label and Session
  actions. Dismissing or going back writes no organization data, and a primary
  Label or Session save remains successful if its optional Group update fails.
- Makes creation-time membership additive and journaled through the existing
  organization domain. A concurrent membership is preserved, Snapshots remain
  excluded, and newly created Sessions now return their exact committed version
  for immediate stale-safe follow-up actions.
- The mounted 33-check creation flow, organization, Label-entry, Smoke, Vault,
  Restore, performance, Loading-starvation, localization, and syntax gates pass.
  Installed confirmation remains open.

## 0.8.425 - 2026-09-01

- Makes the visible selected-set toolbar the authoritative shortcut owner.
  Repeated L, S, and T activations stay anchored to the same visible action,
  while I, A, Z, R, C, and D can no longer fall through to a row or whole-card
  action because focus returned somewhere else.
- Registers rendered Session controls plus Archive and Snoozed bulk actions in
  the same semantic shortcut contract. A selected subset always remains the
  operation target; selecting two tabs and pressing I cannot save the complete
  five-tab window.
- Lets Enter toggle every focused list checkbox, matching Space. The 78-check
  mounted Dashboard gate, Smoke, Vault, performance, Loading, Popup keyboard,
  and syntax gates pass. Installed confirmation remains open.

## 0.8.424 - 2026-08-31

- Anchors keyboard-opened Label and Snooze menus to the visible action that
  owns the shortcut. A programmatic shortcut now transfers focus before the
  click, so selected-set menus no longer fall back to the page or appear in an
  unrelated position.
- Makes action-menu arrows spatial. Left and Right move across a choice row;
  Up and Down move to the nearest choice above or below instead of treating
  the menu as one flat button list.
- Adds mounted regressions for both shortcut-owned menus and the complete
  two-dimensional Snooze path. The 57-check Dashboard browser gate, Smoke,
  Vault, performance, Loading, and Popup keyboard suites pass. The side-panel
  pressure page reports pass, although its Chrome process twice missed the
  existing 10-second teardown deadline. Installed confirmation remains open.

## 0.8.423 - 2026-08-31

- Promotes favorite star **F, Compact favorite**, and checkmark **H, Rounded
  confident** to the shared Dashboard, Settings, Soft, and Crisp interfaces.
- Keeps anchored Label and Session menus at one stable footprint while their
  results change. Page scrolling repositions the open menu instead of
  dismissing it, and the reveal no longer scales the menu away from its anchor.
- Claims a Snooze choice immediately. The menu closes on the first click and
  ignores every later click while that Snooze is being saved, preventing
  duplicate entries.
- Shows the complete Inbox instead of hiding cards behind a generic disclosure.
  A real mounted 250-card fixture completes in 34.8 ms, comfortably inside the
  interaction budget.
- Aligns Inbox expiry, its Needs You warning, and visible saved age on the
  stable time the item entered Inbox. Labeling or reorganizing an item no
  longer silently postpones expiry. Smoke, Vault, portable-state, performance,
  Loading, localization, scheme, Interface-style, and the 54-check mounted
  Dashboard gate pass. Installed confirmation remains open.

## 0.8.422 - 2026-08-31

- Makes selected-set shortcuts independent of row focus. **L**, **I**, and the
  new **T** Session shortcut now invoke the visible action for the complete
  selection even after focus returns to the page; Session hover tips advertise
  **T** on row, card, and selected-set actions.
- Right-aligns Rotation and Interface style in the scheme-sheet header with a
  wider gap. Light, Dark, and Scheme default remain inside the live preview
  session instead of dismissing the sheet; other outside clicks still close it.
- Gives Minimal spatial keyboard navigation: Left and Right stay within a row,
  Down moves to the next visual row, and Up reverses the path back to Search.
- Adds a directly openable comparison study with eight lighter favorite stars
  and eight rounded, logo-balanced checkmarks. Production glyphs remain
  unchanged until one of each is selected. The focused mounted Dashboard,
  Minimal navigation, deterministic, Vault, Restore, performance, Loading,
  localization, and real scheme-sheet Chrome gates pass. The comprehensive
  fresh-profile Minimal runner currently stops earlier at its unrelated Focus
  hydration wait, so installed confirmation remains open for the spatial keys.

## 0.8.421 - 2026-08-31

- Refines the Dashboard scheme sheet without reflowing the page. Favorite stars
  use one centered SVG control, compact Rotation and Interface style controls
  occupy the sheet header, and clicking elsewhere closes the sheet. Scheme
  choices and favorite changes still keep it open for comparison.
- Makes list shortcuts selection-aware. When tabs are selected, a shortcut such
  as **L** invokes the matching selected-set action instead of one focused row;
  list action tooltips include their shortcut wherever one exists.
- Keeps late-growing Label and Session pickers inside the viewport with one
  internally scrolling top-layer panel. Soft and Crisp checkmarks regain a
  fuller shape.
- Gives Minimal an explicit keyboard path from empty Search through Starred,
  Dashboard, Settings, and Focus, with Arrow Up returning to Search. Mounted
  Dashboard, real Minimal, scheme-sheet, and 320/800/1280 Interface-style Chrome
  gates pass, together with Smoke, Vault, Restore, performance, Loading, and
  localization suites. Installed confirmation remains open.

## 0.8.420 - 2026-08-30

- Moves the Dashboard scheme catalogue out of the sidebar takeover and into a
  stable bottom sheet over the main content. The left navigation, active
  section, appearance controls, and original palette trigger remain visible;
  opening the sheet never reflows or scrolls the Dashboard.
- Keeps Favorites as a readable first column and places the four built-in
  families beside it. All 36 built-ins fit at once on a 1440 by 900 Dashboard;
  constrained heights and large personal libraries fall back to one contained
  sheet scrollbar. Names continue to wrap rather than truncate.
- Favorite toggles update only the affected list, so the sheet and pointer do
  not jump. Applying a scheme updates the current state and live Dashboard
  without dismissing the sheet. The persistent palette trigger, Escape, and a
  dedicated close control all dismiss it.
- Adds a compositor-only 180 ms rise and reverse exit with a centre-drawn
  accent boundary, deterministic settle fallbacks, and the shared reduced-motion
  contract. Smoke, Vault, portable-state, performance, Loading, localization,
  Minimal, the 4,212-pairing audit, 31 refreshed contact sheets, and a real
  unpacked-Chrome scheme-sheet interaction gate pass. Installed confirmation
  remains open.

## 0.8.419 - 2026-08-30

- Promotes Minimal direction **C, All-caps inscription**, to production. The
  optional phrase now sits between the clock and date as a large, wrapped
  inscription. A new portable **Phrase tone** setting offers Clock tone or
  Accent tone, with Clock tone as the fresh-profile default.
- Replaces the sidebar's floating scheme menu with a contained, full-height
  catalogue. It opens as a real sidebar takeover, keeps the current scheme and
  back action fixed, presents Favorites first in one readable list, groups the
  complete catalogue below, and never truncates scheme names. Escape and the
  back control restore focus to the opener; rail and header navigation use the
  same responsive drawer.
- The strict 36-scheme / 72-map audit remains green across all 4,212 production
  pairings and 31 refreshed contact sheets. Focused settings and Minimal tests,
  the complete deterministic suites, and real unpacked-Chrome Dashboard and
  Minimal gates pass. Installed confirmation remains open, as does the named
  automatic Activity / Needs you observation.

## 0.8.418 - 2026-08-30

- Repairs suspended tabs that Chrome leaves on its internal **Error code: 5**
  document during an unpacked-extension reload. Recovery now distinguishes a
  genuinely mounted suspend page from a tab that merely retains the same URL,
  then forces one in-place navigation without moving or duplicating the tab.
- Lets the reload teardown settle for two seconds before its first recovery
  pass. Ordinary browser startup keeps its immediate recovery path, and the
  exact Error-5, partial-teardown, placement, favicon, Vault, Restore, Loading,
  and mature-profile performance gates pass.
- Makes both active visual studies open directly from `file://` in Chrome and
  permanently guards that contract. Minimal now offers six substantially larger
  clock-message-date treatments in either clock or accent tone. The sidebar
  study adds the selected full takeover with Favorites fixed above the complete
  scheme catalogue.
- Keeps the installed verification for named one-tab automatic Activity and
  its Needs you deep link open until a real automatic event occurs.

## 0.8.417 - 2026-08-30

- Promotes the accepted Crimson Peach maps as the built-in **Aladdin** scheme,
  with Light as its default, and removes the temporary Aladdin candidate shelf.
  The 36 built-ins / 72 mode maps pass all 4,212 production pairings. All 31
  current contact sheets were recaptured against the same source.
- Prevents an older asynchronous Open-filter render from restoring a stale
  caret after faster typing. The exact rapid-input regression now stays at the
  end of the current query.
- Makes group removal explicit in both membership directions. Individual
  Label and Session pickers explain removing selected groups with ×, while an
  active group's member picker explains that unchecking removes membership.
- Names a single automatically saved tab in Activity, shortens the matching
  Needs you entry, and routes that entry to a focused, temporarily cued exact
  Activity row.
- Adds unlinked five-direction studies for Minimal's clock-message-date
  hierarchy and a sidebar-contained, bottom-rising color-scheme picker. No
  production layout is selected by these studies.

## 0.8.416 - 2026-08-29

- Corrects the Crimson variation study after installed-direction feedback.
  Frozen Llama is now a reference for saturated tonal construction, not for a
  cyan palette.
- Replaces the four blue-led Light trials with Crimson Peach, Crimson Saffron,
  Crimson Coral, and Crimson Apricot. The complete Crimson family defaults to
  Light and uses peach, amber, coral, and sun-warmed yellow across its canvas
  and materials, with no white surfaces in the four new trials.
- Gives each Dark map a separate poster-led composition of navy, indigo, or
  plum with orange-coral light and restrained Genie blue. Crimson Sunset itself
  keeps its exact Light/Dark colors, and all eight candidates pass the production
  contrast gate.

## 0.8.415 - 2026-08-29

- Keeps **Aladdin: Crimson Sunset** exact and adds four editor-only variations
  around it: Crimson Turquoise, Crimson Lapis, Crimson Genie, and Crimson Rose.
- Gives every new Light map fully tinted vivid materials, with no white page,
  card, or raised surface. Their color hierarchy borrows Frozen Llama's
  saturated blue and turquoise structure while retaining crimson and violet.
- Builds the neighboring Dark maps from midnight indigo, Genie blue, coral,
  rose, and violet rather than the poster-title yellow. All eight complete
  candidates pass the production role and contrast boundary and remain outside
  the built-in catalogue until the installed comparison settles a direction.

## 0.8.414 - 2026-08-29

- Adds four editor-only Aladdin color studies from the supplied sunset scene:
  Sunset Palace, Magic Carpet, Crimson Sunset, and Genie Twilight. Each has a
  complete Light and Dark map built from the scene's sun gold, crimson clouds,
  lapis carpet, turquoise clothing, periwinkle Genie, and violet skyline.
- Keeps the studies outside the built-in catalogue, rotation pool, Settings
  picker, and first-paint path. The Scheme Editor can compare them or save a
  chosen direction as a local custom scheme without changing the 35 built-ins.
- Validates every candidate through the complete production role and contrast
  ledger. Focused scheme, custom-scheme, performance, Loading, Smoke, and Vault
  gates pass; installed visual comparison remains open.

## 0.8.413 - 2026-08-28

- Gives Open rows, selected-tab actions, and whole-window actions the same
  Save to Inbox, Save as Session, then Label order. Whole-window headers now
  include the previously missing Label action and reuse the shared picker.
- Retires Perestroika from the built-in portfolio because it is too close to
  Jamón. Existing saved Perestroika selections safely resolve to Jamón on the
  first paint, including older backups and Vault data.
- Keeps the resulting 35-scheme catalogue strict: all 4,095 production
  pairings pass and the compact pressure fixture includes the added window
  action.

## 0.8.412 - 2026-08-28

- Places **Interface style** first in Appearance and repairs the complete,
  centered checked mark in Soft and Crisp. Terminal keeps its intentional
  `[ ]`, `[x]`, and `[-]` selection language and gains a stable Focus width.
- Replaces the separate Color scheme dropdown with one categorized scheme
  catalogue. The main area applies a scheme, the star independently marks a
  Rotation favorite, the current scheme is explicit, and the explanation no
  longer changes height after the first favorite.
- Keeps the Starred edge rail clear of Dashboard content at compact widths and
  skips its document transition while the page is scrolled, preventing sticky
  rows from flashing through during expansion or collapse.
- Makes the Open-window four-hour count update at its next real threshold with
  one scheduled wakeup instead of a polling refresh.
- Offers **Create new label** in the shared Label picker when typed text has no
  exact match, and puts Session first in Open, Inbox, and Session bulk actions.

## 0.8.411 - 2026-08-28

- Replaces the separate Corner style and Checkbox shape controls with one
  **Interface style** setting: Soft, Crisp, or Terminal. Existing profiles keep
  their Soft or Crisp presentation; retired values remain portable for older
  backups and Vault data.
- Promotes the approved Terminal direction as a skin over the ordinary product.
  It keeps every feature, route, color scheme, and safety flow while using the
  native monospace stack, square structures, quiet elevation, and `[ ]`, `[x]`,
  and `[-]` selection controls.
- Gives all eight production pages the same first-frame style contract. A real
  browser matrix covers Dashboard, Minimal, popup, side panel, Settings, and the
  scheme editor in all three styles at 320, 800, and 1280 px.

## 0.8.410 - 2026-08-27

- Gives Session actions the same stable anchored picker as Label actions. The
  action remains visible while one searchable field creates a Session or picks
  an existing one, including in the Popup.
- Rebalances the Popup into equal tab and window action grids with secondary
  utilities in their section headings, so labels remain readable at the fixed
  Popup width.
- Removes Move from individual rows. Pointer drag and the selected-tabs Move
  workflow remain available for intentional placement changes.
- Retires Terminal as a New Tab page and removes its colon commands. Existing
  saved Terminal preferences safely open Dashboard. Five unlinked studies now
  explore Terminal as a future interface style using the ordinary product,
  data, actions, and color schemes. Their controller is inline so the comparison
  works when the HTML file is opened directly in Chrome. **B. Operator Ledger**
  is the selected direction: its prototype uses scheme-derived materials and
  Terminal `[ ]` / `[x]` selection rather than browser-default surfaces.

## 0.8.409 - 2026-08-27

- Keeps selected tabs selected after non-removing actions such as Label,
  Suspend, Wake, Restore, Move, or saving to a Session. Rows that an action
  actually removes still disappear from the selection naturally.
- Gives Popup tab and window actions, Open rows, and Inbox rows the same
  searchable Session picker for creating a Session or choosing an existing one.
- Lets one saved Session be appended to another without changing the source.
  Selected tabs across saved Sessions can also be deleted through one confirmed,
  stale-safe operation with one exact Undo.

## 0.8.408 - 2026-08-27

- Repairs suspended tabs whose URLs had already been reduced to the title
  **Suspended** with no favicon. The delayed upgrade repair finds the newest
  richer copy in local automatic Snapshots and rewrites the existing suspended
  page in place.
- Does not wake, move, close, or duplicate a repaired tab. Tabs without a local
  richer source remain untouched rather than receiving guessed metadata.
- Keeps the historical Snapshot scan off ordinary recovery and first paint.
  Normal startup performs no Session read for this repair.

## 0.8.407 - 2026-08-27

- Keeps the original page title and favicon when a restored suspended page
  reasserts its recovery record. The live EveryTab page title and extension icon
  can no longer overwrite that source identity.
- Repairs already affected recovery records from the still-mounted suspended
  page before Chrome removes and recreates it during an extension reload.
- Records the successful Snapshot recovery of 40 missing occurrences; the
  first-upgrade conservation and selected Snapshot recovery gate is accepted.

## 0.8.406 - 2026-08-27

- Closes the first-upgrade migration hole exposed by the main profile. During
  the reload grace window, the new worker now adopts every mounted EveryTab
  suspended page before Chrome tears down the old extension renderers, even
  when an older reload had already removed that page's registry record.
- Adds a second inspect-first recovery under **Data**. It compares up to 50
  recent local automatic Snapshots with the tabs open now and lists only the
  missing occurrences, including the correct number of duplicate URLs.
- Opens only the selected missing tabs, grouped into new windows matching their
  Snapshot windows. Current windows stay unchanged, and a fresh comparison
  before opening prevents repeated clicks from creating duplicate recoveries.

## 0.8.405 - 2026-08-27

- Prevents extension reload from deleting suspended-tab recovery records when
  Chrome's removal events race the new worker's recovery marker.
- Makes recovery merge-safe when another tab is suspended, woken, or closed
  while the recovery pass is waiting on Chrome.
- Lets each mounted suspended page repair its own recovery identity.
- Adds an explicit review under **Data → Recover suspended tabs**. It finds only
  this EveryTab installation's recently closed suspended pages, shows the exact
  recoverable selection, and opens nothing until **Recover** is chosen.

## 0.8.404 - 2026-08-26

- Separates the two Label-page interactions. The field and its suggestion rows
  only add or remove filters; the lower row is explicitly labelled **Jump to:**
  and always navigates to one Label.
- Keeps selected Labels in the suggestion list with a checkmark and a complete
  accent selection band, so the active AND filter is visible before and after
  another choice.
- Moves the suggestion ledger into Chrome's top layer. Sticky headers and list
  overflow can no longer hide it, and scrolling inside the ledger leaves it
  open.

## 0.8.403 - 2026-08-26

- Adds exact, additive Label facets to shared Search. Multiple Labels use AND
  semantics and compose with ordinary text plus a source, Session, or domain.
- Gives the Labels section the same removable-filter grammar and one truthful
  saved-occurrence intersection. Open's local filter remains title and URL only.

## 0.8.402 - 2026-08-26

- Keeps retained EveryTab pages from competing with a newly opened New Tab or
  Popup. Inactive Dashboards collapse browser and storage events into one dirty
  batch, while an On-open scheme draw no longer rebuilds every Dashboard or
  repeats full theme preparation in every live extension page.
- Adds a permanent three-window, 120-tab Chrome gate. Three retained Dashboard
  openings complete in 158.0 to 175.7 ms and the following Popup in 65.1 ms on
  the local release machine, all within the 200 ms installed budget.
- Marks the exact Dashboard-hosting row as **This tab**, independently of the
  focused browser window.
- Keeps Close available for local files, Chrome pages, and extension pages.
  These pages use a separate two-step **Close without Undo?** path that cannot
  bypass recovery for an ordinary web page.
- Shows progressively more saved-label chips as a ledger widens and supports
  repeated Open filters such as `label:work label:urgent` with AND semantics.
- Keeps source-window Snooze placement marked for further everyday-use
  confirmation.

## 0.8.401 - 2026-08-25

- Returns a woken single-tab Snooze to its source window and tab-strip position.
  The placement hint is device-local and never enters Backup, Restore, or Vault.
- Survives a full Chrome restart, where window ids change, by matching the
  restored source from its surviving nearby pages. A same-session wake uses the
  exact live window id.
- Refuses ambiguous placement. If the original window cannot be identified
  safely, EveryTab creates one separate background window instead of silently
  putting the tab into an unrelated window. Existing synced and legacy Snoozes
  without a local hint keep their established behavior.
- Adds deterministic same-session, restart, ambiguity, locality, recurrence,
  and single-owner coverage. Smoke, Snooze ownership, Vault, portable-state,
  performance, Loading, and syntax gates are green.

## 0.8.400 - 2026-08-25

- Removes the underlying mature-profile Session write stall. Renaming,
  creating, labeling, grouping, moving, deleting, and undoing a named Session
  now update a small named-record projection instead of rewriting and
  broadcasting the complete automatic-Snapshot history.
- Keeps the legacy Session/Snapshot map intact and merges the projection into
  every ordinary read, Export, Restore, Search, and Vault path. Existing data,
  record identities, automatic Snapshots, portable JSON, and Vault files do not
  change format.
- Adds a permanent 2,000-Snapshot by 72-tab responsiveness fixture. The exact
  rename/create path that previously blocked the event loop for 817.4 ms now
  keeps the maximum input gap to 7.1 ms. Smoke, Vault, portable state,
  organization, performance, Loading, refresh, and syntax gates are green.

## 0.8.399 - 2026-08-25

- Removes the remaining delayed freeze after a Vault-backed Session change.
  Vault completion now refreshes only the Vault surface, its sidebar status,
  Needs you, and no longer rebuilds the unrelated saved-library navigation.
- Extends the mature-profile regression through the post-sync `vaultMeta`
  event. That previously missed navigation scan falls from 133.1 ms to 0.0 ms
  in the permanent 2,000 Snapshot fixture.

## 0.8.398 - 2026-08-25

- Removes the second mature-profile pause after Session create or rename.
  Session-only changes now patch the Session navigation branch and Snapshot
  count instead of cloning and walking the complete saved library.
- Keeps Vault sync cooperative while it scans large folders, so pointer and
  keyboard input receive regular task boundaries during the delayed sync.
- Reuses the maps already merged by Vault when regenerating `index.md`. A
  Session sync no longer clones the large Session/Snapshot map two additional
  times after its required fresh merge read.
- Adds permanent 2,000 Snapshot responsiveness gates for both immediate
  Dashboard refresh and the delayed Vault tail.

## 0.8.397 - 2026-08-25

- Gives Open-tab rows, selected tabs, and whole Open windows the same complete
  Snooze picker as the Popup, including Custom time and recurrence.
- Adds Snooze to each Open window header. Compact headers move the complete
  six-action lane to a second line under pressure instead of hiding a control.
- Moves Session choices into Chrome's top layer so sticky rows cannot clip or
  paint over them.
- Restores a Session action immediately after a choice, while the durable
  Session and Vault-backed write continues. Neighboring controls no longer feel
  frozen on a mature profile.

## 0.8.396 - 2026-08-25

- Insets the open-Search separator four pixels from each side, keeping its
  endpoints visibly clear of the connected accent contour in every scheme.
- Reveals the popup Label panel before focusing its text field. Clicking Label
  or using its shortcut now leaves the input ready for immediate typing without
  scrolling the popup.

## 0.8.395 - 2026-08-25

- Moves Dashboard and Command Deck's open-Search divider inside the text field,
  so the neutral separator can no longer cross the rounded outer contour.
- Prevents popup action shortcuts from firing while any text input, textarea,
  select, or editable field owns typing, including retargeted document events.
- Re-anchors popup label deep links while the Dashboard sticky label controls
  finish laying out, keeping the requested label card fully visible.
- Makes Inbox expiry reliable for legacy records without a modification time,
  runs immediately when its threshold changes, and awaits the complete durable
  alarm sweep. A recently changed item still expires from its last change, not
  from the older date on which it first entered the Inbox.

## 0.8.394 - 2026-08-25

- Removes Terminal's remaining Search radius and shadow overrides. Command Deck
  now inherits the exact connected Dashboard Search contour, including square
  joining corners, the shared focus treatment, and the neutral middle divider.
- Prevents an absent Terminal command section from becoming a literal `null`
  text node in Dashboard, Minimal, popup, or side-panel Search.
- Adds real unpacked-Chrome regressions for both the ordinary Dashboard text
  tree and Terminal's shared connected-corner geometry.

## 0.8.393 - 2026-08-24

- Fixes the intermittent Command Deck keyboard trap after Escape. Down now
  leaves an empty closed prompt for the first visible tab row, while Up alone
  recalls the latest successful Terminal command.
- Removes the accent guide from both the focused-empty Commands shortcuts and
  typed command results. They remain distinct Search sections through their
  heading, ordering, and command typography.
- Replaces the competing external focus shadows with one exact Terminal-only
  accent border around the connected field and dropdown. Their middle divider
  stays neutral and aligned.
- Extends the real unpacked-Chrome gate through Escape-to-list navigation,
  Up-only recall, guide absence, exact contour colors, 320px pressure, scheme
  rotation, and singleton New Tabs.

## 0.8.392 - 2026-08-24

- Moves the five Command Deck shortcuts into focused-empty Search as a distinct
  **Commands** section between Jump to and Recent tabs. The detached shortcut
  strip is gone, so resting Search returns to one clean field and route content.
- Keeps the command shortcuts on the shared ghost-button pointer and keyboard
  model. Typing `:` still replaces the focused-empty sections with the complete
  command result group.
- Repairs the focused Search contour in Terminal. The field and its connected
  dropdown now draw the same outer accent boundary on one exact horizontal
  axis instead of leaving the dropdown edge several pixels outside the field.
- Extends the real unpacked-Chrome gate through section order, shortcut count,
  detached-row absence, connected edge geometry, focused contour ownership,
  command execution, Help, 320px pressure, rotation, and singleton New Tabs.

## 0.8.391 - 2026-08-24

- Restores the complete shared focused-empty Search state in Command Deck.
  Jump-to filter examples and recent open tabs now appear exactly as they do in
  Dashboard; Terminal commands appear only after a leading `:`.
- Gives command results a real aligned three-lane layout and one restrained
  accent guide, so command, outcome, and action no longer separate across the
  full width or blend into ordinary tab results.
- Expands Terminal's Focus utility to fit its native-monospace label without
  clipping. Help and onboarding explicitly retain their established system
  typography and component presentation above the Terminal skin.
- Fixes the empty-prompt Escape and command-history race. The real unpacked
  Chrome gate checks focused-empty Search, Focus geometry, command alignment,
  standard Help, 320px pressure, scheme rotation, and singleton New Tabs.

## 0.8.390 - 2026-08-24

- Adds the approved **Terminal (Command Deck)** as a fourth New Tab choice while
  keeping Dashboard as the default and every ordinary Dashboard link unchanged.
  It reuses the complete Dashboard collections, list actions, drag, selection,
  Undo, Needs you, Starred, Focus, schemes, Settings, Help, Data, and Vault.
- Keeps plain text on the existing Search path and reserves a leading `:` for a
  bounded EveryTab command catalogue. Navigation, window and Session saving,
  Focus, Close the day review, schemes, appearance mode, and Help all delegate
  to their existing safe operation or review route. Tab-selection mutations
  deliberately remain in the familiar rows and bulk controls.
- Stores at most 20 successful commands in browser-session storage only. Search
  text and URLs are never recorded, exported, synced, or written to Vault.
  Suggestions use one stale-safe opaque activation token and live scheme values
  are revalidated before application.
- Adds a responsive native-monospace shell with visible routes and utilities,
  compact top-layer More navigation, the shared Search result anatomy, and the
  complete scheme/corner/row system. Terminal-only code and CSS are loaded only
  for Terminal New Tabs.
- Extends the real unpacked-Chrome gate through command execution, recall,
  ordinary Search preservation, 320px pressure, scheme rotation, singleton New
  Tabs, and the five-window/120-tab profile. Useful content measured
  194.3-322.3 ms under that mature fixture, within its 350 ms contract;
  deterministic, privacy, portability,
  Vault, Loading, localization, and Search performance gates remain green.

## 0.8.389 - 2026-08-24

- Perches Minimal's Starred Rename control just beyond the launcher's top-right
  corner while keeping it inside the reserved grid gap. The hover, focus,
  keyboard, persistence, and 320px interaction contract is unchanged.
- Corrects Settings navigation order. Keyboard shortcuts is now registered and
  shown after Intro, matching the actual final section instead of appearing
  first because it happened to be constructed first.
- Adds a throwaway five-direction Terminal mode comparison using the real scheme
  tokens: Terminal Ledger, Command Deck, Split Console, Tmux Board, and REPL.
  The prototype includes functional sample commands, scheme switching, and
  pressure-safe 400px layouts, but adds no production Terminal setting yet.

## 0.8.388 - 2026-08-24

- Centers Minimal's active Focus copy in a fixed 96px footer lane, aligns its
  vertical center with Dashboard and Settings, and shortens the unconfigured
  action to **Set Focus**. Timed, open-ended, ready, and setup states therefore
  retain one compact position without clipping or an oversized capsule.
- Adds a top-right Rename control to each Minimal Starred launcher. It appears
  only on hover or keyboard focus, supports F2, Enter, Escape, and blur, and uses
  the existing atomic, Undo-backed Starred rename operation.
- Extends the real unpacked-Chrome 320px gate through computed footer geometry,
  hidden and focused Rename states, persisted inline rename, and the unchanged
  ten-launcher grid. Full deterministic, performance, Loading, localization,
  and real Chrome gates are green.

## 0.8.387 - 2026-08-24

- Adds a separate **Show welcome phrases** switch. It defaults On, travels with
  ordinary Settings through Backup/Restore and Vault, and hides Horizon's clock
  note without changing or deleting the saved phrase library.
- Keeps the compact Minimal Focus action aligned in every state. Timed runs show
  the remaining time, open-ended runs show stop + Focus, and an unconfigured
  action says **Set up Focus** before opening the relevant Settings section.
- Expands Minimal's Starred launcher from five to ten pages in two rows of five.
  At narrow pressure widths all ten remain reachable through a centered
  icon-only layout with each full name retained in its tooltip.
- Keeps Minimal's first-paint boundary unchanged. Focused, mounted Settings,
  Smoke, Vault, portable-state, performance, Loading, localization, and real
  unpacked-Chrome 320 px gates are green, including an unclipped setup action
  and all ten Starred launchers.

## 0.8.386 - 2026-08-24

- Repairs the blank Minimal page exposed by a long-lived unpacked Chrome
  profile. Chrome can briefly retain the previous localized-message catalogue
  after an extension reload; the new Focus control had made those new keys a
  synchronous dependency before Horizon appended any content.
- Reuses the established shared Focus copy and resolves the compact Focus
  module only after the clock, date, Search, Starred launcher, and footer have
  mounted. Focus keeps a reserved footer lane, so normal loading does not move
  Dashboard or Settings; an optional-module failure can no longer blank Minimal.
- Adds the exact stale-catalogue regression and strengthens the real Chrome
  gate so core Minimal paint and optional Focus readiness are measured
  separately. Both focus modes pass eight openings with 120 tabs in five
  windows; core useful paint measured 37.9-50.5 ms with clean rotation and
  singleton behavior.

## 0.8.385 - 2026-08-24

- Adds optional personal welcome phrases to Minimal New Tab only. Settings
  accepts one phrase per line, up to 100 phrases and 96 characters each. Each
  phrase appears once in a shuffled cycle before any repeats; an empty list
  leaves Horizon unchanged. The phrases are ordinary portable Settings data,
  while the local shuffle receipt stores only indexes and a content-free hash.
- Adds Focus as the third quiet Horizon footer action beside Dashboard and
  Settings. The compact action uses the established play-to-stop morph and
  accent fill, shows remaining time while active, starts and stops through the
  same worker-owned Focus state as Dashboard, and routes to Focus setup when no
  During Focus sites exist.
- Keeps Minimal's startup boundary intact: phrase selection reuses the Settings
  snapshot already read and Focus status hydrates after useful content paints.
  Focused behavior, Settings persistence, full Smoke/Vault/Restore, performance,
  Loading-starvation, mounted Settings, and real unpacked-Chrome gates are green.
  Minimal useful content measured 39.3-43.5 ms and the complete phrase/footer
  layout has no overflow at 320 px.

## 0.8.384 - 2026-08-22

- Completes the planned Dashboard controller slice. Backup/Restore and imports,
  Vault status/sync/recovery, automatic Snapshots, and Snoozed now own their
  reads, actions, presentation, and local rerendering in four focused modules.
  Dashboard composes them through narrow interfaces and no longer carries their
  implementations or static dependencies on Open tabs' startup graph.
- Makes the first-paint boundary literal rather than promise-only. Secondary
  controller work begins after Chrome has painted Open; Vault controller loading
  and automatic sync use the existing three-second quiet period so a burst of
  New Tabs cannot make one completed Dashboard delay the next one.
- Corrects the real-Chrome mature-profile fixture so it waits for its own 120
  synthetic pages to settle before timing EveryTab. Three independent
  five-window/120-tab runs measured 179.8, 184.2, and 300.8 ms (184.2 ms median),
  while clean Dashboard samples remained 53.5-78.7 ms. The mounted Dashboard,
  full Smoke/Vault/portable-state, performance, Loading, singleton, syntax, and
  focused controller gates are green.

## 0.8.383 - 2026-08-22

- Repairs the mature-profile cold-loading regression found after the first
  Dashboard controller extraction. Archive, Duplicates, Stats, and Activity
  remain complete controllers, but their modules now load only when their
  section is visited instead of joining Open tabs' static startup graph.
- Starts connected Vault synchronization only after the primary Open ledger has
  had a real paint opportunity. Vault work remains automatic and unchanged, but
  no longer competes with the answer the user opened the Dashboard to see.
- Makes Minimal paint its clock, Search, Focus status, and navigation before the
  optional Starred read. It also reuses the Settings snapshot already read by
  the New Tab entry instead of reading it twice.
- Adds real unpacked-Chrome timing gates for useful Dashboard/Minimal content,
  singleton cleanup, and an optional five-window/120-tab pressure profile. The
  mature Dashboard fixture improved from 246.5 ms to 179.5 ms; Minimal remained
  usable in 65.6-121.8 ms across both focus modes, and singleton cleanup
  completed in 117.2-192.1 ms under the same pressure. Main-profile installed
  confirmation remains open.

## 0.8.382 - 2026-08-22

- Starts the Dashboard ownership migration with four complete section
  controllers. Archive, Duplicates, Stats, and Activity now own their reads,
  actions, list configuration, focus continuity, and rerendering behind one
  `render()` interface each.
- Leaves Dashboard responsible for composition, routing, visibility gating, and
  cross-section refresh only. It no longer imports Journal, Restore checkpoint,
  counters, suspend-page, or Archive action internals for these sections, and
  falls from 2,778 review-baseline lines to 2,372.
- Adds a focused interface contract, moves source assertions to the modules that
  now own the behavior, and keeps the existing mounted Dashboard UI unchanged.
- Focused controller, full Smoke, portable state, and mounted Dashboard gates
  are green. Stored data, user-visible behavior, and Chrome permissions are
  unchanged.

## 0.8.381 - 2026-08-22

- Replaces the background worker's long string comparison chain with one
  explicit handler registry. Every route now declares its message type,
  synchronous or asynchronous ownership, payload validator, effect, and safe
  failure response together.
- Adds one response-settlement boundary that preserves Chrome's service-worker
  channel rules, rejects malformed payloads before browser or storage effects,
  catches synchronous throws and rejected work, and prevents duplicate route
  registration. Unknown messages still pass only to the Focus guard.
- Updates architecture source contracts to assert the registry rather than the
  retired branch text. The real unpacked-extension gate also now distinguishes
  the current static Ink fallback from the first meaningful boot paint without
  hard-coding a product default.
- Focused registry, full Smoke, Vault, portable state, rotation, Singleton,
  privacy, Snooze ownership, performance, Loading, localization, syntax, and
  real Chrome New Tab gates are green. Runtime commands and stored data formats
  are unchanged.

## 0.8.380 - 2026-08-22

- Completes the broad presentation/source-contract extraction. Design tokens,
  shared list anatomy, responsive hosts, outcomes, and motion now run in one
  focused presentation suite. Dashboard lazy rendering, navigation, Starred,
  group-lens, and section behavior run in a separate focused suite.
- Keeps production modules behind the installed Chrome test double by loading
  runtime dependencies only after each runner is called. Settings-preservation
  checks receive the local fixture explicitly; the Dashboard suite needs only
  the assertion interface.
- Preserves `node test/smoke.mjs`, assertion order, and output while reducing the
  main runner from 7,108 to 4,388 lines, 7,852 fewer than the review baseline.
  Extension runtime behavior and persisted data are unchanged.
- Smoke, Vault, portable state, Journal, Snooze ownership, performance, Loading,
  localization, and syntax gates are green.

## 0.8.379 - 2026-08-22

- Continues the behavior-preserving smoke-suite migration with two cohesive
  domains. Unified list adapters, Archive exits, Session and Snooze tab-grain
  actions, and drag/Undo behavior now live in one list-workflow suite. Labels,
  label recency, Starred, saved-item Undo, Session drift, and Inbox triage live
  in one saved-data workflow suite.
- Reuses one narrow browser-effect adapter across the new suites and storage
  concurrency instead of exposing unrelated runner globals or duplicating the
  Chrome test double.
- Keeps `node test/smoke.mjs`, assertion order, and output unchanged while
  reducing the main runner from 8,333 to 7,108 lines, 5,132 fewer than the
  review baseline. Extension runtime behavior and persisted data are unchanged.
- Smoke, Vault, portable state, Journal, Snooze ownership, performance, Loading,
  localization, and syntax gates are green.

## 0.8.378 - 2026-08-22

- Continues the behavior-preserving maintainability pass by moving the complete
  Focus and storage-concurrency smoke domains behind focused runner interfaces.
  The public `node test/smoke.mjs` command, assertion order, and output remain
  unchanged.
- Keeps test ownership explicit: Focus receives only the shared settings fixture,
  while storage concurrency receives only the Chrome tab-effect controls its
  Snooze boundary needs. Production modules are still loaded after the shared
  Chrome test double is installed.
- Reduces the main smoke runner from 11,652 to 8,333 lines without changing
  extension runtime behavior or persisted data. Full smoke, Vault, portable
  state, Journal, Snooze ownership, performance, Loading, localization, and
  syntax gates are green.

## 0.8.377 - 2026-08-22

- Starts the behavior-preserving maintainability pass by separating the shared
  Chrome API test double from the 12,000-line smoke scenario runner. Fresh state
  providers keep reassigned windows, tabs, groups, permissions, and effects
  faithful without duplicating mock behavior in each future domain suite.
- Gives smoke suites one result collector while leaving process ownership in the
  public runner. `node test/smoke.mjs` remains the only required command and
  retains the same assertion order and output.
- Extracts theme rotation, keyboard Search handoff, Search/manifest contracts,
  brand assets, user-facing copy policy, and storage-writer policy into focused
  modules. The main runner is 588 lines smaller; remaining domain extraction is
  explicit follow-up rather than a line-count-only rewrite.
- Changes no extension runtime behavior or persisted data. Smoke, Vault,
  portable state, Journal, Snooze ownership, performance, Loading, and syntax
  gates are green.

## 0.8.376 - 2026-08-22

- Completes the bounded P2 cleanup from the pre-beta review. Direct Dashboard
  no longer starts a populated-window read that only New Tab can consume, and
  store cache misses now make one ownership clone at the caller boundary.
- Reuses one immutable Inbox, Archive, Sessions, and label-recency snapshot for
  navigation counts and label groups. Removes the duplicate Search domain sort.
- Finishes the reviewed English-catalogue slice for automatic Archive notices,
  Snoozed controls, Restore, Close the day, and the affected Dashboard and side
  panel outcomes. Help no longer documents the retired `view:` filter.
- Adds stable Activity `actionKind` and bounded structured parameters to new
  Journal entries. Current Activity copy is localized when rendered; old and
  imported records retain their readable persisted-label fallback.
- Keeps Close-the-day's sticky summary height stable at the middle desktop
  width where changing a choice could otherwise move the review underneath it.
  Reconciles the PRD with the settled v1 whole-record LWW merge contract.
- Adds focused clone-count, shared-read, duplicate-work, extraction, Activity,
  and mounted geometry regressions. Smoke, Vault, portable state, Journal,
  import, Close the day, performance, Loading, localization, syntax, and the
  mounted Restore plus 320/800/1280px Close-the-day gates are green.

## 0.8.375 - 2026-08-22

- Makes mature-profile Search useful within the adopted 100 ms interaction
  budget. The permanent 2,000 automatic Snapshots x 72 tabs fixture now returns
  an Open-tab result about 92 ms after the keystroke including the 90 ms
  debounce, instead of roughly 340 ms.
- Starts the debounce at the keystroke rather than after scope preparation and
  builds a compact primary snapshot from ordinary sources plus the existing
  named-Session identity index.
- Completes named Session tabs and automatic Snapshot matches after the primary
  rows paint. Final source order, normalized-URL deduplication, History
  precedence, the 50-result cap, keyboard selection, and fast Enter semantics
  remain unchanged.
- Keeps label, domain, and Session autocomplete complete through a compact facet
  scan without retaining the expanded 144,000-candidate graph. A real task
  boundary ensures the secondary read cannot consume the primary paint frame.
- Adds permanent timing, retained-heap, exact-completion, and stale-secondary
  regressions. Smoke, Vault, portable-state, Search/History/domain, performance,
  Loading, syntax, and the mounted Dashboard/Search DOM gate are green.

## 0.8.374 - 2026-08-22

- Gives every Snooze delivery one owner. Startup recovery, an alarm, and an
  explicit **Wake** can overlap without opening the same tab, window, or Session
  twice or advancing a recurring Snooze twice.
- Persists the ownership claim before Chrome opens anything, then commits the
  completed receipt, Snooze tombstone or next recurrence, and counter together.
  Browser effects never run while the shared storage lock is held.
- Treats a worker stop during Chrome's effect honestly: automatic recovery does
  not risk a duplicate, the Snooze remains visible, and an explicit **Wake** can
  retry it. A known pre-effect Chrome failure clears its claim and receives a
  bounded alarm retry.
- Keeps automatic delivery on the Snooze's originating device while allowing an
  explicit Wake from a synced device. Delivery receipts remain device-local and
  are excluded from Export, Restore, and Vault.
- Adds deterministic same-worker and cross-context overlap coverage plus
  one-shot, recurring, window, Session, partial Session, failure, restart, and
  missed-alarm fixtures. Smoke, Vault, portable-state, performance, Loading,
  syntax, and the focused Snooze gate are green.

## 0.8.373 - 2026-08-22

- Restores a closed Open tab to its original Chrome window and tab-strip index
  instead of appending it to whichever window is current. Pinned state is kept.
- Restores a multi-tab close into each tab's own original window, in ascending
  original order. If an original window no longer exists, its tabs reopen
  together in one replacement window instead of leaking into the current one.
- Rechecks every closed tab id after Chrome reports completion. If the original
  tab is still present, the pending receipt is removed and no phantom Undo can
  create a second copy.
- Extends the focused live-close regression with cross-window, multi-position,
  missing-window, concurrent-Undo, and resolved-but-not-closed cases. The full
  deterministic release matrix remains green.

## 0.8.372 - 2026-08-22

- Makes generic Undo stale-safe and single-owner. Every newly journaled saved
  record carries an exact post-state fingerprint from the same commit. Undo
  refuses an older action after later work changed that record, and simultaneous
  Undo requests cannot repeat a browser reopen.
- Moves Undo ownership into the background worker for Dashboard, side panel,
  keyboard shortcuts, Needs you, Activity, and toasts. Store rollback and its
  terminal Journal state now share one locked write; an interrupted browser
  effect becomes an honest, non-repeatable incomplete result after restart.
- Commits whole Inbox, Archive, and Snapshot deletion with its inverse in one
  set. Third-party imports now commit every record, label date, index, and their
  one Undo together. Archive **Restore all** uses the same journaled operation as
  row and bulk Restore.
- Gives live tab, whole-window, and duplicate closes a persist-first receipt.
  The recovery record exists before Chrome removes anything, restart recovery
  distinguishes no-op and partial closes, and incognito/internal Open rows are
  not closed without a recoverable normal-profile page.
- Adds focused adversarial fixtures for stale and simultaneous Undo, stopped
  workers, atomic deletion, partial imports, Archive Restore all, close receipts,
  partial close recovery, and incognito exclusion. Smoke, Vault, portable-state,
  performance, and Loading-starvation gates are green.

## 0.8.371 - 2026-08-22

- Closes the incognito capture gap found by the pre-beta engineering review.
  Popup Star, Label, and Snooze actions now require a saveable normal-profile
  tab before any URL can reach persistent storage or the Vault.
- Enforces the same provenance check inside the background Snooze boundary, so
  popup, context-menu, and keyboard entry points cannot persist or close an
  incognito tab. The Popup explains that privacy boundary directly. Normal
  suspended tabs still save their underlying page.
- Adds one central saveable-tab capture adapter and a focused regression over
  the real Popup and worker wiring. Smoke, Vault, portable-state, localization,
  pre-localization, and performance gates remain green.

## 0.8.370 - 2026-08-22

- Preserves suspended-tab placement across the sequence **browser restart,
  then extension reload**. When Chrome restores a suspend page with new tab and
  window IDs, EveryTab now refreshes the recovery registry with that page's
  current tab ID, window ID, index, and pin state.
- Prevents a later reload from treating those restored IDs as dead and falling
  back to the window where Reload was clicked. Matching is occurrence-aware, so
  separate suspended copies of the same address cannot claim one live page.
- Adds a deterministic two-window regression that first restores a registered
  page under new Chrome identities, removes the extension page as reload does,
  and proves recreation returns to the same window and tab position.

## 0.8.369 - 2026-08-22

- Makes keyboard activation of a Search **Jump to** suggestion commit its scope
  before Search can rebuild the empty state. Enter and Space now follow the same
  path as a pointer click and immediately reveal matching tabs.
- Replaces the old Inbox and Session selected-card controls with the current
  compact icon actions and shared anchored Label and Session pickers. The card
  header no longer contains an inline text field or overlapping action names.
- Clarifies active Search results as **open tab** beside **Switch**; shortens the
  primary Chrome extension identity to **EveryTab** so extension pages and
  suspended pages no longer expose the Store-oriented long title.
- Tightens first-run and Settings copy: automation timing is stated in reading
  order, the one-use automation-review action disappears after expanding,
  familiar folder-sync services illustrate Vault portability, and rotation
  favorites are explained directly. Intro scheme dots and Settings stars now
  share a measured center.
- Smoke, Vault, portable-state, localization, performance, Loading-starvation,
  Corner-style, mounted Dashboard/Search, and mounted 320px onboarding/Help
  regressions are green.

## 0.8.368 - 2026-08-21

- Expands the introduction to six purposeful steps. The opening page now gives
  a compact map of clutter control, organization, Focus, and recovery; the new
  color step applies any of the 36 built-in schemes immediately through the
  same Light/Dark and Soft/Vivid groups used in Settings.
- Keeps automation review inside the introduction: **Review all automation
  settings** now unfolds the eight shared controls in place. The final step
  reminds users that every choice remains editable, with direct routes to full
  Settings and Help.
- Calls Search by its visible name and explains the `et` address-bar entry in
  plain point-of-use language. Help topics that mention settings now link to
  the exact Auto-save, Suspension, Sessions, Duplicates, Focus, Appearance, New
  tab, Keyboard, or Privacy section instead of leaving the user to find it.
- The strict English catalogue now has 1,109 described entries. Smoke,
  localization, and mounted 320px/800px first-run and Help interaction gates
  are green; the design detector reports no new finding from this batch.

## 0.8.367 - 2026-08-21

- Rewrites the five-step introduction around one first-use journey: clear tab
  clutter without loss, choose a New Tab, save before sorting, find anything
  again, and keep data local. The first page now states the free, no-account,
  no-telemetry promise directly. Dashboard is named and selected as the fresh
  default. Implementation limitations, import-format lists, and redundant Undo
  copy leave first run.
- Introduces Auto-save, Suspension, and Snapshots beside the Inbox workflow.
  The eight main thresholds stay collapsed, while **Review all automation
  settings** remains visible as an accented route to the complete controls.
  The Chrome `et` address-bar search is now explained at point of use.
- Groups permanent Help by user goal instead of a flat feature list. Open Tabs
  now covers filtering, selection, exact drag placement, and Organize; Inbox
  points to its expiry setting without a disconnected numeric instruction; the
  final intro step offers **Explore full Help**. Zero keeps its honest
  context-specific meanings: Off, Never, Always, No limit, or Keep all.
- Smoke, Vault, portable-state, i18n, performance, Loading-starvation, and
  mounted 320px/800px first-run and Help gates are green. The design detector's
  only findings remain the intentional native-font and keycap-shape exceptions.

## 0.8.366 - 2026-08-21

- Fixes **Replay intro** in both embedded and standalone Settings. The action now
  clears old progress and opens the first step immediately in the current page;
  it no longer relies on a Dashboard hash navigation that does not rerun startup
  code in an already-open Dashboard.
- Rewrites permanent Help around each task instead of repeating three bullets per
  topic. Ordered work uses steps, compact concepts use term-and-definition rows,
  optional tips remain short lists, and explanatory topics use plain prose. The
  redundant current-window explanation and implementation-facing filler are
  removed.
- Expands the strict English catalogue from 1,081 to 1,091 described entries.
  Smoke, Vault, portable-state, performance, Loading, Corner-style, i18n, and
  mounted 320px/800px Replay-intro and Help gates are green.

## 0.8.365 - 2026-08-21

- Replaces the old eleven-page feature tour with the approved five-step first
  run: local trust, new-tab choice, Inbox and automation, finding and returning,
  and data ownership. It never saves, closes, labels, snoozes, restores, or moves
  a real tab. Completed profiles are not shown it again, and incomplete older
  tours resume at the nearest new outcome.
- Adds a separate permanent **EveryTab Help** library with 14 topics covering
  Open, Inbox and Archive, Sessions and snapshots, Labels and groups, Search,
  Snooze, Focus, automation, Close the day, appearance and New Tab, keyboard,
  Data and Vault, History and permissions, and safety and Undo. Dashboard
  **Learn more** links deep-link into Help; Settings exposes both **Open Help**
  and the existing **Replay intro** action.
- Makes **Tune automation** an optional collapsed first-run panel using the same
  implementation as Settings for all eight approved thresholds. The strict
  English catalogue grows from 937 to 1,081 translator-described messages.
  Smoke, Vault, portable-state, performance, Loading, Corner style, i18n, and
  mounted 320px/800px first-run and Help gates are green. No new locale,
  permission, migration, or background work is included.

## 0.8.364 - 2026-08-21

- Restores the compact **EveryTab** product mark in the left navigation. The
  localized shell had accidentally reused Chrome's longer Store listing title;
  a focused regression now keeps those two manifest identities distinct.
- Completes the fifth P11-26 runtime extraction slice across the shared Settings
  form, Focus rules, optional permissions, appearance options, scheme favorites,
  the Dashboard appearance picker, and the custom-scheme library. Stored values,
  route ids, setting keys, and domain decisions remain language-free.
- Expands the strict English catalogue from 725 to 937 translator-described
  messages. Catalogue/dead-key/pseudo-expansion, smoke, Vault, Restore, custom-
  scheme, Dashboard, and 320px Settings pressure gates are green. No new locale,
  permission, migration, or setting behavior is included.

## 0.8.363 - 2026-08-21

- Completes the fourth P11-26 runtime extraction slice for Dashboard and side-
  panel section chrome, navigation, and the complete toolbar popup. Stable
  route ids, worker message types, action ids, and keyboard bindings remain
  language-free behind dedicated shell and popup presentation modules.
- Localizes popup headings, actions, results, counts, Session names, label lists,
  duplicate and Vault notices, Focus choices, and document identity without
  changing its fixed frame or action order. Dashboard, popup, side panel, and
  New Tab entry now publish the active document language and direction.
- Expands the strict English catalogue from 577 to 725 translator-described
  messages. Exact-reference/dead-key, duplicate-copy, pseudo-expansion, smoke,
  mounted Dashboard, and compact side-panel pressure gates are green. No new
  locale, permission, stored-data migration, or behavior change is included.

## 0.8.362 - 2026-08-21

- Completes the third P11-26 runtime extraction slice across the shared list
  renderer and the Open, Inbox, Archive, Labels, and Sessions surfaces. One
  presentation boundary now owns row/card titles, sources, compact ages,
  metadata counts, selection summaries, action names, empty states, filters,
  sort labels, Snooze choices, and Label/Session group controls.
- Keeps stored enums, search syntax, list actions, group identity, and domain
  operations language-free. The English interface and behavior are unchanged;
  there is no stored-data migration, permission change, or packaged non-English
  locale.
- Expands the strict English catalogue from 238 to 577 translator-described
  messages. The extraction gate covers shared-list behavior and duplicate-copy
  detection. A real-DOM follow-up also makes group focus recovery survive a
  coalesced rerender without stealing focus after the user moves elsewhere.

## 0.8.361 - 2026-08-21

- Completes the second P11-26 runtime extraction slice across shared Search,
  optional Browser History results, the `et` omnibox, recent-tab context, and
  the shared keyboard reference. One presentation module now owns result
  actions, source names, relative ages, Session/group counts, and live-result
  announcements without putting language into Search matching.
- Keeps `in:`, `label:`, `session:`, and `domain:` as stable product syntax.
  Search behavior, source ordering, no-result handoff, and the existing English
  interface remain unchanged across Dashboard, Minimal, popup, and side panel.
- Expands the strict English catalogue from 109 to 238 translator-described
  messages. Source, pure-domain, mounted Search, smoke, Vault, Restore,
  Loading-starvation, and performance gates are green.

## 0.8.360 - 2026-08-21

- Moves Laser, Cyberwave, Nautilus, Perestroika, and Phosphor from **Dark
  default · Soft** to **Dark default · Vivid** in both scheme selectors. The
  four groups remain complete, exclusive, and shared by Settings and the quick
  picker.
- Completes the first broad P11-26 runtime extraction slice. Focus decisions
  remain language-free, while one localized presentation module now owns guard
  headings, actions, durations, counts, and failures. The guard page, shared
  temporary-access controls, Focus band, Chrome context menus, and system
  notifications all resolve through the English Chrome catalogue.
- Expands the strict catalogue from 19 to 109 translator-described messages.
  The gate now rejects missing and dead runtime keys, placeholder drift,
  duplicated extracted copy, and placeholder damage across 35% pseudo-expanded
  copies. No French locale, stored-data migration, permission, or build step is
  added.

## 0.8.359 - 2026-08-21

- Rebuilds manual navigation collapse around one fully painted final page. The
  moving navigation edge now reveals or conceals that page instead of
  transforming its sticky gradient layers, removing the persistent and flashing
  background seams seen across Open, Inbox, Duplicates, Snoozed, and Settings.
- Aligns the end-of-window drag target with the final tab's existing separator,
  retaining an 18px pointer and keyboard target without drawing a second line
  below the row.
- Reorganizes all 36 built-in schemes into one shared 2×2 browsing model:
  **Light default · Soft**, **Light default · Vivid**, **Dark default · Soft**,
  and **Dark default · Vivid**. The quick picker and Settings favorites share
  the same matrix; custom schemes remain honestly separate under **Yours**.

## 0.8.358 - 2026-08-21

- Removes the old viewport-sized Dashboard runway. Short sections now stop with
  ordinary breathing room while their final row remains visible at maximum
  scroll.
- Uses one continuous page material when the navigation is collapsed, including
  during its resize motion, and moves Label/Session group-navigation anatomy to
  the shared component layer so the side panel no longer falls back to browser
  button styling.
- Replaces the wordy end-of-window drag target with a compact terminal rail
  directly after the final tab and before **Show fewer**. Its complete action
  name remains available to keyboard and assistive-technology users.

## 0.8.357 - 2026-08-21

- Imports the Markdown link lists EveryTab already copies from windows,
  selections, labels, Sessions, and Snapshots. Pasted text and `.md` or
  `.markdown` files are auto-detected in Data.
- Preserves the shared H1 name, H2 window order, link order, escaped titles,
  and web URLs containing parentheses. Flat copies become one group; Session
  copies retain their separate windows.
- Reuses the existing import preview, destination choices, optional labels,
  Activity entry, Undo, and section refresh. Ordinary prose is not claimed as
  an import, and internal or non-web links remain excluded.

## 0.8.356 - 2026-08-20

- Adds **Keep at most N tabs open** to Auto-save in Settings and Tune
  automation. `0` remains Off and the existing idle-time rule remains an
  independent choice.
- When the count is over the cap, saves the longest-idle eligible surplus tabs
  to the Inbox in source-window order. Active, pinned, audible, grouped,
  incognito, unsaveable, and user-exempt tabs remain protected, even when that
  means a very small limit cannot be reached.
- Consolidates rapid tab creation into one check after 900 ms, with the existing
  15-minute alarm as the MV3 fallback. Overlapping alarm, Settings, and
  tab-created checks share one sweep, while Inbox persistence, Activity, Undo,
  notification, Export, Restore, and Vault use the existing safe paths.

## 0.8.355 - 2026-08-20

- Gives Open pointer drag a compact themed preview that travels with the
  pointer and states the exact number of tabs being moved.
- Reveals an explicit **Move to end of Window…** target after the final row of
  every Open window. Dropping there appends the complete dragged set instead of
  requiring the window header to imply that destination.
- Uses that same terminal slot for keyboard Move highlighting, while preserving
  the existing worker validation and one whole-set best-effort Undo.

## 0.8.354 - 2026-08-20

- Extends Open-tabs pointer drag to the selected set. Dragging a selected row
  now carries every selected tab, including selections spanning windows;
  dragging an unselected row remains a one-tab move.
- Routes row, window-header, and between-window drops through the same guarded
  worker operation as the explicit Move action, retaining one complete
  best-effort Undo record for the set.
- Keeps a newly created window card at the visible between-card slot where it
  was dropped. Later live refreshes retain that surface order, closed windows
  disappear, and unrelated newly opened windows append normally.

## 0.8.353 - 2026-08-20

- Repairs the selected-tabs **Label** palette header. Its title, explanation,
  icon, and Close control now occupy the intended columns instead of squeezing
  the heading into the icon lane.
- Adds **Move** to the Open-tabs selected-set actions. One destination palette
  moves the complete selection to any existing regular window or a new window,
  including selections that span several source windows.
- Keeps live-tab movement in the background worker, validates every tab and
  destination immediately before acting, and records one best-effort Undo entry
  with every selected tab's original window and position. Open filtering never
  hides valid destination windows.

## 0.8.352 - 2026-08-20

- Applies the approved fresh-profile defaults: **Ink**, **Scheme default**,
  **Soft** corners, **Detailed** row information, **Icons only**, and a
  200-snapshot retention limit. Existing explicit settings, including
  unlimited snapshots with `0`, are not migrated.
- Retires five Settings choices without breaking old backups or Vault data.
  Quick theme controls and Bold emphasis are now fixed; snoozes always reopen;
  duplicate matching always preserves query strings; and the popup duplicate
  hint is always available with a per-open Dismiss action. The retired values
  still round-trip but cannot affect runtime behavior.
- Makes **Corner style** a global semantic contract across Search, fields,
  buttons, menus, popovers, cards, Dashboard, Minimal, popup, side panel,
  Settings, and Scheme Editor. Connected rows and seams stay square; pills,
  circles, favicon crops, and Checkbox shape keep their own meaning.
- Changes Settings writes from stale whole-form saves to locked field patches,
  preserving concurrent changes from quick controls, Vault, or another open
  EveryTab page. Every first-frame HTML fallback now matches the new defaults.

## 0.8.351 - 2026-08-20

- Fixes **One EveryTab New Tab per window** when New tab focus is **Address bar
  (don't grab focus)**. Chrome keeps those override tabs under its browser-owned
  `chrome://newtab/` identity, while **EveryTab search** performs a navigation
  that exposes the extension URL. The singleton boundary now recognizes both
  identities as the same EveryTab New Tab surface.
- Extends the fast planner and completed-tab regressions with Chrome's native
  address-bar identity. The unpacked-Chrome gate now runs the failing
  address-bar setting and converges three rapid native New Tabs to one keeper.

## 0.8.350 - 2026-08-19

- Removes the ten-second startup exception that could make **One EveryTab New
  Tab per window** silently inert in both real profiles. The active mounted New
  Tab is always a safe keeper; inactive restored pages, pinned tabs, explicit
  Dashboards, incognito tabs, moved tabs, and changed URLs remain protected.
- Enforces the same invariant from Chrome's completed-tab event as well as the
  page readiness message. Singleton cleanup no longer depends on Dashboard,
  Minimal, Vault loading, or runtime-message delivery.
- Adds deterministic regressions for active startup pages, inactive restored
  pages, and Chrome's independent completed-tab trigger.

## 0.8.349 - 2026-08-19

- Starts **One EveryTab New Tab per window** cleanup from the lightweight New
  Tab entry document, before Dashboard, Vault-backed surfaces, or the Minimal
  launcher build. A late bounded retry still covers a cold worker. Three rapid
  native New Tabs now converge to one active keeper in the unpacked-Chrome gate.
- Keeps the complete Focus status copy visible while its recessed band closes.
  Closing now uses the same height seam as opening, with no earlier opacity or
  translation phase.

## 0.8.348 - 2026-08-19

- Actually removes the four unavailable **This tab** actions on unsupported
  popup pages. The action grid's author-level `display: grid` rule had
  overridden Chrome's `hidden` layout rule, so the earlier JavaScript state was
  correct while the controls remained visible and kept the popup scrollable.
- Makes **One EveryTab New Tab per window** work when a native New Tab wakes a
  cold MV3 worker after its `tabs.onCreated` claim was missed. Once startup
  restore protection has elapsed, the active mounted override page is a safe
  keeper claim; every pin, URL, window, incognito, activity, and live-tab check
  still runs immediately before closing older pages.
- Replaces the misleading singleton release check with Chrome's default New Tab
  creation path. The gate now exercises the override lifecycle used by
  `Cmd/Ctrl+T`, alongside the exact unsupported-popup computed-layout check.

## 0.8.347 - 2026-08-19

- Keeps unsupported toolbar-popup states within the available height by
  replacing unavailable This tab actions with Chrome's explanation instead of
  stacking the explanation below four disabled controls.
- Removes the small keyboard flash between Jump to and Search results. Moving
  focus back into the field now preserves the mounted command surface and
  selects the first recent result without rebuilding it.
- Adds the approved, default-Off **One EveryTab New Tab per window** setting.
  A newly created override tab waits until its UI mounts, then the background
  worker retires older unpinned EveryTab New Tabs in that normal window. Pinned,
  restored, active, navigated, moved, incognito, Dashboard, and utility tabs are
  left alone. A real unpacked-Chrome gate verifies one newest keeper alongside
  eight non-repeating On-open theme draws.

## 0.8.346 - 2026-08-19

- Routes every ordinary Dashboard destination to the named Open section, so
  Minimal, popup, side panel, guard recovery, and internal actions no longer
  leave Search focused. The explicit Search command remains the only focused
  Dashboard handoff.
- Uses Chrome's complete supported 600px action-popup height. The stable
  one-frame shell and sticky footer remain unchanged; scrolling stays available
  only when a short display, enlarged text, or conditional content needs it.
- Extends the scheduled pre-beta maintainability review with an explicit
  AI-tell and AI-slop audit, and records the separate one-EveryTab-New-Tab-per-
  window options without changing New Tab lifecycle behavior yet.

## 0.8.345 - 2026-08-19

- Fixes the blank Minimal page introduced by the localization foundation.
  Chrome reports locales such as `en_GB`, while JavaScript Intl requires the
  canonical `en-GB` form. The shared boundary now canonicalizes every runtime
  and injected locale before number or date formatting.
- Strengthens the real unpacked-extension gate with an explicit Minimal mode.
  It now requires both the Horizon clock and command deck to mount and captures
  page/module errors, so correct theme paint can no longer conceal an empty UI.
- Schedules a full-tree pre-beta engineering review after localization and
  onboarding stabilize, covering performance, architecture/standards, and
  human maintainability before public-source and Store work.

## 0.8.344 - 2026-08-19

- Gives Minimal Search the same neutral input-to-content separator as every
  other Search host while preserving one uninterrupted accent contour around
  the complete command surface.
- Starts the approved English-localization phase with Chrome's native default
  locale. Extension name, description, toolbar title, and command descriptions
  now resolve from a translator-described English catalogue.
- Adds one strict runtime message boundary, locale-aware number/date/time/
  relative-time helpers, placeholder validation, and a development-only 35%
  pseudo-expansion gate. Horizon is the first runtime surface to consume the
  catalogue. French is not packaged or claimed.

## 0.8.343 - 2026-08-19

- Makes the Focus copy present from the first opening frame. The accepted
  recessed material and single smooth layout track remain the complete reveal,
  with no added delay, rail, glow, or motion.
- Promotes the selected **Horizon** Minimal page: the atmospheric clock owns the
  upper field, its date sits directly below it, and a lower command deck carries
  Search, up to five real Starred pages, Focus access, Dashboard, and Settings.
- Defines **current window** as the Chrome window containing this EveryTab
  surface, not whichever window or app currently has operating-system focus.
  Its badge and first-place ordering therefore remain stable when switching
  apps or working in another Chrome window.

## 0.8.342 - 2026-08-19

- Restores the sense of the page opening around the Focus band without changing
  the smooth v0.8.341 layout track. A borderless accent material is revealed as
  the gap opens and concealed as it closes.
- Adds only a very thin inset shadow along the material's inner top and bottom
  edges, making the band read as slightly recessed. There is no rail, glow,
  bounce, or additional movement.

## 0.8.341 - 2026-08-19

- Removes the Focus border animation entirely. The band now uses only its
  normal static border. Its material waits until the layout track is open and
  withdraws before that track closes, so no moving rail, glow, or bounce-like
  edge cue appears in either direction.
- Replaces the scroll-coordinate and translated-sticky choreography with one
  registered layout length. That same value drives the band height and every
  sticky offset, keeping the header and scrolled rows on the same frame.
- Uses the same 220ms path in both directions. A mounted Chrome regression now
  samples every opening and closing frame with a real sticky header and a
  scrolled row, and rejects jumps, reversals, or header/row desynchronization.

## 0.8.340 - 2026-08-19

- Removes the opening rail glow. The two centre-drawn rails remain as crisp,
  contrast-safe lines, but no shadow bloom or bounce-like light effect is
  emitted on either side of the Focus band.
- Starts scroll and sticky-cap compensation immediately after the strip writes
  its layout, before the independent navigation-status read can cross a paint.
  This removes the brief down/up/down jitter at the start of Focus.
- Gives opening and closing the same 180ms workspace settle. Exit retains its
  quieter glow-free withdrawal without the previous sharper final movement.

## 0.8.339 - 2026-08-19

- Keeps the Focus glow as an opening cue only. Ending Focus now retracts the
  band and its copy without replaying the illuminated rails, removing the small
  bounce-like finish.
- Drives sticky window caps and document scroll from the same eased progress
  value while the Focus band changes the hero height. A mounted Chrome test
  samples the middle of the transition and proves a window header and its rows
  travel together rather than arriving on adjacent frames.

## 0.8.338 - 2026-08-19

- Makes Focus rails visible across every built-in scheme. The glow retains the
  same focus-accent family as Search, while a contrast-safe accent-ink core now
  separates it from the solid accent band. The mounted gate checks all 72
  built-in light/dark maps at 3:1 or better.
- Adds the spatial inverse when Focus ends: copy withdraws, both glowing rails
  contract toward the centre, and the band closes along its entry seam before
  leaving the page.
- Removes the authored four-pixel Search movement. Search remains completely
  still while the Focus band opens or closes.
- Replaces the whole-ledger transform with a scroll-coordinate FLIP. Window
  caps and rows still move together, but sticky positioning and text are never
  temporarily transformed or re-rasterized during the close transition.

## 0.8.337 - 2026-08-19

- Keeps the Start and End Focus symbols on one fixed left axis. Their labels
  can change without shifting the icon or the adjacent Needs-you line.
- Makes the Focus opening sequence durable across its two normal status reads.
  The authoritative follow-up refresh no longer removes the entry class before
  the centre seam and twin rails reach a visible glowing frame.
- Captures the scrolled workspace before the asynchronous Focus commit. After
  the band is inserted, the Dashboard counters Chrome scroll anchoring and
  moves the complete stage, including sticky window caps and their rows, as one
  body. Reduced motion keeps the same final layout without animation.
- Extends the mounted Chrome gate to check the fixed icon axis, duplicate-refresh
  resilience, and an actually visible rail-and-glow frame.

## 0.8.336 - 2026-08-19

- Promotes the combined Focus-button directions C and D. The fixed-size action
  transforms its play symbol into Stop while one accent fill sweeps across the
  same surface; Setup, Start, End, and the adjacent Needs-you line never move.
- Removes the cursor handoff at its actual cause. The async guard now uses an
  internal pending gate plus `aria-busy`/`aria-disabled` instead of the native
  disabled state, so pointer and keyboard focus remain stable while duplicate
  activation is still blocked.
- Implements the production opening seam. The upper Search region lifts four
  pixels while the collection moves down by one compositor-owned FLIP; the
  Focus band opens from its centre without per-frame layout. Its copy stays
  hidden until the band reaches full height, then two accent rails draw outward
  with one bounded glow.
- First hydration and reduced-motion paths are instant. The mounted real-Chrome
  regression uses the real shared Focus-strip renderer and verifies the initial
  sequencing plus cursor stability alongside Search, Open filtering, Pinned,
  and selection-scroll behavior.

## 0.8.335 - 2026-08-19

- Promotes the selected **Columns + fold** navigation glyph to the production
  brand row. A softly filled narrow column identifies the navigation pane, the
  chevron states collapse or expand, and both directions retain one footprint,
  hit target, tooltip, and accessible label.
- Refocuses the unlinked Focus study on the remaining decision. Every variant
  now shares one opening-seam band concept: the upper and lower page regions
  separate, the Focus band settles into the seam, and its two accent rails draw
  outward from the centre with one bounded glow. Variants A-E compare only the
  fixed-size button transition: crossfade, vertical handoff, icon transform,
  accent sweep, or perimeter pulse. Production Focus motion is unchanged until
  that button comparison is selected.
- The focused sidebar contract and JavaScript syntax gates pass. The selected
  glyph is source-guarded by its filled-column anatomy and mirrored directions,
  rather than by the presence of an arbitrary icon name.

## 0.8.334 - 2026-08-19

- Removes the clipped focus-shadow stub at Dashboard Search's field/result
  junction. Search keeps one continuous accented outer boundary while a normal
  neutral hairline separates the input from suggestions and results.
- Makes Open's title/URL filter a permanently available field in the existing
  section action line. The broken empty icon and click-to-expand state are gone,
  so focusing it changes neither its width nor the **Close the day** position.
- Repairs pinned-tab state at the actual cascade boundary. **Pinned** remains
  visible when optional row details are set to Clean and now uses exactly the
  same accent text color as **(current window)**. The browser-backed regression
  checks visibility and computed color, not merely the conditional markup.
- Uses the concise **Light**, **Dark**, and **Vivid** headings in both scheme
  selectors. The Focus action no longer requests the operating system's busy
  cursor while its state refreshes.
- Replaces the settled brand-row navigation prototype with five glyph-only
  comparisons and adds a separate five-option interactive Focus-motion study.
  Neither prototype changes production Focus or sidebar motion before selection.
- Full Smoke, Vault, portable-state, organization, Close-the-day, performance,
  Loading starvation, focused browser polish, side-panel pressure, scheme picker,
  and syntax gates pass. The strict scheme gate remains 4,212/4,212; all 31
  source-bound contact sheets were recaptured with zero measured overflow.

## 0.8.333 - 2026-08-19

- Repairs Dashboard Search at its actual clipping boundary. Expanded results
  now paint and receive clicks above the collection instead of disappearing
  behind it. The existing Arrow Up and `domain:` paths are unchanged and ready
  for the requested installed recheck.
- Replaces Open's full-width sticky filter row with a compact Search action in
  the existing section header on Dashboard and side panel. It expands into one
  small whole-boundary field only when used, preserving the established window
  alignment and removing the extra sticky tier.
- Restores list focus with `preventScroll`, so selecting a row after scrolling
  cannot move the page. Pinned tabs now use the accented word **Pinned** without
  the unclear glyph, and **Drop Dasher** is renamed **Dasher**.
- Keeps the Focus button enabled geometry unchanged until its operation and UI
  refresh finish. Starting Focus adds one 180ms accent-edge cue to the status
  band, with no layout animation and an instant reduced-motion path.
- Adds an unlinked five-option navigation-collapse prototype. It compares a
  brand-row panel icon, labeled footer, canvas layout control, divider handle,
  and hover footer without changing the shipped sidebar.
- Full Smoke, Vault, performance, 373 scheme assertions, and the focused polish
  suites pass. The 4,212 scheme pairings remain green; all 31 source-bound
  contact sheets were recaptured with zero measured overflow. Installed Search,
  filter, selection, and Focus confirmation remains open.

## 0.8.332 - 2026-08-18

- Extends the strong connected Search boundary to Dashboard, Minimal, Popup, and
  side panel. The field and results now read as one focused surface with no
  accented middle seam and no background blur. Arrow Up from the first result
  reaches the **Jump to** shortcuts; a live frequent-domain example replaces the
  retired Smart View example.
- Retires Smart Views from navigation, Search, onboarding, and active runtime.
  Existing pre-launch Smart View records remain valid in Export, Restore, and
  Vault so no saved data is discarded. The local `domain:` facet is now the
  simpler replacement for finding a site's tabs across locations.
- Adds a fast sticky **Filter open tabs** field that filters titles and URLs while
  preserving window structure. The shared cross-window bulk dock receives the
  same focus contour as Search, while one-window selections keep actions in that
  window header.
- Clarifies pinned tabs with an accented **Pinned** metadata state, rebuilds the
  sidebar collapse control as a panel control, accents **Now**, **Saved**, and
  **More**, and groups the 36 scheme choices into four scannable families with
  alphabetical names and wider column spacing.
- Keeps interoperability permanently expanded in Data, puts **Choose file**
  first, and changes the paste prompt to **Or paste the export text here...**.
  Focus feedback is now one short opacity cue without a competing layout
  transition.
- Stabilizes Popup at its final frame before reveal, keeps its utility footer
  visible, and makes compact side-panel Suspend/Wake actions square regardless
  of profile-specific action-label settings.
- Adds five unlinked Minimal studies for the next design choice: Monument,
  Starred orbit, Editor desk, Horizon, and Split day. They are decision tools,
  not a silent change to the shipped Minimal mode.
- Smoke, Vault, performance, Loading starvation, domain, History, compact
  side-panel pressure, scheme-picker geometry, syntax, and the focused polish
  suites are green. Hosted Windows/macOS/Ubuntu and physical ChromeOS/native-UI
  checks remain explicit release gates.

## 0.8.331 - 2026-08-18

- Completes the 26-point pre-localization polish batch. Minimal New Tab now has a
  larger responsive clock and calmer vertical hierarchy while retaining Search,
  Focus access, quiet destinations, and the complete color-scheme atmosphere.
- Makes mature-profile Session rename feel immediate: the visible title and
  focus commit optimistically while the atomic Session/Vault operation finishes;
  a failed write restores the previous title and reports the failure.
- Brings Popup and side-panel Search back onto the shared Dashboard field,
  connected results, square selection, and full accent-boundary treatment. The
  rest of the ledger remains sharp rather than being blurred behind a non-modal
  Search surface.
- Reuses the shared anchored Sort and Snooze palettes in Popup, aligns native
  select arrows, clarifies Gather, replaces ambiguous pinned/dot marks, squares
  Session drift rows, fixes compact Suspend/Wake pressure, stabilizes the Focus
  action width, and adds one restrained reduced-motion-safe Focus reveal.
- Reorganizes the sidebar into **Now**, **Saved**, and **More**, edge-docks the
  collapse control, aligns Settings and Color scheme utilities, and rebuilds
  Data as Settings-style Backup, Restore, and collapsed interoperability groups.
  OneTab import remains; the redundant OneTab export is removed.
- Moves one-card bulk actions into that card's header, keeping the shared dock
  only for a cross-card selection. Popup publishes one useful state after its
  independent reads and derives duplicates from the same live-tab snapshot.
- Adds an Inbox-expiry Needs you entry during the final 24 hours before automatic
  archive. **Open tabs** and **Open** remain the correct English state labels.
- Adds a local, non-persisted `domain:` Search facet with captured domains ranked
  by frequency and autocomplete from two characters. Smart Views remain while
  installed use compares live domain finding with durable saved rules.
- Restricts **On open** rotation to New Tab. Popup, side panel, and direct
  Dashboard paint the current scheme synchronously. Theme caching now reads one
  atomic storage snapshot and rejects an older cross-context write, eliminating
  the rapid consecutive-New-Tab first-frame flash found by the real browser gate.
- Adds Windows, macOS, and Ubuntu portable plus real unpacked-Chrome CI jobs.
  ChromeOS and Linux desktop/native-dialog differences stay in the explicit
  manual release matrix.
- New focused polish and domain suites pass, alongside smoke, Vault, portable
  Restore, organization, custom schemes, Loading starvation, and performance.
  Two independent real-Chrome runs each advance eight non-repeating New Tabs with
  synchronous and final colors matched and no intermediate scheme.

## 0.8.330 - 2026-08-18

- Names every selected label in each affected Close-the-day row, matching the
  exact existing/new Session outcome already shown there. Multi-label choices
  keep every name in the full row description while the compact line may
  ellipsize visually.
- Completes the approved optional Browser History trust model. The capability
  remains off by default and outside installation. Contextual Search and Smart
  View entry points now explain Chrome's broad permission before a separate
  **Allow browser History** action. Settings adds one central On/Off control and
  **Turn off**; revocation leaves existing Smart Views and all saved data intact.
- Makes opted-in History Search local-first and bounded: the last 30 days,
  maximum 20 fetched, and at most five History-only rows in an ordinary query.
  Local URL matches win deduplication. `in:history` retains the normal surface
  cap, while blank, one-character, and other scoped queries never call History.
- History rows now say **Browser history · age** with **Open**, never expose visit
  counts, and never enter EveryTab storage, Vault, Export, or Activity. Popup,
  Dashboard, side panel, Minimal new tab, and `et` update their placeholder and
  permission state without reload.
- Adds focused permission/search privacy coverage and a mounted Allow/Turn off
  Settings flow. Close the day passes 64 mounted checks at 320 px and 65 at 800
  and 1280 px. Full smoke, Vault, Restore, organization, performance, Loading,
  custom schemes, and the 4,212-pair scheme gate remain green.

## 0.8.329 - 2026-08-18

- Names the exact chosen Session in each affected Close-the-day row, including
  window-level bulk choices and newly created Sessions. The selected icon,
  tooltip, accessible label, and supporting action copy now tell the same story.
- Upgrades resumable drafts created before the shared label picker gained its
  catalogue. The draft is rebuilt once from current saved data while preserving
  its identity and every validated tab/window choice, so matching existing
  labels populate without starting the review over.
- Adds a real legacy-draft domain regression plus mounted Chrome coverage for
  the selected-Session outcome. The planner passes 20 focused checks; the
  mounted workflow passes 63 checks at 320 px and 64 at 800 and 1280 px. Full
  smoke, Vault, portable Restore, organization, performance, Loading, custom
  scheme, and 4,212-pair scheme gates remain green.

## 0.8.328 - 2026-08-18

- Treats YouTube playback positions such as `t=3s` and `t=4s` as the same saved
  page during Close the day. Video, playlist, index, and unrelated query values
  remain significant, so only temporary playback position stops creating false
  new-Session suggestions or stale-review warnings.
- Reuses EveryTab's searchable top-layer pickers for both filing paths. Labels
  show existing suggestions and accept several values with the standard
  **Enter adds a label. Enter again applies.** flow; Sessions combine existing
  choices and new Session creation in one field. Both shared controls prime
  their suggestions as they open, independent of native popover focus timing.
- Makes saved Archive labels more visible with the scheme's contrast-safe accent
  material while retaining their ordinary row-chip position.
- Keeps Up and Down in the same action column across rows, falling back only when
  the next row does not offer that action. Left still returns to the checkbox and
  Right re-enters the row action lane.
- Renames **Other windows** to **Regular windows** and makes every section
  navigator count tabs rather than mixing window and tab totals.
- Extends each sticky window cap's page-material mask across the complete gap
  above it, removing the final one-pixel text seam at rounded corners.
- The planner passes 19 focused checks. The mounted workflow passes 61 checks at
  320 px and 62 at 800 and 1280 px. Smoke, Vault, portable Restore,
  organization, Loading, custom schemes, performance, all 4,212 scheme
  pairings, and all 31 source-bound captures are green.

## 0.8.327 - 2026-08-18

- Adds one compact section navigator below the fixed review summary. **Sessions**,
  **Other windows**, and **Staying open** show live counts, jump to their stage,
  and follow the current stage while the page scrolls.
- Derives ordinary **Window N** headings from the current browser window order at
  render time. Resumable drafts made by earlier builds can no longer restore a
  tab title such as **New Tab** as the window heading.
- Gives the sticky summary a full 16 px opaque clearance strip. Window headings
  retain ordinary section breathing room and rows cannot show through its lower
  edge while scrolling.
- Returns review items to the normal 44 px ledger rhythm. The chosen outcome now
  sits in the row copy, below the title, while one compact action rail owns the
  border and keyboard path.
- Places each window checkbox in the ordinary leading selection column. The
  compact filing actions and **All N tabs** or **N selected** scope share one
  line, reducing header height without weakening whole-window actions.
- Renames the replacement reversal to **Keep saved arrangement** and states
  **Open tabs will replace the saved arrangement** after confirmation.
- The mounted workflow passes 57 checks at 320 px and 58 checks at 800 and
  1280 px. Planner, smoke, Vault, portable Restore, organization, Loading,
  performance, and all 4,212 scheme pairings are green; all 31 source-bound
  captures report zero overflow.

## 0.8.326 - 2026-08-18

- Gives both **Close the day** entry points the scheme's authored accent text.
  Miami Nights is pink, while palettes such as Frozen Llama retain their own
  primary accent.
- Keeps a small opaque gap between the fixed review summary and each sticky
  window cap. A page-material halo masks rows at every edge, and the summary
  keeps a stable two-line measure while choices change, so the review no longer
  jumps or bleeds during scrolling.
- Replaces split action-set borders with one continuous themed contour. The same
  component now stays intact in Phosphor, Frozen Llama, and the other schemes.
- Moves whole-window and selection filing into the window header. With no rows
  selected, actions apply to the complete window; with a selection, the same
  actions apply only to those tabs. The separate instruction row is removed.
- Names ordinary groups **Window 1**, **Window 2**, and so on, rather than using
  one tab title as the group name. Archive rows show their existing labels as
  normal label chips and use the clearer outcome **Close. Already saved with
  labels**.
- Makes the complete row body select the tab. Up and Down enter and traverse row
  checkboxes, Right enters the action set, Left returns to the checkbox, and
  Enter or Space toggles the current choice without scrolling the page.
- The mounted workflow passes 49 checks at 320, 800, and 1280 px with zero
  overflow. Planner, smoke, Vault, portable Restore, organization, Loading,
  performance, and the refreshed 4,212-pair scheme gates are green.

## 0.8.325 - 2026-08-18

- Keeps **Close the day** text in the scheme's primary accent at rest, including
  Miami Nights pink. The button remains visually text-only until hover; a new
  derived accent-text role preserves that hue while meeting 4.5:1 across all 72
  built-in maps.
- Removes the exposed corridor between the sticky save summary and window caps.
  An outgoing cap may pass underneath the opaque summary, but rows can no longer
  appear between the two layers.
- Gives every row action one aligned 24-grid icon vocabulary: a saved check for
  durable copies, Inbox, Session, Label, a clear eye for **Leave this tab open**,
  and close for the explicit unsaved path. The connected lower band now says
  **Selected:** and names the exact outcome, including the Session, Inbox, or
  Archive labels that already hold a copy.
- Replaces the unclear Undo-only wording with **Close without a permanent saved
  copy** and plain supporting copy. Up, Down, Left, Right, Home, End, Enter, and
  Space now stay inside both row and window-level action sets instead of
  scrolling the Dashboard.
- Adds per-tab selection plus one window-header bulk rail. A whole source window
  can receive one existing or new Session, one label plus Archive, Inbox, stay
  open, or close choice without typing the same value repeatedly. The bulk plan
  validates every member and persists in one atomic draft update.
- Paints row and bulk choices optimistically, then serializes their device-local
  saves. The review feels immediate while final Close remains disabled until the
  pending choices are durable.
- The focused planner passes 17 checks; the mounted workflow passes 37 checks at
  320, 800, and 1280 px with zero overflow. Smoke, Vault, and the refreshed
  4,212-pair scheme/contact-sheet gates are green.

## 0.8.324 - 2026-08-18

- Makes **Replace saved arrangement** an explicit confirmation instead of a
  transient relabel. After confirmation, the chosen replacement stays visible,
  can be reversed before closing, and cannot be submitted repeatedly while it
  is being saved.
- Replaces event-based stale warnings with an exact read-only comparison. Merely
  switching apps, windows, or focus no longer says the browser changed; actual
  tab or saved-data changes still stop the final close and require a refresh.
- Treats an EveryTab-suspended web page as its original saveable address, so it
  can follow ordinary save-and-close choices instead of filling the protected
  exceptions stage. Truly internal and unsaveable pages remain protected.
- Keeps the save summary and final action visible below the section heading,
  preserves rounded group caps while they are sticky, accents **Close the day**,
  and gives empty stages a distinct quiet status treatment.
- Replaces each tab's native action menu with a shared icon radiogroup. Arrow
  keys move between choices and Enter or Space applies one; the selected choice
  remains written below the icons. Copy throughout the review is shorter and
  uses direct global English.
- Adds exact stale-state, suspended-page, replacement, keyboard, sticky-scroll,
  and overflow regressions. The mounted suite passes 24 checks at 320, 800, and
  1280 px; planner, smoke, Vault, portable Restore, organization, Loading,
  custom-scheme, syntax, and performance gates remain green.

## 0.8.323 - 2026-08-18

- Adds the approved full-page **Close the day** review from Open tabs in both
  Dashboard and side panel. Restored Session windows, other windows, and
  stay-open exceptions are separated into three readable stages; the review is
  device-local, resumable, and changes nothing until the final confirmation.
- Closes already-kept occurrences safely, adds only genuinely new restored-
  Session tabs by default, preserves saved tabs that are currently absent, and
  makes arrangement replacement an explicit two-step choice. Automatic
  Snapshots do not count as durable coverage. Unsaved tabs default to one ordered
  Inbox bundle per source window; label + Archive, existing/new Session, stay
  open, and address-only recovery remain explicit alternatives.
- Keeps pinned tabs open by default and always protects audible, EveryTab,
  extension, internal, blank, incognito, non-normal, and unsaveable pages.
  Browser and saved-data revisions are checked again at commit; any change stops
  the operation and refreshes the review instead of guessing.
- Commits every keep decision, one Activity entry, and a bounded device-local
  receipt atomically before removing any tab. Exact tabs are revalidated again
  during the close phase; an interrupted worker resumes from the receipt.
  **Undo Close the day** restores unchanged saved records and reopens the page
  addresses it actually closed, while later edits are left untouched.
- Adds a focused planner/coordinator regression plus a mounted workflow
  fixture. The latter passes at 320, 800, and 1280 px with no horizontal
  overflow. Full smoke, Vault, portable Restore, organization, Loading, syntax,
  and performance gates remain green.

## 0.8.322 - 2026-08-18

- Fixes the exact Ungrouped membership sequence where applying a new group
  removed the current card but left focus on a clipped lens outline. Focus now
  returns to the surviving card action, or to **+ Group** when the card leaves
  Ungrouped.
- Makes every explicit Label/Session group-lens route reveal its first card
  below the measured sticky stack. The instant anchor is repeated across the
  existing coalesced refresh frames, so a retained deep scroll offset can no
  longer produce an apparently empty group.
- Keeps empty and member-seeded group creation itself non-navigating; only a
  deliberate lens click changes and repositions the view.

## 0.8.321 - 2026-08-18

- Uses the chosen connected **cluster** glyph for Label/Session group creation,
  membership, and management. Window **Organize** keeps its distinct sliders.
- Keeps the current group lens, scroll context, and stable focus when a newly
  created group already contains labels or sessions. Empty and populated group
  creation now follow the same non-navigating rule.
- Adds an executable regression for the exact member-seeded creation path that
  previously switched into the new lens.

## 0.8.320 - 2026-08-18

- Adds fast themed tooltips to **+ Group**, **Add labels/sessions**, **Manage**,
  and each card's **Groups...** action with purpose-specific copy.
- Keeps the current populated lens after **+ Group** creates an empty group.
  This prevents the list from collapsing into an apparent empty page and keeps
  focus on the creation command instead of a clipped horizontal lens boundary.
- Keeps an anchored action palette open while its own choices scroll. Scrolling
  the underlying page still dismisses it, so the palette never becomes detached
  from its invoking row.
- Replaces the card-level group checkbox ledger with the established tag-entry
  grammar: type to filter, Enter adds an existing or pending new group, and Enter
  again applies. New groups and the complete membership change commit atomically,
  with no half-created assignment if the member changed concurrently.
- Retains the existing organization icon while the replacement cluster-glyph
  direction awaits installed visual approval.

## 0.8.319 - 2026-08-18

- Removes the temporary **Troubleshoot theme rotation** control after its report
  identified the main-profile fault and v0.8.318 was installed successfully. The
  bounded internal diagnostic remains dormant for future evidence, while normal
  Appearance keeps only the ordinary scheme and rotation controls.
- Adds optional one-level **Label groups** and **Session groups** directly to the
  existing Labels and Sessions sections. **All** deduplicates objects,
  **Ungrouped** shows objects with no membership, and one Label or named Session
  can belong to several groups. Automatic Snapshots are never group members.
- Adds anchored **+ Group**, **Groups...**, **Add labels/sessions**, rename, and
  group-only delete controls to Dashboard and side panel. Group deletion keeps
  every Label, Session, link, and tab; named-Session deletion updates its group
  memberships atomically, and existing Undo behavior remains intact.
- Makes both group types portable through JSON Restore and Vault. Deterministic
  membership edges merge independently, freshness tokens prevent stale pickers
  from erasing concurrent assignments, and duplicate-name Vault conflicts render
  as one unioned lens without a destructive repair migration.
- Adds navigation-only Label-group and Session-group results to Search and `et`
  from two characters. They open the exact existing section and group lens; no
  new filter grammar, page, permission, account, drag behavior, or Open first-paint
  read was added.
- The final gates cover 33 organization assertions, portable Restore, Vault,
  Search/omnibox routing, full smoke, performance, Loading starvation, shared
  group interaction/focus contracts, measured side-panel pressure, scheme
  selection, and eight real non-repeating Chrome New Tabs.

## 0.8.318 - 2026-08-17

- Fixes the long-lived-profile **On open** failure identified by v0.8.317's
  local report. Deleting a custom scheme deliberately cleared the no-repeat bag
  to `null`; the next draw handled an absent key but dereferenced that explicit
  null before it could commit, so the worker failed and the selected scheme
  stayed unchanged.
- Normalizes a cleared or malformed persisted bag at the shared draw boundary.
  The next New Tab creates a fresh valid bag and reservation automatically, so
  existing affected profiles need no reset, migration, export/import, or data
  deletion. Popup, side-panel, hourly, and daily draws inherit the same repair.
- Adds both the exact custom-delete → On-open transaction regression and a report-shaped
  fixture with Dasher, no favorites, two tombstones, and null operational keys.
  The ordinary smoke, Vault, interaction, pressure, and real-extension rotation
  gates remain unchanged; the diagnostic stays available for future evidence.

## 0.8.317 - 2026-08-17

- Adds an opt-in **Troubleshoot theme rotation** check in Appearance for the
  main-profile-only failure that the fresh-profile regression cannot reproduce.
  It opens one ordinary temporary New Tab, watches the complete path for five
  seconds, closes only that tab, and produces a copyable local report.
- Distinguishes a missing page-to-worker handshake, a worker no-op or failure,
  malformed/stale rotation state, a one-scheme pool, a successful commit that a
  later Settings or Vault write replaced, and a stored scheme that the New Tab
  did not actually paint. The check records that tab's masked synchronous boot
  and final paint, so a background write alone cannot be reported as success.
- Keeps the diagnostic bounded and private: its 24-event trace exists only in
  worker memory while the check is armed. It includes no URLs, titles, labels,
  Sessions, history, Vault folder name, custom-scheme name/ID, or arbitrary error
  text, and it performs no reset, repair, migration, telemetry, or network call.
- Leaves ordinary New Tabs unchanged. An unarmed page receives the established
  response and sends no diagnostic paint message. Smoke, Vault, pressure,
  surface, Settings interaction, selector, and focused diagnostic gates pass.

## 0.8.316 - 2026-08-17

- Fixes the profile-dependent **On open** cache race. The previous native-tab
  trigger committed before the override document's first script; an already-open
  EveryTab page could then replace the shared prepared cache with the following
  draw, so the new page briefly showed the wrong scheme or appeared not to rotate.
- Keeps worker and tab-ID ownership, but starts that task from the New Tab page's
  readiness handshake only after the classic pre-paint script has consumed the
  reserved scheme. The classic script is now the sole pre-paint reader; the module
  cannot reread a newer shared reservation during loading.
- Strengthens the installed-shape Chrome gate to inspect both the synchronous boot
  scheme and the final stored/painted scheme. The pre-fix build fails on the first
  warm-cache New Tab; the fix passes eight consecutive real New Tabs with eight
  non-repeating writes and no intermediate non-final scheme.
- No profile reset, cache clearing, data migration, permission, selector, or
  Dashboard loading-path change is required.

## 0.8.315 - 2026-08-17

- Moves real New Tab **On open** ownership to the background worker. Chrome's
  native `chrome://newtab/` creation event starts the draw before the override
  page's module graph, so a long-lived or delayed page can no longer make the
  open inert.
- Adds a tab-ID handshake from the New Tab page to that same worker task. The
  creation event and page readiness are independent triggers but one durable
  in-worker claim, so one Chrome tab consumes exactly one scheme.
- Replaces the misleading mock-only gate with an installed-shape regression:
  load the unpacked extension in Chrome for Testing, use real extension storage,
  open eight actual `chrome://newtab/` targets, and require eight visible,
  non-repeating schemes from exactly eight stored changes.
- Keeps manual selection and cold loading outside the rotation transaction.
  Rapid-selection, Loading-starvation, 32-context pressure, performance, smoke,
  and Vault gates remain green.

## 0.8.314 - 2026-08-17

- Restores the opening page's ownership of **On open** rotation. A New Tab now
  paints the draw it commits directly instead of depending on its own asynchronous
  `storage.onChanged` broadcast to complete the visible operation.
- Keeps v0.8.313's fast boundary. A local transaction token lets the opening page
  skip only its matching broadcast, so it does not repaint twice; other live
  EveryTab contexts still update once, and no reservation lock herd returns.
- Adds the missing regression: remove the prepared first-paint cache, delay the
  writer's storage event, and require the stored and painted schemes to advance
  together. The prior implementation fails this exact test while v0.8.314 passes.

## 0.8.313 - 2026-08-17

- Restores instant scheme selection and cold loading after the previous rotation
  repair accidentally made every open EveryTab page queue the same next-scheme
  reservation. One non-blocking cross-context coordinator now owns that write;
  other pages paint the saved choice immediately instead of joining a lock herd.
- Removes two redundant full theme passes: an atomic On-open draw is painted by
  its storage event only once, and the internal prepared-reservation write no
  longer broadcasts a second repaint to every context.
- Makes the latest rapid scheme click authoritative over any older asynchronous
  reconciliation. The regression gate mounts 2 and 32 existing contexts, checks
  bounded work, then opens three real New Tab entry contexts without repeats.
  A mounted Chrome check also fires three immediate picker choices and verifies
  the final selection owns the page, stored setting, cache, and next reservation.

## 0.8.312 - 2026-08-17

- Repairs the remaining state-dependent **On open** stall. If a manual scheme
  choice was still waiting inside the current no-repeat bag, it could become its
  own next draw; the no-op path then preserved that same pending state forever.
  Rotation now removes the active scheme from the pending bag and rejects a
  self-reservation before every draw.
- Treats the manifest `newtab.html` URL as the authoritative New Tab identity for
  both prepared pre-paint and draw consumption, rather than requiring the async
  entry module's convenience marker.
- Extends the release gate with the exact manual-choice-inside-pending-bag
  sequence plus five consecutive persisted New Tab opens. Each open must advance
  both the stored and visible scheme without a repeat.

## 0.8.311 - 2026-08-17

- Makes every manual scheme choice paint immediately from its saved value. The
  independent **On open** reservation now finishes afterward, so another
  EveryTab context briefly holding the shared store lock cannot leave Settings
  showing one scheme while the page remains painted with another.
- Moves the Dashboard scheme menu out of the sidebar's clipped stacking context.
  Both columns now receive their own scheme and star clicks instead of the main
  content intercepting the right-hand column.
- Strengthens the release gate with a mounted real-DOM saved-selection test under
  deliberate cross-context lock contention, a zero-favorites visual rotation test
  on all four entry surfaces, and real-Chrome hit testing at 320, 400, and 800px.

## 0.8.310 - 2026-08-17

- Promotes Good Night **Pastel keys** and Oblivion **Frost + blue** into the free
  built-in library. The candidate shelf is now empty and the completed portfolio
  contains 36 built-ins / 72 Light/Dark maps.
- Repairs **On open** rotation on the surfaces people actually open: Popup, side
  panel, Dashboard, and every New Tab mode. The next no-repeat draw is reserved
  and synchronously pre-painted, while Settings, the editor, and suspend pages do
  not consume it. Hourly and Daily cadence repair plus worker dispatch are covered
  by the release gate.
- Gives the scheme selector a fixed star lane and a responsive one/two-column
  grid. Names remain on one ellipsized line with their full value in the tooltip,
  so the existing 64-character custom-name boundary needs no shorter UI limit.
- Expands the strict palette gate to 4,212/4,212 production pairings. All 31
  source-bound responsive contact sheets are current, visually reviewed, and
  measured without overflow; a real-Chrome 320/400/800px selector gate verifies
  that names and stars never overlap.

## 0.8.309 - 2026-08-16

- Promotes Red Samurai's crimson-field composition, `/dev/tty` White, and Frozen
  Llama Aqua into Scheme default, favorites, rotation, and the free built-in
  library.
- Replaces the rejected Good Night pair with four visibly different studies:
  balanced pastel keys, mint case, lavender case, and sky case. All keep the
  supplied off-white, teal, yellow, blue, and purple family; the interaction
  yellow is now cleaner and less brown.
- Rebuilds Oblivion as four cool-grey studies using blue, green, violet, or slate
  legend hierarchy. The unrelated orange interaction color is removed entirely.
- Expands the canonical gate to 34 built-ins, 68 mode maps, and
  3,978/3,978 exact production pairings. All 29 responsive contact sheets are
  current, visually reviewed, and measured without overflow.

## 0.8.308 - 2026-08-16

- Promotes Miami Nights and Darling into the free built-in library. Miami keeps
  blue primary text with pink interaction color; Darling keeps deep red text on
  pale pink with a dark red accent. Both participate in Scheme default,
  favorites, and rotation.
- Removes `GMK` from every visible scheme name. Chocolatier, Perestroika,
  Metropolis, Hiney Beige, Taiga, Bushido, Jamón, Darling, and Oblivion now use
  the concise portfolio names.
- Rebuilds the five remaining trial directions from the supplied photographs.
  Red Samurai is red-dominant with yellow actions; Oblivion is light-grey-led;
  Good Night combines off-white with pastel teal, yellow, blue, and purple;
  Frozen Llama is cyan-led with blue structure and purple secondary text; and
  `/dev/tty` is a restrained white/light-grey theme with one red accent.
- Offers two clearly named editor variants for each remaining direction, ten
  candidates total, so the next comparison can settle all five without another
  exploratory round. The strict gate now covers 31 built-ins, 62 mode maps, and
  3,627/3,627 production pairings; 27 source-bound responsive sheets have zero
  measured overflow.

## 0.8.307 - 2026-08-16

- Promotes Chocolatier, Perestroika, Metropolis, Hiney Beige, Taiga, Bushido,
  Dasher, and Jamón into the free built-in library. Chocolatier now opens in its
  intended Dark mode. Every accepted scheme participates in Scheme default,
  favorites, and rotation like the established library.
- Rebuilds the remaining candidate pass around Miami Nights, Red Samurai,
  `/dev/tty`, Frozen Llama, Darling, Good Night, and the new Oblivion. Miami now
  uses blue text with pink interaction color; the other revisions follow their
  source sets more closely, including Darling's red-on-pink relationship and
  Good Night's wider pastel range.
- Keeps preview window headers in the editor's own scroll flow, so they no
  longer stop halfway down the component atlas as detached floating rows.
- Expands the strict built-in gate to 29 schemes and 58 Light/Dark maps. All
  3,393 production pairings pass, and 25 current wide, compact, and pressure
  sheets have zero measured overflow.

## 0.8.306 - 2026-08-15

- Adds fourteen editable **Candidate schemes** to the dedicated editor: Miami
  Nights, RedSuns Blue Samurai, /dev/tty, Frozen Llama, Darling, Good Night,
  Chocolatier, Perestroika, Metropolis, Hiney Beige, Taiga, Bushido, Dasher, and
  Jamón. Candidates can be compared, adjusted, and saved into **Yours**, but do
  not join built-ins or rotation until explicitly approved.
- Consolidates the overlapping violet family around Dracula. Catppuccin and
  Rosé Pine leave the visible built-in portfolio while existing beta selections
  continue safely through compatibility aliases. The built-in library now has
  21 schemes and 42 Light/Dark maps.
- Replaces Sunset Surf with the approved warm surf-orange, teal, cream, and
  aubergine role maps, including the supplied Light and Dark gradients.
- Makes save state explicit with **Not yet in Yours**, **Unsaved changes**,
  **All changes saved**, **Needs fixes**, and **Saving** feedback. Save is the
  accent action only while valid work is waiting and becomes a disabled
  **Saved** control after a successful write.
- Replaces preview lookalikes with production navigation and Search anatomy.
  The active section uses the real accent treatment and selected Search results
  use the same square full-width band and aligned title, metadata, and outcome
  lanes as EveryTab.
- The revised 42-map portfolio passes 2,457 exact production pairings. All wide,
  400px, and selected 320px contact sheets were recaptured against the new
  source with zero measured overflow.

## 0.8.305 - 2026-08-13

- Moves color authoring out of the compact Appearance card and into a dedicated,
  responsive editor. Desktop keeps source colors, the full component preview,
  and validation visible together; narrow windows use the same content in one
  readable column with no horizontal overflow.
- Any built-in or saved custom scheme can be the starting point. Built-ins load
  their exact production roles in Advanced and remain protected; saving creates
  a new custom copy. Moving an exact scheme to Guided requires an explicit
  confirmation because it re-derives roles from seven source colors.
- Each color combines the native picker with an editable, copyable, paste-ready
  hex field. **Show uses** briefly marks directly controlled preview components
  with a solid outline and derived uses with a dashed outline, then clears
  automatically or with Escape.
- The isolated preview now includes navigation, Search, real tab-list anatomy,
  controls, chips, statuses, typography, and surfaces. Validation issues link
  back to the relevant mode and field without applying draft colors to the
  surrounding EveryTab interface.
- Settings keeps a compact **Yours** library for Apply, Edit, Duplicate, Share,
  Import, and Delete, plus direct routes to start or resume the editor. Draft,
  strict validation, storage, portability, and the 100-scheme boundary are
  unchanged.

## 0.8.304 - 2026-08-13

- Adds the free, local **Your color schemes** library to Appearance. Guided
  editing exposes seven source colors for both Light and Dark; Advanced exposes
  every production color role and gradient control in the same page.
- A live isolated preview and plain-language validation report update while
  editing. A failing design remains a resumable local draft, but cannot be
  saved, applied, favorited, rotated, shared, restored, or synced until both
  modes pass EveryTab's complete contrast and component checks.
- Valid custom schemes appear under **Yours** in Settings and the quick picker.
  They can be applied, edited, duplicated, favorited, rotated, shared as
  data-only JSON, or imported as a fresh copy with no account or entitlement.
- Each saved scheme is an independent UUID record in JSON Export/Restore and
  Vault. Deleting one repairs active and favorite references atomically; a
  missing active scheme safely falls back to Cream and reports what happened.
- Cold pre-paint caching includes the complete allowlisted custom role map, so
  a custom theme does not flash Cream on a new tab. A deterministic validation
  seal keeps a 100-scheme library inexpensive to browse while strict validation
  remains mandatory at every write and portability boundary.

## 0.8.303 - 2026-08-13

- Completes the exhaustive built-in scheme review across all 46 Light/Dark maps
  at both 1280px and 400px, plus four selected 320px pressure cases. Hierarchy,
  interaction states, controls, materials, atmosphere, and compact truncation
  pass without a built-in palette change.
- Adds a source-bound real-Chrome capture runner for all 21 labelled sheets. It
  rejects stale plans, incorrect page widths, specimen overflow, and descendant
  bleed before a review can be recorded.
- Repairs two internal Lab-only fidelity defects found by that pass: state
  selectors now target the mounted specimen root, and nested specimens resolve
  derived roles and fixed atmosphere inside their own scheme canvas.
- The durable review ledger now records every wide, compact, and pressure result
  against the exact source fingerprint. A later visual-input change makes that
  approval stale automatically.
- v0.8.302's shared scheme-role repair is installed-accepted. No installed
  product surface, built-in palette choice, permission, setting, saved data,
  sync, Vault, or export format changed.

## 0.8.302 - 2026-08-12

- Closes the expanded built-in scheme readiness gate: all 2,691 exact
  component-state pairings now pass across the 23 schemes in Light and Dark.
- Tinted controls, label chips, active stars, and muted navigation now use a
  dedicated readable ink role instead of borrowing the palette's second accent
  hue. Dark schemes lift only that small-control copy when needed.
- Pale accents now derive a contrast-safe focus boundary while preserving their
  authored hue. Status dots keep their semantic fill and gain a quiet readable
  edge on their own tints.
- Workbench metadata receives a shared per-mode readability lift, and the Dark
  hover material receives a one-point accent adjustment. No built-in palette
  block was individually changed.
- The real-Chrome Scheme Lab passes its wide, narrow, and 320px pressure
  contracts. Representative high-risk contact sheets were inspected; the
  durable exhaustive 46-map human review remains the next gate.
- v0.8.301's internal Scheme Lab foundation is now installed-accepted. No
  permission, setting, saved data, sync, Vault, or export format changed.

## 0.8.301 - 2026-08-12

- Adds an unlinked internal Scheme Lab that renders the real Dashboard and
  compact side-panel list anatomy across built-in Light and Dark schemes,
  gradient states, and 1280, 400, and 320px capture widths.
- Adds a pure seven-colour compiler, exact production-token parser, bounded
  draft fixture format, and shared role validator. The Lab stores nothing and
  is not connected to Settings, rotation, Vault, or product navigation.
- The expanded readiness audit records all 2,691 production pairings across 46
  built-in scheme/mode maps. It finds 307 component-state pairings to repair;
  the existing established contrast gate remains green while this stricter
  pre-screenshot gate stays explicitly open.
- Adds a deterministic 21-page capture plan, a durable human-review ledger that
  regeneration never overwrites, and a real-Chrome contract for wide, narrow,
  and pressure specimens.
- v0.8.300's folded-favicon, Starred-motion, and typography changes are now
  installed-accepted. No palette, permission, saved-data, sync, or Vault change
  was made in this foundation batch.

## 0.8.300 - 2026-08-12

- Folded cards still show at most eight favicons. Under proven compact side-panel
  pressure, that same eight-tab summary becomes a stable text count so the title,
  fold control, and full action lane never collide. No resize observer or runtime
  measurement was added.
- Reordering Starred shortcuts now gives displaced rows one quiet 180ms continuity
  cue. The saved order, rendered order, and focus are final before motion begins;
  rapid reversals serialize safely and reduced-motion mode remains instant.
- The native system sans and mono direction is now explicit for v1. The section
  role is consistently 16px, changing popup, Search, and side-panel counts use
  tabular numerals, and compact host-specific sizes remain intact.
- The pressure gate covers 320, 400, and 520px plus 200% zoom, long expanded copy,
  a broken favicon, and the complete compact action lane with zero overflow.
- No permission, saved-data, Settings, sync, Vault, or export-format change was made.

## 0.8.299 - 2026-08-12

- Restore is now one unmistakable workflow: **Restore backup**, then **Confirm
  Restore**. The redundant disabled **Restore saved data** choice is removed;
  saved data is the operation, while **Restore settings** remains the one real
  optional choice.
- After a successful Restore, its action disappears and the completed result
  plus **Undo Restore** owns the workflow. It cannot be clicked repeatedly. The
  action returns only after an explicit Undo or after checking another backup.
- Settings still apply in the same atomic Restore commit, and the completion
  sentence explicitly includes settings when they changed.
- The mounted Chrome regression now covers this complete terminal behavior and
  the simplified preview. No storage, sync, Vault, export-format, or permission
  change was made.

## 0.8.298 - 2026-08-11

- JSON backup and Restore now use one versioned portable-state contract for
  saved records, tombstones, ordinary settings, and label recency. Live browser
  state, Activity, counters, Focus runtime, caches, and other device-only state
  remain excluded.
- Restore validates the complete file before writing, previews exact add/update/
  keep outcomes inline, and applies all accepted changes in one locked commit.
  Newer local records and tombstones remain protected.
- **Restore settings** is on by default. File settings win only through this
  explicit action, receive a fresh local timestamp only when they differ, and
  refresh an already-open Settings page without remounting or losing focus.
- A destructive Restore uses the established two-press confirmation and
  rechecks the plan at commit time. A newly arrived local change therefore
  requires a fresh review instead of being overwritten by a stale preview.
- The latest Restore has one selective local Undo checkpoint. If later saved-
  data edits make Undo unsafe, EveryTab leaves them untouched and offers an
  honestly labelled backup of the affected earlier data; Activity records the
  terminal state without blocking older Undo actions.
- Vault rolling backups now use the same portable v2 envelope. Unknown or newer-
  schema Vault files remain byte-for-byte untouched, including files whose IDs
  overlap understood local records.
- Large backup validation stages the shared delayed Loading treatment. Oversized
  files are rejected before their text is allocated; fast checks show no flash.

## 0.8.297 - 2026-08-10

- **Needs you** now says **3 duplicates** and **20 Inbox items**, without the
  redundant “Review” prefix.
- Its permanent history route is now **All activity**, making clear that the
  link is always the complete log rather than a fallback for missing recent
  automatic work.
- The heading and warning-item coloured dots are removed. Their mixed meanings
  were not self-explanatory; the direct labels already carry the information.
- No behavior, threshold, permission, storage, sync, export, or Vault format changed.

## 0.8.296 - 2026-08-10

- **Needs you** now shows up to three actual entries directly. Unresolved Vault,
  overdue snooze, restored-Session drift, duplicate, and meaningful Inbox work
  ranks before recent automatic actions.
- Inbox asks for attention only at 20 items or when its oldest item has waited
  seven days. Future snoozes remain plans, not warnings.
- Recent automatic work stays visible for 24 hours with its age and an exact
  **Undo** action. **Activity** remains the full durable history; completed or
  undone work disappears from the small queue.
- Automatic duplicate cleanup now uses the same fresh validation, journal, and
  recovery path as manual cleanup. Periodic automatic snapshots are excluded
  from both **Needs you** and **Activity**.
- The wide utility line keeps direct links rather than adding more chips. At
  tighter wide layouts, automatic information yields before actionables.
- No permission, synced setting, canonical store, export, or Vault format changed.

## 0.8.295 - 2026-08-10

- Fixed Open tabs staying blank when a live window was bound to a restored
  Session. The fast Session index now carries only normalized URL membership
  needed by the existing “new tabs since restore” check.
- Existing v0.8.294 indexes upgrade automatically after the first useful paint.
  Until then, Open safely uses generic window names instead of failing.
- Automatic snapshots and full tab metadata remain outside the Open startup
  path. The snapshot-heavy fixture remains at 0.01ms and the T2 primary path is
  0.07ms, both far below the 30ms budget.
- No Session, snapshot, binding, open tab, or Vault data is removed or rewritten.

## 0.8.294 - 2026-08-10

- Open no longer reads the full combined Session and automatic-snapshot store
  to name restored windows. Long-lived profiles now use a tiny derived index
  containing only live named Session IDs and names.
- The mature-profile regression fixture reproduces three named Sessions beside
  2,000 retained automatic snapshots. Its Open identity path falls from 74.58ms
  to 0.01ms in the permanent performance gate.
- Existing profiles build the index once after the first useful paint. Every
  later Session change updates the canonical store and its index atomically.
- No Session, snapshot, label, Archive item, open tab, or Vault file is removed
  or rewritten. The index is derived local state and is not exported or synced.

## 0.8.293 - 2026-08-09

- The side panel no longer focuses Search when it opens. Search remains one
  click or the `/` shortcut away, without covering a section before the user
  asks for it.
- Long Session tab titles now stop before the complete four-control action tray
  whenever it is revealed. Move, Star, Label, and Remove stay visible at compact
  panel widths.
- Mature-profile Open loading now paints live windows and Session names before
  scanning the full Inbox and Archive for saved-label chips. That exact label
  enrichment runs after the first paint and refreshes whenever either store
  changes.
- The performance harness now measures primary Open data separately from saved-
  label enrichment. At the heavy tier the primary library path is 0.39ms versus
  21.02ms for deferred enrichment; at the pathological tier it is 1.73ms versus
  94.27ms.
- No data reset, migration, permission, storage key, sync behavior, or Vault
  format changed.

## 0.8.292 - 2026-08-09

- Compact row actions now sit on an opaque row-matched tray, and Close uses an
  opaque danger tint. Long links and label chips can no longer show through
  buttons or the gaps between them.
- Sessions places **Save all to session** on the same line as its section count,
  aligned to the right. Side-panel action tips now use the shared fast themed
  tooltip instead of Chrome's delayed native tooltip.
- Open tabs no longer shows the compact “untouched over 4h” header sentence;
  the roomier Dashboard retains that contextual nudge.
- No permission, action behavior, storage, sync, or Vault format changed.

## 0.8.291 - 2026-08-09

- The side panel now uses one flat section-navigation band instead of five
  competing pills. Open, Inbox, Sessions, Labels, and More stay on one row at
  320px, with accent text and a bottom rail marking the active section.
- Search, active Focus, navigation, the section heading, local controls, and
  lists now share one 10px/12px horizontal axis. Temporary Focus access and the
  Labels filter/index publish their real wrapped height into the sticky stack.
- Compact window, session, label, Inbox, and Snoozed groups now use the same
  connected header/body material as Dashboard. Their headers pin immediately
  below the measured panel navigation and are pushed away by the next group.
- Loading, folding, actions, drag, selection, bulk operations, Search, and
  caching still come from the existing shared behavior sources. Needs you
  remains Dashboard-owned. No permission, action, storage, sync, or Vault
  format changed.

## 0.8.290 - 2026-08-09

- The accented duplicate-cleanup button now keeps its exact fill and text
  contrast on hover. A crisp inner keyline supplies the hover feedback instead
  of brightening the button toward the surrounding surface.
- Dashboard content links such as Inbox, Duplicates, Vault, Labels, and Focus
  settings now arrive with Search inactive. This works both when creating a
  Dashboard tab and when reusing an existing one.
- Plain Dashboard opens remain keyboard-first, and the dedicated Search command
  still focuses Search as intended.
- No permission, action behavior, storage, sync, or Vault format changed.

## 0.8.289 - 2026-08-09

- Popup section boundaries now use an exact 12px / hairline / 12px rhythm. The
  first section receives the same breathing room as later sections and the
  navigation footer follows the same spacing.
- An empty transient feedback row no longer reserves invisible height before
  Focus, removing the remaining uneven separator gap. Feedback still appears
  normally after an action.
- **This tab**, **This window**, **Focus**, and **Duplicates** headings now use
  each scheme's audited accent-ink role. **Close N duplicate tabs** is the one
  standing accent action; Save window remains quiet.
- No permission, action behavior, storage, sync, or Vault format changed.

## 0.8.288 - 2026-08-09

- Popup sections now use one consistent hairline and balanced spacing from
  **This tab** through **This window**, **Focus**, conditional **Duplicates**,
  and the navigation footer.
- **Save window to Inbox** remains the first full-width window command but no
  longer uses a standing accent block; it now matches the popup's quiet command
  vocabulary.
- When global duplicates exist, they appear in a separated **Duplicates**
  section. **See duplicates** opens the existing Dashboard Duplicates page for
  review, while **Close N duplicate tabs** keeps the established bulk cleanup
  and Undo path. The top active-page duplicate warning remains the faster
  switch-to-existing action.
- No permission, action behavior, storage, sync, or Vault format changed.

## 0.8.287 - 2026-08-08

- The toolbar popup is shorter and more deliberate. Search is now the stable
  first row, above duplicate and Vault warnings, while its result panel still
  floats over the content below.
- **This tab**, the current favicon, page title, and Star state share one identity
  line. Existing labels are capped at two plus a `+N` route, and the four tab
  actions form a balanced two-column grid.
- **This window** keeps **Save window to Inbox** as the only standing primary.
  **Copy links** is now a quiet heading utility and the four secondary actions
  form a complete two-column grid. Focus uses one compact status line, and the
  redundant popup Quick settings expander is retired; Settings remains in the
  footer.
- The duplicate banner's primary action keeps its accent material in every
  scheme, fixing an Ink-dark contrast leak. No action behavior, permission,
  storage, sync, or Vault format changed.

## 0.8.286 - 2026-08-08

- Loading remains an accent message after the 180ms anti-flash delay, but the
  moving gloss is removed. Typical waits ended during its first partial pass,
  which could make the letters look briefly broken rather than meaningfully
  animated.
- The user-confirmed main-thread-starvation repair is unchanged: cold empty
  owners stage the message before work, CSS reveals it even while JavaScript is
  busy, and fast reads remain silent.
- No data reset or migration is required for older profiles. No permission,
  storage, sync, or Vault format changed.

## 0.8.285 - 2026-08-08

- Loading feedback is now staged invisibly before a cold render and revealed by
  CSS after 180ms. A large synchronous list build can no longer block the timer
  and cancel the message before it ever appears. The Dashboard and full new-tab
  Open section now use it too, matching the installed cold-boot report.
- Fast reads still show nothing. The polite screen-reader status remains
  JavaScript-delayed, while cached content continues to stay visible during
  background refreshes.
- The old Chrome profile is not reset or migrated. Its larger saved library and
  retained sync tombstones remain useful for exposing realistic cold-render
  pressure; no permission, storage, sync, or Vault format changed.

## 0.8.284 - 2026-08-08

- Cold side-panel sections and the explicit Smart Views history scan now share
  one accent **Loading…** treatment instead of muted italic placeholder text.
- The state waits 180ms before appearing, so fast local reads never flash. It
  mounts only into an empty area; cached content stays visible during background
  refreshes and button-level work keeps its existing local pending feedback.
- A narrow clipped gloss passes across solid readable text while work remains
  pending. Reduced motion shows the same accent label without movement.
- The owning area exposes `aria-busy` immediately and the visible status is
  announced politely. No permission, storage, sync, or Vault format changed.

## 0.8.283 - 2026-08-08

- The Focus warning keeps its native **Add 5 minutes** button where Chrome and
  the operating system render it. Clicking the notification body now performs
  the same stale-safe five-minute extension, covering macOS installations that
  show only their own Settings control.
- Every temporary-access timer now includes **Stop**. It revokes that domain's
  grant immediately and returns its matching tabs to the existing Focus guard
  with their cumulative access context.
- Stop remains visually secondary to **Add 5 min**. At 320px the status heading
  wraps above the domain row, preserving a readable domain, exact timer, and both
  28px actions without horizontal overflow.
- No permission, synced state, or Vault format changed.

## 0.8.282 - 2026-08-08

- Temporary Focus access now shows an exact live countdown in the popup,
  Dashboard and full-dashboard new tab, side panel, and Minimal new tab.
- **Add 5 min** stays beside the timer and can be used repeatedly. Each click
  adds five minutes from the latest boundary, while a stale control from another
  surface refreshes safely instead of replaying an old extension.
- The system warning now points back to EveryTab for the timer and extension
  control, since macOS can collapse notification actions. Its own button remains
  available when the notification is expanded.
- Blank new-tab mode remains blank. No permission, synced state, or Vault format
  changed.

## 0.8.281 - 2026-08-08

- Focus temporary access now gives one domain-level notification two minutes
  before it expires, with an **Add 5 minutes** action. A late worker wake uses
  the honest remaining minute count instead of claiming a full two minutes.
- At expiry, matching background tabs return to the Focus guard, but the matching
  tab currently being used is never replaced. It stays live so an unfinished
  comment or form is not interrupted.
- The deferred page remains intact after switching away. Returning to that tab,
  or navigating it within the guarded domain, completes the expired guard. Closing
  it, leaving the domain, removing the rule, or ending its Focus scope clears the
  local deferral.
- Notification delivery is advisory. The active-page protection still applies if
  system notifications are hidden or unavailable, and no page-content permission
  was added.

## 0.8.280 - 2026-08-08

- Every Open-window header now ends with a Close action in Dashboard and side
  panel. The first click turns that header into a compact confirmation; the
  second closes the exact Chrome window, including pinned and internal tabs.
- Confirmation names the live tab total and explicitly warns when pinned tabs,
  the EveryTab window, or the last Chrome window are included. Escape, Cancel,
  leaving the control, or waiting four seconds safely disarms it.
- The worker re-reads the window before committing and stops if tabs or pin
  state changed, even when the total stayed the same. Ordinary web pages receive
  a best-effort recovery record; internal pages and exact window state are not
  presented as fully undoable.
- After another window closes, keyboard focus returns to the next Open-window
  header, or the previous header when the closed window was last in the list.

## 0.8.279 - 2026-08-08

- Dashboard Search now ends in a slim permanent footer, so the floating results
  stay visually distinct from the tab rows underneath in light and dark schemes.
- The footer shows the number of results or recent tabs plus compact keyboard
  guidance. If browser History is not enabled, its existing invitation occupies
  the same row instead, so granting permission no longer removes the boundary.
- A tighter contact shadow strengthens the lower edge without recoloring Search,
  dimming the page, or changing result density and behavior.

## 0.8.278 - 2026-08-07

- Search results now read as one continuous command list: hover is a quiet
  neutral band, selection fills the complete row, and rounded inner row cards
  are gone in Dashboard, popup, side panel, and Minimal new tab.
- Result titles now lead a stable title, source, and outcome order. Switch,
  Open, Restore, Search web, and Open site remain visible as aligned text
  instead of competing with titles as filled pills.
- Empty-Search filters are now compact syntax-style targets with 28px hit areas,
  no resting fill or border, and consistent spacing. Adjacent label and view
  examples no longer touch.
- Applied Search scopes remain persistent removable tokens, but use the compact
  structural radius. The optional History grant is now a quiet utility line.

## 0.8.277 - 2026-08-07

- Search now exposes one coherent listbox only when result rows exist. Filter
  chips, recent-tab framing, empty states, and recovery actions keep their own
  correct button or status semantics, with polite result and no-match updates.
- Long Session or label scopes now truncate inside a bounded shared chip while
  the remove action and Search input remain visible. Long source metadata also
  truncates without clipping Session window and tab counts.
- Dashboard Search keeps a visible field-sized focus cue while results are open.
  Compact Search chips, retry actions, and empty states now share the same
  alignment and minimum target size in the popup, side panel, and new tab.
- Minimal new-tab navigation is now a quiet bottom footer. Its Search list is
  capped to the measured space above that footer, including short windows and
  browser zoom, so Dashboard and Settings remain clickable.
- Closing Search now cancels its pending debounce before clearing rows, so an
  outside click cannot let a queued query reopen the panel.

## 0.8.276 - 2026-08-07

- A local Search miss now offers one ordinary keyboard-accessible action to
  search with Chrome's configured default provider. URL-like input opens the
  site directly; one-character, partial-filter, and scoped searches stay inside
  EveryTab.
- Raw text entered after the `et` address-bar keyword gets the same fallback
  only after a successful empty EveryTab search. Current, foreground-tab, and
  background-tab dispositions are preserved, including cleanup if a background
  search cannot start.
- EveryTab now declares Chrome's `search` permission. It adds no host or page
  access and is used only after the person explicitly activates Search web.
- Fast Enter now waits for the current local results, and new typing immediately
  retires older actions. A provider failure keeps the query in place and offers
  Try again instead of disappearing silently.

## 0.8.275 - 2026-08-07

- Search now treats a saved Session as something you can restore, not only as
  a source of individual tab matches. Matching Sessions lead from two typed
  characters, show their window and tab counts, and keep their tab results
  underneath.
- A `session:` filter now leads with Restore for that Session and excludes
  automatic Snapshots. Restore rereads the current Session by id and reports
  if it was deleted after the results appeared.
- The `et` address-bar shortcut now completes real `in:`, `label:`, `session:`,
  and `view:` values from their first matching character. Up to four filter
  choices lead, ordinary results fill the remaining suggestions, and accepting
  a Session choice restores all of its saved windows.

## 0.8.274 - 2026-08-07

- Session counts in the left pane now align with every other sub-navigation
  count. Long names still ellipsize, and Restore keeps its own stable lane.
- Filter autocomplete no longer replaces matching Search results. Suggestions
  stay first, one labelled divider separates ordinary results, and arrows plus
  Enter move through both groups as one list.

## 0.8.273 - 2026-08-06

- Every focused Search now keeps the existing suggestion chips first and shows
  the six most recently used open tabs directly below them. The keyboard popup
  shortcut now changes focus only, so all Search surfaces share one state.
- One-character Search now returns up to eight high-confidence title-word
  matches from Open tabs and Starred, while saved collections, URLs, labels,
  and optional History stay out of this deliberately quiet first pass.
- Search filter keywords now autocomplete from their first letter. Choosing
  `in:`, `label:`, `session:`, or `view:` reveals its actual values; named
  sessions can be browsed through a `session:` chip without mixing in Snapshots.
- Settings keeps its filter and live jump chips together in a measured sticky
  strip on both the dashboard and standalone page. Filtering also removes jump
  chips whose groups are hidden.
- The long-session-name fix now constrains the complete sidebar sizing chain,
  so an unbroken name cannot push its count or Restore action out of view.

## 0.8.272 - 2026-08-06

- The Chrome-wide Search shortcut now opens the popup with Search focused and
  the six most recently used open tabs ready to switch to.
- A normal toolbar click still opens the action-first popup without covering its
  controls with Search results.
- Recent tabs work across normal windows, exclude the tab already underneath the
  popup and incognito windows, and retain pinned, discarded, and suspended tabs.
- Older Chromium versions that cannot open a popup programmatically fall back to
  the dashboard with Search focused.

## 0.8.271 - 2026-08-06

- Settings: the first section now starts 24px below the navigation chips. Later
  section rules have 16px before them and 24px after them, so headings no longer
  look stuck to the separator.
- Sessions: very long names now stay on one ellipsized line in the left pane.
  Tab counts and Restore remain visible, and the full name is available from the
  native tooltip and accessible label.

## 0.8.270 - 2026-08-03

- Settings: more room above every group name, including the first, so each
  heading reads as the start of a section rather than another line in the list.

## 0.8.269 - 2026-08-03

- Labels: each tab row now has a Label action, so you can add another label to a
  tab from here. An existing name adds the tab to that label; a new name starts
  one. The duplicate Open action is gone: the tab's title already opens it.
- Reverted yesterday's change that kept a label alive after its last tab was
  removed. Labels come from the tabs that carry them, as before.
- Focus: "N sites guarded" stays readable when hovered, and clicking it now
  lands in the Blocked sites field instead of the search box.
- Settings: groups are separated by a heavier rule, so the page is easier to scan.

## 0.8.268 - 2026-08-03

- Settings: "Keep these tabs open" and "Never suspend these" now sit under their
  labels with the full width, instead of a squeezed box wrapping one word a line.
  Both descriptions now say what each list actually controls.
- Focus: "N sites guarded" in the status band is clickable and opens the Blocked
  sites settings.
- Labels: you can create a label from the Labels section before anything carries
  it. A label also survives losing its last tab, so it stays ready to reuse, and
  deleting it removes it for good.

## 0.8.267 - 2026-08-03

- **Fixed a way suspended tabs could be lost when the extension reloaded.** If
  Chrome left a suspended tab open but replaced its page with a blank new tab,
  recovery saw the tab still existed, decided nothing was wrong, and skipped it
  for good. Those tabs are now restored in place, in their own window and
  position. A tab you are actually reading is never touched.
- A tab is recorded for recovery before it is suspended rather than after, so a
  browser that stops the extension mid-suspend cannot leave a page unrecorded.

## 0.8.266 - 2026-08-03

- A folded card now says "folded" right after its name, so the state is obvious
  where you are already looking.
- Folding works in every section, not just Open tabs: Inbox, Sessions,
  Snapshots, Labels, Snoozed, Archive, Duplicates, and Smart views.

## 0.8.265 - 2026-08-03

- The favicons on a folded window are all the same size now, at the size a
  browser tab shows them. They were rendering at whatever size each site served.
- Folding a window no longer throws you down the page. The window you fold keeps
  its place, and if you were scrolled inside it, its header comes to the top.
- Hovering a window name tints the name instead of washing the whole header.

## 0.8.264 - 2026-08-03

- Fixed folding and selection in Open tabs. Clicking a window name folded
  nothing, row checkboxes did not update the window checkbox, and clicking a
  row's empty space no longer selected it: one error while drawing a folded
  window was stopping every redraw those actions rely on.

## 0.8.263 - 2026-08-03

- Windows fold by clicking their name area. There is no separate control: a
  folded window shows its tabs' favicons instead of its rows, so you can still
  see what is in it. Past eight tabs it says "N tabs, folded" instead.
- The current window now reads "(current window)" in accent colour, immediately
  right of the window name.

## 0.8.262 - 2026-08-03

- "This window" is now plain accent-coloured text beside the window name, with
  no pill or container around it.

## 0.8.261 - 2026-08-03

- Open tabs: the window you are in comes first and is marked "This window" in
  the accent colour, beside its name.
- A window saved as a session now shows that session's name instead of "Window
  N", so naming a window means saving it.
- Windows can be folded down to their header, by the new control or by clicking
  the name. Folded windows stay folded while you work.

## 0.8.260 - 2026-08-03

- Fixed the Activity Undo button, which was squeezed into a square and had its
  label cut off when action labels are set to icons only.
- Activity now shares the same left edge as search and every other collection,
  and its filters hold their place under the section name while rows scroll
  beneath, like the Labels and Sessions controls.

## 0.8.259 - 2026-08-03

- Starred: the favicon is now the visible drag handle, and the whole rail
  accepts the drop so the pointer stops flickering while you drag.
- Activity keeps 200 actions instead of 50.
- Activity's Undo button is always visible and always says "Undo", including in
  icons-only mode.
- Activity's explanation and its filters are now two calm lines with real space
  before the first day, and the filter is a proper segmented control.
- Inbox items moving to the Archive now announce themselves with the same
  notification, badge, and Undo button as auto-saved tabs.

## 0.8.258 - 2026-08-03

- Starred shortcuts show the normal pointer again. The grab hand is only on the
  row surface around the launcher.
- Labels: the "+N more" control now sits with the chips it opens, and looks like
  a control rather than another label.
- Activity is now day by day, in the same cards and rows as every other section,
  and each entry says whether you did it or EveryTab did.
- Auto-saving idle tabs and auto-archiving old Inbox items are recorded in
  Activity, and both can be undone. Auto-saving could not be undone before.
- Activity can be filtered to All, Automatic, or Yours.
- The auto-save notification now carries an Undo button.

## 0.8.257 - 2026-08-03

- Starred shortcuts are reordered by dragging them. A plain click still opens
  the site; press and move to reorder. The up and down buttons are gone, so the
  rail keeps its width for names.
- Fixed the reason those buttons did nothing: a control built with a false
  boolean attribute was being written as disabled="false", which HTML reads as
  disabled.

## 0.8.256 - 2026-08-03

- Needs you: "More stats" lost its arrow, which pointed straight at the Focus
  button, and now underlines when you hover it.
- Starred shortcuts can be reordered with up and down controls on each row.
- Snoozed: a single snoozed tab now heads its card with "Single tab" instead of
  repeating the page title above the row.
- Smart views now use the same cards and rows as every other section, with
  favicons, hover actions, Copy as markdown, and a jump from the sidebar.
- Sessions: the Snooze action on a session card has its icon and label back.

## 0.8.255 - 2026-08-03

- Focus moved out of the sidebar onto the top-right utility line, directly to
  the right of the Needs you counts, where it stays on every page and width.
- While a run is active the control is accented and reads End Focus. The status
  band no longer carries its own End button.
- A settings control sits beside it, so guarded sites and duration are one click
  away instead of a search through Settings.
- Ending a run now uses a stop glyph. The moon it used to show means snooze
  everywhere else in the app.

## 0.8.254 - 2026-08-03

- The label and session arrival highlight now shows on the first jump after
  opening a tab, not only on later ones. It was being applied to a card that a
  second render replaced a moment later.

## 0.8.253 - 2026-08-03

- Suspending a tab now keeps focus on its row. The refresh Chrome triggers a
  moment later no longer sends focus back to the top of the list.
- Undoing a label from Open tabs removes the chip from the row straight away.
- Toast messages no longer end in a stray "null".
- Jumping to a label or a session highlights the destination on the first jump
  after opening a tab, not only on later ones.
- A jumped-to session with several windows now lands on its first window instead
  of scrolling slightly past it.

## 0.8.252 - 2026-08-03

- After a row action such as Suspend, focus stays on that row instead of falling
  back to the top of the list. When the row goes away, focus lands on the row
  that took its place.
- The search box now offers the two labels you applied most recently as
  examples, rather than the two with the most tabs.
- Labeling from Open tabs is now undoable and shows the Undo chip.
- Jumping to a label or a session highlights the whole card, including its
  header.
- Round checkboxes centre their check and dash exactly like square ones.

## 0.8.251 - 2026-08-03

- Entering a list from the search box now lands on the window header checkbox
  again, instead of skipping straight to the first tab.
- Any arrow key, up, down, left, or right, now enters the list at its first
  checkbox from anywhere on the page. Menus, palettes, dialogs, and text fields
  keep their own arrow behavior.
- Arrow Down from the last row wraps back to the first row.
- Tab from the browser address bar now lands on the search field. The old hidden
  "Skip to content" control is now "Skip to search" and forwards there
  automatically.

## 0.8.250 - 2026-08-03

- Arrow Up and Arrow Down now really move between rows when a row action button
  is focused. The destination row reveals its actions just before receiving
  focus, so the move lands instead of quietly staying put.

## 0.8.249 - 2026-08-03

- ArrowUp/ArrowDown now capture row navigation before action buttons can
  consume the event, so moving down from a focused button works reliably.
- Focused tab titles now use a flat accent wash and underline instead of the
  rounded generic focus capsule.

## 0.8.248 - 2026-08-03

- Row arrow navigation now follows the visible focus order: checkbox, tab
  title/URL, labels, then row actions. Pressing Enter on the focused title uses
  the normal open, switch, or restore behavior.
- ArrowUp/ArrowDown preserve the current lane when moving between rows, so a
  focused label or action stays at that level when the next row supports it.
- The keyboard shortcuts reference now documents Enter on a focused tab title.

## 0.8.247 - 2026-08-03

- Window 1 and Starred are aligned from the first frame. The empty inline
  keeper-panel slot is now removed from grid layout, so it cannot consume the
  list's 16px group gap before the first window and then scroll away.
- The production-CSS harness now includes the list's real bulk and keeper
  helper nodes, preventing future alignment checks from missing production-only
  grid spacing.

## 0.8.246 - 2026-08-03

- The first window header and Starred now share one physical lower edge with
  the opaque section line. The former two-pixel scrolling inset is gone, so the
  header neither corrects its position nor exposes passing row pixels.
- Sticky measurements preserve fractional CSS pixels instead of rounding them.
  Sessions and Labels therefore keep an exact seam between their expandable
  shortcut area, the first header, and Starred at scaled or zoomed layouts.

## 0.8.245 - 2026-08-03

- The resting first collection header, its sticky position, and Starred now
  share the same small content inset. Nothing jumps upward by two pixels when
  scrolling begins, and Starred is aligned from the first frame.
- Labels and Sessions replace hidden horizontal chip scrolling with a visible
  second line. Ten shortcuts are offered first, with a fixed +N more control
  that expands into a bounded wrapping list and changes to Show less.
- The compact index reserves the reduced Starred edge and now has complete
  min-width containment, so long label names cannot widen the collection.

## 0.8.244 - 2026-08-02

- Section identity is now a stable Canvas line: title and explanation share one
  compact row directly on the page while collection headers scroll beneath it.
- Starred follows the measured first collection-header axis, including the
  taller Sessions and Labels stack, so its reduced and expanded forms align.
- Sessions and Labels keep their filter, sort, and jump chips pinned in one
  compact strip. The redundant Jump to caption is gone, and long chip sets
  scroll horizontally instead of making the sticky stack grow.
- Save open windows now lives at the right of the Sessions section line rather
  than consuming a separate toolbar row.

## 0.8.243 - 2026-08-02

- Needs you now remains in the top-right utility position while scrolling. It
  still disappears when the viewport cannot hold the line.
- Left-pane expansion and reduction now use Starred's exact 180ms continuity
  timing and ease-out velocity across the pane edge, content, and crossfade.
- Search now has the same 20px breathing room below as above. The shared shelf,
  sticky window headers, and Starred edge tab all follow that one spacing token.

## 0.8.242 - 2026-08-02

- Rows can no longer appear in the breathing room between Search and a sticky
  window header. One shared page layer now covers that exact gap.
- Needs you has one responsive home at Search's right edge and disappears when
  there is not enough horizontal room instead of moving below Search.
- Starred now begins on the sticky-window axis as a flush-right edge tab. Its
  flat expanded rail still pushes wide rows smoothly without covering actions.

## 0.8.241 - 2026-08-02

- Search now aligns with the left edge of the working collection while keeping
  its focused 760px width and non-reflowing results overlay.
- Needs you uses the free space beside Search on wide dashboards and returns
  below it when that space is not available. It still withdraws on scroll.
- Collections use the available workspace width. Opening the flat Starred
  ledger now pushes wide rows inward; closing it gives that space back.
- Starred uses the same border-and-row rhythm as the collections with no
  floating shadow. Its 180ms transition commits layout once and animates the
  old and new workspace snapshots on the compositor.

## 0.8.240 - 2026-08-02

- Search suggestions now open over the page without moving the collection or
  its sticky window headers. This also removes the exposed window-row content
  caused by the former moving sticky offset.
- Needs you is centered beneath Search and still scrolls away normally.
- Focus no longer shows a navigation count. The same first navigation button
  now starts Focus when idle and ends it when active.
- Starred uses a filled star at the far-right edge. Wide dashboards reserve a
  stable gutter for its expanded rail while window rows retain their capped
  1080px working width.

## 0.8.239 - 2026-08-02

- Focus now replaces Home as the first navigation action and always shows its
  guarded-site count instead of ever displaying `null`.
- Search remains one centered sticky row, with no opaque shell below it, so tab
  text scrolls directly through the breathing room beneath the panel.
- Needs you is again a minimalist line below Search, but now scrolls away with
  the page instead of sticking.
- Starred opens from the top-right into a persistent overlay rail. Its reduced
  or expanded state survives page changes and reloads without narrowing tab
  rows or collections.
- Retired the three experimental page-utility layout choices after their
  installed comparison; existing stored preferences remain safe and ignored.

## 0.8.238 - 2026-08-02

- Search is one calm row again. Starred and Needs you no longer occupy permanent
  rows inside the sticky search panel.
- Appearance now offers three placements for those page shortcuts: a connected
  Shelf below Search, a Side rail on wide screens, or two Compact launchers in
  Search's upper-right corner. All three use the same data and actions.
- Focus now lives in the sidebar when inactive and returns to the sticky area
  only while a Focus session is active.
- Reduced unnecessary launcher refreshes and retained the fast structural sticky
  header fix from the previous build.

## 0.8.237 - 2026-08-01

- Restored complete rounded top borders on every grouped window header by
  removing the foreground corner mask that was erasing their curves.
- Sticky headers now use two tiny page-coloured patches behind the real cap,
  hiding scrolling rows and side edges through the corner cutouts without
  masking the border or adding a full-card repaint layer.

## 0.8.236 - 2026-08-01

- Replaced every card's large sticky-gap curtain with one shared 12px shelf
  owned by the command shell. It covers all rows and frame edges before the
  rounded header begins.
- Removed the repeated fixed-background layers from each grouped card, reducing
  repaint work while scrolling long collections.

## 0.8.235 - 2026-08-01

- Window cards now use two structural frames: the sticky header owns the full
  upper frame, and the rows/panels own the connected lower frame. The scrolling
  card itself has no border, outline, fill, or shadow, so no vertical line can
  bleed above a rounded sticky header.

## 0.8.234 - 2026-08-01

- Group headers keep a continuous top border in every card.
- While a header is sticky, the scrolling card's left and right borders are
  fully hidden above its rounded corners instead of continuing toward the top
  of the page.

## 0.8.233 - 2026-08-01

- Restored a clearly visible, real border around the sticky window header in
  both its resting and stuck states. The scrolling ledger frame is covered
  only behind the header and resumes with the rows.

## 0.8.232 - 2026-08-01

- Restored a complete frame around the sticky window header. The scrolling
  window frame is hidden behind it and resumes with the rows, so no straight
  line climbs past the rounded top.

## 0.8.231 - 2026-08-01

- Removed the last straight window-frame line beside a sticky rounded header.
  The frame now resumes only where the tab rows begin.

## 0.8.230 - 2026-08-01

- Rename and Remove now use the same neutral circular badge, border, colour,
  hover treatment, focus ring, and size.
- Theme-matched corner guards hide passing rows and window edges inside the
  sticky header's two rounded upper cutouts.

## 0.8.229 - 2026-08-01

- Window headers now round only their upper corners. Their lower edge stays
  square and connected to the rows, with no tab content showing through.
- The sticky gap now hides the window frame as well as the scrolling rows.
- Shortcut Rename now sits over the lower-right corner, opposite Remove in the
  upper-right corner.

## 0.8.228 - 2026-08-01

- Sticky window headers keep their rounded shape and sit with more room below
  the command box. Tabs passing underneath can no longer appear in that gap.
- Shortcut controls are less crowded: Rename stays at the end of the chip and
  the smaller remove control sits over its upper-right corner, without moving
  the chip or its neighbours.

## 0.8.227 - 2026-07-31

- Fixed the sticky window header, which was landing in the middle of the page
  instead of holding under the search box.
- Your shortcuts now sit centred in their row, in line with the rows above and
  below them.
- A shortcut's rename and remove controls now appear over the end of the chip
  instead of stretching it, so nothing shifts while you move across the row.

## 0.8.226 - 2026-07-31

- Window headers now stay in view. As you scroll a window's tabs pass under
  its header, and the next window pushes it out of the way, so the window's
  actions stay reachable and you always know which window you are in.
- The rows in the command box share one height and one left edge, so the
  field, your shortcuts, the attention line and the search suggestions all
  line up. The "Jump to" line is centred properly.
- Start focus uses a play symbol instead of the asterisk it was sharing with
  Suspend.
- Shortcuts no longer leave a permanent gap for their hover controls. The chip
  grows when you hover it, and the row reserves that space once rather than on
  every shortcut.

## 0.8.225 - 2026-07-31

- Content now slides under the search box and is simply gone. The soft band
  below the box is removed, so there is nothing between the box and your list.
- Search results now appear between the field and your shortcuts, instead of
  replacing them. Your shortcuts and the attention line stay where they are
  while you type.

## 0.8.224 - 2026-07-31

- Home is gone, and so is the row of collection tabs that sat above every
  list. The left pane is now the only navigation, and EveryTab opens straight
  onto your open tabs.
- Everything Home carried lives in the command box at the top, which is
  present on every page rather than just one. Old links to Home still work and
  land on Open tabs.
- Each collection shows its own name again, since the tab row that used to
  carry it is gone.

## 0.8.223 - 2026-07-31

- Renaming a shortcut works. Hover or focus one and a pencil appears next to
  the remove control. The previous double-click could never fire, because the
  first click already switched to the tab.
- The search results card now lines up exactly with the box above it.

## 0.8.222 - 2026-07-31

- You can rename a starred shortcut. Double-click it, or press F2 when it is
  focused, and edit the name in place. Enter saves, Escape cancels, and Undo
  restores the previous name.
- Removing a shortcut is now one click. Hover or focus a shortcut and an ×
  appears on it. The removal is undoable.
- Searching now extends the box instead of opening a separate panel below it.
  The field, the suggestions and the results read as one card, and your
  shortcuts come back as soon as you clear the search.

## 0.8.221 - 2026-07-31

- First step of the interface simplification. The search panel becomes a
  command box: search on top, your starred shortcuts under it, and a line at
  the bottom that names only what actually needs you right now.
- Starred shortcuts are one row of named chips you can launch from anywhere,
  including Settings. If they do not fit, a control reveals the rest in place.
- The bottom line lists duplicates, inbox and anything waking soon, and only
  when there is something to say. When there is nothing, the line disappears
  and your shortcuts use the space, so the box never changes height as you
  scroll.
- Start focus moved into the box, on the right of the shortcuts row.
- The old four-number stats line is gone. Three of those numbers already sit
  next to their sections in the left pane, and Stats has its own entry there.

## 0.8.220 - 2026-07-31

- Removed the faint second frame that appeared inside the search panel in light
  schemes.
- Rebalanced the search panel. The field and the counts under it now have
  proper breathing room and a sensible size relationship.
- Rows no longer get sliced in half at the bottom of the search area while you
  scroll. The edge fades instead, so content dissolves rather than leaving a
  band of cut-off text.

## 0.8.219 - 2026-07-31

- Fixed shadows in dark schemes. They were mixed from the text colour, which is
  near-white in a dark theme, so every raised surface was glowing instead of
  casting a shadow. This affected the left pane most visibly, and quietly
  affected cards, menus, and the selection bar too.
- The left pane's depth cue is now much fainter.
- The search area no longer reads as a band across the top of the page. It
  paints the same background the page does, so its lower edge is invisible and
  the search panel is the only thing that floats.
- Removed the line inside the search panel. The counts separate themselves by
  being smaller and quieter.
- In dark schemes the search panel now sits a step above the page, so it is
  clearly its own surface.

## 0.8.218 - 2026-07-31

- Search and the counts under it are now one floating panel, the same width as
  the lists below it, so scrolled content passes cleanly under a matching edge.
  The panel lifts when you focus it. The counts are plain text again, not
  chips, and results now drop below the whole panel.
- The left pane's depth cue moved inside its own edge, so the page reads as
  sitting above the pane rather than under it.

## 0.8.217 - 2026-07-31

- Selection bar: icons are now centred in their buttons when you use the
  Icons only preference. Buttons that only ever show a word keep their full
  width instead of being squeezed into a square.
- Left pane: the vault status, appearance controls, and Settings now stay at
  the bottom of the pane above a thin separator, however long your list of
  labels, views, and sessions gets. Only the navigation scrolls. The pane also
  casts a very soft shadow over the page for a little depth.
- Duplicates: the Refresh and Close all buttons are replaced by a proper
  header that says what was found, explains which copy is kept, and separates
  Rescan from the destructive sweep.
- Duplicates: the Close extras action no longer uses an icon that looked like
  copying.
- Duplicates: the kept copy now wears a solid accent Keep chip, and every row
  shows which window that copy is open in.
- Duplicates: the survivor rule is now written on the page. EveryTab keeps the
  copy you are using, then an awake copy, then the oldest, and it never closes
  a pinned tab.
- Search: the field is now a capsule that rests above the page and lifts when
  you focus it, and the counts beneath it read as small pills.

## 0.8.216 - 2026-07-31

- Fixed Duplicates, where the first duplicate group could stick to the bottom
  of the window instead of sitting in the list. Every group now sits in normal
  flow, and the selection bar in other sections still floats as before.
- "N more" and "Show fewer" are now full list rows. The whole row is
  clickable, it highlights like the rows around it, and it announces whether
  it is expanded.
- Hovering or keyboard-focusing a Starred shortcut or a What's happening
  pointer now fills the whole square cell, instead of drawing a smaller
  rounded patch inside it.
- Selecting several rows next to each other now reads as one continuous band.
  The lines between selected neighbours are gone, while the edges of the
  selection, the accent rail, and the checkmarks stay.

## 0.8.215 - 2026-07-30

- Starred shortcuts, What’s happening, collection rows, group headers, empty
  states, and the inactive Focus footer now use one consistent material
  hierarchy. Each saved bundle or live window is a separate rounded ledger.
- The approved two-line row design now covers Inbox, Snoozed, Sessions,
  Labels, Duplicates, Archive, and Snapshots. Sessions and Snapshots preserve
  their outer card and distinguish each saved window inside it. The compact
  side panel keeps its denser presentation.
- Duplicates now groups every copy of a page into rows, marks the copy that
  will be kept, shows each copy’s window and tab position, and lets you close
  one extra at a time. Individual and grouped cleanup remain undoable.
- Label and Session destination links now work reliably from both the left
  pane and their section indexes, including repeated jumps within the section
  and jumps made while a filter is active.

## 0.8.214 - 2026-07-30

- Daily navigation is predictable now. Left-pane links reset to the collection
  entrance, while the inline collection navigator swaps the list without
  moving the page. Short collections align the same way, and the selected
  inline tab uses a simple accent underline.
- Inactive Focus now lives at the bottom of What’s happening, beside a direct
  Settings link. All four live pointers remain visible. The global accent band
  remains reserved for an active Focus run.
- Dark Workbench rows, window headers, hover states, and supporting copy use a
  clearer scheme-derived contrast ladder across all 23 palettes. Light schemes
  and list geometry are unchanged.

## 0.8.213 - 2026-07-30

- The small Open tabs, Duplicates, Inbox, and Snoozed stats are back beneath
  Search on Home and daily collections.
- Starting Focus is now one compact control. The full-width Focus band appears
  only while Focus is running.
- Open windows now clip cleanly to one rounded outer shell. Dark schemes use a
  clearer border and brighter window and row materials, making the ledger
  distinct from the page background without changing light schemes.

## 0.8.212 - 2026-07-30

- **Open tabs now gives hover and selection unmistakable feedback.** Hover uses
  a clearer tint. Selected rows keep that tint, add a bold accent rail, and use
  a centered keeper-style checkmark. The new two-line row remains an Open-only
  pilot until it is approved for the other collections.
- Home now offers a quiet Focus ready strip below Search. It starts the existing
  site Focus with the user’s saved default, becomes the active timer in place,
  and links to the existing setup when no Focus sites exist.
- What’s happening now names Snoozed, Inbox, Duplicates, and Sessions in each
  pointer. The sticky collection navigator uses the same solid or gradient
  background as the page instead of a separate translucent slab.

## 0.8.211 - 2026-07-30

- **Home and the daily collections now use the clean production hierarchy from
  the approved mock.** The oversized Home card and its explanatory labels are
  gone. Starred and What’s happening sit directly on the page in connected,
  quieter ledgers, and the active collection names itself without a Workbench
  heading.
- The daily canvas and Search are wider. Open windows now form one softly
  bounded ledger with compact two-line rows: checkbox, favicon, title and
  source, labels, then stable actions.
- Appearance no longer offers Space, Divider, or Accent cap as competing window
  treatments. Existing stored values remain safe for compatibility but no
  longer change the interface.

## 0.8.210 - 2026-07-29

- **The Dashboard now opens on Home with one complete Workbench directly
  below it.** Home keeps global Search and the existing Focus strip close,
  adds a compact Starred launchpad and four useful “What’s happening”
  pointers, and removes the old repeated Overview stack and fold controls.
- Open, Inbox, Snoozed, Sessions, Labels, and Duplicates now share one sticky
  Workbench switcher. Only the active complete collection renders. The Open
  collection uses the approved clean, continuous window-and-row ledger with
  the existing selection checkboxes in the leading position.
- Any HTTP(S) tab in the popup or in Open, Inbox, Archive, Sessions, Snapshots,
  Labels, or Snoozed can now be Starred. Starred search and omnibox results switch to an
  exact live match when possible, otherwise open the URL. Star and Unstar are
  local-first, Vault-synced, included in JSON backup, and journaled for Undo.

## 0.8.209 - 2026-07-29

- **The dashboard left pane now resizes without scaling its icons or text.**
  A flat material edge carries the 180ms width change, the content pane
  translates into place, and the final navigation crossfades at its native
  size. Rapid reversals and reduced motion remain supported.
- Label and Session jumps now show their arrival cue after the destination's
  final render, including jumps from another section. Ring and Wash gains a
  small 4px settle and title emphasis to make the destination easier to locate
  without bringing back scroll travel.
- Labels Rename and Delete now have proper icons in Icons-only mode. The armed
  Delete/Cancel choice expands just long enough to keep both decisions readable.

## 0.8.208 - 2026-07-29

- **Anchored Label, Snooze, and Organize palettes now keep their source row or
  card visibly connected during keyboard use.** The palette has one consistent
  header, type scale, spacing system, control height, field layout, and primary
  action. Tab, arrow keys, Enter, and Escape continue the full workflow without
  requiring a mouse.
- Ring and Wash now draws a complete inset perimeter and wash, including the
  left and right edges inside clipped section containers.
- Manual left-pane collapse and expand now uses a compositor-driven geometry
  morph. The real dashboard layout changes once instead of recalculating a grid
  width every frame, and the settings write cannot cut the motion short.

## 0.8.207 - 2026-07-29

- **Label, Snooze, and Organize now open in an anchored palette above the
  list.** Rows stay exactly where they are, label suggestions stay above later
  tabs, outside click dismisses the palette, and Escape returns focus.
- Wide dashboard rows show action names by default. A new Appearance setting
  offers an icon-only look, while compact and narrow surfaces continue to use
  icons automatically. Suspend and Wake reserve the same width, so changing
  state no longer shifts neighboring actions.
- Label and session jumps now use a longer Ring and Wash cue that is easier to
  locate without delaying navigation. Reduced-motion users receive a brief
  static ring.
- The dashboard left pane now resizes fluidly when manually collapsed or
  expanded. Boot, responsive layout changes, data work, routing, and action
  completion remain immediate.

## 0.8.206 - 2026-07-28

- **Small, purposeful motion now connects important dashboard state changes.**
  Pointer-opened label, snooze, and organize controls settle into place without
  delaying focus or saving. Label and session jumps briefly identify their
  destination, and the selection dock appears with a short continuity cue.
- Collapsing or expanding the dashboard's left navigation still changes the
  layout immediately. Its contents settle for 140 ms and rapid repeat clicks
  continue from the current visual state.
- Buttons acknowledge pointer presses with a restrained one-pixel response.
  Keyboard actions remain instant, reduced-motion is respected, and no list,
  scroll, or layout property is animated.

## 0.8.205 - 2026-07-28

- The extension package now declares
  **EveryTab - Tab Manager for Clutter-Free Browsing**. Chrome will show this
  longer name when the version is installed or uploaded to the Store.
- Compact Chrome surfaces keep the shorter **EveryTab** name. The product name,
  tagline, features, permissions, and behavior are unchanged.

## 0.8.204 - 2026-07-28

- **EveryTab has its final pointed stack-and-keeper mark.** The selected teal
  source now appears at every Chrome icon size and in the Dashboard, onboarding,
  Focus, and suspended-page brand marks.
- The more generic flat archive-box alternative was not selected. The pointed
  silhouette remains recognizable at toolbar size and under the orange count
  badge while keeping the three-tab rhythm and calm teal palette.

## 0.8.203 - 2026-07-27

- **Saving a labeled copy no longer rewrites the entire Archive.** New copies
  and label recency now commit together in a small, atomic write, removing the
  multi-second whole-Archive persistence cost measured on a large real library.
- Archive views, search, export, import, undo, and Vault sync still see one
  complete Archive. Full Archive operations atomically fold pending copies into
  the existing base, so the faster path does not trade away data safety.

## 0.8.202 - 2026-07-27

- Label-save performance reports now identify time spent waiting for the
  exclusive data lock, reading stored maps, applying the in-memory mutation,
  and committing the atomic write. This is diagnostic-only; storage
  coordination and data behavior are unchanged.

## 0.8.201 - 2026-07-27

- **The label panel now closes at the successful save boundary.** It no longer
  waits for the Open list to rerender and eventually replace its DOM.
- While a label save is pending, the action shows “Saving…”, blocks duplicate
  confirmation, and remains retryable with a visible error if storage fails.
- Developer performance reports now separate label metadata preparation, the
  locked storage commit, and total confirmation time.

## 0.8.200 - 2026-07-27

- **Confirming labels now takes one storage transaction.** Saving one or many
  labeled Open-tab copies commits the Archive records and label recency
  together instead of rewriting the Archive once per tab and then writing
  recency separately.
- Archive label changes now refresh only the Labels, Archive, and library part
  of the sidebar. They no longer rebuild live-tab counts, duplicates, sessions,
  appearance, or Vault status.

## 0.8.199 - 2026-07-27

- **Labeling no longer refreshes unrelated hero statistics.** Archive-only
  label changes now update Archive, Labels, and navigation without re-querying
  and re-deduplicating every open tab for numbers that cannot have changed.
- Opening a label control starts its independent Inbox, Archive, Sessions, and
  label-recency reads together, improving cold suggestions on larger libraries.

## 0.8.198 - 2026-07-27

- **Hidden Open tabs stays warm again.** A missing session-binding import could
  interrupt tab and storage event handling after navigating away from Open.
  Background Open snapshots and the normal live refresh now continue without
  that console error.

## 0.8.197 - 2026-07-26

- **Search builds its world once per interaction.** Later keystrokes match the
  same in-memory snapshot instead of re-querying tabs and rebuilding every
  saved source. Any relevant storage, tab, or window change invalidates it
  before the next result can appear.
- Search begins after 90 ms instead of 150 ms. Scope suggestions, Smart views,
  labels, ranking, deduplication, optional History, and keyboard behavior are
  unchanged.
- **Large Open-tab profiles paint less DOM on Overview.** The first view shows
  up to 10 rows per window, with the existing expand control for the rest. The
  dedicated Open page still shows up to 20 per window.
- Empty search focus no longer competes with cold Open. Its data-backed
  suggestion chips warm at idle after the two immediate source chips appear.

## 0.8.196 - 2026-07-26

- **Open tabs now starts at the first line of New Tab startup.** The live-window
  query begins in the pre-CSS head script, while Chrome preloads the Dashboard
  module graph.
- **Collapsed Open stays warm.** Its data loads without building hidden DOM,
  and tab or relevant storage changes refresh that background snapshot so the
  first expansion does not begin a cold read.
- Settings and onboarding no longer load on the primary Open path. They load
  after Open paints or when the user asks for them.

## 0.8.195 - 2026-07-26

- **“Rotate on open” now prepares the next palette ahead of time.** New Tabs
  start with the reserved scheme, light/dark mode, and background instead of
  repainting from the previous palette after the page appears. The first New
  Tab after this update primes the reservation; later opens consume and replace
  it automatically.
- **Expanded Open tabs starts loading before the dashboard module finishes
  assembling.** Its live-window query can begin before Settings settles, and
  the saved snapshots overlap module evaluation.
- No loading animation was added. New Tab is a frequent action, so the fix
  removes lead time rather than making users watch it.

## 0.8.194 - 2026-07-26

- **Collapsed Overview sections show their names immediately.** Their headings
  no longer depend on hidden content being rendered, so a collapsed page never
  becomes a column of unlabeled arrows.
- **Collapsed Open tabs does no loading work.** It catches up when expanded,
  like every other lazy section.
- **Expanded Open tabs starts its independent data reads together.** Stale
  session-binding cleanup now waits for idle time instead of holding up the
  first rows.
- The remembered gradient is applied before first paint, and early appearance
  events cannot push sidebar/stat work ahead of the primary Open render.

## 0.8.193 - 2026-07-26

- **Open tabs gets the first turn on a cold dashboard.** The sidebar still
  appears immediately, but its counts, subnavigation, and Vault state no longer
  compete with the first Open-tabs render.
- **The selected section now highlights with the click.** It no longer waits
  for the sidebar's asynchronous counts and Vault reads.
- **Chrome tab moves appear sooner in EveryTab.** The old fixed 400 ms pause is
  gone: the first event refreshes on the next frame, with one short trailing
  pass to reconcile a burst.
- Related storage and tab events now share one prioritized frame scheduler, so
  repeated refresh requests are deduplicated and visible content settles before
  global counts or hidden sections.

## 0.8.192 - 2026-07-26

- **Repeated reads now stay in memory until that exact data changes.** Opening,
  counting, and refreshing the same saved lists no longer makes EveryTab ask
  Chrome for identical data over and over.
- Changes from the background worker, Vault sync, undo, and this page's own
  actions all clear the right cached keys at commit, so refreshed lists never
  trade correctness for speed.
- A representative refresh that asked storage for seven snapshots now asks for
  three, one per unique key.

## 0.8.191 - 2026-07-25

- **The dashboard stops building pages you are not looking at.** Every section
  used to render at startup and re-render on any change, even while hidden, so
  editing your Inbox rebuilt the Labels page while you were on Sessions. A
  hidden section now just notes that it is out of date and catches up the moment
  you open it. Opening the dashboard does a fraction of the work it used to.
- Sections keep what they last showed while hidden, so coming back to one never
  flashes empty.
- **The sidebar and the line under search count faster.** Those numbers were
  built by assembling and sorting the whole list first.

## 0.8.190 - 2026-07-25

- **Motion pass, and D4 is done.** EveryTab now has three kinds of movement and
  nothing else: instant feedback when you hover or press, a short reveal for
  menus and tooltips, and a slightly longer one for toasts. Everything is under
  200ms.
- **Folding a section is instant.** Nav groups, overview sections, and window
  blocks used to animate their height over a third of a second, which made the
  interface feel slower than it is.
- **The gradient background no longer drifts.** If you use the gradient
  atmosphere the orbs are still there, they just hold still. Perpetual movement
  on a page you open dozens of times a day is not restful.
- **Jumping to a settings group respects your reduced-motion setting.** It was
  the one place that scrolled smoothly regardless of what you had asked for.

## 0.8.189 - 2026-07-25

- **You can tell at a glance whether your vault is fine (D4-3c).** Connected,
  needs reconnect, error, and not configured each carry their own marker instead
  of three nearly identical pale pills. An error is no longer dressed as a
  warning.
- **A failed sync reads like a problem and tells you what to do.** It used to
  appear in the same muted grey as the explanatory text beneath it.
- **Imports say whether they worked.** Success and failure now differ by more
  than the wording.
- **Onboarding:** Next is the highlighted action on every page, not only the
  last one, and the progress dots announce which page you are on out of how many.

## 0.8.188 - 2026-07-25

- **Search looks and behaves the same everywhere (D4-3c).** The field, the
  result list, and the suggestion chips were four separate copies that had
  drifted apart; they are one thing now. The result list regained the border it
  had lost on the dashboard and the new tab page, so it reads as a panel
  floating over the page rather than bleeding into it.
- **Settings adapts to the space it has.** When the column gets narrow, each
  control moves below its label instead of being squeezed. Long vault paths wrap
  instead of running off the edge.
- **Checkboxes follow your color scheme** instead of showing Chrome's blue.
- The Settings heading lines up with the settings beneath it. It had been
  sitting on a different axis.

## 0.8.187 - 2026-07-25

- **The popup is redesigned (D4-3d).** It was nine bordered boxes stacked in two
  nested cards, every action shouting at the same volume. It is now a quiet
  command surface: flat sections separated by a hairline, and each action a row
  with its own icon, the way rows already work in the dashboard.
- **The tab you are acting on looks like a thing.** Favicon, title, site, and its
  labels sit together above the actions instead of floating on their own line.
- **One action is clearly the main one.** Save window to Inbox keeps the accent;
  Focus became a quiet status line with End beside it rather than a second big
  button competing for your eye.
- **Keyboard shortcuts, shown and real.** `i` saves to Inbox, `s` snoozes, `z`
  suspends or wakes, `l` labels, matching the dashboard exactly. The hint beside
  each action is the actual key, and it disappears when the action is
  unavailable.
- The popup is noticeably shorter, and the EveryTab title no longer takes a line
  to tell you which extension you just clicked.

## 0.8.186 - 2026-07-25

- **The popup and the Focus guard page now speak the product's design language
  (D4-3b).** Buttons, links, inline panels, and tooltips come from one shared
  place instead of each page inventing its own, so a primary action looks and
  behaves the same everywhere.
- **Save window to Inbox is unmistakably the main action.** It takes a full row
  and reads on one line; the popup is slightly wider so no action label wraps.
- **The popup footer is separated from the buttons above it.** Side panel,
  Dashboard, and Settings are quiet navigation, not three more actions
  competing with the ones that change your tabs.
- Confirmations like "Saved 12 tabs to Inbox" are now announced to screen
  readers, and "This tab" / "This window" / "Focus" are real headings you can
  navigate by.
- The Focus guard card has its intended elevation back, and its Focus settings
  link opens in a new tab with Cmd-click or middle-click like any other link.

## 0.8.185 - 2026-07-25

- **The collapse control now actually disappears** when the window is narrow
  enough that navigation collapses on its own. It was still on screen offering a
  choice that could not change anything.
- **The icon rail keeps its groups.** Overview through Snapshots, Library, and
  More are separated by a hairline instead of running together as one column of
  fifteen icons.

## 0.8.184 - 2026-07-25

- **Skip to content.** Tab once from the top of the dashboard and you can jump
  straight past the sidebar to the page itself.
- The fold arrows beside Sessions, Labels, and Smart views are easier to hit.
- Scrolling the narrow header navigation sideways no longer triggers the
  browser's back gesture.

## 0.8.183 - 2026-07-25

- **The Dashboard now adapts to the window instead of assuming a wide one (D4-3a).**
  The sidebar is slimmer and can be collapsed to an icon rail from a control beside the
  EveryTab mark; your choice is remembered. Narrow windows switch to the rail on their
  own, and very narrow windows (including 200% zoom) move section navigation into a
  header strip above the list so the content column keeps the full width. Collapsed
  navigation keeps every name, count, and tooltip.
- **The sticky search area is opaque.** Rows scrolling underneath no longer show
  through it or collide with it.
- **Active Focus is a full-width band below the compact stats line.** Search, then your
  daily counts, then Focus: the search glow and the Focus boundary no longer compete
  for the same space. The current section in the sidebar now reads clearly at a glance,
  and Muted emphasis softens both.
- The New Tab dashboard is the same page and behaves identically. Minimal and Blank new
  tabs are unchanged.

## 0.8.182 - 2026-07-25

- **The refreshed tab list is live in the Dashboard and side panel (D4-2b).**
  Ultra-compact square rows, aligned window headers, stable direct-action lanes, and
  the selection keeper dock now share one presentation across both surfaces. Open
  windows keep Inbox, Session, Copy, and Organize directly available, while the keeper
  offers Inbox, Label, Snooze, Suspend or Wake, Session, and Close with no bulk Move.
  Appearance now includes Bold or Muted emphasis, Round or Square checkboxes, Crisp or
  Soft corners, three row-information levels, and Space, Divider, or Accent-cap window
  grouping. All choices retain the current color scheme and update live.

## 0.8.181 - 2026-07-25

- **The design refresh now has a shared foundation (D4-2a).** EveryTab's main product
  surfaces share the first semantic control, field, chip, floating-panel, Focus, toast,
  and keyboard-focus primitives. The approved spacing, type, shape, motion, and density
  tokens are ready for the visible rollout. Broad `transition: all` rules are gone, and
  every extension page now declares its language. Layout, actions, data, and interaction
  behavior are unchanged in this foundation batch.

## 0.8.180 — 2026-07-23

- **Dashboard now respects the New Tab focus choice (N1).** Dashboard and Minimal both
  keep typing in Chrome's address bar when Address bar is selected, and both hand typing
  to EveryTab search when EveryTab search is selected. The New Tab page now mounts the
  same dashboard module and stylesheet as the regular Dashboard without redirecting or
  copying its behavior. Blank remains blank and leaves focus in the address bar.

## 0.8.179 — 2026-07-22

- **Search EveryTab from Chrome's address bar (F20).** Type `et`, press Space or Tab,
  then search open tabs, Inbox, Snoozed, Archive, Labels, Sessions, and already-granted
  history with the same scopes and ranking as universal search. Choosing an open result
  switches to its exact tab and window; saved results honor current-tab, foreground-tab,
  and background-tab opening. Suggestions are read-only, capped at ten, safely escaped,
  and stale searches cannot replace newer results. This adds no permission or install
  warning.

## 0.8.178 — 2026-07-22

- **Internal only: search actions now have one shared target path (F14/F20).** Universal
  search and Smart-view results use the same pure rule: a live tab switches to its exact
  tab and window; a saved or historical result opens its URL. Invalid result shapes do
  nothing rather than opening the wrong destination. This preserves current search
  behavior while providing the DOM-free seam needed by the upcoming `et` address-bar
  search.

## 0.8.177 — 2026-07-22

- **The side panel now remembers where you were (F14).** Each section is built only on
  first visit, then returns instantly from its local cache. Open tabs and saved-data
  changes refresh the visible section immediately while quietly marking hidden sections
  for a fresh read next time. Every section remembers its own scroll position, open
  inline panels are dismissed when you leave, and late refreshes cannot replace the
  section you switched to or move focus. Label-chip jumps still land directly on the
  requested label.

## 0.8.176 — 2026-07-22

- **Every side-panel section is live now (F14).** The final **Labels** tab renders your
  complete label list with the same Open, Remove label, Rename, Delete, Open all, and
  Copy actions as the dashboard. Its compact filter, sort, and jump controls fit the
  narrow panel, and clicking a label chip anywhere in the panel switches to Labels and
  lands on that card immediately. The list updates as labels change. The dashboard keeps
  the same Labels behavior through the new shared surface.

## 0.8.175 — 2026-07-22

- **The side panel's Sessions tab works now (F14).** Switch to **Sessions** in the panel
  and your saved sessions render live, with the same actions as the dashboard: restore all
  / a window / a tab, rename, label, remove a tab, snooze a session, per-session drag and
  new-window blocks, the "save all open windows" button, and bulk restore/label/copy/merge.
  It updates as sessions change. Only Labels is still a placeholder now; the toolbar button
  still opens the popup.

## 0.8.174 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork.** The Sessions
  section's render machinery (its data-gathering, the per-session drag/reorder plumbing,
  the "save all windows" toolbar, and the tab-selection bulk actions) moved, unchanged in
  behavior, into a shared `createSessionsSurface` in `js/ui/sessions-surface.js`
  (mirroring the Open and Inbox surfaces), so the dashboard and the coming side panel
  share one behavior source. The dashboard Sessions page renders and behaves exactly as
  before. No side-panel Sessions yet; the panel wires this next.

## 0.8.173 — 2026-07-22

- **The side panel's Snoozed list works now (F14).** Pick **Snoozed** from the panel's
  More menu and your snoozed tabs and sessions render live, with Wake, Reschedule, and
  Cancel, selection and bulk actions, and Undo, just like the dashboard. It refreshes as
  snoozes fire or change. Sessions and Labels are still placeholders.

## 0.8.172 — 2026-07-22

- **The side panel now shows your Inbox too (F14).** Switch to **Inbox** in the panel
  and it renders live, with the same actions as the dashboard: restore, label, snooze,
  archive, delete, save a window as a session, cross-bundle drag, bulk actions, and
  Undo. It refreshes as items arrive or are woken from snooze. Sessions, Labels, and
  Snoozed still show a placeholder; the toolbar button still opens the popup.

## 0.8.171 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork.** The Inbox
  section's render machinery (its data-gathering, the snooze/delete/save-to-session
  helpers, and the drag-between-bundles plumbing) moved, unchanged in behavior, into
  a shared `createInboxSurface` in `js/ui/inbox-surface.js` (mirroring the Open
  surface), so the dashboard and the coming side panel share one behavior source.
  The dashboard Inbox renders and behaves exactly as before. No side-panel Inbox
  yet; the panel wires this next.

## 0.8.170 — 2026-07-22

- **The side panel now shows your open tabs (F14).** Opening EveryTab's side panel
  renders the **Open tabs** section, live, with the same actions as the dashboard
  (switch, save, label, snooze, suspend/wake, close, save window, save as session,
  organize, copy), plus drag/keyboard move, selection and bulk actions, the active
  Focus strip, and Undo. It updates as you open and close tabs. Inbox, Sessions,
  Labels, and Snoozed still show a placeholder for now; the toolbar button keeps
  opening the popup. Open the panel from Chrome's side-panel picker, the popup footer,
  or the assigned shortcut.

## 0.8.169 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, compact CSS
  infrastructure.** `createTabList` gained an opt-in `presentation: "compact"` that
  sets `data-compact` on the list root (the default is unchanged, so the dashboard's
  markup is byte-for-byte identical), and `css/sidepanel.css` gained the compact list
  skin (cards, rows, chips, drag zones, inline panels), the shared Focus strip, and
  the toast, all from the existing role tokens. No side-panel list renders yet; this
  lays the styling so the next batch's panel render lands into ready CSS.

## 0.8.168 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 2b-2d.**
  The site-guard Focus strip (the "Focus is on" bar with the countdown, guarded-site
  count, and End focus) moved, unchanged in behavior, into a shared
  `createFocusStrip()` factory in `js/ui/focus-strip.js`, so the dashboard and the
  coming side panel share one strip. The dashboard strip shows/hides, counts down,
  ends, and announces exactly as before.

## 0.8.167 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 2b-2c.**
  The undo/notice toast (the corner "Undone… / Undo" and one-off alert messages) and its
  Ctrl/⌘+Z shortcut moved, unchanged in behavior, into a shared `createUndoToast()` +
  `bindUndoShortcut()` in `js/ui/toast.js`, so the dashboard and the coming side panel
  share one toast. Undo and notices behave exactly as before.

## 0.8.166 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 2b-2b.**
  The copy-as-markdown helpers (copy a session, label, bundle, or selection to the
  clipboard as a Markdown link list) moved, unchanged in behavior, into a shared
  `createCopyHelpers` factory in `js/ui/list-helpers.js`, so the dashboard and the coming
  side panel copy through one implementation. Copy behaves exactly as before.

## 0.8.165 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 2b-2a.**
  The small shared UI helpers used across list sections (the status marker, the inline
  validation flash, the two-step delete confirm, the inline label panel, the
  session-name combobox button, and the selection→links mapper) moved, unchanged in
  behavior, into a shared `js/ui/list-helpers.js` so both the dashboard and the coming
  side panel use one copy. The dashboard renders and behaves exactly as before.

## 0.8.164 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 2b-1.**
  The Open-tabs section's render logic and its inline panels (per-tab snooze, the F13
  Organize panel, the session-drift banner, the F10 idle nudge, the F18 group nudge,
  and the whole open-tabs drag machinery) moved, unchanged in behavior, into a shared
  `js/ui/open-surface.js` module, so the dashboard and the coming side panel build the
  Open section from one behavior source. The dashboard's Open tabs render and behave
  exactly as before. No panel change ships yet.

## 0.8.163 — 2026-07-22

- **New: EveryTab side panel (F14, first build).** EveryTab now registers a global
  Chrome side panel you can keep open beside the page you're working on. Open it from
  Chrome's side-panel picker, a new **Side panel** button in the toolbar popup's footer,
  or an assignable "Open the side panel" keyboard shortcut. The toolbar icon still opens
  the popup as before. This first build ships the panel shell: theme, global search, and
  the section switcher (Open / Inbox / Sessions / Labels / More). The in-panel section
  lists and the compact layout arrive in the next updates.

## 0.8.162 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 1e.**
  The Snoozed list configuration moved, unchanged in behavior, into the shared
  `js/ui/list-configs.js` module (the inline reschedule panel, subset wake/cancel,
  and the two snooze kinds went with it). This completes the extraction of all five
  list sections (Open, Inbox, Sessions, Labels, Snoozed) into one shared behavior
  source. The dashboard Snoozed page renders and behaves exactly as before. No panel
  ships yet.

## 0.8.161 — 2026-07-22

- **The Labels "recent" order is now precise (F21).** A label ranks by when you
  actually last used it, not by the most recent unrelated edit to a bundle it sits
  on. Before, labeling a different tab in the same bundle, snoozing, moving, or a
  vault sync could push an old label back to the top of "recent"; now only applying
  or renaming a label bumps it. Recency is tracked in a small `labelMeta` register
  that syncs across devices via the vault (per-key most-recent-wins). Existing labels
  keep today's order on upgrade and become precise the next time each one is used, so
  nothing reshuffles unexpectedly.

## 0.8.160 — 2026-07-22

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 1d.**
  The Labels list configuration moved, unchanged in behavior, into the shared
  `js/ui/list-configs.js` module. The Labels page keeps its own render loop
  (collect/sort, filter/sort index bar, and the instant single-card jump), and
  now builds its list from the shared `buildLabelsListConfig` factory, so the
  dashboard and the coming side panel share one behavior source. The Labels page
  renders and behaves exactly as before. No panel ships yet.

## 0.8.159 — 2026-07-21

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 1c.**
  The Sessions/Snapshots list configuration moved, unchanged in behavior, into the
  shared `js/ui/list-configs.js` module (the config body is byte-identical; the
  dashboard keeps a thin adapter). Sessions and Auto-snapshots render and behave
  exactly as before. No panel ships yet.

## 0.8.158 — 2026-07-21

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 1b.**
  The Inbox list configuration was moved, unchanged in behavior, into the shared
  `js/ui/list-configs.js` module (following the Open section in 1a), so the
  dashboard and the coming side panel share one behavior source. The dashboard
  Inbox renders and behaves exactly as before. No panel ships yet.

## 0.8.157 — 2026-07-21

- **Internal only (no user-facing change): F14 side-panel groundwork, batch 1a.**
  The Open-tabs list configuration was moved, unchanged in behavior, into a new
  shared module (`js/ui/list-configs.js`) so the dashboard and the coming side
  panel can share one behavior source instead of duplicating action logic. The
  dashboard renders and behaves exactly as before. No panel ships yet.

## 0.8.156 — 2026-07-21

- **Planning only: the side-panel mini-dashboard is fully specified (F14).**
  Locked mockup A becomes a worker-ready contract: Open tabs by default plus
  Inbox, Sessions, Labels, and Snoozed switching; global search; active Focus;
  the same list actions, drag, bulk, keyboard, journal, and Undo behavior under
  a compact 320-400 px presentation. The toolbar continues to open the popup.
  No runtime panel behavior ships in this version.

## 0.8.155 — 2026-07-21

- **Cleaner copy across the app.** Swept every user-facing string of em dashes
  (an "AI tell"), replacing them with plain punctuation, so messages, tooltips,
  and empty states read more naturally. A test now guards against em dashes
  sneaking back into UI copy, and the engineering guide records the rule.

## 0.8.154 — 2026-07-21

- **Keyboard shortcuts now cover every list, consistently (N28).** The same key
  means the same thing on any focused row or card: **r** restore/open, **l**
  label, **s** snooze, **c** copy, **d** delete, **x** select. Open-tabs rows
  gained **s** (snooze), **z** (suspend/wake), and **i** (Save → Inbox); every
  card's Restore-all and Delete now answer **r** and **d** (Delete/Backspace still
  work too). The **?** shortcuts reference (and Settings list) now describe these
  under "Any list" instead of just the Inbox, and include Copy. Full before/after
  map: `n28-shortcut-audit.md`.

## 0.8.153 — 2026-07-21

- **Popup labels are clickable.** The labels shown on a page in the popup now open
  the dashboard's Labels page, positioned right on that label's card.
- **Labeling an Inbox item no longer reorders it.** The Inbox is now ordered by
  when each item was saved (stable), so adding a label leaves the item where it
  is instead of jumping it to the top.
- **Cleaner single-tab cards.** A saved single tab no longer repeats its title in
  the card header; the header now reads **Single tab** (matching how a window card
  reads "Window · N tabs"), with the page title shown once, in the row.

## 0.8.152 — 2026-07-21

- **Popup label polish.** The "Labeled with …" confirmation now appears under the
  **This tab** section (where you labeled), not under This window.
- **Label suggestions are ordered by most-recently-used**, not alphabetically, so
  the labels you reach for most surface first as you type — everywhere the label
  box appears (popup and dashboard).

## 0.8.151 — 2026-07-21

- **Popup quick-label now keeps the tab open, and shows a page's labels.** Two
  refinements to F16: (1) **Label…** → **Save labeled copy** saves the labeled
  page to your Archive and leaves the tab open (same as the dashboard's Label
  action) instead of closing it. (2) The "This tab" section shows the labels the
  current page already carries — pulled from any saved copy of the same URL — as
  read-only chips under the title, and they update the moment you add a label.

## 0.8.150 — 2026-07-21

- **Label a tab straight from the popup (F16).** The "This tab" section gains a
  **Label…** button that opens a small inline panel: type or pick labels (your
  existing labels are suggested as you type), then save them without opening the
  dashboard. Type a label and press Enter twice to apply without the mouse. The
  panel never opens at the same time as Snooze or Sort. Works on normal and
  suspended tabs; disabled on pages Chrome won't let extensions touch.
  *(Superseded same day by 0.8.151, which keeps the tab open + shows labels.)*

## 0.8.149 — 2026-07-21

- **Copy as markdown is now in the popup too.** The "This window" section gains a
  **Copy as markdown** button that puts the current window's web pages on your
  clipboard as a `- [Title](URL)` list — the same as the dashboard, without
  opening it. Read-only; suspended tabs copy under their real page and incognito
  windows are excluded.

## 0.8.148 — 2026-07-21

- **Fixed: a suspended tab's favicon could leak into its URL.** Some third-party
  tab suspenders pack the page's favicon into their suspend URL as
  `…&icon=data:image/…`. EveryTab's URL unwrapper was grabbing that too, so the
  real page URL (and anything copied, searched, or saved from it) carried a huge
  base64 blob. It now stops at the real URL, and legitimate query strings are
  preserved. Applies to live tabs and anything saved from here on.
- **Fixed: a stray "null" after some toast messages** (e.g. "Copied 8 links null").
  Notices without an action button no longer render the extra text.

## 0.8.147 — 2026-07-21

- **Copy as markdown now works on open windows too.** Each Open-tabs window
  header gains the same **Copy as markdown** action as sessions and saved
  bundles, so you can grab a whole open window's web pages as a link list in one
  click (the bulk "Copy" over a selection was already there). The list only ever
  contains the page title and URL — never favicon data — and non-web tabs
  (chrome://, data: images) are skipped.

## 0.8.146 — 2026-07-21

- **Copy any list as a Markdown link list (F19).** A new **Copy as markdown**
  action on session, snapshot, label, Inbox, and Archive cards — plus a **Copy**
  button in every selection's bulk bar — puts a clean `- [Title](URL)` list on
  your clipboard. Multi-window sessions copy with a heading per window. Paste a
  reading list straight into a doc, chat, or issue. Read-only: nothing is changed
  or moved, and it needs no new permission.

## 0.8.145 — 2026-07-21

- **Label suggestions no longer look pre-selected while you type.** The first
  existing-label suggestion used to appear highlighted even though pressing Enter
  created the text you'd typed (a new label). Now nothing is highlighted until you
  arrow into the list, so Enter's behavior matches what you see: Enter creates the
  typed label; ↓ then Enter picks an existing one.

## 0.8.144 — 2026-07-21

- **Popup confirmations are now visible.** "Saving…", "Saved: …", Undo, and other
  action messages moved directly under the This tab / This window buttons instead of
  below the Focus section, where they were easy to miss.
- **Enter now confirms a session rename** in the popup (previously you had to click Save).

## 0.8.143 — 2026-07-21

- **Save as session in the popup now confirms and can't double-fire.** Clicking
  "Save as session" shows "Saving…" immediately and then the saved name; the button
  is disabled while the save is in flight, so a quick second click no longer creates
  a duplicate session (previously several rapid clicks quietly made several sessions).
- **Clearer wording** on the dashboard Sessions button: "Save all windows as session"
  is now "Save all open windows as session."

## 0.8.142 — 2026-07-21

- **Your Chrome tab groups now survive save and restore (F18).** Save a window or
  session and its tab groups (names, colors, collapsed state) come back when you
  restore it; snapshots keep them too. Turn it on in **Settings → Sessions →
  Preserve tab groups** (on by default). Reading group names and colors needs a
  one-time **tab-groups** permission, requested from that toggle or the in-app
  nudge — group membership is saved even without it. Session cards show read-only
  group chips, and a restore never fails because of groups: worst case the tabs
  come back ungrouped. The permission is **optional** (no new install warning);
  nothing else changed about your data or privacy.

## 0.8.141 — 2026-07-21

- **Organize panel opens right under the window header (F13 polish).** The
  **Organize ▾** (and **Label window**) panels on each Open-tabs window now appear
  directly below the header buttons instead of at the bottom of the tab list, so
  the choices sit next to the button you just clicked. No behavior or data
  changes — placement only.

## 0.8.140 — 2026-07-21

- **Organize your open tabs, one tidy at a time (F13).** Each Open-tabs window
  header gains an **Organize ▾** panel: sort the window by **Domain**, **Title**,
  or **Recent**, or pick a domain from **Gather a domain…** to pull all of its
  tabs (across every window) into a new window. The toolbar popup's This-window
  group gains a matching **Sort ▾** with the same three orders. Pinned tabs
  always stay put, and every organize action is a single best-effort Undo —
  nothing happens automatically, and tabs are only rearranged, never closed. No
  new permissions or data formats.

## 0.8.139 — 2026-07-20

- **Minimal new-tab navigation is always clickable on the first try.** The
  Dashboard and Settings actions now sit below a stable responsive clearance
  zone for the search field's “Jump to” suggestions, so the overlay no longer
  covers them when search starts focused. Search suggestions still appear
  without shifting the page. No permissions or data formats changed.

## 0.8.138 — 2026-07-20

- **The sidebar appearance controls are clearer and no longer crowded.** Light,
  Dark, and Scheme default now show themed hover/focus tips; Vault sync sits on
  its own row above the appearance controls; and the scheme picker opens directly
  above the palette button, stays within the viewport, and scrolls internally
  when space is tight. No scheme values, permissions, or data formats changed.

## 0.8.137 — 2026-07-20

- **Theme controls are easier to discover.** The sidebar's former light/dark
  toggle is now a compact, explicit three-choice control for Light, Dark, and
  Scheme default; System remains available in full Settings and its currently
  resolved appearance is represented truthfully in the sidebar. Rotation
  favorites now open expanded whenever Settings mounts, while remaining
  collapsible once a selection is made. No scheme values, permissions, or data
  formats changed.

## 0.8.136 — 2026-07-20

- **The color system now has 23 complete light/dark schemes and can rotate
  without repeats.** Ink, Ember, Phosphor, Tide, and Meadow join the picker;
  Cyberwave now owns violet + electric blue; Everforest becomes the warmer
  green-tea Matcha without breaking existing selections. Appearance adds
  **Scheme default**, which uses each palette in the light or dark mode it was
  designed around, alongside System and forced Light/Dark. Optional rotation
  runs on open, hourly, or daily and uses starred favorites when present.
  Meadow Light is cooler and sky-toned so it no longer blurs into Matcha.
  Accessibility checks now cover all 46 combinations, including the 3:1 status
  graphic and 4.5:1 status-text rules; older weak status dots were corrected.
  A generated product-state board makes active, focus, selection, chip,
  warning, danger, gradient, canonical-mode, and fixed-logo behavior visible.
  No permission or vault format changed. Smoke, vault, syntax, and contrast
  audits are green.

## 0.8.135 — 2026-07-20

- **The performance measurement harness is in place (E3-0) — no behavior changes.**
  A deterministic dataset generator can now seed the extension with typical, heavy,
  or pathological amounts of data through the normal Data-page import; a hidden,
  dev-only instrumentation layer (off unless explicitly activated) times boot,
  label jumps, search, section switches, the popup fill, and render fan-out; and a
  separate Node benchmark guards the pure compute paths with budget assertions.
  First baseline: pure compute is comfortably fast even on the heavy dataset — the
  remaining speed work is in storage round-trips and redundant rendering, exactly
  what the next performance batches target. Also verified along the way: only the
  Labels page renders uncapped (by design), and collapsed Overview sections still
  build their content at boot (the lazy-sections batch will fix that).

## 0.8.134 — 2026-07-20

- **Planning only: the performance plan (E3) is approved.** T2 stays the budget tier,
  instant jumps are confirmed (already enforced), lazy sections are accepted, and the
  budgets are adopted together with a new overriding principle: no perceived wait — the
  content under your eyes paints first, everything else fills invisibly behind it (now
  normative in ENGINEERING.md). A delta review reconciled the plan with everything
  shipped since it was written: the label-navigation fix batch is already done, and the
  completed storage-concurrency work unblocks the read-cache batch outright. The
  measurement-harness batch is worker-able now. No runtime change.

## 0.8.133 — 2026-07-20

- **The zero-data-loss storage work is complete — every write in the extension
  now goes through one coordination lock.** This closes the pre-public-beta
  data-safety gate (E2-0e, the final step). The last few writers that still
  wrote storage directly — the suspended-tab recovery registry, the tab-activity
  map, session↔window bindings, and the smart-views seed flag — now serialize on
  the same lock as everything else, so a background task and an open dashboard
  can't overwrite each other. Quick settings changed from the popup, onboarding,
  and the dashboard's theme/sort controls now save just the field you touched
  instead of rewriting the whole settings object, so two surfaces changing
  different settings at once can't clobber each other. And a test now fails the
  build if any future code introduces an uncoordinated storage write. No feature,
  data format, or permission changed. Smoke 860 ok / 0 FAIL, vault green.

## 0.8.132 — 2026-07-20

- **Vault sync can no longer drop a record you create while it's running, and two
  open dashboards can't sync over each other.** When EveryTab merges the vault
  folder into your local data, the read-merge-write step now happens under the
  same lock every other write uses: a tab you save mid-sync lands either before
  the merge reads or after it writes, never in the gap where the whole-map write
  used to erase it. And a full sync run now holds a second lock, so if a second
  dashboard tab kicks off a sync while one is already in progress, it quietly
  skips instead of running a redundant, riskier pass — the next scheduled sync
  picks up anything new. No vault file format, setting, or permission changed.
  Smoke 859 ok / 0 FAIL, vault green. This is the E2-0d step of the pre-beta
  data-safety work; the E2-0e sweep closes the gate. (Needs MH's live
  two-dashboard Chrome check.)

## 0.8.131 — 2026-07-20

- **Every snooze operation now commits atomically — and the E2-0c atomic-commit
  pass is COMPLETE (sub-batch 5 of 5: snooze.js).** A firing snooze commits its
  quiet Inbox delivery, the stats counter, and its own end (recurring reschedule
  or one-shot removal) in one storage write — a worker kill mid-fire can no
  longer deliver a tab without ending the snooze, or end it without delivering.
  Session snoozes, cancel (single and bulk), bulk wake, and the Inbox snooze exit
  (whose snooze records now ride the same commit as the splits and undo entry)
  all follow. Alarms are scheduled after each commit; a missed one is re-asserted
  by the existing startup sweep, and an orphaned one fires as a harmless no-op.
  With this, every multi-step mutation in the product — across archive, actions,
  labels, sessions, and snooze — is a single all-or-nothing storage commit
  carrying its undo entry. Smoke 859 ok / 0 FAIL, vault green. Next: E2-0d
  vault-sync serialization, then the E2-0e sweep closes the pre-beta gate.

## 0.8.130 — 2026-07-20

- **The final teal mark now uses MH's latest micro-adjusted source.** The revised
  body contour, check position, layer endpoints, and spacing replace the v0.8.128
  geometry without changing the four-color teal palette, normalized canvas, or any
  surrounding UI. The exact new source drives the regenerated transparent
  16/24/32/48/128 px Chrome assets and matching in-product vector. Smoke 858
  ok / 0 FAIL; vault green.

## 0.8.129 — 2026-07-20

- **Fix (from MH's live check): Open tabs bulk "→ Session" keeps window
  structure and is undoable.** Selecting tabs across several windows and saving
  them to a session used to flatten everything into a single session window and
  — on the "new session" path — created the session with no undo entry. The
  selection now becomes one session window per source browser window (both the
  new-session and add-to-existing branches), and the new session commits
  atomically with its "Created session" undo entry like every other creation
  path. Smoke 858 ok / 0 FAIL, vault green.

## 0.8.128 — 2026-07-20

- **The supplied teal stack/keeper mark is now the active EveryTab identity.** The
  exact user-provided paths and four opaque teal fills now appear in the Chrome
  16/24/32/48/128 px icon family and on in-product brand surfaces, replacing the
  temporary ET tile. The supplied red version remains archived as a comparison;
  teal was chosen for its calm/editorial character, reliable light/dark rendering,
  and separation from Chrome's orange count badge. No artwork was redrawn: only the
  source's oversized SVG canvas was tightened so the mark uses the available pixels.
  The old porcelain ET wrapper was removed from the sidebar so the symbol appears as
  itself. A deterministic generator and native-size/badged QA board preserve the
  install. Current full suite: 858 smoke checks and vault sync green.

## 0.8.127 — 2026-07-20

- **Every session operation now commits atomically (E2-0c, sub-batch 4 of 5:
  sessions.js).** Saving a session (selection, window, all windows), appending to
  one, renaming, removing a tab (including the rule-8 empty-session tombstone),
  the cross-session →Session merge, in-session drag, and drift "Update session"
  each land in one storage write together with their undo entry — and their
  guards (snapshot immutability, deleted/missing targets, the drag's
  "List changed — nothing moved" check) now run on fresh state under the store
  lock at the commit point. Auto-snapshots commit the snapshot, its
  change-detection signature, and old-snapshot pruning as one write, so a crash
  can never record the signature without the snapshot it describes. Smoke 856 ok
  / 0 FAIL, vault green. Remaining sub-batch: snooze.

## 0.8.126 — 2026-07-20

- **Every label operation now commits atomically (E2-0c, sub-batch 3 of 5:
  labels.js).** Labeling, unlabeling (item, tab, and session grains), label &
  archive, the tab-grain archive exit, rename-everywhere, delete-everywhere, and
  the legacy collections migration each land in one storage write together with
  their undo entry — a crash can no longer archive items without the entry that
  brings them back, rename a label in only some stores, or half-apply a
  label & archive split. Rename/delete-everywhere now read fresh under the store
  lock, so a record changed mid-operation is renamed from its current state, not
  a stale copy. Smoke 855 ok / 0 FAIL, vault green. Remaining sub-batches:
  sessions → snooze.

## 0.8.125 - 2026-07-20

- **Planning only: the supplied source now anchors a responsive logo system.** The
  16 px favicon stays exactly source-led. A display-mark comparison confirmed that
  adding cards, sheets, or indexed tabs inside the mark still makes it feel like a
  container full of objects. A second comparison therefore moves the cue outside
  the mark and tests the `Tab` suffix: pure control, stacked underline, stacked
  corners, and a selected-tab frame. **Stacked underline is the consultant lead:**
  two short offset rules suggest layers without changing the liked source or turning
  `Tab` into a button, badge, or browser diagram. Runtime ET remains unchanged.
  854 smoke checks and the vault suite are green.

## 0.8.124 — 2026-07-20

- **Every save, delete, restore, snooze-split, session-move, and drag-drop now
  commits atomically (E2-0c, sub-batch 2 of 5: actions.js).** Each of these
  operations — the Inbox item(s) it writes, the counter it bumps, and the undo
  entry that reverses it — lands in one storage write: a crash or worker kill can
  no longer save a tab without its Undo, delete tabs without the journal entry
  that revives them, or half-apply a move-to-session (the last torn "session
  merge" case). Drag-and-drop's "List changed — nothing moved" stale guard now
  checks at the true commit point under the store lock, so nothing can slip in
  between the check and the write. Restores open their tabs first and only then
  commit all splits + Undo together — a failed window open now leaves every item
  intact instead of split without a journal entry. The Focus guard's receipt-based
  save keeps its own (already atomic) machinery. Smoke 854 ok / 0 FAIL, vault
  green. Remaining sub-batches: labels → sessions → snooze.

## 0.8.123 — 2026-07-20

- **The Inbox-expiry move is now one atomic commit (E2-0c, sub-batch 1 of 5:
  archive.js).** Expired items' Archive copy, Inbox tombstone, and stats counter
  commit in a single storage write, derived from a fresh read under the store
  lock — a crash or worker kill mid-move can no longer leave an item visible in
  both stores (or half-moved), and an item you triage while the sweep runs is
  seen and kept. Characterization tests C-R2 and C-R5 part A flipped: every
  interleaving boundary now shows all-pre or all-post, never torn. `archiveSweep`
  (persist-before-close) and `restoreArchiveItem` were already single-commit and
  are unchanged. Smoke 852 ok / 0 FAIL, vault green. Next sub-batches: actions →
  labels → sessions → snooze.

## 0.8.122 - 2026-07-20

- **Planning correction: Pocket Stack is rejected.** MH's toolbar-size review found
  the angled overlapping tabs unreadable as a stack; they resembled a pile of rocks
  and were worse than the supplied source. A source-faithful correction locks the
  original body and check while testing only straight layers: offset cards, parallel
  sheets, and indexed tabs. The result is also conclusive: although they remove the
  rock reading, none adds enough tab meaning at 16 px to beat the source control.
  The source remains the visual lead; any explicit tab/stack cue moves to the larger
  lockup rather than the favicon. Runtime ET remains unchanged. 851 smoke checks and
  the vault suite are green.

## 0.8.121 - 2026-07-19

- **Planning only: the supplied pocket/check explorations become a restrained
  Pocket Stack direction.** Their strongest idea is not the shield or the source
  palette, but the gesture of something valuable being held. Four rebuilt vector
  variants now test that gesture with browser-tab shoulders: a faithful three-layer
  cleanup, two tabs without a check, two tabs with a check, and a checked Crest Tab
  derived from the second source. Every option is shown at native 16 px, beneath the
  real duplicate-count badge, and in light/dark extension clusters. **Pocket Stack
  is the consultant lead:** two tabs are enough, and removing the check avoids
  antivirus/task-complete semantics. Runtime ET remains unchanged pending review.

## 0.8.120 — 2026-07-19

- **Storage writes are now coordinated across contexts (E2-0b).** MH's live console
  probe confirmed Web Locks works across all extension contexts (§4.6 PASS), so
  every storage read-modify-write — record upserts/tombstones, settings, journal,
  counters — now goes through one exclusive cross-context lock (`"everytab-store"`)
  that auto-releases if a context dies. New `patchSettings` patches individual
  fields without the whole-object clobber, and `mutateStores` provides the atomic
  multi-key single-`set` commit seam the next batch (E2-0c) converts domain
  sequences to. Characterization tests C-R1, C-R4, and C-R5 part B flipped to
  assert the fixed behavior; torn multi-set sequences (C-R2/C-R5a) and vault-sync
  races (C-R3/C-R6) remain documented current behavior until E2-0c/E2-0d. Smoke
  851 ok / 0 FAIL (+6), vault green.

## 0.8.119 - 2026-07-19

- **Planning only: symbol-only toolbar study after the live ET context test.** The
  installed ET trial looked like a small file-type/acronym badge beside real Chrome
  extensions, and the duplicate-count badge obscured its T. Three Terracotta-field,
  porcelain-glyph alternatives now replace literal letter recognition with one strong
  silhouette: Stack, Keeper, and Convergence. Each is shown at actual 16 px, with the
  real lower-right `2` badge, and in light/dark extension clusters. Stack is the clear
  consultant lead; Keeper leans inbox/save and Convergence leans share/automation.
  The runtime icon remains ET until the comparison is reviewed. No product behavior
  or active icon changed. 845 smoke checks and the vault suite are green.

## 0.8.118 — 2026-07-19

- **Tests only: storage-concurrency characterization (E2-0a).** No behavior change.
  The test harness can now interleave two contexts' storage operations
  deterministically (new `test/e2-mocks.mjs`: pausable storage mock + mock
  LockManager with MV3 context-death auto-release), and six new C-R1…C-R6 test
  groups document the current concurrency loss mechanisms from
  `e2-0-storage-concurrency.md` §2.3 — lost record on overlapped inbox writes,
  torn two-set archive move (transient and context-death-persisted), vault-pull
  stale whole-map overwrite, settings clobber, and unserialized concurrent syncs —
  as passing documented-current-behavior tests that later E2-0 batches flip to
  assert the fixes. A report-only guardrail scan inventories every
  `chrome.storage.local.set` writer (0 unsanctioned today). Smoke 845 ok / 0 FAIL
  (+21), vault green.

## 0.8.117 — 2026-07-19

- **Planning only: the storage-concurrency design (E2-0) is approved.** MH accepted all
  four design calls — the Web Locks dependency, one global write lock, the narrow gate
  scope, and early landing of the additive batches interleaved with feature work. The
  characterization-test batch is worker-able immediately; the atomic-commit and vault
  coordination batches follow in order, and the final enforcement batch remains the
  hard pre-public-beta gate. The performance plan still awaits review. No runtime
  change.

## 0.8.116 — 2026-07-19

- **Label and session jumps are now one single motion.** Clicking a label chip (or a
  sidebar session) no longer shows the page first and then hops to the card a beat
  later: navigation now switches the page synchronously and anchors the card that is
  already on it in the same frame, so the first thing painted IS the final position.
  The list still refreshes quietly behind and re-anchors invisibly. 824 smoke checks
  and the vault suite are green.

## 0.8.115 - 2026-07-19

- **The tight Terracotta ET mark is live as a reversible extension trial.** Chrome now
  receives separately drawn 16, 24, 32, 48, and 128 px porcelain-tile icons rather
  than scaling one master. The compact sizes use pixel-hinted tight E/T geometry;
  the larger sizes use the same letters with optical breathing room. The sidebar,
  new-tab, Focus, onboarding, and suspend surfaces use the matching filled ET mark,
  and the fixed public accent is now Terracotta `#B84A32`. The retired wildcard
  generator and source assets remain intact as decision history. 821 smoke checks
  and the vault suite are green.

## 0.8.114 — 2026-07-19

- **Sessions page: the same navigation as Labels, and every jump is instant.** The
  Sessions page gains the Labels-style index bar — a filter box (narrows cards without
  losing your typing), an A–Z / Most tabs / Recent sort (persisted; Recent is the new
  default order), and clickable jump chips capped at 24 with "+N more". Under the hood
  both bars are now one shared component, so they stay identical by construction.
  Sidebar session jumps land instantly with the sticky-search offset (no more slow
  travel), and the last remaining animated jump (the Focus settings deep link) is
  instant too. 821 smoke checks and the vault suite are green.

## 0.8.113 - 2026-07-19

- **Planning only: Terracotta geometry and Chrome-context studies.** Wordmark A now
  compares the current ET ligature with tight, balanced, and open separate-letter
  constructions. Tabline compares the original narrow plateau with broader and softer
  selected-tab silhouettes. Native 16 px drawings show ET-only porcelain tiles beside
  both Tabline reductions, then place the strongest three in light and dark Chrome
  toolbar mockups. Initial call: balanced separate ET for Wordmark A, broad selected
  tab for the large Tabline, and the ET-only porcelain tile for the toolbar. Figma
  import is pending because the Starter-plan MCP quota is exhausted. No runtime icon,
  product token, or behavior changed.

## 0.8.112 — 2026-07-19

- **Labels page: three quick fixes (the P9 quick batch, also the first E3 performance
  fix).** Label chips on Labels-page rows are now clickable and navigate like chips in
  every other section. The "+N" / "–" label-chip expander on any row now expands in
  place instead of re-rendering the whole section, so the page no longer jumps and you
  keep your place (focus lands on the replacement toggle). And clicking a label from
  anywhere now lands instantly: the target card paints first and positioning no longer
  animates, so there is no load-then-travel feel. 809 smoke checks and the vault suite
  are green.

## 0.8.111 - 2026-07-19

- **Planning only: Wordmark A and Tabline ET now share one measured six-color
  comparison.** Ember remains the control; Terracotta, Red Clay, Teal, Turquoise,
  and Sunflower are applied to both exact silhouettes on porcelain and warm ink,
  including native 16 px checks. All six clear 3:1 as graphical objects on both
  fixed surfaces. The initial shortlist is Terracotta, Red Clay, and Teal. The
  editable boards were added beside the prior studies in Figma. No runtime icon or
  product token changed.

## 0.8.110 — 2026-07-19

- **Planning only: the restart now compares a colored Wordmark system with one final
  reference-based Tabline pass.** The browser-frame Tabline is rejected after strong
  male-organ and middle-finger readings. Its replacement follows the earlier shape that
  produced some tab recognition: one low selected tab on a long rail, with ET cut through
  the tab and a separately pixel-hinted 16 px drawing. The Wordmark study now applies the
  fixed Ember, warm-ink, porcelain, and edge palette across primary, reverse, campaign,
  and toolbar contexts. The extension icon remains unchanged pending fresh human testing.

## 0.8.109 — 2026-07-19

- **Planning only: the failed wildcard logo is retired and the identity restart has two
  developed comparison routes.** Unaided participants saw an emergency beacon rather
  than browser tabs, called the form clumsy, and read the asterisk as a snowflake. New
  monochrome boards now test a wordmark-derived ET ligature against a more literal
  Tabline/browser-frame mark at 16/24/32/80 px. The extension keeps the previous icon
  temporarily; no replacement ships until one restart route passes a fresh human test.

## 0.8.108 — 2026-07-18

- **Planning only: the two engineering gates are fully designed.**
  `e2-0-storage-concurrency.md` settles the pre-public-beta data-safety design — a
  cross-context write lock with atomic single-commit storage writes and serialized
  vault sync, after a code-verified characterization of the three ways today's
  storage layer could lose data under concurrency. `e3-performance-pass.md` sets
  the "blazing fast" performance budgets, the measurement harness, and the ordered
  fix batches (starting with the slow label-click navigation). Both documents
  await MH's review and answers before implementation ships. No runtime change.

## 0.8.105 - 2026-07-18

- **EveryTab's responsive Ember identity is now production-rendered and color-validated.**
  Toolbar icons use a simplified wildcard at 16, 24, and 32 px; extension management
  and store assets use the full browser-tab mark at 48 and 128 px. A four-way native-size
  comparison selected a cleaner porcelain tile with the original lively Ember over the
  browner dark-Ember alternative. Fixed identity tokens also align the sidebar and
  product marks across every scheme. Independent unaided silhouette recognition remains
  the final brand-validation gate.

## 0.8.107 — 2026-07-18

- **Planning only: D3 palettes designed and verified.** Final values for the five new
  schemes (Ink, Ember, Phosphor, Tide, Meadow), the Matcha rework (with the key rename
  and read alias), and the cyberwave violet+blue retune — 14 blocks, all checked
  programmatically against the contrast bar calibrated from the shipped Cream scheme,
  with paste-ready CSS, worker instructions, and a preview sheet. All scheme work is now
  worker-able. No runtime change.

## 0.8.106 — 2026-07-18

- **Planning only: F18 group-aware sessions spec settled (f18-group-sessions-spec.md).**
  Key finding: the tabGroups permission does show an install warning, so the design uses
  an optional permission requested on user gesture (the existing history-permission
  pattern) and the install surface stays unchanged. Group membership is captured
  permission-free; titles/colors/collapsed need the grant; restores recreate groups only
  when granted and never fail because of groups. Worker-able. No runtime change.

## 0.8.105 — 2026-07-18

- **Planning only: F17 gap review closed by MH.** Group-aware sessions (F18),
  copy-as-markdown (F19), and omnibox search (F20) are all approved pre-launch; the
  omnibox detail brief MH requested is in the report (keyword-based address-bar search
  over the existing engine, switch-to-tab first, read-only actions). The sync-recipes
  documentation gap is now tracked as L7. All rejections stand confirmed. No runtime
  change.

## 0.8.104 — 2026-07-18

- **Planning only: D3 fully settled.** "Meadow" confirmed as the cozy scheme's name, and
  the Matcha mechanics were revised after MH's pushback: since no beta exists yet, the
  scheme key renames fully from everforest to matcha, with a permanent one-line read
  alias covering the few technically-live installs. No open scheme decisions remain;
  worker batch 1 (rotation + favorites + cyberwave retune) is ready. No runtime change.

## 0.8.103 — 2026-07-18

- **Planning only: D3 schemes SETTLED by MH.** Five adds coming (Ink mono, Ember red,
  Phosphor terminal green, Tide teal, and a Ghibli-like cozy scheme proposed as
  "Meadow"), cyberwave retunes toward violet+blue, everforest retunes to green-tea
  "Matcha" (display rename only; stored key unchanged), and scheme rotation is settled
  (off / every open / hourly / daily, star-favorites pool, shuffle-bag). Rotation +
  cyberwave are worker-able now; the five palettes are frontier design before L5. No
  runtime change.

## 0.8.102 — 2026-07-18

- **Planning only: D2 logo SETTLED — V4 wildcard mark with the ember asterisk.** MH picked
  ember (loving sun and teal too), which spawned D2b: a proposed toolbar icon-accent
  setting (Ember / Sun / Teal) using chrome.action.setIcon — the store tile stays ember
  since manifest icons cannot change at runtime and one public mark serves recognition.
  Icon regeneration is now worker-able. No runtime change.

## 0.8.101 — 2026-07-18

- **Planning only: D2 logo geometry settled by MH (V4 accent asterisk).** A nine-hue
  accent exploration sheet was produced (ember, terracotta, sun, mustard, old gold, teal,
  slate blue, forest, graphite) on the settled geometry with light/dark bands and 24px
  toolbar rows; frontier recommends ember, with mustard and teal as runners-up. Per-size
  icon tuning is delegated to make-icons.py judgment. Only the color pick remains before
  the icon-regeneration batch. No runtime change.

## 0.8.100 — 2026-07-18

- **Planning only: F13 and F14 validated by MH; both brainstorm reports iterated to v2.**
  Open-tab organization is settled and worker-able (one window-header Organize panel with
  three sorts plus a gather-a-domain dropdown, popup sorts, journaled one-undo; tab-group
  creation parked with preservation proposed pre-launch as F18). The side panel identity
  expanded to a mini dashboard (one section at a time, feature parity via the shared list
  component); three mockups added for MH to pick from. Backlog queue re-drawn with an
  explicit awaiting-MH-review list. No runtime change.

## 0.8.99 — 2026-07-18

- **Planning only: F17 product gap review — all six P9 brainstorms complete.** One true
  gap found (proposed F18: group-aware sessions, saving/restoring Chrome tab groups
  through sessions), plus proposed copy-as-markdown (F19), omnibox search (F20), and a
  sync-recipes help section. Rejections and re-confirmed assumptions are recorded in
  `brainstorm-f17-product-gaps.md`. The six brainstorm reports now await MH's inline
  answers. No runtime change.

## 0.8.98 — 2026-07-18

- **Planning only: D3 scheme portfolio audit + rotation.** The purple corner is crowded
  (laser/cyberwave nearest duplicates; cyberwave retune recommended), three adds proposed
  (Ink mono, Ember red, Phosphor terminal green), and an opt-in scheme-rotation setting
  (every open / hourly / daily, all-or-favorites pool, shuffle-bag) is specced with
  additive settings only. Open questions await MH in `brainstorm-d3-schemes.md`. No
  runtime change.

## 0.8.97 — 2026-07-18

- **Planning only: L6 store-name descriptor.** Recommendation: rename the store-visible
  manifest name to "EveryTab - Tab Manager & Session Saver" (policy-safe, high search
  value, honors the settled launch title without the em dash) plus a clean "EveryTab"
  short_name. "All-in-One" stays out of the title. Open questions await MH in
  `brainstorm-l6-store-name.md`. No runtime change.

## 0.8.96 — 2026-07-18

- **Planning only: D2 logo re-brainstorm.** The wildcard mark stays as the concept; the
  weakness is the bare solid-ink execution, which disappears on dark toolbars. Five
  re-packaging variants were produced (`campaign-assets/d2-logo-variants.svg`), with the
  accent-asterisk-on-cream-tile direction recommended. MH decides by eyeballing the sheet
  (`brainstorm-d2-logo.md`). No runtime change.

## 0.8.95 — 2026-07-18

- **Planning only: F14 side-panel exploration.** The `sidePanel` permission carries no
  install warning and no data access, so the privacy story holds. Recommendation: build a
  search-first "triage rail" side panel pre-launch (this window's tabs + quick Save/Snooze/
  Label + Inbox head), keeping the toolbar popup unchanged. Open questions await MH in
  `brainstorm-f14-side-panel.md`. No runtime change.

## 0.8.94 — 2026-07-18

- **Planning only: F13 open-tab organization brainstorm.** Report recommends a per-window
  one-shot Sort (Domain / Title / Recent) with journaled one-undo and an optional "Gather
  this domain" action; auto-sort is permanently out; native tab-group creation is parked
  post-launch. Open questions await MH in `brainstorm-f13-open-tabs-organization.md`. No
  runtime change.

## 0.8.93 — 2026-07-18

- **Planning only: 2026-07-18 feedback triaged as backlog P9; launch resequenced to the end.**
  The CWS listing and closed beta now come after a maturity push: Labels-page fixes (clickable
  chips, no scroll jump, snappy label navigation), popup quick-label, a keyboard-shortcut
  coverage audit, six brainstorms (open-tab organization, side panel, logo re-brainstorm,
  store-name tagline, color-scheme portfolio + rotation, product gap review), and a full
  performance pass. No runtime change.

## 0.8.92 — 2026-07-17

- **Distraction-site Focus passed its final live Chrome re-check.** The persisted countdown,
  explicit blocked-site totals, initial close-without-saving action, last-tab dashboard safety,
  All-the-time return, and expired-access choice all behaved as intended. Focus V1 is now
  complete and user-verified, with no new permission or page-content access. EveryTab can move
  to launch preparation and the remaining pre-beta data-safety gate.

## 0.8.91 — 2026-07-17

- **The three Focus live-checkpoint corrections passed engineering review.** The visible pause
  countdown stays tied to its original unlock time across delayed ticks and rerenders, popup
  totals clearly identify blocked sites, and initial “Back to focus” closes without saving
  while preserving last-tab safety. The neighboring All-the-time and expired-access flows are
  unchanged. All 802 smoke checks and the vault suite remain green, with no new permission or
  storage key. A short live re-check is the remaining Focus gate.

## 0.8.90 — 2026-07-17

- **Focus's live-checkpoint corrections are ready for re-check.** A paused guard now shows
  “Continue in 15 seconds” down to the real unlock boundary without timer drift or repeated
  screen-reader announcements. The inactive popup explicitly labels its blocked-site totals.
  On an initial During Focus guard, “Back to focus” now closes that tab without saving, while
  preserving dashboard replacement for a last tab. All-the-time safe return and the expired
  Save-or-close choice are unchanged. No new permission, storage key, or page-content access.

## 0.8.89 — 2026-07-17

- **The live Focus checkpoint produced three small UX corrections.** The next bounded batch
  will show the real 15-second access countdown, identify the popup totals explicitly as
  blocked sites, and make the initial During Focus “Back to focus” action close that guarded
  tab without saving. The expired-access Save-or-close choice remains unchanged, and a last
  tab will still become the dashboard rather than closing its Chrome window. This planning
  build changes no runtime behavior or permission.

## 0.8.88 — 2026-07-17

- **Distraction-site Focus passed its final automated engineering review.** The exact-access
  retry, repairable Save to Inbox receipt, normal-window privacy gate, preserved Back context,
  equivalent-control keyboard focus, truthful failure handling, reload teardown protection,
  and expiry retry all match the settled contract. All 782 smoke checks and the vault suite
  remain green, syntax is clean, and the extension still adds no permission or page-content
  access. Focus now moves to its live Chrome checkpoint before launch preparation.

## 0.8.87 — 2026-07-17

- **Focus retries now finish exactly once and stay calmly recoverable.** Retrying a site reopen
  no longer adds the same access time twice, and an interrupted Save to Inbox converges to one
  item, one Stats increment, and one Undo entry. Guarding now uses Chrome's real normal-window
  information, so popup, developer-tools, and private windows stay outside Focus. Browser Back
  preserves the original pause or expired-access context. Live guard refreshes return keyboard
  focus to the equivalent action, and action failures remain on the guard with accurate saved,
  not-saved, or temporarily-unavailable feedback. Reload teardown and failed expiry redirects
  also retain enough state to recover. No new permission and no page-content access.

## 0.8.86 — 2026-07-17

- **The launch-hardening re-review found a final set of retry and keyboard-flow gaps.** The
  site-only Focus direction and privacy boundary remain unchanged, and all 759 smoke checks plus
  the vault suite pass. Before live Chrome testing, one bounded correction will ensure a failed
  site reopen cannot add access time twice, a partially completed Inbox save repairs all of its
  undo/counting effects, only real normal Chrome windows participate, Browser Back preserves the
  original guard context, and live refresh returns keyboard focus to the equivalent action. This
  review build changes no runtime behavior or permission.

## 0.8.85 — 2026-07-17

- **Distraction-site Focus is hardened for launch.** A round of fixes closes the edge cases
  found in review. Pressing Browser Back onto a blocked site now steps the guard back in
  instead of showing the site. If a guard action can't switch the tab (a rare navigation
  failure), it now leaves the guard in place with an honest "try again" message rather than
  getting stuck. Choosing "Save to Inbox and close" can no longer create a duplicate Inbox
  item if the close is retried. A blocked site's temporary access can no longer be cancelled
  early by an unrelated tab closing. Guard pages recover more reliably after an extension
  reload or a full browser restart, and are never re-created for a site you've unblocked or
  into a private window. The guard page now updates itself live when you change your Focus
  settings, end a run, or a site becomes unblocked, without stealing your keyboard focus. The
  popup now respects a custom default duration you set (for example 25 minutes) instead of
  always offering one hour, and its Start/End buttons ignore a double-click. The onboarding
  text now states both return choices clearly. No new permission, and the guard still reads
  no page content.

## 0.8.84 — 2026-07-17

- **Distraction-site Focus completed its first engineering review.** The permission-free,
  same-tab product direction is unchanged, and all 709 smoke checks plus the vault suite still
  pass. Before the live Chrome checkpoint, one launch-hardening batch will make Browser Back
  re-apply a guard, keep guard actions retryable after navigation failures, prevent duplicate
  Inbox saves, make restart recovery race-safe, refresh an open guard when its rule changes, and
  honor the saved duration in the popup. No runtime behavior changed in this review build.

## 0.8.83 — 2026-07-17

- **Distraction-site Focus is here: block the sites that pull you away, right in the same
  tab.** Add blocked sites in Focus settings, each scoped either During Focus (blocked only
  while a Focus run is on) or All the time (always blocked while EveryTab is running). Start a
  timed or open-ended run from the popup, and the dashboard shows one small "Focus is on" strip
  while it runs. When you open a blocked site, EveryTab steps in on that same tab with a calm
  guard page instead of the site. From there you can take 5, 10, 15, or 30 minutes on the site
  (immediately, or after a short 15-second pause if you turned that on), and the page tells you
  how long it has been open. When the time is up the site returns to the guard. Choosing to
  return opens a clear choice: close the tab without saving, or save the page to your Inbox and
  close. Nothing is ever saved or closed for you, and if a tab is the last one in its window it
  is replaced with your dashboard rather than closing the window. This is a private, same-tab
  guard: EveryTab reads no page content and adds no new permission. There is a new onboarding
  page explaining it all. Because it reacts to a site opening, a page may briefly begin loading
  before the guard steps in.

## 0.8.82 — 2026-07-17

- **The Workspace Focus retirement passed review, and distraction-site Focus is ready to
  build.** A fresh code inspection plus all 637 smoke checks and the vault suite confirm that
  the old window-hiding feature cannot start again and its compatibility path only restores
  windows left by an earlier version. The guard-page plan is now final: temporary access still
  offers 5, 10, 15, or 30 minutes, while Return to focus opens a clear choice to close without
  saving or save the destination to Inbox and close. Nothing is saved or closed automatically.
  The second and final Focus build is fully specified; permissions and runtime behavior are
  otherwise unchanged in this documentation-and-review build.

## 0.8.81 — 2026-07-17

- **Unreliable window and session Focus has been retired ahead of the distraction-guard
  rebuild.** The old "Workspace Focus" that minimized and restored other Chrome windows is
  gone: the popup Focus group, the Focus actions on Open tabs and Sessions, and the active
  status strip are all removed, and no action can start or hide windows anymore. Focus
  settings keep your durations, your blocked-site list, and the immediate-versus-15-second
  access choice; the two settings that only made sense for window hiding are no longer shown
  (your saved values are kept untouched). If an earlier build left a Focus run mid-flight, this
  build quietly brings those windows back the next time EveryTab starts, then forgets it. The
  distraction-site guarding itself is not built yet; that is the next step.

## 0.8.80 — 2026-07-17

- **Focus is being simplified to dependable distraction-site guarding.** Live macOS testing
  showed that hiding and restoring Chrome windows still felt slow and could leave an End action
  stuck, so window and session isolation will be removed before launch. The replacement keeps
  During Focus and All the time site rules, with optional 15-second friction and 5, 10, 15, or
  30 minutes of access. When access ends, a calm EveryTab page will preserve the destination,
  show how long access has been open, and offer a return to Focus or more time. A true overlay
  is not used because it would require access to website content. This build changes the
  specification and worker plan only; runtime behavior remains unchanged until the two bounded
  implementation batches land.

## 0.8.79 — 2026-07-17

- **Workspace Focus native-transition gate approved for live verification.** Frontier
  review confirmed that the final correction batch issues multi-window updates together,
  safely tracks and reverses a hide that the operating system applies late, presents an
  honest non-interactive ending state, and keeps one Hide action through live UI refreshes.
  All 946 smoke assertions and the vault suite pass, every touched script parses, and the
  Focus UI detector reports no issues. This build changes documentation and version only.
  Site blocking remains absent; the next step is the repeat native macOS checkpoint.

## 0.8.78 — 2026-07-17

- **Workspace Focus closes the last window-restore timing gaps (still no site blocking).**
  When Focus hides several windows, it now asks the operating system to move all of them at
  once instead of waiting for each one in turn, so nothing is held up behind a slow window.
  If a window is slow to hide and Focus has to correct course, it now watches the window
  settle for a moment before it considers the job done, so a hide that lands late can never
  leave a window stranded out of sight; if that check is interrupted, Focus finishes it on
  its own afterward. While Focus is bringing your windows back, it now clearly says "Ending
  focus…" and does not offer to hide windows again mid-restore. And the "Hide other windows
  again" button now stays a single reliable action even if the view refreshes while it is
  working, so one click never turns into two. No site is redirected and no new permission is
  added.

## 0.8.77 — 2026-07-17

- **Workspace Focus transition-safety review; one final bounded correction remains.**
  The automatic retry and session-switch rollback added in 0.8.76 are sound, and all
  919 smoke assertions plus the vault suite remain green. Review found that a pending
  hide can still be treated as safely cancelled after one visible-state check even if
  the earlier operating-system hide is still queued, and the dashboard can rebuild its
  pending Hide button with a fresh duplicate-action guard. An ending run can also still
  offer Hide again while it is bringing windows back. F8-2r7 is now specified to close
  those three transition boundaries and record the additive recovery shape in the
  canonical schema.
  Runtime behavior and permissions are unchanged in this documentation-only build; site
  blocking remains absent.

## 0.8.76 — 2026-07-17

- **Workspace Focus is now safe against slow and interrupted window moves (still no
  site blocking).** When Focus asks the operating system to hide a window, that move can
  take a moment or be interrupted. Focus now keeps a recovery record for a window whose
  hide has not confirmed yet, so a slow move can never leave a window hidden without Focus
  knowing about it, and ending Focus brings such a window safely back even if the hide
  lands late. "Hide other windows again" writes its record before it starts hiding, so a
  browser restart mid-action still recovers cleanly. If ending Focus cannot bring every
  window back right away, it now finishes the job on its own a few seconds later instead
  of waiting for you to click End again. Switching Focus from one saved session to another
  no longer risks leaving a stray window or a broken session link if the switch cannot
  finish. And the "Hide other windows again" button stays reachable by keyboard while it
  is working and lands your focus in the right place afterward, in both the popup and the
  dashboard. No site is redirected and no new permission is added.

## 0.8.75 — 2026-07-17

- **Workspace Focus native-convergence review; one safety pass remains.** All 878
  smoke assertions and the vault suite are green, and the new convergence layer fixes
  the original incomplete-restore path. Review found that a minimize request timing out
  can still be removed from the restore ledger before the operating system commits it,
  which could hide a window later without a recovery record. Incomplete automatic Ends
  also need a calm retry alarm, failed session-switch rollback must preserve surviving
  bindings, and pending Hide controls must keep keyboard focus connected. F8-2r6 is now
  a bounded correction batch. Runtime behavior and permissions are unchanged in this
  documentation-only build; site blocking remains absent.

## 0.8.74 — 2026-07-17

- **Workspace Focus now waits for windows to actually come back (still no site
  blocking).** Chrome tells the extension a window has been minimized or restored before
  the operating system has finished the move, so End Focus could clear its record while a
  window was still on its way back and leave it minimized. Focus now confirms each window
  has really returned before it considers End done; if one is still coming back it keeps
  the run and says so, and trying End again finishes the job. A window you re-open by hand
  during that moment is left where you put it, and one you close is simply let go. "Hide
  other windows again" now confirms the windows are hidden before it settles, so the
  button behaves the same in the popup and the dashboard and disappears after one
  successful click. An already-open dashboard now notices when you manually bring a hidden
  window back and offers to hide it again. On macOS, windows still animate one at a time
  and a full-screen window may leave and later recreate its own Space; that is normal
  macOS behavior, not an error. No site is redirected and no new permission is added.

## 0.8.73 — 2026-07-17

- **Workspace Focus native checkpoint recorded.** Live macOS testing confirmed that
  multi-window session Focus works and pre-minimized windows stay untouched, but found
  that some Focus-minimized windows can remain minimized after End. Chrome window-state
  requests may return before the native transition is committed, which also leaves the
  popup's repeat-Hide action one refresh behind. An already-open dashboard additionally
  misses native window changes that do not rewrite Focus state. F8-2r5 is now specified
  to confirm state transitions, retain the restore ledger until every hidden window is
  visible, and refresh both surfaces consistently. Site blocking remains blocked; no
  runtime behavior or permission changed in this documentation-only build.

## 0.8.72 — 2026-07-17

- **Workspace Focus automated gate accepted.** Frontier review confirmed that direct
  actions now settle on the exact returned run, degraded session survivors are reported
  honestly when they could not be rebound, and the final target check and minimize plan
  use one window snapshot. All 840 smoke assertions and the vault suite are green, with
  syntax checks and the UI-quality detector clean. This build changes documentation and
  version only. Site blocking remains absent and no permission changed. The remaining
  gate before that work starts is MH's live macOS minimize/restore check.

## 0.8.71 — 2026-07-17

- **Workspace Focus checkpoint closure (still no site blocking).** Three final
  reliability fixes to the window/session Focus build. Starting or switching Focus with
  the keyboard now lands your keyboard on the exact run the button started, so a quick
  second click on the same window or session can no longer steal focus back to the older
  one, and a late failure from a click you already replaced does nothing. When a session
  window has to be reopened and something goes wrong, EveryTab now reuses a recovered
  window that is still tied to its session and is honest when a leftover window is not,
  so you never get a duplicate. And the moment-before-hiding check that makes sure your
  chosen window is still open now reuses a single look at your open windows, so a window
  that closes in that instant can never cause the others to be minimized around a target
  that is already gone. No site is redirected and no new permission is added; the native
  macOS minimize/restore checkpoint remains the next verification step.

## 0.8.70 — 2026-07-17

- **Workspace Focus checkpoint re-review; closure pass specified.** All 819 smoke
  assertions and the vault suite remain green, and F8-2r3 fixes the original switch,
  rollback-focus, and early target-close cases. The invariant review found three
  narrower gaps before the native macOS checkpoint: direct actions still settle by
  target rather than the returned run identity, an unbound degraded session survivor
  is not distinguished from a reusable bound one, and candidate discovery performs
  another Chrome window query after the claimed final target check. F8-2r4 is now a
  bounded closure batch. Runtime behavior is otherwise unchanged; site blocking and
  new permissions remain absent.

## 0.8.69 — 2026-07-17

- **Workspace Focus reliability pass (still no site blocking).** Three final
  live-checkpoint fixes to the window/session Focus build. Switching Focus with the
  keyboard now reliably lands your keyboard on the new window or session's "Focused"
  status, even while the lists are mid-refresh, and a start that fails keeps your
  focus on the button (or a sensible nearby control) instead of dropping it. If a
  saved session cannot reopen, EveryTab now returns your focus to the window you were
  on, and a reopened window it could not clean up stays attached to its session so a
  later Focus reuses it instead of opening a duplicate. And if the window or session
  you are focusing closes in the split second before Focus starts, EveryTab stops
  cleanly rather than hiding your other windows with nothing left to focus. No tab is
  redirected and no new permission was added.

## 0.8.68 — 2026-07-17

- **Workspace Focus final review; live-checkpoint corrections specified.** All 784
  smoke assertions and the vault suite remain green, and the prior transaction,
  switch-state, lifecycle, and late-marker fixes are sound in isolation. The full
  interaction review found three remaining races before the native macOS checkpoint:
  an old run's ending refresh can discard the pending keyboard target of a local
  switch, a failed session restore can lose native window focus or detach an
  unremovable survivor from its session, and a target can close after preparation but
  before the new run is stored. F8-2r3 is now a bounded correction batch. Runtime
  behavior is otherwise unchanged; site blocking and new permissions remain absent.

## 0.8.67 — 2026-07-16

- **Workspace Focus reliability pass (still no site blocking).** Four deep
  correctness fixes to the window/session Focus build. Focusing a saved session that
  has to reopen its windows is now transactional: if a window opens but then fails to
  finish setting up, EveryTab cleans it up instead of leaving a stray window behind,
  and if it truly cannot be closed it is kept and used rather than lost. Switching
  Focus from one window or session to another is now one smooth change with no flicker
  of "Focus ended" in between. The dashboard's Focus status and keyboard focus now
  settle by which run is active rather than by timing, so starting Focus while the
  lists are refreshing still lands your keyboard on the right card, and moving your
  focus away yourself is respected. Background timer and window-close handling now
  hold their work to completion. No tab is redirected and no new permission was added.

## 0.8.66 — 2026-07-16

- **Workspace Focus re-review completed; one final correction batch specified.**
  The previous fixes and all 742 smoke assertions are green, but deeper review found
  four asynchronous cases the source-level tests missed: a session window can be
  created and then become untracked if its setup fails, target switching can briefly
  look like Focus ended, a queued dashboard rerender can still strand keyboard focus,
  and the timer event does not retain its full End transaction. F8-2r2 is now a
  bounded reliability and accessibility pass. Extension behavior is otherwise
  unchanged; site blocking and new permissions remain absent.

## 0.8.65 — 2026-07-16

- **Workspace Focus corrections (still no site blocking).** The window/session Focus
  build from the review is hardened. "Hide other windows again" now re-hides a window
  you manually brought back, and the status count reflects what is actually minimized
  right now. Focus survives an interrupted end, a browser restart, and a settings
  change without ever un-minimizing the wrong window or losing your run's end time.
  Starting Focus on a session that cannot be reopened no longer disturbs the run you
  already had. Every Focus button responds even if the background is briefly
  unavailable, showing "Focus is unavailable right now. Try again." rather than
  hanging. Starting Focus from a window header or session card keeps your keyboard
  place on that card's new "Focused" status, the active bar no longer repeats the
  countdown to screen readers, its text meets contrast in every theme, and pre-launch
  wording honestly says "N blocked sites set up" (blocking arrives in the next Focus
  build). Still no tab is redirected, and no new permission was added.

## 0.8.64 — 2026-07-16

- **Workspace Focus review completed; corrections specified.** Automated tests are
  green, but the first window/session build is not yet approved for the live macOS
  checkpoint. Review found that repeat Hide must re-hide a window you manually
  restored, the restore ledger and ending state need stronger interruption safety,
  startup and failed session switches need tighter recovery, and the new status UI
  needs focus, screen-reader, contrast, and honest pre-site-blocking copy corrections.
  The bounded F8-2r contract is ready for the worker. Extension behavior is otherwise
  unchanged; no site blocking or new permission was added.

## 0.8.63 — 2026-07-16

- **Workspace Focus is now real (window and session).** Start Focus on the current
  window from the toolbar popup, on any window from its header in Open tabs, or on a
  named session from its Sessions card. EveryTab minimizes your other normal Chrome
  windows and restores them, to exactly the state they were in (normal, maximized, or
  full screen), when Focus ends. Windows you open or un-minimize during a run stay
  visible; "Hide other windows again" re-hides the current clutter on demand. A run
  can last one hour, until a configured morning or day time, a custom time, or until
  you end it, and a global status strip in the dashboard header shows what you are
  focused on and how long is left. A window that was already minimized before you
  started is left alone, and incognito windows are never touched, read, or shown.
  Ending Focus does not steal your keyboard focus. This release adds no site blocking
  yet: the guarded-site count is shown, but no page is redirected. It also adds no new
  permissions.

## 0.8.62 — 2026-07-16

- **Focus settings verified; workspace Focus is ready to build.** The complete
  Focus settings foundation passed its automated review and live Chrome check,
  including light/dark presentation, two-tab synchronization, validation, and
  keyboard focus restoration. This release prepares the bounded next build:
  starting Focus on a window or named session, temporarily minimizing unrelated
  Chrome windows, and restoring them when Focus ends. No window behavior or site
  blocking runs yet.

## 0.8.61 — 2026-07-16

- **Focus settings polish (still nothing runs).** Final correctness pass on the
  Focus settings foundation. Removing a blocked site with the keyboard now keeps your
  place: focus moves to the next site's Remove button, or the previous one, or back to
  the add box when the list is empty, and it never jumps around when a removal did not
  come from the keyboard. If a site was removed in another open tab, acting on its
  now-stale row does nothing and the list quietly refreshes once you move focus away,
  instead of shifting under your cursor. An absurdly large Focus run length is rejected
  rather than accepted. No tab is redirected, hidden, or closed yet.

## 0.8.60 — 2026-07-16

- **Focus settings correctness pass (still nothing runs).** Hardening of the
  Focus settings foundation from review. The blocked-site list now tracks each rule
  by its domain, so changing a site's scope or removing it always affects the right
  site even if the list changed in another open tab, and acting on a site that was
  just removed elsewhere does nothing instead of touching a different site. Domain
  entry is stricter about clearly invalid addresses (names that start or end with a
  hyphen, over-long names). Focus run lengths below one minute are rejected. Behavior
  in a live browser is unchanged from your point of view; no tab is redirected,
  hidden, or closed yet.

## 0.8.59 — 2026-07-16

- **Focus Mode settings arrive (nothing runs yet).** Settings gains a new **Focus**
  group: choose a default run length (one hour, until a morning or day time you set,
  open-ended, or a custom number of minutes), decide whether other windows are hidden
  when Focus starts, and build a list of blocked sites, each guarded either only
  during Focus or all the time. You also choose what happens when you open a blocked
  site (an immediate exception or a short pause) and what happens when temporary
  access ends (block again on your next visit, or save the matching tabs to your
  Inbox and close them, with a clear note that unsaved page content cannot be kept).
  This release only stores these preferences. No tab is redirected, no window is
  hidden, and no site is blocked yet. Those actions ship in the next Focus builds.

## 0.8.58 — 2026-07-16

- **Focus Mode is fully designed and ready to build.** The settled specification
  covers focusing a window or saved session, timed and open-ended runs, reversible
  window hiding, blocked sites during Focus or all the time, clear exception
  choices, safe save-before-close behavior, privacy boundaries, accessibility,
  recovery, and testing. Extension behavior is unchanged in this specification
  release.

## 0.8.57 — 2026-07-16

- **A maintainability contract for EveryTab.** The project now has a normative
  engineering guide covering architecture, readable JavaScript style, data and
  privacy invariants, accessibility, testing, safe refactoring, and file-size
  budgets. The accompanying audit turns the refactor program into small,
  risk-graded batches. Extension behavior is unchanged.

## 0.8.56 — 2026-07-15

- **Clearer wording: "Save to Inbox".** The action that closes a tab and keeps it
  in EveryTab is now called Save, not Dump, everywhere you see it: the popup and
  dashboard buttons ("Save tab → Inbox", "Save window → Inbox", "Save selected"),
  the right-click menu, the keyboard-command labels, notifications, the Inbox
  provenance ("saved" / "auto-saved"), the stats counters, and onboarding. The
  automatic version is now "Auto-save tabs to Inbox", and its never-touch list is
  "Keep these tabs open". Your existing data is untouched; this is wording only.

## 0.8.55 — 2026-07-14

- **Sidebar labels show recent first.** The Labels list in the left pane is now
  ordered by most recently used, matching the Labels page's default sort.

## 0.8.54 — 2026-07-14

- **Settings navigation polish.** Jumping to a section from the settings menu now
  lands below the sticky search bar instead of behind it, and the section headers
  stand out (accent-colored, with a divider between groups) so the groups are
  easy to tell apart.

## 0.8.53 — 2026-07-14

- **Incognito stays private.** EveryTab now ignores incognito windows entirely,
  even if you allow the extension in incognito: incognito tabs are never
  snapshotted, dumped, suspended, deduped, shown on the dashboard, or searched,
  so none of their URLs are ever written to your vault.
- **Find a setting fast.** Settings gained a filter box and a row of jump links
  to each group, so the page is quick to navigate as it grows.
- **New suspend controls in the tour.** The onboarding "quiet machinery" page now
  includes the "only over N tabs" and "keep at most N awake" settings alongside
  the sliders.

## 0.8.52 — 2026-07-14

- **Keep at most N tabs awake.** A new suspension setting caps how many tabs stay
  live: go over it and the longest-idle tabs get suspended to fit (your active
  tab, pinned tabs, and anything on your never-suspend list are always spared).
  It works even with time-based "Suspend after" set to Off, so you can use a pure
  tab limit if you prefer. 0 = no limit.

## 0.8.51 — 2026-07-14

- **Sections open at the top.** Switching to another section now starts at the
  top instead of wherever you had scrolled the previous one.
- **Suspend only when you have a lot of tabs.** A new setting, "Only suspend over
  N tabs", leaves everything live until you pass that many open tabs. When it
  does kick in, the longest-idle tabs go first (0 = always, the old behavior).
- **Smoother first load.** The dashboard now paints your open tabs first, so the
  page fills top-down instead of the Inbox landing first and getting pushed down.

## 0.8.50 — 2026-07-14

- **Range select can toggle off.** After selecting a range with shift+click (or
  x then shift+x), hitting the same end tab again clears that range.
- **Snooze by keyboard, end to end.** Pressing Enter on a row's Snooze button now
  drops focus into the panel that opens; use the arrows to pick a preset and
  Enter to set it, or Esc to step back to the row. Every inline panel works this
  way now.
- **Suspended tabs keep their icon.** A suspended tab shows the site's own
  favicon in the tab strip again (greyed where the browser allows), so you can
  still tell your tabs apart at a glance.

## 0.8.49 — 2026-07-14

- **Never-suspend list.** Settings now has a "Never suspend these" list (mirroring
  "Never dump these"): the automatic suspender leaves any matching tab alone.
- **Idle-window nudge.** Each Open-tabs window header quietly notes when tabs have
  gone untouched for over 4 hours, right next to "Dump window", so the heads-up
  and the fix sit together. No countdowns, no notifications.
- **More keyboard.** Press x then shift+x to select a range of tabs from the
  keyboard, and use the left/right arrows to step into a row's action buttons
  (right to enter, arrows to move between them, left or Esc to step back out).
- **A calmer suspended-tab page.** The suspended page now carries the EveryTab
  mark instead of a sleep emoji, and the tab title reads "... · suspended".

## 0.8.48 — 2026-07-14

- **Onboarding polish.** The welcome tour is calmer and clearer: it no longer
  runs actions on your real tabs mid-tour, the card is a fixed size so the Next
  button stays put, and the copy was tightened throughout (the Inbox page now
  talks about dumping rather than closing, since a plain close is not saved).
- **Set the quiet machinery right in the tour.** The machinery page now has the
  actual Suspend, Auto-dump, and Snapshot controls, so you can set them up
  without opening Settings.
- **Suggest smart views from history, any time.** The "Suggest from history"
  step moved out of the first-run tour and into the Smart views section as a
  button, so you can ask for suggestions whenever you like (and the history
  permission is only requested when you click it).

## 0.8.47 — 2026-07-14

- **A new welcome tour, one page per feature.** The intro is now ten short
  pages: the promise, the Inbox, sessions, snoozing, labels, finding anything,
  the quiet machinery (now including the auto-snapshot safety net), your new
  tab, the keyboard, and your vault. Each page can offer one opt-in "Try it"
  that acts on your real tabs and is always undoable, and every page stays
  reachable later as help from the "Learn more" links under each section.
- **Per-action keyboard shortcuts you control.** Three new commands, dump this
  tab, snooze this tab, and suspend this tab, are ready to bind. They ship with
  no default key, so nothing changes until you choose a key at
  chrome://extensions/shortcuts. Settings now lists every command with its
  current key (or "Not set") and a "Change in Chrome" button.
- **A blank new-tab option.** New Tab can now be nearly empty: just your color
  scheme and a faint mark, with no clock or search. The quietest new tab
  EveryTab can offer.

## 0.8.46 — 2026-07-13

- **Import defaults to labels.** The import destination now defaults to "File to
  Archive (find by label)", so pasting an export tags everything by folder/tag
  name without touching your Inbox or Sessions unless you choose otherwise.
- **"Recent" labels means recently used.** The Labels page's Recent sort now
  ranks by the most recently used label (the last time you applied it or touched
  a tab carrying it), instead of when the label first appeared.

## 0.8.45 — 2026-07-13

- **Import to just labels.** The import destination now offers a third choice —
  File to Archive (find by label) — alongside Inbox bundles and one session. So
  you can bring tabs in tagged by their folder/tag names without adding anything
  to your Inbox or Sessions, and browse them from the Labels page.

## 0.8.44 — 2026-07-13

- **Simpler import.** Importing from another tab tool now asks the big questions
  only: add the tabs to your Inbox or as one session, and whether to turn folder
  and tag names into labels. Instead of a long per-group checklist, you get a
  one-line summary of what's coming in, e.g. "134 links in 3 groups → 3 Inbox
  bundles; 45 labels will be created."

## 0.8.43 — 2026-07-13

- **Labels page: jump chips always land.** The label list no longer caps at 20
  cards, so clicking any jump chip goes straight to its label — even ones far
  down the list (previously they did nothing until you clicked "Show all").

## 0.8.42 — 2026-07-13

- **Labels page: filter and jump fixes.** The filter box now narrows the label
  cards too (not just the jump chips), so you see only what you're looking for.
  Clicking a jump chip lands the label's card just below the search bar instead
  of hidden behind it, and it now works reliably for labels far down the list.

## 0.8.41 — 2026-07-13

- **Navigate a big label list.** The Labels page now has a compact index bar:
  filter labels by name, sort them (A–Z, most tabs, or most recent), and click a
  chip to jump straight to that label's card. Handy after an import leaves you
  with dozens of labels. Sort defaults to most recent and is remembered; the
  filter narrows the jump chips only, so your cards stay put.

## 0.8.40 — 2026-07-13

- **Clearer Export / Import page.** The page now has three labelled areas —
  Export, Import from another tab tool, and Restore a backup — so the full-backup
  JSON restore is no longer mixed in with importing from OneTab and friends.
- **Import preview before you commit.** Once a paste or file is detected, you see
  what will be added — "Session Buddy · 3 groups", each group with its tab count
  and labels — and can untick any group you don't want. The summary updates live
  as you toggle groups or switch between Inbox bundles and one session.
- **File validation.** Choosing a file only accepts .json, .csv, .html, or .txt,
  with a clear message otherwise; the chosen file name is shown.

## 0.8.39 — 2026-07-13

- **Import from other tab tools.** The Export / Import page now imports OneTab,
  Session Buddy, Tab Session Manager, Toby, Raindrop (CSV), and browser bookmarks
  (HTML). Paste the export or choose a file — EveryTab auto-detects the format
  (you can override it) — then bring it in as Inbox bundles or as one session.
  Folder, collection, and tag names come across as labels on each tab, so
  everything is instantly searchable and filterable.
- **One-click Undo on import.** A whole import is a single Undo.

## 0.8.38 — 2026-07-13

- **Search suggestion chips highlight your stuff.** The example chips under an
  empty search box now lead with `in:open` and `in:snoozed` and offer your top
  smart views and top labels as one-click `view:` / `label:` chips. (Dropped the
  `in:inbox` / `in:archive` examples — you can still type them.) If you have no
  labels or smart views yet, those chips simply don't appear.

## 0.8.37 — 2026-07-13

- **Search matches every word, in any field.** Typing more than one word now
  finds pages where each word appears somewhere in the title, address, or a
  label — so "claude youtube" turns up a YouTube link you'd titled about Claude.
  Word order doesn't matter; a page must contain all of them.
- **Filter by label.** A new `label:` scope (alongside `in:` and `view:`) narrows
  search to tabs carrying that label; start typing `label:` and it suggests your
  existing labels. Typing `in:`, `view:`, or `label:` now opens a list of the
  valid choices you can arrow through and pick.
- **Scope chips you can browse.** With a scope chip active and nothing typed, the
  dropdown shows that scope's items so you can arrow through them. Esc now steps
  back one level at a time: clear your text, then drop the chip, then leave search.
  Suggestion chips lead with `in:open`.
- **↑ returns to search.** Pressing ↑ on the first row of a list puts you back in
  the search box — the mirror of ↓ stepping from search into the list.

## 0.8.36 — 2026-07-12

- **Escape leaves the label input.** First Esc closes the suggestion dropdown,
  the next closes the label panel itself — you're back to arrow-key navigation
  instead of being stuck until you apply labels. Works in the bulk-bar label
  fields too.
- **Escape and ↓ leave the search box.** The dashboard opens with search
  focused; Esc on an empty box now steps out to the page, and ↓ on an empty box
  jumps straight to the first row of the visible list.
- **Sidebar lists show "All … →" past their cap.** Labels and Smart views cap
  at 14 sub-items (sessions at 7); beyond that a tail link opens the full page.

## 0.8.35 — 2026-07-12

- **Arrow keys walk every row now.** ↓/↑ step through cards AND the tabs inside
  them in order (a card header steps into its rows), instead of jumping window
  to window.
- **? works mid-navigation, Esc steps out.** The shortcuts overlay opens even
  when a row checkbox has focus, and Esc anywhere in a list drops focus back to
  the page — the mirror of ↓ entering it.
- Removed the scope-chip Backspace line from the shortcuts reference — an
  implementation detail, not a shortcut anyone needs to learn.

## 0.8.34 — 2026-07-12

- **Sessions in the sidebar.** The Sessions nav entry expands (same twist as
  Labels) to show your 7 most recent named sessions — click one to jump to its
  card, or hover it and hit the small restore button to reopen the whole session
  right from the sidebar.
- **Arrow keys enter the list.** Pressing ↓ with nothing focused now steps into
  the first visible row (↑ enters from the bottom) instead of just scrolling
  the page.

## 0.8.33 — 2026-07-12

- **Move tabs without a mouse.** Every draggable row now has a ⠿ Move handle in
  its action set (visible on hover or keyboard focus). Press Enter on it to lift
  the tab, arrow up/down through the possible destinations — before any row,
  the end of any window or bundle, or a "new window/bundle" spot — then Enter to
  drop, Escape to cancel. Each step is announced to screen readers. Works in
  Open tabs, the Inbox, and Sessions, with exactly the same rules and undo as
  dragging. (Mouse users: clicking the handle lifts too — click again to drop.)

## 0.8.32 — 2026-07-12

- **Drag works inside sessions now.** Rearrange a saved session directly: drag a
  tab to reorder it within its window, onto another window's rows or header to
  move it there, or onto the dashed zone between windows to give it a window of
  its own. A window emptied by a move collapses. One Undo restores the exact
  previous arrangement. (Moving tabs *between* sessions stays with → Session;
  snapshots stay untouchable.)
- Same safety as the Inbox: if the session changed under you mid-drag, the drop
  is refused with "List changed — nothing moved".

## 0.8.31 — 2026-07-12

- **Drag works in the Inbox now.** Drag a tab onto another bundle (drops before
  the row you're over), onto a bundle's header (adds it at the end), within its
  own bundle to reorder, or onto the dashed zone between bundles to start a new
  bundle. Labels travel with the tab; a bundle emptied by a move disappears.
  One Undo restores both sides exactly.
- **Safe against surprises:** if the Inbox changed under you mid-drag (a sweep,
  a sync, another window), the drop is refused with "List changed — nothing
  moved" instead of overwriting the newer state.

## 0.8.30 — 2026-07-12

- **Dragging a tab to a new window no longer switches you to it.** The new window
  opens in the background; you stay on the dashboard and keep organizing.

## 0.8.29 — 2026-07-12

- **Fix: dragging works in every window again.** Revealing the new-window drop
  zones at the very start of a drag shifted the rows below them, and Chrome
  cancels a drag whose row moves at that instant — so only the first window's
  tabs were draggable in 0.8.28. The zones now appear a moment after the drag
  begins.

## 0.8.28 — 2026-07-11

- **Drag a tab out into its own window.** While dragging an Open-tabs row, dashed
  "Drop here to move to a new window" zones appear between windows — drop to
  split the tab out. (Dropping on a row or a window header still reorders/moves,
  as before.)
- **Drag moves are undoable now.** Every drag (reorder, cross-window, new-window)
  journals the tab's previous spot; Undo moves it back if the tab is still open —
  the entry says the undo is best-effort.
- **Keyboard and mouse focus no longer die after an action.** When the row you
  acted on disappears (restore, delete, archive, …), focus lands on the next row
  (or the previous one if it was last, or the section's controls if the list
  emptied) instead of falling off the page. This was the long-standing N1 bug.

## 0.8.27 — 2026-07-11

- **Snooze a whole session.** A session card can now schedule itself: pick a time
  (same presets as tab snooze, recurrence included) and the session's windows
  restore then. The session itself is never consumed — it stays exactly as saved.
  While scheduled, the card shows "snoozed until …" and the button becomes
  Cancel snooze; the Snoozed section shows it as a bundle named after the session
  (its rows always reflect the session's current tabs). Cancel from either side.
- **Remove a tab from a session.** Session rows have a × now — the tab leaves the
  session in place. Removing the last tab removes the session. Undoable, like
  everything else.
- **Cancelling a snooze is undoable now** (card Cancel and bulk Cancel both).

## 0.8.26 — 2026-07-11

- **Sessions have selection and bulk actions now.** Checkboxes on every session
  tab, per-window and per-card select-all, and a bulk bar: Restore (opens the
  picked tabs, one window per source window — the session itself is untouched),
  + Label, and → Session, which MOVES the picked tabs into another session (new
  or existing). A session emptied by a move is removed; one Undo restores
  everything, membership included.
- **Snoozed tabs can be picked individually.** Select tabs inside a snoozed
  window bundle and Wake now (they open and leave the snooze) or Cancel selected
  (they're dropped without opening). Picking only some tabs splits the snooze —
  the rest keeps its schedule. Both are undoable.
- Shift+click range selection and keyboard triage work in these sections like
  everywhere else.

## 0.8.25 — 2026-07-11

- **Enter applies labels.** In any label input, type a label, press Enter (it becomes
  a chip), press Enter again on the empty input and the labels apply — no more
  reaching for the small button. Works in the row/card Label panels and every
  bulk-bar label input.
- **Shift+click selects a range.** Click one row, shift+click another, and everything
  between them is selected — in every section with checkboxes.
- **Sections introduce themselves.** A one-line description under each section title
  (Inbox, Archive, Sessions, Labels, …) says what it's for. Turn it off in Settings →
  Appearance → "Section descriptions".
- **One checkbox size.** Row, window-header, and select-all checkboxes now all match
  (17px) — no more mixed sizes in a list.

## 0.8.24 — 2026-07-11

- **Label chips are links now.** Clicking any label chip — on a row, a card, or an
  open tab's saved-copy chips — jumps to the Labels page with that label's card in
  view, same as clicking it in the left sidebar. (The × still just removes.)
- **Selecting no longer nudges the list.** The bulk action bar reserves its space,
  so selecting a first row doesn't shift everything down when the buttons appear.

## 0.8.23 — 2026-07-11

- **Label chips show on every row now.** They were being clipped by long page titles
  (which is why only short-titled tabs seemed to have them). And open tabs finally
  show labels too: if a page you have open has a labeled saved copy, its labels appear
  on the row as read-only chips.
- **Every row can label.** Open tabs rows gain the same Label action as everywhere
  else — it saves a labeled copy to the Archive; the tab stays open.
- **Leaner rows, easier selection.** The tab's name is the action: clicking it
  switches/opens, so the redundant Switch/Restore buttons are gone from Open tabs and
  Sessions rows (keyboard "r" still works; Inbox/Archive keep Restore — there it moves
  the item out, which the name-click doesn't). Clicking anywhere on a row's empty
  space now toggles its selection, the checkbox is bigger, and the bulk action bar
  appears on selection in every section — Open tabs included.

## 0.8.22 — 2026-07-10

- **Hotfix for 0.8.21.** Labeling a tab no longer blanks the Inbox, Sessions, and
  Labels sections (a scoping bug crashed any list that tried to draw the new row
  chips — so chips never appeared either), and clicking a label in the left sidebar
  works again: it jumps to the Labels page and scrolls that label into view.

## 0.8.21 — 2026-07-10

- **Labels now live on tabs — and labeling never rearranges anything.** Labeling tabs
  in a window bundle tags exactly those tabs, in place: the bundle stays together (the
  old behavior split it apart, which read as "my tabs moved"). Each tab shows its own
  labels as small chips on its row (first two, "+N" shows the rest), removable right
  there.
- **Labels everywhere.** Every window card can label all its tabs at once — Open tabs,
  Inbox, Archive, and now Sessions too: label a whole session, one window, or a single
  tab inside it; the session card shows all labels its tabs carry. Search finds tabs by
  label, including inside sessions.
- **The Labels section grew up.** Same look and keyboard handling as every other list,
  plus two new powers: rename a label everywhere, and delete a label everywhere (the
  tabs stay, only the label goes). Every label change — including removing a chip — can
  now be undone.

## 0.8.20 — 2026-07-10

- **One way to name things — and sessions finally suggest themselves.** Saving a window
  as a session, sending a selection to a session, renaming, and "Save all windows" now
  all use the same inline control: type a new name or pick an existing session from the
  list that appears (so adding tabs to a session you already have is one click). The old
  pop-up naming dialog is gone. First step of the interaction-consistency work (P2g-1).

## 0.8.19 — 2026-07-10

- **New tagline: "Every tab, kept, organized, local."** Chosen by the user to replace
  "Every tab, kept. Nothing phoned home." — shorter and clearer for non-native readers.
  Swept through the manifest description and onboarding; the vault panel now ends
  simply: "Everything stays local."

## 0.8.18 — 2026-07-10

- **The dashboard now opens in place.** Sections no longer glide up from the bottom
  while the Overview loads — the first paint snaps into position, and the smooth
  expand/collapse animation returns once everything has settled.

## 0.8.17 — 2026-07-10

- **Onboarding speaks EveryTab now.** The intro leads with the brand promise — "Every
  tab, kept" — and the vault panel says the other half out loud: nothing phoned home,
  there's no telemetry to turn off.

## 0.8.16 — 2026-07-10

- **EveryTab has its mark: the wildcard.** A browser tab carrying the asterisk — the `*`
  that matches every(thing). New toolbar and store icons at every size (16/32/48/128,
  drawn per-size so the mark stays bold when tiny), and the sidebar/onboarding brand
  mark now match.

## 0.8.15 — 2026-07-10

- **TabVault is now EveryTab.** The product has its real name: EveryTab — "Every tab,
  kept. Nothing phoned home." Every user-facing string, the toolbar title, the settings
  and onboarding copy, and the extension name now say EveryTab. Your data is untouched:
  vault files, storage keys, and formats are exactly as before.

## 0.8.14 — 2026-07-10

- **Suspended tabs can now be selected in Open tabs.** Their checkbox was disabled; now they
  join bulk Label / Dump / Save-to-session / Close like any other tab (everything acts on the
  real underlying page).
- **"Auto-archive" is now called what it is: auto-dump.** Inbox and Archive items now say
  "auto-dumped" / "dumped" instead of showing the internal "auto-archive" tag — the idle sweep
  sends tabs to the *Inbox*, not the Archive, so the old wording claimed the wrong destination.
  Same rename in Settings ("Auto-dump", "Never dump these"), the sweep notification ("Tabs
  dumped to Inbox"), and the Stats page. Display-only: stored data is untouched.

## 0.8.13 — 2026-07-09

- **Open tabs now use the shared list too — every list in TabVault is one consistent component.**
  Same open-tabs powers as before: per-tab Switch / Dump / Snooze / Suspend-or-Wake / Close, tab
  selection with a bulk bar (Label · Dump · Save-to-session · Close), per-window Dump / Save as
  session, the "session drifted" notice, and drag-to-move tabs between windows. Selection now
  follows each tab by identity, so it survives tabs being reordered live. This completes the
  rebuild: Open tabs, Inbox, Archive, Sessions, Snapshots, and Snoozed all render the same way.

## 0.8.12 — 2026-07-09

- **The Inbox now shares the one list component too.** Same tab-level triage as before —
  per-tab Restore / Label / Snooze / Archive / Delete, window-bundle actions, tab selection with
  a bulk bar, the keyboard run-through (arrows + x/r/l/s/a/d) — rebuilt on the shared component so
  it stays pixel-consistent with Archive, Sessions, and Snoozed. Nothing you could do before was
  lost; the triage keyboard now works the same way across every list.

## 0.8.11 — 2026-07-09

- **Sessions, Snapshots, and Snoozed now match the Archive.** All three use the same list
  look: favicon rows grouped by window, with per-window "Restore window", per-session Restore
  all / Rename / Delete, and per-tab Restore. Snoozed window bundles are now proper cards
  (Wake now · Reschedule · Cancel) instead of a cramped expander. Snapshots stay read-only by
  design — no rename, no editing — because they're your crash-recovery safety net.

## 0.8.10 — 2026-07-09

- **The Archive is now a real, workable list.** Archived tabs show favicons and their site,
  and each one has its own Restore, Label, and Delete — plus checkboxes to select several and
  act on them all at once (restore, label, or delete the selection). Every action is undoable,
  and windows stay grouped. This is the first section rebuilt on a new shared list component, so
  the same look and behavior can roll out to every other list next.

## 0.8.9 — 2026-07-09

- **Suspended-tab recovery now survives the reload race.** 0.8.8's recovery could be defeated
  by timing: on a reload, the new extension sometimes boots while the old suspended tabs are
  still open — it saw them "alive", skipped them, and then their closures wiped the recovery
  registry. Now a ~30-second grace window after any install/update stops closures from purging
  the registry, and recovery re-runs several times (immediately, +2s, +8s, +30s) until the dust
  settles. A tab you close yourself within seconds of an update may reappear once — the
  trade-off errs on never losing tabs.

## 0.8.8 — 2026-07-09

Critical recovery + Inbox/session fixes (P0b: N4–N8):

- **Suspended tabs survive an extension reload.** Chrome closes any tab showing an extension page
  when the extension updates or reloads — which used to wipe out suspended tabs (the Great
  Suspender failure). TabVault now keeps a recovery registry and recreates the suspended tabs at
  startup, in their original windows and positions, with a "Recovered N suspended tabs" notice.
  A tab you deliberately close is never resurrected.
- **Labels from the Inbox now apply even if you don't press Enter.** Typing a label and clicking
  Apply works everywhere; an empty label gives a "Type a label first" hint instead of doing nothing.
- **"→ Session" from the Inbox now moves tabs** (they leave the Inbox, matching "Save as session"),
  preserves window structure, and confirms with an Undo.
- **Auto-snapshots read as "Snapshot", not "session", in search** — so the crash-recovery net isn't
  confused with your named workspaces.
- **Snapshots are now strictly read-only:** no rename, reorder, or editing; they can only be
  restored, copied out to the Archive with a label, or exported. Named sessions stay fully editable.

## 0.8.7 — 2026-07-09

Inbox triage v2 — sort every tab, fast (P2d):

- **The Inbox now works one tab at a time.** Every tab in a window bundle gets its own row with
  a favicon, and hover (or keyboard focus) reveals quick actions — Restore · Label · Snooze ·
  Archive · × — so you can send a single tab through any exit without disturbing its siblings.
  Acting on part of a bundle splits it: the chosen tabs leave, the rest stay, and an emptied
  item disappears. Everything is undoable.
- **Snooze from the Inbox**, at every level — a single tab, a whole window (reopens as a window
  when it wakes), or a hand-picked selection across items — using the same preset/custom/recurrence
  panel as the popup.
- **Window bundles gained header actions** (Restore all · Save as session · Snooze window ·
  Delete) and a real expand/collapse past 8 tabs; the bulk bar promotes Restore · Label · Archive ·
  Session · Snooze, and reads "N tabs selected (across M items)".
- **Full keyboard triage:** arrow to a tab row, then x select · r restore · l label · s snooze ·
  a archive · d delete (press twice to confirm). All listed in the ? shortcuts overlay.
- Onboarding's history scan now pre-checks only its top 5 suggestions.

## 0.8.6 — 2026-07-09

Onboarding polish (P4: O1–O3):

- **Smarter "scan my history" suggestions.** The onboarding smart-view scan now skips the noise
  — webmail message links, photo viewers, search-result pages, AI chats, and TabVault's own
  suspended-tab pages — and ranks sites by how many *different* pages you have on them (the
  "lots of tabs on one site" signal, like YouTube, Amazon, or GitHub), so it proposes a fuller,
  more useful set of views.
- **The onboarding color picker now shows each theme's name**, not just a color dot, and leads
  with a clear default: Cream in Light or Dark, one click each.
- **Clearer sync copy:** the vault step now says your data "syncs **across your devices** with
  no account and no server."

## 0.8.5 — 2026-07-09

- **Further new-tab flash reduction.** All pages now declare `color-scheme: dark light`
  statically, so the very first browser-drawn frame (before any script can run) follows the
  OS dark mode instead of defaulting to white. Note: the first tab opened right after an
  extension reload can still flash once (the theme cache is cold until a page has loaded);
  the fix shows from the second open.

## 0.8.4 — 2026-07-09

New-tab flash fix + slider settings (P2c: N2, N3):

- **No more white flash when opening a new tab.** A tiny script now runs before the page
  paints: it applies your saved theme (so even the first frame is your color, not white) and,
  in dashboard mode, jumps straight to the dashboard instead of flashing a blank new-tab page
  first. Every TabVault page (dashboard, popup, settings, suspend) opens themed from the very
  first frame.
- **Suspend and auto-dump timings are now sliders.** In both the popup's quick settings and the
  main Settings page, "Suspend after" and "Auto-dump after" are horizontal sliders with a live
  label; sliding to **Off** turns the feature off. Auto-dump now supports sub-day timings (1h,
  6h, 12h …) — not just whole days — and the background check runs every 15 minutes so short
  timings actually fire on time. Existing settings carry over automatically.

## 0.8.3 — 2026-07-09

Popup v2 — window snooze + a cleaner, calmer popup (P2b-1…4):

- **Snooze a whole window** from the popup's This-window group. All its saveable tabs are
  stored under one snooze (suspended tabs included, under their real URLs) and reopen together
  as a window when it wakes — or land as a single Inbox bundle if you wake quietly. The Snoozed
  list shows it as "Window (N tabs)" you can expand, and Undo brings the whole window straight
  back. Existing single-tab snoozes are untouched.
- **The two popup groups now read as one pattern.** This-tab and This-window sit in matching
  quiet cards with the same button order (Dump · Snooze… · Suspend / Suspend others, plus Save
  as session), so the popup is easier to scan.
- **Quick settings in the popup:** a discreet, collapsible row with two live-saved controls —
  "Suspend after" and "Auto-dump after" (each with an Off option) — plus an "All settings →" link.
- **The popup no longer grabs the search box on open,** so the action buttons are usable
  immediately; press "/" to jump into search when you want it.

## 0.8.2 — 2026-07-09

Search polish + new-tab and snooze features (batch 5: S5, F2–F4):

- **Search dropdown no longer nudges the page.** The results panel (and its scope-suggestion
  chips) is now an overlay, so focusing, typing, or clearing the box never shifts content
  around it. The suggestion chips paint instantly, reappear whenever the box is emptied, and
  a click anywhere outside the field dismisses the panel. A vanished smart view in a `view:`
  search now falls back to searching everywhere instead of coming up empty.
- **New-tab focus is yours to choose.** A setting picks whether a new tab leaves the cursor in
  Chrome's address bar (default) or jumps straight into TabVault search. In either mode,
  pressing Enter with nothing selected opens what you typed — as a URL if it looks like one,
  otherwise a web search.
- **Snooze can repeat on your schedule.** Alongside daily/weekly, snoozes can now recur on a
  specific weekday ("every Monday") or every 2–4 weeks, chosen right in the snooze picker.
- **Press ? for a keyboard-shortcut reference** — a themed overlay on the dashboard, mirrored
  in Settings, both generated from one list so they can't drift.

## 0.8.1 — 2026-07-09

The 2026-07-08 feedback pass, batches 1–4 (P0, carried-over polish, P2a popup rebuild,
P1 search workstream):

- **Popup rebuilt** around the popup-journeys spec: THIS TAB / THIS WINDOW groups with
  favicon+title, status strip (tab/window counts, Inbox and due-today deep links),
  disabled-with-reason instead of post-click failures, Undo on dump/snooze, Rename after
  session save, Suspend↔Wake swap, vault-sync warning row, duplicate-tab "switch to it?"
  hint (toggleable in Settings).
- **Suspended tabs are now first-class** (S1): sessions/snapshots no longer silently drop
  them (data-loss fix), dump/snooze/search/dedup/smart views all see the underlying URL,
  switch-to wakes them.
- **Search**: results dedupe across sources by normalized URL; scope operators
  (`in:inbox`, `view:…`) with a removable chip + suggestion chips; dropdown dismisses on
  outside click / Esc / activation and reopens on focus.
- **Polish**: settings page live-syncs with the quick theme picker; sidebar no longer
  shifts during vault sync; Overview no longer flashes when navigating; fast themed
  tooltips; per-window "show all" cap on open-tabs; last AA contrast stragglers fixed;
  semantic-pill parity on popup/newtab/options.

## 0.8.0 — 2026-07-08 (baseline)

M0–M6 feature-complete + the a11y/contrast/UX hardening pass (WCAG AA across all 36
scheme×mode combos, keyboard model, trust signals, perf gating). See
`status-ui-hardening.md`.
