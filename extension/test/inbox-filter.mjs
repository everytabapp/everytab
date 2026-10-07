import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { readFileSync } from "node:fs";

const checks = [];
const check = (condition, name) => {
  if (!condition) throw new Error(name);
  checks.push(name);
};

const fixture = installDomFixture();
try {
  document.addEventListener = () => {};
  document.removeEventListener = () => {};
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    runtime: { getURL: (path = "") => `chrome-extension://fixture/${path}` }
  };
  const { createTabList } = await import("../js/ui/tablist.js");
  const groups = [{
    id: "bundle-a",
    title: "Window · 2 tabs",
    data: { id: "bundle-a" },
    refs: [
      { title: "Alpha", url: "https://alpha.test/" },
      { title: "Needle", url: "https://example.test/needle" }
    ]
  }, {
    id: "bundle-b",
    title: "Single tab",
    data: { id: "bundle-b" },
    refs: [{ title: "Gamma", url: "https://gamma.test/" }]
  }];
  const root = createTabList({
    section: "inbox-filter-fixture",
    groups,
    rowVisible: ({ ref }) => `${ref.title}\n${ref.url}`.toLowerCase().includes("needle"),
    empty: "No matches"
  });
  const rows = root.querySelectorAll("[data-tablist-row]");
  check(rows.length === 1, "Inbox filtering renders only matching tabs");
  check(rows[0]._tlRow.ctx.index === 1,
    "a filtered Inbox row retains its original source index for actions");
  check(root.querySelectorAll("[data-tablist-card]").length === 1,
    "Inbox filtering omits bundles with no matching tab");

  const empty = createTabList({
    section: "inbox-filter-empty-fixture",
    groups,
    rowVisible: () => false,
    empty: "No matches"
  });
  check(empty.textContent === "No matches", "Inbox filtering has an honest no-match state");

  const computedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => ({...computedStyle(node), visibility:node.style.getPropertyValue('visibility') || 'visible'});
  const { createTabFilterControl } = await import('../js/ui/tab-filter-control.js');
  const filter = createTabFilterControl({ placeholder:'Filter', ariaLabel:'Filter open tabs',
    shortcut:'f', rerender() {} });
  document.body.append(filter.element);
  let visible = true, selected = 0;
  filter.input.getClientRects = () => visible ? [{}] : [];
  filter.input.select = () => { selected += 1; };
  const shortcut = (overrides = {}) => {
    let prevented = false;
    const handled = filter.handleShortcut({ key:'f', target:document.body,
      preventDefault() { prevented = true; }, ...overrides });
    return { handled, prevented };
  };
  document.body.focus();
  const focused = shortcut();
  check(focused.handled && focused.prevented && document.activeElement === filter.input && selected === 1,
    'F focuses and selects the Open filter');
  check(filter.input.getAttribute('aria-keyshortcuts') === 'f', 'Open filter exposes its shortcut');
  for (const event of [{key:'F'}, {key:'x'}, {ctrlKey:true}, {metaKey:true}, {altKey:true},
    {shiftKey:true}, {isComposing:true}, {keyCode:229}, {defaultPrevented:true}]) {
    document.body.focus();
    const result = shortcut(event);
    check(!result.handled && !result.prevented, 'unrelated, modified, composing and consumed keys stay untouched');
  }
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const field = document.createElement(tag);
    if (tag === 'div') field.isContentEditable = true;
    document.body.append(field);field.focus();
    check(!shortcut({target:field}).handled, 'typing keeps F in the field');
    check(!shortcut().handled, 'retargeted input keeps text-entry focus');
    field.remove();document.body.focus();
  }
  const checkbox = document.createElement('input');checkbox.type='checkbox';
  document.body.append(checkbox);checkbox.focus();
  check(shortcut({target:checkbox}).handled, 'F remains available from a row checkbox');
  document.body.focus();
  const dialog = document.createElement('div');dialog.setAttribute('role','dialog');
  dialog.getClientRects = () => [{}];document.body.append(dialog);
  check(!shortcut().handled, 'a visible dialog keeps its keyboard scope');
  dialog.style.setProperty('visibility', 'hidden');
  check(shortcut().handled, 'a visibility-hidden dialog does not block the filter');
  document.body.focus();
  dialog.getClientRects = () => [];
  check(shortcut().handled, 'a hidden dialog does not block the Open filter');
  dialog.remove();document.body.focus();
  const menu = document.createElement('div');menu.setAttribute('role','menu');
  const menuItem = document.createElement('button');menu.append(menuItem);document.body.append(menu);
  menu.getClientRects = () => [{}];menuItem.focus();
  check(!shortcut({target:menuItem}).handled, 'a visible More menu keeps keyboard focus');
  menu.getClientRects = () => [];document.body.focus();
  check(shortcut().handled, 'a hidden More menu does not block the filter');
  menu.remove();document.body.focus();
  visible = false;check(!shortcut().handled, 'hidden Open filter never takes focus');
  visible = true;filter.element.remove();check(!shortcut().handled, 'detached filter never takes focus');
  const plainFilter = createTabFilterControl({placeholder:'Filter',ariaLabel:'Filter Inbox',rerender() {}});
  check(!plainFilter.handleShortcut({key:'f'}), 'Inbox does not acquire an unrequested shortcut');

  const inboxSource = readFileSync(new URL("../js/ui/inbox-surface.js", import.meta.url), "utf8");
  const openSource = readFileSync(new URL("../js/ui/open-surface.js", import.meta.url), "utf8");
  check(inboxSource.includes("createTabFilterControl") && openSource.includes("createTabFilterControl"),
    "Inbox and Open mount the same focus-stable filter control");
} finally {
  fixture.restore();
  delete globalThis.chrome;
}

console.log(`PASS ${checks.length}: ${checks.join(" | ")}`);
