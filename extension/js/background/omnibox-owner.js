// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  OMNIBOX_DEFAULT_SUGGESTION,
  createOmniboxQueryController,
  executeOmniboxPlan,
  omniboxNavigationPlan,
  omniboxTargetForInput
} from "../lib/omnibox.js";

/**
 * Bind the Chrome omnibox surface to one Search session and the worker's
 * existing navigation actions. Search ranking and navigation policy remain in
 * the Chrome-free omnibox module.
 *
 * @param {{
 *   searchSession: {
 *     search: (query: string, options: object) => Promise<Array<object>>,
 *     scopeNames: (kind: string) => Promise<Array<string>>|Array<string>
 *   },
 *   hasHistory: () => Promise<boolean>|boolean,
 *   actions: {
 *     focus: (target: object) => Promise<unknown>,
 *     restoreSession: (sessionId: string) => Promise<unknown>,
 *     openOrganizationGroup: (kind: string, groupId: string) => Promise<unknown>,
 *     activateStarred: (url: string) => Promise<unknown>
 *   }
 * }} dependencies
 */
export function installOmniboxOwner({ searchSession, hasHistory, actions }) {
  const search = (query, options) => searchSession.search(query, options);
  const queries = createOmniboxQueryController({
    search,
    hasHistory,
    scopeNames: (kind) => searchSession.scopeNames(kind)
  });

  try {
    Promise.resolve(chrome.omnibox.setDefaultSuggestion({
      description: OMNIBOX_DEFAULT_SUGGESTION
    })).catch(() => {});
  } catch { /* the omnibox surface is unavailable */ }

  chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
    const { accepted, suggestions } = await queries.run(text);
    if (!accepted) return;
    try { suggest(suggestions); } catch { /* the omnibox closed */ }
  });

  chrome.omnibox.onInputCancelled.addListener(() => queries.cancel());

  chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
    const target = await omniboxTargetForInput(text, { search, hasHistory });
    const plan = omniboxNavigationPlan(target, disposition);
    await executeOmniboxPlan(plan, {
      ...actions,
      searchWeb: (queryInfo) => chrome.search.query(queryInfo),
      getLastFocusedWindow: () => chrome.windows.getLastFocused({ populate: true }),
      updateTab: (tabId, properties) => chrome.tabs.update(tabId, properties),
      createTab: (properties) => chrome.tabs.create(properties),
      removeTab: (tabId) => chrome.tabs.remove(tabId)
    });
  });
}
