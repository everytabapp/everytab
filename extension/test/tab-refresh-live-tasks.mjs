/**
 * Tab and window signals refresh only what depends on live tabs. Needs you
 * reuses the saved inputs of its last complete refresh, navigation updates
 * only the Open and Duplicates counts, and a storage flush shares one Inbox
 * and Snoozed clone between navigation and Needs you.
 *
 *     node test/tab-refresh-live-tasks.mjs   (from extension/)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage } from "./e2-mocks.mjs";

const dom = installDomFixture();
const now = Date.now();
const DAY = 86_400_000;
const ist = createInterleavableStorage({
  inbox: {
    old: { id: "old", kind: "tab", source: "dump", createdAt: now - 9 * DAY, modifiedAt: now - 9 * DAY,
      labels: [], tabs: [{ url: "https://old.example/", title: "Old" }] }
  },
  snoozes: {
    due: { id: "due", url: "https://due.example/", title: "Due", dueAt: now - 60_000, modifiedAt: now - DAY }
  },
  journal: [],
  settings: { inboxExpiryDays: 0, duplicateDomainRules: [] }
});
let openTabs = [
  { id: 1, windowId: 1, url: "https://a.example/", title: "A" },
  { id: 2, windowId: 1, url: "https://b.example/", title: "B" }
];
const windowsOf = () => [{ id: 1, type: "normal", incognito: false, tabs: openTabs }];
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://live/${path}` },
  storage: { local: ist.local, onChanged: ist.onChanged },
  tabs: { query: async () => structuredClone(openTabs) },
  windows: { getAll: async () => structuredClone(windowsOf()) }
};
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const { STORE_KEYS } = await import("../js/lib/types.js");
const { listItems } = await import("../js/lib/store.js");
const { createDisplayTabReads } = await import("../js/ui/display-tab-reads.js");
const { createPageUtilities } = await import("../js/ui/command-box.js");
const { readLabelNavigationSnapshot } = await import("../js/lib/labels.js");
const {
  TAB_REFRESH_TASKS, LIVE_ONLY_REFRESH_TASKS, withoutSupersededLiveTasks, dashboardTasksForStorage
} = await import("../js/ui/refresh-scheduler.js");

/* ---- scheduler contract ---- */
assert.deepEqual([...TAB_REFRESH_TASKS], ["open", "attentionLive", "duplicates", "navOpen"]);
assert.deepEqual(LIVE_ONLY_REFRESH_TASKS, { attentionLive: "attention", navOpen: "nav" });
assert.deepEqual(withoutSupersededLiveTasks(["open", "attentionLive", "duplicates", "navOpen"]),
  ["open", "attentionLive", "duplicates", "navOpen"], "a pure tab burst keeps every live task");
assert.deepEqual(withoutSupersededLiveTasks(["attentionLive", "navOpen", "nav", "attention", "open"]),
  ["nav", "attention", "open"], "complete tasks in the same flush supersede the live variants");
assert.deepEqual(withoutSupersededLiveTasks(["attentionLive", "nav"]), ["attentionLive", "nav"],
  "an unrelated complete task does not drop a live variant");
for (const key of ["inbox", "snoozes", "journal", "vaultMetaV2", "sessions", "sessionWindows", "settings"]) {
  const tasks = dashboardTasksForStorage({ [key]: {} });
  assert.ok(tasks.includes("attention"), `${key} changes schedule the complete Needs-you refresh`);
  assert.ok(!tasks.includes("attentionLive") && !tasks.includes("navOpen"),
    `${key} changes never schedule live-only variants`);
}

/* ---- Needs you: live-only refresh reuses saved inputs ---- */
const utilities = createPageUtilities({ go: () => {} });
dom.document.body.append(utilities.attention);
const labels = () => [...utilities.attention.querySelectorAll(".page-attention-link, .page-attention-entry")]
  .map((node) => node.textContent);
const attentionText = () => utilities.attention.textContent;

// Live-only before any complete refresh falls back to a complete read.
await utilities.refreshAttention(createDisplayTabReads(), { liveOnly: true });
const firstText = attentionText();
assert.match(firstText, /overdue/, "the overdue snooze is reported by the fallback complete read");
assert.match(firstText, /Inbox waiting/, "the old Inbox record is reported");

// A tab burst: duplicates appear without any saved-store read.
openTabs = [...openTabs, { id: 3, windowId: 1, url: "https://a.example/", title: "A again" }];
const readsBefore = ist.getLog.length;
await utilities.refreshAttention(createDisplayTabReads(), { liveOnly: true });
assert.match(attentionText(), /1 duplicate/, "live duplicates refresh from the display snapshot");
assert.match(attentionText(), /overdue/, "saved inputs are retained");
const liveReads = ist.getLog.slice(readsBefore).flat();
assert.ok(!liveReads.some((key) => ["inbox", "snoozes", "journal", "archive", "sessions"].includes(key)),
  `a live-only refresh reads no saved family (${liveReads.join(",")})`);

// The live-only output equals a complete refresh over the same state.
const liveText = attentionText();
await utilities.refreshAttention(createDisplayTabReads());
assert.equal(attentionText(), liveText, "live-only and complete refreshes agree while saved data is unchanged");

// A saved change arrives through storage, which schedules the complete task;
// the next live-only refresh then reuses the new inputs.
await ist.local.set({ snoozes: {} });
await utilities.refreshAttention(createDisplayTabReads());
assert.doesNotMatch(attentionText(), /overdue/, "the complete refresh drops the resolved snooze");
openTabs = openTabs.slice(0, 2);
await utilities.refreshAttention(createDisplayTabReads(), { liveOnly: true });
assert.doesNotMatch(attentionText(), /duplicate|overdue/, "live-only sees the new saved inputs and no duplicates");
void labels;

/* ---- shared reads: one Inbox clone for nav library and Needs you ---- */
{
  let inboxLists = 0;
  const reads = {
    ...createDisplayTabReads(),
    inboxItems: (() => { let read; return () => read ??= (inboxLists += 1, listItems(STORE_KEYS.inbox)); })(),
    snoozeItems: (() => { let read; return () => read ??= listItems(STORE_KEYS.snoozes); })()
  };
  const [library] = await Promise.all([
    readLabelNavigationSnapshot(reads), reads.inboxItems(), utilities.refreshAttention(reads)
  ]);
  assert.equal(inboxLists, 1, "label navigation and Needs you share the refresh's Inbox read");
  assert.equal(library.archiveCount, 0);
  assert.deepEqual(await readLabelNavigationSnapshot(), library, "the shared read changes no result");
}

/* ---- Dashboard wiring (source shape) ---- */
{
  const dashboard = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  assert.ok(dashboard.includes("  navOpen: renderNavOpen,") && dashboard.includes("  attentionLive: renderAttentionLive,"),
    "the refresh runners include both live-only variants");
  assert.ok(dashboard.includes("queueDashboardRefresh(TAB_REFRESH_TASKS);"),
    "tab bursts still queue the shared tab task list");
  assert.ok(dashboard.includes("const tasks = withoutSupersededLiveTasks(requested);"),
    "a refresh drops live variants superseded by complete tasks");
  assert.ok(dashboard.includes("pageUtilities.refreshAttention(reads, { liveOnly: true })"));
  assert.ok(dashboard.includes("readLabelNavigationSnapshot(reads)") &&
    dashboard.includes("reads.inboxItems()") && dashboard.includes("reads.snoozeItems()"),
    "navigation derives Inbox and Snoozed counts from the shared refresh reads");
  const navOpen = dashboard.slice(dashboard.indexOf("const renderNavOpen ="), dashboard.indexOf("/* ---- hero"));
  assert.ok(!/listItems|readLabelNavigationSnapshot|inboxItems|snoozeItems/.test(navOpen),
    "the live navigation count path reads no saved family");
}

dom.restore();
console.log("PASS: tab signals refresh live counts and Needs you without saved-library reads");
