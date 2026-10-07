// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isId = (value) => Number.isInteger(value) && value >= 0;
const isOptionalId = (value) => value === undefined || isId(value);
const isOptionalText = (value) => value === undefined || typeof value === "string";
const RULE_MODES = new Set(["standard", "include-fragment", "skip"]);

/**
 * Describe duplicate closing. The operation waits for interrupted action
 * recovery and reconciles the toolbar badge before reporting completion.
 *
 * @param {{
 *   ready: Promise<unknown>,
 *   close: (target:{key?:string,tabId?:number}) => Promise<number>,
 *   setRule: (hostname:string,mode:"standard"|"include-fragment"|"skip") => Promise<unknown>,
 *   refreshBadge: () => Promise<unknown>
 * }} duplicates
 */
export function createDuplicateMessageHandlers(duplicates) {
  return [{
    type: "close-duplicates",
    mode: "async",
    validate: (message) => isOptionalText(message.key) && isOptionalId(message.tabId),
    handle: async (message) => {
      const n = await duplicates.ready.then(() => duplicates.close({
        key: message.key,
        tabId: message.tabId
      }));
      await duplicates.refreshBadge();
      return { n };
    },
    failure: { n: 0 }
  }, {
    type: "set-duplicate-domain-rule",
    mode: "async",
    validate: (message) => typeof message.hostname === "string" &&
      message.hostname.length <= 253 && RULE_MODES.has(message.mode),
    handle: async (message) => {
      await duplicates.ready;
      await duplicates.setRule(message.hostname, message.mode);
      await duplicates.refreshBadge();
      return { ok: true };
    },
    failure: { ok: false }
  }];
}
