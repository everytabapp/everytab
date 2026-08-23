import { findDuplicateGroups } from "../lib/dedup.js";
import { el, coalesce } from "./dom.js";
import { icon } from "./icons.js";
import { createTabList, fromDuplicateGroups } from "./tablist.js";
import { shellSectionCountTitle } from "./shell-copy.js";

/** Mirrors the survivor order in findDuplicateGroups. */
export const DUPLICATE_KEEP_RULE =
  "EveryTab keeps the copy you are using, then an awake copy, then the oldest. Pinned tabs are never closed.";

/** Owns the complete Duplicates scan, presentation, and close actions. */
export function createDuplicatesSurface({ getBody, setHeading, msg }) {
  const render = coalesce(renderInner);

  async function renderInner() {
    const [groups, windows] = await Promise.all([
      findDuplicateGroups(),
      chrome.windows.getAll({ windowTypes: ["normal"] })
    ]);
    const total = groups.reduce((count, group) => count + group.close.length, 0);
    setHeading(shellSectionCountTitle("duplicates", total));
    const windowNumber = new Map(windows.map((window, index) => [window.id, index + 1]));
    const listGroups = fromDuplicateGroups(groups);

    getBody().replaceChildren(createTabList({
      section: "duplicates",
      foldable: true,
      groups: listGroups,
      selectable: "none",
      onChange: render,
      empty: "No duplicate tabs open.",
      toolbar: el("div", { class: "dup-toolbar" },
        el("div", { class: "dup-toolbar-copy" },
          el("strong", {}, total === 0
            ? "Every open page is unique."
            : `${total} extra ${total === 1 ? "copy" : "copies"} across ${listGroups.length} ${listGroups.length === 1 ? "page" : "pages"}.`),
          el("span", {}, DUPLICATE_KEEP_RULE)),
        el("div", { class: "dup-toolbar-acts" },
          el("button", {
            class: "quiet", title: "Scan the open tabs again", onclick: render
          },
          el("span", { class: "action-icon" }, icon("refresh", 14)),
          el("span", {}, "Rescan")),
          total > 0
            ? el("button", {
              class: "danger",
              title: "Close every extra copy. This is undoable",
              onclick: async () => {
                await msg({ type: "close-duplicates" });
                await render();
              }
            }, `Close ${total} extra ${total === 1 ? "copy" : "copies"}`)
            : null)),
      rowOpen: (ctx) => msg({
        type: "focus-tab", tabId: ctx.live.id, windowId: ctx.live.windowId
      }),
      rowMeta: (_ref, group, index) => {
        const tab = group.live[index];
        const role = tab.id === group.data.keepId
          ? "kept copy"
          : tab.pinned ? "pinned" : "extra";
        return `tab ${(tab.index ?? 0) + 1} · ${role}`;
      },
      rowBadges: (ctx) => {
        const windowLabel = windowNumber.get(ctx.live.windowId) ?? "?";
        const isKeep = ctx.live.id === ctx.group.data.keepId;
        return [
          isKeep
            ? el("span", { class: "dup-role", title: DUPLICATE_KEEP_RULE }, "Keep")
            : null,
          el("span", { class: "dup-window", title: `Open in window ${windowLabel}` },
            `Window ${windowLabel}`)
        ].filter(Boolean);
      },
      rowActions: [
        {
          id: "switch", label: "Switch", icon: "switch", key: "r", hidden: true,
          run: (ctx) => msg({
            type: "focus-tab", tabId: ctx.live.id, windowId: ctx.live.windowId
          })
        },
        {
          id: "close", label: "Close duplicate", glyph: "×", danger: true, key: "d",
          when: (ctx) => ctx.group.data.closeIds.has(ctx.live.id),
          run: async (ctx) => {
            await msg({ type: "close-duplicates", tabId: ctx.live.id });
            await render();
          }
        }
      ],
      groupActions: [{
        id: "close-extras", label: "Close extras", danger: true, key: "d",
        run: async (ctx) => {
          await msg({ type: "close-duplicates", key: ctx.group.data.key });
          await render();
        }
      }]
    }));
  }

  return { render };
}
