// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { shouldReconcileNewTabUpdate } from "../lib/newtab-singleton.js";
import { isHttpTab } from "../lib/tabs.js";

async function runTabTask(name, work) {
  try {
    await work();
  } catch (error) {
    reportFailure(name, error);
  }
}

/**
 * Install the worker's tab lifecycle policy. Domain modules retain product
 * behavior; this module owns Chrome event recognition, task lifetime, badge
 * coalescing, and failure containment.
 *
 * @param {{
 *   activity: {
 *     recordActivation: (tabId: number, windowId: number) => Promise<unknown>,
 *     forgetTab: (tabId: number) => Promise<unknown>
 *   },
 *   newTabs: {
 *     recordCreation: (tab: object) => unknown,
 *     forget: (tabId: number) => unknown,
 *     retireOlder: (tab: object) => Promise<unknown>
 *   },
 *   suspension: {
 *     unregister: (tabId: number) => Promise<unknown>,
 *     queueCloseCleanup: (tabId: number) => Promise<unknown>
 *   },
 *   focus: {
 *     activate: (tabId: number) => Promise<unknown>,
 *     update: (tabId: number, changeInfo: object, tab: object) => Promise<unknown>,
 *     remove: (tabId: number) => Promise<unknown>
 *   },
 *   duplicates: {
 *     alarmPrefix: string,
 *     graceMs: number,
 *     readSettings: () => Promise<object>,
 *     findGroups: () => Promise<Array<{close?: Array<{id?: number}>}>>
 *   },
 *   badge: { refresh: () => unknown, delayMs?: number },
 *   protection?: { removeTemporary: (tabId: number) => Promise<unknown> },
 *   scheduleAutoSaveCapSweep: () => unknown
 * }} domains
 */
export function installTabLifecycleOwner({
  activity,
  newTabs,
  suspension,
  focus,
  duplicates,
  badge,
  protection,
  scheduleAutoSaveCapSweep
}) {
  let badgeTimer = 0;
  const scheduleBadge = () => {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      void runTabTask("badge refresh", badge.refresh);
    }, badge.delayMs ?? 500);
  };

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    scheduleBadge();
    await Promise.all([
      runTabTask("tab activity transition", () => activity.recordActivation(tabId, windowId)),
      runTabTask("Focus activation", () => focus.activate(tabId))
    ]);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const tasks = [];
    // Chrome's completed-tab event is the fallback when the mounted New Tab
    // page could not deliver its own singleton-reconciliation message.
    if (shouldReconcileNewTabUpdate(changeInfo, tab, chrome.runtime.getURL(""))) {
      tasks.push(runTabTask("New Tab singleton reconciliation", () => newTabs.retireOlder(tab)));
    }

    if (changeInfo.url || changeInfo.status === "complete") {
      scheduleBadge();
    }

    if (changeInfo.url && isHttpTab(tab)) {
      // Once a suspended tab commits an ordinary page, its recovery identity
      // must retire or a later Chrome restart could recreate a duplicate.
      tasks.push(runTabTask("suspended-tab navigation cleanup", () => (
        suspension.unregister(tabId)
      )));
      tasks.push(runTabTask("duplicate grace scheduling", async () => {
        const settings = await duplicates.readSettings();
        if (!settings.dedupAutoClose) return;
        const groups = await duplicates.findGroups();
        if (groups.some((group) => group.close?.some((entry) => entry.id === tabId))) {
          await chrome.alarms.create(`${duplicates.alarmPrefix}${tabId}`, {
            when: Date.now() + duplicates.graceMs
          });
        }
      }));
    }

    if (changeInfo.url) {
      // Focus guarding reacts only to URL metadata and revalidates the live tab
      // inside its domain module before redirecting anything.
      tasks.push(runTabTask("Focus navigation", () => focus.update(tabId, changeInfo, tab)));
    }
    await Promise.all(tasks);
  });

  chrome.tabs.onCreated.addListener(async (tab) => {
    scheduleBadge();
    await Promise.all([
      runTabTask("New Tab creation tracking", () => newTabs.recordCreation(tab)),
      runTabTask("maximum-open-tabs scheduling", scheduleAutoSaveCapSweep)
    ]);
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    scheduleBadge();
    // Start invalidation before unrelated awaited cleanup so a newly-created
    // tab can never observe the closed tab's temporary protection identity.
    const protectionCleanup = protection?.removeTemporary
      ? runTabTask("temporary automation protection cleanup", () => (
        protection.removeTemporary(tabId)
      ))
      : Promise.resolve();
    // Suspension and Focus each own a separate reload-grace policy. Both must
    // see the close; their domain modules decide whether it is user intent or
    // Chrome tearing down an extension page during reload.
    await Promise.all([
      runTabTask("New Tab lifecycle cleanup", () => newTabs.forget(tabId)),
      runTabTask("tab activity cleanup", () => activity.forgetTab(tabId)),
      runTabTask("suspended close cleanup", () => suspension.queueCloseCleanup(tabId)),
      runTabTask("Focus tab cleanup", () => focus.remove(tabId)),
      protectionCleanup
    ]);
  });
}
