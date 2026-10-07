// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Dedicated three-pane colour-scheme editor. Draft tokens never escape its preview root. */
import { getSettings, listItems, newMeta, patchSettings, upsertItem } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { SCHEMES, SCHEME_META } from "../lib/schemes.js";
import {
  SCHEME_CANDIDATES,
  SCHEME_CANDIDATE_META,
  createCandidateSchemeDraft
} from "../lib/scheme-candidates.js";
import {
  CUSTOM_SCHEME_CSS_PROPERTIES,
  createCustomSchemeRecord,
  customSchemeCatalogue,
  customSchemeDraftFromRecord,
  customSchemeRef
} from "../lib/custom-schemes.js";
import { loadCustomSchemeDraft, saveCustomSchemeDraft } from "../lib/custom-scheme-store.js";
import {
  MODES,
  ROLE_DEFINITIONS,
  SIMPLE_COLOR_KEYS,
  SIMPLE_COLOR_LABELS,
  compileSimpleMode,
  parseBuiltInTokenCss,
  validateRoleMap
} from "../lib/scheme-tokens.js";
import {
  SCHEME_EDITOR_PREVIEW_META,
  VALIDATION_ROLE_FIELDS,
  convertDraftToGuided,
  createBuiltInSchemeDraft,
  fieldDependencies,
  normalizeEditorHex,
  previewProperties,
  schemeEditorEnvelope,
  validateSchemeEditorEnvelope
} from "../lib/scheme-editor-model.js";
import { el } from "./dom.js";
import { icon } from "./icons.js";
import {
  clearPreviewHighlights,
  createSchemeEditorPreview,
  highlightPreviewDependencies
} from "./scheme-editor-preview.js";
import { initTheme } from "./theme.js";
import { applyDocumentLocale, applyUiLanguage } from "../lib/i18n.js";

const clone = (value) => structuredClone(value);
const params = new URLSearchParams(location.search);
const returnTarget = params.get("return") === "options" ? "options.html" : "dashboard.html#settings";
const compactPreviewMedia = matchMedia("(max-width: 760px)");
const state = {
  draft: null,
  editingId: null,
  source: null,
  mode: "light",
  dirty: false,
  records: [],
  catalogue: [],
  builtIns: null,
  busy: false,
  persistTimer: 0,
  highlightTimer: 0,
  highlightButton: null,
  replaceTimer: 0,
  guidedTimer: 0
};

const app = document.getElementById("app");
const live = el("div", { class: "scheme-editor-live sr-only", role: "status", "aria-live": "polite" });
const preview = createSchemeEditorPreview();
const fields = el("div", { class: "scheme-editor-fields" });
const validation = el("div", { class: "scheme-editor-validation" });
const validationSummary = el("div", { class: "scheme-editor-validation-summary" });
const validationList = el("div", { class: "scheme-editor-validation-list" });
const sourceSelect = el("select", { "aria-label": "Starting scheme" });
const startButton = el("button", { type: "button", class: "scheme-editor-secondary" }, "Start from selection");
const nameInput = el("input", { type: "text", maxlength: 64, "aria-label": "Scheme name" });
const defaultModeSelect = el("select", { "aria-label": "Scheme default mode" },
  el("option", { value: "light" }, "Light by default"),
  el("option", { value: "dark" }, "Dark by default"));
const saveStateText = el("span", {}, "Loading draft");
const saveState = el("span", { class: "scheme-editor-save-state", "data-state": "pending" },
  el("span", { class: "scheme-editor-save-dot", "aria-hidden": "true" }), saveStateText);
const saveButton = el("button", { type: "button", class: "scheme-editor-secondary" }, "Save custom copy");
const applyButton = el("button", { type: "button", class: "scheme-editor-secondary" }, "Save copy and apply");
const guidedButton = el("button", { type: "button" }, "Guided");
const advancedButton = el("button", { type: "button" }, "Advanced");
const lightButton = el("button", { type: "button" }, "Light");
const darkButton = el("button", { type: "button" }, "Dark");

function replaceEditorLocation() {
  if (!location.pathname.endsWith("/scheme-editor.html")) return;
  const query = new URLSearchParams({
    source: state.source,
    return: params.get("return") === "options" ? "options" : "dashboard"
  });
  history.replaceState(null, "", `scheme-editor.html?${query}`);
}

function announce(message) {
  live.textContent = "";
  requestAnimationFrame(() => { live.textContent = message; });
}

function applyDraftPreview() {
  for (const property of CUSTOM_SCHEME_CSS_PROPERTIES) preview.style.removeProperty(property);
  for (const [property, value] of Object.entries(previewProperties(state.draft.roles[state.mode]))) {
    preview.style.setProperty(property, value);
  }
  preview.dataset.mode = state.mode;
  preview.dataset.gradient = "true";
  const compact = compactPreviewMedia.matches;
  preview.dataset.surface = compact ? "sidepanel" : "dashboard";
  preview.querySelector(".tablist")?.toggleAttribute("data-compact", compact);
}

function persistDraftSoon() {
  clearTimeout(state.persistTimer);
  state.persistTimer = setTimeout(() => {
    if (state.draft) void saveCustomSchemeDraft(schemeEditorEnvelope(state.draft, {
      editingId: state.editingId,
      source: state.source
    }));
  }, 120);
}

function markChanged() {
  state.dirty = true;
  applyDraftPreview();
  updateValidation();
  persistDraftSoon();
}

function sourceOption(value, label, group) {
  let parent = sourceSelect.querySelector(`optgroup[data-group="${group}"]`);
  if (!parent) {
    parent = el("optgroup", { label: group, "data-group": group });
    sourceSelect.append(parent);
  }
  parent.append(el("option", { value }, label));
}

function renderSourceOptions() {
  sourceSelect.replaceChildren();
  for (const id of SCHEMES) sourceOption(`builtin:${id}`, SCHEME_META[id].label, "Built-in schemes");
  for (const id of SCHEME_CANDIDATES) {
    sourceOption(`candidate:${id}`, SCHEME_CANDIDATE_META[id].label, "Candidate schemes");
  }
  for (const { record, label } of state.catalogue) {
    sourceOption(`custom:${record.id}`, label, "Your schemes");
  }
  sourceSelect.value = state.source && [...sourceSelect.options].some(({ value }) => value === state.source)
    ? state.source : "builtin:cream";
}

function builtInDraft(id) {
  const meta = SCHEME_META[id];
  return meta ? createBuiltInSchemeDraft({
    id, label: meta.label, defaultMode: meta.defaultMode, maps: state.builtIns
  }) : { ok: false, errors: [{ message: "That built-in scheme is unavailable." }] };
}

function customDraft(id) {
  const entry = state.catalogue.find(({ record }) => record.id === id);
  if (!entry) return { ok: false, errors: [{ message: "That custom scheme is unavailable." }] };
  return customSchemeDraftFromRecord(entry.record);
}

function loadSource(source, { restored = false } = {}) {
  const [kind, id] = String(source).split(":");
  const result = kind === "custom" ? customDraft(id)
    : kind === "candidate" ? createCandidateSchemeDraft(id)
      : builtInDraft(SCHEMES.includes(id) ? id : "cream");
  if (!result.ok) {
    announce(result.errors?.[0]?.message ?? "That starting scheme could not be loaded.");
    return false;
  }
  state.draft = clone(result.value);
  state.editingId = kind === "custom" ? id : null;
  state.source = kind === "custom" ? `custom:${id}`
    : kind === "candidate" && SCHEME_CANDIDATES.includes(id) ? `candidate:${id}`
      : `builtin:${SCHEMES.includes(id) ? id : "cream"}`;
  state.mode = state.draft.defaultMode;
  state.dirty = false;
  sourceSelect.value = state.source;
  syncTopControls();
  renderFields();
  applyDraftPreview();
  updateValidation();
  clearPreviewHighlights(preview);
  replaceEditorLocation();
  persistDraftSoon();
  announce(restored ? "Your unsaved scheme draft was restored." : `${state.draft.name} loaded.`);
  return true;
}

function syncTopControls() {
  nameInput.value = state.draft.name;
  defaultModeSelect.value = state.draft.defaultMode;
  for (const [button, active] of [
    [guidedButton, state.draft.authoringMode === "simple"],
    [advancedButton, state.draft.authoringMode === "advanced"],
    [lightButton, state.mode === "light"],
    [darkButton, state.mode === "dark"]
  ]) {
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  guidedButton.textContent = "Guided";
  const sourceKind = state.source?.split(":")[0];
  document.getElementById("scheme-editor-source-note").textContent = state.editingId
    ? "You are editing your saved scheme. Changes remain local until Save."
    : sourceKind === "candidate"
      ? "Candidate only. Save adds a custom copy to Yours; it is not a built-in."
      : "Built-ins are protected. Save creates a new custom copy.";
}

function fieldLabelFor(error) {
  const role = VALIDATION_ROLE_FIELDS[error?.check?.role] ?? error?.check?.role;
  if (!role) return null;
  if (state.draft.authoringMode === "advanced") return role;
  const map = {
    bgSolid: "page", surface: "surface", surface2: "raisedSurface", border: "border",
    ink: "text", ink2: "text", ink3: "text", accent: "accent", accentInk: "accent",
    accentStrong: "secondaryAccent", accentStrongInk: "secondaryAccent",
    ok: "text", warn: "text", danger: "text"
  };
  return map[role] ?? null;
}

function focusFieldFromError(error) {
  const mode = error?.check?.id?.includes("/dark:") ? "dark" :
    error?.check?.id?.includes("/light:") ? "light" : state.mode;
  if (mode !== state.mode) {
    state.mode = mode;
    syncTopControls();
    renderFields();
    applyDraftPreview();
  }
  const key = fieldLabelFor(error);
  if (!key) return;
  const target = fields.querySelector(`[data-field-key="${CSS.escape(key)}"] input[type="text"]`);
  target?.focus({ preventScroll: true });
  const pane = target?.closest(".scheme-editor-inspector");
  if (pane && target && pane.scrollHeight > pane.clientHeight + 1 &&
      getComputedStyle(pane).overflowY !== "visible") {
    pane.scrollTop = Math.max(0, target.offsetTop - pane.clientHeight / 2);
  } else if (target) {
    const top = target.getBoundingClientRect().top + scrollY - 74;
    scrollTo(0, Math.max(0, top));
  }
}

function updateValidation() {
  const result = createCustomSchemeRecord(state.draft, SCHEME_EDITOR_PREVIEW_META);
  const errors = result.errors ?? [];
  const createsCopy = !state.editingId;
  const needsSave = createsCopy || state.dirty;
  saveButton.disabled = state.busy || !result.ok || !needsSave;
  applyButton.disabled = state.busy || !result.ok;
  saveButton.textContent = state.busy ? "Saving"
    : !needsSave ? "Saved"
      : createsCopy ? "Save custom copy" : "Save changes";
  applyButton.textContent = state.busy ? "Saving"
    : createsCopy ? "Save copy and apply"
      : state.dirty ? "Save and apply" : "Apply";
  saveButton.classList.toggle("scheme-editor-primary", result.ok && needsSave && !state.busy);
  saveButton.classList.toggle("scheme-editor-secondary", !result.ok || !needsSave || state.busy);
  const saveStateValue = state.busy ? "pending"
    : !result.ok ? "blocked"
      : createsCopy ? "copy"
        : state.dirty ? "dirty" : "saved";
  saveState.dataset.state = saveStateValue;
  saveStateText.textContent = {
    pending: "Saving…",
    blocked: "Needs fixes",
    copy: "Not yet in Yours",
    dirty: "Unsaved changes",
    saved: "All changes saved"
  }[saveStateValue];
  saveState.title = saveStateText.textContent;
  saveState.setAttribute("aria-label", `Save status: ${saveStateText.textContent}`);
  validation.classList.toggle("is-valid", result.ok);
  if (result.ok) {
    const pairingCount = MODES.reduce((total, mode) => total +
      validateRoleMap(state.draft.roles[mode], { id: "custom", mode }).checks.length, 0);
    validationSummary.replaceChildren(
      el("span", { class: "scheme-validation-mark" }, "✓"),
      el("div", {}, el("strong", {}, "Ready to save"),
        el("p", {}, "Light and Dark pass every production contrast and component check.")));
    validationList.replaceChildren(
      el("div", { class: "scheme-validation-pass" },
        el("span", {}, String(pairingCount)), el("span", {}, "production pairings covered")),
      el("div", { class: "scheme-validation-pass" },
        el("span", {}, "0"), el("span", {}, "blocking issues")));
    return;
  }
  const unique = [];
  const seen = new Set();
  for (const error of errors) {
    if (seen.has(error.message)) continue;
    seen.add(error.message);
    unique.push(error);
  }
  validationSummary.replaceChildren(
    el("span", { class: "scheme-validation-mark" }, "!"),
    el("div", {}, el("strong", {}, `${unique.length} check${unique.length === 1 ? "" : "s"} need attention`),
      el("p", {}, "Save stays unavailable until every production pairing passes.")));
  validationList.replaceChildren(...unique.slice(0, 12).map((error) => el("button", {
    type: "button",
    class: "scheme-validation-issue",
    onclick: () => focusFieldFromError(error)
  }, el("strong", {}, error.check?.label ?? "Color check"), el("span", {}, error.message))));
}

async function copyHex(value, button) {
  try {
    await navigator.clipboard.writeText(value.toUpperCase());
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
    announce(`${value.toUpperCase()} copied.`);
  } catch {
    announce("Copy was unavailable. Select the hex value instead.");
  }
}

function showAffected(fieldKey, button) {
  clearTimeout(state.highlightTimer);
  if (state.highlightButton && state.highlightButton !== button) {
    state.highlightButton.textContent = "Show uses";
  }
  const count = highlightPreviewDependencies(
    preview, fieldDependencies(state.draft.authoringMode, fieldKey)
  );
  state.highlightButton = button;
  button.textContent = "Showing";
  state.highlightTimer = setTimeout(() => {
    clearPreviewHighlights(preview);
    button.textContent = "Show uses";
    if (state.highlightButton === button) state.highlightButton = null;
  }, 3000);
  announce(`${count.directCount} direct and ${count.derivedCount} derived preview uses highlighted for three seconds.`);
}

function colorField({ key, label, value, onValid }) {
  const color = el("input", { type: "color", value, "aria-label": `${label} color picker` });
  const text = el("input", {
    type: "text", value: value.toUpperCase(), spellcheck: "false",
    autocomplete: "off", "aria-label": `${label} hex value`
  });
  const copy = el("button", { type: "button", class: "scheme-field-copy" }, "Copy");
  const show = el("button", { type: "button", class: "scheme-field-show" }, "Show uses");
  const commit = (candidate, normalizeText = true) => {
    const normalized = normalizeEditorHex(candidate);
    text.classList.toggle("is-invalid", !normalized);
    text.setAttribute("aria-invalid", String(!normalized));
    if (!normalized) return false;
    color.value = normalized.toLowerCase();
    if (normalizeText) text.value = normalized;
    onValid(normalized.toLowerCase());
    return true;
  };
  color.addEventListener("input", () => {
    text.value = color.value.toUpperCase();
    commit(color.value);
  });
  text.addEventListener("input", () => commit(text.value, false));
  text.addEventListener("blur", () => {
    const normalized = normalizeEditorHex(text.value);
    if (normalized) text.value = normalized;
  });
  copy.addEventListener("click", () => copyHex(color.value, copy));
  show.addEventListener("click", () => showAffected(key, show));
  return el("div", { class: "scheme-color-field", "data-field-key": key },
    el("div", { class: "scheme-color-field-head" }, el("label", {}, label), show),
    el("div", { class: "scheme-color-field-controls" }, color, text, copy));
}

function renderFields() {
  const mode = state.mode;
  const nodes = [];
  if (state.draft.authoringMode === "simple") {
    for (const key of SIMPLE_COLOR_KEYS) {
      nodes.push(colorField({
        key,
        label: SIMPLE_COLOR_LABELS[key],
        value: state.draft.simple[mode][key],
        onValid: (value) => {
          state.draft.simple[mode][key] = value;
          const compiled = compileSimpleMode(state.draft.simple[mode], { mode });
          if (compiled.roles) state.draft.roles[mode] = compiled.roles;
          markChanged();
        }
      }));
    }
  } else {
    for (const { key, label } of ROLE_DEFINITIONS) {
      nodes.push(colorField({
        key, label, value: state.draft.roles[mode][key],
        onValid: (value) => { state.draft.roles[mode][key] = value; markChanged(); }
      }));
    }
    state.draft.roles[mode].gradientStops.forEach((value, index) => {
      const key = `gradient-stop-${index}`;
      nodes.push(colorField({
        key: "gradientStops", label: `Gradient stop ${index + 1}`, value,
        onValid: (next) => { state.draft.roles[mode].gradientStops[index] = next; markChanged(); }
      }));
    });
    const angle = el("input", {
      type: "number", min: -360, max: 360, value: state.draft.roles[mode].gradientAngle,
      "aria-label": "Gradient angle",
      onchange: (event) => {
        state.draft.roles[mode].gradientAngle = Number(event.currentTarget.value);
        markChanged();
      }
    });
    nodes.push(el("div", { class: "scheme-number-field", "data-field-key": "gradientAngle" },
      el("label", {}, "Gradient angle"), angle,
      el("button", { type: "button", class: "scheme-field-show",
        onclick: (event) => showAffected("gradientAngle", event.currentTarget) }, "Show uses")));
  }
  fields.replaceChildren(...nodes);
}

async function saveDraft({ apply = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  updateValidation();
  const existing = state.editingId
    ? state.catalogue.find(({ record }) => record.id === state.editingId)?.record : null;
  const meta = existing ? {
    id: existing.id,
    deviceId: existing.deviceId,
    createdAt: existing.createdAt,
    modifiedAt: Date.now(),
    schemaVersion: existing.schemaVersion
  } : await newMeta();
  const result = createCustomSchemeRecord(state.draft, meta);
  if (!result.ok) {
    state.busy = false;
    updateValidation();
    announce(result.errors?.[0]?.message ?? "This scheme is not ready to save.");
    return;
  }
  await upsertItem(STORE_KEYS.customSchemes, result.value);
  state.editingId = result.value.id;
  state.source = `custom:${result.value.id}`;
  state.draft = customSchemeDraftFromRecord(result.value).value;
  state.dirty = false;
  if (apply) await patchSettings({ uiScheme: customSchemeRef(result.value.id) });
  await saveCustomSchemeDraft(null);
  state.records = await listItems(STORE_KEYS.customSchemes);
  state.catalogue = customSchemeCatalogue(state.records);
  state.busy = false;
  renderSourceOptions();
  syncTopControls();
  updateValidation();
  replaceEditorLocation();
  announce(`${result.value.name} saved${apply ? " and applied" : ""}.`);
}

function wireControls() {
  startButton.addEventListener("click", () => {
    if (state.dirty && startButton.dataset.armed !== "true") {
      startButton.dataset.armed = "true";
      startButton.textContent = "Confirm replace draft";
      clearTimeout(state.replaceTimer);
      state.replaceTimer = setTimeout(() => {
        delete startButton.dataset.armed;
        startButton.textContent = "Start from selection";
      }, 5000);
      return;
    }
    delete startButton.dataset.armed;
    startButton.textContent = "Start from selection";
    loadSource(sourceSelect.value);
  });
  nameInput.addEventListener("input", () => {
    state.draft.name = nameInput.value;
    markChanged();
  });
  defaultModeSelect.addEventListener("change", () => {
    state.draft.defaultMode = defaultModeSelect.value;
    markChanged();
  });
  lightButton.addEventListener("click", () => {
    state.mode = "light"; syncTopControls(); renderFields(); applyDraftPreview(); updateValidation();
  });
  darkButton.addEventListener("click", () => {
    state.mode = "dark"; syncTopControls(); renderFields(); applyDraftPreview(); updateValidation();
  });
  advancedButton.addEventListener("click", () => {
    if (state.draft.authoringMode === "advanced") return;
    state.draft.authoringMode = "advanced";
    syncTopControls(); renderFields(); markChanged();
  });
  guidedButton.addEventListener("click", () => {
    if (state.draft.authoringMode === "simple") return;
    if (guidedButton.dataset.armed !== "true") {
      guidedButton.dataset.armed = "true";
      guidedButton.textContent = "Confirm Guided";
      announce("Guided will re-derive supporting colors from seven sources in both modes. Press again to confirm.");
      clearTimeout(state.guidedTimer);
      state.guidedTimer = setTimeout(() => {
        delete guidedButton.dataset.armed;
        guidedButton.textContent = "Guided";
      }, 5000);
      return;
    }
    delete guidedButton.dataset.armed;
    const converted = convertDraftToGuided(state.draft);
    if (!converted.ok) {
      announce(converted.errors?.[0]?.message ?? "Guided could not be prepared.");
      return;
    }
    state.draft = converted.value;
    syncTopControls(); renderFields(); markChanged();
  });
  saveButton.addEventListener("click", () => saveDraft());
  applyButton.addEventListener("click", () => saveDraft({ apply: true }));
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearTimeout(state.highlightTimer);
      clearPreviewHighlights(preview);
      if (state.highlightButton) state.highlightButton.textContent = "Show uses";
      state.highlightButton = null;
    }
  });
  fields.addEventListener("focusin", (event) => {
    if (event.target === state.highlightButton) return;
    clearTimeout(state.highlightTimer);
    clearPreviewHighlights(preview);
    if (state.highlightButton) state.highlightButton.textContent = "Show uses";
    state.highlightButton = null;
  });
  compactPreviewMedia.addEventListener("change", applyDraftPreview);
}

function mount() {
  const inspector = el("aside", { class: "scheme-editor-inspector", "aria-label": "Color inspector" },
    el("div", { class: "scheme-editor-pane-head" },
      el("p", {}, "Color inspector"), el("h1", {}, "Build your scheme"),
      el("span", { id: "scheme-editor-source-note" })),
    el("div", { class: "scheme-editor-source" },
      el("label", {}, "Start from", sourceSelect), startButton),
    el("div", { class: "scheme-editor-basics" },
      el("label", {}, "Name", nameInput), el("label", {}, "Default", defaultModeSelect)),
    el("div", { class: "scheme-editor-segmented-row" },
      el("div", { class: "scheme-editor-segmented", role: "group", "aria-label": "Edit mode" }, guidedButton, advancedButton),
      el("div", { class: "scheme-editor-segmented", role: "group", "aria-label": "Preview mode" }, lightButton, darkButton)),
    el("p", { class: "scheme-editor-mode-help" },
      "Guided offers seven source colors. Advanced exposes every production role and gradient control."),
    fields);
  const previewPane = el("section", { class: "scheme-editor-preview-pane", "aria-label": "Live component atlas" },
    el("header", { class: "scheme-editor-preview-head" },
      el("div", {}, el("p", {}, "Live preview"), el("strong", {}, "Complete component atlas")),
      el("span", {}, "Scroll inside the preview")),
    preview);
  validation.append(
    el("div", { class: "scheme-editor-pane-head" }, el("p", {}, "Validation"), el("h2", {}, "Production checks"),
      el("span", {}, "Select an issue to jump to its likely source color.")),
    validationSummary, validationList);
  const shell = el("main", { class: "scheme-editor-workbench" }, inspector, previewPane, validation);
  app.replaceChildren(
    el("header", { class: "scheme-editor-topbar" },
      el("a", { href: returnTarget, class: "scheme-editor-back" }, icon("navcollapse", 15), "Back to Appearance"),
      el("div", { class: "scheme-editor-title" }, icon("palette", 18), el("strong", {}, "Color scheme editor")),
      el("div", { class: "scheme-editor-actions" }, saveState, saveButton, applyButton)),
    shell, live);
}

async function boot() {
  // Settings arrive before the first mount so the chosen interface language is
  // installed before any text renders; the later reads start after that.
  const settings = await getSettings();
  await applyUiLanguage(settings.uiLanguage);
  applyDocumentLocale();
  initTheme();
  mount();
  wireControls();
  const [records, tokenCss, stored] = await Promise.all([
    listItems(STORE_KEYS.customSchemes),
    fetch(new URL("../../css/tokens.css", import.meta.url)).then((response) => response.text()),
    loadCustomSchemeDraft()
  ]);
  state.records = records;
  state.catalogue = customSchemeCatalogue(records);
  const parsed = parseBuiltInTokenCss(tokenCss);
  if (!parsed.ok) throw new Error(parsed.errors[0]?.message ?? "Built-in schemes could not be read.");
  state.builtIns = parsed.maps;
  renderSourceOptions();
  const requested = params.get("source");
  const restored = validateSchemeEditorEnvelope(stored);
  const validRestoredSource = restored && (
    restored.source?.startsWith("builtin:") ||
    (restored.source?.startsWith("candidate:") &&
      SCHEME_CANDIDATES.includes(restored.source.slice("candidate:".length))) ||
    state.catalogue.some(({ record }) => restored.editingId === record.id)
  );
  if (!requested && validRestoredSource) {
    state.draft = restored.draft;
    state.editingId = restored.editingId;
    state.source = restored.source ?? `custom:${restored.editingId}`;
    state.mode = state.draft.defaultMode;
    state.dirty = true;
    sourceSelect.value = state.source;
    syncTopControls(); renderFields(); applyDraftPreview(); updateValidation();
    announce("Your unsaved scheme draft was restored.");
    return;
  }
  const current = state.catalogue.find(({ id }) => id === settings.uiScheme);
  const fallback = current ? `custom:${current.record.id}` :
    `builtin:${SCHEMES.includes(settings.uiScheme) ? settings.uiScheme : "cream"}`;
  loadSource(requested || fallback);
}

boot().catch((error) => {
  app.replaceChildren(el("main", { class: "scheme-editor-fatal" },
    el("h1", {}, "The color scheme editor could not open"),
    el("p", {}, error?.message ?? String(error)),
    el("a", { href: returnTarget }, "Back to Appearance")));
});
