/**
 * Standalone options page — thin wrapper around the shared settings form
 * (js/ui/settings-form.js), which is also mounted by the dashboard's
 * Settings page. One source of truth.
 */
import { el } from "./dom.js";
import { applyDocumentLocale } from "../lib/i18n.js";
import { initTheme } from "./theme.js";
import { mountSettingsForm } from "./settings-form.js";
import { settingsStatic } from "./settings-copy.js";

initTheme();
applyDocumentLocale();
document.title = settingsStatic.pageTitle();

const app = document.getElementById("app");
const list = el("div", { class: "setlist" });
app.append(el("h1", {}, settingsStatic.pageTitle()), list);
mountSettingsForm(list);
