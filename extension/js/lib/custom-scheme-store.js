/** Coordinated persistence operations for custom colour schemes and their one local draft. */
import { mutateStores, readStoreMap } from "./store.js";
import { DEFAULT_SETTINGS, STORE_KEYS } from "./types.js";
import {
  CUSTOM_SCHEME_DRAFT_KEY,
  customSchemeIdFromRef,
  customSchemeRef
} from "./custom-schemes.js";
import {
  SCHEME_ROTATION_PREPARED_KEY
} from "./scheme-rotation.js";

const ROTATION_STATE_KEY = "schemeRotationState";

export async function loadCustomSchemeDraft() {
  const stored = await readStoreMap(CUSTOM_SCHEME_DRAFT_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored : null;
}

/** Drafts are local operational state. A null value deliberately means cleared. */
export async function saveCustomSchemeDraft(value) {
  await mutateStores([CUSTOM_SCHEME_DRAFT_KEY], () => ({
    [CUSTOM_SCHEME_DRAFT_KEY]: value && typeof value === "object"
      ? structuredClone(value) : null
  }));
}

/**
 * Tombstone one record and repair every setting that can reference it in the
 * same atomic storage commit. This prevents a deleted active scheme from
 * flashing through a transient missing-reference state.
 */
export async function deleteCustomSchemeAndRepair(id) {
  const ref = customSchemeRef(id);
  if (!ref || customSchemeIdFromRef(ref) !== id.toLowerCase()) return false;
  let deleted = false;
  await mutateStores([
    STORE_KEYS.customSchemes,
    "settings",
    "settingsModifiedAt",
    ROTATION_STATE_KEY,
    SCHEME_ROTATION_PREPARED_KEY
  ], (maps) => {
    const records = { ...(maps[STORE_KEYS.customSchemes] ?? {}) };
    const record = records[id] ?? records[id.toLowerCase()];
    if (!record || record.deletedAt) return null;
    const now = Date.now();
    records[record.id] = { ...record, deletedAt: now, modifiedAt: now };
    const settings = { ...DEFAULT_SETTINGS, ...(maps.settings ?? {}) };
    settings.uiScheme = settings.uiScheme === ref ? "cream" : settings.uiScheme;
    settings.schemeFavorites = (Array.isArray(settings.schemeFavorites)
      ? settings.schemeFavorites : []).filter((entry) => entry !== ref);
    deleted = true;
    return {
      [STORE_KEYS.customSchemes]: records,
      settings,
      settingsModifiedAt: now,
      [ROTATION_STATE_KEY]: null,
      [SCHEME_ROTATION_PREPARED_KEY]: null
    };
  });
  return deleted;
}
