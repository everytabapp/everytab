// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "../lib/types.js";
import { listItems, listNamedSessions } from "../lib/store.js";
import { createTabList, fromSnoozes } from "./tablist.js";
import { buildSnoozedListConfig } from "./list-configs.js";
import { createCopyHelpers } from "./list-helpers.js";
import { shellSectionCountTitle } from "./shell-copy.js";
import { coalesce } from "./dom.js";

/** Owns the Snoozed projection and list behavior behind one render boundary. */
export function createSnoozedSurface({ getBody, setHeading, showNotice }) {
  const { copyRefs } = createCopyHelpers(showNotice);
  const send = (message) => chrome.runtime.sendMessage(message);
  const render = coalesce(renderInner);

  async function renderInner() {
    const snoozes = (await listItems(STORE_KEYS.snoozes)).sort((a, b) => a.dueAt - b.dueAt);
    const sessionsById = new Map(
      (await listNamedSessions()).map((session) => [session.id, session])
    );
    setHeading(shellSectionCountTitle("snoozed", snoozes.length));
    getBody().replaceChildren(createTabList(buildSnoozedListConfig({
      data: { groups: fromSnoozes(snoozes, sessionsById) },
      renderSnoozes: render,
      // Session changes also emit storage changes. The shared Dashboard refresh
      // scheduler owns that cross-section repaint instead of this hidden view.
      renderSessions: () => {},
      msg: send,
      copyRefs,
      showNotice
    })));
  }

  return { render };
}
