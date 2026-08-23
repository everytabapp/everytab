import { buildJsonExport } from "../lib/export.js";
import {
  detectFormat, parseImport, importCounts, FORMAT_LABELS, IMPORT_FORMATS
} from "../lib/import-formats.js";
import { commitParsedImport } from "../lib/import-commit.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { el, coalesce } from "./dom.js";
import { createRestorePanel } from "./restore-panel.js";
import { shellSectionTitle } from "./shell-copy.js";

const IMPORT_ACCEPT = /\.(json|csv|html?|txt|md|markdown)$/i;

function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = el("a", { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Owns portable Backup, Restore, and interoperability import presentation and
 * behavior. The host supplies stable slots plus one committed-change effect.
 */
export function createDataSurface({ getBody, setHeading, onChanged }) {
  const render = coalesce(renderInner);

  function renderInner() {
    setHeading(shellSectionTitle("data"));

    const exportAction = el("button", { class: "primary", onclick: async () =>
      download(`everytab-backup-${new Date().toISOString().slice(0, 10)}.json`,
        await buildJsonExport(), "application/json") }, "Download backup");

    let parsed = null;
    const importArea = el("textarea", {
      rows: 5,
      placeholder: "Or paste the export text here..."
    });
    const importFile = el("input", {
      type: "file", accept: ".json,.csv,.html,.htm,.txt,.md,.markdown", class: "hidden-file"
    });
    const fileNameOut = el("span", { class: "item-meta" });
    const formatSelect = el(
      "select",
      { "aria-label": "Import format" },
      el("option", { value: "" }, "Auto-detect"),
      ...IMPORT_FORMATS.map((format) => el("option", { value: format.id }, format.label))
    );
    const destSelect = el(
      "select",
      { "aria-label": "Where to put the imported tabs" },
      el("option", { value: "archive" }, "File to Archive (find by label)"),
      el("option", { value: "inbox" }, "Add as Inbox bundles"),
      el("option", { value: "session" }, "Add as one session")
    );
    const labelsToggle = el("input", { type: "checkbox" });
    labelsToggle.checked = true;
    const labelsField = el("label", {
      class: "imp-toggle",
      title: "Turn Markdown headings, folders, collections, and tags into labels on imported tabs"
    }, labelsToggle, "Create labels from headings, folders, or tags");
    const summaryLine = el("div", { class: "note" });
    summaryLine.style.display = "none";
    const importInfo = el("span", { class: "item-meta" });
    const importBtn = el("button", { class: "primary", onclick: () => doImport() }, "Import");

    const outcome = (node, base, text, kind = "") => {
      node.className = kind ? `${base} ${kind}` : base;
      node.textContent = text;
    };

    function updateSummary() {
      if (!parsed) {
        summaryLine.style.display = "none";
        importBtn.disabled = true;
        return;
      }
      summaryLine.style.display = "";
      if (!parsed.groups.length) {
        summaryLine.textContent = `${FORMAT_LABELS[parsed.source]}: no http links found to import.`;
        importBtn.disabled = true;
        return;
      }
      importBtn.disabled = false;
      const counts = importCounts(parsed.groups);
      const destination = destSelect.value === "session"
        ? localeMessage(counts.groups === 1
          ? "import_destination_session_one"
          : "import_destination_session_other", [formatNumber(counts.groups)])
        : destSelect.value === "archive"
          ? localeMessage("import_destination_archive")
          : localeMessage(counts.groups === 1
            ? "import_destination_inbox_one"
            : "import_destination_inbox_other", [formatNumber(counts.groups)]);
      const labelPart = !labelsToggle.checked
        ? localeMessage("import_no_labels")
        : counts.labels
          ? localeMessage(counts.labels === 1 ? "import_labels_one" : "import_labels_other",
            [formatNumber(counts.labels)])
          : "";
      summaryLine.textContent = localeMessage("import_preview_summary", [
        FORMAT_LABELS[parsed.source], formatNumber(counts.tabs), formatNumber(counts.groups),
        destination, labelPart
      ]);
    }

    function renderPreview() {
      parsed = null;
      importInfo.textContent = "";
      const text = importArea.value;
      if (!text.trim()) {
        summaryLine.style.display = "none";
        importBtn.disabled = true;
        return;
      }
      const format = formatSelect.value || detectFormat(text);
      if (!format) {
        summaryLine.style.display = "";
        summaryLine.textContent = localeMessage("import_format_unrecognized");
        importBtn.disabled = true;
        return;
      }
      try {
        parsed = parseImport(text, format);
      } catch {
        summaryLine.style.display = "";
        outcome(summaryLine, "note", localeMessage("import_invalid_format", [
          FORMAT_LABELS[format]
        ]), "bad");
        importBtn.disabled = true;
        return;
      }
      updateSummary();
    }

    async function doImport() {
      if (!parsed?.groups.length) {
        outcome(importInfo, "item-meta", localeMessage("import_choose_source_first"), "bad");
        return;
      }
      const destination = destSelect.value;
      const committed = await commitParsedImport(parsed, {
        destination,
        keepLabels: labelsToggle.checked
      });
      if (!committed.ok) {
        outcome(importInfo, "item-meta", localeMessage("import_changed_retry"), "bad");
        return;
      }
      const counts = importCounts(parsed.groups);
      outcome(importInfo, "item-meta",
        destination === "session"
          ? localeMessage("import_success_session", [formatNumber(counts.tabs), parsed.name])
          : destination === "archive"
            ? localeMessage(labelsToggle.checked
              ? "import_success_archive_labeled"
              : "import_success_archive", [formatNumber(counts.tabs)])
            : localeMessage(counts.groups === 1
              ? "import_success_inbox_one"
              : "import_success_inbox_other", [
              formatNumber(counts.groups), formatNumber(counts.tabs)
            ]), "good");
      importArea.value = "";
      fileNameOut.textContent = "";
      renderPreview();
      await onChanged({ entry: committed.entry ?? null });
    }

    importArea.addEventListener("input", renderPreview);
    formatSelect.addEventListener("change", renderPreview);
    destSelect.addEventListener("change", updateSummary);
    labelsToggle.addEventListener("change", updateSummary);
    importFile.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      if (!IMPORT_ACCEPT.test(file.name)) {
        outcome(importInfo, "item-meta",
          localeMessage("import_unsupported_file", [file.name]), "bad");
        importFile.value = "";
        return;
      }
      fileNameOut.textContent = file.name;
      importArea.value = await file.text();
      importFile.value = "";
      renderPreview();
    });

    const restorePanel = createRestorePanel({
      download,
      onChange: () => onChanged({ entry: null })
    });

    getBody().replaceChildren(
      el("section", { class: "settings-group data-group" },
        el("h3", {}, "Backup"),
        el("div", { class: "setrow" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, "Download EveryTab data"),
            el("div", { class: "d" },
              "Saved tabs, Sessions, labels, groups, custom schemes, ordinary settings, and label recency in one portable JSON file.")),
          exportAction)),
      el("section", { class: "settings-group data-group" },
        el("h3", {}, "Restore"),
        el("div", { class: "setrow data-restore-row" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, "Restore an EveryTab backup"),
            el("div", { class: "d" },
              "Check the file first, review exactly what will change, then confirm once."))),
        restorePanel),
      el("section", { class: "settings-group data-group data-interoperability" },
        el("h3", {}, "Import shared tabs or another tab tool"),
        el("p", { class: "note" },
          "Paste an EveryTab Markdown copy, or bring in OneTab, Session Buddy, Tab Session Manager, Toby, Raindrop CSV, or browser bookmarks."),
        importFile,
        el("div", { class: "data-import-source" },
          el("button", { onclick: () => importFile.click() }, "Choose file..."),
          fileNameOut),
        importArea,
        el("div", { class: "data-import-controls" }, formatSelect, destSelect, labelsField),
        summaryLine,
        el("div", { class: "data-import-outcome" }, importBtn, importInfo))
    );
  }

  return { render };
}
