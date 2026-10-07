# Architecture

## The short version

Think of EveryTab as a desk with a filing cabinet and an optional backup folder.
The pages show the desk. The background worker talks to Chrome. The Library
is the filing cabinet; Recovery keeps bounded lists of earlier open windows.
Vault copies changes to a folder, but that folder is not the working database.

```text
Popup / Dashboard / Minimal page / Side panel
             │ user actions and reads
             ▼
Domain modules in js/lib/ ←→ Chrome event/message owners in js/background/
             │                         │
             ▼                         ▼
Store interface                    Browser tabs, windows,
             │                     alarms and notifications
             ▼
IndexedDB Library + separate Recovery database
             │
             ▼
Vault: incremental files + Restore points + readable views
```

Paths below are relative to `extension/`.

## Where a change belongs

| Area | Responsibility | Start here |
| --- | --- | --- |
| Page entry points | Mount a surface, wire navigation and page state | `js/ui/dashboard.js`, `popup.js`, `newtab-entry.js`, `sidepanel.js` |
| Shared UI | Lists, selection, actions, search, pickers, appearance | `js/ui/tablist.js`, `js/ui/list-configs.js`, `js/ui/theme.js` |
| Domain operations | Meaning of save, restore, snooze, label, protect, close, and Undo | `js/lib/`; select the feature's module and its direct tests |
| Chrome boundary | Validate messages, route events, retain asynchronous work | `js/background/*-owner.js`, `*-message-handlers.js` |
| Composition | Supply the domain dependencies to those boundaries | `js/background.js` |
| Store facade | Fresh locked mutations, logical family reads, invalidation | `js/lib/store.js` |
| Local persistence | Library records/assets/journal/outbox, separate Recovery retention | `js/lib/storage/` |
| Failure diagnostics | Fixed operation/error labels shared by worker, domains and UI; raw failures never reach console sinks | `js/lib/failure-diagnostic.js` |
| Optional folder copy | File protocol, publication, Restore, retention | `js/vault/` |
| Visual language | Shared tokens and component styling | `css/tokens.css` and `css/` |

Domain modules should not reach into page markup. UI modules should not invent
their own storage transactions. `i18n.js` includes a small document-localization
adapter as well as translation lookup; it is an intentional DOM boundary, not
a claim that every file under `lib/` is browser-independent.

## Follow one action

Saving an open tab starts from a row or popup action. A message handler checks
the request, then calls the save operation. That operation captures the page's
identity and commits the saved record before asking Chrome to close it. The
close path rechecks live identity so a tab that navigated while saving is not
silently treated as the original page. A revision invalidates page caches and
the list refreshes. A later Vault sync publishes the durable change.

Chrome does not offer an atomic "close only if this URL is unchanged" operation.
Revalidation narrows that race; it does not make browser actions transactional.

## Search reads a lighter copy

Search is like checking the writing on each card without fetching its picture.
`lib/search.js` asks `lib/store.js` for `listSearchItems`. The storage authority
passes `includeFavicons: false` to Library and Recovery, which omit favicon fields
and private asset references without reading the asset stores. Other record fields,
Session ordering and deleted-record handling retain their normal meaning.

Store keeps these display-only records in a separate cache. Both caches share
invalidation generations, so an edit or revision discards stale Search data too.
Search's complete Session pass uses a fresh read to avoid retaining large Snapshot
maps. Ordinary reads and locked mutations still request complete records; Search
projections never supply the editable cache or change the saved format.

When one request asks for both the complete Session map and its named-only view,
`storage/local-authority.js` reads the named Library rows once. Each view still
gets its own deep copy; Recovery data merges only into the complete view. That
shared read belongs to one request and is discarded afterward. It is not a cache
across edits. Named-only operations such as rename already avoid Recovery entirely.

## Selection is a local UI update

Think of selecting a row as putting a sticker on a card. It should not ask the
filing cabinet to reload every card. `ui/tablist.js` keeps the selected keys and
range anchor for each section, then commits one synchronous DOM update:

1. Paint the selected rows, checkboxes and availability of row actions.
2. Update the owning group/window checkboxes and action lanes.
3. Update the cross-group selection toolbar and retain its keyboard focus.

The existing rows stay mounted. Selection-only gestures do not call the external
`onChange` refresh. A completed bulk operation can clear selection immediately
and then request that refresh because saved data or browser tabs may have changed.
Live Open rows use stable tab keys. Saved rows use positional keys guarded by a
serialized layout signature, so reordering a saved group cannot silently move a
selection to a different saved occurrence. Range keys stay lazy until needed.

## Recovery results are receipts

A receipt says what Chrome actually confirmed, like checking which cards arrived
back on the desk. `lib/sessions.js` restores one window; `lib/snapshot-recovery.js`
rechecks which selected occurrences are still missing and combines the receipts.
A rejected browser call does not always mean that nothing happened.

| Field | Meaning |
| --- | --- |
| `restored` | Tab occurrences confirmed by browser evidence, including repeated URLs |
| `failed` | Invalid references or occurrences absent from a successful browser query |
| `uncertain` | Insufficient browser evidence to confirm whether the requested tabs opened |
| `degraded` | Opened window whose binding or pinned-tab setup could not be fully applied |
| `unavailable` | Snapshot selection no longer eligible after the fresh recheck |
| `windows` | Acknowledged window IDs; this does not mean every tab in them was confirmed |

The one-window receipt always includes its uncertainty/degradation fields. The
Snapshot aggregate omits those optional fields when zero, preserving its caller
contract. An unavailable selection alone does not make an otherwise completed
aggregate fail. Confirmed failures, uncertain effects or incomplete setup do.
The legacy restore function still returns a window ID or throws its retained
setup error; it does not adopt the Snapshot receipt interface.

## Close-the-day Undo

`lib/close-day.js` owns the saved-data inverse, browser reopen result and durable
Close-the-day receipt. Think of Undo as a checked to-do list: first it records
who is doing the work, then it opens the pages, then it records what happened.
The saved inverse and matching Activity claim share one Library transaction;
Chrome window creation happens afterward and cannot join that transaction.

A successful result settles both receipts together. Partial or uncertain browser
results settle as incomplete. If the worker stops between creating a window and
recording its result, startup cannot know which pages opened. It marks the result
incomplete without creating them again or repeating the saved inverse. The
confirmed count is then a lower bound; zero does not mean no pages opened.

`lib/journal.js` routes Close-the-day Undo to that owner and leaves its recovery
to the same module. `background.js` waits for all action recovery tasks to settle;
a failure keeps affected commands unavailable. `background/close-day-message-handlers.js`
applies that gate to every Close-the-day request. `ui/close-day-surface.js` shows
the outcome and does not offer a repeat Undo for uncertain browser effects.

## Durability boundaries

- **Library** owns saved records, favicon assets, change history, and saved-data
  Undo state. Related Library writes can share one IndexedDB transaction.
- **Recovery** is a separate database with bounded automatic snapshots. A
  Library write and a Recovery write are not one cross-database transaction.
- **Chrome storage** still holds device-local settings/coordination records
  and authority metadata where the store contract requires them. It is not a
  second complete saved-library authority.
- **Vault** publishes incremental records and sealed Restore points. Folder
  writes are not one atomic filesystem transaction; the protocol checks the
  parts before accepting a publication. `library.json` and `index.md` are
  generated readable views, not a database to edit in place.
- **Undo** follows each operation's contract. Restoring a saved record does not
  imply reversing every browser side effect, such as closing a newly opened tab.

Some on-disk and browser-storage strings contain historical prefixes or a
version number. These are persistent identifiers, not alternate code paths.
Changing their spelling can disconnect existing data. Source names should
describe the current responsibility; stored names must remain stable.

Startup initializes current product services directly. Historical conversion
and window-restoration helpers are preserved outside the extension in the
[source archive](archive/2026-09-11-startup-bridges/INDEX.md).

## What is good, and what is not finished

The worker has explicit event owners, the store has a single mutation boundary,
and the Vault protocol has focused modules. Those are useful boundaries with
direct tests, not reasons to split every long file further.

The UI list kernel, Dashboard composition, and Focus/suspension state machines
remain substantial. Their interfaces and invariants matter more than a line
count target. Future changes should isolate a cohesive responsibility with
behavior tests, not create forwarding modules just to make files shorter.

Search scheduling has measured improvements on synthetic Chrome fixtures.
Those results do not establish end-to-end storage latency, full-page rendering
cost, or performance for every large library. The [backlog](backlog.md) records
those measurement gaps separately from completed repairs.
