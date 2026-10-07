// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { msg as localeMessage } from "../lib/i18n.js";

async function runNotificationTask(name, work, { quiet = false } = {}) {
  try {
    await work();
  } catch (error) {
    if (!quiet) reportFailure(name, error);
  }
}

/**
 * Own Chrome notification events and Undo receipt identity. Focus retains its
 * access policy; this module decides which notification domain receives each
 * Chrome interaction and keeps that task alive through settlement.
 *
 * @param {{
 *   actionRecoveryReady: Promise<unknown>,
 *   undoAction: (entryId: string) => Promise<unknown>,
 *   access: {
 *     owns: (notificationId: string) => boolean,
 *     handleButton: (notificationId: string, buttonIndex: number) => Promise<unknown>,
 *     handleClick: (notificationId: string) => Promise<unknown>
 *   }
 * }} dependencies
 */
export function createNotificationOwner({ actionRecoveryReady, undoAction, access }) {
  const undoByNotificationId = new Map();

  function registerUndo(notificationId, entryId) {
    if (!notificationId || !entryId) return;
    undoByNotificationId.set(notificationId, entryId);
  }

  chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    const undoId = undoByNotificationId.get(notificationId);
    if (undoId && buttonIndex === 0) {
      undoByNotificationId.delete(notificationId);
      await Promise.all([
        runNotificationTask("notification Undo", async () => {
          await actionRecoveryReady;
          await undoAction(undoId);
        }, { quiet: true }),
        runNotificationTask("notification cleanup", () => (
          chrome.notifications.clear(notificationId)
        ), { quiet: true })
      ]);
      return;
    }

    if (!access.owns(notificationId)) return;
    await runNotificationTask("Focus access extension", () => (
      access.handleButton(notificationId, buttonIndex)
    ));
  });

  chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (!access.owns(notificationId)) return;
    await runNotificationTask("Focus access notification click", () => (
      access.handleClick(notificationId)
    ));
  });

  chrome.notifications.onClosed.addListener((notificationId) => {
    undoByNotificationId.delete(notificationId);
  });

  /**
   * Create a command notification and register its optional Undo receipt only
   * after Chrome accepts the notification.
   *
   * @param {{id: string, title: string, message: string, undoId?: string|null}} notice
   * @returns {Promise<void>}
   */
  async function notify({ id, title, message, undoId = null }) {
    try {
      await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title,
        message,
        ...(undoId ? { buttons: [{ title: localeMessage("action_undo") }] } : {})
      });
      if (undoId) registerUndo(id, undoId);
    } catch (error) {
      reportFailure("command notification", error);
    }
  }

  return { notify, registerUndo };
}
