// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Editor-only trial palettes.
 *
 * Candidates can be compared, edited, and saved as custom schemes. They never
 * enter the built-in catalogue, rotation pool, or first-paint theme path until
 * a direction is explicitly promoted.
 */
import { compileSimpleMode, createDraftFixture } from "./scheme-tokens.js";

const candidate = (label, defaultMode, light, dark, gradients) => Object.freeze({
  label,
  defaultMode,
  simple: Object.freeze({ light: Object.freeze(light), dark: Object.freeze(dark) }),
  gradients: Object.freeze({
    light: Object.freeze(gradients.light),
    dark: Object.freeze(gradients.dark)
  })
});

const DEFINITIONS = Object.freeze({});

export const SCHEME_CANDIDATES = Object.freeze(Object.keys(DEFINITIONS));
export const SCHEME_CANDIDATE_META = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([id, definition]) => [id, Object.freeze({
    label: definition.label,
    defaultMode: definition.defaultMode
  })])
));

export function createCandidateSchemeDraft(id) {
  const definition = DEFINITIONS[id];
  if (!definition) {
    return { ok: false, value: null, errors: [{
      code: "value.candidate",
      message: "That candidate scheme is unavailable."
    }] };
  }
  const roles = {};
  const errors = [];
  for (const mode of ["light", "dark"]) {
    const [first, middle, last, angle] = definition.gradients[mode];
    const compiled = compileSimpleMode(definition.simple[mode], {
      mode,
      overrides: {
        gradientStops: [first, middle, last],
        gradientAngle: angle,
        gradientStopPositions: [0, 55, 100]
      }
    });
    errors.push(...compiled.errors);
    roles[mode] = compiled.roles;
  }
  if (errors.length) return { ok: false, value: null, errors };
  return createDraftFixture({
    name: definition.label,
    defaultMode: definition.defaultMode,
    authoringMode: "advanced",
    simple: structuredClone(definition.simple),
    roles
  });
}
