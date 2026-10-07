// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "../lib/types.js";
import { listItems } from "../lib/store.js";
import { deleteSavedItem } from "../lib/saved-item-actions.js";
import { msg as localeMessage } from "../lib/i18n.js";
import { createTabList } from "./tablist.js";
import { buildSessionListConfig } from "./list-configs.js";
import {
  buildSnoozePanel, cardLabelPanel, confirmDelete, createCopyHelpers
} from "./list-helpers.js";
import { shellAutoSnapshotsTitle } from "./shell-copy.js";
import { coalesce } from "./dom.js";

/**
 * Owns the immutable automatic-Snapshot list. The host supplies only stable
 * shell slots and effects that cross into the Label or Snoozed sections.
 */
export function createSnapshotsSurface({
  getBody, setHeading, renderLabels, renderSnoozes, goToLabel, showNotice
}) {
  const { copySession } = createCopyHelpers(showNotice);
  const send = (message) => chrome.runtime.sendMessage(message);
  const render = coalesce(renderInner);

  async function deleteSnapshot(snapshot) {
    await deleteSavedItem(
      STORE_KEYS.sessions,
      snapshot,
      localeMessage("snapshot_deleted", [snapshot.name]),
      { actionKind: "deleted-snapshot", actionParams: { name: snapshot.name } }
    );
    render();
  }

  async function renderInner() {
    const snapshots = (await listItems(STORE_KEYS.sessions)).filter((session) => session.auto);
    setHeading(shellAutoSnapshotsTitle(snapshots.length));
    getBody().replaceChildren(createTabList(buildSessionListConfig({
      section: "snapshots",
      sessions: snapshots,
      rerender: render,
      extra: { empty: localeMessage("snapshot_empty") },
      renderLabels,
      renderSnoozes,
      goToLabel,
      msg: send,
      cardLabelPanel,
      copySession,
      buildSnoozePanel,
      confirmDelete,
      delSession: deleteSnapshot,
      showNotice
    })));
  }

  return { render };
}
