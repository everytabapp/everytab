// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** First-run controls. Persistence and the live theme remain owned by the host. */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { msg } from "../lib/i18n.js";
import { SCHEMES, SCHEME_LABELS, resolveSchemeMode } from "../lib/schemes.js";
import { settingsDurationLabel, settingsOptions } from "./settings-copy.js";
import { autoDumpPatch, suspendPatch } from "./slider.js";

function normalizeOnboardingTabLimit(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(number)));
}

/** Checkbox and timing select preserve values not offered by the short list. */
export function createOnboardingAutomation({ readSettings, update, registerSync }) {
  const rows = [
    { id: "save", enabled: "autoArchiveEnabled", timing: "autoDumpAfterMinutes",
      fallback: 10080, options: [10080, 20160, 43200], title: "onboarding_auto_save", patch: autoDumpPatch },
    { id: "suspend", enabled: "suspendEnabled", timing: "suspendAfterMinutes",
      fallback: 60, options: [60, 240, 720], title: "onboarding_auto_suspend", patch: suspendPatch }
  ].map((rule) => {
    const enabled = el("input", { type: "checkbox", "data-automation": rule.id,
      onchange: () => update(rule.patch(enabled.checked
        ? Number(readSettings()[rule.timing]) || rule.fallback : 0)) });
    const timing = el("select", { "data-timing": rule.id, "aria-label": msg(rule.title),
      onchange: () => update(rule.patch(Number(timing.value))) });
    const sync = () => {
      const settings = readSettings();
      enabled.checked = Boolean(settings[rule.enabled]);
      timing.disabled = !enabled.checked;
      const minutes = Number(settings[rule.timing]) || rule.fallback;
      const values = [...new Set([...rule.options, minutes])].sort((a, b) => a - b);
      timing.replaceChildren(...values.map((value) => el("option", { value },
        msg("onboarding_after_duration", [settingsDurationLabel(value, "auto")]))));
      timing.value = String(minutes);
    };
    registerSync(sync);
    sync();
    return el("div", { class: "ob-auto-row" },
      el("label", { class: "ob-auto-label" }, enabled, el("span", {}, msg(rule.title))),
      el("label", { class: "ob-auto-timing" }, el("span", {}, msg("onboarding_when_unused")), timing));
  });

  const limit = (key, titleKey, detailKey) => {
    let editRevision = 0;
    const input = el("input", {
      type: "number", min: "0", max: "999", step: "1", inputmode: "numeric",
      "data-tab-limit": key,
      oninput: () => { editRevision += 1; },
      onchange: async (event) => {
        const revision = ++editRevision;
        const value = normalizeOnboardingTabLimit(event.currentTarget.value, Number(input.max));
        event.currentTarget.value = String(value);
        const saved = await update({ [key]: value });
        if (saved === false && revision === editRevision) sync(true);
      }
    });
    const sync = (force = false) => {
      if (!force && document.activeElement === input) return;
      const stored = Number(readSettings()[key]);
      const value = Number.isInteger(stored) && stored >= 0 ? stored : 0;
      input.max = String(Math.max(999, value));
      input.value = String(value);
    };
    registerSync(sync);
    sync();
    return el("label", { class: "ob-tab-limit-row" },
      el("span", { class: "ob-tab-limit-copy" },
        el("strong", {}, msg(titleKey)),
        el("span", {}, msg(detailKey))),
      input);
  };
  const limits = el("details", { class: "ob-tab-limits" },
    el("summary", {}, msg("onboarding_tab_limits_title")),
    el("p", { class: "ob-note" }, msg("onboarding_tab_limits_intro")),
    el("div", { class: "ob-tab-limit-rows" },
      limit("autoSaveMaxTabs", "onboarding_tab_limit_open", "onboarding_tab_limit_open_detail"),
      limit("suspendMaxTabs", "onboarding_tab_limit_awake", "onboarding_tab_limit_awake_detail")),
    el("p", { class: "ob-note" }, msg("onboarding_tab_limit_off")));

  return el("div", { class: "ob-automation" }, ...rows,
    el("p", { class: "ob-note ob-automation-timing" }, msg("onboarding_automation_timing")),
    limits,
    el("aside", { class: "ob-protection" }, icon("shield", 22), el("div", {},
      el("h3", {}, msg("onboarding_protection_title")),
      el("p", {}, msg("onboarding_protection_body")),
      el("p", { class: "ob-note" }, msg("onboarding_protection_safety")))));
}

export function createOnboardingAppearance({ readSettings, update, registerSync }) {
  const segments = (key, title, options, style = false) => {
    const buttons = options.map(([value, label]) => el("button", {
      type: "button", class: "ob-segment", "data-preference": key, "data-value": value,
      "data-style-sample": style ? value : null, "aria-pressed": "false",
      onclick: () => update({ [key]: value })
    }, label));
    const sync = () => buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.value === readSettings()[key]));
    });
    registerSync(sync);
    sync();
    return el("fieldset", {}, el("legend", {}, title), el("div", { class: "ob-segments" }, ...buttons));
  };
  const modeLabels = Object.fromEntries(settingsOptions("mode"));
  const modes = ["scheme", "light", "dark", "system"].map((value) => [value, modeLabels[value]]);
  const toolbar = el("div", { class: "ob-appearance-toolbar" },
    segments("uiMode", msg("onboarding_appearance_mode"), modes),
    segments("uiInterfaceStyle", msg("settings_row_interface_style"), settingsOptions("interfaceStyle"), true));
  const featured = ["aladdin", "laser", "sunset", "frozenllama", "matcha", "devtty", "dracula", "hineybeige"];
  const buttons = [];
  const swatches = [];
  const grid = (ids) => el("div", { class: "ob-palette-grid" }, ...ids.map((scheme) => {
    const swatch = el("span", { class: "ob-palette-swatches scheme-role-scope", "data-scheme": scheme,
      "aria-hidden": "true" }, ...Array.from({ length: 4 }, () => el("i")));
    const button = el("button", { type: "button", class: "ob-palette", "data-scheme-choice": scheme,
      "aria-pressed": "false", onclick: () => update({ uiScheme: scheme })
    }, swatch, el("span", { class: "ob-palette-name" }, SCHEME_LABELS[scheme]));
    buttons.push(button);
    swatches.push(swatch);
    return button;
  }));
  const initial = grid(featured);
  const more = el("details", { class: "ob-more-palettes" },
    el("summary", {}, msg("settings_scheme_picker_all")), grid(SCHEMES.filter((id) => !featured.includes(id))));
  const custom = el("p", { class: "ob-note" }, msg("onboarding_custom_scheme"));
  const sync = () => {
    const settings = readSettings();
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.schemeChoice === settings.uiScheme));
    for (const swatch of swatches) swatch.dataset.mode = resolveSchemeMode(settings.uiMode,
      swatch.dataset.scheme, globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    custom.hidden = SCHEMES.includes(settings.uiScheme);
    if (!custom.hidden || featured.includes(settings.uiScheme)) return;
    more.open = true;
  };
  registerSync(sync);
  sync();
  return el("div", { class: "ob-appearance" }, toolbar, custom,
    el("fieldset", {}, el("legend", {}, msg("onboarding_scheme_aria")), initial, more),
    el("p", { class: "ob-note" }, msg("onboarding_appearance_later")));
}
