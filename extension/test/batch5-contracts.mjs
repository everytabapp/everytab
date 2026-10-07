import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const bootSource = readFileSync(new URL("../js/boot.js", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../js/lib/search.js", import.meta.url), "utf8");
const archiveSource = readFileSync(new URL("../js/lib/archive.js", import.meta.url), "utf8");
const listConfigSource = readFileSync(new URL("../js/ui/list-configs.js", import.meta.url), "utf8");
const restoreSource = readFileSync(new URL("../js/ui/restore-panel.js", import.meta.url), "utf8");
const closeDaySource = readFileSync(new URL("../js/ui/close-day-surface.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const activitySource = readFileSync(new URL("../js/ui/activity-surface.js", import.meta.url), "utf8");

function runBoot(pathname) {
  let populatedReads = 0;
  const attributes = new Map();
  const context = vm.createContext({
    location: { pathname },
    localStorage: { getItem: () => null },
    document: {
      documentElement: {
        style: { setProperty() {} },
        setAttribute: (name, value) => attributes.set(name, value)
      },
      head: { appendChild() {} },
      createElement: () => ({})
    },
    window: { innerWidth: 1280 },
    chrome: {
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
      windows: {
        getAll: async (options) => {
          if (options?.populate) populatedReads += 1;
          return [];
        }
      }
    }
  });
  context.globalThis = context;
  vm.runInContext(bootSource, context);
  return { populatedReads, early: context.__everyTabEarlyOpenWindows };
}

const directDashboard = runBoot("/dashboard.html");
assert.equal(directDashboard.populatedReads, 0,
  "direct Dashboard preloads code without creating an unconsumed populated-window query");
const dashboardNewTab = runBoot("/newtab.html");
assert.equal(dashboardNewTab.populatedReads, 1,
  "Dashboard New Tab creates exactly one early populated-window query for its entry consumer");
assert.ok(dashboardNewTab.early instanceof Promise,
  "Dashboard New Tab publishes its early populated-window promise");

const nativeStructuredClone = globalThis.structuredClone;
let cloneCalls = 0;
globalThis.structuredClone = (value) => {
  cloneCalls += 1;
  return nativeStructuredClone(value);
};
const storageListeners = new Set();
const storeValues = {
  inbox: {
    one: {
      id: "one", modifiedAt: 1,
      tabs: [{ url: "https://one.example", title: "One" }]
    }
  }
};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(
        (typeof keys === "string" ? [keys] : keys)
          .filter((key) => Object.hasOwn(storeValues, key))
          .map((key) => [key, JSON.parse(JSON.stringify(storeValues[key]))])
      )
    },
    onChanged: {
      addListener: (listener) => storageListeners.add(listener),
      removeListener: (listener) => storageListeners.delete(listener)
    }
  }
};
installBrowserMapStorageAuthority();
const store = await import(`../js/lib/store.js?batch5=${Date.now()}`);
const miss = await store.listItems("inbox");
assert.equal(cloneCalls, 1,
  "a cache miss makes one ownership clone at the caller seam");
miss[0].tabs[0].url = "https://caller-mutated.example";
const hit = await store.listItems("inbox");
assert.equal(cloneCalls, 2,
  "a cache hit makes the same one ownership clone at the caller seam");
assert.equal(hit[0].tabs[0].url, "https://one.example",
  "caller mutation cannot contaminate the private cache snapshot");
globalThis.structuredClone = nativeStructuredClone;

const getLog = [];
const navigationValues = {
  inbox: {
    inbox1: { id: "inbox1", modifiedAt: 4, tabs: [{ url: "https://inbox.example", title: "Inbox", labels: ["Work"] }] }
  },
  archive: {
    archive1: { id: "archive1", modifiedAt: 3, tabs: [{ url: "https://archive.example", title: "Archive", labels: ["Work"] }] }
  },
  archiveOverlay: {},
  sessions: {
    named: { id: "named", name: "Named", modifiedAt: 2, windows: [[{ url: "https://session.example", title: "Session", labels: ["Research"] }]] },
    automatic: { id: "automatic", name: "Snapshot", auto: true, modifiedAt: 1, windows: [[]] }
  },
  labelMeta: { Work: 10, Research: 9 }
};
const navListeners = new Set();
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const requested = typeof keys === "string" ? [keys] : [...keys];
        getLog.push([...requested].sort());
        return Object.fromEntries(requested
          .filter((key) => Object.hasOwn(navigationValues, key))
          .map((key) => [key, nativeStructuredClone(navigationValues[key])]));
      }
    },
    onChanged: {
      addListener: (listener) => navListeners.add(listener),
      removeListener: (listener) => navListeners.delete(listener)
    }
  }
};
const labels = await import(`../js/lib/labels.js?batch5=${Date.now()}`);
const navigation = await labels.readLabelNavigationSnapshot();
assert.equal(navigation.archiveCount, 1);
assert.equal(navigation.namedSessions.length, 1);
assert.equal(navigation.snapshotCount, 1);
assert.deepEqual(navigation.labelGroups.map((group) => group.label), ["Research", "Work"]);
assert.equal(getLog.length, 4,
  "navigation derives Archive count, Sessions, Snapshots, and Labels from four shared reads");
assert.equal(getLog.filter((keys) => keys.includes("archive")).length, 1,
  "navigation reads the large Archive map once");
assert.equal(getLog.filter((keys) => keys.includes("sessions")).length, 1,
  "navigation reads the large Sessions map once");

assert.doesNotMatch(searchSource,
  /\.sort\(\(a, b\) => b\.tabs - a\.tabs \|\| a\.domain\.localeCompare\(b\.domain\)\)\s*\.sort\(\(a, b\) => b\.tabs - a\.tabs \|\| a\.domain\.localeCompare\(b\.domain\)\)/,
  "no Search domain-facet path repeats the same deterministic sort");

const { inferJournalDescriptor } = await import("../js/lib/journal-descriptor.js");
assert.deepEqual(
  inferJournalDescriptor("Moved 4 tabs to “Research”"),
  { actionKind: "moved-tabs-session", actionParams: { count: 4, name: "Research" } },
  "new Journal writes derive a stable Activity kind and bounded parameters"
);
assert.equal(inferJournalDescriptor("Old imported wording"), null,
  "unknown historical Journal wording remains a compatibility fallback");
globalThis.chrome.i18n = createChromeI18nMock();
const { activityEntryLabel, activityAttentionLabel } =
  await import(`../js/ui/activity-copy.js?batch5=${Date.now()}`);
assert.equal(activityEntryLabel({
  label: "compatibility fallback", actionKind: "moved-tabs-session",
  actionParams: { count: 4, name: "Research" }
}), "Moved 4 tabs to “Research”",
"Activity renders structured records through the locale catalogue");
assert.equal(activityEntryLabel({ label: "Readable old action" }), "Readable old action",
  "Activity preserves readable labels for old and imported Journal records");
assert.equal(activityEntryLabel({
  label: "compatibility fallback", actionKind: "deleted-saved-item",
  actionParams: { location: "archive" }
}), "Deleted an Archive item",
"Activity localizes language-neutral saved-location parameters");
const namedAutoSave = {
  label: "compatibility fallback", actionKind: "auto-saved-tabs",
  actionParams: { count: 1, name: "Project brief" }
};
assert.equal(activityEntryLabel(namedAutoSave), "Auto-saved “Project brief” to the Inbox",
  "one-tab automatic Activity names the tab it saved");
assert.equal(activityAttentionLabel(namedAutoSave), "Saved “Project brief” to Inbox",
  "Needs you uses a shorter title-aware automatic label");
const namedAutoSaveBatch = {
  label: "compatibility fallback", actionKind: "auto-saved-tabs",
  actionParams: { count: 3, name: "Project brief" }
};
assert.equal(activityEntryLabel(namedAutoSaveBatch),
  "Auto-saved “Project brief” and 2 more to the Inbox",
  "multi-tab automatic Activity identifies the first affected link");
assert.equal(activityAttentionLabel(namedAutoSaveBatch),
  "Saved “Project brief” +2 to Inbox",
  "multi-tab automatic Needs you stays compact while identifying the affected links");
const namedAutoArchive = {
  label: "compatibility fallback", actionKind: "auto-archived-items",
  actionParams: { count: 1, name: "Project brief" }
};
assert.equal(activityEntryLabel(namedAutoArchive),
  "Auto-archived “Project brief” from the Inbox",
  "one-item automatic expiry identifies the affected link in Activity");
assert.equal(activityAttentionLabel(namedAutoArchive),
  "Archived “Project brief” from Inbox",
  "one-item automatic expiry identifies the affected link in Needs you");
const namedAutoArchiveBatch = {
  label: "compatibility fallback", actionKind: "auto-archived-items",
  actionParams: { count: 3, name: "Project brief" }
};
assert.equal(activityEntryLabel(namedAutoArchiveBatch),
  "Auto-archived “Project brief” and 2 more from the Inbox",
  "multi-item automatic expiry identifies its first affected link in Activity");
assert.equal(activityAttentionLabel(namedAutoArchiveBatch),
  "Archived “Project brief” +2 from Inbox",
  "multi-item automatic expiry stays compact while identifying the affected links");
const earlierAutoSave = {
  label: "Auto-saved 2 tabs to the Inbox", actionKind: "auto-saved-tabs",
  actionParams: { count: 2 },
  reopen: [[{ title: "Earlier project", url: "https://earlier.example" }]]
};
assert.equal(activityEntryLabel(earlierAutoSave),
  "Auto-saved “Earlier project” and 1 more to the Inbox",
  "an earlier automatic save recovers its link name from its existing Undo payload");
const earlierAutoArchive = {
  label: "Auto-archived 1 Inbox item", actionKind: "auto-archived-items",
  actionParams: { count: 1 },
  puts: [{ store: "inbox", item: {
    id: "earlier", tabs: [{ title: "Earlier project", url: "https://earlier.example" }]
  } }]
};
assert.equal(activityAttentionLabel(earlierAutoArchive),
  "Archived “Earlier project” from Inbox",
  "an earlier automatic expiry recovers its link name from its existing Undo payload");

for (const [source, oldCopy, name] of [
  [archiveSource, "Tabs auto-saved to Inbox", "automatic Archive notifications"],
  [listConfigSource, "Select tabs to wake or cancel.", "Snoozed list controls"],
  [restoreSource, "Choose EveryTab backup", "Restore workflow"],
  [closeDaySource, "Preparing the review", "Close-the-day workflow"],
  [dashboardSource, "Format not recognized", "Dashboard import outcomes"]
]) {
  assert.ok(source.includes("localeMessage(") && !source.includes(oldCopy),
    `${name} use the packaged locale catalogue instead of presentation literals`);
}
assert.ok(activitySource.includes("activityEntryLabel(entry)"),
  "Activity renders structured descriptors rather than persisted English labels");

console.log("PASS: Batch 5 cold-read ownership, duplicate-work, and Activity contracts");
