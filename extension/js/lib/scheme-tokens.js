/**
 * EveryTab colour-scheme compiler and ephemeral draft format.
 *
 * Schema/validation, unquantized colour math, and gradient parsing live in
 * focused pure helpers. This facade preserves the one import used by the Lab
 * and command-line QA without returning to one over-budget utility module.
 */
import {
  CONTRAST_THRESHOLDS,
  ROLE_KEYS,
  issue,
  validateGradientStops,
  validateHexField,
  validateRoleMap,
  validateSimpleSource
} from "./scheme-token-contract.js";
import {
  averageSrgb,
  contrastRatio,
  mixHex,
  mixSrgb,
  rgbToHex
} from "./scheme-token-color.js";

export * from "./scheme-token-color.js";
export * from "./scheme-token-contract.js";
export * from "./scheme-token-draft.js";

const STATUS_SEEDS = Object.freeze({
  ok: "#4f7d46",
  warn: "#9a6b12",
  danger: "#b04435"
});

function minimumContrast(color, surfaces) {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface) ?? 0));
}

function fitToward(color, target, surfaces, threshold) {
  let last = null;
  for (let step = 0; step <= 1000; step++) {
    const amount = step / 1000;
    const candidate = rgbToHex(mixSrgb(color, target, amount));
    if (minimumContrast(candidate, surfaces) + 1e-12 >= threshold) {
      last = { color: candidate, amount };
    } else if (last) {
      break;
    }
  }
  return last;
}

function fitToNearestPole(color, surfaces, threshold) {
  if (minimumContrast(color, surfaces) + 1e-12 >= threshold) {
    return { color, amount: 0, pole: null };
  }
  const candidates = [];
  for (const pole of ["#000000", "#ffffff"]) {
    for (let step = 1; step <= 1000; step++) {
      const amount = step / 1000;
      const candidate = rgbToHex(mixSrgb(color, pole, amount));
      if (minimumContrast(candidate, surfaces) + 1e-12 >= threshold) {
        candidates.push({ color: candidate, amount, pole });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.amount - b.amount ||
    minimumContrast(b.color, surfaces) - minimumContrast(a.color, surfaces));
  return candidates[0] ?? null;
}

function fitStatusMarker(color, surfaces, amount, threshold) {
  const score = (candidate) => Math.min(...surfaces.map((surface) =>
    contrastRatio(candidate, mixSrgb(surface, candidate, amount)) ?? 0));
  if (score(color) + 1e-12 >= threshold) return { color, amount: 0, pole: null };
  const candidates = [];
  for (const pole of ["#000000", "#ffffff"]) {
    for (let step = 1; step <= 1000; step++) {
      const amountToPole = step / 1000;
      const candidate = rgbToHex(mixSrgb(color, pole, amountToPole));
      if (score(candidate) + 1e-12 >= threshold) {
        candidates.push({ color: candidate, amount: amountToPole, pole });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.amount - b.amount || score(b.color) - score(a.color));
  return candidates[0] ?? null;
}

function generatedGradient(source) {
  return {
    gradientStops: [
      mixHex(source.page, source.accent, 0.06),
      mixHex(source.page, source.surface, 0.35),
      mixHex(source.page, source.secondaryAccent, 0.08)
    ],
    gradientAngle: 135,
    gradientStopPositions: [0, 55, 100]
  };
}

function componentSurfaces(source, mode) {
  const workbenchRow = mode === "dark"
    ? mixSrgb(source.raisedSurface, source.text, 0.04)
    : source.surface;
  const workbenchHeader = mode === "dark"
    ? mixSrgb(source.raisedSurface, source.text, 0.14)
    : source.raisedSurface;
  const workbenchHover = mode === "dark"
    ? mixSrgb(workbenchRow, source.accent, 0.15)
    : mixSrgb(source.surface, source.accent, 0.09);
  const states = [
    source.page,
    source.surface,
    source.raisedSurface,
    workbenchRow,
    workbenchHeader,
    workbenchHover,
    mixSrgb(workbenchRow, source.accent, 0.16),
    mixSrgb(workbenchRow, source.accent, 0.20)
  ];
  return {
    states,
    accentSoft: states.map((surface) => mixSrgb(surface, source.accent, 0.12))
  };
}

function applyAdvancedOverrides(roles, overrides, errors) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    errors.push(issue("shape.overrides", "Advanced overrides must be an object."));
    return;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!ROLE_KEYS.includes(key)) {
      errors.push(issue(
        "shape.unknown-role",
        `Advanced contains an unsupported “${key}” role.`,
        { key }
      ));
    } else if (key === "gradientStops") {
      const gradient = validateGradientStops(value, { where: "Advanced gradient stops" });
      errors.push(...gradient.errors);
      if (gradient.ok) roles.gradientStops = gradient.value;
    } else if (key === "gradientAngle") {
      if (!Number.isFinite(value) || value < -360 || value > 360) {
        errors.push(issue("value.gradient-angle", "Advanced gradient angle is out of range."));
      } else {
        roles.gradientAngle = value;
      }
    } else if (key === "gradientStopPositions") {
      if (!Array.isArray(value)) {
        errors.push(issue("value.gradient-positions", "Advanced gradient positions must be an array."));
      } else {
        roles.gradientStopPositions = [...value];
      }
    } else {
      const color = validateHexField(value, `Advanced ${key}`, errors);
      if (color) roles[key] = color;
    }
  }
}

/** Compile one mode's guided seven colours to the complete editable role map. */
export function compileSimpleMode(source, { overrides = {}, mode = "light" } = {}) {
  const checked = validateSimpleSource(source, { where: `${mode} Simple colours` });
  const errors = [...checked.errors];
  if (!checked.ok) {
    return { ok: false, roles: null, checks: [], errors, adjustments: [] };
  }
  const s = checked.value;
  const materials = componentSurfaces(s, mode);
  const surfaceAxis = rgbToHex(averageSrgb([s.page, s.surface, s.raisedSurface]));
  const adjustments = [];
  const fitMuted = (key, threshold) => {
    const fitted = fitToward(s.text, surfaceAxis, materials.states, threshold);
    if (!fitted) return s.text;
    adjustments.push({ role: key, source: s.text, result: fitted.color, amount: fitted.amount });
    return fitted.color;
  };
  const statusSurfaces = [s.page, mixSrgb(s.page, s.raisedSurface, 0.55)];
  const fitStatus = (key, color, amount) => {
    const fitted = fitStatusMarker(
      color,
      statusSurfaces,
      amount,
      CONTRAST_THRESHOLDS.statusGraphic
    );
    if (!fitted) return color;
    adjustments.push({ role: key, source: color, result: fitted.color, amount: fitted.amount });
    return fitted.color;
  };
  const blackRatio = contrastRatio("#000000", s.accent);
  const whiteRatio = contrastRatio("#ffffff", s.accent);
  const accentInk = blackRatio >= whiteRatio ? "#000000" : "#ffffff";
  const accentStrong = fitToNearestPole(
    s.secondaryAccent,
    [...materials.states, ...materials.accentSoft],
    CONTRAST_THRESHOLDS.accentText
  );
  if (accentStrong) {
    adjustments.push({
      role: "accentStrongInk",
      source: s.secondaryAccent,
      result: accentStrong.color,
      amount: accentStrong.amount
    });
  }
  const roles = {
    bgSolid: s.page,
    surface: s.surface,
    surface2: s.raisedSurface,
    border: s.border,
    ink: s.text,
    ink2: fitMuted("ink2", CONTRAST_THRESHOLDS.ink2),
    ink3: fitMuted("ink3", CONTRAST_THRESHOLDS.ink3),
    accent: s.accent,
    accentInk,
    accentStrong: s.secondaryAccent,
    accentStrongInk: accentStrong?.color ?? s.secondaryAccent,
    ok: fitStatus("ok", STATUS_SEEDS.ok, 0.13),
    warn: fitStatus("warn", STATUS_SEEDS.warn, 0.14),
    danger: fitStatus("danger", STATUS_SEEDS.danger, 0.13),
    ...generatedGradient(s)
  };
  applyAdvancedOverrides(roles, overrides, errors);
  const validation = validateRoleMap(roles, { mode });
  errors.push(...validation.errors);
  return {
    ok: errors.length === 0,
    roles,
    checks: validation.checks,
    errors,
    adjustments
  };
}
