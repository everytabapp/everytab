/** Inline, no-modal JSON Restore preview, confirmation, result, and Undo. */
import { el } from "./dom.js";
import {
  buildRestoreCheckpointExport, previewPortableRestore,
  readPortableRestoreCheckpoint, readPortableRestoreFile,
  restorePortableState, undoPortableRestore
} from "../lib/portable-state.js";
import {
  captureRestoreFocus, markRestoreFocus, restoreRestoreFocus
} from "./restore-panel-focus.js";
import { showLoadingFeedback } from "./loading.js";
import { formatList, formatNumber, msg as localeMessage } from "../lib/i18n.js";

const DEFAULT_RESTORE_EFFECTS = Object.freeze({
  readFile: readPortableRestoreFile,
  preview: previewPortableRestore,
  restore: restorePortableState,
  undo: undoPortableRestore,
  checkpointExport: buildRestoreCheckpointExport,
  readCheckpoint: readPortableRestoreCheckpoint
});

/** Yield one compositor opportunity after staging Loading and before JSON.parse. */
function yieldForRestoreValidation() {
  return new Promise((resolve) => {
    const nextFrame = globalThis.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0));
    nextFrame(() => setTimeout(resolve, 0));
  });
}

/**
 * @param {RestorePanelOptions} options
 * @returns {HTMLElement} mounted-workflow root; storage changes occur only through effects
 */
export function createRestorePanel({
  download,
  onJournal = null,
  onChange = null,
  effects = {},
  armTimeoutMs = 4000,
  scheduleArm = (callback, delay) => setTimeout(callback, delay),
  cancelArm = (handle) => clearTimeout(handle)
}) {
  const restoreEffects = { ...DEFAULT_RESTORE_EFFECTS, ...effects };
  let backupText = "";
  let source = null;
  let preview = null;
  let armed = false;
  let armTimer = null;
  let busy = false;
  let completed = false;
  let previewGeneration = 0;
  let replacingAction = false;

  const input = el("input", { type: "file", accept: ".json", class: "hidden-file" });
  const choose = markRestoreFocus(
    el("button", { type: "button", onclick: () => input.click() },
      localeMessage("restore_choose_backup")),
    "choose-backup"
  );
  const fileName = el("span", { class: "item-meta" });
  const status = el("div", { class: "note", role: "status", "aria-live": "polite" });
  const loadingHost = el("div", { class: "restore-loading-host" });
  const previewHost = el("div");
  const actionHost = el("div", { class: "bulk-bar" });
  const priorHost = el("div");
  const restoreSettings = markRestoreFocus(
    el("input", { type: "checkbox", "aria-label": localeMessage("restore_settings") }),
    "restore-settings"
  );
  restoreSettings.checked = true;

  const findFocusIdentity = (identity) => [previewHost, actionHost, priorHost]
    .flatMap((host) => [...host.querySelectorAll("[data-restore-focus-id]")])
    .find((node) => node.dataset.restoreFocusId === identity) ??
    (choose.dataset.restoreFocusId === identity ? choose : null);

  const resetArm = ({ focus = false } = {}) => {
    armed = false;
    if (armTimer !== null) cancelArm(armTimer);
    armTimer = null;
    renderAction({ focus });
  };

  const resultCopy = (summary) => {
    const changed = summary.records.added + summary.records.updated;
    const parts = [];
    if (changed) parts.push(localeMessage(changed === 1
      ? "restore_saved_record_one"
      : "restore_saved_record_other", [formatNumber(changed)]));
    if (summary.labelMeta.advanced) {
      parts.push(localeMessage(summary.labelMeta.advanced === 1
        ? "restore_label_date_one"
        : "restore_label_date_other", [formatNumber(summary.labelMeta.advanced)]));
    }
    if (summary.settings.changed) parts.push(localeMessage("restore_settings_lower"));
    return parts.length ? formatList(parts) : localeMessage("restore_no_portable_state");
  };

  async function offerCheckpointDownload(checkpointId) {
    try {
      const text = await restoreEffects.checkpointExport(checkpointId);
      if (!text) {
        status.className = "note bad";
        status.textContent = localeMessage("restore_checkpoint_unavailable");
        return;
      }
      download(
        `everytab-restore-recovery-${new Date().toISOString().slice(0, 10)}.json`,
        text,
        "application/json"
      );
    } catch {
      status.className = "note bad";
      status.textContent = localeMessage("restore_recovery_failed");
    }
  }

  function recoveryButton(checkpointId, { focus = false } = {}) {
    const button = markRestoreFocus(el("button", {
      type: "button", onclick: () => offerCheckpointDownload(checkpointId)
    }, localeMessage("restore_download_earlier_data")), `restore-recovery:${checkpointId}`);
    if (focus) queueMicrotask(() => button.focus());
    return button;
  }

  function renderUndo(checkpointId, { prior = false } = {}) {
    const label = localeMessage(prior ? "restore_undo_last" : "restore_undo");
    const button = markRestoreFocus(el("button", { type: "button", onclick: async () => {
      button.disabled = true;
      try {
        const result = await restoreEffects.undo(checkpointId);
        if (result.status === "undone") {
          completed = false;
          status.className = "note good";
          status.textContent = localeMessage("restore_undone");
          priorHost.replaceChildren();
          renderAction();
          (actionHost.querySelector("button") ?? choose).focus();
          onChange?.();
        } else if (result.status === "stale") {
          status.className = "note bad";
          status.textContent = localeMessage("restore_undo_stale");
          const keep = recoveryButton(checkpointId);
          priorHost.replaceChildren(el("div", { class: "bulk-bar" }, keep));
          keep.focus();
        } else {
          status.className = "note bad";
          status.textContent = localeMessage("restore_undo_unavailable");
        }
      } catch {
        status.className = "note bad";
        status.textContent = localeMessage("restore_undo_failed");
      } finally {
        button.disabled = false;
        if (button.isConnected && document.activeElement === document.body) button.focus();
      }
    } }, label), `restore-undo:${checkpointId}`);
    return button;
  }

  function renderPreview() {
    const focusSnapshot = captureRestoreFocus(document, [previewHost]);
    previewHost.replaceChildren();
    if (!preview) return;
    const date = preview.exportedAt
      ? new Date(preview.exportedAt).toLocaleDateString()
      : localeMessage("restore_date_not_recorded");
    const records = preview.records;
    const kept = records.keptIncoming + records.localOnly;
    const settingsField = el("label", { class: "imp-toggle" },
      restoreSettings,
      preview.settings.available
        ? localeMessage("restore_settings_recognized", [formatNumber(preview.settings.count)])
        : localeMessage("restore_no_settings"));
    restoreSettings.disabled = !preview.settings.available;

    previewHost.replaceChildren(
      el("div", { class: "note" },
        el("strong", {}, localeMessage(preview.legacy
          ? "restore_legacy_backup_date"
          : "restore_backup_date", [date])),
        el("div", {}, localeMessage(records.incoming === 1
          ? "restore_file_record_one"
          : "restore_file_record_other", [formatNumber(records.incoming)]))),
      el("div", { class: "bulk-bar" }, settingsField),
      el("div", { class: "note" },
        localeMessage("restore_plan_summary", [
          formatNumber(records.added), formatNumber(records.updated), formatNumber(kept),
          formatNumber(preview.labelMeta.advanced)
        ]))
    );
    restoreRestoreFocus({
      document,
      snapshot: focusSnapshot,
      findIdentity: findFocusIdentity,
      fallback: restoreSettings
    });
  }

  async function commit() {
    if (!backupText || busy) return;
    busy = true;
    renderAction();
    status.className = "note";
    status.textContent = localeMessage("restore_restoring_locally");
    try {
      const result = await restoreEffects.restore(backupText, {
        restoreSettings: restoreSettings.checked,
        source,
        confirmationToken: armed ? preview?.confirmationToken : null
      });
      armed = false;
      if (armTimer !== null) cancelArm(armTimer);
      armTimer = null;
      if (result.status === "confirmation-required") {
        preview = result.summary;
        status.className = "note";
        status.textContent = localeMessage("restore_reconfirm_changed");
        renderPreview();
        renderAction({ focus: true });
      } else if (result.status === "no-op") {
        completed = true;
        status.className = "note good";
        status.textContent = localeMessage("restore_already_current");
        renderAction();
        choose.focus();
      } else {
        completed = true;
        status.className = "note good";
        status.textContent = localeMessage("restore_success", [resultCopy(result.summary)]);
        const undo = renderUndo(result.checkpointId);
        priorHost.replaceChildren(el("div", { class: "bulk-bar" }, undo));
        undo.focus();
        onJournal?.(result.journalEntry);
        onChange?.();
      }
    } catch (error) {
      status.className = "note bad";
      status.textContent = localeMessage("restore_failed", [
        error?.message ?? localeMessage("restore_failed_fallback")
      ]);
    } finally {
      busy = false;
      renderAction();
    }
  }

  function renderAction({ focus = false } = {}) {
    const focusSnapshot = captureRestoreFocus(document, [actionHost]);
    choose.disabled = busy;
    restoreSettings.disabled = busy || completed || !preview?.settings.available;
    replacingAction = true;
    actionHost.replaceChildren();
    replacingAction = false;
    if (!preview || completed) return;
    const button = markRestoreFocus(el("button", {
      type: "button",
      class: preview.changed ? "primary" : "",
      "aria-disabled": busy ? "true" : "false",
      "aria-label": localeMessage(armed ? "restore_confirm_aria" : "restore_apply_aria"),
      onclick: async () => {
        if (busy) return;
        if (preview.requiresConfirmation && !armed) {
          armed = true;
          status.className = "note";
          status.textContent = localeMessage("restore_confirm_prompt");
          renderAction({ focus: true });
          armTimer = scheduleArm(resetArm, armTimeoutMs);
          return;
        }
        await commit();
      },
      onblur: () => { if (armed && !busy && !replacingAction) resetArm(); },
      onkeydown: (event) => {
        if (event.key === "Escape" && armed) { event.preventDefault(); resetArm(); }
      }
    }, localeMessage(busy
      ? "restore_restoring"
      : armed
        ? "restore_confirm"
        : preview.changed
          ? "restore_backup"
          : "restore_check_backup")),
    "restore-action");
    actionHost.append(button);
    if (focus) button.focus();
    else restoreRestoreFocus({
      document,
      snapshot: focusSnapshot,
      findIdentity: findFocusIdentity,
      fallback: button
    });
  }

  async function updatePreview() {
    if (!backupText) return;
    const generation = ++previewGeneration;
    completed = false;
    resetArm();
    status.className = "note";
    status.textContent = localeMessage("restore_checking_whole_backup");
    const loading = showLoadingFeedback(loadingHost, {
      label: localeMessage("restore_checking_backup")
    });
    try {
      // Mount the CSS-delayed controller before the synchronous parse. The
      // frame + task boundary lets an old, large file reveal Loading at 180ms,
      // while a fast file stops it before any visual or spoken flash.
      await yieldForRestoreValidation();
      const nextPreview = await restoreEffects.preview(backupText, {
        restoreSettings: restoreSettings.checked
      });
      if (generation !== previewGeneration) return;
      preview = nextPreview;
      status.textContent = preview.changed
        ? localeMessage("restore_ready_merge")
        : localeMessage("restore_current_options");
      renderPreview();
      renderAction();
    } catch (error) {
      if (generation !== previewGeneration) return;
      preview = null;
      previewHost.replaceChildren();
      actionHost.replaceChildren();
      status.className = "note bad";
      status.textContent = localeMessage("restore_failed", [
        error?.message ?? localeMessage("restore_unreadable")
      ]);
    } finally {
      loading.stop();
    }
  }

  restoreSettings.addEventListener("change", updatePreview);
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    fileName.textContent = file.name;
    source = { name: file.name, size: file.size, lastModified: file.lastModified };
    try {
      backupText = await restoreEffects.readFile(file);
      restoreSettings.checked = true;
      await updatePreview();
    } catch (error) {
      previewGeneration++;
      backupText = "";
      preview = null;
      status.className = "note bad";
      status.textContent = localeMessage("restore_failed", [
        error?.message ?? localeMessage("restore_unreadable")
      ]);
      previewHost.replaceChildren();
      actionHost.replaceChildren();
    }
  });

  void restoreEffects.readCheckpoint().then((checkpoint) => {
    if (!checkpoint) return;
    if (checkpoint.undoStatus !== "available") {
      priorHost.replaceChildren(
        el("div", { class: "note bad" },
          localeMessage("restore_prior_stale")),
        el("div", { class: "bulk-bar" }, recoveryButton(checkpoint.id))
      );
      return;
    }
    priorHost.replaceChildren(
      el("div", { class: "note" },
        localeMessage("restore_prior_available", [
          new Date(checkpoint.createdAt).toLocaleString()
        ])),
      el("div", { class: "bulk-bar" }, renderUndo(checkpoint.id, { prior: true }))
    );
  }).catch(() => {});

  return el("div", { class: "restore-panel" },
    el("div", { class: "bulk-bar" }, choose, fileName),
    input,
    status,
    loadingHost,
    previewHost,
    actionHost,
    priorHost,
    el("div", { class: "note" },
      localeMessage("restore_scope_note"))
  );
}

/**
 * @typedef {Object} RestorePanelEffects
 * @property {(file: {size?: number, text: () => Promise<string>}) => Promise<string>} readFile
 * @property {(text: string, options?: {restoreSettings?: boolean}) => Promise<import("../lib/types.js").PortableRestoreSummary>} preview
 * @property {(text: string, options?: import("../lib/types.js").PortableRestoreOptions) => Promise<import("../lib/types.js").PortableRestoreResult>} restore
 * @property {(checkpointId: string) => Promise<import("../lib/types.js").PortableRestoreUndoResult>} undo
 * @property {(checkpointId: string) => Promise<string|null>} checkpointExport
 * @property {() => Promise<import("../lib/types.js").PortableRestoreCheckpointSummary|null>} readCheckpoint
 */

/**
 * @typedef {Object} RestorePanelOptions
 * @property {(name: string, content: string, mime: string) => void} download
 * @property {(entry: import("../lib/types.js").JournalEntry) => void} [onJournal]
 * @property {() => void} [onChange]
 * @property {Partial<RestorePanelEffects>} [effects]
 * @property {number} [armTimeoutMs]
 * @property {(callback: () => void, delay: number) => unknown} [scheduleArm]
 * @property {(handle: unknown) => void} [cancelArm]
 */
