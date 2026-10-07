// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { canonicalStarUrl } from "../lib/starred.js";
import { urlOf } from "../lib/tabs.js";

/**
 * Create the browser navigation actions shared by Search, the omnibox, and
 * worker messages. This is the single owner of wake-before-focus behavior,
 * canonical Starred matching, and stale Session feedback.
 *
 * @param {{
 *   wakeTab: (tabId:number) => Promise<unknown>,
 *   restoreSessionById: (sessionId:string) => Promise<boolean>,
 *   openDashboard: (route:string) => Promise<unknown>,
 *   message: (key:string) => string,
 *   now?: () => number,
 *   schedule?: (callback:Function,delay:number) => unknown,
 *   runtime: { getURL: (path:string) => string },
 *   tabs: {
 *     query: (query:object) => Promise<object[]>,
 *     update: (tabId:number,properties:object) => Promise<unknown>,
 *     create: (properties:object) => Promise<unknown>
 *   },
 *   windows: { update: (windowId:number,properties:object) => Promise<unknown> },
 *   notifications: {
 *     create: (id:string,options:object) => Promise<unknown>,
 *     clear: (id:string) => Promise<unknown>
 *   },
 *   warn?: (message:string) => void
 * }} dependencies
 */
export function createNavigationActions(dependencies) {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? setTimeout;
  const warn = dependencies.warn ?? console.warn;

  const focus = async ({ tabId, windowId }) => {
    await dependencies.wakeTab(tabId).catch(() => {});
    await dependencies.tabs.update(tabId, { active: true });
    if (windowId !== undefined) {
      await dependencies.windows.update(windowId, { focused: true });
    }
  };

  const activateStarred = async (url) => {
    const target = canonicalStarUrl(url);
    if (!target) return false;
    const tabs = await dependencies.tabs.query({});
    const existing = tabs.find((tab) => canonicalStarUrl(urlOf(tab)) === target);
    if (existing?.id !== undefined) {
      await dependencies.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        await dependencies.windows.update(existing.windowId, { focused: true });
      }
    } else {
      await dependencies.tabs.create({ url: target });
    }
    return true;
  };

  const restoreSession = async (sessionId) => {
    if (await dependencies.restoreSessionById(sessionId)) return true;
    const id = `session-missing-${now()}`;
    try {
      await dependencies.notifications.create(id, {
        type: "basic",
        iconUrl: dependencies.runtime.getURL("icon.png"),
        title: dependencies.message("notification_session_missing_title"),
        message: dependencies.message("notification_session_missing_body")
      });
      schedule(() => {
        try { Promise.resolve(dependencies.notifications.clear(id)).catch(() => {}); }
        catch { /* notification already gone */ }
      }, 5_000);
    } catch (error) {
      reportFailure("missing Session notification", error, warn);
    }
    return false;
  };

  const openGroup = async (kind, groupId) => {
    if (!["label", "session"].includes(kind) ||
        typeof groupId !== "string" || !groupId.trim()) return false;
    await dependencies.openDashboard(`${kind}-group:${encodeURIComponent(groupId)}`);
    return true;
  };

  return { focus, activateStarred, restoreSession, openGroup };
}
