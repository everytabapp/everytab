// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isId = (value) => Number.isInteger(value) && value >= 0;
const isIdList = (value) => Array.isArray(value) && value.every(isId);
const isOptionalText = (value) => value === undefined || typeof value === "string";
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe explicit Inbox capture messages. The action adapter retains
 * persist-before-close behavior; this module owns public validation, result
 * shapes, and the Undo identity returned by single-target captures.
 *
 * @param {{
 *   capture: {
 *     window: (windowId: number) => Promise<{n:number,undoId:string|null}>,
 *     tab: (tabId: number) => Promise<{n:number,undoId:string|null}>,
 *     tabs: (tabIds: number[], label?: string) => Promise<number>
 *   }
 * }} dependencies
 */
export function createInboxCaptureMessageHandlers({ capture }) {
  return [
    handler(
      "dump-window",
      (message) => isId(message.windowId),
      (message) => capture.window(message.windowId),
      { n: 0, undoId: null }
    ),
    handler(
      "dump-tab",
      (message) => isId(message.tabId),
      (message) => capture.tab(message.tabId),
      { n: 0, undoId: null }
    ),
    handler(
      "dump-tabs",
      (message) => isIdList(message.tabIds) && isOptionalText(message.label),
      async (message) => ({ n: await capture.tabs(message.tabIds, message.label) }),
      { n: 0 }
    )
  ];
}
