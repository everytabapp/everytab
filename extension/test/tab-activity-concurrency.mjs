import assert from "node:assert/strict";
import {
  ACTIVITY_CONTEXT_KEY,
  ACTIVITY_KEY,
  createTabActivityOwner
} from "../js/lib/tab-activity.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function fixture({ stored, windows, activeByWindow }) {
  let afterLightDecision = null;
  const mutateStores = async (keys, mutate) => {
    const maps = Object.fromEntries(keys.filter((key) => key in stored)
      .map((key) => [key, clone(stored[key])]));
    const changes = mutate(maps);
    if (changes) Object.assign(stored, clone(changes));
    if (afterLightDecision && !keys.includes("suspendedRegistry")) {
      const change = afterLightDecision;
      afterLightDecision = null;
      change();
    }
    return Boolean(changes);
  };
  const owner = createTabActivityOwner({
    readStoreValue: async (key) => clone(stored[key]),
    mutateStores,
    windows: { getAll: async () => clone(windows) },
    tabs: {
      query: async ({ windowId }) => [{
        id: activeByWindow[windowId], windowId, active: true
      }]
    },
    now: () => 100,
    windowIdNone: -1
  });
  return {
    owner,
    afterLightDecision(change) { afterLightDecision = change; }
  };
}

{
  const stored = {
    [ACTIVITY_KEY]: {},
    [ACTIVITY_CONTEXT_KEY]: {
      focusedWindowId: 1,
      activeByWindow: { 1: 11, 2: 21 }
    },
    suspendedRegistry: { 11: { recoveryOccurrenceId: "activation-11" } }
  };
  const test = fixture({ stored, windows: [], activeByWindow: { 2: 21 } });
  test.afterLightDecision(() => {
    stored[ACTIVITY_CONTEXT_KEY] = {
      focusedWindowId: 2,
      activeByWindow: { 1: 11, 2: 21 }
    };
  });
  await test.owner.recordActivation(12, 1, 100);
  assert.equal(stored[ACTIVITY_KEY][11], undefined,
    "activation rechecks focus and does not stamp a tab after its window became background");
  assert.equal(stored.suspendedRegistry[11].awayAt, undefined);
  assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], {
    focusedWindowId: 2,
    activeByWindow: { 1: 12, 2: 21 }
  });
}

{
  const stored = {
    [ACTIVITY_KEY]: {},
    [ACTIVITY_CONTEXT_KEY]: {
      focusedWindowId: 1,
      activeByWindow: { 1: 11, 2: 22 }
    },
    suspendedRegistry: { 11: { recoveryOccurrenceId: "focus-11" } }
  };
  const test = fixture({ stored, windows: [], activeByWindow: { 2: 22 } });
  test.afterLightDecision(() => {
    stored[ACTIVITY_CONTEXT_KEY] = {
      focusedWindowId: 2,
      activeByWindow: { 1: 11, 2: 22 }
    };
  });
  await test.owner.recordWindowFocus(2, 100);
  assert.equal(stored[ACTIVITY_KEY][11], undefined,
    "focus transition rechecks context and does not stamp after the arrival is already current");
  assert.equal(stored.suspendedRegistry[11].awayAt, undefined);
  assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], {
    focusedWindowId: 2,
    activeByWindow: { 1: 11, 2: 22 }
  });
}

{
  const currentWindows = [{
    id: 2,
    focused: true,
    tabs: [{ id: 22, windowId: 2, active: true }]
  }];
  const currentContext = { focusedWindowId: 2, activeByWindow: { 2: 22 } };
  const stored = {
    [ACTIVITY_KEY]: { 11: 10 },
    [ACTIVITY_CONTEXT_KEY]: {
      focusedWindowId: 1,
      activeByWindow: { 1: 11 }
    },
    suspendedRegistry: { 11: { recoveryOccurrenceId: "initialize-11" } }
  };
  const test = fixture({ stored, windows: currentWindows, activeByWindow: { 2: 22 } });
  test.afterLightDecision(() => {
    stored[ACTIVITY_CONTEXT_KEY] = clone(currentContext);
  });
  await test.owner.initialize();
  assert.deepEqual(stored[ACTIVITY_KEY], { 11: 10 },
    "initialization rechecks context and does not stamp a departure already reconciled elsewhere");
  assert.equal(stored.suspendedRegistry[11].awayAt, undefined);
  assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], currentContext);
}

console.log("PASS: full registry branches re-evaluate fresh activity context");
