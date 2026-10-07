import assert from "node:assert/strict";

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { onChanged: { addListener() {}, removeListener() {} } },
  tabs: { query: async () => [] },
  windows: { getAll: async () => [] }
};

const {
  projectInboxAutomationAwareness,
  projectOpenAutomationAwareness,
  projectOpenTabAwareness
} = await import("../js/lib/automation-awareness-policy.js");

const HOUR = 3_600_000;
const DAY = 86_400_000;
const now = 20 * DAY;
const baseSettings = {
  suspendEnabled: true,
  suspendAfterMinutes: 60,
  suspendMinTabs: 0,
  suspendMaxTabs: 0,
  suspendWhitelist: [],
  autoArchiveEnabled: true,
  autoDumpAfterMinutes: 7 * 1440,
  autoArchiveDays: 7,
  autoSaveMaxTabs: 0,
  archiveWhitelist: [],
  inboxExpiryDays: 30
};
const snapshot = (settings = {}, activityByTabId = {}, temporarySuspendExemptions = {}) => ({
  now,
  settings: { ...baseSettings, ...settings },
  activityByTabId,
  temporarySuspendExemptions
});
const tab = (overrides = {}) => ({
  id: 1, windowId: 1, index: 0, active: false, pinned: false,
  audible: false, incognito: false, groupId: -1,
  url: "https://example.com/article", title: "Article",
  ...overrides
});

const timed = projectOpenTabAwareness(
  tab({ lastAccessed: now - 12 * DAY }), snapshot({}, { 1: now - 45 * 60_000 }), 12
);
assert.equal(timed.action, "suspend");
assert.equal(timed.display, "timed");
assert.equal(timed.progress, 0.75);
assert.equal(timed.awayMs, 45 * 60_000,
  "the UI clock comes from tabActivity, never Chrome lastAccessed");

const pinned = projectOpenTabAwareness(tab({ pinned: true }), snapshot(), 12);
assert.equal(pinned.reason, "pinned");
assert.equal(pinned.progress, null);

const autosavePastSuspendRule = projectOpenTabAwareness(
  tab(), snapshot({ suspendWhitelist: ["example.com"] }, { 1: now - 2 * DAY }), 12
);
assert.equal(autosavePastSuspendRule.reason, "automation-protected",
  "a historical Suspension exception now protects from both automatic actions");
assert.equal(autosavePastSuspendRule.display, "state");

const suspendPastKeepOpenRule = projectOpenTabAwareness(
  tab(), snapshot({ archiveWhitelist: ["example.com"] }, { 1: now - 30 * 60_000 }), 12
);
assert.equal(suspendPastKeepOpenRule.reason, "automation-protected",
  "a historical Auto-save exception now protects from both automatic actions");

const temporaryProtection = projectOpenTabAwareness(
  tab(), snapshot({}, { 1: now - 2 * DAY }, {
    "https://example.com/article": now + HOUR
  }), 12
);
assert.equal(temporaryProtection.reason, "automation-protected",
  "the popup's 24-hour page protection covers both automatic actions");

const suspended = projectOpenTabAwareness(tab({
  url: "chrome-extension://test/suspend.html?originalUrl=https%3A%2F%2Fexample.com%2Farticle"
}), snapshot({}, { 1: now - 6 * DAY }), 12);
assert.equal(suspended.action, "save", "an EveryTab-suspended tab remains Auto-saveable");
assert.equal(suspended.progress, 6 / 7);

const unknown = projectOpenTabAwareness(tab(), snapshot(), 12);
assert.equal(unknown.state, "unknown");
assert.equal(unknown.progress, null);
assert.equal(projectOpenTabAwareness(tab(), snapshot({}, { 1: null }), 12).state,
  "unknown", "missing activity must not become an epoch timestamp");

const minimum = projectOpenTabAwareness(tab(), snapshot({
  autoArchiveEnabled: false, suspendMinTabs: 20
}, { 1: now - 4 * HOUR }), 12);
assert.equal(minimum.state, "minimum-count");
assert.equal(minimum.limit, 20);
assert.equal(minimum.progress, null);

const cap = projectOpenTabAwareness(tab(), snapshot({
  suspendEnabled: false, autoArchiveEnabled: false, suspendMaxTabs: 30
}), 40);
assert.equal(cap.action, "awake-cap");
assert.equal(cap.progress, null, "count limits never receive time progress");

const active = projectOpenTabAwareness(tab({ active: true }), snapshot({}, { 1: now - DAY }), 12);
assert.equal(active.state, "active");
assert.equal(active.progress, null,
  "a background-window selected tab does not receive a fictional row timer");
const protectedActive = projectOpenTabAwareness(tab({ active: true }),
  snapshot({ suspendWhitelist: ["page:https://example.com/article"] }), 12);
assert.equal(protectedActive.state, "active");
assert.equal(protectedActive.protection.protected, true,
  "Active must not conceal an explicit protection");
const protectedWithAutomationOff = projectOpenTabAwareness(tab(), snapshot({
  suspendEnabled: false, autoArchiveEnabled: false, suspendWhitelist: ["example.com"]
}), 12);
assert.equal(protectedWithAutomationOff.protection.protected, true);
assert.equal(protectedWithAutomationOff.display, "state");
assert.equal(projectOpenTabAwareness(tab({ active: true }), snapshot({
  suspendEnabled: false, autoArchiveEnabled: false, suspendWhitelist: ["site:example.com"]
}), 12).state, "active", "timers off must not hide the active state of a protected tab");

const layeredProtection = projectOpenTabAwareness(tab(), {
  ...snapshot({ suspendWhitelist: ["site:example.com"] }),
  tabProtections: { 1: { expiresAt: now + HOUR } }
}, 12);
assert.equal(layeredProtection.protection.kind, "tab");
assert.equal(layeredProtection.protection.afterExpiry.kind, "site",
  "temporary expiry must reveal the website rule beneath it without a new data read");

const projected = projectOpenAutomationAwareness([
  { id: 1, focused: true, tabs: [tab(), tab({ id: 2, pinned: true })] }
], snapshot({}, { 1: now - 30 * 60_000, 2: now - DAY }));
assert.equal(projected.size, 2);
assert.equal(projected.get(2).reason, "pinned");
const windowCounts = projectOpenAutomationAwareness([
  { type: "normal", tabs: [tab()] },
  { type: "normal", incognito: true, tabs: [tab({ id: 2, incognito: true })] },
  { type: "popup", tabs: [tab({ id: 3 }), tab({ id: 4 })] }
], snapshot({ autoArchiveEnabled: false, suspendMinTabs: 2 }, {
  1: now - HOUR, 3: now - 10 * 60_000, 4: now - 5 * 60_000
}));
assert.equal(windowCounts.size, 1, "only ordinary non-private rows receive projections");
assert.equal(windowCounts.get(1).display, "timed",
  "Suspension minimum uses the same all-window count as its effect");

const recentFloor = projectOpenAutomationAwareness([
  { type: "normal", tabs: [
    tab({ id: 11, lastAccessed: now - 4 * HOUR }),
    tab({ id: 12, lastAccessed: now - 3 * HOUR }),
    tab({ id: 13, lastAccessed: now - 2 * HOUR })
  ] }
], snapshot({ autoArchiveEnabled: false, suspendMinTabs: 2 }, {
  11: now - 4 * HOUR, 12: now - 3 * HOUR, 13: now - 2 * HOUR
}));
assert.equal(recentFloor.get(11).display, "timed",
  "the least-recent eligible tab remains a time-based suspension candidate");
assert.equal(recentFloor.get(12).state, "minimum-count");
assert.equal(recentFloor.get(13).state, "minimum-count",
  "the configured recent floor protects the two most recently used eligible tabs");

const inbox = projectInboxAutomationAwareness([
  { id: "created", createdAt: now - 12 * DAY, modifiedAt: now - DAY },
  { id: "legacy", modifiedAt: now - 31 * DAY },
  { id: "unknown" }
], snapshot());
assert.equal(inbox.get("created").savedAt, now - 12 * DAY);
assert.equal(inbox.get("legacy").savedAt, now - 31 * DAY,
  "legacy Inbox clocks use modifiedAt when createdAt is unavailable");
assert.equal(inbox.get("unknown").display, "unknown");
assert.equal(projectInboxAutomationAwareness([
  { id: "null", createdAt: null, modifiedAt: now - DAY }
], snapshot()).get("null").savedAt, now - DAY,
"null createdAt uses the same valid modifiedAt fallback as the expiry effect");

const { dashboardTasksForStorage } = await import("../js/ui/refresh-scheduler.js");
assert.deepEqual(dashboardTasksForStorage({ tabActivity: { newValue: {} } }), ["open"]);
assert.deepEqual(dashboardTasksForStorage({ suspendTemporaryExemptions: { newValue: {} } }), ["open"]);
const settingTasks = dashboardTasksForStorage({ settings: {
  oldValue: { inboxExpiryDays: 0 }, newValue: { inboxExpiryDays: 30 }
} });
assert.ok(settingTasks.includes("open") && settingTasks.includes("inbox"));

const inboxOff = projectInboxAutomationAwareness([
  { id: "off", createdAt: now - 12 * DAY }
], snapshot({ inboxExpiryDays: 0 }));
assert.equal(inboxOff.get("off").display, "age-only");
assert.equal(inboxOff.get("off").settingsGroup, null);

console.log("automation-awareness policy projection: pass");
