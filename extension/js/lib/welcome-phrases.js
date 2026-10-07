// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal New Tab welcome phrases.
 *
 * The phrases themselves are ordinary portable Settings data. The shuffle-bag
 * receipt is deliberately content-free operational state: it remembers only
 * indexes and a bounded fingerprint, so it never duplicates personal copy in
 * another storage surface.
 */

export const WELCOME_PHRASE_MAX_COUNT = 100;
export const WELCOME_PHRASE_MAX_LENGTH = 96;
export const WELCOME_PHRASE_STATE_VERSION = 1;

/** @param {unknown} value @returns {string[]} */
export function normalizeWelcomePhrases(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/u)
      : [];
  const phrases = [];
  const seen = new Set();
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const normalized = entry.normalize("NFC").trim();
    if (!normalized) continue;
    const phrase = [...normalized].slice(0, WELCOME_PHRASE_MAX_LENGTH).join("");
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
    if (phrases.length >= WELCOME_PHRASE_MAX_COUNT) break;
  }
  return phrases;
}

function phrasePoolKey(phrases) {
  // Two small independent integer hashes make accidental reuse after a phrase
  // edit vanishingly unlikely without storing the user's phrase text here.
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (const phrase of phrases) {
    for (const code of `${phrase}\u0000`) {
      const value = code.codePointAt(0);
      fnv ^= value;
      fnv = Math.imul(fnv, 0x01000193) >>> 0;
      djb = (Math.imul(djb, 33) ^ value) >>> 0;
    }
  }
  return `${WELCOME_PHRASE_STATE_VERSION}:${phrases.length}:${fnv.toString(36)}:${djb.toString(36)}`;
}

function shuffledIndexes(length, random) {
  const indexes = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    const sample = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
    const other = Math.floor(sample * (index + 1));
    [indexes[index], indexes[other]] = [indexes[other], indexes[index]];
  }
  return indexes;
}

function validRemaining(value, length) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (!Number.isInteger(entry) || entry < 0 || entry >= length || seen.has(entry)) return null;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Draw one phrase from a non-repeating shuffled bag.
 * @param {unknown} value string array or newline-separated editor value
 * @param {unknown} state prior content-free shuffle receipt
 * @param {() => number} [random]
 * @returns {{phrase:string,index:number,state:(object|null)}}
 */
export function drawWelcomePhrase(value, state, random = Math.random) {
  const phrases = normalizeWelcomePhrases(value);
  if (phrases.length === 0) return { phrase: "", index: -1, state: null };

  const poolKey = phrasePoolKey(phrases);
  const prior = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const lastIndex = Number.isInteger(prior.lastIndex) &&
    prior.lastIndex >= 0 && prior.lastIndex < phrases.length
    ? prior.lastIndex
    : -1;
  let remaining = prior.version === WELCOME_PHRASE_STATE_VERSION && prior.poolKey === poolKey
    ? validRemaining(prior.remaining, phrases.length)
    : null;

  if (!remaining?.length) {
    remaining = shuffledIndexes(phrases.length, random);
    // The bag already prevents repeats within a cycle. Avoid the only repeat
    // it could otherwise create: the boundary between consecutive cycles.
    if (remaining.length > 1 && remaining[0] === lastIndex) {
      [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
    }
  }

  const index = remaining.shift();
  return {
    phrase: phrases[index],
    index,
    state: {
      version: WELCOME_PHRASE_STATE_VERSION,
      poolKey,
      remaining,
      lastIndex: index
    }
  };
}
