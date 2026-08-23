/**
 * P11-14 organization controls shared by Labels and Sessions.
 *
 * The domain module owns storage, merge, stale, and Undo behavior. This module
 * owns one interaction grammar: a same-page group lens plus anchored top-layer
 * palettes for creation, membership, rename, and group-only deletion.
 */
import { el } from "./dom.js";
import { createAnchoredPanel } from "./tablist.js";
import { msg } from "../lib/i18n.js";
import { listUnit } from "./list-copy.js";
import {
  createOrganizationGroup,
  renameOrganizationGroup,
  deleteOrganizationGroup,
  replaceMemberGroups,
  replaceGroupMembers
} from "../lib/organization.js";

export const ALL_ORGANIZATION_LENS = "all";
export const UNGROUPED_ORGANIZATION_LENS = "ungrouped";

/** Root creation policy is pure so an empty-group navigation jump stays locked down. */
export function organizationLensAfterRootCreate(currentLens, _createdGroupId) {
  return currentLens;
}

/** Creating a populated group must not move the user away from their current lens. */
export function organizationLensAfterMemberCreate(currentLens, _createdGroupId) {
  return currentLens;
}

const labelsFor = (kind) => kind === "label"
  ? { singular: msg("organization_label_singular"), plural: msg("organization_label_plural"),
      title: msg("organization_label_groups") }
  : { singular: msg("organization_session_singular"), plural: msg("organization_session_plural"),
      title: msg("organization_session_groups") };

const groupRecord = (entry) => entry?.group ?? entry;
const groupName = (entry) => groupRecord(entry)?.name ?? msg("organization_unnamed_group");
const groupId = (entry) => groupRecord(entry)?.id;
const groupCount = (entry) => Number(entry?.count ?? entry?.members?.length ?? 0);
const memberName = (kind, member) => kind === "label"
  ? String(member?.label ?? member ?? "")
  : String(member?.name || msg("organization_unnamed_member"));

/** Resolve stable focus after a membership render replaces or removes its card. */
export function organizationMembershipFocusTarget(root, kind, memberKey, activeLens) {
  const cardId = kind === "label" ? `label::${memberKey}` : memberKey;
  const card = [...root.querySelectorAll("[data-tablist-card]")]
    .find((node) => node.getAttribute("data-tablist-card") === cardId);
  const cardAction = card?.querySelector('[data-action-id="groups"]');
  if (cardAction) return cardAction;
  const row = root.querySelector(`.organization-row[data-organization-kind="${kind}"]`);
  const create = [...(row?.querySelectorAll("[data-organization-command]") ?? [])]
    .find((node) => node.dataset.organizationCommand === "create");
  return create ?? [...(row?.querySelectorAll("[data-organization-lens]") ?? [])]
    .find((node) => node.dataset.organizationLens === activeLens) ?? null;
}

/** Reveal the content chosen by a group lens after its replacement render. */
export function revealOrganizationLensResult(root, stickyOffset) {
  const card = root?.querySelector?.("[data-tablist-card]");
  const local = root?.querySelector?.(".section-local-sticky");
  const target = card ?? local;
  if (!(target instanceof HTMLElement) || !target.isConnected ||
      typeof target.scrollIntoView !== "function") return false;
  const fullOffset = Math.max(0, Number(stickyOffset) || 0);
  const localHeight = local?.getBoundingClientRect?.().height ?? 0;
  const clearance = card ? fullOffset + 12 : Math.max(0, fullOffset - localHeight);
  target.style.scrollMarginTop = `${clearance}px`;
  target.scrollIntoView({ block: "start", behavior: "auto" });
  return true;
}

function resultMessage(result) {
  if (result?.ok !== false) return "";
  return {
    "invalid-name": msg("organization_invalid_name"),
    "duplicate-name": msg("organization_duplicate_name"),
    "reserved-name": msg("organization_reserved_name"),
    stale: msg("organization_stale"),
    missing: msg("organization_missing"),
    "not-found": msg("organization_missing"),
    "invalid-member": msg("organization_invalid_member"),
    "invalid-members": msg("organization_invalid_members"),
    "invalid-groups": msg("organization_invalid_groups"),
    snapshot: msg("organization_snapshot_excluded")
  }[result.reason] ?? msg("organization_nothing_changed");
}

function feedbackNode() {
  const note = el("p", { class: "organization-feedback", role: "status", "aria-live": "polite" });
  note.hidden = true;
  return {
    node: note,
    show(message) {
      note.textContent = message;
      note.hidden = !message;
    }
  };
}

function textCreator({ kind, onCreated, memberKeys = [], autofocus = false }) {
  const copy = labelsFor(kind);
  const feedback = feedbackNode();
  const input = el("input", {
    type: "text", class: "organization-name-input", maxlength: "64",
    placeholder: msg("organization_group_name_placeholder", [copy.singular]),
    "aria-label": msg("organization_new_group_name", [copy.singular])
  });
  const create = el("button", { class: "primary", type: "button" }, msg("organization_create_group"));
  const commit = async () => {
    const result = await createOrganizationGroup(kind, input.value, memberKeys);
    if (result?.ok === false) {
      feedback.show(resultMessage(result));
      input.focus();
      return;
    }
    feedback.show("");
    await onCreated?.(result?.entry ?? result);
  };
  create.addEventListener("click", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });
  const node = el("div", { class: "organization-form" },
    el("label", { class: "palette-field" },
      el("span", { class: "palette-field-label" }, msg("organization_group_name")), input),
    feedback.node,
    el("div", { class: "organization-form-actions" }, create));
  if (autofocus) queueMicrotask(() => input.focus({ preventScroll: true }));
  return node;
}

function searchableChecks({ items, selected, nameFor, keyFor, empty, onNewGroup }) {
  const chosen = new Set(selected);
  const input = el("input", {
    type: "search", class: "organization-search", placeholder: msg("organization_filter_placeholder"),
    "aria-label": msg("organization_filter_choices")
  });
  const list = el("div", { class: "organization-checks", role: "group" });
  const emptyNote = el("p", { class: "organization-empty" }, empty);

  function render() {
    const q = input.value.trim().toLocaleLowerCase();
    list.replaceChildren();
    let visible = 0;
    for (const item of items) {
      const key = keyFor(item);
      const name = nameFor(item);
      if (q && !name.toLocaleLowerCase().includes(q)) continue;
      visible++;
      const checkbox = el("input", { type: "checkbox", checked: chosen.has(key) });
      checkbox.addEventListener("change", () => checkbox.checked ? chosen.add(key) : chosen.delete(key));
      list.append(el("label", { class: "organization-check" }, checkbox,
        el("span", { title: name }, name)));
    }
    emptyNote.hidden = visible > 0;
  }

  input.addEventListener("input", render);
  render();
  const nodes = [input, list, emptyNote];
  if (onNewGroup) {
    const creatorHost = el("div", { class: "organization-new-group", hidden: true });
    const reveal = el("button", { class: "organization-new-trigger", type: "button",
      onclick: () => {
        creatorHost.hidden = !creatorHost.hidden;
        reveal.setAttribute("aria-expanded", String(!creatorHost.hidden));
        if (!creatorHost.hidden && creatorHost.childNodes.length === 0) {
          creatorHost.append(onNewGroup());
        }
      }, "aria-expanded": "false" }, msg("organization_new_group"));
    nodes.push(reveal, creatorHost);
  }
  return { chosen, element: el("div", { class: "organization-picker" }, ...nodes) };
}

let groupEntrySeq = 0;

/**
 * Tag-style group assignment: the same two-Enter grammar used by Label input,
 * but with new group names held locally until Apply can commit the complete
 * membership change in one domain transaction.
 */
function groupEntryPicker({ groups, selected, onSubmit, onCancel }) {
  const id = `organization-group-entry-${++groupEntrySeq}`;
  const available = groups.map((entry) => ({ id: groupId(entry), name: groupName(entry) }));
  const selectedIds = new Set([...selected].filter((group) => available.some((entry) => entry.id === group)));
  const pendingNames = [];
  const chips = el("span", { class: "tagchips" });
  const input = el("input", {
    type: "text", class: "taginput", placeholder: msg("organization_groups_placeholder"), maxlength: "64",
    role: "combobox", "aria-label": msg("organization_groups"), "aria-autocomplete": "list",
    "aria-expanded": "false", "aria-controls": `${id}-list`
  });
  const menu = el("div", { class: "tagmenu hidden", role: "listbox", id: `${id}-list` });
  const box = el("span", { class: "tagbox organization-group-entry" }, chips, input, menu);
  let options = [];
  let selectedOption = -1;

  const normalized = (value) => String(value ?? "").trim().toLocaleLowerCase();
  const existingByName = (name) => available.find((entry) => normalized(entry.name) === normalized(name));

  function closeMenu() {
    menu.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selectedOption = -1;
  }

  function renderChips() {
    const entries = [
      ...available.filter((entry) => selectedIds.has(entry.id))
        .map((entry) => ({ key: `id:${entry.id}`, name: entry.name, remove: () => selectedIds.delete(entry.id) })),
      ...pendingNames.map((name) => ({ key: `new:${normalized(name)}`, name,
        remove: () => pendingNames.splice(pendingNames.indexOf(name), 1) }))
    ];
    chips.replaceChildren(...entries.map((entry) => el("span", { class: "chip", "data-group-key": entry.key },
      entry.name, el("button", {
        class: "x", type: "button", "aria-label": msg("organization_remove_group", [entry.name]),
        onclick: (event) => {
          event.stopPropagation();
          entry.remove();
          renderChips();
          renderMenu();
        }
      }, "×"))));
  }

  function addExisting(entry) {
    if (!entry) return;
    selectedIds.add(entry.id);
    input.value = "";
    renderChips();
    closeMenu();
    input.focus({ preventScroll: true });
  }

  function addTyped(value = input.value) {
    const name = String(value ?? "").trim();
    if (!name) return false;
    const existing = existingByName(name);
    if (existing) {
      addExisting(existing);
      return true;
    }
    if (!pendingNames.some((candidate) => normalized(candidate) === normalized(name))) {
      pendingNames.push(name);
    }
    input.value = "";
    renderChips();
    closeMenu();
    input.focus({ preventScroll: true });
    return true;
  }

  function choose(option) {
    if (!option) return;
    if (option.type === "existing") addExisting(option.entry);
    else addTyped(option.name);
  }

  function renderMenu() {
    const query = input.value.trim();
    const q = normalized(query);
    options = available
      .filter((entry) => !selectedIds.has(entry.id) && (!q || normalized(entry.name).includes(q)))
      .map((entry) => ({ type: "existing", entry }));
    const exactExists = available.some((entry) => normalized(entry.name) === q) ||
      pendingNames.some((name) => normalized(name) === q);
    if (query && !exactExists) options.push({ type: "create", name: query });
    if (options.length === 0) { closeMenu(); return; }
    if (selectedOption >= options.length) selectedOption = options.length - 1;
    menu.replaceChildren(...options.map((option, index) => {
      const label = option.type === "existing"
        ? option.entry.name : msg("organization_create_group_named", [option.name]);
      return el("div", {
        class: `tagopt${option.type === "create" ? " create" : ""}${index === selectedOption ? " on" : ""}`,
        role: "option", id: `${id}-option-${index}`,
        "aria-selected": index === selectedOption ? "true" : "false",
        onmousedown: (event) => { event.preventDefault(); choose(option); }
      }, label);
    }));
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    if (selectedOption >= 0) input.setAttribute("aria-activedescendant", `${id}-option-${selectedOption}`);
    else input.removeAttribute("aria-activedescendant");
  }

  box.addEventListener("click", () => input.focus());
  input.addEventListener("focus", renderMenu);
  input.addEventListener("input", () => { selectedOption = -1; renderMenu(); });
  input.addEventListener("blur", () => setTimeout(closeMenu, 150));
  input.addEventListener("keydown", (event) => {
    const menuOpen = !menu.classList.contains("hidden");
    if (event.key === "ArrowDown" && menuOpen) {
      event.preventDefault();
      selectedOption = Math.min(selectedOption + 1, options.length - 1);
      renderMenu();
    } else if (event.key === "ArrowUp" && menuOpen) {
      event.preventDefault();
      selectedOption = Math.max(selectedOption - 1, 0);
      renderMenu();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (input.value.trim()) {
        if (menuOpen && selectedOption >= 0) choose(options[selectedOption]);
        else addTyped();
      } else {
        closeMenu();
        onSubmit?.();
      }
    } else if (event.key === "Tab" && input.value.trim()) {
      event.preventDefault();
      addTyped();
    } else if (event.key === "Backspace" && !input.value) {
      const lastPending = pendingNames.at(-1);
      if (lastPending) pendingNames.pop();
      else {
        const lastExisting = [...available].reverse().find((entry) => selectedIds.has(entry.id));
        if (lastExisting) selectedIds.delete(lastExisting.id);
      }
      renderChips();
    } else if (event.key === "Escape") {
      const wasOpen = menuOpen;
      closeMenu();
      if (!wasOpen) onCancel?.();
    }
  });
  renderChips();
  return {
    element: box,
    getSelection() {
      if (input.value.trim()) addTyped();
      return { groupIds: [...selectedIds], createNames: [...pendingNames] };
    }
  };
}

/** Members visible for one selected lens. The projection preserves caller sort. */
export function membersForOrganizationLens(projection, lens) {
  const views = lens === UNGROUPED_ORGANIZATION_LENS
    ? projection?.ungrouped ?? []
    : !lens || lens === ALL_ORGANIZATION_LENS
      ? projection?.all ?? []
      : projection?.groups?.find((entry) => groupId(entry) === lens)?.members ?? [];
  return views.map((view) => view?.member ?? view);
}

/**
 * Create one per-render controller. The returned cardAction is appended to the
 * existing Label/Session card action lane; groupRow sits inside createIndexBar.
 */
export function createOrganizationControls({
  kind, members, memberKey, projection, activeLens = ALL_ORGANIZATION_LENS,
  onLensChange, onChange, showNotice, focusRoot
}) {
  const copy = labelsFor(kind);
  const projectedGroups = [...(projection?.groups ?? [])]
    .sort((a, b) => groupName(a).localeCompare(groupName(b), undefined, { sensitivity: "base" }));
  const groupsById = new Map(projectedGroups.map((entry) => [groupId(entry), entry]));
  const selectedGroup = groupsById.get(activeLens) ?? null;
  const host = el("span", { class: "organization-row-actions" });
  const panel = createAnchoredPanel(host);

  // Dashboard mounts both namespaces in one document. Focus recovery must stay
  // inside the organization row that owns this controller, otherwise the two
  // identical All/Ungrouped controls can send Label focus into Sessions.
  const focusScope = () => (typeof focusRoot === "function" ? focusRoot() : focusRoot) ?? document;
  const findOrganizationRow = () =>
    focusScope().querySelector(`.organization-row[data-organization-kind="${kind}"]`);
  const findLens = (id) => [...(findOrganizationRow()?.querySelectorAll("[data-organization-lens]") ?? [])]
    .find((node) => node.dataset.organizationLens === id);
  const findCommand = (action, id = activeLens) =>
    [...(findOrganizationRow()?.querySelectorAll("[data-organization-command]") ?? [])]
      .find((node) => node.dataset.organizationCommand === action &&
        (!id || node.dataset.organizationGroupId === id));
  const findCardGroupAction = (key) => {
    return organizationMembershipFocusTarget(focusScope(), kind, key, activeLens);
  };
  const restoreFocus = (find) => {
    let tracked = document.activeElement;
    const tryFocus = () => {
      const target = find?.();
      const active = document.activeElement;
      const focusStillOurs = active === tracked || active === target || active === document.body ||
        !(active instanceof HTMLElement) || !active.isConnected;
      if (!focusStillOurs) return; // The user deliberately moved elsewhere.
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true });
        tracked = target;
      }
    };
    // A coalesced storage refresh can replace the first focused node after the
    // current microtask. Re-resolve its stable identity across a short bounded
    // window. Timers also run when a hidden document suppresses animation
    // frames; the ownership guard above prevents every later retry from
    // stealing focus after the user moves elsewhere.
    queueMicrotask(tryFocus);
    setTimeout(tryFocus, 0);
    setTimeout(tryFocus, 40);
    setTimeout(tryFocus, 120);
  };
  const refreshAndFocus = async (find) => {
    await onChange?.();
    restoreFocus(find);
  };

  const changeLens = (lens) => onLensChange?.(lens);
  const lensButton = (id, label, count) => el("button", {
    class: `organization-lens${activeLens === id ? " on" : ""}`,
    type: "button", "aria-pressed": String(activeLens === id),
    "data-organization-lens": id,
    title: msg("organization_lens_count", [label, listUnit(kind, count)]),
    onclick: async () => {
      await changeLens(id);
      restoreFocus(() => findLens(id));
    }
  }, el("span", { class: "organization-lens-name" }, label),
  el("span", { class: "organization-lens-count" }, String(count)));

  const createPanel = (afterCreate, memberKeys = [], { autofocus = false, focusAfter } = {}) =>
    textCreator({ kind, memberKeys, autofocus, onCreated: async (created) => {
    await afterCreate?.(created);
    await refreshAndFocus(() => focusAfter?.(created));
  }});

  const createButton = el("button", {
    class: "organization-command tip", type: "button",
    "data-organization-command": "create",
    "data-tip": msg("organization_create_new_group"), "aria-label": msg("organization_create_new_group"),
    onclick: (event) => {
      panel.anchor(event.currentTarget);
      panel.toggle(() => createPanel((created) => {
        const nextLens = organizationLensAfterRootCreate(activeLens, created.id);
        return nextLens === activeLens ? null : changeLens(nextLens);
      }, [], {
        focusAfter: () => findCommand("create", null)
      }), `new-${kind}-group`);
    }
  }, msg("organization_add_group"));
  host.append(createButton);

  if (selectedGroup) {
    const group = groupRecord(selectedGroup);
    const addButton = el("button", {
      class: "organization-command tip", type: "button",
      "data-organization-command": "add", "data-organization-group-id": group.id,
      "data-tip": msg("organization_add_members_to_group", [copy.plural]),
      "aria-label": msg("organization_add_members_to_group", [copy.plural]),
      onclick: (event) => {
        panel.anchor(event.currentTarget);
        panel.toggle(() => {
          const feedback = feedbackNode();
          const currentKeys = new Set(selectedGroup.memberKeys ??
            selectedGroup.members?.map((view) => view?.key ?? memberKey(view?.member ?? view)) ?? []);
          let picker;
          picker = searchableChecks({
            items: [...members], selected: currentKeys,
            nameFor: (member) => memberName(kind, member), keyFor: memberKey,
            empty: msg("organization_no_members_match", [copy.plural]),
            onNewGroup: () => createPanel((created) => {
              const nextLens = organizationLensAfterMemberCreate(activeLens, created.id);
              return nextLens === activeLens ? null : changeLens(nextLens);
            }, [...picker.chosen], {
              autofocus: true,
              focusAfter: () => findCommand("add", activeLens) ?? findLens(activeLens)
            })
          });
          const apply = el("button", { class: "primary", type: "button", onclick: async () => {
            const result = await replaceGroupMembers(kind, group.id, [...picker.chosen],
              projection?.groupRevisionById?.get(group.id));
            if (result?.ok === false) { feedback.show(resultMessage(result)); return; }
            showNotice?.(msg("organization_group_updated", [copy.singular]));
            await refreshAndFocus(() => findCommand("add", group.id) ?? findLens(group.id));
          } }, msg("organization_apply_members", [copy.plural]));
          return el("div", { class: "organization-form" }, picker.element, feedback.node,
            el("div", { class: "organization-form-actions" }, apply));
        }, `add-${kind}s-to-group`);
      }
    }, msg("organization_add_members", [copy.plural]));
    host.append(addButton);

    const manageButton = el("button", {
      class: "organization-command tip", type: "button",
      "data-organization-command": "manage", "data-organization-group-id": group.id,
      "data-tip": msg("organization_manage_group_tip"), "aria-label": msg("organization_manage_group_tip"),
      onclick: (event) => {
        panel.anchor(event.currentTarget);
        panel.toggle(() => {
          const feedback = feedbackNode();
          const input = el("input", { type: "text", class: "organization-name-input",
            value: group.name, maxlength: "64",
            "aria-label": msg("organization_group_name_placeholder", [copy.singular]) });
          const rename = el("button", { type: "button", onclick: async () => {
            const result = await renameOrganizationGroup(kind, group.id, selectedGroup.revision, input.value);
            if (result?.ok === false) { feedback.show(resultMessage(result)); return; }
            await refreshAndFocus(() => findCommand("manage", group.id) ?? findLens(group.id));
          } }, msg("action_rename"));
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            rename.click();
          });
          const danger = el("button", { class: "danger", type: "button" }, msg("organization_delete_group"));
          let armed = false;
          let disarmTimer = 0;
          const disarm = () => {
            clearTimeout(disarmTimer);
            disarmTimer = 0;
            armed = false;
            danger.textContent = msg("organization_delete_group");
            danger.setAttribute("aria-label", msg("organization_delete_group_named", [group.name]));
          };
          disarm();
          danger.addEventListener("click", async () => {
            if (!armed) {
              armed = true;
              danger.textContent = msg("organization_confirm_delete");
              danger.setAttribute("aria-label",
                msg("organization_confirm_delete_named", [group.name, copy.plural]));
              disarmTimer = setTimeout(() => { if (danger.isConnected) disarm(); }, 4_000);
              return;
            }
            clearTimeout(disarmTimer);
            const result = await deleteOrganizationGroup(kind, group.id, selectedGroup.revision);
            if (result?.ok === false) { disarm();
              feedback.show(resultMessage(result)); return; }
            await changeLens(UNGROUPED_ORGANIZATION_LENS);
            showNotice?.(msg("organization_deleted_notice", [group.name, copy.plural]));
            await refreshAndFocus(() => findLens(UNGROUPED_ORGANIZATION_LENS));
          });
          danger.addEventListener("focusout", () => { if (armed) disarm(); });
          return el("div", { class: "organization-form" },
            el("label", { class: "palette-field" },
              el("span", { class: "palette-field-label" }, msg("organization_group_name")), input),
            feedback.node,
            el("p", { class: "palette-help" }, msg("organization_delete_help", [copy.singular])),
            el("div", { class: "organization-form-actions" }, rename, danger));
        }, `manage-${kind}-group`);
      }
    }, msg("organization_manage"));
    host.append(manageButton);
  }

  const groupRow = el("div", { class: "organization-row", "aria-label": copy.title,
    "data-organization-kind": kind },
    el("span", { class: "organization-row-label" }, msg("organization_groups")),
    el("div", { class: "organization-lenses" },
      lensButton(ALL_ORGANIZATION_LENS, msg("organization_all"), projection?.all?.length ?? members.length),
      lensButton(UNGROUPED_ORGANIZATION_LENS, msg("organization_ungrouped"),
        projection?.ungrouped?.length ?? members.length),
      ...projectedGroups.map((entry) => lensButton(groupId(entry), groupName(entry), groupCount(entry)))),
    host);

  const cardAction = {
    id: "groups", label: msg("organization_choose_groups", [copy.singular]),
    shortLabel: msg("organization_groups_placeholder"), icon: "cluster",
    run: (ctx) => ctx.panel.toggle(() => {
      const key = memberKey(ctx.group.data);
      const feedback = feedbackNode();
      const initial = projection?.groupIdsByMemberKey?.get(key) ?? [];
      let apply;
      const picker = groupEntryPicker({
        groups: projectedGroups, selected: initial,
        onSubmit: () => apply?.click(),
        onCancel: () => ctx.panel.close()
      });
      apply = el("button", { class: "primary", type: "button", onclick: async () => {
        apply.disabled = true;
        apply.setAttribute("aria-busy", "true");
        const selection = picker.getSelection();
        const result = await replaceMemberGroups(kind, key, selection.groupIds,
          projection?.memberRevisionByKey?.get(key), { createNames: selection.createNames });
        if (result?.ok === false) {
          apply.disabled = false;
          apply.removeAttribute("aria-busy");
          feedback.show(resultMessage(result));
          return;
        }
        showNotice?.(msg("organization_member_groups_updated", [memberName(kind, ctx.group.data)]));
        await refreshAndFocus(() => findCardGroupAction(key));
      } }, msg("organization_apply_groups"));
      const field = el("div", { class: "palette-field palette-label-field" },
        el("span", { class: "palette-field-label" }, msg("organization_groups")), picker.element,
        el("span", { class: "palette-help" }, msg("organization_entry_help")));
      queueMicrotask(() => picker.element.querySelector("input")?.focus({ preventScroll: true }));
      return el("div", { class: "organization-form" }, field, feedback.node,
        el("div", { class: "organization-form-actions" }, apply));
    }, `organization-${kind}`)
  };

  return { groupRow, cardAction };
}
