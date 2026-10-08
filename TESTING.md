# Testing

[test-inventory.json](test-inventory.json) is the shared source of truth for the
local runner and CI. Every file under `extension/test/` and `tools/` has an
execution or exclusion decision, with a reason and owners for support files.
New, missing, duplicate or malformed entries fail inventory validation.

Run commands from the project root. CI uses Node.js 22; the latest local receipt
uses Node.js 26.4.0 on macOS arm64.

```sh
node tools/test.mjs --check-inventory
node tools/test.mjs --list --all
node tools/test.mjs --list
node tools/test.mjs
node tools/test.mjs search-domain-filter.mjs
node tools/test.mjs --list --lane browser
node tools/test.mjs --lane browser --ci
```

The default gate runs portable and performance suites supported on your platform,
checks runtime JavaScript syntax, and parses the manifest. A failed suite fails
the gate. Named runs use their declared working directory, environment, timeout
and Node flags, including `--expose-gc` for mature Search measurements. Unknown
IDs or flags fail instead of silently running a different selection.

| Lane | Local default | CI selection |
| --- | --- | --- |
| Portable | Yes | Linux, macOS and Windows; two POSIX tool tests excluded on Windows |
| Performance | Yes | Linux only, to keep timing budgets in one environment |
| Browser | Explicit | Declared disposable Chrome variants per platform |
| Package | Explicit authorization required | Manual workflow dispatch, opt-in only |

CI runs `--lane portable --ci`, `--lane performance --ci`, and
`--lane browser --ci` through the same runner. `--ci` applies the inventory's
CI platform restrictions; it does not contact a CI service. Browser runs need
Chrome for Testing (`CHROME_BIN` can select it) and permission to start local
fixture servers. Linux CI uses Xvfb for installed-extension checks.

The inventory classifies every maintained test and tool file. Its default macOS gate executes
251 suites (240 portable and 11 performance); the macOS browser lane executes
eight (six are CI-selected). These are execution counts, not a code coverage percentage. Imported smoke
helpers are covered by their owning suite rather than counted as separate runs.
Manual browser entries remain explicit qualification work. Inspect each tool's
setup and evidence output path before running it; some target historical folders
and must be adapted to a fresh output location first.

Packaging remains paused. Listing `--lane package --list` creates nothing.
Only after explicit release authorization may `--lane package --allow-packaging`
be used. The package artifact suite also requires an existing current candidate
and is excluded from CI. `--all` only works with `--list`; it never executes all
lanes. Never use personal browser data or Vault copies for fixtures.

When adding or moving a file, update the inventory classification and run
`--check-inventory`. The validator and CLI tests live in `tools/testing/`.

## Hosted runners

GitHub-hosted CI differs from a developer Mac in ways the suites handle explicitly:

- **Node 22.** CI uses Node 22, which has no `navigator.locks` (Node 24+ does).
  A portable suite that reaches a Store write installs `createMockLockManager()`
  from `extension/test/e2-mocks.mjs` on `globalThis.navigator`, including in
  child processes it spawns. Prove a change with the official Node 22 binary,
  for example `<node-v22>/bin/node tools/test.mjs --lane portable --ci`.
- **Line endings.** `.gitattributes` checks out LF everywhere. Hosted Windows
  defaults to `core.autocrlf=true`, and CRLF breaks source-text guards,
  eval-based fixtures and the codebase-guide freshness hashes.
- **Chrome stable.** `browser-actions/setup-chrome` installs the current Chrome
  for Testing stable build, which can be newer than the local `CHROME_BIN`.
  Every browser-lane launch passes `CHROME_FIXTURE_ARGS` from
  `extension/test/chrome-test-process.mjs`: `--use-mock-keychain` (from Chrome
  155 on macOS a disposable profile's first navigation otherwise waits for
  Keychain access that a non-interactive runner never grants) and a
  `--blink-settings` desktop pointer (headless Chrome on hosted Linux detects
  no mouse and matches `(hover: none)`, which CDP media emulation cannot undo).
- **Sandbox.** Hosted Ubuntu blocks the user namespaces Chrome's sandbox uses;
  the workflow sets `EVERYTAB_CHROME_NO_SANDBOX=1` and every browser suite
  honours it.
- **Reduced motion.** Hosted Windows disables OS animations, which Chrome
  reports as `prefers-reduced-motion: reduce`. A browser check that asserts an
  ordinary-motion duration pins `no-preference` through
  `Emulation.setEmulatedMedia`; reduced-motion checks pin `reduce`.
- **Installed-Chrome timing budgets are observations on hosted runners.** The
  workflow sets `EVERYTAB_HOSTED_RUNNER=1`. The timing budgets in
  `theme-on-open-extension.mjs` (spread New Tab 400 ms, context-pressured Popup
  300 ms, and the optional content and singleton budgets) then print as
  `OBSERVATION` lines with the measured value and the local budget instead of
  failing. Run 37769962127 measured 1638/864/1089 ms on one hosted Ubuntu VM,
  a 2x spread inside one run. Functional assertions and the 10 s readiness
  bounds still fail the job; local runs enforce the budgets unchanged. On one
  Mac, Chrome for Testing 155 measured the spread New Tabs at about 630 ms and
  the Popup at 500 ms where 150 measured 200 ms and 90 ms, with Dashboard
  content readiness unchanged (about 85 ms), so a local run with a current
  stable Chrome can exceed these budgets too.
- **Performance lane.** Budgets stay enforced on hosted Linux. A suite whose
  Mac-calibrated absolute budget does not fit the 2-vCPU private-repository
  runner multiplies it by `HOSTED_BUDGET_SCALE` (3) from
  `extension/test/hosted-runner.mjs` under `EVERYTAB_HOSTED_RUNNER=1` and prints
  both numbers. The runner measured 2.2x to 3.1x the reference Mac:
  `archive-render-performance.mjs` T2 47.5 ms (about 21 ms locally, budget 45)
  and `inbox-filter-performance.mjs` T2/T3 135/513 ms (61/167 ms locally,
  budgets 120/350). Hardware-independent assertions, such as the Inbox filter's
  zero reads and its 0.6x-of-before ratio, are never scaled.
  `inbox-filter-performance.mjs` also runs with `--max-old-space-size=4096`
  because its T3 fixture exceeds the 2 GB default heap of a 7 GB runner.
- **macOS.** Both jobs use the `macos-15` (arm64) label. Hosted macOS starts
  Chrome and the extension worker, but page targets have not answered their
  first DevTools command there. The installed job first runs
  `tools/probe-chrome-page-target.mjs` (20 s per launch variant). When the
  baseline page answers, the full browser lane runs; otherwise only
  `installed-worker-bootstrap` runs and the job raises a "macOS browser lane
  not executed" warning. A green macOS installed job therefore proves page
  behavior only when the probe printed `pages=ready`.
- **Bounded hangs.** The three DOM suites bound each DevTools command to 30 s,
  and the runner prints a timed-out suite's partial output, so a stall names
  its step instead of consuming the 3-minute suite timeout silently.

## Choose evidence for the change

| Change | Required evidence |
| --- | --- |
| Pure planning or formatting | Direct input/output cases, including boundary values |
| Saved mutations or Undo | Fresh-state races, failed writes, exact retained identities |
| Chrome event owner | Listener routing, pending work, partial failures, stale identities |
| Vault protocol | Corrupt/incomplete files, retry, no-change sync, Restore verification |
| UI behavior | Mounted DOM interaction and, when relevant, installed Chrome confirmation |
| Performance | Fixed fixture size, baseline, repeated measurements, stated environment |
| Archive/tool relocation | Hash parity, import/link resolution, affected tool tests |

Some tests inspect source text to prevent forbidden wiring. Keep those as
architecture guards, but do not use their success as visual or interaction
evidence. Portable mocks do not exercise real IndexedDB disk behavior, folder
permissions, extension lifecycle timing, or native Chrome notifications.

Browser harnesses live in `tools/`; their instructions use a server rooted at
the project directory so both `/tools/` and `/extension/` can resolve. Browser
test runners and their environment flags are documented in their own files.
Do not claim a browser test ran just because its portable preconditions passed.

## Automation reveal continuity

`node tools/test.mjs check-automation-reveal.mjs` runs the production automation controller
and CSS in disposable installed Chrome. It interrupts a real opacity transition
with a cached remount and rejects renewed brightness after pointer departure.
Normal/reduced motion, Open/Inbox, stationary pointer and keyboard controls are covered.
This is a minimized native rendering regression; the separate installed live-feedback
runner checks full Dashboard moves and exact browser order. Neither substitutes for
acceptance of the user-recorded interaction on their macOS browser.

## Current codebase learning files

```sh
node tools/build-codebase-guide.mjs --write
node tools/test.mjs codebase-guide-freshness
node tools/testing/codebase-guide.test.mjs
node tools/testing/codebase-source-graph.test.mjs
node tools/check-codebase-explorer.mjs
```

Regenerate after maintained source, test, inventory or root-guide edits. The
portable gate runs a read-only byte comparison of all generated learning files.
It fails if outputs are missing, edited or stale; it never quietly updates them.
The generator preserves previous output bytes and verifies their hashes before
replacement. Synthetic filesystem tests cover safe scope, symlinks, relocation,
input/output drift, source links and archive preservation. Scanner tests distinguish
literal imports/reexports from comments and embedded source examples. This graph
is deliberately incomplete for computed imports, browser messages and events.

The separate Chrome fixture exercises the root explorer's current inventory,
search, dependency navigation, source links, real Enter activation and narrow
layout. It is an explicit qualification tool, not part of the seven-suite browser gate.
No runtime version bump is needed when only documentation and development tools change.

## Native Library storage measurements

```sh
CHROME_BIN=/path/to/chrome node tools/measure-native-storage.mjs > receipt.json
node tools/testing/native-storage-benchmark.test.mjs
```

Run the explicit measurement alone, outside other browser or performance suites.
The runner uses a new disposable profile, a loopback page and the production Library
module with native IndexedDB. It never loads an installed profile or personal Vault.
It prints the JSON receipt only after exact payload checks, all fixture database
deletions, owned-browser shutdown and profile/server cleanup succeed. Diagnostics
and progress go to stderr. Use a fresh output filename to preserve older receipts.

Four fixed scenarios compare 1,000/10,000 one-tab Inbox records with 64 shared or
one distinct ~1 KB embedded SVG favicon per record. Three fresh-database rounds
run sequentially in one browser, reversing scenario order in the middle round.
The receipt records input JSON bytes, environment, served-source hashes and every
sample. It times seeding in batches of 100, a first family read after reopening the
connection, five warm family/entity reads, five distinct single-record label edits,
and one checkpoint per round. Exact records and favicon payloads are checked after
reads and after reopening following writes; checkpoint contents must match the
edited records. Verification and input construction are outside timed regions.

This is a baseline with no hardware-dependent speed threshold. Timings include
production hashing, cloning, outbox maintenance and IndexedDB transaction completion;
they do not isolate physical disk I/O. Reopening a connection does not clear OS
caches. Report raw samples and median/range, not small-sample tail percentiles.
Warm entity reads follow family hydration. These results do not measure full
extension startup, storage-authority locks, mixed saved families, Search/facets,
UI rendering, cloud transport, contention or power-loss durability. The portable
oracle tests reject corrupt/stale payloads but do not replace the native run.

## Favicon-free Search reads

```sh
node tools/test.mjs search-storage-projection.mjs
node tools/test.mjs search-projection-cache.mjs
node tools/test.mjs search-projection-parity.mjs
```

These portable suites verify zero asset requests across Library/Recovery projected
reads, exact non-icon field parity, separate cache ownership, in-flight invalidation,
revision/alias changes, failed-read recovery and full-payload editing afterward.
Production Search snapshots, progressive results, scopes and facets are compared
with full-read references across saved families and named/automatic Sessions,
including legacy timestamp ordering. Memory adapters establish behavior, not native
transaction timing. The mounted native fixture below repeats the zero-asset-read
assertion in every Search phase and verifies the committed edit retains its favicon.

## Mounted Search with native storage

```sh
CHROME_BIN=/path/to/chrome node tools/measure-native-storage.mjs --search > fresh-search-receipt.json
node tools/testing/native-search-oracles.test.mjs
node tools/testing/native-measurement-receipt.test.mjs
```

The explicit runner uses the same four Inbox/favicon scenarios as the Library
baseline, with three fresh-document rounds in one owned Chrome profile. Each page
seeds UUID-named native Library/Recovery databases and routes through the actual
production authority, Store, Search session and shared Searchbox with production CSS.
Only Chrome local-storage/event transport, empty tabs/windows and denied History
permission are synthetic. Native Web Locks and IndexedDB remain real. One matching
Session tab makes the primary and completed result sets independently observable.

Each page measures first use, three immediate warm queries with a 50 ms
inter-sample wait, one query after 1,100 ms to expire the completion cache, and a query
after an edit committed through `upsertItem`. The saved-edit duration is separate.
The component receives synthetic `input` events without focus or suggestion
preloading, preserving the real 90 ms input debounce without a focus-triggered
prewarm. This isolates this input path; it is not full installed-host startup or
trusted keyboard/OS-input acceptance. All four actual Search hosts remain outside
this mounted fixture.

Every phase verifies exact production result titles/URLs/types, new DOM row
identities, order, roles, selection and layout. Shared negative oracles reject
stale/wrong rows and invalid cache behavior: first/post-edit build one primary
snapshot and read Inbox/Sessions; immediate warm reads neither; expired warm
retains primary/Inbox but rereads Sessions. Trial receipt checks reject a previous
page's PASS, malformed phase sequences/timings, mismatched dimensions or missing
cleanup. Source bytes changing during a run also fail instead of creating an
ambiguous fingerprint.

Timings begin before input dispatch, including preparation that may happen before
`searchProgressively`. DOM-ready timestamps are distinct from the next animation
frame opportunity. Frame callbacks happen before paint; the receipt records whether
primary rows were already replaced by completion at that callback. Neither metric
proves compositor presentation. Frame waits fail after two seconds; actual warm
input cadence must remain within the intended cache interval. No timeout is
substituted for a rendering opportunity. The runner brings the page forward,
emulates focus and disables background timer/renderer throttling; those settings
are recorded. These controlled scheduling conditions are not background-tab evidence.
Library/authority/snapshot spans overlap and must
not be added as independent costs. Native request counts describe work, not disk
throughput. Seed work and assertions are outside measured input intervals, but
instrumentation/observer overhead remains. No speed threshold or broad latency
claim is inferred from these synthetic fixtures.

## Mixed Sessions, Snapshots and facets

```sh
CHROME_BIN=/path/to/chrome node tools/measure-native-storage.mjs --search-mixed > mixed-search-receipt.json
node tools/testing/native-mixed-search-fixture.test.mjs
node tools/testing/native-measurement-receipt.test.mjs
```

This explicit measurement uses 1,000/10,000 total saved tabs split across Inbox,
10/30 named Sessions and 20/60 automatic Snapshots. Each Session/Snapshot has two
windows of 15/50 tabs; all sources share 64 embedded favicons and 16 domains. Three
rounds each run selective Search, broad Search and facet methods in separate fresh
documents: 18 trials, 108 phases and 36 disposable database deletions. Trial order
reverses in the middle round. Run alone, without other native/performance suites.

Selective queries must return exactly one Inbox, one named Session and one Snapshot
tab; broad queries must return 50 Inbox matches and display the first 15 without
Session completion. Query timing
uses mounted Searchbox input/DOM/frame checks. Facet timing instead calls the public
Search session's label and scope-name methods; it makes no autocomplete DOM claim.
Pure fixture formulas independently check all result fields, facet counts and order,
including ignored Snapshot labels. Portable tests reject corrupted outputs and
incorrect cache behavior, and compare expectations with production Search.

Each trial repeats first use, three immediate warm requests, a request after 1.1s,
and a request after a committed named Session tab title/label edit. That edit should
invalidate Search while retaining the Inbox projection cache. Facets should remain
cached after completion expiry; selective completion rereads Sessions/Recovery;
broad Search must never do so. Every phase asserts zero favicon asset reads. Full
committed Session payload verification occurs outside timed phases. Generic upsert commit
cost is reported separately: it is not the UI's named-only rename. After the six
Search/facet phases, the fixture also measures production `renameSession`, verifying
retained payloads, its saved Undo inverse, fresh Session names and zero Recovery
reads. Import/setup/assertion work is outside that rename timing. Native assertions
also require at most one named-record read per Search phase and exactly two over
its generic upsert (fresh state plus commit comparison). The compact identity index is seeded before measurement,
so this is not startup timing. Other synthetic-input and native-measurement limits
from the preceding section still apply.

## Session read sharing

```sh
node tools/test.mjs authority-session-read-sharing.mjs
```

This behavior suite uses production Library/Recovery memory adapters to verify one
Library read for both Session aliases, with independent nested values and unchanged
Recovery/tombstone precedence. It covers both favicon modes, duplicate keys, fresh
and concurrent calls, failed-read retries and unrelated requests. The same test fails
against the archived pre-change authority's duplicate read. Existing projection,
mutation and native storage checks remain separate evidence.

## Selection and recovery contracts

```sh
node tools/test.mjs selection-feedback.mjs
node tools/test.mjs ui-interaction-safety.mjs
node tools/test.mjs snapshot-recovery-outcomes.mjs
node tools/test.mjs snapshot-recovery.mjs
node extension/test/open-preparation-dom.mjs
```

Selection checks exercise the mounted list through pointer/keyboard controls,
including range anchors, current bulk-action payloads and row identity across
refreshes. Snapshot checks compare complete receipts for healthy, partial,
uncertain and degraded outcomes, including optional-field omission and the
legacy restore wrapper. Native selection geometry and the Open group fixture
cover real DOM behavior; mocks alone do not establish Chrome lifecycle timing.

## Diagnostic privacy regressions

```sh
node tools/test.mjs background-failure-diagnostic.mjs
node tools/test.mjs storage-authority-prewarm.mjs
node tools/test.mjs vault-sync-watchdog.mjs
node tools/test.mjs perf.mjs
```

These exercise synthetic private URLs/titles, arbitrary operation labels,
throwing getters, revoked proxies and failed log sinks. Mounted UI/lifecycle
fixtures also verify failure containment. Performance reports must omit URLs and
free-form details while retaining allowed timing labels and numeric measurements.
Vault failure receipts retain timeout/owner identity with safe error classes;
localized presentation is covered by the i18n suite. Historical receipts are not
rewritten. The diagnostic source guard prevents direct console calls outside
the explicitly tested opt-in performance reporter. This is privacy regression
coverage, not a comprehensive security assessment.

## Identity, Restore and interrupted Undo regressions

```sh
node extension/test/selection-feedback.mjs
node extension/test/focus-close-live-identity.mjs
node extension/test/suspend-effect-live-identity.mjs
node extension/test/library-restore-freshness.mjs
node extension/test/close-day.mjs
node extension/test/close-day-undo-storage.mjs
node extension/test/action-recovery-readiness.mjs
node extension/test/indexeddb-adapter-dom.mjs
node extension/test/selection-geometry-dom.mjs
node tools/check-codebase-explorer.mjs
```

The first seven are portable behavior tests. Close-day Undo also runs through the
production storage authority with transactional memory adapters; this covers
failed inverse/final writes, competing Undo claims, partial and uncertain browser
results, legacy interrupted receipts and late completion. These adapters do not
prove native disk durability. The readiness fixture executes the actual worker
gate with deferred owners and real message handlers; it covers expected first-install
absence, recovery ordering and blocked commands after genuine storage failures.
The IndexedDB fixture uses real Chrome storage for remote stale-preview rejection,
fresh Restore and Undo. The selection fixture mounts the shared list in Chrome.
The root explorer fixture checks search, filtering and file relations. Browser
fixtures use synthetic data, localhost servers and disposable profiles.

Keep real two-profile Vault sync, Chrome reload/restart and native navigation
acceptance distinct from these checks. All maintained suites and historical tools have explicit execution or exclusion
decisions in the inventory.

## Post-commit repair and recovery outcomes

```sh
node extension/test/library-revision-repair.mjs
node extension/test/vault-recovery-receipt-bounds.mjs
node extension/test/snooze-session-source-unavailable.mjs
node extension/test/snapshot-recovery-outcomes.mjs
node extension/test/indexeddb-adapter-dom.mjs
```

The Library suite injects failures after durable remote/Restore commitment and
requires repair after reopen, a no-change retry, and before a subsequent ordinary
Session edit. The native IndexedDB fixture repeats persisted repair intent across
an actual database close/reopen. It does not terminate Chrome mid-transaction.
The Recovery receipt suite covers 9,999/10,000/10,001 historical asset hints and
repeated retention cycles through a synthetic folder adapter, preserving files.

Snooze and Snapshot suites inject unavailable sources, partial browser results and
post-create setup failures into real domain owners. They assert exact counts,
retained records, retry ownership and honest notification/copy behavior. They are
simulated browser-boundary tests, not an installed-profile timing guarantee.

## Import and interaction transitions

```sh
node extension/test/data-import-lifecycle.mjs
node extension/test/import-commit.mjs
node extension/test/ui-interaction-safety.mjs
node tools/check-data-import.mjs
node extension/test/selection-geometry-dom.mjs
```

The import lifecycle suite mounts Data and uses the production storage authority
with transactional memory adapters. It covers double activation, draft/options
edited during persistence, failure/retry and a host refresh failure after save.
The browser import tool repeats pending activation and draft retention through
the real unpacked extension, native IndexedDB and the Store Web Lock.

Shared interaction cases cover row actions after refresh/deselection, held danger
keys and composition ownership. The mounted Chrome fixture additionally exercises
Search and bubbling palette handlers. Synthetic composing events do not replace
an actual Japanese, Chinese or Korean operating-system input-method check.

## Targeted duplicate matching checks

```sh
node extension/test/duplicate-domain-rules.mjs
node extension/test/duplicate-message-handlers.mjs
node extension/test/duplicate-rules-ui.mjs
```

These portable tests cover exact-host matching, migration into portable Settings,
message routing and control discovery. They do not replace a disposable installed-
profile check of cross-device Vault convergence, popup, badge and close behavior.

## Startup and icon privacy browser fixtures

```sh
node tools/check-startup-paint.mjs
node tools/security-favicon-browser.mjs
```

Both load the real unpacked extension in Chrome for Testing with disposable
profiles and synthetic records. Startup records frame geometry, normal/reduced
motion, slow optional data, keyboard paths, and Starred width boundaries. The
security fixture counts requests to a localhost marker receiver while displaying
an imported icon and hostile text/image payloads. These are mounted-browser
checks, not personal-profile acceptance or a comprehensive penetration test.

## Delight interaction browser fixtures

```sh
EVERYTAB_STARTUP_HEADED=1 node tools/check-startup-arrivals.mjs
node tools/check-window-arrivals.mjs
node tools/check-startup-controls.mjs
node tools/check-search-emphasis.mjs
node tools/check-search-suggestion-cohesion.mjs
node tools/check-delight-interactions.mjs
node tools/check-minimal-delight.mjs
node tools/check-minimal-motion-visibility.mjs
node tools/check-focus-motion.mjs
node extension/test/selection-geometry-dom.mjs
node extension/test/search-refresh-continuity-dom.mjs
EVERYTAB_OPEN_GROUP_EVIDENCE_DIR=review-evidence/open-groups-fresh node tools/check-open-group-rails.mjs
```

These use disposable Chrome for Testing profiles and synthetic records. They
exercise delayed real-count arrival, one-time cues, Search stacking and outside
clicks, tooltip intent, toast/Undo races, selection-stable list geometry,
reversible disclosure geometry, clock
locales and narrow widths, and reduced-motion changes. Focus checks use worker
start/end actions, sampled geometry, reversals, access-height changes and a
Side Panel fixture. Search and startup receipts include actual intermediate
rendered values and paused-frame captures; animation API calls alone do not
establish visibility. The startup paint runner
also intersects rows with the actual growing card bounds: mounted DOM, first
uncovered content, fully uncovered rows, and completed card growth are distinct
measurements. Set `EVERYTAB_STARTUP_EVIDENCE_DIR` to retain
separate baseline and after receipts. Browser checks establish the recorded
behavior and geometry, not subjective feel on every installed profile.

The Search continuity fixture mounts the shared Search component and fires a
background title notification while the field is focused. It verifies that the
snapshot is retired for the next interaction without replacing the visible result
DOM used by Dashboard, Popup, Side Panel and Minimal.

Choose a fresh `EVERYTAB_OPEN_GROUP_EVIDENCE_DIR` before running the Open group
fixture; its legacy default points to preserved .632 evidence.

The Open group rail fixture mounts the real shared list in Chromium, verifies
that headers have no actions or decorative rule, that loose tabs remain
ungrouped, and that one scheme-accent rail occupies the right edge through the
final member tab. It also holds the external refresh unresolved and requires
the row, owning-window controls and cross-window action dock to update together,
remain stable past the former flicker interval and trigger no Chrome/storage
refresh. A 300-row fixture measures the complete local transaction. It records
cream light, Tide light and Nautilus dark captures under the current evidence
receipt.

Window arrival checks measure actual card/header heights, the composed list
viewport, fixed section-separator geometry, row visibility, continuous curtain
travel, enrichment continuity and interruption. A tab-heavy tall-window fixture
ensures the visible viewport is still only halfway revealed at the motion
midpoint. The checks also assert that Open animates one empty, background-matched
curtain with no card or row descendants. Page reload and reduced motion must skip
the effect. Normal motion must stay below 300ms and use the accepted restrained
back-out curve. Warm enrichment and viewport changes must retarget that same
effect in place rather than restart its easing.
The startup-controls fixture holds the optional
Focus module and status response, verifies first-frame control presence and
retained keyboard focus, exercises an early click through adoption, checks
MORE spacing, and measures the clock-clear atmosphere mask at four viewports. Pending-count checks
include native headed screenshots, decorative accessibility exclusion and hidden
page pause/resume. Minimal visibility checks sample actual visible travel in three
schemes and the initially hidden tab's first foreground frame. This geometric
threshold is a visibility proxy, not a substitute for watching the movement.

```sh
node tools/capture-minimal-motion-replay.mjs
```

This optional replay recorder stores native Chrome screencast frames and their
original timing, plus a local Play/Pause/Restart/seek page. It does not stretch
production animation time or edit the captured image pixels. Playback frame
sampling and capture overhead mean it is not a display frame-rate benchmark.
`prepareSession` in the shared browser harness sets reduced motion by default;
normal-motion tests must explicitly override that after preparing each session.

## Installed acceptance regressions

```sh
node tools/test.mjs check-installed-action-races.mjs
node tools/check-installed-recovery-ui.mjs
node tools/check-installed-restart.mjs
node tools/check-installed-vault.mjs
node tools/test.mjs suspend-close-occurrence.mjs
node tools/test.mjs restart-occurrences.test.mjs
node tools/test.mjs installed-recovery-cleanup.test.mjs
node tools/test.mjs vault-reconnect-ui.mjs
node tools/test.mjs vault-folder-choice-ui.mjs
node tools/test.mjs idb-transaction-lifecycle.mjs
node tools/test.mjs check-installed-vault-handle.mjs
```

These tools always create disposable profiles and synthetic records. Set
`CHROME_BIN` to Chrome for Testing. The action-race runner is in the explicit
browser lane; the other tools are direct qualification entries with retained
receipts. They have not been qualified on remote CI. Inspect each tool's output
options before a run and preserve historical evidence.

Action races use real Web Locks, native IndexedDB and native tab effects. A
controlled browser-call pause permits destruction of a Close-the-day owner
before or after its close; Activity Undo then settles the durable receipt and
reopens exactly once. Two additional cases pause the actual worker during Undo,
before or after window creation, then reload the extension and require a different
worker target. Startup must settle an incomplete receipt without duplicate equal-URL
occurrences or repeating the inverse over a later saved edit. Fresh-install startup
must emit no action-recovery failure diagnostic. These are controlled extension
reloads, not abrupt OS termination or a disk power-loss guarantee.

The recovery UI runner drives installed Snapshot and Snoozed controls. A scoped
worker API rejection verifies partial/unconfirmed Snapshot copy and an exact
retry after the native API is restored. It also checks composing keys through a name field's actual containing header, which
standalone input tests cannot cover. Synthetic composition remains distinct from
a native operating-system input-method session. The Dashboard refresh dependency
regression also checks deferred hidden-page work and preserves the Session-only
navigation path.

The restart runner compares per-window URL and stable occurrence identities,
allowing Chrome to renumber windows while rejecting equal-URL copies swapped
between them. After a second ordinary restart it waits for natural reload-grace
expiry, closes one adopted occurrence and reloads again to prove it stays closed.
The portable close-occurrence suite covers stale aliases, registry/ledger write
failures, reused numeric IDs, independent equal URLs and concurrent recovery.
An in-memory identity protects failed ledger writes only in the current worker.

The cleanup suite executes the maintained recovery runner's actual catch/finally
with injected resource and report-write failures. It requires every cleanup
attempt and preservation of the primary failure. The Vault runner also requires
all checkpoint, recovery-pack, recovery-snapshot and view publication flags to
remain false during a no-change sync.

The mounted Reconnect suite uses the production Vault/IndexedDB owners with
synthetic boundaries. It covers both controls, rejected permission requests,
one-shot and persistent handle reads, safe Details rendering, non-granted
results, and a granted retry reaching `syncNow`. Its replication authority is
intentionally unavailable; the resulting bounded failure proves entry into sync,
not successful native folder I/O. Native permission selection, retention and
revocation must still be exercised with a real disposable folder.

The folder-choice suite separates picker cancellation from subsequent inspection
and persistence failures, preserving the previous handle and sync receipt. The
IDB helper suite controls request success, transaction commit/abort and connection
closure. Request success alone must never be treated as a committed handle write.

The native-handle runner is in the explicit browser lane. It uses real OPFS
`FileSystemDirectoryHandle` objects, native IndexedDB and `syncNow()`, checking
identity after page reload, actual worker replacement and clean browser restart.
It compares file hashes and modification times across no-change sync, aborts a
real write transaction after request success, and checks missing-directory failure.
The picker is replaced only for the controlled abort scenario; native external
folder selection, grant/revocation UI and cloud transport are not exercised.
Choose a fresh `EVERYTAB_VAULT_HANDLE_OUTPUT` directory when retaining evidence.

Lifecycle and Vault receipts must state the installation mechanism, shutdown
method, storage adapter and permission limitations. Treat browser restart,
extension reload, two local profiles, two devices, native folder handles and
filesystem bridges as distinct evidence.

## Installed checks

Use disposable test records, not destructive experiments on the user's library.
After a change touching startup, confirm suspended tabs begin recovering promptly
and produce the expected notification. After persistence changes, verify one
small saved edit and a subsequent no-change Vault sync. UI changes need their
actual keyboard/mouse path, not just a successful render.

Keep results under `review-evidence/` with the tested version and exact commands.
Historical results remain valid only for the version and environment recorded.


## Installed Inbox and focused Search

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs > inbox-receipt.json
CHROME_BIN=/path/to/chrome node tools/check-installed-search-refresh.mjs > search-refresh.log
node tools/testing/installed-inbox-receipt.test.mjs
```

Run these native tools sequentially, without concurrent performance gates. Both
use disposable profiles and synthetic data; neither packages the extension.
The Inbox runner seeds 250 and 1,000 single-tab cards through the production Store,
then navigates to the installed Dashboard three times per size. It verifies every
ordered row, title and URL, no disclosure cap, visible first-row geometry, and
separate class/checkbox selection for the first and last rows through CDP clicks.
Each receipt must match the freshly injected navigation token. Source hashes and
successful browser/profile cleanup accompany the completed JSON receipt.

Timing starts at navigation and records first/all row insertion plus the next real
animation frame. A frame callback is not compositor paint, favicon decoding or an
interaction-latency measurement. Explicit native tab/window focus, focus emulation and reduced
motion are part of setup, completed against the outgoing document before each
measured navigation. The owned browser also starts with
`--force-prefers-reduced-motion`: the native preference must be true before any
CDP override, and the effective preference must remain true at injection and the
measured frame. Receipts name this `focus-before-navigation-native-motion-v3`
protocol. Earlier v2 receipts can include outgoing style work caused by mismatched
browser/emulation settings; still earlier receipts used post-navigation focus.
Do not pool these protocols as comparable latency baselines. Trials reuse the profile and worker; these are not
cold browser startups. Bundled records and Side Panel Inbox remain separate work.
The portable validator deliberately rejects stale tokens, incomplete or reordered
rows, hidden frames, absent or non-true motion observations, and disagreement
between selection classes and checkboxes.

The Search tool uses real background title/favicon/URL changes in four installed
host documents. It checks focused input, query, backward text selection, highlighted
option, row identity and rendered content after confirmed native event delivery.
Same-node content mutations must fail its continuity oracle. The next query must
use the changed title; URL navigation must refresh live results without input.
A remaining saved Snapshot must match an actual synthetic Recovery record at the
former URL, including displayed title and Snapshot metadata; its Restore action
is outside this fixture. Current
Search rows do not show favicons, so favicon evidence is native delivery plus
continuity. The 500ms observation is bounded, not an unlimited stability guarantee.
Popup and Side Panel documents opened as tabs do not replace their attached browser
containers, trusted OS IME, or manual visual acceptance.


## Inbox cost tracing and bundled records

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --trace > inbox-trace.json
CHROME_BIN=/path/to/chrome node tools/check-installed-inbox-bundles.mjs > inbox-bundles.log
node tools/testing/inbox-cpu-profile.test.mjs
node tools/testing/installed-inbox-bundles.test.mjs
```

`--trace` retains the full single-tab Inbox correctness checks and adds diagnostic
instrumentation. Existing `?perf=1` boot spans overlap and begin after some module
and shell work; they are not a full wall-clock decomposition. Profiler commands bracket navigation and milestone detection, including fixture
polling and the first geometry read. Focus setup finishes before profiling starts. Profiling stops before row serialization
and selection, but its separate CPU clock does not establish complete navigation
coverage. The later receipt timestamp includes extraction and is not profile-stop time.
Only safe extension-relative source paths and numeric aggregates are retained.
No raw profile function names or external URLs are written. Sample times are
estimates; waiting, layout, raster and compositor work are not fully attributed.

Script ResourceTiming entries, long tasks and completed spans use the frame cutoff.
A resource count of zero with `available:false` means no script entries were exposed,
not that loading cost was zero. The first geometry read is timed separately because
it can force layout after the frame callback. Its end still does not prove paint.
Keep traced observations separate from the uninstrumented baseline.

The bundled Inbox runner seeds 25 fresh window records with 12 unique tabs each,
using opposite creation and modification order to verify Inbox ordering. Dashboard
and Side Panel documents each run at 360 and 400 pixels. Initial eight-row previews,
all 300 expanded rows, exact disclosure ownership/counts, and endpoint selection
are checked through overflow collapse/reexpansion and whole-card fold/unfold.
Card/row geometry and document scroll widths must fit the narrow viewport.
The fixture uses CDP clicks and disposable data; it does not exercise the attached
Side Panel container, trusted OS input or simultaneous visibility of every row.


## Inbox boundary work and reduced-motion counters

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --work > inbox-work.json
EVERYTAB_STARTUP_OUTPUT=review-evidence/current-startup CHROME_BIN=/path/to/chrome node tools/check-startup-arrivals.mjs
node extension/test/startup-count-style-reads.mjs
node tools/testing/inbox-work-probes.test.mjs
node tools/testing/inbox-measurement-cleanup.test.mjs
```

`--work` is separate from `--trace`. It wraps Intl construction, canonical locale
resolution, Chrome message lookup and pending startup-counter pseudo-style reads
before modules evaluate. Only numeric counts and durations are retained in the work
report; the surrounding receipt still carries known synthetic row identities.
The snapshot ends after the first geometry read, before row serialization or
selection. Probes add overhead, including an eager transform access immediately
before the caller's original access; aggregate times are not a full wall-clock
breakdown. The exact receipt schema and nonzero formatter/locale/message activity
must validate before success. Keep these observations separate from plain timings.

The startup test uses the actual owner with a simulated DOM to assert zero style
work under reduced motion, truthful accessible counts, normal-motion sampling
before pending DOM replacement, no replay, expired replacement and preference
cleanup. Native startup qualification adds intermediate animation frames, native
accessibility and preference/visibility checks. Use a fresh `EVERYTAB_STARTUP_OUTPUT`
path to preserve older receipts. Its own computed-style sampling cannot prove
zero product style reads; the portable owner test and attributed probe do that.
Any uncaught fixture error now fails qualification. Inbox cleanup fault injection
verifies remaining resources are attempted after a close failure; a profile is
removed only after confirmed browser termination, and cleanup errors prevent a
successful measurement receipt.


## Inbox message callers and deferred controls

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --messages > inbox-message-callers.json
CHROME_BIN=/path/to/chrome node tools/check-deferred-list-controls.mjs > deferred-controls.json
node extension/test/deferred-list-control-copy.mjs
node tools/testing/inbox-message-callers.test.mjs
```

`--messages` enables the existing numeric work counters and attributes every message
lookup to the first allowlisted current-extension source frame outside `i18n.js`.
It retains file/line/count only: no raw stack, function name, message key or input.
Its totals must match the work counter at the same post-geometry boundary, and an
entirely unattributed report fails. Windows source paths are normalized only for
this allowlist; existing source-hash receipt keys retain their original format.
Capturing stacks adds substantial overhead; use this mode for counts, never speed
claims. Run the uninstrumented mode separately for timing observations.

The actual-control portable suite verifies unopened copy is deferred, default and
explicit null/empty labels, accessible names, focus, four-second cancellation and
reset, explicit-only confirmation, and picker keyboard/reopen behavior. Its DOM
and read-only named-Session adapter are simulated. Native qualification mounts the
same production controls in a disposable installed Dashboard and uses CDP pointer
and Enter events plus real timers. It verifies default/custom labels and focus,
without saving/deleting real data. This is not trusted OS input, complete Inbox
layout coverage or proof of Session commit/Undo behavior. Output is emitted only
after source stability and owned-browser/profile cleanup succeed.


## Initial list action construction

```sh
node extension/test/tablist-action-resolution.mjs
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --messages > inbox-actions.json
CHROME_BIN=/path/to/chrome node tools/check-installed-inbox-bundles.mjs > inbox-bundles.log
```

The actual `createTabList` regression counts factory calls and checks behavior,
not private cache structure. Initial shortcut discovery and card rendering share
raw descriptors only during that synchronous build. Immutable filtering and row
predicates remain at rendering; later folding and new list construction resolve
fresh factories. Local selection still uses current selection contexts without
rebuilding all rows. Native Inbox attribution verifies the expected source-call
reduction; bundle fixtures exercise selection/disclosure/folding at narrow widths.
Neither source counts nor synthetic CDP input establish compositor latency or
trusted OS keyboard behavior. Use plain measurements separately for timing.


## Inbox startup diagnosis

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --startup > inbox-startup.json
node tools/testing/inbox-navigation.test.mjs
node tools/testing/inbox-startup-network.test.mjs
```

Startup mode retains exact rows, first-frame visibility and endpoint selection.
It records document injection, classic boot load, interactive state, shell observer
delivery, Dashboard module load and DOM/load events using the new document clock.
Shell observation is not the exact append instant. Existing boot spans overlap;
these are observations, not a complete wall-clock decomposition.

A separate CDP collector allows only known runtime source paths on the exact
extension origin and measured loader/frame. It records resource types and numeric
event times relative to the main document request, without retaining raw URLs,
request IDs or error payloads. Its snapshot is taken when the fixture detects the
frame, which is later than the page callback; do not subtract or sum across clocks.
Response and completion timestamps are independent and may appear in either order;
their difference is not a latency. The main document and both entry scripts must
have successful observed completions. Null milestones on other resources are
unavailable, not zero work. Long tasks and resource-buffer
saturation are not monitored in this mode.

The navigation suite executes the actual focus callback and proves pending/failed
setup cannot overlap navigation or profiling. Synthetic network tests exercise
identity, privacy, stale traffic, malformed timestamps and partial/failure events.
Run the native tool separately from performance gates. It does not change runtime
source, package the extension or replace attached browser/OS acceptance.


## Outgoing Inbox navigation diagnostics

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --departure > inbox-departure.json
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --departure-open > open-departure.json
node tools/testing/inbox-departure-trace.test.mjs
```

Run these comparisons sequentially. Both preserve startup-mode source, row, focus,
selection and cleanup assertions. `--departure` leaves each preceding measured
Inbox mounted; the first trial per size leaves the Open seed page.
`--departure-open` first navigates to a fresh Open Dashboard and waits for its
initial boot to settle, then verifies zero outgoing Inbox rows. This extra
navigation changes outgoing content and warmup; it is a diagnostic comparison,
not an interchangeable performance baseline. Receipts report outgoing row and
element counts.

An awaited pre-navigation hook starts native tracing after focus setup, marks the
outgoing document, and measures to a mark injected before incoming module work.
The collector keeps only fixed browser event names and numeric timing, requires
one ordered marker pair on the same renderer thread, and clips complete events
to that interval. It discards raw args, addresses, stacks and arbitrary labels.
Costs can nest/overlap and must not be summed into an elapsed-time total. Absent
allowlisted events do not prove zero unobserved work.

The runner requires an explicit `dataLossOccurred: false` completion receipt.
Reported loss, missing/invalid status, missing/duplicate markers, thread changes
or trace timeout fail the diagnostic. The collector's completion validator
represents a missing loss flag as unknown; the runner rejects that unknown.
Tests exercise those metadata states, privacy, invalid events, clipping, multiple
chunks and overlapping costs. Navigation tests prove a pending/failed diagnostic
hook prevents profiling and measured navigation.

Navigation Timing also records request/response and unload milestones. Zero
unload duration is an observation at browser precision, not proof of no pagehide
work. Native trace timestamps and new-document performance timestamps remain
separate clocks. No runtime version bump is needed for these development tools.


## Inbox selector and style-invalidation diagnostics

```sh
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --selectors > inbox-selectors.json
CHROME_BIN=/path/to/chrome node tools/measure-installed-inbox.mjs --selectors-pre-focus > inbox-selectors-focus.json
node tools/testing/inbox-selector-stats.test.mjs
node tools/testing/inbox-departure-trace.test.mjs
```

Run serially in an owned disposable profile. Both modes retain the exact incoming
row, selection, focus, source-integrity and cleanup oracles. `--selectors` starts
after fixture focus setup; `--selectors-pre-focus` deliberately includes that
setup to observe its effects. Its interval is not navigation latency. Receipts
include outgoing selection, focused-checkbox, boot, Starred and scheme state.

Chrome selector statistics add substantial overhead. Use matching counts and
partial attribution, never these timings as normal startup latency. The collector
pairs each statistics dump to the preceding complete same-thread UpdateLayoutTree
pass. The pass must fit entirely inside the marker interval; its dump must start
before injection but may finish later. Ambiguous, crossing or unpaired observations
are excluded. Selector text must exactly match the current owned CSSOM catalogue,
including meaningful whitespace. Grouped-rule fragments are not split or guessed;
unknown selectors contribute only excluded counts/time. File lists are catalogue
candidates, not proof of the executing stylesheet. Private sheet IDs are discarded.

Optional invalidation attribution retains only fixed Chromium reasons and exact
owned JavaScript source paths with positive one-based trace coordinates. Unknown
reasons become `other`; unmatched locations become null. Root/body mutation
observers emit fixed markers without attribute values. They record delivered
writes, not a complete inventory of browser style changes. No observed marker
does not prove no other mutation occurred.

These intervals establish renderer-thread work before incoming injection, not
outgoing document identity or causality. Frame IDs can survive navigation. Do not
interpret keyframe/property invalidation reasons as proof of application mutation
or teardown. Collector failures fail the awaited diagnostic path and reach owned
cleanup; explicit no-loss trace completion is still required. Synthetic tests
cover pairing, exact selector identity, privacy, malformed input, source URL
spoofing, fixed markers, phase/thread boundaries and count limits.


Selector modes also privately capture the outgoing HTML root before tracing and
the incoming HTML root after confirmed trace completion. Remote objects are
released immediately, including on validation failure. Only PropertyRegistration
invalidation observations receive a `rootOwnership` label: `outgoing-root`,
`incoming-root`, `other` for a valid different node, or `unknown` for missing or
invalid identity. Supplied root IDs must be positive safe integers and distinct.
They are never receipt fields. Other invalidation reasons remain unassigned.

This labels the two sampled root objects, not all work in either document.
Root replacement can yield `other`; missing observations do not establish absence
of registry work. The ordered marker pair must still share renderer process and
thread identity. Synthetic cases cover label isolation, late identity binding,
invalid values, default-output compatibility, remote-object release ordering and
fixed failure messages. Use fresh native receipts after collector changes.


## Static Inbox registered-property comparison

```sh
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs > property-comparison.json
node tools/testing/inbox-property-fixture.test.mjs
```

Run separately from browser/performance suites. The runner captures synthetic
250/1,000-card Dashboard markup in a disposable installed profile, then reconstructs
it in `extension/test/inbox-property-static.html` without application modules.
Live checkbox properties are restored without changing default attributes; a
real CDP pointer click restores endpoint focus. Markup remains in memory; receipts
retain its hash and numeric/fixture-key state only. Source blob icons are converted
to data URLs before their original document is destroyed.

Both outgoing variants explicitly set collapsed Focus height to `0px`. The
control keeps all CSS rules. The other removes exactly the one top-level
`--focus-layout-h` CSSPropertyRule after loading and verifies all remaining rules
are unchanged. This is removal after loading, not a never-registered property.
Three rounds alternate variant order for each size. Destination markup/CSS and
focus-before-navigation steps are identical. Styles, fonts/images and frames are
settled before tracing. Trace categories omit expensive selector statistics.

Every pair must have identical ordered row keys, selected/checked endpoints,
focus-visible state, element count, viewport/scroll coordinates, all row rectangles
and Focus-strip rectangles. Zero-height collapsed strips are valid. The required
explicit Focus value, zero scripts/inline handlers/script resources and exact
eight-stylesheet order are asserted. Mismatches fail the comparison; fixed field
names and numeric rectangle differences aid diagnosis without dumping markup.

The first experiment without a common explicit value changed the Focus strip
from 0 to 16px and failed geometry equality. The explicit-value experiment is a
narrower scenario. It does not show that the registered initial value can be
removed safely, or exercise Focus animation. A static control that does not
reproduce relevant registration/style observations cannot exclude application
listeners or animation history omitted by reconstruction. Property ownership
labels apply only to their own events. Explicit trace-loss checks, source hashes
and owned Chrome/profile cleanup remain required; no product speed claim follows.


## Static Inbox focus comparison

```sh
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --focus-control > focus-comparison.json
node tools/testing/inbox-property-fixture.test.mjs
node tools/testing/inbox-departure-trace.test.mjs
```

Both variants retain the registered property and the explicit collapsed `0px`
height. They receive the same endpoint pointer click and shared Chrome focus setup;
the runner then verifies that the last checkbox is still focused. Tracing starts
before `blur()` in the treatment or a no-op in the control. Both wait two frames
and collect the complete state. The fixed `inbox:focus-prepared` marker separates
this preparation from the subsequent navigation to the same empty destination.

Pairs may differ only in focused row key, focused-row count, checkbox focus and
focus-visible state. Selection, hover over the last row, CSS, script absence and
all sampled geometry must match exactly. Zero SVG use elements is asserted; the
current icon owner constructs inline paths, not external SVG use resources.

Receipts retain full intervals plus preparation/navigation durations and split
UpdateLayoutTree totals. A style pass crossing the marker is divided at the
boundary. This prevents earlier preparation work being mistaken for eliminated
work. Both phases include fixture/protocol overhead; preparation includes settling
frames and state collection, and neither phase is pure application CPU time.
Compare full-interval style totals as well as the split. Preserve the same trace
loss, source provenance, root-ownership and owned-cleanup checks as the property
comparison. Default invocation retains the previous property experiment.


Optional invalidation attribution also emits `insertedNodeKind` for the exact
node-insertion event/reason. It keeps only `style`, `link`, `html`, `body`, `text`
or `other`. Chrome's DebugName can include IDs/classes; the classifier discards
those suffixes and accepts only documented tag boundaries, never arbitrary prefix
matches. When the caller supplies the two sampled root IDs, exact HTML insertions
also receive `insertedRootOwnership`: `outgoing-root`, `incoming-root`, `other`
or `unknown`. IDs stay private. `other` means a valid ID matched neither sampled
root; it does not identify a third document or the node's ownerDocument. Missing
or malformed IDs become `unknown`. Non-HTML insertions receive no ownership label.
Property-registration root labels remain separate.

Optional attribution also retains `lifecycleType` on EventDispatch costs only for
exact `beforeunload`, `pagehide`, `unload` and `visibilitychange` types. No listener
is added to generate these observations. Other types and raw event args remain
private, and default collectors gain no new fields. These labels show observed
same-thread ordering, not document identity or complete shutdown. A clipped event
start is not its original dispatch start; absence does not prove a lifecycle phase
was skipped. Neither insertion categories nor neighboring events establish cause.


## Static Inbox navigation-command comparison

```sh
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --command-control > command-comparison.json
node tools/testing/inbox-navigation.test.mjs
node tools/testing/inbox-property-fixture.test.mjs
```

Both arms use one canonical source/destination URL, reconstruct the same synthetic
Inbox snapshot and retain CSS registration, focus, hover, selection and exact
geometry. Three alternating-order pairs at 250 and 1,000 cards compare
Page.navigate-to-current-URL with Page.reload (ignoreCache false). Shared focus
setup stays ahead of tracing; equal settling/state collection stays inside the
trace before the existing preparation marker. No field may differ between paired
outgoing states. Earlier property/focus modes remain available.

Reload acceptance returns no loader identity. The runner requires a completed
empty destination, distinct sampled document roots and the same-thread trace
marker pair, plus one PerformanceNavigationTiming entry at the canonical URL.
Only a fixed observed type and URL-equality boolean enter the receipt. Either
command may produce `navigate` or `reload`; do not infer browser behavior from
command spelling. Unexpected/missing types fail rather than entering logs.
Keep the no-loss, before/after source hashes and owned cleanup requirements.
This is a diagnostic command comparison, not a user-visible speedup or proof of
ordinary interactive navigation performance.


## Static Inbox reduced-motion comparison

```sh
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --media-control > media-comparison.json
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --command-control > default-before.json
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --command-control --native-reduced-motion > default-aligned.json
CHROME_BIN=/path/to/chrome node tools/measure-inbox-property.mjs --command-control > default-restored.json
node tools/testing/inbox-property-fixture.test.mjs
```

Run native measurements sequentially. Media control launches an owned browser
with native reduced motion, then compares retained CDP emulation against a cleared
override. Both arms retain reduced motion, focus and registration; every outgoing
state field must match within each pair. Three alternating pairs per size use the
same canonical URL and navigation command. The command-control sequence separately
varies only the native browser flag between fresh profiles; compare its full source
hashes and matching outgoing states before interpreting timing. Its default arm
uses the host's native preference, so another host need not reproduce a mismatch.

Keep historical property/focus/command modes unchanged by default. All modes retain
no-loss tracing, source guards, complete destinations and owned cleanup. A static
result must be qualified against the full installed Inbox runner. This diagnoses
measurement configuration, not a runtime speedup, compositor latency, or the exact
Chromium call path.


## Live move feedback and saved duplicate markers

```sh
node extension/test/dashboard-tab-move-refresh.mjs
node extension/test/dashboard-open-scroll.mjs
node extension/test/open-placement.mjs
node extension/test/automation-awareness-batching.mjs
node extension/test/recovery-ready-summary.mjs
node extension/test/saved-duplicate-badges.mjs
node extension/test/startup-inbox-safety.mjs
CHROME_BIN=/path/to/chrome node tools/check-installed-live-feedback.mjs
```

The move suite executes the maintained Dashboard event/scheduler/interaction-gate
blocks with synthetic Chrome signals, fake frames/timers and render output. It
proves prompt placement scheduling without losing hidden/held/in-flight work;
ordinary signals keep their trailing quiet window. A blocked auxiliary read cannot
delay Open, and foreground replay coalesces Open once. It is not a DOM speed benchmark. The Open scroll caller suite verifies that the
latest scroll position is read after awaited data and before connected heading
writes; it preserves held/hidden/loading behavior and final clamp-aware correction.
It also verifies that an already committed placement skips a second host DOM commit.
The actual Open surface/list suite checks retained rows, fresh action indexes,
range selection and conservative fallback using a minimal DOM, not native layout.

Saved-duplicate tests mount the actual list builders, validate exact URL/scope and
accessible visible markers, retain filtered source indexes, and exercise existing
remove/delete plus Undo. They preserve saved records and exclude automatic Snapshots.
Worker-start tests compose the actual Inbox sweep with startup/reload owners:
disabled controls do nothing; an independent enabled tab cap saves eligible surplus
once. Active recovery grace blocks timer/cap/bundle capture and closure, including
planning, commit and close races; expiry restores normal behavior. This is simulated
lifecycle behavior, not an installed extension reload.

The native tool owns a disposable Chrome profile and local HTTP pages. It checks
exact DOM order after four browser reorders, unique membership after two cross-window
moves, Dashboard reload with both Auto-save controls disabled, and exact duplicate
marker scopes/data preservation. Navigation tokens require fresh documents; full
page visits use distinct query tokens to avoid fragment-only navigation. Runtime
hashes must stay unchanged, and success is emitted only after browser/profile/server
cleanup. Native timings are observations, not hardware-sensitive pass thresholds
or compositor-paint proof. Run serially with other native/performance work.

`--large-moves --normal-motion` uses 164 local fixture tabs across five windows;
`--profile-moves` adds sanitized per-source CPU samples, optional one-based source
coordinates and numeric scroll-read/owned-replacement probes. These add overhead;
the probe restores original browser methods before later fixture phases. The large
fixture also asserts a fifth reorder preserves a nonzero scroll position, then
returns to the top before cross-window moves.
`--stable-placements` requires retained root/row identities at the second frame
and after the trailing refresh. It verifies selection persistence, new-order
Shift range and pointer/keyboard focus payloads. This flag is for eligible flat
same-window moves; cross-window checks continue to require exact membership.
Default workload remains four tracked tabs with reduced motion. Reorders record
exact DOM order and two subsequent frame opportunities; the sampled animation
count does not prove no animation occurred or establish compositor paint time.

`tools/check-installed-restart.mjs` now enables eligible idle timer and max-tab
Auto-save for its first actual extension reload, retaining exact occurrences,
window membership, Inbox and settings through the nine-second recovery tail.
It waits for the new cycle's delivery state and exact final notification ID before
its completion capture, then checks distinct starting/final IDs and final retention
through the tail. Acceptance/retention does not establish an OS banner. The actual
owner suite also covers zero affected tabs without a final notification. The
ready-summary suite composes the real domain and owner for adopted-before-repair
pages, separate ready/repair counts, mixed results, stale/closed/new occurrences
and notification races. The installed runner adds a controlled owner start after
real reloads have finished: it checks a ready-only summary without changing native
tab identities, URLs or Recently closed. This extra case is explicitly not another
`runtime.reload`, and retained native notifications do not prove OS banners.
It disables both policies before unrelated restart phases. Set
`EVERYTAB_RESTART_EVIDENCE_DIR` to a fresh evidence folder when running it.

Manual acceptance still needs the user's actual move interaction. The reported
trigger is extension Reload with Auto-save enabled; precise thresholds remain
optional fixture refinements. Repetition alone is not proof of corrupt
Inbox data: saved occurrences can come from separate captures or bundles.


## Dashboard drag with timed indicators

`tools/check-installed-live-feedback.mjs --grouped-profile --normal-motion
--dashboard-drag --timed-automation` models 57 total tabs in 8 windows and one
native Chrome group. The four moved tabs share that group; other fixture tabs
produce timed indicators. `--grouped-profile` and `--large-moves` are alternatives.
Use `--large-moves` with the other flags for 164 fixture tabs and scrolled movement.
The optional group-name permission is not granted by this fixture.

Dashboard drag dispatches synthetic drag events with DataTransfer through the
actual row/controller, background message, journal and Chrome effect. It is not
trusted OS pointer input. Its start is immediately before event dispatch; it
records onMoved delivery in the Dashboard separately from DOM order. That event
timestamp is page-observed delivery, not precise browser-process completion.
Cross-window phases continue to use direct Chrome API moves. Timed Auto-save is
set to one day with one-hour-old synthetic activity, so it cannot archive these
fixture tabs. The pre-existing Dashboard reload phase disables the timer first.

The automation-awareness batching regression composes the actual Open surface
and controller and requires connected opacity reads before the first connected
indicator mutation. It covers button/reveal identity, selection and scoped
snapshot cleanup. It is a behavioral layout-order guard, not a timing benchmark.


### Automation indicator continuity and recovery diagnostic

Add `--indicator-continuity` to the grouped Dashboard drag command above to hold
an actual CDP mouse position over the drop target and sample CSS opacity through
reordering and 350ms after exact DOM/frame reconciliation. The oracle requires a
different button under the pointer, uninterrupted hover and opacity >=0.95; it
then checks pointer-leave opacity 0, temporary-class cleanup and focus opacity 1.
It requires `--timed-automation` and excludes `--large-moves` because that variant
has a separate scrolling trial. Frame sampling adds work; use a separate run
without this flag for matched timing. Input drag events remain synthetic, and
programmatic focus verifies CSS parity rather than physical keyboard navigation.

The installed tool also executes the exact maintained recovery diagnostic in its
owned Dashboard context, outside measured moves. It checks real module import,
authoritative Store read and native notification query, not visible OS banners.

`tools/recovery-summary-diagnostic.js` is a read-only Console snippet. Open
Dashboard, press Command-Option-J on macOS, paste the entire file and press Enter.
Copy the JSON output; the fulfilled undefined Promise is normal. Run before the
next extension reload so the previous recovery cycle remains available. Its
portable VM suite runs through the inventory with `--experimental-vm-modules` and
covers wrong contexts, failed steps, safe output and preservation of partial counts.


### Vault restart during an unresponsive folder read

`node tools/test.mjs vault-restart-ui.mjs` mounts the production Vault surface with
synthetic retained-handle, permission and Chrome boundaries. It verifies that the
Restart action reaches Chrome before a hung presentation read resolves, without
fabricating a successful sync. This complements `vault-sync-watchdog.mjs`, whose
operation/lock checks and source assertions did not exercise the mounted action.
The fixture does not establish the cause of a user's folder timeout or qualify
external-folder permissions, cloud availability or native page-reload completion.


### Vault progress and inactivity

`node tools/test.mjs vault-progress-watchdog.mjs` drives the production Vault
protocol, real memory Library/Recovery stores, synthetic filesystem handles and
an injected watchdog clock. It covers cumulative healthy scans over 30 seconds,
partial progress followed by a stall, blocked root/device/format/manifest operations,
invalid files and incomplete writes. Only completed work may reset the deadline.
This does not measure iCloud hydration or identify the user's individual stalled call.
The installed native-handle fixture can separately qualify OPFS/IndexedDB/protocol
integration, while external-folder/cloud permission and transport remain manual.


### Open row mount continuity

`node tools/check-automation-reveal.mjs` also mounts the production `createTabList`
in disposable Chrome. It checks stationary-pointer replacement across Soft,
Crisp and Terminal, selected/unselected rows and normal/reduced motion. Once Chrome
assigns hover (required by the second sampled frame), highlight colour, action
opacity and timed awareness opacity must remain settled on every subsequent sample.
Receipts retain `preHoverFrames`; RAF/computed styles do not prove compositor pixels.
It checks mount-class cleanup, restored ordinary transitions, reduced-motion
suppression, pointer departure, programmatic focus and rows without automation.
The prior six departing-fade/reveal cases remain. These are synthetic list mounts,
not native browser-tab shortcuts or trusted OS drag input.

`node tools/test.mjs automation-awareness-batching.mjs` includes actual list root
lifecycle checks for two-frame cleanup, non-Open scope, overlapping replacements
and hidden-document timer fallback. The full gate still has the same suite count.
