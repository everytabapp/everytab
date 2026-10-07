import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SCHEME_META } from "../js/lib/schemes.js";
import {
  SCHEME_CANDIDATES,
  SCHEME_CANDIDATE_META,
  createCandidateSchemeDraft
} from "../js/lib/scheme-candidates.js";
import { parseBuiltInTokenCss } from "../js/lib/scheme-tokens.js";
import {
  convertDraftToGuided,
  createBuiltInSchemeDraft,
  fieldDependencies,
  normalizeEditorHex,
  previewProperties,
  schemeEditorEnvelope,
  validateSchemeEditorEnvelope
} from "../js/lib/scheme-editor-model.js";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};

check(normalizeEditorHex("0af") === "#00AAFF", "three-digit hex expands for paste");
check(normalizeEditorHex("bc5f3c") === "#BC5F3C", "six-digit hex accepts a missing hash");
check(normalizeEditorHex(" #Bc5F3c ") === "#BC5F3C", "hex trims and normalizes case");
check(normalizeEditorHex("#12zz00") === null, "malformed hex remains invalid");

const tokenPath = fileURLToPath(new URL("../css/tokens.css", import.meta.url));
const parsed = parseBuiltInTokenCss(await readFile(tokenPath, "utf8"));
check(parsed.ok, "production token sheet parses through the exact built-in contract");
const cream = createBuiltInSchemeDraft({
  id: "cream", label: SCHEME_META.cream.label,
  defaultMode: SCHEME_META.cream.defaultMode, maps: parsed.maps
});
check(cream.ok && cream.value.authoringMode === "advanced",
  "built-in starts as a protected exact Advanced copy");
check(cream.value.roles.light.bgSolid === "#f5efe3" &&
  cream.value.roles.dark.bgSolid === "#221e18",
"both production modes are retained exactly");
check(cream.value.simple.light.page === cream.value.roles.light.bgSolid &&
  cream.value.simple.dark.accent === cream.value.roles.dark.accent,
"built-in seeds Guided sources without altering exact roles");

const guided = convertDraftToGuided(cream.value);
check(guided.ok && guided.value.authoringMode === "simple",
  "explicit Guided conversion recompiles both modes");
check(guided.value.roles.light.bgSolid === cream.value.simple.light.page &&
  guided.value.roles.dark.accent === cream.value.simple.dark.accent,
"Guided preserves the seven authored source colors");

const simpleAccent = fieldDependencies("simple", "accent");
check(simpleAccent.direct.includes("accent") && simpleAccent.derived.includes("accentSoft") &&
  simpleAccent.derived.includes("workbenchMaterials"),
"Guided accent dependency explains direct and derived uses");
const advancedInk = fieldDependencies("advanced", "ink");
check(advancedInk.direct.includes("ink") && advancedInk.derived.includes("focusAccent") &&
  advancedInk.derived.includes("statusMarkerOutline"),
"Advanced ink dependency includes its computed production roles");

const envelope = schemeEditorEnvelope(guided.value, {
  editingId: "11111111-1111-4111-8111-111111111111",
  source: "custom:11111111-1111-4111-8111-111111111111"
});
check(Boolean(validateSchemeEditorEnvelope(envelope)), "complete invalid-or-valid draft remains resumable");
envelope.draft.roles.dark.accent = "not-a-color";
check(validateSchemeEditorEnvelope(envelope) === null, "malformed persisted color is rejected");

const properties = previewProperties(cream.value.roles.light);
check(properties["--bg-solid"] === "#f5efe3" &&
  properties["--bg-grad"].startsWith("linear-gradient("),
"isolated preview projects every authored role and gradient");

check(SCHEME_CANDIDATES.length === 0 && Object.keys(SCHEME_CANDIDATE_META).length === 0,
  "the accepted Aladdin scheme closes the temporary candidate shelf");
check(parsed.maps.aladdin.light.bgSolid === "#efa36f" &&
  parsed.maps.aladdin.light.surface === "#f5c487" &&
  parsed.maps.aladdin.light.surface2 === "#ed956f" &&
  parsed.maps.aladdin.dark.bgSolid === "#101b42" &&
  parsed.maps.aladdin.dark.accent === "#f57a45" &&
  SCHEME_META.aladdin.defaultMode === "light",
"Aladdin promotes the accepted Crimson Peach colors and Light default exactly");
check(!createCandidateSchemeDraft("aladdin-crimson-peach").ok,
  "the promoted Aladdin candidate id no longer shadows its built-in identity");
check(!createCandidateSchemeDraft("good-night").ok && !createCandidateSchemeDraft("oblivion").ok,
  "retired candidate ids still fail closed instead of shadowing promoted built-ins");
check(parsed.maps.goodnight.light.bgSolid === "#f2f1ea" &&
  parsed.maps.goodnight.light.accent === "#e0bd5d" &&
  parsed.maps.goodnight.light.accentStrong === "#356f6c",
  "Good Night promotes the accepted off-white, pastel-yellow, and teal composition exactly");
check(parsed.maps.oblivion.light.bgSolid === "#d7dde0" &&
  parsed.maps.oblivion.light.accent === "#39789a" &&
  parsed.maps.oblivion.light.accentStrong === "#4d725d",
  "Oblivion promotes the accepted frost-grey and blue composition exactly");

console.log(`Scheme editor model tests passed: ${checks} assertions.`);
