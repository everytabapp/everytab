// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared interpretation rules; opaque backup/export does not use these guards. */
import { SCHEMA_VERSION, STORE_KEYS } from "../types.js";
import { STORAGE_SETTINGS_FAMILY, STORAGE_LABEL_META_FAMILY } from "./constants.js";

const RECORD_FAMILIES = new Set([
  ...Object.values(STORE_KEYS), STORAGE_SETTINGS_FAMILY, STORAGE_LABEL_META_FAMILY
]);

export function requireSupportedFamily(family) {
  if (!RECORD_FAMILIES.has(family)) {
    throw new Error("Unsupported saved-data family. Update EveryTab before using this data.");
  }
}

/** Missing declarations are valid current records; explicit versions must be understood. */
export function requireSupportedValue(value) {
  if (value?.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Unsupported saved-data version. Update EveryTab before using this data.");
  }
}

export function requireSupportedEntity(entity) {
  if (!entity) return;
  requireSupportedFamily(entity.family);
  if (entity.lifecycle === "live") requireSupportedValue(entity.value);
}
