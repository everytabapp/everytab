import assert from "node:assert/strict";
import {
  createFrameRefreshScheduler,
  createForegroundTaskQueue,
  createInteractionRefreshGate,
  dashboardTasksForStorage
} from "../js/ui/refresh-scheduler.js";
import {
  NAMED_SESSION_RECORDS_KEY,
  SESSION_IDENTITY_INDEX_KEY,
  SESSION_NAVIGATION_REVISION_KEY
} from "../js/lib/session-identity-index.js";
import { DUPLICATE_DOMAIN_RULES_KEY } from "../js/lib/duplicate-domain-rules.js";

const frames = [];
let foreground = true;
const runs = [];
const scheduler = createFrameRefreshScheduler(
  async (tasks) => { runs.push(tasks); },
  { requestFrame: (callback) => frames.push(callback), canRun: () => foreground }
);

scheduler.request(["attention", "openWarm"]);
assert.equal(frames.length, 1, "a foreground request schedules one frame");
foreground = false;
await frames.shift()();
assert.deepEqual(runs, [], "a hidden frame does no work");
assert.equal(frames.length, 0, "a hidden frame does not reschedule itself");

scheduler.request("nav");
assert.equal(frames.length, 0, "hidden requests remain dirty without polling frames");
foreground = true;
scheduler.foreground();
assert.equal(frames.length, 1, "foreground wakes retained work");
await frames.shift()();
assert.deepEqual(runs, [["attention", "openWarm", "nav"]]);

let release;
const running = new Promise((resolve) => { release = resolve; });
const asyncRuns = [];
foreground = true;
const asyncScheduler = createFrameRefreshScheduler(
  async (tasks) => {
    asyncRuns.push(tasks);
    await running;
  },
  { requestFrame: (callback) => frames.push(callback), canRun: () => foreground }
);
asyncScheduler.request("open");
const flushing = frames.shift()();
asyncScheduler.request(["attention", "openWarm"]);
foreground = false;
release();
await flushing;
assert.deepEqual(asyncRuns, [["open"]], "follow-up work waits for the in-flight flush");
assert.equal(frames.length, 0, "hidden follow-up work remains dirty without a frame");
foreground = true;
asyncScheduler.foreground();
await frames.shift()();
assert.deepEqual(asyncRuns, [["open"], ["attention", "openWarm"]]);

for (const changes of [
  { sessionWindows: {} },
  { sessions: {} },
  { [NAMED_SESSION_RECORDS_KEY]: {} },
  { [SESSION_NAVIGATION_REVISION_KEY]: {} },
  { [SESSION_IDENTITY_INDEX_KEY]: {} }
]) {
  assert.ok(dashboardTasksForStorage(changes).includes("openWarm"));
}
// Linked Snooze cards project their Session's name and rows. Source repair,
// edits and deletion must invalidate that projection while respecting hidden UI.
for (const key of ["sessions", NAMED_SESSION_RECORDS_KEY, SESSION_NAVIGATION_REVISION_KEY]) {
  const tasks = dashboardTasksForStorage({ [key]: {} });
  assert.ok(tasks.includes("snoozes"), `${key} invalidates linked Snooze projection`);
  let visible = false;
  const refreshed = [];
  const queue = createForegroundTaskQueue(batch => refreshed.push(batch), {
    isForeground: () => visible
  });
  queue.request(tasks);
  assert.equal(refreshed.length, 0, "hidden Snooze refresh remains deferred");
  visible = true;
  queue.foreground();
  assert.ok(refreshed.flat().includes("snoozes"), "foregrounding refreshes repaired Session Snooze");
  assert.equal(tasks.includes("nav"), false, "Session repair avoids the full library navigation scan");
}
assert.ok(
  dashboardTasksForStorage({ [SESSION_IDENTITY_INDEX_KEY]: {} }).includes("open"),
  "identity changes also refresh the live Open section"
);
assert.deepEqual(
  dashboardTasksForStorage({ [DUPLICATE_DOMAIN_RULES_KEY]: {} }),
  ["duplicates", "attention", "nav"],
  "a domain matching rule refreshes every duplicate-count surface"
);
assert.deepEqual(
  dashboardTasksForStorage({
    settings: {
      oldValue: { duplicateDomainRules: [] },
      newValue: { duplicateDomainRules: [{ hostname: "tickets.example", mode: "skip" }] }
    }
  }),
  ["duplicates", "attention", "nav", "focus", "settings"],
  "a portable Settings domain rule refreshes duplicate counts and Settings surfaces"
);
assert.deepEqual(
  dashboardTasksForStorage({ [DUPLICATE_DOMAIN_RULES_KEY]: {} }, { statsVisible: true }),
  ["duplicates", "attention", "nav", "stats"],
  "visible Stats follows duplicate domain rules"
);

foreground = false;
const frameOperations = { attention: 0, openWarm: 0 };
const composedScheduler = createFrameRefreshScheduler(
  async (tasks) => {
    for (const task of tasks) {
      if (task in frameOperations) frameOperations[task] += 1;
    }
  },
  { requestFrame: (callback) => frames.push(callback), canRun: () => foreground }
);
const queue = createForegroundTaskQueue((tasks) => {
  composedScheduler.request(tasks);
}, { isForeground: () => foreground });
for (let tick = 0; tick < 4; tick += 1) {
  queue.request("attention");
  for (let event = 0; event < 25; event += 1) {
    queue.request(dashboardTasksForStorage({ sessions: {} }));
  }
}
assert.deepEqual(frameOperations, { attention: 0, openWarm: 0 },
  "inactive session events do not run refresh operations");
foreground = true;
queue.foreground();
queue.foreground();
assert.equal(frames.length, 1, "repeated foreground notifications do not duplicate the frame");
await frames.shift()();
assert.deepEqual(frameOperations, { attention: 1, openWarm: 1 },
  "100 session events and four attention polls coalesce into one frame");

const defaultFrames = [];
let defaultRuns = 0;
const defaultScheduler = createFrameRefreshScheduler(
  () => { defaultRuns += 1; },
  { requestFrame: (callback) => defaultFrames.push(callback) }
);
defaultScheduler.request("attention");
await defaultFrames.shift()();
assert.equal(defaultRuns, 1, "the default scheduler remains runnable");

let interactionHeld = true;
const interactionListeners = new Set();
let interactionRuns = 0;
const interactionGate = createInteractionRefreshGate(
  async () => { interactionRuns += 1; },
  {
    isHeld: () => interactionHeld,
    subscribe: (listener) => {
      interactionListeners.add(listener);
      return () => interactionListeners.delete(listener);
    }
  }
);
await interactionGate.request();
await interactionGate.request();
assert.equal(interactionRuns, 0,
  "an active row workflow holds live Open refreshes instead of replacing its anchor");
interactionHeld = false;
for (const listener of interactionListeners) listener();
await Promise.resolve();
await Promise.resolve();
assert.equal(interactionRuns, 1,
  "closing the row workflow reconciles every held signal with one refresh");
interactionGate.dispose();

console.log("PASS: hidden dashboard refresh scheduling");
