// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Bounded, storage-free JSON fixture format for ephemeral Scheme Lab drafts. */
import {
  MODES,
  exactKeys,
  issue,
  validateRoleMap,
  validateSimpleSource
} from "./scheme-token-contract.js";

export const SCHEME_FORMAT_VERSION = 1;
export const DRAFT_FORMAT_VERSION = 1;
export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_SCHEME_NAME_LENGTH = 64;

const SAFE_NAME_RE = /^[^\u0000-\u001f\u007f]*$/;

function validName(name, errors) {
  if (typeof name !== "string" || !name.trim() || name.length > MAX_SCHEME_NAME_LENGTH ||
      !SAFE_NAME_RE.test(name)) {
    errors.push(issue(
      "value.name",
      `Name must be 1–${MAX_SCHEME_NAME_LENGTH} visible characters with no control characters.`
    ));
    return "";
  }
  return name.trim();
}

function validateModeMap(container, validate, where, errors) {
  errors.push(...exactKeys(container, MODES, where));
  const value = {};
  if (!container || typeof container !== "object" || Array.isArray(container)) return value;
  for (const mode of MODES) {
    const result = validate(container[mode], mode);
    errors.push(...result.errors);
    if (result.value) value[mode] = result.value;
  }
  return value;
}

export function createDraftFixture({
  name = "Untitled scheme",
  defaultMode = "light",
  authoringMode = "simple",
  simple,
  roles
}) {
  return validateDraftFixture({
    app: "everytab",
    kind: "color-scheme-draft",
    formatVersion: DRAFT_FORMAT_VERSION,
    name,
    defaultMode,
    authoringMode,
    simple,
    roles
  });
}

export function validateDraftFixture(candidate) {
  const errors = exactKeys(candidate, [
    "app", "kind", "formatVersion", "name", "defaultMode", "authoringMode", "simple", "roles"
  ], "Draft fixture");
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, value: null, errors };
  }
  if (candidate.app !== "everytab") {
    errors.push(issue("value.app", "Draft app must be “everytab”."));
  }
  if (candidate.kind !== "color-scheme-draft") {
    errors.push(issue("value.kind", "This file is not an EveryTab colour-scheme draft."));
  }
  if (candidate.formatVersion !== DRAFT_FORMAT_VERSION) {
    errors.push(issue(
      "value.format-version",
      `Draft format ${candidate.formatVersion} is not supported; expected ${DRAFT_FORMAT_VERSION}.`
    ));
  }
  const name = validName(candidate.name, errors);
  if (!MODES.includes(candidate.defaultMode)) {
    errors.push(issue("value.default-mode", "Default mode must be light or dark."));
  }
  if (!["simple", "advanced"].includes(candidate.authoringMode)) {
    errors.push(issue("value.authoring-mode", "Authoring mode must be simple or advanced."));
  }
  const simple = validateModeMap(candidate.simple,
    (value, mode) => validateSimpleSource(value, { where: `${mode} Simple colours` }),
    "Draft simple modes", errors);
  const roles = validateModeMap(candidate.roles, (value, mode) => {
    const result = validateRoleMap(value, { id: "draft", mode });
    return { ...result, value };
  }, "Draft role modes", errors);
  const value = {
    app: "everytab",
    kind: "color-scheme-draft",
    formatVersion: DRAFT_FORMAT_VERSION,
    name,
    defaultMode: MODES.includes(candidate.defaultMode) ? candidate.defaultMode : "light",
    authoringMode: candidate.authoringMode === "advanced" ? "advanced" : "simple",
    simple,
    roles
  };
  return { ok: errors.length === 0, value, errors };
}

export function serializeDraftFixture(candidate) {
  const validation = validateDraftFixture(candidate);
  if (!validation.ok) return { ok: false, text: "", errors: validation.errors };
  return { ok: true, text: `${JSON.stringify(validation.value, null, 2)}\n`, errors: [] };
}

export function parseDraftFixture(input) {
  const text = typeof input === "string" ? input : "";
  if (new TextEncoder().encode(text).length > MAX_DRAFT_BYTES) {
    return {
      ok: false,
      value: null,
      errors: [issue(
        "value.file-size",
        `Draft exceeds the ${MAX_DRAFT_BYTES / 1024} KiB limit.`
      )]
    };
  }
  try {
    return validateDraftFixture(JSON.parse(text));
  } catch {
    return {
      ok: false,
      value: null,
      errors: [issue("value.json", "Draft is not valid JSON.")]
    };
  }
}
