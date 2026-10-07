// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isOptionalText = (value) => value === undefined || typeof value === "string";
const noPayload = () => true;
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe action-journal Undo and clearing messages. Both operations wait for
 * interrupted action recovery before consulting journal state.
 *
 * @param {{
 *   ready: Promise<unknown>,
 *   undo: (id?:string) => Promise<{status:string,entry?:unknown}>,
 *   clear: () => Promise<unknown>
 * }} journal
 */
export function createJournalMessageHandlers(journal) {
  return [
    handler(
      "undo-last",
      (message) => isOptionalText(message.id),
      async (message) => {
        const result = await journal.ready.then(() => journal.undo(message.id));
        return {
          ok: result.status === "undone",
          status: result.status,
          entry: result.entry
        };
      },
      { ok: false, status: "unavailable", entry: null }
    ),
    handler(
      "clear-journal",
      noPayload,
      () => journal.ready.then(() => journal.clear()),
      { ok: false }
    )
  ];
}
