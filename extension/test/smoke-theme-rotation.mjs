import fs from "node:fs";
import { getSettings } from "../js/lib/store.js";
import {
  SCHEMES,
  SCHEME_META,
  normalizeScheme,
  resolveSchemeMode
} from "../js/lib/schemes.js";
import {
  rotationPool,
  drawNextScheme,
  rotateScheme,
  ensureSchemeRotationAlarm,
  prepareNextSchemeOnOpen,
  maybeRotateSchemeOnOpen,
  SCHEME_ROTATION_ALARM,
  SCHEME_ROTATION_PREPARED_KEY
} from "../js/lib/scheme-rotation.js";

/** Scheme catalogue, cadence, and persisted on-open reservation contracts. */
export async function runSmokeThemeRotation({ check, local, alarms }) {
  check(
    SCHEMES.length === 36 && new Set(SCHEMES).size === 36,
    "D3: exactly 36 unique canonical schemes"
  );
  check(
    SCHEMES.every((id) => SCHEME_META[id]?.label && SCHEME_META[id]?.accent &&
      ["light", "dark"].includes(SCHEME_META[id]?.defaultMode)),
    "D3: every scheme has a label, swatch, and canonical mode"
  );
  check(
    normalizeScheme("everforest") === "matcha" &&
      normalizeScheme("catppuccin") === "dracula" &&
      normalizeScheme("rosepine") === "dracula" &&
      normalizeScheme("unknown") === "cream",
    "D3: retired overlapping schemes and Everforest keep safe compatibility aliases"
  );
  check(
    resolveSchemeMode("light", "phosphor", true) === "light" &&
      resolveSchemeMode("dark", "cream", false) === "dark" &&
      resolveSchemeMode("system", "cream", true) === "dark" &&
      resolveSchemeMode("scheme", "phosphor", false) === "dark" &&
      resolveSchemeMode("scheme", "meadow", true) === "light",
    "D3: forced, system, and Scheme default modes resolve independently"
  );
  check(
    rotationPool(["tide", "bogus", "tide"]).length === 1 &&
      rotationPool(["tide"])[0] === "tide" && rotationPool([]).length === 36,
    "D3: favorites constrain rotation; invalid ids are ignored; empty means all"
  );

  let state = {};
  const seen = [];
  let current = "cream";
  for (let index = 0; index < 3; index++) {
    const draw = drawNextScheme(current, ["cream", "tide", "ember"], state, () => 0.25);
    seen.push(draw.next);
    current = draw.next;
    state = draw.state;
  }
  check(new Set(seen).size === 3, "D3: shuffle bag visits every favorite before repeating");
  check(
    drawNextScheme("tide", ["tide"], {}, () => 0).next === "tide",
    "D3: one-scheme rotation pool is a safe no-op"
  );
  check(
    drawNextScheme("dasher", [], null, () => 0.25).next !== "dasher",
    "D3: an explicitly cleared rotation bag restarts safely on the next draw"
  );
  check(
    drawNextScheme("tide", ["cream", "tide", "ember"], {
      poolKey: "cream|ember|tide",
      remaining: ["cream", "ember", "tide"]
    }, () => 0).next === "ember",
    "D3: a manual scheme choice is removed from the pending bag before the next draw"
  );

  local.settings = { uiScheme: "everforest" };
  check(
    (await getSettings()).uiScheme === "matcha",
    "D3: settings normalization permanently migrates stored Everforest selection"
  );
  local.settings = { schemeRotate: "hourly" };
  await ensureSchemeRotationAlarm();
  check(
    alarms[SCHEME_ROTATION_ALARM]?.periodInMinutes === 60,
    "D3: hourly cadence repairs the single rotation alarm"
  );
  local.settings = { schemeRotate: "daily" };
  await ensureSchemeRotationAlarm();
  check(
    alarms[SCHEME_ROTATION_ALARM]?.periodInMinutes === 1440,
    "D3: daily cadence repairs the same rotation alarm"
  );
  local.settings = { schemeRotate: "off" };
  await ensureSchemeRotationAlarm();
  check(!(SCHEME_ROTATION_ALARM in alarms), "D3: Off clears the rotation alarm");

  const background = fs.readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
  check(
    /if \(alarm\.name === SCHEME_ROTATION_ALARM\) await rotateScheme\(\)/.test(background) &&
      /changes\.settings[\s\S]{0,180}ensureSchemeRotationAlarm\(\)/.test(background),
    "D3: worker dispatches hourly/daily alarms and repairs cadence after Settings changes"
  );

  local.settings = { uiScheme: "cream", schemeFavorites: ["tide"], schemeRotate: "off" };
  delete local.schemeRotationState;
  check(
    await rotateScheme() === true && local.settings.uiScheme === "tide" &&
      typeof local.settingsModifiedAt === "number" && local.schemeRotationState,
    "D3: rotation atomically writes normal synced scheme + local shuffle state"
  );

  local.settings = {
    uiScheme: "cream",
    uiMode: "scheme",
    schemeFavorites: ["cream", "tide", "ember"],
    schemeRotate: "open"
  };
  delete local.schemeRotationState;
  delete local[SCHEME_ROTATION_PREPARED_KEY];
  const reservedScheme = await prepareNextSchemeOnOpen(() => 0.25);
  check(
    local.settings.uiScheme === "cream" && reservedScheme !== "cream" &&
      local[SCHEME_ROTATION_PREPARED_KEY]?.next === reservedScheme,
    "D3/E3: preparing the next on-open scheme advances the bag without changing today's scheme"
  );
  const consumed = await maybeRotateSchemeOnOpen(() => 0.25);
  check(
    local.settings.uiScheme === reservedScheme && consumed?.scheme === reservedScheme &&
      consumed?.nextScheme === local[SCHEME_ROTATION_PREPARED_KEY]?.next,
    "D3/E3: on-open rotation consumes the exact pre-painted scheme and reserves its successor atomically"
  );

  delete local.settings;
  delete local.settingsModifiedAt;
  delete local.schemeRotationState;
  delete local[SCHEME_ROTATION_PREPARED_KEY];
}
