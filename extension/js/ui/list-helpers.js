/**
 * F14-2b — shared leaf UI helpers used across list surfaces.
 *
 * These are the small, self-contained cross-section pieces the list configs and
 * the Open surface pull in through their `ctx`: the status marker, the inline
 * validation flash, the two-step delete confirm, the inline card label panel, the
 * session-combobox button, and the generic selection→refs mapper. They hold no
 * module state and touch no storage beyond a read for the session picker, so both
 * the dashboard and the side panel can import them directly (one behavior source).
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createLabelInput } from "./labelinput.js";
import { swapInCombobox } from "./combobox.js";
import { listItems } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { linksToMarkdown, sessionToMarkdown } from "../lib/export.js";
import { RECURRENCE_OPTIONS, presetDue } from "../lib/snooze.js";
import { SORT_MODES } from "../lib/organize.js";
import { msg as localeMessage, pluralCategory } from "../lib/i18n.js";
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
 * Two-step delete control: first click arms ("Delete?" + Cancel), second confirms.
 * The action is still journaled + undoable, but the arm step gives the burned-tab-
 * hoarder persona felt safety at the exact moment their anxiety spikes — instead of
 * an instant delete backed only by a corner toast they might not be looking at.
 * @param {() => (void|Promise<void>)} onConfirm
 */
export function confirmDelete(onConfirm, label = localeMessage("action_delete")) {
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
  const yes = el("button", {
    class: "danger", title: localeMessage("list_confirm_delete"),
    "aria-label": localeMessage("list_confirm_delete"),
    onclick: () => onConfirm()
  }, ...content("delete", localeMessage("list_delete_question")));
  const no = el("button", {
    class: "mini2", title: localeMessage("action_cancel"), "aria-label": localeMessage("action_cancel"),
    onclick: () => reset()
  }, ...content(null, localeMessage("action_cancel")));
  function arm() {
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
 * P2g-1 — a button that swaps, in place, into the P2 session combobox:
 * pick an existing named session (append) or type a new name (create).
 * One control for every session-naming act — the promptName modal and the
 * add-to-session <select> are gone per interaction-model.md ("modals banned").
 * @param {string} label button text
 * @param {{cls?:string, title?:string, iconName?:string, actionId?:string, onPick:(v:{id:string|null,name:string,isNew:boolean})=>Promise<void>|void}} o
 */
export function sessionComboboxButton(label, {
  cls = "", title = "", iconName = "sessions", actionId = "", onPick
}) {
  const btn = el("button", { class: cls || null, title: title || label, "aria-label": title || label,
    ...(actionId ? { "data-action-id": actionId } : {}),
    onclick: () => swapInCombobox(btn, {
      ariaLabel: localeMessage("list_session_picker_aria"),
      placeholder: localeMessage("list_session_picker_placeholder"),
      loadOptions: async () =>
        (await listItems(STORE_KEYS.sessions))
          .filter((s) => !s.auto)
          .map((s) => ({ id: s.id, name: s.name })),
      createLabel: (v) => localeMessage("list_new_session_named", [v]),
      emptyCreateLabel: localeMessage("list_new_session_auto"),
      onCommit: onPick
    }) },
    iconName ? el("span", { class: "action-icon" }, icon(iconName, 14)) : null,
    el("span", { class: "action-label" }, label));
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
  const apply = el("button", { class: "mini primary palette-commit", onclick: async (e) => {
    if (apply.disabled) return;
    const labels = li.getLabels();
    if (labels.length === 0) {
      flashNote(e.currentTarget, localeMessage("list_type_label_first"));
      return;
    }
    apply.disabled = true;
    apply.setAttribute("aria-busy", "true");
    const priorText = apply.textContent;
    apply.textContent = localeMessage("list_saving");
    try {
      await applyFn(labels);
      // Success owns its own lifecycle. Do not wait for a section rerender to
      // eventually destroy this slot: the durable write is complete now.
      panel?.close();
    } catch (error) {
      console.error("EveryTab: label save failed", error);
      apply.disabled = false;
      apply.removeAttribute("aria-busy");
      apply.textContent = priorText;
      flashNote(apply, localeMessage("list_save_failed"));
    }
  } }, buttonText);
  const li = createLabelInput({ placeholder: localeMessage("list_labels_placeholder"), onSubmit: () => apply.click(),
    onCancel: () => panel?.close() });
  const bar = el("div", { class: "row-labelbar palette-form" },
    el("div", { class: "palette-field palette-label-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_add_labels")),
      li.element,
      el("span", { class: "palette-help" }, localeMessage("list_label_entry_help"))),
    apply);
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
  const go = (dueAt) => commit(dueAt, recur.value || undefined);
  const custom = el("input", { type: "datetime-local", class: "snooze-custom",
    "aria-label": localeMessage("list_custom_snooze_time") });
  return el("div", { class: "snoozebar palette-form" },
    el("div", { class: "palette-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_quick_choices")),
      el("div", { class: "palette-choice-grid" },
        ...INBOX_SNOOZE_PRESETS.map((preset) =>
          el("button", { class: "mini", onclick: () => go(presetDue(preset)) },
            listSnoozePresetLabel(preset))))),
    el("div", { class: "palette-field" },
      el("span", { class: "palette-field-label" }, localeMessage("list_custom_time")),
      el("div", { class: "palette-control-row" },
        custom,
        el("button", { class: "mini", onclick: () => {
          const t = new Date(custom.value).getTime();
          if (Number.isFinite(t) && t > Date.now()) go(t);
        } }, localeMessage("list_set")))),
    el("label", { class: "palette-field palette-field-inline" },
      el("span", { class: "palette-field-label" }, localeMessage("list_repeat")), recur));
}
