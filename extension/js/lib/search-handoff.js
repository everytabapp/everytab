// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * The deliberately small seam between EveryTab search and Chrome navigation.
 * It is pure so every Search host (and the omnibox) agrees on when a local
 * miss may leave EveryTab. Dispatch belongs to the calling surface.
 */

const FILTER_PREFIXES = ["in", "label", "session", "view"];

/** @param {string} value */
function isPartialFilterKeyword(value) {
  const lower = value.toLowerCase();
  return FILTER_PREFIXES.some((prefix) => prefix.startsWith(lower));
}

/** @param {string} value */
function isRecognizedFilterExpression(value) {
  return /^(?:in|label|session|view):/i.test(value);
}

/** @param {string} value */
function isExplicitWebUrl(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A hostname is intentionally conservative: a dotted DNS name, localhost, or
 * an IPv4 address, with an optional port and path. Search text such as
 * "plan.q3" still opens as a site, matching Chrome's familiar hostname rule.
 */
const BARE_HOST = /^(?:(?:localhost)|(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)|(?:(?:\d{1,3}\.){3}\d{1,3}))(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** @param {string} value */
function isBareHost(value) {
  return BARE_HOST.test(value);
}

/**
 * Classify raw Search input after EveryTab has found no local action.
 *
 * @param {string} raw
 * @returns {{type: "open-url", url: string}|{type: "search-web", text: string}|null}
 */
export function browserHandoffForInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length < 2) return null;
  if (isPartialFilterKeyword(text) || isRecognizedFilterExpression(text)) return null;
  if (isExplicitWebUrl(text)) return { type: "open-url", url: text };
  if (isBareHost(text)) return { type: "open-url", url: `https://${text}` };
  return { type: "search-web", text };
}

export { isBareHost, isExplicitWebUrl, isPartialFilterKeyword, isRecognizedFilterExpression };
