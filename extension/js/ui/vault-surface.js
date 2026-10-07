// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import {
  getVaultHandle, getVaultStatus, getVaultSyncMeta, pickVaultFolder, reconnectVault
} from "../vault/vault.js";
import { recordVaultSyncFailure, syncNow } from "../vault/sync.js";
import {
  confirmVaultRestore,
  listVaultRestorePointsWithReport,
  previewVaultRestorePoint,
  restoreVaultRestorePoint,
  undoVaultRestore
} from "../vault/restore.js";
import { VAULT_FAILURE_CODES, readQuarantine } from "../vault/failure-codes.js";
import { activeVaultStores } from "../lib/storage/authority-runtime.js";
import { formatNumber, msg, pluralCategory } from "../lib/i18n.js";
import { compactRelativeAge } from "../lib/relative-time.js";
import { coalesce, el } from "./dom.js";
import { shellSectionTitle } from "./shell-copy.js";
import {
  vaultFailureBanner, vaultLastSyncText, vaultPillState, vaultProgressText,
  vaultReconnectBanner, vaultRestoreChangesAction, vaultRestoreDeltaRows,
  vaultRestorePointLabel, vaultRestoreProgressText, vaultRestoreReadFailure,
  vaultRestoreRestoredFrom, vaultRestoreShowMoreAction, vaultRestoreStatic,
  vaultRestoreSummary, vaultStatic, vaultStatusBadge, vaultSyncAction, vaultSyncDidNotFinish,
  vaultSyncRestartFailure, vaultSyncStopped, vaultSyncFailureReason, vaultTargetLabel
} from "./vault-copy.js";
import {
  restartStalledVaultSync, runVaultSyncWithDeadline, VaultSyncTimeoutError
} from "./vault-sync-watchdog.js";

function isTimeoutFailure(meta) {
  return meta?.failureCode === "timeout" ||
    (meta?.ok === false && /timed out|stopped responding/i.test(String(meta.error ?? "")));
}

const VAULT_OWNER_PROBE_MS = 35_000;

/** Fatal failure families with a specific cause and action; see failure-codes.js. */
const FAILURE_COPY = Object.freeze({
  [VAULT_FAILURE_CODES.updateRequired]: {
    reason: "vault_failure_update_required_reason",
    guidance: "vault_failure_update_required_guidance"
  },
  [VAULT_FAILURE_CODES.placeholderFile]: {
    reason: "vault_failure_placeholder_reason",
    guidance: "vault_failure_placeholder_guidance"
  }
});

/** Skipped-file families reported on a completed sync or Restore listing. */
const QUARANTINE_COPY = Object.freeze({
  [`${VAULT_FAILURE_CODES.damagedBackup}:checkpoint`]: {
    one: "vault_quarantine_missing_checkpoint_one",
    other: "vault_quarantine_missing_checkpoint_other"
  },
  [VAULT_FAILURE_CODES.damagedBackup]: {
    one: "vault_quarantine_damaged_backup_one", other: "vault_quarantine_damaged_backup_other"
  },
  [VAULT_FAILURE_CODES.foreignManifestUnreadable]: {
    one: "vault_quarantine_foreign_manifest_one", other: "vault_quarantine_foreign_manifest_other"
  },
  [VAULT_FAILURE_CODES.placeholderFile]: {
    one: "vault_quarantine_placeholder_one", other: "vault_quarantine_placeholder_other"
  },
  [VAULT_FAILURE_CODES.conflictCopy]: {
    one: "vault_quarantine_conflict_copy_one", other: "vault_quarantine_conflict_copy_other"
  }
});

function codedFailureCopy(meta) {
  if (meta?.ok !== false || meta.busy) return null;
  const copy = FAILURE_COPY[meta.failureCode];
  return copy ? { reason: msg(copy.reason), guidance: msg(copy.guidance) } : null;
}

/** One short note per skipped-file family, counts only. */
export function quarantineNotes(entries) {
  return readQuarantine(entries).map(({ code, kind, count }) => {
    const keys = QUARANTINE_COPY[`${code}:${kind}`] ?? QUARANTINE_COPY[code];
    return msg(pluralCategory(count) === "one" ? keys.one : keys.other, [formatNumber(count)]);
  });
}

function joinRecordsText(count) {
  if (!Number.isSafeInteger(count)) return msg("vault_join_records_unknown");
  return msg(pluralCategory(count) === "one" ? "vault_join_records_one" : "vault_join_records_other",
    [formatNumber(count)]);
}

/**
 * Owns Vault status, sync scheduling, recovery, banner copy, and its settings
 * surface. The Dashboard sees only the rendered pill projection and four
 * lifecycle methods.
 */
export function createVaultSurface({
  getBody, setHeading, getBanner, onStateChange, showNotice, goToVault
}) {
  let syncTimer = 0;
  let syncing = false;
  let restarting = false;
  let following = false;
  let followStartedAt = 0;
  let rerunPending = false;
  let stalled = false;
  let stalledAt = 0;
  let stalledOwnerTabId = null;
  let progress = null;
  let progressTimer = 0;
  let syncStartedAt = 0;
  let syncButton = null;
  let bannerSyncButton = null;
  let syncDetail = null;
  let transientFailure = null;
  let lastSyncNoticeAt = 0;
  let restoreBusy = false;
  let restorePreview = null;
  let restoreSelectedName = "";
  let restoreMessage = "";
  let restoreMessageNode = null;
  let restoreFailed = false;
  let restoreDeltaExpanded = false;
  let restoreDeltaVisible = 50;
  let joinPrompt = null;
  let changeFolderButton = null;
  const render = coalesce(renderInner);

  /**
   * Ask before a different populated Vault replaces the retained folder. The
   * picked handle stays in memory inside pickVaultFolder until the answer; the
   * previous handle is untouched while the prompt is open.
   */
  function requestJoinConfirmation(details) {
    return new Promise((resolve) => {
      joinPrompt = { details, resolve };
      void render();
    });
  }

  function settleJoin(confirmed) {
    const pending = joinPrompt;
    if (!pending) return;
    joinPrompt = null;
    pending.resolve(confirmed);
    void render().then(() => changeFolderButton?.focus?.({ preventScroll: true }));
  }

  function buildJoinPrompt() {
    if (!joinPrompt) return null;
    const { details } = joinPrompt;
    const headingId = "vault-join-heading";
    const descriptionId = "vault-join-description";
    const cancel = el("button", {
      type: "button", class: "mini2", onclick: () => settleJoin(false)
    }, msg("action_cancel"));
    const confirm = el("button", {
      type: "button", class: "danger", onclick: () => settleJoin(true)
    }, msg("vault_join_confirm"));
    const group = el("section", {
      class: "vault-join",
      role: "group",
      tabindex: "-1",
      "aria-labelledby": headingId,
      "aria-describedby": descriptionId,
      onkeydown: (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settleJoin(false);
        }
      }
    },
    el("h3", { id: headingId }, msg("vault_join_heading")),
    el("p", { id: descriptionId, class: "note" }, msg("vault_join_description", [
      details.name, joinRecordsText(details.folderRecords), joinRecordsText(details.localRecords)
    ])),
    el("div", { class: "vault-row" }, cancel, confirm),
    el("p", { class: "note" }, msg("vault_join_cancel_hint")));
    // Focus the question itself, not an action, so a key press that closed the
    // folder picker cannot also confirm a merge no single device can undo.
    queueMicrotask(() => { if (group.isConnected) group.focus?.({ preventScroll: true }); });
    return group;
  }

  function reportRestoreProgress(next) {
    restoreMessage = vaultRestoreProgressText(next);
    if (restoreMessageNode?.isConnected) restoreMessageNode.textContent = restoreMessage;
  }

  function resetRestoreDelta() {
    restoreDeltaExpanded = false;
    restoreDeltaVisible = 50;
  }

  async function restoreContext() {
    const [root, replication] = await Promise.all([
      getVaultHandle(), activeVaultStores()
    ]);
    if (!root || !replication) throw new Error(vaultRestoreStatic.unavailable());
    return { root, library: replication.library };
  }

  async function reviewRestorePoint(name) {
    if (!name || restoreBusy) return;
    restoreBusy = true;
    restoreFailed = false;
    restorePreview = null;
    resetRestoreDelta();
    restoreMessage = vaultRestoreProgressText({ stage: "opening", target: "restorePoint" });
    await render();
    try {
      const { root, library } = await restoreContext();
      restorePreview = await previewVaultRestorePoint(root, {
        library,
        name,
        onProgress: reportRestoreProgress
      });
      restoreSelectedName = name;
      restoreMessage = restorePreview.summary.changed
        ? vaultRestoreStatic.reviewChanges()
        : vaultRestoreStatic.alreadyMatches();
    } catch (error) {
      restorePreview = null;
      restoreFailed = true;
      restoreMessage = error?.message ?? String(error);
    } finally {
      restoreBusy = false;
      await render();
    }
  }

  async function applyRestorePoint() {
    if (!restorePreview || restoreBusy) return;
    restoreBusy = true;
    restoreFailed = false;
    restoreMessage = vaultRestoreStatic.replacing();
    await render();
    try {
      const { root, library } = await restoreContext();
      const result = await restoreVaultRestorePoint(root, {
        library,
        preview: restorePreview,
        onProgress: reportRestoreProgress
      });
      restorePreview = null;
      resetRestoreDelta();
      restoreMessage = result.status === "no-op"
        ? vaultRestoreStatic.alreadyMatches()
        : vaultRestoreStatic.restoredReview();
      if (result.status === "restored") onStateChange();
    } catch (error) {
      restoreFailed = true;
      restoreMessage = error?.message ?? String(error);
    } finally {
      restoreBusy = false;
      await render();
    }
  }

  async function settleRestore(undo) {
    if (restoreBusy) return;
    restoreBusy = true;
    restoreFailed = false;
    restoreMessage = undo ? vaultRestoreStatic.undoing() : vaultRestoreStatic.keeping();
    await render();
    try {
      const { library } = await restoreContext();
      const pending = await library.readPendingRestore();
      if (!pending) throw new Error(vaultRestoreStatic.safetyUnavailable());
      if (undo) {
        await undoVaultRestore({ library, restoreId: pending.id });
        restoreMessage = vaultRestoreStatic.undone();
        onStateChange();
      } else {
        await confirmVaultRestore({ library, restoreId: pending.id });
        restoreMessage = vaultRestoreStatic.kept();
      }
    } catch (error) {
      restoreFailed = true;
      restoreMessage = error?.message ?? String(error);
    } finally {
      restoreBusy = false;
      await render();
    }
  }

  async function buildRestoreSurface(status) {
    if (status.state !== "connected") return null;
    restoreMessageNode = null;
    const section = el("section", { class: "vault-restore" },
      el("h3", {}, vaultRestoreStatic.heading()),
      el("p", { class: "note" }, vaultRestoreStatic.description()));
    try {
      const { root, library } = await restoreContext();
      const pending = await library.readPendingRestore();
      if (pending) {
        const source = pending.source?.day
          ? vaultRestorePointLabel(pending.source.day)
          : vaultTargetLabel("vault");
        restoreMessageNode = el("div", { class: restoreFailed ? "note bad" : "note good" },
          restoreMessage || vaultRestoreRestoredFrom(source));
        section.append(
          restoreMessageNode,
          el("div", { class: "vault-row" },
            el("button", {
              type: "button",
              onclick: () => settleRestore(false),
              disabled: restoreBusy
            }, restoreBusy ? vaultRestoreStatic.working() : vaultRestoreStatic.keep()),
            el("button", {
              type: "button",
              onclick: () => settleRestore(true),
              disabled: restoreBusy
            }, vaultRestoreStatic.undo()))
        );
        return section;
      }

      const { points, skipped } = await listVaultRestorePointsWithReport(root);
      // A damaged or still-arriving point is named by count and reason; the
      // usable points stay selectable instead of the whole list failing.
      const skippedNotes = quarantineNotes(skipped)
        .map((note) => el("div", { class: "note bad vault-restore-skipped" }, note));
      if (points.length === 0) {
        section.append(el("div", { class: "note" },
          vaultRestoreStatic.noPoints()), ...skippedNotes);
        return section;
      }
      section.append(...skippedNotes);
      if (!points.some(({ name }) => name === restoreSelectedName)) {
        restoreSelectedName = points[0].name;
        restorePreview = null;
      }
      const select = el("select", {
        "aria-label": vaultRestoreStatic.selectAria(),
        disabled: restoreBusy,
        onchange: (event) => {
          restoreSelectedName = event.currentTarget.value;
          restorePreview = null;
          resetRestoreDelta();
          restoreMessage = "";
          restoreFailed = false;
          void render();
        }
      }, ...points.map((point) => el("option", {
        value: point.name,
        selected: point.name === restoreSelectedName
      }, vaultRestorePointLabel(point.day))));
      section.append(el("div", { class: "vault-row" },
        select,
        el("button", {
          type: "button",
          onclick: () => reviewRestorePoint(restoreSelectedName),
          disabled: restoreBusy
        }, restoreBusy ? vaultRestoreStatic.checking() : vaultRestoreStatic.reviewPoint())));
      if (restorePreview) {
        const changes = restorePreview.summary.changes ?? [];
        const delta = vaultRestoreDeltaRows({
          changes,
          limit: restoreDeltaVisible
        });
        section.append(
          el("div", { class: "note vault-restore-summary" },
            vaultRestoreSummary(restorePreview.summary)));
        if (changes.length > 0) {
          section.append(el("div", { class: "vault-restore-review" },
            el("button", {
              type: "button",
              onclick: () => {
                restoreDeltaExpanded = !restoreDeltaExpanded;
                void render();
              }
            }, vaultRestoreChangesAction(changes.length, restoreDeltaExpanded)),
            restoreDeltaExpanded
              ? el("div", { class: "vault-restore-delta" },
                el("ul", { class: "vault-restore-delta-list" },
                  ...delta.rows.map((row) => el("li", {}, row))),
                delta.remaining > 0
                  ? el("div", { class: "vault-restore-delta-more" },
                    el("span", {}, delta.remainingText),
                    el("button", {
                      type: "button",
                      onclick: () => {
                        restoreDeltaVisible += Math.min(50, delta.remaining);
                        void render();
                      }
                    }, vaultRestoreShowMoreAction(Math.min(50, delta.remaining))))
                  : null)
              : null));
        }
        section.append(
          restorePreview.summary.changed
            ? el("div", { class: "vault-row" }, el("button", {
              type: "button",
              class: "danger",
              onclick: applyRestorePoint,
              disabled: restoreBusy
            }, vaultRestoreStatic.replace()))
            : null
        );
      }
      if (restoreMessage) {
        restoreMessageNode = el("div", {
          class: restoreFailed ? "note bad" : "note"
        }, restoreMessage);
        section.append(restoreMessageNode);
      }
    } catch (error) {
      section.append(el("div", { class: "note bad" },
        vaultRestoreReadFailure(error?.message ?? String(error))));
    }
    return section;
  }

  async function currentMeta() {
    if (syncing) return { ok: true, busy: true, local: true, progress };
    if (transientFailure) return transientFailure;
    const meta = await getVaultSyncMeta();
    if (following) {
      if (meta?.lastSyncAt > followStartedAt) {
        following = false;
        followStartedAt = 0;
        stopProgressClock();
      } else {
        return { ...(meta ?? {}), ok: true, busy: true, local: false };
      }
    }
    if (stalled && meta?.ok && meta.lastSyncAt > stalledAt) {
      stalled = false;
      stalledAt = 0;
      stalledOwnerTabId = null;
    }
    if (!stalled && isTimeoutFailure(meta)) {
      stalled = true;
      stalledAt = meta.lastSyncAt ?? 0;
      stalledOwnerTabId = Number.isInteger(meta.ownerTabId) ? meta.ownerTabId : null;
    }
    return meta;
  }

  function updateSyncButton() {
    if (syncButton) {
      syncButton.disabled = syncing || following || restarting;
      syncButton.textContent = vaultSyncAction({
        restarting, busy: syncing || following, stalled
      });
    }
    if (bannerSyncButton) {
      bannerSyncButton.disabled = restarting;
      bannerSyncButton.textContent = restarting ? vaultStatic.restarting()
        : stalled ? vaultStatic.restartSync() : vaultStatic.tryAgain();
    }
  }

  function progressElapsedMs() {
    return syncStartedAt ? Math.max(0, Date.now() - syncStartedAt) : 0;
  }

  function updateProgressDetail() {
    const nextText = vaultProgressText(progress, following, progressElapsedMs());
    if (syncDetail && syncDetail.textContent !== nextText) syncDetail.textContent = nextText;
  }

  function stopProgressClock() {
    clearInterval(progressTimer);
    progressTimer = 0;
    syncStartedAt = 0;
  }

  function startProgressClock(startedAt) {
    clearInterval(progressTimer);
    syncStartedAt = startedAt;
    progressTimer = setInterval(updateProgressDetail, 1_000);
  }

  async function pillState() {
    const [status, meta] = await Promise.all([getVaultStatus(), currentMeta()]);
    return { ...vaultPillState(status, meta, syncing || following || restarting), status };
  }

  function schedule() {
    if (stalled) return;
    clearTimeout(syncTimer);
    if (following) {
      rerunPending = true;
      scheduleFollowingCheck();
      return;
    }
    syncTimer = setTimeout(run, 3000);
  }

  function scheduleFollowingCheck() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(checkFollowingSync, 1000);
  }

  async function checkFollowingSync() {
    if (!following) return;
    const meta = await getVaultSyncMeta();
    if (meta?.lastSyncAt > followStartedAt) {
      following = false;
      followStartedAt = 0;
      stopProgressClock();
      await render();
      onStateChange();
      if (rerunPending) {
        rerunPending = false;
        schedule();
      }
      return;
    }
    // If an owning page disappears before publishing a final receipt, probe
    // the Web Lock again. A healthy owner simply wins again and this page keeps
    // following; a dead owner has released the lock and this page takes over.
    if (Date.now() - followStartedAt >= VAULT_OWNER_PROBE_MS) {
      following = false;
      followStartedAt = 0;
      void run();
      return;
    }
    scheduleFollowingCheck();
  }

  async function currentTabId() {
    try {
      const tab = await chrome.tabs?.getCurrent?.();
      return Number.isInteger(tab?.id) ? tab.id : null;
    } catch {
      return null;
    }
  }

  async function requestSync() {
    if (restarting) return;
    if (stalled) {
      restarting = true;
      updateSyncButton();
      // Recovery must not re-enter folder-backed presentation before releasing
      // its stalled owner. Both mounted controls provide feedback locally.
      const ownerTabId = stalledOwnerTabId;
      const thisTabId = await currentTabId();
      try {
        const restarted = await restartStalledVaultSync({ tabId: ownerTabId });
        if (restarted === "owner-tab" && ownerTabId !== thisTabId) {
          stalled = false;
          stalledAt = 0;
          stalledOwnerTabId = null;
          transientFailure = null;
          restarting = false;
          void run();
          updateSyncButton();
        }
      } catch {
        restarting = false;
        const message = vaultSyncRestartFailure(vaultStatic.unknownError());
        transientFailure = { lastSyncAt: Date.now(), ok: false, error: message };
        // A failed reload leaves the same stalled folder behind. Keep retry
        // available without another status read or exposing browser error text.
        updateSyncButton();
        if (syncDetail) syncDetail.textContent = message;
        showNotice(message);
      }
      return;
    }
    void run();
  }

  async function chooseFolder() {
    if (joinPrompt) return;
    try {
      const next = await pickVaultFolder({ confirmJoin: requestJoinConfirmation });
      if (next.state === "cancelled") return;
      if (next.state === "rejected") {
        showNotice(next.reason === "placeholder"
          ? msg("vault_folder_placeholder_guidance")
          : vaultStatic.folderSelectionGuidance());
        return;
      }
      transientFailure = null;
      await run();
    } catch {
      // Failed selection leaves the prior folder and its sync receipt intact.
      joinPrompt = null;
      showNotice(vaultRestoreStatic.unavailable(), goToVault, vaultStatic.details());
    }
  }

  async function reconnect() {
    try {
      const next = await reconnectVault();
      if (next.state === "connected") await run();
      else await render();
    } catch {
      // Reconnecting can fail before sync starts, including while reading the
      // retained handle. Keep that handle and its retry controls available.
      showNotice(vaultRestoreStatic.unavailable(), goToVault, vaultStatic.details());
    }
  }

  async function run() {
    if (syncing || following) {
      rerunPending = true;
      return;
    }
    const attemptStartedAt = Date.now();
    stalled = false;
    stalledAt = 0;
    stalledOwnerTabId = null;
    syncing = true;
    progress = { stage: "connecting", target: "" };
    startProgressClock(attemptStartedAt);
    await render();
    onStateChange();
    const attemptOwnerTabId = await currentTabId();
    try {
      const outcome = await runVaultSyncWithDeadline({
        sync: (heartbeat) => syncNow({ onProgress: heartbeat }),
        onProgress: (nextProgress) => {
          progress = nextProgress;
          const nextText = vaultProgressText(progress, false, progressElapsedMs());
          if (syncDetail && syncDetail.textContent !== nextText) {
            syncDetail.textContent = nextText;
          }
        }
      });
      if (outcome?.report?.skipped) {
        following = true;
        followStartedAt = attemptStartedAt;
      } else {
        transientFailure = null;
      }
    } catch (error) {
      const message = error instanceof VaultSyncTimeoutError
        ? vaultSyncStopped(progress?.target)
        : vaultSyncDidNotFinish(error);
      stalled = error instanceof VaultSyncTimeoutError;
      stalledAt = Date.now();
      transientFailure = {
        lastSyncAt: stalledAt,
        ok: false,
        error: message,
        ...(stalled ? { failureCode: "timeout" } : {}),
        ...(stalled && Number.isInteger(attemptOwnerTabId)
          ? { ownerTabId: attemptOwnerTabId }
          : {})
      };
      const failure = transientFailure;
      void recordVaultSyncFailure(
        error,
        failure.lastSyncAt,
        failure.failureCode ?? null,
        failure.ownerTabId ?? null
      ).then(() => {
        if (transientFailure === failure) transientFailure = null;
      }).catch((writeError) => {
        reportFailure("Vault timeout status save", writeError);
      });
    } finally {
      syncing = false;
      progress = null;
      if (!following) stopProgressClock();
      updateSyncButton();
    }
    if (following) scheduleFollowingCheck();
    else if (rerunPending) {
      rerunPending = false;
      schedule();
    }
    await render();
    onStateChange();
    const meta = await currentMeta();
    if (!meta?.busy && meta?.ok === false && meta.lastSyncAt && meta.lastSyncAt > lastSyncNoticeAt) {
      lastSyncNoticeAt = meta.lastSyncAt;
      showNotice(
        vaultStatic.failureNotice(),
        goToVault,
        vaultStatic.details()
      );
    }
  }

  function renderBanner(status, meta) {
    const banner = getBanner();
    bannerSyncButton = null;
    if (status.state === "needs-permission") {
      banner.classList.remove("hidden");
      banner.replaceChildren(
        el("span", {}, vaultReconnectBanner(status.name)),
        el("button", { onclick: reconnect }, vaultStatic.reconnectVault())
      );
      return;
    }
    if (status.state === "connected" && meta?.busy) {
      banner.classList.add("hidden");
      banner.replaceChildren();
      return;
    }
    const failed = status.state === "error" ||
      (status.state === "connected" && meta?.ok === false);
    if (failed) {
      const reason = status.state === "error"
        ? status.errorClass != null ? vaultSyncFailureReason(status) : status.message
        : codedFailureCopy(meta)?.reason ?? vaultSyncFailureReason(meta);
      const why = String(reason ?? "")
        .replace(/[.\s]+$/, "");
      banner.classList.remove("hidden");
      banner.replaceChildren(
        el("span", {}, vaultFailureBanner(why)),
        bannerSyncButton = el("button", {
          onclick: requestSync,
          disabled: restarting
        }, restarting
          ? vaultStatic.restarting()
          : stalled ? vaultStatic.restartSync() : vaultStatic.tryAgain()),
        el("button", { class: "mini2", onclick: goToVault }, vaultStatic.details())
      );
      return;
    }
    banner.classList.add("hidden");
    banner.replaceChildren();
  }

  async function renderInner() {
    const [status, meta] = await Promise.all([getVaultStatus(), currentMeta()]);
    renderBanner(status, meta);
    setHeading(shellSectionTitle("vault"));

    const badgeState = vaultStatusBadge(status, meta);
    const badge = el("span", { class: badgeState.cls }, badgeState.text);

    const timeoutFailure = isTimeoutFailure(meta);
    const coded = codedFailureCopy(meta);
    const lastSync = coded
      ? msg("vault_sync_attempt_failed", [
        compactRelativeAge(meta.lastSyncAt), coded.reason.replace(/[.\s]+$/, ""), coded.guidance
      ])
      : vaultLastSyncText(meta, progress, { timeoutFailure, elapsedMs: progressElapsedMs() });
    const skippedNotes = meta?.ok && !meta.busy
      ? quarantineNotes(meta.quarantined).map((note) =>
        el("div", { class: "note vault-sync-skipped" }, note))
      : [];

    changeFolderButton = el("button", { onclick: chooseFolder, disabled: Boolean(joinPrompt) },
      status.state === "unset" ? vaultStatic.connectFolder() : vaultStatic.changeFolder());
    const actions = el("div", { class: "vault-row" }, changeFolderButton);
    if (status.state === "needs-permission") {
      actions.append(el("button", { onclick: reconnect }, vaultStatic.reconnect()));
    }
    if (status.state === "connected") {
      syncButton = el("button", {
        onclick: requestSync,
        disabled: syncing || following || restarting
      }, vaultSyncAction({ restarting, busy: syncing || following, stalled }));
      actions.append(syncButton);
    }

    syncDetail = el("div", {
      class: meta && !meta.ok && !meta.busy
        ? "note bad vault-sync-details"
        : "note vault-sync-details",
      id: "vault-sync-details",
      tabindex: "-1"
    }, lastSync);

    const restoreSurface = await buildRestoreSurface(status);
    getBody().replaceChildren(
      el("div", {}, badge),
      actions,
      buildJoinPrompt(),
      syncDetail,
      ...skippedNotes,
      el("div", { class: "note" }, vaultStatic.description()),
      el("div", { class: "note" }, msg("vault_sync_requires_open_page")),
      restoreSurface
    );
  }

  return {
    render,
    pillState,
    start: () => { void run(); },
    schedule
  };
}
