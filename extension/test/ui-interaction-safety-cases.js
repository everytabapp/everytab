/** Mounted interaction transitions shared by Node and disposable Chromium. */
import { createTabList, clearSelection, createAnchoredPanel } from '../js/ui/tablist.js';
import { createCombobox, swapInCombobox } from '../js/ui/combobox.js';
import { createLabelInput } from '../js/ui/labelinput.js';
import { createSearchBox } from '../js/ui/searchbox.js';

export async function exerciseUiInteractionSafety({ host, click, key, inputEvent, messages, includeSearch = true }) {
  const failures = [];
  const check = (condition, label) => { if (!condition) failures.push(label); };
  const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
  const refs = ['a', 'b', 'c'].map(name => ({ title: name, url: `https://${name}.test/` }));
  const section = 'interaction-row-actions';
  clearSelection(section);
  let acted = null;
  let list;
  const render = () => {
    list = createTabList({ section, groups: [{ id: 'group', title: 'Window', meta: '3 tabs', refs }],
      selectable: 'tab', rowActions: [{ id: 'copy', label: 'Copy', key: 'c', run: ctx => { acted = ctx.ref.url; } }],
      bulkActions: () => [], onChange() {} });
    host.replaceChildren(list);
  };
  render();
  await click(list.querySelectorAll('.trow')[0]);
  await click(list.querySelectorAll('.trow')[1]);
  render();
  const lane = list.querySelector('.tacts');
  check(lane.inert === true && lane.getAttribute('aria-hidden') === 'true',
    'fresh multi-selection render keeps row actions inaccessible');
  await click(list.querySelectorAll('.trow')[1]);
  let action = list.querySelector('[data-action-id="copy"]');
  check(Boolean(action), 'refresh then deselect restores row action buttons');
  check(list.querySelector('.tacts').inert === false && list.querySelector('.tacts').getAttribute('aria-hidden') === null,
    'deselection restores row action accessibility');
  if (action) await click(action);
  check(acted === refs[0].url, 'restored pointer action reaches its exact row');
  await click(list.querySelectorAll('.trow')[0]);
  check(list.querySelectorAll('.tacts button').length === 3, 'clearing selection leaves every row action present');
  acted = null;
  await key(list.querySelectorAll('.trow')[1], { key: 'c' });
  check(acted === refs[1].url, 'restored keyboard action reaches the focused row after refresh');

  for (const shortcut of ['Delete', 'Backspace', 'd']) {
    const section = `interaction-repeat-${shortcut}`;
    clearSelection(section);
    let deleted = 0;
    const danger = createTabList({ section, groups: [{ id: 'group', title: 'Saved', meta: '1 tab', refs: [refs[0]] }],
      rowActions: [{ id: 'delete', label: 'Delete', key: 'd', danger: true, run: () => { deleted++; } }] });
    host.replaceChildren(danger);
    const row = danger.querySelector('.trow');
    await key(row, { key: shortcut, repeat: false });
    check(deleted === 0, `${shortcut}: first press arms only`);
    await key(row, { key: shortcut, repeat: true });
    await key(row, { key: shortcut, repeat: true });
    check(deleted === 0, `${shortcut}: auto-repeat cannot confirm or rearm`);
    await key(row, { key: shortcut }, 'keyup');
    await key(row, { key: shortcut, repeat: false });
    check(deleted === 1, `${shortcut}: a second deliberate press confirms once`);
  }

  // Retargeted held keys must not arm a newly focused row. Expire the real
  // confirmation callback deterministically instead of waiting 2.5 seconds.
  const confirmationTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === 2500) confirmationTimers.push({ handle, callback });
    return handle;
  };
  try {
    let deleted = 0;
    const danger = createTabList({ section: 'interaction-danger-focus',
      groups: [{ id: 'group', title: 'Saved', meta: '2 tabs', refs: refs.slice(0, 2) }],
      rowActions: [{ id: 'delete', label: 'Delete', key: 'd', danger: true, run: () => { deleted++; } }] });
    host.replaceChildren(danger);
    const [first, second] = danger.querySelectorAll('.trow');
    first.querySelector('a').focus();
    await key(first, { key: 'Delete' });
    second.querySelector('a').focus();
    await key(second, { key: 'Delete', repeat: true });
    check(!second.classList.contains('armed-del') && deleted === 0,
      'held Delete cannot arm or delete after focus moves to another row');
    await key(second, { key: 'Delete' }, 'keyup');
    await key(second, { key: 'Delete' });
    check(second.classList.contains('armed-del') && deleted === 0,
      'a fresh press on the new row arms instead of confirming the previous row');
    const expiry = confirmationTimers.at(-1);
    clearTimeout(expiry.handle);
    expiry.callback();
    check(!second.classList.contains('armed-del'), 'confirmation timeout disarms the row');
    await key(second, { key: 'Delete' }, 'keyup');
    await key(second, { key: 'Delete' });
    check(deleted === 0, 'first press after confirmation timeout must arm again');
    await key(second, { key: 'Delete' }, 'keyup');
    await key(second, { key: 'Delete' });
    check(deleted === 1, 'two deliberate presses after timeout still confirm once');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    for (const timer of confirmationTimers) clearTimeout(timer.handle);
  }

  for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    let commits = 0;
    let cancellations = 0;
    const combo = createCombobox({ value: 'にほん', loadOptions: async () => [{ id: 'jp', name: 'にほん' }],
      onCommit: () => { commits++; }, onCancel: () => { cancellations++; } });
    host.replaceChildren(combo.element);
    const field = combo.element.querySelector('input');
    await pause();
    const selected = field.getAttribute('aria-activedescendant');
    for (const name of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter']) {
      const event = await key(field, { key: name, ...composition });
      check(!event.defaultPrevented, `combobox leaves composing ${name} with the input method`);
    }
    check(field.getAttribute('aria-activedescendant') === selected && !field.disabled && commits === 0 && cancellations === 0,
      'composing keys neither navigate, cancel nor commit the combobox');
    await key(field, { key: 'Enter' });
    check(commits === 1, 'ordinary Enter still commits the combobox');

    let submitted = 0;
    const labels = createLabelInput({ loadOptions: async () => ['にほん'], onSubmit: () => { submitted++; } });
    host.replaceChildren(labels.element);
    const labelField = labels.element.querySelector('input');
    labelField.value = 'にほん';
    await inputEvent(labelField);
    await pause();
    const labelActive = labelField.getAttribute('aria-activedescendant');
    for (const name of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab']) {
      const event = await key(labelField, { key: name, ...composition });
      check(!event.defaultPrevented, `Labels leaves composing ${name} with the input method`);
    }
    check(labelField.value === 'にほん' && labels.element.querySelectorAll('.chip').length === 0 && submitted === 0 &&
      labelField.getAttribute('aria-activedescendant') === labelActive,
      'composing Labels keys neither select a suggestion nor create chips');
    await key(labelField, { key: 'Enter' });
    check(labels.element.querySelectorAll('.chip').length === 1, 'ordinary Enter still creates a Label chip');
    await key(labelField, { key: 'Backspace', ...composition });
    check(labels.element.querySelectorAll('.chip').length === 1, 'composing Backspace cannot remove an existing Label chip');

    if (!includeSearch) continue;
    const search = createSearchBox({ searchSession: {
      invalidate() {}, async scopeNames() { return []; },
      async resolveFilters(raw) { return { scope: null, labels: [], query: raw }; },
      async searchProgressively() { return { results: refs.map((ref, i) => ({ ...ref, type: 'open', tabId: i + 1, windowId: 1 })), complete: null }; }
    } });
    host.replaceChildren(search);
    const searchField = search.querySelector('input');
    searchField.value = 'にほん';
    await inputEvent(searchField);
    await pause(140);
    const searchActive = searchField.getAttribute('aria-activedescendant');
    const before = messages.length;
    for (const name of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter']) {
      const event = await key(searchField, { key: name, ...composition });
      check(!event.defaultPrevented, `Search leaves composing ${name} with the input method`);
    }
    check(searchField.value === 'にほん' && searchField.getAttribute('aria-activedescendant') === searchActive && messages.length === before,
      'composing Search keys neither navigate results, clear the query nor activate a page');
    await key(searchField, { key: 'Enter' });
    check(messages.length === before + 1, 'ordinary Enter still activates Search');
  }

  // A real Session rename lives inside the header's own focus-walk listener.
  // Bubbling must leave composing keys with the field, not the header controls.
  if (includeSearch) {
    let cancelled = 0;
    let rename;
    const headerList = createTabList({ section: 'interaction-header-composition', foldable: true,
      groups: [{ id: 'session', title: 'Session', refs: [refs[0]] }],
      groupActions: [{ id: 'rename', label: 'Rename', render: () => {
        rename = document.createElement('button');
        rename.textContent = 'Rename';
        rename.addEventListener('click', () => swapInCombobox(rename, {
          value: 'Session', onCommit() {}, onCancel() { cancelled++; }
        }));
        return rename;
      } }]
    });
    host.replaceChildren(headerList);
    await click(rename);
    const field = headerList.querySelector('input[role="combobox"]');
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const name of ['ArrowLeft', 'ArrowRight', 'Escape']) {
        const event = await key(field, { key: name, ...composition });
        check(!event.defaultPrevented && field.isConnected && document.activeElement === field,
          `header leaves composing ${name} with the mounted rename input`);
      }
    }
    check(cancelled === 0, 'composing Escape does not cancel the nested rename');
    await key(field, { key: 'Escape' });
    check(cancelled === 1 && rename.isConnected && document.activeElement === rename,
      'ordinary Escape still cancels rename and restores its invoking button');
  }

  // This bubbles in Chromium: a field guard alone must not allow its palette
  // ancestor to consume Escape and discard the still-composing control.
  if (includeSearch) {
    const opener = document.createElement('button');
    host.replaceChildren(opener);
    const panel = createAnchoredPanel(opener);
    panel.anchor(opener);
    panel.toggle(() => createCombobox({ onCommit() {}, onCancel: () => panel.close({ restore: true }) }).element, 'session');
    const palette = document.querySelector('.action-popover');
    check(Boolean(palette), 'composition test mounts a real anchored palette');
    if (palette) {
      const field = palette.querySelector('input');
      const event = await key(field, { key: 'Escape', isComposing: true });
      check(!event.defaultPrevented && palette.isConnected, 'palette leaves composing Escape owned by its input');
      await key(field, { key: 'Escape' });
      check(!palette.isConnected, 'ordinary Escape still dismisses the anchored palette');
    }
    panel.close();
  }
  host.replaceChildren();
  if (failures.length) throw new Error(failures.join('\n'));
}
