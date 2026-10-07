// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { mutateStores, readStoreValue } from "./store.js";

export const ACTIVITY_KEY = "tabActivity";
export const ACTIVITY_CONTEXT_KEY = "tabActivityContext";
const SUSPEND_REGISTRY_KEY = "suspendedRegistry";

/**
 * @typedef {Object} TabActivityContext
 * @property {number|null} focusedWindowId
 * @property {Record<string, number>} activeByWindow
 */

function normalizedContext(value) {
  const activeByWindow = {};
  for (const [windowId, tabId] of Object.entries(value?.activeByWindow ?? {})) {
    if (Number.isInteger(Number(windowId)) && Number.isInteger(tabId)) {
      activeByWindow[windowId] = tabId;
    }
  }
  return {
    focusedWindowId: Number.isInteger(value?.focusedWindowId)
      ? value.focusedWindowId
      : null,
    activeByWindow
  };
}

/**
 * Device-local time-away clock. The activity map records when a tab was left,
 * while the context remembers which selected tab belongs to each window and
 * which window is actually in the foreground. Neither key is portable state.
 *
 * @param {{
 *   readStoreValue: (key:string) => Promise<unknown>,
 *   mutateStores: (keys:string[], mutate:(maps:Record<string, unknown>) => object|null) => Promise<boolean>,
 *   tabs: {query:(query?:object) => Promise<object[]>},
 *   windows: {getAll:(query?:object) => Promise<object[]>},
 *   now?: () => number,
 *   windowIdNone?: number
 * }} dependencies
 */
export function createTabActivityOwner(dependencies) {
  const now = dependencies.now ?? Date.now;
  const windowIdNone = dependencies.windowIdNone ?? globalThis.chrome?.windows?.WINDOW_ID_NONE ?? -1;
  let transitionChain = Promise.resolve();
  let contextReady = Promise.resolve();
  let contextPending = false;
  let contextFailed = false;

  const queueTransition = (work) => {
    const run = () => work();
    const result = transitionChain.then(run, run);
    transitionChain = result.catch(() => {});
    return result;
  };

  const mutateActivityWithRegistry = (mutate) => dependencies.mutateStores(
    [ACTIVITY_KEY, ACTIVITY_CONTEXT_KEY, SUSPEND_REGISTRY_KEY],
    (maps) => {
      const activity = maps[ACTIVITY_KEY] ?? {};
      const context = normalizedContext(maps[ACTIVITY_CONTEXT_KEY]);
      const registry = maps[SUSPEND_REGISTRY_KEY] ?? {};
      return mutate(activity, context, registry);
    }
  );

  const mutateActivityContext = (mutate) => dependencies.mutateStores(
    [ACTIVITY_KEY, ACTIVITY_CONTEXT_KEY],
    (maps) => mutate(
      maps[ACTIVITY_KEY] ?? {},
      normalizedContext(maps[ACTIVITY_CONTEXT_KEY]),
      maps
    )
  );

  const mutateContext = (mutate) => dependencies.mutateStores(
    [ACTIVITY_CONTEXT_KEY],
    (maps) => mutate(normalizedContext(maps[ACTIVITY_CONTEXT_KEY]), maps)
  );

  const stampAway = (activity, registry, tabId, at) => {
    activity[tabId] = at;
    if (!registry[tabId]) return false;
    registry[tabId] = { ...registry[tabId], awayAt: at };
    return true;
  };

  const leaveFocusedWindow = (activity, context, registry, at) => {
    const previousId = context.activeByWindow[context.focusedWindowId];
    return Number.isInteger(previousId)
      ? stampAway(activity, registry, previousId, at)
      : false;
  };

  const liveContext = (windows) => {
    const context = { focusedWindowId: null, activeByWindow: {} };
    for (const window of windows) {
      const active = window.tabs?.find((tab) => tab.active);
      if (Number.isInteger(window.id) && Number.isInteger(active?.id)) {
        context.activeByWindow[window.id] = active.id;
      }
      if (window.focused && Number.isInteger(window.id)) {
        context.focusedWindowId = window.id;
      }
    }
    return context;
  };

  /**
   * Reconcile the durable foreground identity before lifecycle events or timer
   * effects use it. A pre-context profile receives a conservative fresh clock.
   */
  const initialize = () => {
    contextPending = true;
    contextFailed = false;
    const task = queueTransition(async () => {
      const windows = await dependencies.windows.getAll({ populate: true });
      const current = liveContext(windows);
      let needsRegistry = false;
      const lightweightResult = await mutateActivityContext((activity, previous, maps) => {
        if (!maps[ACTIVITY_CONTEXT_KEY]?.activeByWindow) {
          return { [ACTIVITY_KEY]: {}, [ACTIVITY_CONTEXT_KEY]: current };
        }
        const oldForeground = previous.activeByWindow[previous.focusedWindowId];
        const currentForeground = current.activeByWindow[current.focusedWindowId];
        if (Number.isInteger(oldForeground) && oldForeground !== currentForeground) {
          needsRegistry = true;
          return null;
        }
        return { [ACTIVITY_KEY]: activity, [ACTIVITY_CONTEXT_KEY]: current };
      });
      if (!needsRegistry) return lightweightResult;

      // The cheap decision deliberately releases the Store lock. Re-evaluate
      // against fresh context under the one full activity+registry mutation so
      // a concurrent registry entry is preserved and stamped atomically.
      return mutateActivityWithRegistry((activity, previous, registry) => {
        const oldForeground = previous.activeByWindow[previous.focusedWindowId];
        const currentForeground = current.activeByWindow[current.focusedWindowId];
        let registryChanged = false;
        if (Number.isInteger(oldForeground) && oldForeground !== currentForeground) {
          registryChanged = stampAway(activity, registry, oldForeground, now());
        }
        return {
          [ACTIVITY_KEY]: activity,
          [ACTIVITY_CONTEXT_KEY]: current,
          ...(registryChanged ? { [SUSPEND_REGISTRY_KEY]: registry } : {})
        };
      });
    });
    contextReady = task;
    void task.then(
      () => { if (contextReady === task) contextPending = false; },
      () => {
        if (contextReady !== task) return;
        contextPending = false;
        contextFailed = true;
      }
    );
    return contextReady;
  };

  /** Record one selected-tab transition without treating arrival as activity. */
  const recordActivation = (tabId, windowId, at = now()) => queueTransition(async () => {
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return false;
    let needsRegistry = false;
    const lightweightResult = await mutateContext((context) => {
      const previousId = context.activeByWindow[windowId];
      if (context.focusedWindowId === windowId && previousId !== tabId &&
          Number.isInteger(previousId)) {
        needsRegistry = true;
        return null;
      }
      if (previousId === tabId) return null;
      context.activeByWindow[windowId] = tabId;
      return { [ACTIVITY_CONTEXT_KEY]: context };
    });
    if (!needsRegistry) return lightweightResult;
    return mutateActivityWithRegistry((activity, context, registry) => {
      const previousId = context.activeByWindow[windowId];
      if (previousId === tabId) return null;
      let registryChanged = false;
      if (context.focusedWindowId === windowId && Number.isInteger(previousId)) {
        registryChanged = stampAway(activity, registry, previousId, at);
      }
      context.activeByWindow[windowId] = tabId;
      return {
        [ACTIVITY_KEY]: activity,
        [ACTIVITY_CONTEXT_KEY]: context,
        ...(registryChanged ? { [SUSPEND_REGISTRY_KEY]: registry } : {})
      };
    });
  });

  /** Record browser focus leaving or entering a window. */
  const recordWindowFocus = (windowId, at = now()) => queueTransition(async () => {
    const isLeavingBrowser = windowId === windowIdNone;
    if (!isLeavingBrowser && !Number.isInteger(windowId)) return false;
    let activeTabId = null;
    if (!isLeavingBrowser) {
      try {
        const [active] = await dependencies.tabs.query({ active: true, windowId });
        activeTabId = Number.isInteger(active?.id) ? active.id : null;
      } catch {
        return false;
      }
    }
    let needsRegistry = false;
    const lightweightResult = await mutateContext((context) => {
      if (context.focusedWindowId !== windowId) {
        const previousId = context.activeByWindow[context.focusedWindowId];
        if (Number.isInteger(previousId)) {
          needsRegistry = true;
          return null;
        }
      }
      const nextFocusedWindowId = isLeavingBrowser ? null : windowId;
      const changed = context.focusedWindowId !== nextFocusedWindowId ||
        (activeTabId !== null && context.activeByWindow[windowId] !== activeTabId);
      if (!changed) return null;
      context.focusedWindowId = nextFocusedWindowId;
      if (activeTabId !== null) context.activeByWindow[windowId] = activeTabId;
      return { [ACTIVITY_CONTEXT_KEY]: context };
    });
    if (!needsRegistry) return lightweightResult;
    return mutateActivityWithRegistry((activity, context, registry) => {
      let registryChanged = false;
      if (context.focusedWindowId !== windowId) {
        registryChanged = leaveFocusedWindow(activity, context, registry, at);
      }
      context.focusedWindowId = isLeavingBrowser ? null : windowId;
      if (activeTabId !== null) context.activeByWindow[windowId] = activeTabId;
      return {
        [ACTIVITY_KEY]: activity,
        [ACTIVITY_CONTEXT_KEY]: context,
        ...(registryChanged ? { [SUSPEND_REGISTRY_KEY]: registry } : {})
      };
    });
  });

  /**
   * A full browser start may reuse numeric tab ids. Clear the old-session clock
   * and seed only current selected identities, granting every restored tab a
   * fresh first-sighting grace. Ordinary MV3 worker starts do not call this.
   */
  const beginBrowserSession = () => {
    contextPending = true;
    contextFailed = false;
    const task = queueTransition(async () => {
      // Clear reusable browser-session ids before any fallible Chrome query.
      // If window inventory fails, the next worker sees a valid empty context
      // and cannot revive an old tab id as current activity.
      await dependencies.mutateStores(
        [ACTIVITY_KEY, ACTIVITY_CONTEXT_KEY],
        () => ({
          [ACTIVITY_KEY]: {},
          [ACTIVITY_CONTEXT_KEY]: { focusedWindowId: null, activeByWindow: {} }
        })
      );
      const windows = await dependencies.windows.getAll({ populate: true });
      const context = liveContext(windows);
      return dependencies.mutateStores(
        [ACTIVITY_CONTEXT_KEY],
        () => ({ [ACTIVITY_CONTEXT_KEY]: context })
      );
    });
    contextReady = task;
    void task.then(
      () => { if (contextReady === task) contextPending = false; },
      () => {
        if (contextReady !== task) return;
        contextPending = false;
        contextFailed = true;
      }
    );
    return contextReady;
  };

  const forgetTab = (tabId) => queueTransition(() => mutateActivityContext((activity, context) => {
    let changed = false;
    if (tabId in activity) {
      delete activity[tabId];
      changed = true;
    }
    for (const [windowId, activeId] of Object.entries(context.activeByWindow)) {
      if (activeId !== tabId) continue;
      delete context.activeByWindow[windowId];
      changed = true;
    }
    return changed ? {
      [ACTIVITY_KEY]: activity,
      [ACTIVITY_CONTEXT_KEY]: context
    } : null;
  }));

  const forgetWindow = (windowId) => queueTransition(() => mutateActivityContext((activity, context) => {
    if (!(windowId in context.activeByWindow) && context.focusedWindowId !== windowId) return null;
    delete context.activeByWindow[windowId];
    if (context.focusedWindowId === windowId) context.focusedWindowId = null;
    return {
      [ACTIVITY_KEY]: activity,
      [ACTIVITY_CONTEXT_KEY]: context
    };
  }));

  const getMap = async ({ waitForContext = true } = {}) => {
    if (!waitForContext && (contextPending || contextFailed)) return {};
    if (!waitForContext) return await dependencies.readStoreValue(ACTIVITY_KEY) ?? {};
    await contextReady;
    return queueTransition(async () => await dependencies.readStoreValue(ACTIVITY_KEY) ?? {});
  };

  /** Fresh timer guard used immediately before an automatic effect. */
  const isOlderThan = async (tabId, cutoff) => {
    await contextReady;
    return queueTransition(async () => {
      let older = false;
      await dependencies.mutateStores(
        [ACTIVITY_KEY, ACTIVITY_CONTEXT_KEY],
        (maps) => {
          const activity = maps[ACTIVITY_KEY] ?? {};
          const context = normalizedContext(maps[ACTIVITY_CONTEXT_KEY]);
          const foregroundTabId = context.activeByWindow[context.focusedWindowId];
          const leftAt = activity[tabId];
          older = foregroundTabId !== tabId && Number.isFinite(leftAt) && leftAt < cutoff;
          return null;
        }
      );
      return older;
    });
  };

  /**
   * Merge sweep bookkeeping into fresh state. Conditional additions and
   * pruning cannot overwrite a leave transition that occurred during planning.
   */
  const reconcileSweep = ({
    snapshot,
    liveIds,
    firstSeenIds,
    forgetIds,
    at = now(),
    waitForContext = true
  }) => {
    const reconcile = () => dependencies.mutateStores([ACTIVITY_KEY], (maps) => {
      const activity = maps[ACTIVITY_KEY] ?? {};
      let changed = false;
      for (const tabId of firstSeenIds) {
        if (activity[tabId] !== undefined) continue;
        activity[tabId] = at;
        changed = true;
      }
      for (const [tabId, observedAt] of Object.entries(snapshot)) {
        if (liveIds.has(Number(tabId)) || activity[tabId] !== observedAt) continue;
        delete activity[tabId];
        changed = true;
      }
      for (const tabId of forgetIds) {
        if (!(tabId in activity) || activity[tabId] !== snapshot[tabId]) continue;
        delete activity[tabId];
        changed = true;
      }
      return changed ? { [ACTIVITY_KEY]: activity } : null;
    });
    return waitForContext ? contextReady.then(reconcile) : reconcile();
  };

  return {
    initialize,
    beginBrowserSession,
    whenReady: () => contextReady,
    recordActivation,
    recordWindowFocus,
    forgetTab,
    forgetWindow,
    getMap,
    isOlderThan,
    reconcileSweep
  };
}

export const tabActivity = createTabActivityOwner({
  readStoreValue,
  mutateStores,
  tabs: { query: (query) => chrome.tabs.query(query) },
  windows: {
    getAll: (query) => chrome.windows.getAll(query)
  }
});
