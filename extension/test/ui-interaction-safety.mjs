import { installDomFixture } from './dom-fixture.mjs';
import { createChromeI18nMock } from './message-fixture.mjs';
const fixture = installDomFixture();
globalThis.CSS = { escape: value => String(value).replace(/[^a-z0-9_-]/gi, char => `\\${char}`) };
const messages = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: p => `chrome-extension://fixture/${p}`, sendMessage: async message => { messages.push(message); return { ok: true }; } },
  permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
};
try {
  const { exerciseUiInteractionSafety } = await import('./ui-interaction-safety-cases.js');
  const host = document.createElement('div');
  document.body.append(host);
  await exerciseUiInteractionSafety({ host, messages, includeSearch: false,
    click: node => node.dispatch('click'), inputEvent: node => node.dispatch('input'),
    key: (node, init, type = 'keydown') => node.matches?.('.trow')
      ? document.dispatch(type, { target: node, ...init }) : node.dispatch(type, init)
  });
  console.log('PASS: refreshed row actions, composing input ownership and deliberate destructive shortcuts');
} finally { fixture.restore(); }
