# EveryTab (dev) — M3

Local-first tab manager. No build step: this folder loads directly in Chrome.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder

## Try it (M0 acceptance tests)

- **Save to Inbox:** click the toolbar icon → "Save window → Inbox" (or `Ctrl+Shift+S` on Mac). Unpinned tabs close and appear in the dashboard Inbox, including asleep/discarded ones.
- **Shortcuts note:** Chrome binds suggested keys only at install time, and silently skips conflicts. If a shortcut doesn't work, set it manually at `chrome://extensions/shortcuts` (this also survives extension updates).
- **Restore:** dashboard → Inbox → Restore. A window bundle reopens as a new window.
- **Snooze (M3):** popup → "Snooze this tab…" (presets or custom time), or right-click → snooze until tomorrow / Monday. Dashboard "Snoozed" section: wake now, reschedule, cancel. Wakes reopen the tab + notification; settings can switch to quiet wake into the Inbox. Missed wakes (browser closed) fire on next launch.
- **Duplicates (M3):** toolbar badge shows the live count. Popup: one-click "Close N duplicates". Dashboard section lists groups (keeps the active/oldest copy; never closes pinned tabs). Optional auto-close with 30s grace in settings.
- **Suspension (M3):** tabs idle >60 min (configurable) are discarded to free memory — never the active, pinned, audible, or grouped ones. Popup: "Suspend other tabs" for instant relief. Toggle in settings.
- **Universal search (M2):** search box in the popup (focused on open; `Ctrl+Shift+K` on Mac opens it — bind at `chrome://extensions/shortcuts`) and dashboard. Searches open tabs, Inbox, collections, sessions; "Switch" jumps to an already-open tab instead of reopening. Enter = first result. Optional: "Include browsing history" button on the dashboard (permission requested only then).
- **Domain filtering:** live `domain:` completion and Search filtering across open and saved tabs, ranked by the domains you use most. Legacy Smart View records remain portable for pre-release data compatibility but are no longer shown or created.
- **Sessions (M1):**
  - Popup → "Save window as session"; dashboard → "Save all windows as session" (named, renamable).
  - Auto-snapshots appear in the dashboard every 15 min (configurable in options) — only when tabs changed, max 20 kept. Restore = crash recovery.
  - Expand a session ("Show") to restore a single window; pinned tabs come back pinned.
- **Inbox triage (M1):** checkboxes + bulk bar — restore, delete, label, or file selected items into a collection (typed name creates it).
- **Export/Import (M1):** dashboard → Export everything (JSON) / Export Inbox (OneTab format) / Import JSON / paste OneTab text. JSON import merges by item — importing twice is a no-op.
- **Vault prototype:** dashboard → Vault → Connect folder → Test write. (M0 finding: Chrome drops the permission after restart; M5 ships a reconnect banner.)
- **Tests:** `node test/smoke.mjs` — 21 logic tests (snapshots, prune, merge-import, OneTab round-trip, suspender unwrapping).

## Architecture notes

- Plain ES modules, zero dependencies. `js/lib/` is the typed core (JSDoc), `js/ui/` the surfaces, `js/vault/` the File System Access prototype.
- Every record carries merge metadata (`id`, `deviceId`, timestamps, `schemaVersion`, tombstones) per PRD §4 — written from day one so M5 sync needs no migration.
- MV3: service worker is ephemeral; all future timers use `chrome.alarms`, all state in `chrome.storage.local`.

See `../prd.md`, `../plan.md`, `../m0-spec.md`.
