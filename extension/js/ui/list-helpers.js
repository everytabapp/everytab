// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * Shared list controls: status, confirmation, Labels, Session selection and
 * Snooze. Dashboard and Side Panel use the same interaction code. Persisted
 * changes remain in domain operations; Session save/group ordering is handled
 * by session-picker-commit.js.
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createLabelInput } from "./labelinput.js";
import { createCombobox } from "./combobox.js";
import { createInlineOrganizationEditor } from "./organization-controls.js";
import { ANCHORED_PANEL_COMMIT_EVENT, createAnchoredPanel } from "./tablist.js";
import { listNamedSessions } from "../lib/store.js";
import { linksToMarkdown, sessionToMarkdown } from "../lib/export.js";
import { RECURRENCE_OPTIONS, presetDue } from "../lib/snooze.js";
import { SORT_MODES } from "../lib/organize.js";
import { msg as localeMessage, pluralCategory } from "../lib/i18n.js";
import { applyOrganizationMemberPlan } from "../lib/organization.js";
import { commitSessionPick } from "./session-picker-commit.js";
import { listRecurrenceOptionLabel, listSnoozePresetLabel, listSortLabel, listUnit } from "./list-copy.js";

const HTTP_REF = /^https?:/;

/**
 * F19 — copy-as-markdown helpers, bound to a `showNotice(message)` sink so the
 * outcome toast belongs to the calling surface. Read-only: nothing is mutated or
 * journaled. Returns `{ copyRefs, copySession, copyMarkdown }`; destructure into the
 * same names so existing call sites are unchanged.
 * @param {(message: string) => void} showNotice
 */
export function createCopyHelpers(showNotice) {
  /** Write `md` to the clipboard and report the outcome as a transient toast. */
  async function copyMarkdown(md, count) {
    if (!md) { showNotice(localeMessage("list_copy_nothing")); return; }
    try {
      await navigator.clipboard.writeText(md);
      showNotice(pluralCategory(count) === "one"
        ? localeMessage("list_copied_one_link")
        : localeMessage("list_copied_links", [String(count)]));
    } catch {
      showNotice(localeMessage("list_copy_failed"));
    }
  }
  /** Copy a flat list of refs as Markdown, optionally under a `# heading`. */
  async function copyRefs(refs, heading) {
    const links = (refs ?? []).filter((r) => r && HTTP_REF.test(r.url ?? ""));
    const body = linksToMarkdown(links);
    const md = heading && body ? `# ${heading}\n\n${body}` : body;
    await copyMarkdown(md, links.length);
  }
  /** Copy a whole session/snapshot as Markdown (name + per-window bullets). */
  async function copySession(session) {
    const count = (session?.windows ?? []).flat().filter((r) => HTTP_REF.test(r?.url ?? "")).length;
    await copyMarkdown(sessionToMarkdown(session), count);
  }
  return { copyRefs, copySession, copyMarkdown };
}

/**
 * Inline status marker: a monochrome icon plus a screen-reader-only label, so
 * meaning is never carried by the glyph alone (pinned / audible tab badges).
 * @param {SVGElement} ic @param {string} label
 */
export function mark(ic, label) {
  return el("span", { class: "tmark" }, ic, el("span", { class: "sr-only" }, label + " "));
}

/**
 * Two-step destructive control: the first click arms the supplied confirmation,
 * and the second confirms. Callers own the exact operation and wording, including
 * whether an inverse can be recorded.
 * @param {() => (void|Promise<void>)} onConfirm
 * @param {string} label
 * @param {string} confirmLabel
 */
export function confirmDelete(
  onConfirm,
  label = localeMessage("action_delete"),
  confirmLabel
) {
  const wrap = el("span", { class: "confirm-inline" });
  let timer = 0;
  const content = (iconName, text) => [
    el("span", { class: "action-icon" },
      iconName ? icon(iconName, 14) : "×"),
    el("span", { class: "action-label" }, text)
  ];
  const ask = el("button", {
    class: "danger", title: label, "aria-label": label, "data-action-id": "delete",
    onclick: () => arm()
  }, ...content("delete", label));
  function arm() {
    // Most controls never open. Resolve hidden copy only when it becomes visible.
    const question = confirmLabel === undefined ? localeMessage("list_delete_question") : confirmLabel;
    const cancel = localeMessage("action_cancel");
    const yes = el("button", {
      class: "danger", title: question, "aria-label": question,
      onclick: () => onConfirm()
    }, ...content("delete", question));
    const no = el("button", {
      class: "mini2", title: cancel, "aria-label": cancel,
      onclick: () => reset()
    }, ...content(null, cancel));
    wrap.classList.add("armed");
    wrap.replaceChildren(yes, no);
    yes.focus();
    clearTimeout(timer);
    timer = setTimeout(reset, 4000); // auto-disarm so it never gets stuck armed
  }
  function reset() {
    clearTimeout(timer);
    wrap.classList.remove("armed");
    wrap.replaceChildren(ask);
  }
  reset();
  return wrap;
}

/**
 * P11-03: two-step whole-window close. Arming temporarily turns the header into
 * the decision so the blast radius is visible without opening a modal.
 * `onConfirm` returns true only when the live window was actually removed; a
 * stale/error result resets the control after the caller reports the reason.
 */
export function confirmWindowClose({
  windowName, tabCount, pinnedCount = 0, isCurrent = false, isLast = false, onConfirm
}) {
  const wrap = el("span", { class: "confirm-inline window-close-confirm" });
  let timer = 0;
  let busy = false;
  const tabs = listUnit("tab", tabCount);
  const actionContent = (glyph, text) => [
    el("span", { class: "action-icon" }, glyph),
    el("span", { class: "action-label" }, text)
  ];
  const ask = el("button", {
    class: "danger", type: "button", title: localeMessage("list_close_window"),
    "aria-label": localeMessage("list_close_named", [windowName]),
    "data-action-id": "close-window", onclick: () => arm()
  }, ...actionContent("×", localeMessage("action_close")));
  const primary = el("span", { class: "confirm-primary" },
    localeMessage("list_close_window_question", [windowName, tabs]));
  const warnings = [
    pinnedCount > 0
      ? (pluralCategory(pinnedCount) === "one"
          ? localeMessage("list_close_window_pinned_one")
          : localeMessage("list_close_window_pinned_other", [String(pinnedCount)]))
      : "",
    isCurrent ? localeMessage("list_close_window_current") : "",
    isLast ? localeMessage("list_close_window_last") : ""
  ].filter(Boolean);
  const copy = el("span", { class: "confirm-copy" }, primary,
    warnings.length ? el("span", { class: "confirm-detail" }, warnings.join(" ")) : null);
  const yes = el("button", {
    class: "danger", type: "button", title: localeMessage("list_close_tabs", [tabs]),
    "aria-label": localeMessage("list_confirm_close_window", [windowName, tabs]),
    onclick: async () => {
      if (busy) return;
      busy = true;
      clearTimeout(timer);
      wrap.setAttribute("aria-busy", "true");
      yes.disabled = true;
      no.disabled = true;
      yes.querySelector(".action-label").textContent = localeMessage("list_closing");
      let closed = false;
      try { closed = await onConfirm() === true; } catch { /* caller reports failures */ }
      if (!closed && wrap.isConnected) reset();
    }
  }, ...actionContent("×", localeMessage("list_close_tabs", [tabs])));
  const no = el("button", {
    class: "mini2", type: "button", title: localeMessage("action_cancel"),
    "aria-label": localeMessage("list_cancel_window_close"),
    onclick: () => reset()
  }, ...actionContent("", localeMessage("action_cancel")));
  const actions = el("span", { class: "confirm-actions" }, yes, no);

  function arm() {
    busy = false;
    wrap.classList.add("armed");
    wrap.replaceChildren(copy, actions);
    yes.focus();
    clearTimeout(timer);
    timer = setTimeout(reset, 4000);
  }
  function reset() {
    clearTimeout(timer);
    busy = false;
    wrap.removeAttribute("aria-busy");
    wrap.classList.remove("armed");
    yes.disabled = false;
    no.disabled = false;
    yes.querySelector(".action-label").textContent = localeMessage("list_close_tabs", [tabs]);
    wrap.replaceChildren(ask);
  }
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && wrap.classList.contains("armed")) {
      event.preventDefault();
      event.stopPropagation();
      reset();
      ask.focus();
    }
  });
  wrap.addEventListener("focusout", () => queueMicrotask(() => {
    if (!busy && wrap.classList.contains("armed") && !wrap.contains(document.activeElement)) reset();
  }));
  reset();
  return wrap;
}

/** N5 — briefly show a small validation note next to a button, then remove it. */
export function flashNote(anchor, text) {
  anchor.parentElement?.querySelector(":scope > .tag-note")?.remove();
  const note = el("span", { class: "tag-note", role: "alert" }, text);
  anchor.after(note);
  setTimeout(() => note.remove(), 2200);
}

/**
 * Shared Session action. The invoking button stays in place and opens the same
 * anchored palette used by Labels, Snooze, and Organize. Inside it, one field
 * selects an existing named Session or enters a new one. The selected Session,
 * inline Organize disclosure, and final Apply action then stay on one screen.
 * @param {string} label button text
 * @param {{cls?:string, title?:string, iconName?:string, actionId?:string,
 *   excludeIds?:string[], allowCreate?:boolean, ariaLabel?:string, placeholder?:string,
 *   onOpen?:()=>void,
 *   onPick:(v:{id:string|null,name:string,isNew:boolean,
 *     organization?:{groupIds:string[],createNames:string[]}})=>Promise<boolean>|boolean}} o
 */
export function sessionComboboxButton(label, {
  cls = "", title = "", iconName = "sessions", actionId = "", excludeIds = [],
  allowCreate = true, ariaLabel, placeholder, onOpen = null, onPick
}) {
  const excluded = new Set(excludeIds);
  let controller;
  const buildPanel = () => {
    const panel = el("div", { class: "palette-form session-picker-form" });
    let organizer = null;
    const showPicker = () => {
      const field = createCombobox({
        ariaLabel: ariaLabel === undefined ? localeMessage("list_session_picker_aria") : ariaLabel,
        placeholder: placeholder === undefined ? localeMessage("list_session_picker_placeholder") : placeholder,
        loadOptions: async () =>
          (await listNamedSessions())
            .filter((s) => !excluded.has(s.id))
            .map((s) => ({ id: s.id, name: s.name })),
        createLabel: (v) => localeMessage("list_new_session_named", [v]),
        emptyCreateLabel: allowCreate ? localeMessage("list_new_session_auto") : null,
        allowCreate,
        portalMenu: false,
        onCommit: async (value) => showSelection(value),
        onCancel: () => controller.close({ restore: true })
      });
      panel.replaceChildren(el("div", { class: "palette-field session-picker-field" }, field.element));
      queueMicrotask(() => field.focus());
    };
    const showSelection = async (value) => {
      const displayName = value.name || localeMessage("list_new_session_auto");
      const temporaryKey = value.id || `new:${displayName}`;
      organizer = createInlineOrganizationEditor({ kind: "session", onSubmit: () => apply.click() });
      await organizer.setMembers([{ key: temporaryKey, name: displayName, isNew: value.isNew }]);
      const selected = el("div", { class: "palette-selected-target" },
        el("span", { class: "chip", title: displayName }, displayName,
          el("button", { class: "x", type: "button",
            "aria-label": localeMessage("action_back"), onclick: showPicker }, "×")));
      const apply = el("button", { class: "primary palette-commit", type: "button",
        onclick: async () => {
          if (apply.disabled) return;
          apply.disabled = true;
          apply.setAttribute("aria-busy", "true");
          try {
            const plan = await organizer.getPlan();
            controller.close();
            const saved = await commitSessionPick(value, plan, onPick, applyOrganizationMemberPlan);
            if (!saved) flashNote(btn, localeMessage("list_save_failed"));
          } catch {
            flashNote(btn, localeMessage("list_save_failed"));
          } finally {
            apply.disabled = false;
            apply.removeAttribute("aria-busy");
          }
        } }, label);
      panel.replaceChildren(
        el("div", { class: "palette-field session-picker-selected" },
          el("span", { class: "palette-field-label" }, localeMessage("list_session_picker_aria")),
          selected),
        organizer.element,
        el("div", { class: "organization-form-actions" }, apply)
      );
      queueMicrotask(() => apply.focus({ preventScroll: true }));
    };
    showPicker();
    return panel;
  };
  const btn = el("button", { class: cls || null, title: title || label, "aria-label": title || label,
    "aria-haspopup": "dialog", "aria-expanded": "false",
    ...(actionId ? { "data-action-id": actionId } : {}),
    onclick: (event) => {
      onOpen?.();
      controller.anchor(event.currentTarget);
      controller.toggle(buildPanel, "session");
    } },
    iconName ? el("span", { class: "action-icon" }, icon(iconName, 14)) : null,
    el("span", { class: "action-label lbl" }, label));
  controller = createAnchoredPanel(btn);
  return btn;
}

/**
 * Shared icon-plus-label anatomy for selected-tab commands. One-card selections
 * use these in the card header; cross-card selections use the same controls in
 * the keeper dock. The visible label may collapse, but title and aria-label
 * always retain the full action name.
 */
export function selectionActionButton(id, label, iconName, attrs = {}) {
  const { glyph = "", ...buttonAttrs } = attrs;
  const title = buttonAttrs.title || label;
  return el("button", {
    ...buttonAttrs,
    "data-bulk-action": id,
    title,
    "aria-label": buttonAttrs["aria-label"] || title
  },
  el("span", { class: "action-icon", "aria-hidden": "true" },
    iconName ? icon(iconName, 14) : glyph || "×"),
  el("span", { class: "action-label" }, label));
}

/**
 * Inline card label panel: a label combobox + Apply, mounted below a card header
 * (row/window/session "Label" action). N13: type a label, Enter (chip), Enter
 * again (empty input) = Apply. N22: Esc closes the panel and frees the keyboard.
 * @param {(labels: string[]) => Promise<void>|void} applyFn
 * @param {string} [buttonText] @param {{close: () => void}|null} [panel]
 */
export function cardLabelPanel(applyFn, buttonText = localeMessage("list_add_labels"), panel = null) {
  let organizer;
  let li;
  const syncOrganizer = async () => {
    if (!li || !organizer) return;
    const labels = li.getLabels();
    await organizer.setMembers(labels.map((name) => ({ key: name, name })));
  };
  const commit = async (labels, organizationPlan = null) => {
    await applyFn(labels);
    if (organizationPlan) {
      const result = await applyOrganizationMemberPlan("label", organizationPlan);
      if (result?.ok === false) reportFailure("Label group assignment");
    }
    panel?.close();
  };
  const apply = el("button", { class: "mini primary palette-commit", onclick: async (e) => {
    if (apply.disabled) return;
    apply.disabled = true;
    apply.setAttribute("aria-busy", "true");
    const priorText = apply.textContent;
    let entries;
    try {
      entries = await li.getEntries();
    } catch (error) {
      reportFailure("Label choices read", error, console.error);
      apply.disabled = false;
      apply.removeAttribute("aria-busy");
      flashNote(apply, localeMessage("list_save_failed"));
      return;
    }
    const labels = entries.map((entry) => entry.name);
    if (labels.length === 0) {
      flashNote(e.currentTarget, localeMessage("list_type_label_first"));
      apply.disabled = false;
      apply.removeAttribute("aria-busy");
      return;
    }
    apply.textContent = localeMessage("list_saving");
    try {
      await organizer.setMembers(entries.map((entry) => ({
        key: entry.name, name: entry.name, isNew: entry.isNew
      })));
      await commit(labels, await organizer.getPlan());
    } catch (error) {
      reportFailure("Label save", error, console.error);
      apply.disabled = false;
      apply.removeAttribute("aria-busy");
      apply.textContent = priorText;
      flashNote(apply, localeMessage("list_save_failed"));
    }
  } }, buttonText);
  organizer = createInlineOrganizationEditor({ kind: "label", onSubmit: () => apply.click() });
  li = createLabelInput({ placeholder: localeMessage("list_labels_placeholder"), onSubmit: () => apply.click(),
    onCancel: () => panel?.close({ restore: true }), onChange: () => { void syncOrganizer(); } });
  const field = el("div", { class: "palette-field palette-label-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_add_labels")),
      li.element,
      el("span", { class: "palette-help" }, localeMessage("list_label_entry_help")));
  const bar = el("div", { class: "row-labelbar palette-form" }, field, organizer.element, apply);
  setTimeout(() => li.element.querySelector("input")?.focus(), 0);
  return bar;
}

/** Generic selection → refs for the flat sections (every group carries `.refs`). */
export const selectionRefs = (sel) => (sel ?? []).flatMap((s) => s.indexes.map((i) => s.group.refs[i])).filter(Boolean);

/** One shared three-choice Sort field for Dashboard, side panel, and Popup. */
export function buildSortChoices(commit) {
  return el("div", { class: "palette-field" },
    el("span", { class: "palette-field-label" }, localeMessage("list_sort_by")),
    el("div", { class: "palette-choice-grid palette-choice-grid-three" },
      ...SORT_MODES.map((mode) => el("button", {
        class: "mini",
        title: localeMessage("list_sort_by_named", [listSortLabel(mode).toLocaleLowerCase()]),
        onclick: () => commit(mode)
      }, listSortLabel(mode)))));
}

const INBOX_SNOOZE_PRESETS = ["later-today", "this-evening", "tomorrow", "weekend", "next-week"];

/**
 * P2g-5 — the P3 time-picking panel, decoupled from what it schedules:
 * presets + custom datetime + recurrence; `commit(dueAt, recurrence)` performs
 * the act (inbox snooze, session snooze, …). Shared across every section that
 * snoozes, on both the dashboard and the side panel.
 * @param {(dueAt: number, recurrence?: string) => void|Promise<void>} commit
 */
export function buildSnoozePanel(commit) {
  const recur = el("select", { class: "snooze-recur", "aria-label": localeMessage("list_repeat") },
    ...RECURRENCE_OPTIONS.map(([v, l]) => el("option", { value: v }, listRecurrenceOptionLabel(v, l))));
  const custom = el("input", { type: "datetime-local", class: "snooze-custom",
    "aria-label": localeMessage("list_custom_snooze_time") });
  let pending = false;
  let root;
  const go = async (dueAt) => {
    if (pending) return;
    pending = true;
    root.setAttribute("aria-busy", "true");
    for (const control of root.querySelectorAll("button, input, select")) control.disabled = true;
    // Dismiss before the durable operation finishes. The synchronous claim
    // above makes even a double click one operation, while the detached panel
    // can no longer accept another time choice during storage or Vault work.
    root.dispatchEvent(new CustomEvent(ANCHORED_PANEL_COMMIT_EVENT, { bubbles: true }));
    try {
      await commit(dueAt, recur.value || undefined);
    } catch (error) {
      reportFailure("Snooze save", error, console.error);
    }
  };
  root = el("div", { class: "snoozebar palette-form" },
    el("div", { class: "palette-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_quick_choices")),
      el("div", { class: "palette-choice-grid" },
        ...INBOX_SNOOZE_PRESETS.map((preset) =>
          el("button", { type: "button", class: "mini", onclick: () => { void go(presetDue(preset)); } },
            listSnoozePresetLabel(preset))))),
    el("div", { class: "palette-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_custom_time")),
      el("div", { class: "palette-control-row" },
        custom,
        el("button", { type: "button", class: "mini", onclick: () => {
          const t = new Date(custom.value).getTime();
          if (Number.isFinite(t) && t > Date.now()) void go(t);
        } }, localeMessage("list_set")))),
    el("label", { class: "palette-field palette-field-inline" },
      el("span", { class: "palette-field-label" }, localeMessage("list_repeat")), recur));
  return root;
}
