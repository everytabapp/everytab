// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** The CSS clamp used by Minimal Search, expressed for geometry projections. */
export function minimalExpandedDeckHeight(viewportHeight) {
  const height = Number(viewportHeight);
  return Math.max(0, Math.min(720, Math.max(560, height * 0.76), height - 84));
}

/**
 * Space below Minimal's Search field after its anchored deck reaches the
 * target state. Measuring the field while the deck is moving creates a false
 * smaller cap and a second resize at transition end.
 */
export function minimalSearchResultsRoom({
  viewportHeight,
  fieldBottom,
  deckHeight,
  expanded,
  bottomClearance = 24
}) {
  const projectedFieldBottom = expanded
    ? Number(fieldBottom) - (minimalExpandedDeckHeight(viewportHeight) - Number(deckHeight))
    : Number(fieldBottom);
  return Math.max(0, Math.floor(Number(viewportHeight) - projectedFieldBottom - bottomClearance));
}
