/** Pure state helpers for the dedicated EveryTab colour-scheme editor. */
import {
  createDraftFixture,
  gradientCss,
  isHexColor,
  MODES,
  ROLE_DEFINITIONS,
  SIMPLE_COLOR_KEYS,
  compileSimpleMode
} from "./scheme-tokens.js";

export const SCHEME_EDITOR_DRAFT_VERSION = 1;

export const SCHEME_EDITOR_PREVIEW_META = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  deviceId: "preview",
  createdAt: 1,
  modifiedAt: 1,
  schemaVersion: 1
});

const clone = (value) => structuredClone(value);

export const SIMPLE_ROLE_DEPENDENCIES = Object.freeze({
  page: Object.freeze({ direct: ["bgSolid"], derived: ["gradientStops"] }),
  surface: Object.freeze({ direct: ["surface"], derived: ["workbenchMaterials"] }),
  raisedSurface: Object.freeze({ direct: ["surface2"], derived: ["workbenchMaterials", "sideBg"] }),
  text: Object.freeze({ direct: ["ink"], derived: [
    "ink2", "ink3", "accentInk", "accentStrongInk", "focusAccent",
    "accentSoftInk", "workbenchMaterials", "statusMarkerOutline"
  ] }),
  accent: Object.freeze({ direct: ["accent"], derived: [
    "accentInk", "accentSoft", "focusAccent", "workbenchMaterials", "gradientStops"
  ] }),
  secondaryAccent: Object.freeze({ direct: ["accentStrong"], derived: [
    "accentStrongInk", "gradientStops"
  ] }),
  border: Object.freeze({ direct: ["border"], derived: [] })
});

export const ADVANCED_DERIVED_DEPENDENCIES = Object.freeze({
  bgSolid: ["sideBg", "statusTints", "gradientAtmosphere"],
  surface: ["accentSoft", "navHover", "workbenchMaterials", "statusTints"],
  surface2: ["sideBg", "workbenchMaterials", "statusTints"],
  border: [],
  ink: ["focusAccent", "accentSoftInk", "navHover", "workbenchMaterials", "statusMarkerOutline"],
  ink2: ["workbenchMaterials"],
  ink3: ["workbenchMaterials"],
  accent: ["accentSoft", "focusAccent", "workbenchMaterials", "gradientAtmosphere"],
  accentInk: [],
  accentStrong: ["gradientAtmosphere"],
  accentStrongInk: [],
  ok: ["statusTints"],
  warn: ["statusTints"],
  danger: ["statusTints"],
  gradientStops: ["gradientAtmosphere"],
  gradientAngle: ["gradientAtmosphere"],
  gradientStopPositions: ["gradientAtmosphere"]
});

export const VALIDATION_ROLE_FIELDS = Object.freeze({
  workbenchTertiary: "ink3",
  workbenchDetail: "ink2",
  accentSoftInk: "ink",
  focusAccent: "accent",
  statusMarkerOutline: "ink",
  "material-separation": "surface2"
});

/** Accept paste-friendly #RGB, RGB, #RRGGBB, and RRGGBB input. */
export function normalizeEditorHex(value) {
  const raw = String(value ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${[...raw].map((letter) => `${letter}${letter}`).join("")}`.toUpperCase();
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

export function simpleSourceFromRoles(roles) {
  return {
    page: roles.bgSolid,
    surface: roles.surface,
    raisedSurface: roles.surface2,
    text: roles.ink,
    accent: roles.accent,
    secondaryAccent: roles.accentStrong,
    border: roles.border
  };
}

/** Clone an exact built-in map into a protected custom-copy draft. */
export function createBuiltInSchemeDraft({ id, label, defaultMode, maps }) {
  if (!maps?.[id] || !MODES.every((mode) => maps[id][mode])) {
    return { ok: false, value: null, errors: [{
      code: "value.builtin",
      message: `${label || id} is missing a Light or Dark production map.`
    }] };
  }
  const roles = Object.fromEntries(MODES.map((mode) => [mode, clone(maps[id][mode])]));
  const simple = Object.fromEntries(MODES.map((mode) => [
    mode, simpleSourceFromRoles(roles[mode])
  ]));
  return createDraftFixture({
    name: `${label || id} custom`.slice(0, 64),
    defaultMode: MODES.includes(defaultMode) ? defaultMode : "light",
    authoringMode: "advanced",
    simple,
    roles
  });
}

/** Recompile both modes after the user explicitly accepts Guided derivation. */
export function convertDraftToGuided(draft) {
  const next = clone(draft);
  const errors = [];
  for (const mode of MODES) {
    const compiled = compileSimpleMode(next.simple?.[mode], { mode });
    errors.push(...compiled.errors);
    if (compiled.roles) next.roles[mode] = compiled.roles;
  }
  next.authoringMode = "simple";
  return { ok: errors.length === 0, value: next, errors };
}

export function schemeEditorEnvelope(draft, { editingId = null, source = null } = {}) {
  return {
    kind: "custom-scheme-editor",
    version: SCHEME_EDITOR_DRAFT_VERSION,
    editingId,
    source,
    updatedAt: Date.now(),
    draft: clone(draft)
  };
}

/** Invalid-contrast drafts remain resumable, but malformed colour data does not. */
export function validateSchemeEditorEnvelope(value) {
  if (!value || value.kind !== "custom-scheme-editor" ||
      value.version !== SCHEME_EDITOR_DRAFT_VERSION || !value.draft) return null;
  const draft = value.draft;
  const complete = typeof draft.name === "string" && draft.name.length <= 64 &&
    MODES.includes(draft.defaultMode) && ["simple", "advanced"].includes(draft.authoringMode) &&
    MODES.every((mode) => {
      const simple = draft.simple?.[mode];
      const roles = draft.roles?.[mode];
      return SIMPLE_COLOR_KEYS.every((key) => isHexColor(simple?.[key])) &&
        ROLE_DEFINITIONS.every(({ key }) => isHexColor(roles?.[key])) &&
        Array.isArray(roles?.gradientStops) && roles.gradientStops.length >= 2 &&
        roles.gradientStops.length <= 3 && roles.gradientStops.every(isHexColor) &&
        Number.isFinite(roles.gradientAngle) &&
        Array.isArray(roles.gradientStopPositions) &&
        roles.gradientStopPositions.length === roles.gradientStops.length &&
        Boolean(gradientCss(
          roles.gradientStops, roles.gradientAngle, roles.gradientStopPositions
        ));
    });
  return complete ? {
    ...value,
    editingId: typeof value.editingId === "string" ? value.editingId : null,
    source: typeof value.source === "string" ? value.source : null,
    draft: clone(draft)
  } : null;
}

export function previewProperties(roles) {
  const properties = Object.create(null);
  for (const { key, css } of ROLE_DEFINITIONS) {
    if (isHexColor(roles?.[key])) properties[css] = roles[key];
  }
  const gradient = gradientCss(
    roles?.gradientStops, roles?.gradientAngle, roles?.gradientStopPositions
  );
  if (gradient) properties["--bg-grad"] = gradient;
  return properties;
}

export function fieldDependencies(authoringMode, field) {
  if (authoringMode === "simple") {
    return SIMPLE_ROLE_DEPENDENCIES[field] ?? { direct: [], derived: [] };
  }
  return {
    direct: [field],
    derived: ADVANCED_DERIVED_DEPENDENCIES[field] ?? []
  };
}

