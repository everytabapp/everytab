// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Scheme role schema, production pairing ledger, validation, and CSS parser. */
import {
  colorToCss,
  contrastRatio,
  gradientCss,
  isHexColor,
  mixSrgb,
  normalizeHex,
  parseGradientCss
} from "./scheme-token-color.js";

export const MODES = Object.freeze(["light", "dark"]);
export const SIMPLE_COLOR_KEYS = Object.freeze([
  "page", "surface", "raisedSurface", "text", "accent", "secondaryAccent", "border"
]);
export const SIMPLE_COLOR_LABELS = Object.freeze({
  page: "Page",
  surface: "Surface",
  raisedSurface: "Raised surface",
  text: "Text",
  accent: "Accent",
  secondaryAccent: "Secondary accent",
  border: "Border"
});
export const ROLE_DEFINITIONS = Object.freeze([
  { key: "bgSolid", css: "--bg-solid", label: "Page" },
  { key: "surface", css: "--surface", label: "Surface" },
  { key: "surface2", css: "--surface-2", label: "Raised surface" },
  { key: "border", css: "--border", label: "Border" },
  { key: "ink", css: "--ink", label: "Primary text" },
  { key: "ink2", css: "--ink-2", label: "Secondary text" },
  { key: "ink3", css: "--ink-3", label: "Tertiary text" },
  { key: "accent", css: "--accent", label: "Accent" },
  { key: "accentInk", css: "--accent-ink", label: "Text on accent" },
  { key: "accentStrong", css: "--accent-strong", label: "Secondary accent" },
  { key: "accentStrongInk", css: "--accent-strong-ink", label: "Accent text" },
  { key: "ok", css: "--ok", label: "Success" },
  { key: "warn", css: "--warn", label: "Warning" },
  { key: "danger", css: "--danger", label: "Danger" }
]);
export const COLOR_ROLE_KEYS = Object.freeze(ROLE_DEFINITIONS.map(({ key }) => key));
export const GRADIENT_ROLE_KEYS = Object.freeze([
  "gradientStops", "gradientAngle", "gradientStopPositions"
]);
export const ROLE_KEYS = Object.freeze([...COLOR_ROLE_KEYS, ...GRADIENT_ROLE_KEYS]);
export const ROLE_CSS_NAMES = Object.freeze(Object.fromEntries(
  ROLE_DEFINITIONS.map(({ key, css }) => [key, css])
));
export const CSS_ROLE_KEYS = Object.freeze(Object.fromEntries(
  ROLE_DEFINITIONS.map(({ key, css }) => [css.slice(2), key])
));
export const FIXED_BRAND_TOKENS = Object.freeze({
  "--brand-cream": "#f4f2ed",
  "--brand-edge": "#d8d4cc",
  "--brand-ink": "#26221c",
  "--brand-accent": "#1e4a49"
});
export const CONTRAST_THRESHOLDS = Object.freeze({
  ink: 7,
  ink2: 4.6,
  ink3: 4.5,
  accentText: 4.5,
  accentFillText: 4.5,
  statusGraphic: 3,
  componentText: 4.5,
  focusGraphic: 3,
  darkPageRow: 1.25,
  darkRowHeader: 1.25,
  darkRowHover: 1.14
});

const SURFACES = Object.freeze([
  ["page", "bgSolid"], ["surface", "surface"], ["raised-surface", "surface2"]
]);
const WORKBENCH_STATES = Object.freeze([
  ["row-rest", "workbenchRow"],
  ["header", "workbenchHeader"],
  ["row-hover", "workbenchHover"],
  ["row-selected", "workbenchSelected"],
  ["row-selected-hover", "workbenchSelectedHover"]
]);
const STATUS_TINT_AMOUNTS = Object.freeze({ ok: 0.13, warn: 0.14, danger: 0.13 });
const STATUS_MARKER_OUTLINE_AMOUNT = 0.70;
const FOCUS_ACCENT_INK_AMOUNT = 0.36;
const DARK_ACCENT_SOFT_WHITE_AMOUNT = 0.35;
/* This is a placement ledger, not a cartesian colour exercise. Dashboard Vault
   statuses sit on the page canvas; the persistent Vault pill sits on the
   sidebar material and only renders success/warning. Each marker is painted on
   its own translucent --*-bg fill, so the effective background must include
   both the tint and the production surface below it. */
export const STATUS_MARKER_PLACEMENTS = Object.freeze([
  Object.freeze({
    component: "vault-settings-status",
    surface: "page",
    surfaceKey: "bgSolid",
    roles: Object.freeze(["ok", "warn", "danger"])
  }),
  Object.freeze({
    component: "sidebar-vault-pill",
    surface: "side-navigation",
    surfaceKey: "sideBg",
    roles: Object.freeze(["ok", "warn"])
  })
]);
export const STAR_ACTION_STATES = Object.freeze([
  ["row-hover", "workbenchHover"],
  ["row-selected", "workbenchSelected"],
  ["row-selected-hover", "workbenchSelectedHover"],
  ["row-palette-source", "workbenchPaletteSource"]
]);

export function issue(code, message, detail = {}) {
  return { code, message, ...detail };
}

export function exactKeys(value, allowed, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [issue("shape.object", `${where} must be an object.`, { where })];
  }
  const allowedSet = new Set(allowed);
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(issue(
        "shape.unknown-key",
        `${where} contains an unsupported “${key}” field.`,
        { where, key }
      ));
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      errors.push(issue("shape.missing-key", `${where} is missing “${key}”.`, { where, key }));
    }
  }
  return errors;
}

export function validateHexField(value, where, errors) {
  const normalized = normalizeHex(value);
  if (!normalized) {
    errors.push(issue(
      "value.hex",
      `${where} must be a six-digit hex colour such as #1e4a49.`,
      { where, value }
    ));
  }
  return normalized;
}

export function validateSimpleSource(source, { where = "Simple colours" } = {}) {
  const errors = exactKeys(source, SIMPLE_COLOR_KEYS, where);
  const value = {};
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const key of SIMPLE_COLOR_KEYS) {
      value[key] = validateHexField(source[key], `${where} ${SIMPLE_COLOR_LABELS[key]}`, errors);
    }
  }
  return { ok: errors.length === 0, value, errors };
}

export function validateGradientStops(stops, { where = "Gradient stops" } = {}) {
  const errors = [];
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 3) {
    errors.push(issue(
      "value.gradient-count",
      `${where} must contain two or three hex colours.`,
      { where }
    ));
    return { ok: false, value: [], errors };
  }
  const value = stops.map((stop, index) =>
    validateHexField(stop, `${where} ${index + 1}`, errors));
  return { ok: errors.length === 0, value, errors };
}

function validateGradientGeometry(roles, errors) {
  const stops = validateGradientStops(roles.gradientStops);
  errors.push(...stops.errors);
  if (!Number.isFinite(roles.gradientAngle) || roles.gradientAngle < -360 ||
      roles.gradientAngle > 360) {
    errors.push(issue(
      "value.gradient-angle",
      "Gradient angle must be a number from -360 to 360."
    ));
  }
  const positions = roles.gradientStopPositions;
  if (!Array.isArray(positions) || positions.length !== roles.gradientStops?.length ||
      positions.some((position) => position != null &&
        (!Number.isFinite(position) || position < 0 || position > 100))) {
    errors.push(issue(
      "value.gradient-positions",
      "Gradient positions must align with every stop and stay between 0 and 100%."
    ));
  }
  if (stops.ok && !gradientCss(stops.value, roles.gradientAngle, positions)) {
    errors.push(issue("value.gradient", "Gradient geometry is not serializable."));
  }
}

function validateRoleShape(roles, errors) {
  errors.push(...exactKeys(roles, ROLE_KEYS, "Role map"));
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return;
  for (const key of COLOR_ROLE_KEYS) validateHexField(roles[key], `Role ${key}`, errors);
  validateGradientGeometry(roles, errors);
}

/** Exact production workbench materials, retained as unquantized sRGB. */
export function deriveComponentMaterials(roles, mode = "light") {
  const dark = mode === "dark";
  const workbenchRow = dark ? mixSrgb(roles.surface2, roles.ink, 0.04) : roles.surface;
  const workbenchHeader = dark ? mixSrgb(roles.surface2, roles.ink, 0.14) : roles.surface2;
  const workbenchHover = dark
    ? mixSrgb(workbenchRow, roles.accent, 0.15)
    : mixSrgb(roles.surface, roles.accent, 0.09);
  const workbenchDetail = dark ? mixSrgb(roles.ink2, roles.ink, 0.65) : roles.ink2;
  const workbenchTertiary = dark
    ? mixSrgb(roles.ink2, roles.ink, 0.88)
    : mixSrgb(roles.ink3, roles.ink, 0.18);
  return {
    workbenchRow,
    workbenchHeader,
    workbenchHover,
    workbenchSelected: mixSrgb(workbenchRow, roles.accent, 0.16),
    workbenchSelectedHover: mixSrgb(workbenchRow, roles.accent, 0.20),
    workbenchPaletteSource: mixSrgb(workbenchRow, roles.ink, 0.07),
    workbenchDetail,
    workbenchTertiary,
    sideBg: mixSrgb(roles.bgSolid, roles.surface2, 0.55)
  };
}

function deriveAccentSoftInk(roles, mode) {
  return mode === "dark"
    ? mixSrgb(roles.ink, "#ffffff", DARK_ACCENT_SOFT_WHITE_AMOUNT)
    : roles.ink;
}

function contrastCheck(checks, {
  id, label, component, role, state, foreground, background, threshold, category
}) {
  const ratio = contrastRatio(foreground, background) ?? 0;
  checks.push({
    id,
    label,
    component,
    role,
    state,
    surface: state,
    category,
    foreground: colorToCss(foreground),
    background: colorToCss(background),
    ratio,
    threshold,
    pass: ratio + 1e-12 >= threshold
  });
}

function addBasePairings(checks, roles, prefix) {
  for (const [state, surfaceKey] of SURFACES) {
    for (const [role, threshold, label] of [
      ["ink", CONTRAST_THRESHOLDS.ink, "Primary text"],
      ["ink2", CONTRAST_THRESHOLDS.ink2, "Secondary text"],
      ["ink3", CONTRAST_THRESHOLDS.ink3, "Tertiary text"],
      ["accentStrongInk", CONTRAST_THRESHOLDS.accentText, "Accent text"]
    ]) {
      contrastCheck(checks, {
        id: `${prefix}:global-copy:${role}:${state}`,
        label: `${label} on ${state}`,
        component: "global-copy",
        role,
        state,
        foreground: roles[role],
        background: roles[surfaceKey],
        threshold,
        category: "base"
      });
    }
  }
  contrastCheck(checks, {
    id: `${prefix}:primary-button:rest`,
    label: "Text on filled accent",
    component: "primary-button",
    role: "accentInk",
    state: "rest",
    foreground: roles.accentInk,
    background: roles.accent,
    threshold: CONTRAST_THRESHOLDS.accentFillText,
    category: "base"
  });
}

function addStatusMarkerPairings(checks, roles, materials, prefix) {
  for (const placement of STATUS_MARKER_PLACEMENTS) {
    const surface = roles[placement.surfaceKey] ?? materials[placement.surfaceKey];
    for (const role of placement.roles) {
      const tint = mixSrgb(surface, roles[role], STATUS_TINT_AMOUNTS[role]);
      contrastCheck(checks, {
        id: `${prefix}:${placement.component}:${role}:${placement.surface}`,
        label: `${role} marker boundary on its tinted ${placement.component} background`,
        component: placement.component,
        role: "statusMarkerOutline",
        state: `${role}-tint/${placement.surface}`,
        foreground: mixSrgb(tint, roles.ink, STATUS_MARKER_OUTLINE_AMOUNT),
        background: tint,
        threshold: CONTRAST_THRESHOLDS.statusGraphic,
        category: "status"
      });
    }
  }
}

function addSurfaceStatePairings(checks, roles, mode, prefix) {
  const accentSoftInk = deriveAccentSoftInk(roles, mode);
  for (const [state, surfaceKey] of SURFACES) {
    const surface = roles[surfaceKey];
    const accentSoft = mixSrgb(surface, roles.accent, 0.12);
    const navHover = mixSrgb(surface, roles.ink, 0.07);
    contrastCheck(checks, {
      id: `${prefix}:generic-chip:accent-soft:${state}`,
      label: `Accent chip on ${state}`,
      component: "generic-chip",
      role: "accentSoftInk",
      state: `accent-soft/${state}`,
      foreground: accentSoftInk,
      background: accentSoft,
      threshold: CONTRAST_THRESHOLDS.accentText,
      category: "component"
    });
    contrastCheck(checks, {
      id: `${prefix}:focus-boundary:${state}`,
      label: `Focus boundary on ${state}`,
      component: "focus-boundary",
      role: "focusAccent",
      state,
      foreground: mixSrgb(roles.accent, roles.ink, FOCUS_ACCENT_INK_AMOUNT),
      background: surface,
      threshold: CONTRAST_THRESHOLDS.focusGraphic,
      category: "component"
    });
    contrastCheck(checks, {
      id: `${prefix}:nav-item:hover:${state}`,
      label: `Navigation text on neutral hover over ${state}`,
      component: "nav-item",
      role: "ink",
      state: `hover/${state}`,
      foreground: roles.ink,
      background: navHover,
      threshold: CONTRAST_THRESHOLDS.componentText,
      category: "component"
    });
    for (const [status, amount] of [["ok", 0.13], ["warn", 0.14], ["danger", 0.13]]) {
      contrastCheck(checks, {
        id: `${prefix}:status-tint:${status}:${state}`,
        label: `Text on ${status} tint over ${state}`,
        component: "status-tint",
        role: "ink",
        state: `${status}/${state}`,
        foreground: roles.ink,
        background: mixSrgb(surface, roles[status], amount),
        threshold: CONTRAST_THRESHOLDS.componentText,
        category: "component"
      });
    }
  }
}

function addWorkbenchPairings(checks, roles, mode, prefix) {
  const materials = deriveComponentMaterials(roles, mode);
  const accentSoftInk = deriveAccentSoftInk(roles, mode);
  for (const [state, materialKey] of WORKBENCH_STATES) {
    const surface = materials[materialKey];
    contrastCheck(checks, {
      id: `${prefix}:tab-row:primary:${state}`,
      label: `Primary tab text on Workbench ${state}`,
      component: "tab-row",
      role: "ink",
      state,
      foreground: roles.ink,
      background: surface,
      threshold: CONTRAST_THRESHOLDS.componentText,
      category: "workbench"
    });
    contrastCheck(checks, {
      id: `${prefix}:tab-metadata:tertiary:${state}`,
      label: `Tab metadata on Workbench ${state}`,
      component: "tab-metadata",
      role: "workbenchTertiary",
      state,
      foreground: materials.workbenchTertiary,
      background: surface,
      threshold: CONTRAST_THRESHOLDS.componentText,
      category: "workbench"
    });
    const accentSoft = mixSrgb(surface, roles.accent, 0.12);
    contrastCheck(checks, {
      id: `${prefix}:label-chip:accent-soft:${state}`,
      label: `Label chip on Workbench ${state}`,
      component: "label-chip",
      role: "accentSoftInk",
      state: `accent-soft/${state}`,
      foreground: accentSoftInk,
      background: accentSoft,
      threshold: CONTRAST_THRESHOLDS.componentText,
      category: "workbench"
    });
  }
  /* A star is a row action. Its tray is reachable on hover/focus, selection,
     selected hover/focus, and while an anchored palette owns the row. It is
     never rendered in a group header and a resting unselected row hides the
     tray with visibility:hidden and pointer-events:none. */
  for (const [state, materialKey] of STAR_ACTION_STATES) {
    contrastCheck(checks, {
      id: `${prefix}:star-action:accent-soft:${state}`,
      label: `Star action on Workbench ${state}`,
      component: "star-action",
      role: "accentSoftInk",
      state: `accent-soft/${state}`,
      foreground: accentSoftInk,
      background: mixSrgb(materials[materialKey], roles.accent, 0.12),
      threshold: CONTRAST_THRESHOLDS.componentText,
      category: "workbench"
    });
  }
  contrastCheck(checks, {
    id: `${prefix}:duplicate-toolbar:detail:header`,
    label: "Duplicate toolbar supporting copy on Workbench header",
    component: "duplicate-toolbar",
    role: "workbenchDetail",
    state: "header",
    foreground: materials.workbenchDetail,
    background: materials.workbenchHeader,
    threshold: CONTRAST_THRESHOLDS.componentText,
    category: "workbench"
  });
  return materials;
}

function addDarkMaterialPairings(checks, roles, materials, prefix) {
  for (const [state, foreground, background, threshold] of [
    ["page-to-row", roles.bgSolid, materials.workbenchRow,
      CONTRAST_THRESHOLDS.darkPageRow],
    ["row-to-header", materials.workbenchRow, materials.workbenchHeader,
      CONTRAST_THRESHOLDS.darkRowHeader],
    ["row-to-hover", materials.workbenchRow, materials.workbenchHover,
      CONTRAST_THRESHOLDS.darkRowHover]
  ]) {
    contrastCheck(checks, {
      id: `${prefix}:workbench-material:${state}`,
      label: `Dark Workbench ${state}`,
      component: "workbench-material",
      role: "material-separation",
      state,
      foreground,
      background,
      threshold,
      category: "material"
    });
  }
}

/** Validate the complete role map against an authoritative production ledger. */
export function validateRoleMap(roles, { id = "draft", mode = "light" } = {}) {
  const errors = [];
  const checks = [];
  validateRoleShape(roles, errors);
  if (errors.length) return { ok: false, errors, checks };
  const prefix = `${id}/${mode}`;
  addBasePairings(checks, roles, prefix);
  addSurfaceStatePairings(checks, roles, mode, prefix);
  const materials = addWorkbenchPairings(checks, roles, mode, prefix);
  addStatusMarkerPairings(checks, roles, materials, prefix);
  contrastCheck(checks, {
    id: `${prefix}:disabled-copy:raised-surface`,
    label: "Disabled explanatory copy on raised surface",
    component: "disabled-copy",
    role: "ink3",
    state: "raised-surface",
    foreground: roles.ink3,
    background: roles.surface2,
    threshold: CONTRAST_THRESHOLDS.componentText,
    category: "component"
  });
  if (mode === "dark") addDarkMaterialPairings(checks, roles, materials, prefix);
  for (const check of checks.filter(({ pass }) => !pass)) {
    errors.push(issue(
      "contrast.failure",
      `${check.label} reaches ${check.ratio.toFixed(3)}:1; it needs ` +
        `${check.threshold}:1. Adjust ${check.role} or the affected surface.`,
      { check }
    ));
  }
  return { ok: errors.length === 0, errors, checks, materials };
}

function schemeRuleMatches(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => selector.includes("[data-scheme="));
}

function parseDeclarations(body, identity, errors) {
  const declarations = Object.create(null);
  for (const raw of body.split(";")) {
    const declaration = raw.trim();
    if (!declaration) continue;
    const match = declaration.match(/^--([\w-]+)\s*:\s*(.+)$/s);
    if (!match) {
      errors.push(issue(
        "css.forbidden-declaration",
        `${identity} contains a non-token declaration; built-ins are colour data only.`,
        { identity, declaration }
      ));
      continue;
    }
    const [, key, value] = match;
    if (Object.hasOwn(declarations, key)) {
      errors.push(issue("css.duplicate-token", `${identity} repeats --${key}.`, { key }));
    }
    declarations[key] = value.trim();
  }
  return declarations;
}

/** Parse only exact built-in scheme blocks from production tokens.css. */
export function parseBuiltInTokenCss(css) {
  const maps = Object.create(null);
  const order = [];
  const errors = [];
  if (typeof css !== "string" || css.length > 512 * 1024) {
    return {
      ok: false,
      maps,
      order,
      errors: [issue("css.size", "tokens.css is missing or outside the 512 KiB QA bound.")]
    };
  }
  const allowed = new Set([...Object.keys(CSS_ROLE_KEYS), "bg-grad"]);
  for (const { selector, body } of schemeRuleMatches(css)) {
    const scope = selector.match(
      /^\[data-scheme="([a-z][a-z0-9-]{0,31})"\]\[data-mode="(light|dark)"\]$/
    );
    if (!scope) {
      errors.push(issue(
        "css.forbidden-scope",
        `Scheme selector “${selector}” is not an exact scheme/mode token scope.`,
        { selector }
      ));
      continue;
    }
    const [, scheme, mode] = scope;
    const identity = `${scheme}/${mode}`;
    if (Object.hasOwn(maps[scheme] ?? {}, mode)) {
      errors.push(issue("css.duplicate", `tokens.css repeats ${identity}.`, { scheme, mode }));
      continue;
    }
    const declarations = parseDeclarations(body, identity, errors);
    for (const key of Object.keys(declarations)) {
      if (!allowed.has(key)) {
        errors.push(issue(
          "css.unknown-token",
          `${identity} defines unsupported --${key}.`,
          { scheme, mode, key }
        ));
      }
    }
    const roles = {};
    for (const [cssKey, roleKey] of Object.entries(CSS_ROLE_KEYS)) {
      const value = validateHexField(declarations[cssKey], `${identity} --${cssKey}`, errors);
      if (value) roles[roleKey] = value;
    }
    const gradient = parseGradientCss(declarations["bg-grad"]);
    if (!gradient.ok) {
      errors.push(...gradient.errors.map((entry) => ({ ...entry, scheme, mode })));
    }
    roles.gradientStops = gradient.value;
    roles.gradientAngle = gradient.angle;
    roles.gradientStopPositions = gradient.positions;
    maps[scheme] ??= Object.create(null);
    maps[scheme][mode] = roles;
    order.push(identity);
  }
  return { ok: errors.length === 0, maps, order, errors };
}

export function roleMapToCssProperties(roles, { mode = "light" } = {}) {
  const validation = validateRoleMap(roles, { mode });
  if (!validation.ok) return { ok: false, value: {}, errors: validation.errors };
  const value = Object.fromEntries(COLOR_ROLE_KEYS.map((key) =>
    [ROLE_CSS_NAMES[key], roles[key]]));
  value["--bg-grad"] = gradientCss(
    roles.gradientStops,
    roles.gradientAngle,
    roles.gradientStopPositions
  );
  return { ok: true, value, errors: [] };
}

export { gradientCss, isHexColor, normalizeHex, parseGradientCss };
