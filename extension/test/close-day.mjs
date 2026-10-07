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
  }),
  [ID(3)]: meta(ID(3), {
    name: "Daily", auto: false, labels: [], windows: [[ref("https://a.test")]]
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
check(bound.rows[0].coverage.sessionNames.join("|") === "Daily|Research",
  "Close the day exposes every named Session containing the reviewed tab");
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
const snoozePlan = structuredClone(plan);
const snoozeRow = snoozePlan.groups[1].rows[0];
const snoozeAt = Date.now() + 3_600_000;
check(applyCloseDayChoices(snoozePlan, [snoozeRow.fingerprintKey], {
  action: CLOSE_DAY_ACTIONS.snooze, dueAt: snoozeAt, recurrence: "weekly"
}) && snoozeRow.choice.action === CLOSE_DAY_ACTIONS.snooze &&
  snoozeRow.choice.dueAt === snoozeAt && snoozeRow.choice.recurrence === "weekly" &&
  snoozePlan.summary.snoozeCount === 1,
"Close the day accepts one validated Snooze choice and includes it in the plan summary");

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
const createdAlarms = [];
const clearedAlarms = [];
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
  alarms: {
    create: async (name, info) => { createdAlarms.push({ name, info }); },
    clear: async (name) => { clearedAlarms.push(name); return true; }
  },
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

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const {
  captureCloseDayReview, checkCloseDayReview, commitCloseDay, undoCloseDayTransaction,
  updateCloseDayChoice
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

/* A Close-the-day draft carries optional organization until its destination exists. */
await storage.local.set({
  sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, archiveOverlay: {}, sessionWindows: {},
  organizationGroups: {}, organizationMemberships: {}, counters: {}, journal: [],
  closeDayDraft: null, closeDayReceipts: {}
});
browserWindows = [{ id: 30, type: "normal", incognito: false, tabs: [
  { id: 31, windowId: 30, index: 0, url: "https://evening.test", title: "Evening",
    pinned: false, audible: false },
  { id: 32, windowId: 30, index: 1, url: "chrome-extension://test/dashboard.html#close-day",
    title: "Review", pinned: false, audible: false }
] }];
const organizedDraft = await captureCloseDayReview({ protectedTabId: 32, refresh: true });
const organizedRow = organizedDraft.plan.groups[0].rows.find((row) => row.tabId === 31);
const organizedChoice = await updateCloseDayChoice(organizedDraft.draftId, organizedRow.fingerprintKey, {
  action: CLOSE_DAY_ACTIONS.newSession,
  newSessionName: "Evening review",
  organizationPlan: {
    mode: "add", memberKeys: ["new:Evening review"], groupIds: [], createNames: ["Personal"]
  }
});
check(organizedChoice.ok && organizedChoice.plan.choices[organizedRow.fingerprintKey]
  .organizationPlan?.createNames?.[0] === "Personal",
"Close the day keeps optional Session organization in its review draft without creating it early");
const organizedCommit = await commitCloseDay(organizedDraft.draftId);
const organizedState = storage.snapshot();
const createdSession = [
  ...Object.values(organizedState.sessions ?? {}),
  ...Object.values(organizedState.sessionNamedRecords ?? {})
]
  .find((session) => session && !session.deletedAt && session.name === "Evening review");
const createdGroup = Object.values(organizedState.organizationGroups ?? {})
  .find((group) => group && !group.deletedAt && group.name === "Personal");
const createdMembership = Object.values(organizedState.organizationMemberships ?? {})
  .find((edge) => edge && !edge.deletedAt && edge.memberKey === createdSession?.id &&
    edge.groupId === createdGroup?.id);
check(organizedCommit.ok && createdSession && createdGroup && createdMembership,
  "Close the day creates its Session destination, applies its Group, then closes the source tab");

/* Snooze is one of the reviewed keep actions and participates in exact Undo. */
await storage.local.set({
  sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, snoozes: {},
  archiveOverlay: {}, sessionWindows: {}, organizationGroups: {}, organizationMemberships: {},
  counters: {}, journal: [], closeDayDraft: null, closeDayReceipts: {}
});
browserWindows = [{ id: 40, type: "normal", incognito: false, tabs: [
  { id: 41, windowId: 40, index: 0, url: "https://tomorrow.test", title: "Tomorrow",
    pinned: false, audible: false },
  { id: 42, windowId: 40, index: 1, url: "chrome-extension://test/dashboard.html#close-day",
    title: "Review", pinned: false, audible: false }
] }];
const snoozeDraft = await captureCloseDayReview({ protectedTabId: 42, refresh: true });
const snoozeDraftRow = snoozeDraft.plan.groups[0].rows.find((row) => row.tabId === 41);
const closeDayDueAt = Date.now() + 2 * 3_600_000;
const snoozeChoice = await updateCloseDayChoice(snoozeDraft.draftId, snoozeDraftRow.fingerprintKey, {
  action: CLOSE_DAY_ACTIONS.snooze, dueAt: closeDayDueAt, recurrence: "daily"
});
const snoozeCommit = await commitCloseDay(snoozeDraft.draftId);
const snoozeState = storage.snapshot();
const savedSnooze = Object.values(snoozeState.snoozes ?? {})
  .find((item) => item && !item.deletedAt);
check(snoozeChoice.ok && snoozeCommit.ok && !findTab(41) &&
  savedSnooze?.url === "https://tomorrow.test" && savedSnooze.dueAt === closeDayDueAt &&
  savedSnooze.recurrence === "daily" &&
  createdAlarms.some((alarm) => alarm.name === `snooze:${savedSnooze.id}` &&
    alarm.info.when === closeDayDueAt),
"Close the day atomically stores and schedules a reviewed Snooze before closing its tab");
const undoneSnooze = await undoCloseDayTransaction(snoozeCommit.transactionId);
const snoozeAfterUndo = storage.snapshot().snoozes[savedSnooze.id];
check(undoneSnooze.status === "undone" && snoozeAfterUndo.deletedAt &&
  clearedAlarms.includes(`snooze:${savedSnooze.id}`) &&
  browserWindows.some((window) => window.tabs.some((tab) => tab.url === "https://tomorrow.test")),
"Close the day Undo cancels its Snooze and reopens the original page");

/* Navigation while the attempted receipt is persisted is revalidated once,
 * with no intervening skipped-status write before the remaining removal. */
await storage.local.set({
  sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, snoozes: {},
  archiveOverlay: {}, sessionWindows: {}, organizationGroups: {}, organizationMemberships: {},
  counters: {}, journal: [], closeDayDraft: null, closeDayReceipts: {}
});
browserWindows = [{ id: 50, type: "normal", incognito: false, tabs: [
  { id: 51, windowId: 50, index: 0, url: "https://first-reviewed.test", title: "First",
    pinned: false, audible: false },
  { id: 52, windowId: 50, index: 1, url: "https://second-reviewed.test", title: "Second",
    pinned: false, audible: false },
  { id: 53, windowId: 50, index: 2, url: "chrome-extension://test/dashboard.html#close-day",
    title: "Review", pinned: false, audible: false }
] }];
const removedCloseDayUrls = [];
const ordinaryCloseDayRemove = chrome.tabs.remove;
chrome.tabs.remove = async (ids) => {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const found = findTab(id);
    if (found) removedCloseDayUrls.push(found.tab.url);
  }
  return ordinaryCloseDayRemove(ids);
};
let navigatedDuringAttempt = false;
let navigatedDuringSkippedWrite = false;
const onCloseDayReceipt = (changes) => {
  const receipts = Object.values(changes.closeDayReceipts?.newValue ?? {});
  const targets = receipts.at(-1)?.windows?.flatMap((window) => window.tabs) ?? [];
  const first = targets.find((target) => target.tabId === 51);
  const second = targets.find((target) => target.tabId === 52);
  if (!navigatedDuringAttempt && first?.status === "attempted" && second?.status === "attempted") {
    navigatedDuringAttempt = true;
    const found = findTab(51);
    if (found) found.tab.url = "https://valuable-first-replacement.test/form";
    return;
  }
  if (!navigatedDuringSkippedWrite && first?.status === "skipped" &&
      second?.status === "attempted") {
    navigatedDuringSkippedWrite = true;
    const found = findTab(52);
    if (found) found.tab.url = "https://valuable-second-replacement.test/form";
  }
};
storage.onChanged.addListener(onCloseDayReceipt);
const raceDraft = await captureCloseDayReview({ protectedTabId: 53, refresh: true });
const raceCommit = await commitCloseDay(raceDraft.draftId);
storage.onChanged.removeListener(onCloseDayReceipt);
chrome.tabs.remove = ordinaryCloseDayRemove;
const raceTargets = raceCommit.receipt.windows.flatMap((window) => window.tabs);
check(navigatedDuringAttempt && !navigatedDuringSkippedWrite &&
  findTab(51)?.tab.url === "https://valuable-first-replacement.test/form" && !findTab(52) &&
  removedCloseDayUrls.join() === "https://second-reviewed.test" &&
  raceTargets.find((target) => target.tabId === 51)?.status === "skipped" &&
  raceTargets.find((target) => target.tabId === 52)?.status === "closed" &&
  raceCommit.receipt.result.closed === 1 && raceCommit.receipt.result.skipped === 1,
"Close the day skips navigation during receipt persistence and attributes Undo only to the original tab it closed");

// A transient post-remove receipt failure retries the already-known exact
// closed/survived ledger instead of widening it through absence inference.
await storage.local.set({
  sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, snoozes: {},
  archiveOverlay: {}, sessionWindows: {}, organizationGroups: {}, organizationMemberships: {},
  counters: {}, journal: [], closeDayDraft: null, closeDayReceipts: {}
});
browserWindows = [{ id: 60, type: "normal", incognito: false, tabs: [
  { id: 61, windowId: 60, index: 0, url: "https://settlement.test", title: "Settle",
    pinned: false, audible: false },
  { id: 62, windowId: 60, index: 1, url: "chrome-extension://test/dashboard.html#close-day",
    title: "Review", pinned: false, audible: false }
] }];
const settlementDraft = await captureCloseDayReview({ protectedTabId: 62, refresh: true });
const nativeStorageSet = chrome.storage.local.set;
let rejectedExactSettlement = false;
chrome.storage.local.set = async (values) => {
  const receipts = Object.values(values.closeDayReceipts ?? {});
  const targets = receipts.at(-1)?.windows?.flatMap((window) => window.tabs) ?? [];
  if (!rejectedExactSettlement && targets.some((target) => target.status === "closed")) {
    rejectedExactSettlement = true;
    throw new Error("transient receipt settlement failure");
  }
  return nativeStorageSet(values);
};
const settlementCommit = await commitCloseDay(settlementDraft.draftId);
chrome.storage.local.set = nativeStorageSet;
check(rejectedExactSettlement && settlementCommit.ok &&
  settlementCommit.receipt.result.closed === 1 && settlementCommit.receipt.result.skipped === 0,
"Close the day retries its exact post-remove ledger after a transient receipt failure");

await storage.local.set({
  sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, snoozes: {},
  archiveOverlay: {}, sessionWindows: {}, organizationGroups: {}, organizationMemberships: {},
  counters: {}, journal: [], closeDayDraft: null, closeDayReceipts: {}
});
browserWindows = [{ id: 70, type: "normal", incognito: false, tabs: [
  { id: 71, windowId: 70, index: 0, url: "https://skip-settlement.test", title: "Skip",
    pinned: false, audible: false },
  { id: 72, windowId: 70, index: 1, url: "chrome-extension://test/dashboard.html#close-day",
    title: "Review", pinned: false, audible: false }
] }];
const skipDraft = await captureCloseDayReview({ protectedTabId: 72, refresh: true });
let navigatedForSkip = false;
const onSkipAttempt = (changes) => {
  const targets = Object.values(changes.closeDayReceipts?.newValue ?? {})
    .at(-1)?.windows?.flatMap((window) => window.tabs) ?? [];
  if (!navigatedForSkip && targets.some((target) => target.tabId === 71 &&
      target.status === "attempted")) {
    navigatedForSkip = true;
    findTab(71).tab.url = "https://valuable-skip-replacement.test/form";
  }
};
storage.onChanged.addListener(onSkipAttempt);
const nativeSkipSet = chrome.storage.local.set;
let rejectedSkipSettlement = false;
chrome.storage.local.set = async (values) => {
  const targets = Object.values(values.closeDayReceipts ?? {})
    .at(-1)?.windows?.flatMap((window) => window.tabs) ?? [];
  if (!rejectedSkipSettlement && targets.some((target) => target.tabId === 71 &&
      target.status === "skipped")) {
    rejectedSkipSettlement = true;
    throw new Error("transient skip settlement failure");
  }
  return nativeSkipSet(values);
};
const skipCommit = await commitCloseDay(skipDraft.draftId);
chrome.storage.local.set = nativeSkipSet;
storage.onChanged.removeListener(onSkipAttempt);
check(navigatedForSkip && rejectedSkipSettlement && skipCommit.ok &&
  skipCommit.receipt.result.closed === 0 && skipCommit.receipt.result.skipped === 1 &&
  findTab(71)?.tab.url === "https://valuable-skip-replacement.test/form",
"Close the day retries an exact skip-only settlement without attributing a later disappearance");

/* Model durable receipts left by a worker interruption. Undo must use the
 * settled close ledger, not the pending snapshot it read before resuming. */
for (const scenario of ["saved", "closing", "navigated"]) {
  await storage.local.set({
    sessions: {}, sessionNamedRecords: {}, inbox: {}, archive: {}, snoozes: {},
    archiveOverlay: {}, sessionWindows: {}, organizationGroups: {}, organizationMemberships: {},
    counters: {}, journal: [], closeDayDraft: null, closeDayReceipts: {}
  });
  const originals = [
    { id: 81, windowId: 80, index: 0, url: "https://undo-first.test", title: "First",
      pinned: false, audible: false },
    { id: 82, windowId: 80, index: 1, url: "https://undo-second.test", title: "Second",
      pinned: false, audible: false },
    { id: 83, windowId: 80, index: 2, url: "chrome-extension://test/dashboard.html#close-day",
      title: "Review", pinned: false, audible: false }
  ];
  browserWindows = [{ id: 80, type: "normal", incognito: false, tabs: structuredClone(originals) }];
  const draft = await captureCloseDayReview({ protectedTabId: 83, refresh: true });
  const commit = await commitCloseDay(draft.draftId);
  const interrupted = structuredClone(commit.receipt);
  interrupted.phase = scenario === "closing" ? "closing" : "saved";
  delete interrupted.result;
  delete interrupted.completedAt;
  for (const target of interrupted.windows.flatMap((window) => window.tabs)) {
    // An attempted tab that disappeared before settlement must be recovered.
    target.status = scenario === "closing" && target.tabId === 81 ? "attempted" : "pending";
  }
  browserWindows = [{ id: 80, type: "normal", incognito: false,
    tabs: structuredClone(originals.filter((tab) => scenario !== "closing" || tab.id !== 81)) }];
  if (scenario === "navigated") findTab(82).tab.url = "https://new-unsaved-work.test";
  await storage.local.set({ closeDayReceipts: { [commit.transactionId]: interrupted } });

  const result = await undoCloseDayTransaction(commit.transactionId);
  const expected = scenario === "navigated" ? 1 : 2;
  const settled = storage.snapshot().closeDayReceipts[commit.transactionId];
  const ledger = settled.windows.flatMap((window) => window.tabs);
  const reopenedUrls = browserWindows.filter((window) => window.id !== 80)
    .flatMap((window) => window.tabs.map((tab) => tab.url)).sort();
  check(result.status === "undone" && result.reopened === expected &&
    settled.reopenResult.expected === expected &&
    ledger.filter((tab) => tab.status === "closed").length === expected &&
    ledger.every((tab) => ["closed", "skipped"].includes(tab.status)),
  `Undo from ${scenario} preserves the newly settled close ledger and reopens every closed occurrence`);
  check(reopenedUrls.join() === (expected === 2
    ? "https://undo-first.test,https://undo-second.test" : "https://undo-first.test") &&
    (scenario !== "navigated" || findTab(82)?.tab.url === "https://new-unsaved-work.test"),
  `Undo from ${scenario} reopens only the exact closed addresses and preserves any changed live page`);
  check(storage.snapshot().journal.find((entry) => entry.id === settled.journalId)?.undone === true &&
    Object.values(storage.snapshot().inbox).every((item) => item.deletedAt),
  `Undo from ${scenario} rolls back its saved output and Activity entry with the receipt`);
  const countBeforeRetry = reopenedUrls.length;
  const repeated = await undoCloseDayTransaction(commit.transactionId);
  check(repeated.status === "unavailable" &&
    browserWindows.filter((window) => window.id !== 80).flatMap((window) => window.tabs).length === countBeforeRetry,
  `Undo from ${scenario} cannot reopen its occurrences twice`);
}

if (failures) {
  console.error(`\n${failures} Close-the-day test(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: Close-the-day planner, save-first coordinator, close receipt, and Undo");
