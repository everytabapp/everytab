import { STORE_KEYS } from "../lib/types.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { listItems } from "../lib/store.js";
import { restoreTabsFromItems, deleteTabsFromItems } from "../lib/actions.js";
import { deleteSavedItem } from "../lib/saved-item-actions.js";
import { restoreArchiveItem } from "../lib/archive.js";
import {
  applyLabels, labelTabsFromItems, removeLabel, removeLabelFromTab
} from "../lib/labels.js";
import { createLabelInput } from "./labelinput.js";
import { el, coalesce } from "./dom.js";
import { createTabList, fromArchiveItems } from "./tablist.js";
import {
  cardLabelPanel, confirmDelete, flashNote, selectionRefs
} from "./list-helpers.js";
import { starredRowAction } from "./starred-button.js";

const ARCHIVE_KEY = STORE_KEYS.archive;

/**
 * Owns Archive reads, mutations, list configuration, and rerendering.
 * The Dashboard host supplies only its stable heading/body slots and the two
 * cross-section navigation effects Archive legitimately needs.
 */
export function createArchiveSurface({
  getBody, setHeading, renderLabels, goToLabel, copyRefs
}) {
  const toSources = (selection) => selection.map((selected) => ({
    item: selected.group.data,
    indexes: selected.indexes
  }));

  const render = coalesce(renderInner);

  async function deleteArchiveItem(item) {
    await deleteSavedItem(
      ARCHIVE_KEY,
      item,
      localeMessage("list_deleted_archive_item"),
      { actionKind: "deleted-saved-item", actionParams: { location: "archive" } }
    );
    await render();
  }

  function openRowLabel(ctx) {
    ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
      await labelTabsFromItems(
        [{ item: ctx.group.data, indexes: [ctx.index] }],
        labels,
        ARCHIVE_KEY
      );
      await render();
      renderLabels();
    }, localeMessage("list_add_labels"), ctx.panel), "label");
  }

  async function renderInner() {
    /** @type {import("../lib/types.js").InboxItem[]} */
    const items = await listItems(ARCHIVE_KEY);
    setHeading(localeMessage("list_archive_heading", [formatNumber(items.length)]));

    getBody().replaceChildren(createTabList({
      section: "archive",
      foldable: true,
      groups: fromArchiveItems(items),
      selectable: "tab",
      onChange: render,
      empty: localeMessage("list_archive_empty"),
      onChipRemove: async (group, label) => {
        await removeLabel(ARCHIVE_KEY, group.data, label);
        await render();
        renderLabels();
      },
      onRowChipRemove: async (ctx, label) => {
        await removeLabelFromTab(ARCHIVE_KEY, ctx.group.data, ctx.index, label);
        await render();
        renderLabels();
      },
      onChipOpen: goToLabel,
      rowActions: [
        starredRowAction(),
        {
          id: "restore", label: localeMessage("search_action_restore"), icon: "switch", key: "r",
          run: async (ctx) => {
            await restoreTabsFromItems(
              [{ item: ctx.group.data, indexes: [ctx.index] }],
              ARCHIVE_KEY
            );
            await render();
          }
        },
        {
          id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
          run: openRowLabel
        },
        {
          id: "delete", label: localeMessage("action_delete"), glyph: "×", danger: true, key: "d",
          run: async (ctx) => {
            await deleteTabsFromItems(
              [{ item: ctx.group.data, indexes: [ctx.index] }],
              ARCHIVE_KEY
            );
            await render();
          }
        }
      ],
      groupActions: [
        {
          id: "restore-all", label: localeMessage("list_restore_all"), always: true, key: "r",
          run: async (ctx) => {
            await restoreArchiveItem(ctx.group.data);
            await render();
          }
        },
        {
          id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
          run: (ctx) => copyRefs(ctx.group.refs)
        },
        {
          id: "label-all", label: localeMessage("action_label"), key: "l",
          run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
            await applyLabels(ARCHIVE_KEY, ctx.group.data, labels);
            await render();
            renderLabels();
          }, localeMessage("list_label_all_tabs"), ctx.panel), "label")
        },
        {
          id: "delete-all", label: localeMessage("action_delete"), danger: true, always: true, key: "d",
          render: (ctx) => confirmDelete(() => deleteArchiveItem(ctx.group.data)),
          run: (ctx) => deleteArchiveItem(ctx.group.data)
        }
      ],
      bulkActions: ({ selection, clear }) => {
        const labelTags = createLabelInput({
          placeholder: localeMessage("list_labels_placeholder"),
          onSubmit: () => labelButton.click()
        });
        const labelButton = el("button", {
          title: localeMessage("list_archive_add_labels_title"),
          onclick: async (event) => {
            const labels = labelTags.getLabels();
            if (labels.length === 0) {
              flashNote(event.currentTarget, localeMessage("list_type_label_first"));
              return;
            }
            await labelTabsFromItems(toSources(selection), labels, ARCHIVE_KEY);
            clear();
          }
        }, localeMessage("list_add_label"));
        return [
          el("button", { onclick: async () => {
            await restoreTabsFromItems(toSources(selection), ARCHIVE_KEY);
            clear();
          } }, localeMessage("search_action_restore")),
          el("button", {
            title: localeMessage("list_copy_selected_title"),
            onclick: () => copyRefs(selectionRefs(selection))
          }, localeMessage("action_copy")),
          labelTags.element,
          labelButton,
          el("button", { class: "danger", onclick: async () => {
            await deleteTabsFromItems(toSources(selection), ARCHIVE_KEY);
            clear();
          } }, localeMessage("action_delete"))
        ];
      }
    }));
  }

  return { render };
}
