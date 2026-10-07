// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
async function runWindowTask(name, work) {
  try {
    await work();
  } catch (error) {
    reportFailure(name, error);
  }
}

/**
 * Install the worker's window lifecycle policy. Activity and Session bindings
 * keep their own storage behavior; this module owns event lifetime and keeps
 * one cleanup failure from blocking the other.
 *
 * @param {{
 *   activity: {
 *     recordWindowFocus: (windowId: number) => Promise<unknown>,
 *     forgetWindow: (windowId: number) => Promise<unknown>
 *   },
 *   sessions: { unbind: (windowId: number) => Promise<unknown> }
 * }} domains
 */
export function installWindowLifecycleOwner({ activity, sessions }) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    await runWindowTask("tab activity focus transition", () => (
      activity.recordWindowFocus(windowId)
    ));
  });

  chrome.windows.onRemoved.addListener(async (windowId) => {
    await Promise.all([
      runWindowTask("tab activity window cleanup", () => activity.forgetWindow(windowId)),
      runWindowTask("Session window cleanup", () => sessions.unbind(windowId))
    ]);
  });
}
