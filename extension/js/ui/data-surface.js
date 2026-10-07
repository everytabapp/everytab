// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { buildJsonExport } from "../lib/export.js";
import { detectFormat, parseImport, importCounts } from "../lib/import-formats.js";
import { importFormatLabel, importFormatOptions } from "../lib/import-copy.js";
import { commitParsedImport } from "../lib/import-commit.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { el, coalesce } from "./dom.js";
import { createDataRecoveryPicker } from "./data-recovery-picker.js";
import { createRestorePanel } from "./restore-panel.js";
import { shellSectionTitle } from "./shell-copy.js";
import {
  dataCandidateMeta, dataImportNoLinks, dataRecentlyClosedAction,
  dataRecentlyClosedFound, dataRecentlyClosedProgress, dataRecentlyClosedResult,
  dataSnapshotAction, dataSnapshotCandidateMeta, dataSnapshotMissing,
  dataSnapshotOption, dataSnapshotProgress, dataSnapshotResult, dataSnapshotsAvailable,
  dataStatic
} from "./data-copy.js";

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
  let mounted = false;

  function renderInner() {
    setHeading(shellSectionTitle("data"));
    // Data navigation keeps this controller and its workflow nodes mounted. The
    // import textarea, parsed preview, and Restore review are user-owned state;
    // jumping between the continuously visible sections must never rebuild them.
    if (mounted && getBody().querySelector("[data-data-area]")) return;

    const exportAction = el("button", { class: "primary", onclick: async () =>
      download(`everytab-backup-${new Date().toISOString().slice(0, 10)}.json`,
        await buildJsonExport(), "application/json") }, dataStatic.downloadBackup());

    let parsed = null;
    let importing = false;
    let draftRevision = 0;
    const importArea = el("textarea", {
      rows: 5,
      placeholder: dataStatic.pasteExport()
    });
    const importFile = el("input", {
      type: "file", accept: ".json,.csv,.html,.htm,.txt,.md,.markdown", class: "hidden-file"
    });
    const fileNameOut = el("span", { class: "item-meta" });
    const formatSelect = el(
      "select",
      { "aria-label": dataStatic.importFormatAria() },
      el("option", { value: "" }, dataStatic.autoDetect()),
      ...importFormatOptions().map((format) => el("option", { value: format.id }, format.label))
    );
    const destSelect = el(
      "select",
      { "aria-label": dataStatic.importDestinationAria() },
      el("option", { value: "archive" }, dataStatic.archiveDestination()),
      el("option", { value: "inbox" }, dataStatic.inboxDestination()),
      el("option", { value: "session" }, dataStatic.sessionDestination())
    );
    const labelsToggle = el("input", { type: "checkbox" });
    labelsToggle.checked = true;
    const labelsField = el("label", {
      class: "imp-toggle",
      title: dataStatic.labelsTitle()
    }, labelsToggle, dataStatic.labelsToggle());
    const summaryLine = el("div", { class: "note data-import-preview" });
    summaryLine.style.display = "none";
    const importInfo = el("span", { class: "item-meta", role: "status", "aria-live": "polite" });
    const importBtn = el("button", { class: "primary", onclick: () => doImport() },
      dataStatic.importAction());

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
        summaryLine.textContent = dataImportNoLinks(parsed.source);
        importBtn.disabled = true;
        return;
      }
      importBtn.disabled = importing;
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
        importFormatLabel(parsed.source), formatNumber(counts.tabs), formatNumber(counts.groups),
        destination, labelPart
      ]);
    }

    function renderPreview() {
      draftRevision++;
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
          importFormatLabel(format)
        ]), "bad");
        importBtn.disabled = true;
        return;
      }
      updateSummary();
    }

    async function doImport() {
      if (importing) return;
      if (!parsed?.groups.length) {
        outcome(importInfo, "item-meta", localeMessage("import_choose_source_first"), "bad");
        return;
      }
      // Claim before the first await. Completion belongs to this captured
      // source/options, while the user can prepare a newer draft independently.
      importing = true;
      const revision = draftRevision;
      const source = structuredClone(parsed);
      const destination = destSelect.value;
      const keepLabels = labelsToggle.checked;
      updateSummary();
      try {
        let committed;
        try {
          committed = await commitParsedImport(source, { destination, keepLabels });
        } catch {
          outcome(importInfo, "item-meta", localeMessage("import_save_failed"), "bad");
          return;
        }
        if (!committed.ok) {
          outcome(importInfo, "item-meta", localeMessage("import_changed_retry"), "bad");
          return;
        }
        if (draftRevision === revision) {
          importArea.value = "";
          fileNameOut.textContent = "";
          renderPreview();
        }
        outcome(importInfo, "item-meta",
          destination === "session"
            ? localeMessage("import_success_session", [formatNumber(committed.tabCount), source.name])
            : destination === "archive"
              ? localeMessage(keepLabels
                ? "import_success_archive_labeled"
                : "import_success_archive", [formatNumber(committed.tabCount)])
              : localeMessage(committed.createdCount === 1
                ? "import_success_inbox_one"
                : "import_success_inbox_other", [
                formatNumber(committed.createdCount), formatNumber(committed.tabCount)
              ]), "good");
        try {
          await onChanged({ entry: committed.entry ?? null });
        } catch {
          // A host refresh cannot turn a durable save into a retryable import.
          outcome(importInfo, "item-meta", localeMessage("import_saved_refresh_failed"), "bad");
        }
      } finally {
        importing = false;
        updateSummary();
      }
    }

    importArea.addEventListener("input", renderPreview);
    formatSelect.addEventListener("change", renderPreview);
    const updateOptions = () => { draftRevision++; updateSummary(); };
    destSelect.addEventListener("change", updateOptions);
    labelsToggle.addEventListener("change", updateOptions);
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

    const recoveryBody = el("div", { class: "data-suspend-recovery" });
    const recoveryStatus = el("div", {
      class: "note data-recovery-status", role: "status", "aria-live": "polite"
    });
    const checkRecovery = el("button", { onclick: () => inspectRecovery() },
      dataStatic.checkRecentlyClosed());

    const recoveryPicker = createDataRecoveryPicker({
      body: recoveryBody,
      status: recoveryStatus,
      checkControl: checkRecovery,
      adapter: {
        candidateKey: (candidate) => candidate.sessionId,
        candidateContent: (candidate) => {
          const when = candidate.closedAt
            ? new Date(candidate.closedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : dataStatic.recentlyClosed();
          return el("span", { class: "tw" },
            el("span", { class: "t" }, candidate.title),
            el("span", { class: "d" }, dataCandidateMeta(candidate.domain, when)));
        },
        actionText: dataRecentlyClosedAction,
        progressText: dataRecentlyClosedProgress,
        foundText: dataRecentlyClosedFound,
        emptyText: dataStatic.noRecentlyClosed,
        failureText: dataStatic.recentWorkerFailure,
        resultText: dataRecentlyClosedResult,
        recover: (_context, sessionIds) => chrome.runtime.sendMessage({
          type: "recover-recently-closed-suspended", sessionIds
        }),
        refresh: (_context, options) => inspectRecovery(options)
      }
    });

    async function inspectRecovery({ preserveStatus = false } = {}) {
      const priorStatus = recoveryStatus.textContent;
      checkRecovery.disabled = true;
      if (!preserveStatus) recoveryStatus.textContent = dataStatic.checkingRecentlyClosed();
      const result = await chrome.runtime.sendMessage({
        type: "inspect-recently-closed-suspended"
      }).catch(() => null);
      checkRecovery.disabled = false;
      if (!result?.ok) {
        recoveryPicker.clear();
        recoveryStatus.textContent = dataStatic.recentCheckFailure();
        return;
      }
      if (preserveStatus && result.candidates.length === 0) {
        recoveryPicker.clear();
        return;
      }
      recoveryPicker.render(null, result.candidates);
      if (preserveStatus && priorStatus) recoveryStatus.textContent = priorStatus;
    }

    const snapshotRecoveryBody = el("div", { class: "data-suspend-recovery" });
    const snapshotRecoveryStatus = el("div", {
      class: "note data-recovery-status", role: "status", "aria-live": "polite"
    });
    const snapshotRecoveryControls = el("div", { class: "data-recovery-actions" });
    const checkSnapshots = el("button", { onclick: () => inspectSnapshots() },
      dataStatic.checkSnapshots());

    const snapshotRecoveryPicker = createDataRecoveryPicker({
      body: snapshotRecoveryBody,
      status: snapshotRecoveryStatus,
      checkControl: checkSnapshots,
      adapter: {
        candidateKey: (candidate) => candidate.key,
        candidateContent: (candidate) => el("span", { class: "tw" },
          el("span", { class: "t" }, candidate.title),
          el("span", { class: "d" },
            dataSnapshotCandidateMeta(candidate.windowIndex, candidate.domain))),
        actionText: dataSnapshotAction,
        progressText: dataSnapshotProgress,
        foundText: dataSnapshotMissing,
        emptyText: dataStatic.noMissingTabs,
        failureText: dataStatic.snapshotWorkerFailure,
        resultText: dataSnapshotResult,
        recover: (snapshot, pickKeys) => chrome.runtime.sendMessage({
          type: "recover-snapshot-missing-tabs",
          snapshotId: snapshot.snapshotId,
          pickKeys
        }),
        refresh: (snapshot, options) => reviewSnapshot(snapshot.snapshotId, options)
      }
    });

    async function reviewSnapshot(snapshotId, { preserveStatus = false } = {}) {
      const priorStatus = snapshotRecoveryStatus.textContent;
      snapshotRecoveryStatus.textContent = preserveStatus
        ? priorStatus
        : dataStatic.comparingSnapshot();
      const result = await chrome.runtime.sendMessage({
        type: "review-snapshot-recovery", snapshotId
      }).catch(() => null);
      if (!result?.ok) {
        snapshotRecoveryPicker.clear();
        snapshotRecoveryStatus.textContent = dataStatic.snapshotUnavailable();
        return;
      }
      snapshotRecoveryPicker.render(result.snapshot, result.candidates);
      if (preserveStatus && priorStatus) snapshotRecoveryStatus.textContent = priorStatus;
    }

    async function inspectSnapshots() {
      checkSnapshots.disabled = true;
      snapshotRecoveryStatus.textContent = dataStatic.checkingSnapshots();
      const result = await chrome.runtime.sendMessage({
        type: "inspect-snapshot-recovery"
      }).catch(() => null);
      checkSnapshots.disabled = false;
      snapshotRecoveryPicker.clear();
      if (!result?.ok) {
        snapshotRecoveryControls.replaceChildren();
        snapshotRecoveryStatus.textContent = dataStatic.snapshotCheckFailure();
        return;
      }
      if (!result.snapshots.length) {
        snapshotRecoveryControls.replaceChildren();
        snapshotRecoveryStatus.textContent = dataStatic.noSnapshots();
        return;
      }
      const select = el("select", { "aria-label": dataStatic.snapshotSelectAria() },
        ...result.snapshots.map((snapshot) => el("option", { value: snapshot.snapshotId },
          dataSnapshotOption(snapshot))));
      const recommended = result.snapshots.find((snapshot) => snapshot.missingCount > 0);
      if (recommended) select.value = recommended.snapshotId;
      const review = el("button", {
        onclick: () => reviewSnapshot(select.value)
      }, dataStatic.reviewMissing());
      snapshotRecoveryControls.replaceChildren(select, review);
      snapshotRecoveryStatus.textContent = dataSnapshotsAvailable(result.snapshots.length);
    }

    getBody().replaceChildren(
      el("div", {
        class: "data-area", id: "data-area-recover", "data-data-area": "recover"
      },
      el("section", { class: "settings-group data-group" },
        el("h3", {}, dataStatic.restoreHeading()),
        el("div", { class: "setrow data-restore-row" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, dataStatic.restoreTitle()),
            el("div", { class: "d" }, dataStatic.restoreDescription()))),
        restorePanel),
      el("section", { class: "settings-group data-group" },
        el("h3", {}, dataStatic.recoveryHeading()),
        el("div", { class: "setrow" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, dataStatic.recentTitle()),
            el("div", { class: "d" }, dataStatic.recentDescription())),
          checkRecovery),
        recoveryStatus,
        recoveryBody,
        el("div", { class: "setrow" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, dataStatic.snapshotTitle()),
            el("div", { class: "d" }, dataStatic.snapshotDescription())),
          checkSnapshots),
        snapshotRecoveryControls,
        snapshotRecoveryStatus,
        snapshotRecoveryBody)),
      el("div", {
        class: "data-area", id: "data-area-transfer", "data-data-area": "transfer"
      },
      el("section", { class: "settings-group data-group" },
        el("h3", {}, dataStatic.backupHeading()),
        el("div", { class: "setrow" },
          el("div", { class: "tw" },
            el("div", { class: "t" }, dataStatic.backupTitle()),
            el("div", { class: "d" }, dataStatic.backupDescription())),
          exportAction)),
      el("section", { class: "settings-group data-group data-interoperability" },
        el("h3", {}, dataStatic.importHeading()),
        el("p", { class: "note" }, dataStatic.importDescription()),
        importFile,
        el("div", { class: "data-import-source" },
          el("button", { onclick: () => importFile.click() }, dataStatic.chooseFile()),
          fileNameOut),
        importArea,
        el("div", { class: "data-import-controls" }, formatSelect, destSelect, labelsField),
        summaryLine,
        el("div", { class: "data-import-outcome" }, importBtn, importInfo)))
    );
    mounted = true;
  }

  return { render };
}
