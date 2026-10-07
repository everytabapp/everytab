// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { createForegroundTaskQueue } from "./refresh-scheduler.js";

/**
 * Defer refresh tasks only while the document is explicitly hidden. A visible
 * Side Panel must stay live when keyboard focus belongs to the page beside it.
 * One instance belongs to the document for its lifetime; wake events drain its
 * dirty set without issuing reads of their own.
 */
export function createVisibleDocumentTasks(run, {
  document = globalThis.document,
  window = globalThis.window
} = {}) {
  const isVisible = () => document.visibilityState !== "hidden";
  const queue = createForegroundTaskQueue(run, { isForeground: isVisible });
  document.addEventListener("visibilitychange", queue.foreground);
  window.addEventListener("focus", queue.foreground);
  window.addEventListener("pageshow", queue.foreground);
  return { request: queue.request, isVisible };
}
