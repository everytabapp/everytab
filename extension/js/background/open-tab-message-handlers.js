// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const isIdList = (value) => Array.isArray(value) && value.every(isId);
const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe Open-tab placement and organization messages. Domain adapters own
 * move planning, journaling, sorting, and gathering; this module owns public
 * validation and the single-tab compatibility routes.
 *
 * @param {{
 *   moveOne: (tabId: number, destination: {windowId:number,index:number}) => Promise<unknown>,
 *   moveSet: (tabIds: number[], destination: object) => Promise<unknown>,
 *   sortWindow: (windowId: number, mode: "domain"|"title"|"recent") => Promise<unknown>,
 *   gatherDomain: (domain: string) => Promise<unknown>
 * }} openTabs
 */
export function createOpenTabMessageHandlers(openTabs) {
  return [
    handler(
      "move-tab",
      (message) => isId(message.tabId) && isId(message.windowId) &&
        Number.isInteger(message.index),
      async (message) => {
        await openTabs.moveOne(message.tabId, {
          windowId: message.windowId,
          index: message.index
        });
        return { ok: true };
      },
      { ok: false }
    ),
    handler(
      "move-tabs",
      (message) => isIdList(message.tabIds) && isRecord(message.destination),
      (message) => openTabs.moveSet(message.tabIds, message.destination),
      { ok: false, reason: "error", moved: 0 }
    ),
    handler(
      "sort-window",
      (message) => isId(message.windowId) &&
        ["domain", "title", "recent"].includes(message.mode),
      (message) => openTabs.sortWindow(message.windowId, message.mode),
      { ok: false, reason: "error", moved: 0 }
    ),
    handler(
      "gather-domain",
      (message) => isNonEmptyText(message.domain),
      (message) => openTabs.gatherDomain(message.domain),
      { ok: false, reason: "error", moved: 0 }
    ),
    handler(
      "new-window-with-tab",
      (message) => isId(message.tabId),
      (message) => openTabs.moveSet([message.tabId], { kind: "new-window" }),
      { ok: false, reason: "error", moved: 0 }
    )
  ];
}
