// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Compact custom colour-scheme library and routes into the dedicated editor. */
import { STORE_KEYS } from "../lib/types.js";
import { newMeta, upsertItem } from "../lib/store.js";
import {
  MAX_CUSTOM_SCHEME_BYTES,
  customSchemeCatalogue,
  customSchemeFileName,
  duplicateCustomSchemeRecord,
  parseCustomSchemeShare,
  serializeCustomSchemeShare
} from "../lib/custom-schemes.js";
import {
  deleteCustomSchemeAndRepair,
  loadCustomSchemeDraft
} from "../lib/custom-scheme-store.js";
import { validateSchemeEditorEnvelope } from "../lib/scheme-editor-model.js";
import { el } from "./dom.js";
import { customSchemeSettingsCopy as copy } from "./settings-copy.js";

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const editorReturn = () => location.pathname.endsWith("/options.html") ? "options" : "dashboard";
const editorUrl = (source = "") => {
  const query = new URLSearchParams({ return: editorReturn() });
  if (source) query.set("source", source);
  const path = `scheme-editor.html?${query}`;
  return chrome.runtime?.getURL ? chrome.runtime.getURL(path) : new URL(path, location.href).href;
};

/**
 * @param {{
 * records?: object[],
 * selectedScheme: () => string,
 * applyScheme: (selection:string) => Promise<void>,
 * onChanged: () => Promise<void>
 * }} options
 */
export function createCustomSchemeSettings({
  records = [], selectedScheme, applyScheme, onChanged
}) {
  let catalogue = customSchemeCatalogue(records);
  let busy = false;
  let deleteArmedId = null;
  let deleteTimer = 0;

  const root = el("div", { class: "custom-schemes" });
  const live = el("div", { class: "custom-scheme-live", role: "status", "aria-live": "polite" });
  const library = el("div", { class: "custom-scheme-library" });
  const draftRoute = el("div", { class: "custom-scheme-draft-route", hidden: "" });
  const importInput = el("input", {
    type: "file", accept: ".json,.everytab-scheme.json,application/json", hidden: ""
  });

  const announce = (message, error = false) => {
    live.textContent = message;
    live.classList.toggle("is-error", error);
  };

  const exportRecord = (record) => {
    const shared = serializeCustomSchemeShare(record);
    if (!shared.ok) {
      announce(copy.shareBlocked(), true);
      return;
    }
    downloadText(customSchemeFileName(record), shared.text);
    announce(copy.exported(record.name));
  };

  const duplicateRecord = async (record) => {
    if (busy) return;
    busy = true;
    const duplicate = duplicateCustomSchemeRecord(record, await newMeta());
    if (!duplicate.ok) {
      announce(copy.duplicateFailed(), true);
      busy = false;
      return;
    }
    await upsertItem(STORE_KEYS.customSchemes, duplicate.value);
    await onChanged();
    busy = false;
    announce(copy.duplicated(record.name));
  };

  function renderLibrary() {
    const active = selectedScheme();
    if (!catalogue.length) {
      library.replaceChildren(el("p", { class: "custom-scheme-empty" },
        copy.empty()));
      return;
    }
    library.replaceChildren(...catalogue.map(({ id, label, accent, defaultMode, record }) => {
      const isActive = active === id;
      const apply = el("button", {
        type: "button", class: `mini${isActive ? " accent" : ""}`,
        disabled: isActive,
        onclick: async () => {
          if (busy) return;
          busy = true;
          await applyScheme(id);
          busy = false;
          announce(copy.applied(label));
          renderLibrary();
        }
      }, isActive ? copy.appliedAction() : copy.applyAction());
      const remove = el("button", {
        type: "button", class: "mini danger-quiet",
        "aria-label": deleteArmedId === record.id ? copy.confirmDeleteAria(label) : copy.deleteAria(label),
        onclick: async () => {
          if (deleteArmedId !== record.id) {
            deleteArmedId = record.id;
            clearTimeout(deleteTimer);
            deleteTimer = setTimeout(() => { deleteArmedId = null; renderLibrary(); }, 5000);
            renderLibrary();
            library.querySelector(`[data-scheme-id="${record.id}"] .danger-quiet`)?.focus();
            return;
          }
          if (busy) return;
          busy = true;
          const deleted = await deleteCustomSchemeAndRepair(record.id);
          deleteArmedId = null;
          await onChanged();
          busy = false;
          announce(deleted ? copy.deleted(label) : copy.unavailable(label));
        }
      }, deleteArmedId === record.id ? copy.confirmDelete() : copy.deleteAction());
      return el("div", {
        class: `custom-scheme-row${isActive ? " is-active" : ""}`,
        "data-scheme-id": record.id
      },
      el("span", { class: "custom-scheme-swatch", style: `background:${accent}` }),
      el("span", { class: "custom-scheme-copy" },
        el("strong", {}, label),
        el("span", {}, copy.defaultMode(defaultMode))),
      el("span", { class: "custom-scheme-actions" },
        apply,
        el("a", { class: "mini button-link", href: editorUrl(`custom:${record.id}`) }, copy.edit()),
        el("button", { type: "button", class: "mini", onclick: () => duplicateRecord(record) }, copy.duplicate()),
        el("button", { type: "button", class: "mini", onclick: () => exportRecord(record) }, copy.share()),
        remove));
    }));
  }

  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    if (file.size > MAX_CUSTOM_SCHEME_BYTES) {
      announce(copy.tooLarge(MAX_CUSTOM_SCHEME_BYTES / 1024), true);
      return;
    }
    if (busy) return;
    busy = true;
    let result;
    try { result = parseCustomSchemeShare(await file.text(), await newMeta()); }
    catch { result = { ok: false }; }
    if (!result.ok) {
      announce(result.errors ? copy.invalid() : copy.unreadable(), true);
      busy = false;
      return;
    }
    await upsertItem(STORE_KEYS.customSchemes, result.value);
    await onChanged();
    busy = false;
    announce(copy.imported(result.value.name));
  });

  const controls = el("div", { class: "custom-scheme-top-actions" },
    el("a", { class: "accent button-link", href: editorUrl("builtin:cream") }, copy.openEditor()),
    el("button", { type: "button", onclick: () => importInput.click() }, copy.importScheme()),
    importInput);
  root.append(
    el("div", { class: "custom-scheme-intro" },
      el("div", {}, el("h4", {}, copy.heading()),
        el("p", {}, copy.intro())),
      controls),
    draftRoute,
    live,
    library);
  renderLibrary();

  void loadCustomSchemeDraft().then((stored) => {
    const restored = validateSchemeEditorEnvelope(stored);
    if (!restored) return;
    draftRoute.hidden = false;
    draftRoute.replaceChildren(
      el("span", {}, copy.unsaved(restored.draft.name || copy.untitled())),
      el("a", { class: "button-link", href: editorUrl() }, copy.continueDraft()));
  });

  return {
    element: root,
    refresh(nextRecords) {
      catalogue = customSchemeCatalogue(nextRecords);
      renderLibrary();
    }
  };
}
