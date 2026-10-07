// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * @typedef {Object} MessageHandler
 * @property {string} type
 * @property {"sync"|"async"} mode
 * @property {(message: Record<string, unknown>, sender: Record<string, unknown>) => boolean} validate
 * @property {(message: Record<string, unknown>, sender: Record<string, unknown>) => unknown} handle
 * @property {unknown|((error: unknown, message: Record<string, unknown>, sender: Record<string, unknown>) => unknown)} failure
 */

function failureResponse(handler, error, message, sender) {
  return typeof handler.failure === "function"
    ? handler.failure(error, message, sender)
    : handler.failure;
}

function settleAsyncResponse(handler, message, sender, sendResponse, onError) {
  let task;
  try {
    task = handler.handle(message, sender);
  } catch (error) {
    onError(error, handler.type);
    sendResponse(failureResponse(handler, error, message, sender));
    return;
  }
  Promise.resolve(task).then(sendResponse, (error) => {
    onError(error, handler.type);
    sendResponse(failureResponse(handler, error, message, sender));
  });
}

/**
 * Builds one Chrome runtime listener from an explicit, validated message contract.
 * The returned listener preserves Chrome's response-channel rule: synchronous
 * handlers answer before returning false; asynchronous handlers return true and
 * settle exactly one response for success, validation failure, or rejection.
 *
 * @param {MessageHandler[]} handlers
 * @param {{
 *   fallback?: (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean,
 *   onError?: (error: unknown, type: string) => void
 * }} [options]
 * @returns {(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean}
 */
export function createMessageListener(handlers, options = {}) {
  if (!Array.isArray(handlers)) throw new TypeError("Message handlers must be an array");
  const byType = new Map();
  for (const handler of handlers) {
    if (!handler || typeof handler.type !== "string" || !handler.type.trim()) {
      throw new TypeError("Every message handler needs a non-empty type");
    }
    if (byType.has(handler.type)) throw new TypeError(`Duplicate message handler: ${handler.type}`);
    if (!["sync", "async"].includes(handler.mode) ||
        typeof handler.validate !== "function" || typeof handler.handle !== "function" ||
        !("failure" in handler)) {
      throw new TypeError(`Invalid message handler: ${handler.type}`);
    }
    byType.set(handler.type, Object.freeze({ ...handler }));
  }

  const fallback = typeof options.fallback === "function" ? options.fallback : () => false;
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  return (message, sender, sendResponse) => {
    const type = message && typeof message === "object" && !Array.isArray(message)
      ? message.type
      : null;
    const handler = typeof type === "string" ? byType.get(type) : null;
    if (!handler) return fallback(message, sender, sendResponse) === true;

    const safeMessage = /** @type {Record<string, unknown>} */ (message);
    const safeSender = sender && typeof sender === "object"
      ? /** @type {Record<string, unknown>} */ (sender)
      : {};
    let valid = false;
    try {
      valid = handler.validate(safeMessage, safeSender) === true;
    } catch (error) {
      onError(error, handler.type);
    }
    if (!valid) {
      sendResponse(failureResponse(
        handler, new TypeError(`Invalid message: ${handler.type}`), safeMessage, safeSender
      ));
      return handler.mode === "async";
    }

    if (handler.mode === "async") {
      settleAsyncResponse(handler, safeMessage, safeSender, sendResponse, onError);
      return true;
    }

    try {
      sendResponse(handler.handle(safeMessage, safeSender));
    } catch (error) {
      onError(error, handler.type);
      sendResponse(failureResponse(handler, error, safeMessage, safeSender));
    }
    return false;
  };
}
