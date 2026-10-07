// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isId = (value) => Number.isInteger(value) && value >= 0;
const isOptionalId = (value) => value === undefined || isId(value);
const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;
const isWebUrl = (value) => {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
};
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe Search-result and direct navigation messages. The navigation
 * adapter owns browser and product effects; this module owns public target
 * validation, web-search disposition, and switch-away cleanup ordering.
 *
 * @param {{
 *   focus: (target:{tabId:number,windowId?:number}) => Promise<unknown>,
 *   restoreSession: (sessionId:string) => Promise<boolean>,
 *   openGroup: (kind:"label"|"session",groupId:string) => Promise<boolean>,
 *   openUrl: (url:string) => Promise<unknown>,
 *   search: (query:{text:string,tabId?:number,disposition?:string}) => Promise<unknown>,
 *   activateStarred: (url:string) => Promise<boolean>,
 *   closeTab: (tabId:number) => Promise<unknown>,
 *   refreshBadge: () => Promise<unknown>
 * }} navigation
 */
export function createNavigationMessageHandlers(navigation) {
  return [
    handler(
      "focus-tab",
      (message) => isId(message.tabId) && isId(message.windowId),
      async (message) => {
        await navigation.focus(message);
        return { ok: true };
      },
      { ok: false }
    ),
    handler(
      "restore-session",
      (message) => isNonEmptyText(message.sessionId),
      async (message) => ({ ok: await navigation.restoreSession(message.sessionId) }),
      { ok: false }
    ),
    handler(
      "open-organization-group",
      (message) => ["label", "session"].includes(message.organizationKind) &&
        isNonEmptyText(message.groupId),
      async (message) => ({
        ok: await navigation.openGroup(message.organizationKind, message.groupId)
      }),
      { ok: false }
    ),
    handler(
      "open-url",
      (message) => isWebUrl(message.url),
      async (message) => {
        await navigation.openUrl(message.url);
        return { ok: true };
      },
      { ok: false }
    ),
    handler(
      "search-web",
      (message) => isNonEmptyText(message.text),
      async (message, sender) => {
        const text = message.text.trim();
        const query = message.disposition === "CURRENT_TAB" && isId(sender.tab?.id)
          ? { text, tabId: sender.tab.id }
          : { text, disposition: "NEW_TAB" };
        await navigation.search(query);
        return { ok: true };
      },
      { ok: false }
    ),
    handler(
      "activate-starred",
      (message) => isWebUrl(message.url),
      async (message) => ({ ok: await navigation.activateStarred(message.url) }),
      { ok: false }
    ),
    handler(
      "switch-to-existing",
      (message) => isId(message.tabId) && isOptionalId(message.windowId) &&
        isOptionalId(message.closeTabId),
      async (message) => {
        await navigation.focus(message);
        if (message.closeTabId !== undefined) {
          try { await navigation.closeTab(message.closeTabId); }
          catch { /* already gone */ }
        }
        await navigation.refreshBadge();
        return { ok: true };
      },
      { ok: false }
    )
  ];
}
