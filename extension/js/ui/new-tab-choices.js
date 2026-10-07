// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared New Tab page and initial-focus choices for Settings and onboarding. */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { msg } from "../lib/i18n.js";

const MODE_COPY = {
  dashboard: ["new_tab_choice_dashboard_title", "new_tab_choice_dashboard_detail"],
  minimal: ["new_tab_choice_minimal_title", "new_tab_choice_minimal_detail"],
  blank: ["new_tab_choice_blank_title", "new_tab_choice_blank_detail"]
};
const MODES = Object.keys(MODE_COPY);
const FOCUS_TARGETS = ["omnibox", "search"];

function thumbnail(mode) {
  if (mode === "minimal") {
    return el("span", { class: "new-tab-choice-thumbnail is-minimal", "aria-hidden": "true" },
      el("span", { class: "new-tab-choice-clock" }, "09:41"),
      el("span", { class: "new-tab-choice-search" }),
      el("span", { class: "new-tab-choice-starred" }, "★  ★  ★"));
  }
  if (mode === "dashboard") {
    return el("span", { class: "new-tab-choice-thumbnail is-dashboard", "aria-hidden": "true" },
      el("span", { class: "new-tab-choice-sidebar" }),
      el("span", { class: "new-tab-choice-open" },
        el("i"), el("i"), el("i"), el("span", { class: "new-tab-choice-saved" })));
  }
  return el("span", { class: "new-tab-choice-thumbnail is-blank", "aria-hidden": "true" },
    el("span", { class: "new-tab-choice-mark" }, icon("mark", 20)));
}

/**
 * @param {{
 *   readSettings: () => {newTabMode?: string, newTabFocus?: string},
 *   update: (patch: {newTabMode?: string, newTabFocus?: string}) => void|Promise<unknown>,
 *   registerSync?: (sync: () => void) => void
 * }} dependencies
 * @returns {HTMLElement}
 */
export function createNewTabChoices({ readSettings, update, registerSync } = {}) {
  if (typeof readSettings !== "function" || typeof update !== "function") {
    throw new TypeError("New Tab choices require readSettings and update callbacks");
  }

  const instance = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const modeName = `new-tab-mode-${instance}`;
  const focusName = `new-tab-focus-${instance}`;
  const status = el("p", {
    class: "new-tab-choice-status", role: "status", "aria-live": "polite"
  });

  const modeInputs = new Map();
  const choices = el("div", { class: "new-tab-choice-grid" });
  for (const mode of MODES) {
    const input = el("input", { type: "radio", name: modeName, value: mode });
    modeInputs.set(mode, input);
    choices.append(el("label", { class: "new-tab-choice-option" },
      el("span", { class: "new-tab-choice-preview-label" }, msg("new_tab_choice_preview")),
      thumbnail(mode),
      el("span", { class: "new-tab-choice-title" }, input,
        el("strong", {}, msg(MODE_COPY[mode][0]))),
      el("span", { class: "new-tab-choice-detail" }, msg(MODE_COPY[mode][1]))));
  }

  const focusInputs = new Map(FOCUS_TARGETS.map((target) => [target,
    el("input", { type: "radio", name: focusName, value: target })]));
  const focusChoices = el("div", { class: "new-tab-focus-options" },
    el("label", {}, focusInputs.get("omnibox"), msg("new_tab_choice_focus_omnibox")),
    el("label", {}, focusInputs.get("search"), msg("new_tab_choice_focus_search")));
  const focusFieldset = el("fieldset", { class: "new-tab-focus-choice" },
    el("legend", {}, msg("new_tab_choice_focus_title")),
    el("p", { class: "new-tab-choice-detail" }, msg("new_tab_choice_focus_detail")),
    focusChoices);
  const focusSection = el("div", { class: "new-tab-focus-section" }, focusFieldset);

  const root = el("div", { class: "setrow setrow-stacked new-tab-choices" },
    el("p", { class: "new-tab-choice-intro" }, msg("new_tab_choice_intro")),
    el("fieldset", { class: "new-tab-layout-choice" },
      el("legend", {}, msg("new_tab_choice_layout_title")), choices),
    focusSection,
    el("details", { class: "new-tab-native-note" },
      el("summary", {}, msg("new_tab_choice_native_title")),
      el("p", { class: "new-tab-choice-detail" }, msg("new_tab_choice_native_detail"))),
    status);

  let displayed = { newTabMode: "dashboard", newTabFocus: "omnibox" };
  const paint = (snapshot) => {
    displayed = {
      newTabMode: MODES.includes(snapshot?.newTabMode) ? snapshot.newTabMode : "dashboard",
      newTabFocus: FOCUS_TARGETS.includes(snapshot?.newTabFocus) ? snapshot.newTabFocus : "omnibox"
    };
    for (const [mode, input] of modeInputs) input.checked = mode === displayed.newTabMode;
    for (const [target, input] of focusInputs) input.checked = target === displayed.newTabFocus;
    focusSection.hidden = displayed.newTabMode === "blank";
  };
  let pending = 0;
  const sync = () => { if (!pending) paint(readSettings()); };
  const commit = (patch) => {
    if (!pending) status.textContent = "";
    pending += 1;
    let result;
    // Enrol the save before another click can finish onboarding. The host
    // owns persistence; this component holds its optimistic radio state until
    // every outstanding write settles, including cross-field changes.
    try { result = update(patch); } catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then((saved) => {
      if (saved === false) throw new Error("New Tab preference was not saved");
    }).catch(() => {
      status.textContent = msg("new_tab_choice_update_failed");
    }).finally(() => {
      pending -= 1;
      sync();
    });
  };

  for (const [mode, input] of modeInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      paint({ ...displayed, newTabMode: mode });
      return commit({ newTabMode: mode });
    });
  }
  for (const [target, input] of focusInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      paint({ ...displayed, newTabFocus: target });
      return commit({ newTabFocus: target });
    });
  }

  registerSync?.(sync);
  sync();
  return root;
}
