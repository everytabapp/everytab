// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const isText = (value) => typeof value === "string";
const isNonEmptyText = (value) => isText(value) && value.trim().length > 0;
const isOptionalText = (value) => value === undefined || isText(value);
const noPayload = () => true;
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe the complete Close-the-day review protocol. The domain adapter owns
 * drafts, plans, commits, browser closing, and Undo; this module owns public
 * validation, sender provenance, and the concise result projections.
 *
 * @param {{
 *   ready?: Promise<unknown>,
 *   capture: (options: {protectedTabId:number|null,refresh:boolean}) => Promise<unknown>,
 *   updateChoice: (draftId:string,fingerprintKey:string,patch:object) => Promise<unknown>,
 *   updateChoices: (draftId:string,fingerprintKeys:string[],patch:object) => Promise<unknown>,
 *   check: (draftId:string) => Promise<unknown>,
 *   updateWindowMode: (draftId:string,windowId:number,mode:string) => Promise<unknown>,
 *   discard: (draftId?:string) => Promise<boolean>,
 *   commit: (draftId:string) => Promise<unknown>,
 *   resume: (transactionId:string) => Promise<object>,
 *   undo: (transactionId:string) => Promise<object>,
 *   status: () => Promise<unknown>
 * }} closeDay
 */
export function createCloseDayMessageHandlers(closeDay) {
  return [
    handler(
      "close-day-capture",
      (message) => message.refresh === undefined || typeof message.refresh === "boolean",
      (message, sender) => closeDay.capture({
        protectedTabId: isId(sender.tab?.id) ? sender.tab.id : null,
        refresh: message.refresh === true
      }),
      { ok: false, reason: "capture-failed" }
    ),
    handler(
      "close-day-choice",
      (message) => isNonEmptyText(message.draftId) &&
        isNonEmptyText(message.fingerprintKey) && isRecord(message.patch),
      (message) => closeDay.updateChoice(
        message.draftId, message.fingerprintKey, message.patch
      ),
      { ok: false, reason: "update-failed" }
    ),
    handler(
      "close-day-bulk-choice",
      (message) => isNonEmptyText(message.draftId) &&
        Array.isArray(message.fingerprintKeys) &&
        message.fingerprintKeys.every(isNonEmptyText) && isRecord(message.patch),
      (message) => closeDay.updateChoices(
        message.draftId, message.fingerprintKeys, message.patch
      ),
      { ok: false, reason: "update-failed" }
    ),
    handler(
      "close-day-check",
      (message) => isNonEmptyText(message.draftId),
      (message) => closeDay.check(message.draftId),
      { ok: false, fresh: false }
    ),
    handler(
      "close-day-window-mode",
      (message) => isNonEmptyText(message.draftId) && isId(message.windowId) &&
        isNonEmptyText(message.mode),
      (message) => closeDay.updateWindowMode(
        message.draftId, message.windowId, message.mode
      ),
      { ok: false, reason: "update-failed" }
    ),
    handler(
      "close-day-discard",
      (message) => isOptionalText(message.draftId),
      async (message) => ({ ok: await closeDay.discard(message.draftId) }),
      { ok: false }
    ),
    handler(
      "close-day-commit",
      (message) => isNonEmptyText(message.draftId),
      (message) => closeDay.commit(message.draftId),
      { ok: false, status: "failed" }
    ),
    handler(
      "close-day-resume",
      (message) => isNonEmptyText(message.transactionId),
      async (message) => {
        const receipt = await closeDay.resume(message.transactionId);
        return { ok: receipt.phase !== "missing", receipt };
      },
      { ok: false }
    ),
    handler(
      "close-day-undo",
      (message) => isNonEmptyText(message.transactionId),
      async (message) => {
        const result = await closeDay.undo(message.transactionId);
        return { ok: result.status === "undone", ...result };
      },
      { ok: false, status: "failed" }
    ),
    handler(
      "close-day-status",
      noPayload,
      closeDay.status,
      { draft: null, pending: null, latest: null }
    )
  ].map((route) => ({
    ...route,
    // Recovery reconciles interrupted browser effects before any route can
    // observe or change their receipts. Rejection preserves the route's fallback.
    handle: async (...args) => {
      await closeDay.ready;
      return route.handle(...args);
    }
  }));
}
