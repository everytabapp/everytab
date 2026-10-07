// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Standalone options page — thin wrapper around the shared settings form
 * (js/ui/settings-form.js), which is also mounted by the dashboard's
 * Settings page. One source of truth.
 */
import { el } from "./dom.js";
import { applyDocumentLocale, applyUiLanguage } from "../lib/i18n.js";
import { getSettings } from "../lib/store.js";
import { initTheme } from "./theme.js";
import { mountSettingsForm } from "./settings-form.js";
import { settingsStatic } from "./settings-copy.js";

// The settings form re-reads the same cached Settings snapshot, so installing
// the chosen language first costs no extra storage read.
await applyUiLanguage((await getSettings()).uiLanguage);
initTheme();
applyDocumentLocale();
document.title = settingsStatic.pageTitle();

const app = document.getElementById("app");
const list = el("div", { class: "setlist" });
app.append(el("h1", {}, settingsStatic.pageTitle()), list);
mountSettingsForm(list);
