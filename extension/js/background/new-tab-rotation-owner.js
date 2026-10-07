// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * Own one On-open scheme draw per mounted New Tab identity. The owner hides
 * in-flight coalescing, handled identity, diagnostic capture, and retry state
 * behind a small interface used by message and tab-lifecycle adapters.
 *
 * @param {{
 *   rotate: () => Promise<unknown>|unknown,
 *   diagnostics: {
 *     record: (event: string, details: Record<string, unknown>) => unknown,
 *     capture: () => unknown,
 *     safeScheme: (value: unknown) => unknown
 *   }
 * }} dependencies
 */
export function createNewTabRotationOwner({ rotate, diagnostics }) {
  const tasks = new Map();
  const handled = new Set();

  const withCapture = (response) => {
    const diagnosticsCapture = diagnostics.capture();
    return diagnosticsCapture ? { ...response, diagnosticsCapture } : response;
  };

  const run = (tabId) => {
    if (!Number.isInteger(tabId)) {
      diagnostics.record("task-missing-tab", { tabId: null });
      return Promise.resolve(withCapture({ ok: false, reason: "missing-tab" }));
    }

    const active = tasks.get(tabId);
    if (active) {
      diagnostics.record("task-coalesced", { tabId });
      return active;
    }

    if (handled.has(tabId)) {
      diagnostics.record("task-already-handled", { tabId });
      return Promise.resolve(withCapture({ ok: true, alreadyHandled: true }));
    }

    handled.add(tabId);
    diagnostics.record("task-start", { tabId });

    let task;
    task = Promise.resolve()
      .then(rotate)
      .then((result) => {
        diagnostics.record("task-complete", {
          tabId,
          changed: typeof result?.changed === "boolean" ? result.changed : null,
          scheme: diagnostics.safeScheme(result?.scheme),
          nextScheme: diagnostics.safeScheme(result?.nextScheme)
        });
        return withCapture({ ok: true, result });
      })
      .catch((error) => {
        // Chrome can reuse a numeric tab id after removal. An older task may
        // settle after a new owner has started for that id; only the current
        // task may release its handled identity.
        if (tasks.get(tabId) === task) handled.delete(tabId);
        diagnostics.record("task-failure", { tabId, reason: "rotation-failed" });
        reportFailure("New Tab scheme rotation", error);
        return withCapture({ ok: false, reason: "rotation-failed" });
      })
      .finally(() => {
        if (tasks.get(tabId) === task) tasks.delete(tabId);
      });
    tasks.set(tabId, task);
    return task;
  };

  return Object.freeze({
    run,
    forget(tabId) {
      handled.delete(tabId);
      tasks.delete(tabId);
    },
    counts() {
      return { active: tasks.size, handled: handled.size };
    }
  });
}
