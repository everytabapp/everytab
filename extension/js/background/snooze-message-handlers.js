// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isId = (value) => Number.isInteger(value) && value >= 0;
const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;
const isOptionalText = (value) => value === undefined || typeof value === "string";
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe direct Snooze creation and manual delivery messages. Snooze storage
 * and browser effects remain behind the domain adapter; this module owns tab
 * lookup, recovery ordering, Undo projection, and public validation.
 *
 * @param {{
 *   deliveryReady: Promise<unknown>,
 *   getTab: (tabId:number) => Promise<object>,
 *   createTab: (tab:object,dueAt:number,recurrence?:string) => Promise<(object & {undoId?:string})|null>,
 *   createWindow: (windowId:number,dueAt:number,recurrence?:string) => Promise<(object & {undoId?:string})|null>,
 *   deliver: (id:string,options:{manual:boolean,expected:object}) => Promise<{status:string}>,
 *   deliverSelections: (selections:object[]) => Promise<{status:string,opened:number}>
 * }} snoozes
 */
export function createSnoozeMessageHandlers(snoozes) {
  return [
    handler(
      "snooze-tab",
      (message) => isId(message.tabId) && Number.isFinite(message.dueAt) &&
        isOptionalText(message.recurrence),
      async (message) => {
        const tab = await snoozes.getTab(message.tabId);
        const snooze = await snoozes.createTab(tab, message.dueAt, message.recurrence);
        return { ok: !!snooze, undoId: snooze?.undoId ?? null };
      },
      { ok: false, undoId: null }
    ),
    handler(
      "snooze-window",
      (message) => isId(message.windowId) && Number.isFinite(message.dueAt) &&
        isOptionalText(message.recurrence),
      async (message) => {
        const snooze = await snoozes.createWindow(
          message.windowId, message.dueAt, message.recurrence
        );
        return {
          ok: !!snooze,
          undoId: snooze?.undoId ?? null,
          n: snooze?.tabs?.length ?? 0
        };
      },
      { ok: false, undoId: null, n: 0 }
    ),
    handler(
      "wake-snooze",
      (message) => isNonEmptyText(message.id) &&
        message.expected && typeof message.expected === "object" &&
        !Array.isArray(message.expected) && message.expected.id === message.id,
      async (message) => {
        const expected = structuredClone(message.expected);
        const result = await snoozes.deliveryReady.then(() =>
          snoozes.deliver(expected.id, { manual: true, expected })
        );
        return { ok: result.status === "delivered", status: result.status,
          ...(result.reason === "session-unavailable" ? { reason: result.reason } : {}) };
      },
      { ok: false, status: "failed" }
    ),
    handler(
      "wake-snooze-tabs",
      (message) => Array.isArray(message.selections) && message.selections.length > 0 &&
        message.selections.every((selection) => isNonEmptyText(selection?.snooze?.id) &&
          Array.isArray(selection.indexes) && selection.indexes.length > 0 &&
          selection.indexes.every(isId)),
      async (message) => {
        const selections = structuredClone(message.selections);
        try {
          await snoozes.deliveryReady;
          const result = await snoozes.deliverSelections(selections);
          return { ok: result.status === "delivered", status: result.status,
            opened: result.opened };
        } catch (error) {
          return { ok: false, status: error?.reason ?? "failed",
            opened: Number.isInteger(error?.opened) ? error.opened : 0 };
        }
      },
      { ok: false, status: "failed", opened: 0 }
    )
  ];
}
