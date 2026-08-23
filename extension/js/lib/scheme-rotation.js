/** D3 — no-repeat scheme rotation and its single alarm. */
import { DEFAULT_SETTINGS, STORE_KEYS } from "./types.js";
import { getSettings, mutateStores } from "./store.js";
import {
  availableSchemeIds, resolveSchemeSelection
} from "./custom-schemes.js";

export const SCHEME_ROTATION_ALARM = "scheme-rotation";
const STATE_KEY = "schemeRotationState";
export const SCHEME_ROTATION_PREPARED_KEY = "schemeRotationPrepared";

export function rotationPool(favorites = [], customRecords = []) {
  const available = availableSchemeIds(customRecords);
  const availableSet = new Set(available);
  const wanted = new Set((Array.isArray(favorites) ? favorites : [])
    // Favorites are a filter, not an active-theme fallback. Silently ignore an
    // unavailable value instead of turning it into Cream; keep the one legacy
    // built-in alias that predates the Matcha rename.
    .map((id) => ({ everforest: "matcha", catppuccin: "dracula", rosepine: "dracula" }[id] ?? id))
    .filter((id) => availableSet.has(id)));
  const valid = available.filter((id) => wanted.has(id));
  return valid.length ? valid : available;
}

function shuffled(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pure draw used by runtime and smoke tests. */
export function drawNextScheme(
  current,
  favorites,
  state = {},
  random = Math.random,
  customRecords = []
) {
  const priorState = state && typeof state === "object" && !Array.isArray(state)
    ? state : {};
  const pool = rotationPool(favorites, customRecords);
  const poolKey = pool.join("|");
  if (pool.length === 1 && pool[0] === current) return { next: current, state: { poolKey, remaining: [] } };

  let remaining = priorState.poolKey === poolKey && Array.isArray(priorState.remaining)
    // A user may manually choose a scheme which is still waiting in this bag.
    // Remove the now-current value before drawing; otherwise it can sit at the
    // pop end forever because the no-op path deliberately does not commit.
    ? priorState.remaining.filter((id) => pool.includes(id) && id !== current)
    : [];
  if (!remaining.length) {
    remaining = shuffled(pool, random);
    if (remaining.length > 1 && remaining[remaining.length - 1] === current) {
      [remaining[0], remaining[remaining.length - 1]] = [remaining[remaining.length - 1], remaining[0]];
    }
  }
  const next = remaining.pop() ?? current;
  return { next, state: { poolKey, remaining } };
}

export async function rotateScheme() {
  let changed = false;
  await mutateStores(
    ["settings", STORE_KEYS.customSchemes, STATE_KEY, "settingsModifiedAt", SCHEME_ROTATION_PREPARED_KEY],
    (maps) => {
    const stored = maps.settings ?? {};
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    const customRecords = maps[STORE_KEYS.customSchemes] ?? {};
    const current = resolveSchemeSelection(settings.uiScheme, customRecords).selection;
    const draw = drawNextScheme(
      current, settings.schemeFavorites, maps[STATE_KEY], Math.random, customRecords
    );
    if (draw.next === current) return null;
    changed = true;
    return {
      settings: { ...settings, uiScheme: draw.next },
      settingsModifiedAt: Date.now(),
      [STATE_KEY]: draw.state,
      // Hourly/daily rotation invalidates any page-prepared on-open choice.
      [SCHEME_ROTATION_PREPARED_KEY]: null
    };
  });
  return changed;
}

const poolKeyFor = (settings, customRecords) =>
  rotationPool(settings.schemeFavorites, customRecords).join("|");
const validPrepared = (prepared, current, poolKey) =>
  prepared && prepared.from === current && prepared.next !== current &&
  prepared.poolKey === poolKey &&
  poolKey.split("|").includes(prepared.next);

/**
 * Reserve the next "on open" draw without changing the active scheme. The
 * returned value can be cached in localStorage by a document for synchronous
 * pre-paint use on the next New Tab. The shuffle-bag state advances in the same
 * atomic commit as the reservation, so the eventual consumer cannot pick a
 * different scheme.
 * @param {() => number} [random]
 * @returns {Promise<string|null>}
 */
export async function prepareNextSchemeOnOpen(random = Math.random) {
  if ((await getSettings()).schemeRotate !== "open") return null;
  let next = null;
  await mutateStores(
    ["settings", STORE_KEYS.customSchemes, STATE_KEY, SCHEME_ROTATION_PREPARED_KEY],
    (maps) => {
      const settings = { ...DEFAULT_SETTINGS, ...(maps.settings ?? {}) };
      if (settings.schemeRotate !== "open") return null;
      const customRecords = maps[STORE_KEYS.customSchemes] ?? {};
      const current = resolveSchemeSelection(settings.uiScheme, customRecords).selection;
      const poolKey = poolKeyFor(settings, customRecords);
      const prepared = maps[SCHEME_ROTATION_PREPARED_KEY];
      if (validPrepared(prepared, current, poolKey)) {
        next = prepared.next;
        return null;
      }
      const draw = drawNextScheme(
        current, settings.schemeFavorites, maps[STATE_KEY], random, customRecords
      );
      next = draw.next;
      if (draw.next === current) return null;
      return {
        [STATE_KEY]: draw.state,
        [SCHEME_ROTATION_PREPARED_KEY]: { from: current, next: draw.next, poolKey }
      };
    }
  );
  return next;
}

/**
 * Consume the pre-painted on-open choice, then reserve its successor in the
 * same commit. If no valid reservation exists (first run/changed favorites),
 * draw now and continue normally.
 * @param {() => number} [random]
 * @param {string|null} [commitToken] local identity used by the opening page to
 * distinguish its own storage broadcast from another context's rotation
 * @returns {Promise<{changed:boolean, scheme:string, nextScheme:string|null}|null>}
 */
export async function maybeRotateSchemeOnOpen(random = Math.random, commitToken = null) {
  if ((await getSettings()).schemeRotate !== "open") return null;
  let result = null;
  await mutateStores(
    ["settings", STORE_KEYS.customSchemes, STATE_KEY, "settingsModifiedAt", SCHEME_ROTATION_PREPARED_KEY],
    (maps) => {
      const settings = { ...DEFAULT_SETTINGS, ...(maps.settings ?? {}) };
      if (settings.schemeRotate !== "open") return null;
      const customRecords = maps[STORE_KEYS.customSchemes] ?? {};
      const current = resolveSchemeSelection(settings.uiScheme, customRecords).selection;
      const poolKey = poolKeyFor(settings, customRecords);
      const prepared = maps[SCHEME_ROTATION_PREPARED_KEY];
      let next = prepared?.next;
      let state = maps[STATE_KEY];
      if (!validPrepared(prepared, current, poolKey)) {
        const draw = drawNextScheme(
          current, settings.schemeFavorites, state, random, customRecords
        );
        next = draw.next;
        state = draw.state;
      }
      if (next === current) {
        result = { changed: false, scheme: current, nextScheme: current };
        return null;
      }
      const following = drawNextScheme(
        next, settings.schemeFavorites, state, random, customRecords
      );
      result = { changed: true, scheme: next, nextScheme: following.next };
      return {
        settings: { ...settings, uiScheme: next },
        settingsModifiedAt: Date.now(),
        [STATE_KEY]: following.state,
        [SCHEME_ROTATION_PREPARED_KEY]: {
          from: next, next: following.next, poolKey,
          ...(typeof commitToken === "string" && commitToken ? { commitToken } : {})
        }
      };
    }
  );
  return result;
}

export async function ensureSchemeRotationAlarm() {
  const { schemeRotate } = await getSettings();
  await chrome.alarms.clear(SCHEME_ROTATION_ALARM);
  if (schemeRotate === "hourly") {
    await chrome.alarms.create(SCHEME_ROTATION_ALARM, { periodInMinutes: 60 });
  } else if (schemeRotate === "daily") {
    await chrome.alarms.create(SCHEME_ROTATION_ALARM, { periodInMinutes: 1440 });
  }
}
