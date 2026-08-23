import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-08-18T09:00:00Z");
let failures = 0;
function check(condition, name) {
  if (condition) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures += 1; }
}
const ref = (url, extra = {}) => ({ url, title: url, ...extra });
const meta = (id, extra = {}) => ({
  id, deviceId: "close-day-test", createdAt: T0, modifiedAt: T0,
  schemaVersion: 1, ...extra
});

const {
  CLOSE_DAY_ACTIONS, buildCloseDayPlan, closeDayUrlKey, mergeAddedSessionRefs, applyCloseDayChoices
} = await import("../js/lib/close-day-planner.js");

const sessionId = ID(1);
const sessions = {
  [sessionId]: meta(sessionId, {
    name: "Research", auto: false, labels: [],
    windows: [[ref("https://a.test"), ref("https://a.test"), ref("https://b.test")]]
  }),
  [ID(2)]: meta(ID(2), {
    name: "Snapshot", auto: true, labels: [], windows: [[ref("https://snap.test")]]
  })
};
const live = (id, windowId, index, url, extra = {}) => ({
  id, windowId, index, rawUrl: url, title: url, ref: ref(url), ...extra
});
const plan = buildCloseDayPlan({
  sessions, inbox: {}, archive: {}, bindings: { 7: { sessionId, windowIndex: 0 } },
  extensionOrigin: "chrome-extension://test/", protectedTabId: 99,
  windows: [
    { id: 7, tabs: [
      live(1, 7, 0, "https://a.test"), live(2, 7, 1, "https://b.test"),
      live(3, 7, 2, "https://a.test"), live(4, 7, 3, "https://c.test")
    ] },
    { id: 8, tabs: [
      live(5, 8, 0, "https://snap.test"),
      live(6, 8, 1, "https://pinned.test", { pinned: true }),
      live(7, 8, 2, "https://audio.test", { audible: true }),
      { id: 99, windowId: 8, index: 3, rawUrl: "chrome-extension://test/dashboard.html#close-day",
        title: "EveryTab", ref: null }
    ] }
  ]
});
const bound = plan.groups[0];
check(bound.rows.map((row) => row.matchSavedIndex).join() === "0,2,1," && bound.session.drift.order,
  "P11-15 matches duplicate Session occurrences and detects order drift");
check(bound.rows[3].choice.action === CLOSE_DAY_ACTIONS.addSession,
  "P11-15 a new restored-Session tab defaults to add-only Session capture");
const timestampPlan = buildCloseDayPlan({
  sessions: { [sessionId]: meta(sessionId, {
    name: "Video", auto: false, labels: [], windows: [[
      ref("https://www.youtube.com/watch?v=WlorPYYgvUQ&t=3s")
    ]]
  }) }, inbox: {}, archive: {}, bindings: { 17: { sessionId, windowIndex: 0 } },
  extensionOrigin: "chrome-extension://test/", protectedTabId: null,
  windows: [{ id: 17, tabs: [live(17, 17, 0,
    "https://www.youtube.com/watch?v=WlorPYYgvUQ&t=4s")] }]
});
check(timestampPlan.groups[0].rows[0].matchSavedIndex === 0 &&
  timestampPlan.groups[0].rows[0].choice.action === CLOSE_DAY_ACTIONS.close &&
  !timestampPlan.groups[0].session.drift.any,
"P11-15 playback-position changes remain the same saved YouTube page");
check(closeDayUrlKey("https://www.youtube.com/watch?v=A&t=3s&list=L") ===
  closeDayUrlKey("https://www.youtube.com/watch?v=A&t=4s&list=L") &&
  closeDayUrlKey("https://www.youtube.com/watch?v=A&t=3s&list=L") !==
    closeDayUrlKey("https://www.youtube.com/watch?v=B&t=4s&list=L") &&
  closeDayUrlKey("https://www.youtube.com/watch?v=A&t=3s&list=L") !==
    closeDayUrlKey("https://www.youtube.com/watch?v=A&t=4s&list=OTHER") &&
  closeDayUrlKey("https://example.com/watch?t=3s") !== closeDayUrlKey("https://example.com/watch?t=4s"),
"P11-15 playback normalization preserves video, playlist, and non-YouTube query identity");
const merged = mergeAddedSessionRefs(sessions[sessionId].windows[0], bound.rows);
check(merged.map((item) => item.url).join() ===
  "https://a.test,https://a.test,https://c.test,https://b.test",
  "P11-15 add-only merge preserves absent saved refs while inserting the new occurrence");
check(plan.groups[1].rows[0].coverage.kind === "snapshot" &&
  plan.groups[1].rows[0].choice.action === CLOSE_DAY_ACTIONS.inbox,
  "P11-15 automatic Snapshots do not qualify as durable coverage");
check(plan.groups[1].rows[1].choice.action === CLOSE_DAY_ACTIONS.stay &&
  !plan.groups[1].rows[1].locked && plan.groups[1].rows[2].locked && plan.groups[1].rows[3].locked,
  "P11-15 pinned tabs are opt-in while audible and EveryTab pages are locked open");
const suspendedPlan = buildCloseDayPlan({
  sessions: {}, inbox: {}, archive: {}, bindings: {},
  extensionOrigin: "chrome-extension://test/", protectedTabId: null,
  windows: [{ id: 30, tabs: [{
    id: 31, windowId: 30, index: 0,
    rawUrl: "chrome-extension://test/suspend.html?originalUrl=https%3A%2F%2Fsleeping.test",
    title: "Sleeping", ref: ref("https://sleeping.test")
  }] }]
});
check(!suspendedPlan.groups[0].rows[0].locked &&
  suspendedPlan.groups[0].rows[0].choice.action === CLOSE_DAY_ACTIONS.inbox,
  "P11-15 EveryTab-suspended tabs are reviewed by their original saveable page");
const bulkPlan = structuredClone(plan);
const bulkRows = bulkPlan.groups[0].rows.slice(0, 3);
check(applyCloseDayChoices(bulkPlan, bulkRows.map((row) => row.fingerprintKey), {
  action: CLOSE_DAY_ACTIONS.archiveLabel, labels: ["Research", "Urgent"]
}) && bulkRows.every((row) => row.choice.action === CLOSE_DAY_ACTIONS.archiveLabel &&
  row.choice.label === "Research" && row.choice.labels.join("|") === "Research|Urgent") &&
  bulkPlan.summary.archiveCount === 3,
"P11-15 one multi-label bulk choice applies to every selected tab atomically");
const beforeInvalidBulk = JSON.stringify(bulkPlan);
check(!applyCloseDayChoices(bulkPlan, [bulkRows[0].fingerprintKey, "missing"], {
  action: CLOSE_DAY_ACTIONS.inbox
}) && JSON.stringify(bulkPlan) === beforeInvalidBulk,
"P11-15 an invalid bulk member leaves the complete review unchanged");

/* Full coordinator: save first, close exact live tabs, then exact Undo. */
const storage = createInterleavableStorage({
  deviceId: "close-day-test", sessions: {
    [sessionId]: meta(sessionId, {
      name: "Research", auto: false, labels: [],
      windows: [[ref("https://kept.test", { labels: ["research"] })]]
    })
  }, inbox: {}, archive: {}, archiveOverlay: {}, sessionWindows: {
    10: { sessionId, windowIndex: 0 }
  }, counters: {}, journal: []
});
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, writable: true, configurable: true
});
let nextWindowId = 100;
let nextTabId = 1000;
let browserWindows = [
  { id: 10, type: "normal", incognito: false, tabs: [
    { id: 11, windowId: 10, index: 0, url: "https://kept.test", title: "Kept", pinned: false, audible: false },
    { id: 12, windowId: 10, index: 1, url: "https://new.test", title: "New", pinned: false, audible: false }
  ] },
  { id: 20, type: "normal", incognito: false, tabs: [
    { id: 21, windowId: 20, index: 0, url: "https://loose.test", title: "Loose", pinned: false, audible: false },
    { id: 22, windowId: 20, index: 1, url: "https://stay.test", title: "Pinned", pinned: true, audible: false },
    { id: 23, windowId: 20, index: 2, url: "chrome-extension://test/dashboard.html#close-day", title: "Review", pinned: false, audible: false }
  ] }
];
const findTab = (id) => {
  for (const win of browserWindows) {
    const tab = win.tabs.find((candidate) => candidate.id === id);
    if (tab) return { win, tab };
  }
  return null;
};
globalThis.chrome = {
  runtime: { getURL: (path = "") => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  windows: {
    getAll: async () => structuredClone(browserWindows),
    create: async ({ url }) => {
      const urls = Array.isArray(url) ? url : [url];
      const win = { id: nextWindowId++, type: "normal", incognito: false,
        tabs: urls.map((value, index) => ({ id: nextTabId++, windowId: nextWindowId - 1,
          index, url: value, title: value, pinned: false, audible: false })) };
      browserWindows.push(win);
      return structuredClone(win);
    }
  },
  tabs: {
    get: async (id) => {
      const found = findTab(id);
      if (!found) throw new Error("gone");
      return structuredClone(found.tab);
    },
    remove: async (ids) => {
      for (const id of (Array.isArray(ids) ? ids : [ids])) {
        const found = findTab(id);
        if (found) found.win.tabs = found.win.tabs.filter((tab) => tab.id !== id)
          .map((tab, index) => ({ ...tab, index }));
      }
    },
    query: async ({ windowId } = {}) => {
      const wins = windowId == null ? browserWindows : browserWindows.filter((win) => win.id === windowId);
      return structuredClone(wins.flatMap((win) => win.tabs));
    },
    update: async (id, patch) => {
      const found = findTab(id);
      if (!found) throw new Error("gone");
      Object.assign(found.tab, patch);
      return structuredClone(found.tab);
    },
    create: async ({ url, pinned = false }) => {
      let win = browserWindows[0];
      if (!win) { win = { id: nextWindowId++, type: "normal", incognito: false, tabs: [] }; browserWindows.push(win); }
      const tab = { id: nextTabId++, windowId: win.id, index: win.tabs.length,
        url, title: url, pinned, audible: false };
      win.tabs.push(tab);
      return structuredClone(tab);
    }
  }
};

const {
  captureCloseDayReview, checkCloseDayReview, commitCloseDay, undoCloseDayTransaction
} = await import("../js/lib/close-day.js");
const captured = await captureCloseDayReview({ protectedTabId: 23, refresh: true });
check(captured.ok && captured.plan.summary.closeCount === 3 && captured.plan.summary.stayOpenCount === 2,
  "P11-15 capture defaults covered, new, loose, pinned, and review tabs safely");
const legacyDraft = storage.snapshot().closeDayDraft;
const legacyChoices = JSON.stringify(legacyDraft.plan.choices);
delete legacyDraft.plan.labels;
await storage.local.set({ closeDayDraft: legacyDraft });
const upgraded = await captureCloseDayReview({ protectedTabId: 23, refresh: false });
check(upgraded.draftId === captured.draftId && upgraded.plan.labels.includes("research") &&
  JSON.stringify(upgraded.plan.choices) === legacyChoices,
"P11-15 a legacy draft rebuild restores label suggestions without losing its choices");
const unchangedReview = await checkCloseDayReview(captured.draftId);
check(unchangedReview.ok && unchangedReview.fresh &&
  !unchangedReview.browserChanged && !unchangedReview.savedChanged,
  "P11-15 an unchanged browser stays fresh across focus and window activation signals");
browserWindows[1].tabs[0].url = "https://changed.test";
const changedReview = await checkCloseDayReview(captured.draftId);
check(changedReview.ok && !changedReview.fresh && changedReview.browserChanged,
  "P11-15 a real tab URL change makes the review stale");
browserWindows[1].tabs[0].url = "https://loose.test";
const committed = await commitCloseDay(captured.draftId);
const afterCommit = storage.snapshot();
const receipt = afterCommit.closeDayReceipts?.[committed.transactionId];
const liveSession = afterCommit.sessions[sessionId];
const inboxItems = Object.values(afterCommit.inbox ?? {}).filter((item) => !item.deletedAt);
check(committed.ok && receipt?.phase === "complete" && receipt.result.closed === 3 && receipt.result.skipped === 0,
  "P11-15 commits one receipt before closing every exact eligible tab");
check(liveSession.windows[0].map((item) => item.url).join() === "https://kept.test,https://new.test" &&
  inboxItems.length === 1 && inboxItems[0].tabs[0].url === "https://loose.test",
  "P11-15 add-only Session and one-window Inbox outputs commit together");
check(Boolean(findTab(22)) && Boolean(findTab(23)) && !findTab(11) && !findTab(12) && !findTab(21),
  "P11-15 pinned and review tabs remain while selected tabs close");
check(afterCommit.journal[0]?.closeDayTransactionId === committed.transactionId &&
  afterCommit.closeDayDraft === null,
  "P11-15 Activity links to the transaction receipt and consumes the draft");

const undone = await undoCloseDayTransaction(committed.transactionId);
const afterUndo = storage.snapshot();
check(undone.status === "undone" && undone.reopened === 3 &&
  afterUndo.sessions[sessionId].windows[0].length === 1 &&
  Object.values(afterUndo.inbox).every((item) => item.deletedAt),
  "P11-15 Undo restores unchanged saved data and tombstones created Inbox output");
check(afterUndo.journal[0].undone === true && afterUndo.closeDayReceipts[committed.transactionId].phase === "undone",
  "P11-15 Undo terminalizes both Activity and receipt atomically");

if (failures) {
  console.error(`\n${failures} Close-the-day test(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: Close-the-day planner, save-first coordinator, close receipt, and Undo");
