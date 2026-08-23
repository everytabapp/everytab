import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createLabelInput } from "./labelinput.js";
import { createCombobox } from "./combobox.js";
import { createAnchoredPanel } from "./tablist.js";
import { formatList, formatNumber, msg as localeMessage } from "../lib/i18n.js";
import {
  CLOSE_DAY_ACTIONS, applyCloseDayChoice, applyCloseDayChoices
} from "../lib/close-day-planner.js";

const ACTION_LABELS = {
  [CLOSE_DAY_ACTIONS.close]: localeMessage("close_day_action_close_saved"),
  [CLOSE_DAY_ACTIONS.inbox]: localeMessage("close_day_action_inbox"),
  [CLOSE_DAY_ACTIONS.addSession]: localeMessage("close_day_action_add_current_session"),
  [CLOSE_DAY_ACTIONS.session]: localeMessage("close_day_action_choose_session"),
  [CLOSE_DAY_ACTIONS.newSession]: localeMessage("close_day_action_new_session"),
  [CLOSE_DAY_ACTIONS.archiveLabel]: localeMessage("close_day_action_archive_label"),
  [CLOSE_DAY_ACTIONS.stay]: localeMessage("close_day_action_stay"),
  [CLOSE_DAY_ACTIONS.unfiled]: localeMessage("close_day_action_unfiled")
};

const ACTION_ICONS = {
  [CLOSE_DAY_ACTIONS.close]: "saved",
  [CLOSE_DAY_ACTIONS.inbox]: "inbox",
  [CLOSE_DAY_ACTIONS.addSession]: "sessions",
  [CLOSE_DAY_ACTIONS.session]: "switch",
  [CLOSE_DAY_ACTIONS.newSession]: "add",
  [CLOSE_DAY_ACTIONS.archiveLabel]: "labels",
  [CLOSE_DAY_ACTIONS.stay]: "eye",
  [CLOSE_DAY_ACTIONS.unfiled]: "close"
};

const clean = (value) => String(value ?? "").trim();

function quotedList(values) {
  const quoted = [...new Set(values.map(clean).filter(Boolean))]
    .map((value) => `“${value}”`);
  return formatList(quoted);
}

function actionLabel(row, action, sessions = []) {
  if (action === CLOSE_DAY_ACTIONS.addSession) {
    const targetId = clean(row?.choice?.targetSessionId || row?.boundSessionId);
    const target = sessions.find((session) => session.id === targetId);
    return target?.name
      ? localeMessage("close_day_add_named_session", [target.name])
      : ACTION_LABELS[action];
  }
  if (action === CLOSE_DAY_ACTIONS.session && row?.choice?.action === action) {
    const target = sessions.find((session) => session.id === clean(row.choice.targetSessionId));
    if (target?.name) return localeMessage("close_day_add_named_session", [target.name]);
  }
  if (action === CLOSE_DAY_ACTIONS.newSession && row?.choice?.action === action) {
    const name = clean(row.choice.newSessionName);
    if (name) return localeMessage("close_day_create_named_session", [name]);
  }
  if (action === CLOSE_DAY_ACTIONS.archiveLabel && row?.choice?.action === action) {
    const selectedLabels = [...new Set((Array.isArray(row.choice.labels)
      ? row.choice.labels
      : [row.choice.label]).map(clean).filter(Boolean))];
    const labels = quotedList(selectedLabels);
    if (labels) {
      return localeMessage(selectedLabels.length > 1
        ? "close_day_add_labels_named"
        : "close_day_add_label_named", [labels]);
    }
  }
  if (action !== CLOSE_DAY_ACTIONS.close) {
    return ACTION_LABELS[action] ?? localeMessage("close_day_choose_action");
  }
  if (["bound-session", "session"].includes(row?.coverage?.kind)) {
    const name = clean(row.coverage.name) || localeMessage("close_day_named_session");
    return localeMessage("close_day_saved_session", [name]);
  }
  if (row?.coverage?.kind === "inbox") return localeMessage("close_day_saved_inbox");
  if (row?.coverage?.kind === "archive") {
    const labels = (row.coverage.labels ?? []).map(clean).filter(Boolean);
    return labels.length
      ? localeMessage("close_day_saved_labels")
      : localeMessage("close_day_saved_archive");
  }
  return ACTION_LABELS[CLOSE_DAY_ACTIONS.close];
}

/**
 * Full-page P11-15 review. It edits only the coordinator's operational draft;
 * all portable writes and live tab effects stay behind one background message.
 */
export function createCloseDaySurface({
  msg, rerender, showNotice, onNavigate, onLeave, decisionTimeoutMs = 4_000
}) {
  let draftId = null;
  let plan = null;
  let completion = null;
  let stale = false;
  let loading = false;
  let committing = false;
  let commitArmed = false;
  let commitTimer = 0;
  let replaceArmed = null;
  let replaceTimer = 0;
  let replaceSaving = null;
  let freshnessTimer = 0;
  let freshnessGeneration = 0;
  let choiceWriteSequence = 0;
  let choiceWriteQueue = Promise.resolve();
  let choiceWriteFailed = false;
  let initialized = false;
  let stageScrollFrame = 0;
  const pendingChoiceWrites = new Map();
  const selectedRows = new Set();
  const pickerPanel = createAnchoredPanel(document.body);

  function syncStageNavigation(preferredId = "") {
    const links = [...document.querySelectorAll(".close-day-stage-link")];
    const stages = [...document.querySelectorAll("[data-close-day-stage]")];
    if (!links.length || !stages.length) return;
    let activeId = preferredId;
    if (!activeId) {
      const summaryBottom = document.querySelector(".close-day-summary")
        ?.getBoundingClientRect().bottom ?? 0;
      activeId = stages[0].dataset.closeDayStage;
      for (const stage of stages) {
        if (stage.getBoundingClientRect().top <= summaryBottom + 16) {
          activeId = stage.dataset.closeDayStage;
        } else break;
      }
    }
    for (const link of links) {
      const active = link.dataset.stageTarget === activeId;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  function scheduleStageNavigationSync() {
    if (stageScrollFrame) return;
    stageScrollFrame = requestAnimationFrame(() => {
      stageScrollFrame = 0;
      syncStageNavigation();
    });
  }

  function goToStage(stageId) {
    const target = document.querySelector(`[data-close-day-stage="${stageId}"]`);
    const summary = document.querySelector(".close-day-summary");
    if (!target || !summary) return;
    syncStageNavigation(stageId);
    const top = window.scrollY + target.getBoundingClientRect().top -
      summary.getBoundingClientRect().bottom - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    requestAnimationFrame(() => syncStageNavigation(stageId));
  }

  window.addEventListener("scroll", scheduleStageNavigationSync, { passive: true });

  function clearArms() {
    clearTimeout(commitTimer);
    clearTimeout(replaceTimer);
    commitTimer = 0;
    replaceTimer = 0;
    commitArmed = false;
    replaceArmed = null;
  }

  async function focusAfterRender(find) {
    await Promise.resolve(rerender());
    if (typeof find === "function") requestAnimationFrame(() => find()?.focus?.({ preventScroll: true }));
  }

  function currentFocusResolver() {
    const active = document.activeElement;
    if (!active?.closest?.(".close-day-review")) return null;
    const row = active.closest("[data-close-day-row]");
    const rowKey = row?.dataset.closeDayRow;
    if (rowKey) {
      if (active.dataset.action) {
        const action = active.dataset.action;
        return () => {
          const targetRow = [...document.querySelectorAll("[data-close-day-row]")]
            .find((node) => node.dataset.closeDayRow === rowKey);
          return [...(targetRow?.querySelectorAll(".close-day-action-option") ?? [])]
            .find((node) => node.dataset.action === action);
        };
      }
      if (active.matches(".close-day-row-select")) return () => [...document.querySelectorAll("[data-row-select]")]
        .find((node) => node.dataset.rowSelect === rowKey);
    }
    const cardKey = active.closest("[data-close-day-card]")?.dataset.closeDayCard;
    if (!cardKey) return null;
    if (active.matches(".close-day-window-select")) {
      return () => cardNode(cardKey)?.querySelector(".close-day-window-select");
    }
    if (active.matches(".close-day-bulk-action")) {
      const action = active.dataset.action;
      return () => [...(cardNode(cardKey)?.querySelectorAll(".close-day-bulk-action") ?? [])]
        .find((node) => node.dataset.action === action);
    }
    return null;
  }

  async function rerenderPreservingCurrentFocus() {
    const find = currentFocusResolver();
    await Promise.resolve(rerender());
    if (find) requestAnimationFrame(() => find()?.focus?.({ preventScroll: true }));
  }

  function rowChoice(fingerprintKey) {
    return [...document.querySelectorAll("[data-close-day-row]")]
      .find((node) => node.dataset.closeDayRow === fingerprintKey)
      ?.querySelector('.close-day-action-option[aria-checked="true"]');
  }

  function windowReplace(windowId) {
    return [...document.querySelectorAll("[data-close-day-window]")]
      .find((node) => Number(node.dataset.closeDayWindow) === Number(windowId))
      ?.querySelector(".close-day-replace, .close-day-replace-confirm .danger, .close-day-replace-state button");
  }

  async function load({ startOver = false } = {}) {
    clearTimeout(freshnessTimer);
    freshnessGeneration += 1;
    loading = true;
    rerender();
    const response = await msg({ type: "close-day-capture", refresh: startOver });
    loading = false;
    if (!response?.ok) {
      showNotice(localeMessage("close_day_prepare_failed"));
      rerender();
      return false;
    }
    draftId = response.draftId;
    plan = response.plan;
    completion = null;
    stale = false;
    pendingChoiceWrites.clear();
    selectedRows.clear();
    pickerPanel.close();
    choiceWriteFailed = false;
    clearArms();
    rerender();
    return true;
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    loading = true;
    rerender();
    const status = await msg({ type: "close-day-status" });
    if (status?.pending?.id) {
      const resumed = await msg({ type: "close-day-resume", transactionId: status.pending.id });
      if (resumed?.ok) completion = resumed.receipt;
    } else if (status?.draft?.plan) {
      // Drafts are operational and deliberately survive reloads. v0.8.327
      // drafts predate the shared picker catalogue, so rebuild them once from
      // current inputs while preserving their validated choices and identity.
      if (!Array.isArray(status.draft.plan.labels)) {
        const upgraded = await msg({ type: "close-day-capture", refresh: false });
        if (upgraded?.ok) {
          draftId = upgraded.draftId;
          plan = upgraded.plan;
        } else {
          draftId = status.draft.id;
          plan = status.draft.plan;
        }
      } else {
        draftId = status.draft.id;
        plan = status.draft.plan;
      }
    } else if (status?.latest && ["complete", "undone"].includes(status.latest.phase) &&
      Date.now() - Number(status.latest.updatedAt ?? 0) < 10 * 60_000) {
      completion = status.latest;
    }
    loading = false;
    if (!plan && !completion) await load();
    else rerender();
  }

  async function render() {
    if (!initialized) await initialize();
    return build();
  }

  async function checkFreshness() {
    if (!plan || completion || committing || stale) return !stale;
    const generation = ++freshnessGeneration;
    const checkedDraftId = draftId;
    const response = await msg({ type: "close-day-check", draftId: checkedDraftId });
    if (generation !== freshnessGeneration || checkedDraftId !== draftId || !plan || completion) return true;
    if (response?.ok && !response.fresh) {
      stale = true;
      clearArms();
      rerender();
      return false;
    }
    return true;
  }

  function checkFreshnessSoon() {
    if (!plan || completion || committing || stale) return;
    clearTimeout(freshnessTimer);
    freshnessTimer = setTimeout(() => void checkFreshness(), 90);
  }

  function reapplyPendingChoices() {
    for (const pending of pendingChoiceWrites.values()) {
      const apply = pending.bulk ? applyCloseDayChoices : applyCloseDayChoice;
      if (pending.bulk) apply(plan, pending.fingerprintKeys, pending.patch);
      else apply(plan, pending.fingerprintKeys[0], pending.patch);
    }
  }

  function saveChoices(fingerprintKeys, patch, { bulk = false, focus = null } = {}) {
    if (!plan || stale || choiceWriteFailed) return false;
    const keys = [...new Set(fingerprintKeys)].filter(Boolean);
    const applied = bulk
      ? applyCloseDayChoices(plan, keys, patch)
      : applyCloseDayChoice(plan, keys[0], patch);
    if (!applied) return false;

    const token = ++choiceWriteSequence;
    pendingChoiceWrites.set(token, { bulk, fingerprintKeys: keys, patch: { ...patch } });
    clearArms();
    void focusAfterRender(focus ?? (() => rowChoice(keys[0])));

    choiceWriteQueue = choiceWriteQueue.then(async () => {
      if (choiceWriteFailed || !pendingChoiceWrites.has(token)) return false;
      const response = await msg(bulk ? {
        type: "close-day-bulk-choice", draftId, fingerprintKeys: keys, patch
      } : {
        type: "close-day-choice", draftId, fingerprintKey: keys[0], patch
      });
      if (!response?.ok) {
        choiceWriteFailed = true;
        pendingChoiceWrites.clear();
        showNotice(localeMessage("close_day_choice_failed"));
        stale = true;
        rerender();
        return false;
      }
      plan = response.plan;
      pendingChoiceWrites.delete(token);
      reapplyPendingChoices();
      await rerenderPreservingCurrentFocus();
      return true;
    });
    return true;
  }

  function updateChoice(row, patch) {
    return saveChoices([row.fingerprintKey], patch);
  }

  async function setWindowMode(group, mode) {
    if (replaceSaving === group.windowId) return;
    replaceSaving = group.windowId;
    rerender();
    const response = await msg({
      type: "close-day-window-mode", draftId, windowId: group.windowId, mode
    });
    replaceSaving = null;
    if (!response?.ok) {
      showNotice(localeMessage("close_day_session_changed"));
      stale = true;
      rerender();
      return;
    }
    plan = response.plan;
    clearTimeout(replaceTimer);
    replaceTimer = 0;
    replaceArmed = null;
    showNotice(mode === "replace"
      ? localeMessage("close_day_arrangement_replace_notice")
      : localeMessage("close_day_arrangement_keep_notice"));
    await focusAfterRender(() => windowReplace(group.windowId));
  }

  function armReplace(group) {
    if (group.session.mode === "replace") {
      void setWindowMode(group, "keep");
      return;
    }
    if (replaceArmed === group.windowId) {
      void setWindowMode(group, "replace");
      return;
    }
    clearTimeout(replaceTimer);
    replaceArmed = group.windowId;
    replaceTimer = setTimeout(() => {
      replaceArmed = null;
      void focusAfterRender(() => windowReplace(group.windowId));
    }, decisionTimeoutMs);
    void focusAfterRender(() => windowReplace(group.windowId));
  }

  function rowActions(row) {
    return row.availableActions
      .filter((action) => action !== CLOSE_DAY_ACTIONS.newSession);
  }

  function labelPicker(anchor, ariaLabel, applyLabels) {
    pickerPanel.anchor(anchor);
    pickerPanel.toggle(() => {
      let picker;
      const apply = el("button", { class: "mini primary palette-commit", type: "button",
        onclick: () => {
          const labels = picker.getLabels();
          if (!labels.length) return;
          pickerPanel.close();
          applyLabels(labels);
        }
      }, localeMessage("close_day_apply_labels"));
      picker = createLabelInput({
        placeholder: localeMessage("close_day_labels_placeholder"), ariaLabel,
        loadOptions: () => plan.labels ?? [],
        onSubmit: () => apply.click(), onCancel: () => pickerPanel.close()
      });
      return el("div", { class: "row-labelbar palette-form close-day-picker-form" },
        el("div", { class: "palette-field palette-label-field" },
          el("span", { class: "palette-field-label" }, localeMessage("close_day_add_labels")), picker.element,
          el("span", { class: "palette-help" }, localeMessage("close_day_label_input_help"))), apply);
    }, "label");
  }

  function sessionPicker(anchor, ariaLabel, sessions, applySession) {
    pickerPanel.anchor(anchor);
    pickerPanel.toggle(() => {
      const picker = createCombobox({
        ariaLabel, placeholder: localeMessage("close_day_session_placeholder"),
        loadOptions: async () => sessions.map((session) => ({ id: session.id, name: session.name })),
        createLabel: (value) => localeMessage("close_day_new_session_named", [value]),
        onCommit: (value) => {
          pickerPanel.close();
          applySession(value);
        },
        onCancel: () => pickerPanel.close()
      });
      return el("div", { class: "palette-form close-day-picker-form" },
        el("label", { class: "palette-field" },
          el("span", { class: "palette-field-label" }, localeMessage("close_day_choose_or_create_session")),
          picker.element,
          el("span", { class: "palette-help" }, localeMessage("close_day_session_input_help"))));
    }, "session");
  }

  function chooseAction(row, action, anchor) {
    if (action === CLOSE_DAY_ACTIONS.archiveLabel) {
      labelPicker(anchor, localeMessage("close_day_labels_for", [row.title]), (labels) => {
        void updateChoice(row, { action, labels });
      });
      return;
    }
    if ([CLOSE_DAY_ACTIONS.session, CLOSE_DAY_ACTIONS.newSession].includes(action)) {
      const sessions = (plan.sessions ?? []).filter((session) => session.id !== row.boundSessionId);
      sessionPicker(anchor, localeMessage("close_day_session_for", [row.title]), sessions, (value) => {
        if (value.isNew) void updateChoice(row, {
          action: CLOSE_DAY_ACTIONS.newSession, newSessionName: value.name
        });
        else void updateChoice(row, {
          action: CLOSE_DAY_ACTIONS.session, targetSessionId: value.id
        });
      });
      return;
    }
    void updateChoice(row, { action });
  }

  function moveActionFocus(event) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
      return false;
    }
    const scope = event.currentTarget.closest(".close-day-action-set, .close-day-bulk-actions");
    const buttons = [...scope.querySelectorAll(".close-day-action-option")];
    const index = buttons.indexOf(event.currentTarget);
    const forward = event.key === "ArrowRight";
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : index + (forward ? 1 : -1);
    if (next < 0 && event.currentTarget.closest(".close-day-action-set")) return false;
    event.preventDefault();
    if (next < 0 || next >= buttons.length) return true;
    buttons[next]?.focus({ preventScroll: true });
    return true;
  }

  function actionKeydown(event, row, action) {
    if (moveActionFocus(event)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseAction(row, action, event.currentTarget);
    }
  }

  function selectedActionState(row) {
    const selected = row.choice.action;
    const visibleSelected = selected === CLOSE_DAY_ACTIONS.newSession ? CLOSE_DAY_ACTIONS.session : selected;
    return { selected: visibleSelected, selectedText: actionLabel(row, selected, plan?.sessions) };
  }

  function actionControl(row, state = selectedActionState(row)) {
    if (row.locked) return el("span", { class: "close-day-outcome locked" },
      icon("eye", 16), localeMessage("close_day_stays_open"));
    const { selected } = state;
    const actionSet = el("div", {
      class: "close-day-action-set", role: "radiogroup",
      "aria-label": localeMessage("close_day_choose_for", [row.title])
    }, ...rowActions(row).map((action) => {
      const label = actionLabel(row, action, plan?.sessions);
      const iconName = ACTION_ICONS[action];
      return el("button", {
      class: "close-day-action-option tip", type: "button", role: "radio",
      "aria-checked": selected === action ? "true" : "false",
      "aria-label": label, "data-tip": label,
      "data-action": action, "data-icon": iconName,
      tabindex: selected === action ? "0" : "-1",
      onclick: (event) => chooseAction(row, action, event.currentTarget),
      onkeydown: (event) => actionKeydown(event, row, action)
    }, icon(iconName, 18));
    }));

    return el("div", { class: "close-day-choice" }, actionSet);
  }

  function cardNode(cardKey) {
    return [...document.querySelectorAll("[data-close-day-card]")]
      .find((node) => node.dataset.closeDayCard === cardKey);
  }

  function rowNode(rowKey) {
    return [...document.querySelectorAll("[data-close-day-row]")]
      .find((node) => node.dataset.closeDayRow === rowKey);
  }

  function enabledRowCheckboxes() {
    return [...document.querySelectorAll(".close-day-row-select:not(:disabled)")]
      .filter((node) => node.offsetParent !== null);
  }

  function reviewKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target.matches?.('input:not([type="checkbox"]), textarea, select') || target.isContentEditable) return;
    const row = target.closest?.("[data-close-day-row]");
    const checks = enabledRowCheckboxes();
    if (!checks.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!row) {
        checks[0].focus({ preventScroll: true });
        return;
      }
      if (target.matches?.(".close-day-action-option")) {
        const rows = [...document.querySelectorAll("[data-close-day-row]")]
          .filter((node) => node.offsetParent !== null && node.querySelector(".close-day-action-option"));
        const rowIndex = rows.indexOf(row);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const action = target.dataset.action;
        const column = [...row.querySelectorAll(".close-day-action-option")].indexOf(target);
        for (let step = 1; step <= rows.length; step++) {
          const candidate = rows[(rowIndex + offset * step + rows.length) % rows.length];
          const actions = [...candidate.querySelectorAll(".close-day-action-option")];
          const next = actions.find((button) => button.dataset.action === action) ??
            actions[Math.min(Math.max(column, 0), actions.length - 1)];
          if (next) {
            next.focus({ preventScroll: true });
            return;
          }
        }
        return;
      }
      const current = row.querySelector(".close-day-row-select:not(:disabled)");
      const index = checks.indexOf(current);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? 0 : (index + offset + checks.length) % checks.length;
      checks[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowRight" && target.matches?.(".close-day-row-select")) {
      event.preventDefault();
      row.querySelector('.close-day-action-option[aria-checked="true"], .close-day-action-option')
        ?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowLeft" && target.matches?.(".close-day-action-option") && row) {
      event.preventDefault();
      row.querySelector(".close-day-row-select:not(:disabled)")?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" && target.matches?.(".close-day-row-select:not(:disabled)")) {
      event.preventDefault();
      target.click();
    }
  }

  function rowSelection(row) {
    const checkbox = el("input", {
      class: "close-day-row-select", type: "checkbox", disabled: row.locked,
      checked: selectedRows.has(row.fingerprintKey),
      "aria-label": localeMessage(row.locked
        ? "close_day_row_unselectable"
        : "close_day_select_row", [row.title]),
      "data-row-select": row.fingerprintKey
    });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedRows.add(row.fingerprintKey);
      else selectedRows.delete(row.fingerprintKey);
      void focusAfterRender(() => [...document.querySelectorAll("[data-row-select]")]
        .find((node) => node.dataset.rowSelect === row.fingerprintKey));
    });
    return checkbox;
  }

  function toggleRowSelection(row, checked = !selectedRows.has(row.fingerprintKey), focus = false) {
    if (row.locked) return;
    if (checked) selectedRows.add(row.fingerprintKey);
    else selectedRows.delete(row.fingerprintKey);
    void focusAfterRender(focus ? () => rowNode(row.fingerprintKey)?.querySelector(".close-day-row-select") : null);
  }

  function selectedFor(rows) {
    return rows.filter((row) => !row.locked && selectedRows.has(row.fingerprintKey));
  }

  function bulkScope(rows) {
    const selected = selectedFor(rows);
    return selected.length ? selected : rows.filter((row) => !row.locked);
  }

  function commonActions(rows) {
    if (!rows.length) return [];
    const allowed = rowActions(rows[0]);
    return allowed.filter((action) => rows.every((row) => rowActions(row).includes(action)));
  }

  function applyBulk(cardKey, rows, patch) {
    const chosen = bulkScope(rows);
    if (!chosen.length) return;
    const keys = chosen.map((row) => row.fingerprintKey);
    for (const key of keys) selectedRows.delete(key);
    const saved = saveChoices(keys, patch, {
      bulk: true,
      focus: () => cardNode(cardKey)?.querySelector(".close-day-window-select")
    });
    if (!saved) for (const key of keys) selectedRows.add(key);
  }

  function chooseBulk(cardKey, rows, action, anchor) {
    const selected = bulkScope(rows);
    const hasSelection = selectedFor(rows).length > 0;
    if (action === CLOSE_DAY_ACTIONS.archiveLabel) {
      labelPicker(anchor, localeMessage(hasSelection
        ? "close_day_label_selected"
        : "close_day_label_window"),
        (labels) => applyBulk(cardKey, rows, { action, labels }));
      return;
    }
    if ([CLOSE_DAY_ACTIONS.session, CLOSE_DAY_ACTIONS.newSession].includes(action)) {
      const sessions = (plan.sessions ?? []).filter((session) =>
        selected.every((row) => session.id !== row.boundSessionId));
      sessionPicker(anchor, localeMessage(hasSelection
        ? "close_day_session_selected"
        : "close_day_session_window"),
        sessions, (value) => applyBulk(cardKey, rows, value.isNew
          ? { action: CLOSE_DAY_ACTIONS.newSession, newSessionName: value.name }
          : { action: CLOSE_DAY_ACTIONS.session, targetSessionId: value.id }));
      return;
    }
    applyBulk(cardKey, rows, { action });
  }

  function windowSelectionState(rows) {
    const selectable = rows.filter((row) => !row.locked);
    const chosen = selectedFor(rows);
    const allSelected = selectable.length > 0 && chosen.length === selectable.length;
    return { selectable, chosen, allSelected };
  }

  function windowSelection(cardKey, rows) {
    const { selectable, chosen, allSelected } = windowSelectionState(rows);
    const checkbox = el("input", {
      class: "close-day-window-select", type: "checkbox",
      checked: allSelected, disabled: selectable.length === 0,
      "aria-label": localeMessage("close_day_select_window", [formatNumber(selectable.length)])
    });
    checkbox.indeterminate = chosen.length > 0 && !allSelected;
    checkbox.addEventListener("change", () => {
      for (const row of selectable) {
        if (checkbox.checked) selectedRows.add(row.fingerprintKey);
        else selectedRows.delete(row.fingerprintKey);
      }
      void focusAfterRender(() => cardNode(cardKey)?.querySelector(".close-day-window-select"));
    });
    return checkbox;
  }

  function windowBulk(cardKey, rows) {
    const { selectable, chosen } = windowSelectionState(rows);
    const scope = chosen.length ? chosen : selectable;
    const actions = commonActions(scope);
    const scopeText = chosen.length
      ? localeMessage("close_day_selected_count", [formatNumber(chosen.length)])
      : localeMessage(selectable.length === 1
        ? "close_day_all_tabs_one"
        : "close_day_all_tabs_other", [formatNumber(selectable.length)]);
    const scopeHint = localeMessage(chosen.length
      ? "close_day_actions_selection"
      : "close_day_actions_window");
    return el("div", { class: "close-day-window-bulk" },
      actions.length ? el("div", {
        class: "close-day-bulk-actions", role: "toolbar",
        "aria-label": localeMessage(chosen.length
          ? "close_day_apply_selection"
          : "close_day_apply_window")
      }, ...actions.map((action) => {
        const label = action === CLOSE_DAY_ACTIONS.close
          ? chosen.length
            ? localeMessage("close_day_close_selected_saved")
            : localeMessage("close_day_close_window_saved")
          : ACTION_LABELS[action];
        const iconName = ACTION_ICONS[action];
        return el("button", {
          class: "close-day-action-option close-day-bulk-action tip", type: "button",
          "aria-label": label, "data-tip": label, "data-action": action, "data-icon": iconName,
          onclick: (event) => chooseBulk(cardKey, rows, action, event.currentTarget),
          onkeydown: (event) => {
            if (moveActionFocus(event)) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              chooseBulk(cardKey, rows, action, event.currentTarget);
            }
          }
        }, icon(iconName, 18));
      })) : null,
      el("span", { class: "close-day-bulk-scope tip", "data-tip": scopeHint },
        selectable.length ? scopeText : localeMessage("close_day_no_selectable_tabs")));
  }

  function favicon(row) {
    if (!row.favIconUrl) return el("span", { class: "close-day-favicon fallback" });
    const image = el("img", { class: "close-day-favicon", src: row.favIconUrl, alt: "" });
    image.addEventListener("error", () => image.replaceWith(el("span", { class: "close-day-favicon fallback" })));
    return image;
  }

  function rowLabels(row) {
    const labels = row.coverage?.kind === "archive"
      ? [...new Set((row.coverage.labels ?? []).map(clean).filter(Boolean))]
      : [];
    if (!labels.length) return null;
    return el("span", { class: "chips rowchips close-day-labels",
      "aria-label": localeMessage("close_day_labels_aria", [formatList(labels)]) },
      ...labels.map((label) => el("span", { class: "chip is-accented", title: label }, label)));
  }

  function reviewRow(row) {
    const actionState = selectedActionState(row);
    return el("div", {
      class: `close-day-row${row.locked ? " is-locked" : ""}${row.pinned ? " is-pinned" : ""}` +
        `${selectedRows.has(row.fingerprintKey) ? " is-selected" : ""}`,
      "data-close-day-row": row.fingerprintKey,
      onclick: (event) => {
        if (row.locked || event.target.closest("button, input, select, textarea, a, label")) return;
        toggleRowSelection(row);
      }
    },
    rowSelection(row),
    favicon(row),
    el("div", { class: "close-day-copy" },
      el("div", { class: "close-day-title", title: row.title }, row.title),
      el("div", { class: "close-day-subline" },
        row.locked ? el("span", { class: "close-day-meta" }, row.lockedReason)
          : el("span", { class: "close-day-action-copy", title: actionState.selectedText },
            el("strong", {}, localeMessage("close_day_action_prefix")), ` ${actionState.selectedText}`,
            row.pinned ? localeMessage("close_day_pinned_suffix") : ""),
        rowLabels(row))),
    actionControl(row, actionState));
  }

  function sessionWindowHeader(group, cardKey) {
    const session = group.session;
    const newCount = group.rows.filter((row) => row.matchSavedIndex == null && row.ref && !row.locked).length;
    const detail = [];
    if (newCount) detail.push(localeMessage("close_day_new_count", [formatNumber(newCount)]));
    if (session.absentCount) detail.push(localeMessage("close_day_saved_not_open", [
      formatNumber(session.absentCount)
    ]));
    if (session.drift.any) detail.push(localeMessage("close_day_arrangement_changed"));
    const armed = replaceArmed === group.windowId;
    let replace;
    if (replaceSaving === group.windowId) {
      replace = el("div", { class: "close-day-replace-state", role: "status" },
        el("span", {}, localeMessage("close_day_saving_choice")));
    } else if (session.mode === "replace") {
      replace = el("div", { class: "close-day-replace-state", role: "status" },
        el("span", {}, localeMessage("close_day_open_replace_arrangement")),
        el("button", { class: "quiet", type: "button", onclick: () => void setWindowMode(group, "keep") },
          localeMessage("close_day_keep_saved_arrangement")));
    } else if (armed) {
      const cancel = () => {
        clearTimeout(replaceTimer);
        replaceTimer = 0;
        replaceArmed = null;
        void focusAfterRender(() => windowReplace(group.windowId));
      };
      replace = el("div", {
        class: "close-day-replace-confirm",
        onfocusout: (event) => {
          const confirmation = event.currentTarget;
          setTimeout(() => {
            if (replaceArmed === group.windowId && !confirmation.contains(document.activeElement)) cancel();
          }, 0);
        }
      },
      el("span", {}, localeMessage("close_day_replace_question")),
      el("div", { class: "close-day-replace-actions" },
        el("button", { class: "quiet", type: "button", onclick: cancel },
          localeMessage("close_day_keep_saved_arrangement")),
        el("button", { class: "danger", type: "button", onclick: () => void setWindowMode(group, "replace") },
          localeMessage("close_day_replace_saved_arrangement"))));
    } else {
      replace = el("button", {
        class: "mini2 close-day-replace", type: "button",
        "data-tip": localeMessage("close_day_replace_tip"),
        onclick: () => armReplace(group)
      }, localeMessage("close_day_replace_saved_arrangement"));
    }
    return el("header", { class: "close-day-window-head" },
      el("div", { class: "close-day-window-heading-row" },
        windowSelection(cardKey, group.rows),
        el("div", { class: "close-day-window-copy" },
          el("h4", {}, localeMessage("close_day_restored_window", [
            session.name, formatNumber(session.windowIndex + 1)
          ])),
          el("p", {}, detail.length ? detail.join(" · ") : localeMessage("close_day_matches_session")), replace),
        windowBulk(cardKey, group.rows)));
  }

  function windowName(group) {
    const ordinal = Number.isInteger(group.ordinal)
      ? group.ordinal
      : Math.max(0, (plan.groups ?? []).findIndex((candidate) => candidate.windowId === group.windowId));
    return localeMessage("close_day_window_number", [formatNumber(ordinal + 1)]);
  }

  function ordinaryWindowHeader(group, cardKey) {
    return el("header", { class: "close-day-window-head" },
      el("div", { class: "close-day-window-heading-row" },
        windowSelection(cardKey, group.rows),
        el("div", { class: "close-day-window-copy" },
          el("h4", {}, windowName(group)),
          el("p", {}, localeMessage(group.rows.length === 1
            ? "close_day_tab_count_one"
            : "close_day_tab_count_other", [formatNumber(group.rows.length)]))),
        windowBulk(cardKey, group.rows)));
  }

  function windowCard(group, rows, session = false, kind = "window") {
    const visibleGroup = rows === group.rows ? group : { ...group, rows };
    const cardKey = `${group.windowId}:${kind}`;
    return el("article", {
      class: "close-day-window", "data-close-day-window": group.windowId,
      "data-close-day-card": cardKey
    },
      el("div", { class: "close-day-window-head-shell" },
        session ? sessionWindowHeader(visibleGroup, cardKey) : ordinaryWindowHeader(visibleGroup, cardKey)),
      el("div", { class: "close-day-window-body-frame" },
        el("div", { class: "close-day-rows" }, ...rows.map(reviewRow))));
  }

  function stage(model) {
    return el("section", { class: "close-day-stage", "data-close-day-stage": model.id },
      el("div", { class: "close-day-stage-head" }, el("h3", {}, model.title),
        el("p", {}, model.description)),
      model.cards.length ? el("div", { class: "close-day-cards" }, ...model.cards)
        : el("p", { class: "close-day-empty" }, model.empty));
  }

  function reviewStages() {
    const sessions = [];
    const ordinary = [];
    const exceptionsByWindow = [];
    let sessionTabCount = 0;
    let ordinaryTabCount = 0;
    let exceptionCount = 0;
    for (const group of plan.groups ?? []) {
      const exceptionRows = group.rows.filter((row) => row.locked || row.pinned);
      const normalRows = group.rows.filter((row) => !row.locked && !row.pinned);
      if (group.session && normalRows.length) {
        sessionTabCount += normalRows.length;
        sessions.push(windowCard(group, normalRows, true, "session"));
      } else if (!group.session && normalRows.length) {
        ordinaryTabCount += normalRows.length;
        ordinary.push(windowCard(group, normalRows, false, "ordinary"));
      }
      if (exceptionRows.length) {
        exceptionCount += exceptionRows.length;
        exceptionsByWindow.push(windowCard(group, exceptionRows, false, "exceptions"));
      }
    }
    return [
      { id: "sessions", navTitle: localeMessage("close_day_nav_sessions"), count: sessionTabCount,
        title: localeMessage("close_day_sessions_title"),
        description: localeMessage("close_day_sessions_description"),
        cards: sessions, empty: localeMessage("close_day_sessions_empty") },
      { id: "regular", navTitle: localeMessage("close_day_nav_regular"), count: ordinaryTabCount,
        title: localeMessage("close_day_regular_title"),
        description: localeMessage("close_day_regular_description"),
        cards: ordinary, empty: localeMessage("close_day_regular_empty") },
      { id: "staying-open", navTitle: localeMessage("close_day_nav_staying_open"), count: exceptionCount,
        title: localeMessage("close_day_staying_open_title"),
        description: localeMessage("close_day_staying_open_description"),
        cards: exceptionsByWindow, empty: localeMessage("close_day_staying_open_empty") },
    ];
  }

  function stageNavigation(stages) {
    return el("nav", { class: "close-day-stage-nav",
      "aria-label": localeMessage("close_day_sections_aria") },
      ...stages.map((item, index) => el("button", {
        class: `close-day-stage-link${index === 0 ? " is-active" : ""}`,
        type: "button", "data-stage-target": item.id,
        "aria-label": localeMessage("close_day_stage_count", [
          item.navTitle, formatNumber(item.count)
        ]),
        "aria-current": index === 0 ? "true" : null,
        onclick: () => goToStage(item.id)
      }, el("span", {}, item.navTitle), el("span", { class: "close-day-stage-count" }, String(item.count)))));
  }

  function summaryLine(value, text) {
    return el("li", {}, el("strong", {}, String(value)), ` ${text}`);
  }

  function summaryPairLine(pairs, fallback = "") {
    const active = pairs.filter(([value]) => value);
    if (!active.length) return el("li", {
      class: fallback ? "" : "close-day-summary-slot",
      "aria-hidden": fallback ? null : "true"
    }, fallback || "\u00a0");
    const children = [];
    active.forEach(([value, text], index) => {
      if (index) children.push(el("span", { class: "close-day-summary-separator", "aria-hidden": "true" }, " · "));
      children.push(el("span", {}, el("strong", {}, String(value)), ` ${text}`));
    });
    return el("li", {}, ...children);
  }

  function armCommit() {
    if (stale || committing || pendingChoiceWrites.size || !plan.summary.closeCount) return;
    if (!commitArmed) {
      commitArmed = true;
      clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        commitArmed = false;
        void focusAfterRender(() => document.querySelector(".close-day-commit"));
      }, decisionTimeoutMs);
      void focusAfterRender(() => document.querySelector(".close-day-commit"));
      return;
    }
    void runCommit();
  }

  async function runCommit() {
    committing = true;
    commitArmed = false;
    rerender();
    const response = await msg({ type: "close-day-commit", draftId });
    committing = false;
    if (!response?.ok) {
      if (["stale-browser", "stale-store"].includes(response?.status)) {
        stale = true;
        showNotice(localeMessage("close_day_commit_stale"));
      } else showNotice(localeMessage("close_day_commit_failed"));
      await focusAfterRender(() => stale
        ? document.querySelector(".close-day-stale button")
        : document.querySelector(".close-day-commit"));
      return;
    }
    completion = response.receipt;
    plan = null;
    clearArms();
    await Promise.resolve(rerender());
    window.scrollTo(0, 0);
    requestAnimationFrame(() => document.querySelector(".close-day-complete h3")
      ?.focus?.({ preventScroll: true }));
  }

  function reviewSummary(stages) {
    const summary = plan.summary;
    const savingChoices = pendingChoiceWrites.size > 0;
    const commitText = committing
      ? localeMessage("close_day_saving_first")
      : savingChoices
        ? localeMessage("close_day_saving_choices")
        : commitArmed
          ? localeMessage(summary.closeCount === 1
            ? "close_day_confirm_one"
            : "close_day_confirm_other", [formatNumber(summary.closeCount)])
          : localeMessage("close_day_commit");
    const commit = el("button", {
      class: `close-day-commit${commitArmed ? " armed" : ""}`, type: "button",
      disabled: stale || committing || savingChoices || summary.closeCount === 0,
      onclick: armCommit
    }, commitText);
    const cancel = commitArmed ? el("button", { class: "quiet", type: "button", onclick: () => {
      commitArmed = false;
      clearTimeout(commitTimer);
      void focusAfterRender(() => document.querySelector(".close-day-commit"));
    } }, localeMessage("action_cancel")) : null;
    const noKeepChanges = !summary.sessionCount && !summary.inboxCount &&
      !summary.archiveCount && !summary.unfiledCount;
    return el("section", { class: "close-day-summary section-local-sticky" },
      el("div", { class: "close-day-summary-grid" },
        el("div", {}, el("h3", {}, localeMessage("close_day_keep_first")), el("ul", {},
          summaryPairLine([
            [summary.sessionCount, localeMessage(summary.sessionCount === 1
              ? "close_day_session_change_one" : "close_day_session_change_other")],
            [summary.inboxCount, localeMessage(summary.inboxCount === 1
              ? "close_day_inbox_tab_one" : "close_day_inbox_tab_other", [
              formatNumber(summary.inboxBundleCount)
            ])]
          ], noKeepChanges ? localeMessage("close_day_everything_saved") : ""),
          summaryPairLine([
            [summary.archiveCount, localeMessage(summary.archiveCount === 1
              ? "close_day_archive_copy_one" : "close_day_archive_copy_other")],
            [summary.unfiledCount, localeMessage(summary.unfiledCount === 1
              ? "close_day_unfiled_one" : "close_day_unfiled_other")]
          ]))),
        el("div", {}, el("h3", {}, localeMessage("close_day_then_close")), el("ul", {},
          summaryLine(summary.closeCount, localeMessage(summary.closeWindowCount === 1
            ? "close_day_close_summary_one_window"
            : "close_day_close_summary_other_windows", [formatNumber(summary.closeWindowCount)])),
          summaryLine(summary.stayOpenCount, localeMessage("close_day_left_open"))))),
      el("div", { class: "close-day-final-actions" }, commit, cancel,
        el("button", { class: "quiet", type: "button", onclick: onLeave },
          localeMessage("close_day_leave_later"))),
      stageNavigation(stages));
  }

  function staleBanner() {
    if (!stale) return null;
    return el("div", { class: "close-day-stale", role: "status" },
      el("div", {}, el("strong", {}, localeMessage("close_day_stale_title")),
        el("span", {}, ` ${localeMessage("close_day_stale_body")}`)),
      el("button", { class: "mini2", type: "button", onclick: () => void load() },
        localeMessage("close_day_refresh_review")));
  }

  async function undoCompletion() {
    const result = await msg({ type: "close-day-undo", transactionId: completion.id });
    if (!result?.ok) {
      showNotice(localeMessage("close_day_undo_unavailable"));
      return;
    }
    completion = result.receipt;
    await focusAfterRender(() => document.querySelector(".close-day-complete h3"));
  }

  function completionView() {
    const undone = completion.phase === "undone";
    const closed = completion.result?.closed ?? 0;
    const skipped = completion.result?.skipped ?? 0;
    const conflicts = completion.storeUndo?.conflicts ?? 0;
    return el("div", { class: "close-day-complete" },
      el("div", { class: "close-day-complete-mark", "aria-hidden": "true" }, icon(undone ? "refresh" : "mark", 28)),
      el("h3", { tabindex: "-1" }, localeMessage(undone
        ? "close_day_undone_title"
        : "close_day_complete_title")),
      el("p", {}, undone
        ? localeMessage(conflicts ? "close_day_undone_conflicts" : "close_day_undone_success", [
          formatNumber(completion.reopenResult?.reopened ?? 0)
        ])
        : localeMessage(skipped ? "close_day_complete_skipped" : "close_day_complete_success", [
          formatNumber(closed), formatNumber(skipped)
        ])),
      !undone ? el("div", { class: "close-day-complete-actions" },
        el("button", { class: "primary", type: "button", onclick: undoCompletion },
          localeMessage("close_day_undo")),
        skipped ? el("button", { class: "quiet", type: "button", onclick: () => void load({ startOver: true }) },
          localeMessage("close_day_review_remaining")) : null,
        el("button", { class: "quiet", type: "button", onclick: () => onNavigate("inbox") },
          localeMessage("close_day_open_inbox")),
        el("button", { class: "quiet", type: "button", onclick: () => onNavigate("sessions") },
          localeMessage("close_day_open_sessions")),
        el("button", { class: "quiet", type: "button", onclick: () => void load({ startOver: true }) },
          localeMessage("close_day_another_review")))
        : el("button", { class: "primary", type: "button", onclick: () => void load({ startOver: true }) },
          localeMessage("close_day_another_review")));
  }

  function build() {
    if (loading) return el("div", { class: "close-day-loading", role: "status" },
      localeMessage("close_day_preparing"));
    if (completion) return completionView();
    if (!plan) return el("div", { class: "close-day-error" },
      el("p", {}, localeMessage("close_day_unavailable")),
      el("button", { class: "primary", type: "button", onclick: () => void load({ startOver: true }) },
        localeMessage("close_day_try_again")));
    const stages = reviewStages();
    const review = el("div", { class: "close-day-review", onkeydown: reviewKeydown },
      reviewSummary(stages),
      el("div", { class: "close-day-intro" },
        el("p", {}, localeMessage(plan.windowCount === 1
          ? "close_day_intro_one_window"
          : "close_day_intro_other_windows", [
          formatNumber(plan.tabCount), formatNumber(plan.windowCount)
        ])),
        el("p", { class: "close-day-honesty" },
          localeMessage("close_day_honesty")),
        plan.excludedWindowCount ? el("p", { class: "close-day-excluded" },
          localeMessage(plan.excludedWindowCount === 1
            ? "close_day_excluded_one"
            : "close_day_excluded_other", [formatNumber(plan.excludedWindowCount)])) : null),
      staleBanner(),
      ...stages.map(stage));
    requestAnimationFrame(() => syncStageNavigation());
    return review;
  }

  return {
    render, load, checkFreshness, checkFreshnessSoon,
    hasPlan: () => Boolean(plan), getDraftId: () => draftId
  };
}
