// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const hasSenderTab = (_message, sender) => isRecord(sender.tab) && isId(sender.tab.id);
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe direct suspended-tab lifecycle messages. Reload recovery retains
 * its separate state owner; this module owns only public route identity,
 * sender provenance, duration validation, and stable response shapes.
 *
 * @param {{
 *   wake: (tabId: number) => Promise<boolean>,
 *   adopt: (tab: Record<string, unknown>) => Promise<boolean>,
 *   suspend: (tabId: number) => Promise<boolean>,
 *   exempt: (tabId: number, duration: "day"|"always") => Promise<unknown>,
 *   suspendOthers: (windowId: number) => Promise<number>
 * }} suspension
 */
export function createSuspensionMessageHandlers(suspension) {
  return [
    handler(
      "wake-tab",
      (message) => isId(message.tabId),
      async (message) => ({ ok: await suspension.wake(message.tabId) }),
      { ok: false }
    ),
    handler(
      "wake-suspended-page",
      hasSenderTab,
      async (_message, sender) => ({ ok: await suspension.wake(sender.tab.id) }),
      { ok: false }
    ),
    handler(
      "adopt-suspended-page",
      hasSenderTab,
      async (_message, sender) => ({ ok: await suspension.adopt(sender.tab) }),
      { ok: false }
    ),
    handler(
      "suspend-tab",
      (message) => isId(message.tabId),
      async (message) => ({ ok: await suspension.suspend(message.tabId) }),
      { ok: false }
    ),
    handler(
      "exempt-tab-from-suspend",
      (message) => isId(message.tabId) && ["day", "always"].includes(message.duration),
      (message) => suspension.exempt(message.tabId, message.duration),
      { ok: false }
    ),
    handler(
      "suspend-others",
      (message) => isId(message.windowId),
      async (message) => ({ n: await suspension.suspendOthers(message.windowId) }),
      { n: 0 }
    )
  ];
}
