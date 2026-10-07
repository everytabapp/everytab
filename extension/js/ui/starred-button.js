// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { el } from "./dom.js";
import { msg as localeMessage } from "../lib/i18n.js";
import { icon } from "./icons.js";
import {
  canonicalStarUrl, isStarredUrl, listStarred, starTab, unstarUrl
} from "../lib/starred.js";
import { STORE_KEYS } from "../lib/types.js";
import { expandStorageChanges } from "../lib/storage/constants.js";

// One render creates many row buttons synchronously. Share their derived URL
// index for that batch only, then drop it. Persistence/invalidation remains
// solely owned by store.js, while 120 rows still issue one cached store read.
let renderBatch = null;
const liveControls = new Set();
let changeListenerInstalled = false;

function registerLiveControl(control) {
  liveControls.add({ ref: new WeakRef(control.button), url: control.url });
  if (changeListenerInstalled || !chrome.storage?.onChanged?.addListener) return;
  changeListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    changes = expandStorageChanges(changes);
    if (area !== "local" || !changes[STORE_KEYS.starred]) return;
    listStarred().then((items) => {
      const urls = new Set(items.map((item) => canonicalStarUrl(item.url)).filter(Boolean));
      for (const entry of [...liveControls]) {
        const button = entry.ref.deref();
        if (!button || !button.isConnected) {
          liveControls.delete(entry);
          continue;
        }
        button._setStarred?.(urls.has(entry.url));
      }
    });
  });
}
function starredInThisRender(url) {
  const canonical = canonicalStarUrl(url);
  if (!canonical) return Promise.resolve(false);
  if (!renderBatch) {
    const batch = listStarred().then((items) =>
      new Set(items.map((item) => canonicalStarUrl(item.url)).filter(Boolean)));
    renderBatch = batch;
    batch.finally(() => queueMicrotask(() => {
      if (renderBatch === batch) renderBatch = null;
    }));
  }
  return renderBatch.then((urls) => urls.has(canonical));
}

/** A self-reconciling Star/Unstar row control for every tab-bearing list. */
export function createStarredButton(ref) {
  let active = false;
  let pending = false;
  const glyph = el("span", { class: "action-icon" }, icon("star", 14));
  const label = el("span", { class: "action-label" }, localeMessage("starred_action_star"));
  const button = el("button", {
    class: "mini iconbtn star-action",
    type: "button",
    "data-action-id": "star",
    "aria-pressed": "false",
    onclick: async () => {
      if (pending) return;
      pending = true;
      button.disabled = true;
      const before = active;
      active = !active;
      paint();
      try {
        const changed = before ? await unstarUrl(ref.url) : await starTab(ref);
        if (!changed) active = await isStarredUrl(ref.url);
      } catch {
        active = before;
      } finally {
        pending = false;
        button.disabled = false;
        paint();
      }
    }
  }, glyph, label);

  function paint() {
    button.classList.toggle("is-starred", active);
    button.setAttribute("aria-pressed", String(active));
    const name = active ? localeMessage("starred_action_unstar_tab") : localeMessage("starred_action_star_tab");
    button.setAttribute("aria-label", name);
    button.title = name;
    label.textContent = active ? localeMessage("starred_action_unstar") : localeMessage("starred_action_star");
  }
  paint();
  button._setStarred = (value) => {
    if (pending) return;
    active = value;
    paint();
  };
  registerLiveControl({ button, url: canonicalStarUrl(ref.url) });
  starredInThisRender(ref.url).then((value) => {
    if (!pending && button.isConnected) {
      active = value;
      paint();
    }
  });
  return button;
}

/** createTabList row-action descriptor. */
export function starredRowAction() {
  return {
    id: "star",
    label: localeMessage("starred_action_star_tab"),
    key: "b",
    when: (ctx) => Boolean(canonicalStarUrl(ctx.ref?.url)),
    render: (ctx) => createStarredButton(ctx.ref)
  };
}
