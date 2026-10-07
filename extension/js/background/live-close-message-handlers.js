// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isId = (value) => Number.isInteger(value) && value >= 0;
const isIdList = (value) => Array.isArray(value) && value.every(isId);
const isOptionalIdList = (value) => value === undefined || isIdList(value);
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe direct live-tab closing messages. Recovery readiness stays explicit:
 * recoverable tab and whole-window closes wait for interrupted action recovery,
 * while unsaveable Chrome pages retain their direct close path.
 *
 * @param {{
 *   ready: Promise<unknown>,
 *   tabs: (tabIds: number[]) => Promise<unknown>,
 *   unsaveableTabs: (tabIds: number[]) => Promise<unknown>,
 *   window: (windowId: number, expected: {
 *     tabCount: number, tabIds?: number[], pinnedTabIds?: number[]
 *   }) => Promise<unknown>
 * }} closing
 */
export function createLiveCloseMessageHandlers(closing) {
  return [
    handler(
      "close-tabs",
      (message) => isIdList(message.tabIds),
      (message) => closing.ready.then(() => closing.tabs(message.tabIds)),
      { ok: false, reason: "error", closed: 0 }
    ),
    handler(
      "close-unsaveable-tabs",
      (message) => isIdList(message.tabIds),
      (message) => closing.unsaveableTabs(message.tabIds),
      { ok: false, reason: "error", closed: 0 }
    ),
    handler(
      "close-window",
      (message) => isId(message.windowId) && Number.isInteger(message.expectedTabCount) &&
        isOptionalIdList(message.expectedTabIds) &&
        isOptionalIdList(message.expectedPinnedTabIds),
      (message) => closing.ready.then(() => closing.window(message.windowId, {
        tabCount: message.expectedTabCount,
        tabIds: message.expectedTabIds,
        pinnedTabIds: message.expectedPinnedTabIds
      })),
      { ok: false, reason: "error" }
    )
  ];
}
