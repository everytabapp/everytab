// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real toolbar-action popup geometry using only a disposable Chrome profile. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import {
  CdpClient, attachTarget, captureFixture, chromeBin, debuggingUrl,
  detectExtension, evaluate, extensionRoot, prepareSession, seedExpression,
  startFixtureServer, createTarget, SITES
} from "./capture-store-screenshots.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "everytab-popup-action-"));
const server = await startFixtureServer();
const hosts = [...new Set(Object.values(SITES).map((site) => site.host))]
  .map((host) => `MAP ${host} 127.0.0.1`).join(",");
let browser;
let sender;
let popup;

try {
  browser = spawnOwnedChrome(chromeBin, [
    "--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`, `--host-resolver-rules=${hosts}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debug = await debuggingUrl(browser);
  const id = await detectExtension(debug);
  sender = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(sender);
  await evaluate(sender, seedExpression(captureFixture(server.port)));
  const publicUrl = captureFixture(server.port).sites.gutenbergShelf.url;
  const opened = await evaluate(sender, `(async () => {
    const current = await chrome.tabs.getCurrent();
    const tab = await chrome.tabs.create({windowId:current.windowId,
      url:${JSON.stringify(publicUrl)}, active:true});
    const labels = await import(chrome.runtime.getURL('js/lib/labels.js'));
    await labels.saveLabeledCopies([{
      url:${JSON.stringify(publicUrl)}, title:'Bookshelves', favIconUrl:''
    }], ['Reading', 'Reference', 'Research']);
    await chrome.windows.update(current.windowId, {focused:true});
    await new Promise(resolve => setTimeout(resolve, 250));
    await chrome.action.openPopup({windowId:current.windowId});
    return {tabId:tab.id, windowId:tab.windowId};
  })()`);
  assert.ok(opened?.tabId, "the disposable public tab opened");

  const client = new CdpClient(debug);
  let popupTarget;
  const deadline = Date.now() + 5_000;
  while (!popupTarget && Date.now() < deadline) {
    const targets = (await client.send("Target.getTargets")).targetInfos ?? [];
    popupTarget = targets.find((target) =>
      target.url === `chrome-extension://${id}/popup.html`);
    if (!popupTarget) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  client.close();
  assert.ok(popupTarget, "Chrome exposed the actual toolbar popup target");
  popup = await attachTarget(debug, popupTarget.targetId);
  await popup.send("Page.enable");
  await popup.send("Runtime.enable");
  await evaluate(popup, `new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = () => {
      if (document.body?.classList.contains('popup-ready')) resolve(true);
      else if (performance.now() - started > 5_000) reject(new Error('popup hydration'));
      else setTimeout(inspect, 20);
    };
    inspect();
  })`);
  const state = await evaluate(popup, `(() => {
    const app = document.querySelector('#app');
    const footer = document.querySelector('.linkrow');
    const visible = (node) => node && getComputedStyle(node).visibility === 'visible';
    return {
      viewport:{width:innerWidth,height:innerHeight},
      app:{client:app.clientHeight,scroll:app.scrollHeight,bottom:app.getBoundingClientRect().bottom},
      groups:document.querySelectorAll('.group').length,
      labels:document.querySelectorAll('.tablabels .labelchip').length,
      groupVisible:visible(document.querySelector('.group')),
      footerBottom:footer?.getBoundingClientRect().bottom ?? null,
      ready:document.body.classList.contains('popup-ready')
    };
  })()`);
  assert.ok(state.ready && state.groups >= 3 && state.groupVisible && state.labels === 2,
    `the hydrated popup exposes its action groups: ${JSON.stringify(state)}`);
  assert.ok(state.viewport.height >= 400 && state.app.client >= 400 &&
    state.footerBottom <= state.viewport.height + 1,
    `the real toolbar popup expands beyond its blank strip and contains its footer: ${JSON.stringify(state)}`);
  const navigation = await evaluate(popup, `(async () => {
    const press = (key, target = document.activeElement) =>
      (target || document).dispatchEvent(new KeyboardEvent('keydown', {
        key, code:key, bubbles:true, cancelable:true
      }));
    document.activeElement?.blur?.();
    press('ArrowDown', document);
    const first = document.activeElement;
    const firstRect = first?.getBoundingClientRect?.();
    press('ArrowRight');
    const second = document.activeElement;
    const secondRect = second?.getBoundingClientRect?.();
    press('ArrowDown');
    const third = document.activeElement;
    const thirdRect = third?.getBoundingClientRect?.();
    const remembered = third;
    const input = document.querySelector('.search-input');
    input.focus({preventScroll:true});
    const started = performance.now();
    while (!document.querySelector('.ghost-chip') && performance.now() - started < 3000) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const suggestion = document.querySelector('.ghost-chip');
    suggestion?.focus({preventScroll:true});
    press('Escape');
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      first:{tag:first?.tagName ?? '', label:first?.getAttribute?.('aria-label') ?? first?.textContent?.trim() ?? '',
        left:firstRect?.left ?? null, top:firstRect?.top ?? null},
      second:{tag:second?.tagName ?? '', label:second?.getAttribute?.('aria-label') ?? second?.textContent?.trim() ?? '',
        left:secondRect?.left ?? null, top:secondRect?.top ?? null},
      third:{tag:third?.tagName ?? '', label:third?.getAttribute?.('aria-label') ?? third?.textContent?.trim() ?? '',
        left:thirdRect?.left ?? null, top:thirdRect?.top ?? null},
      suggestion:Boolean(suggestion),
      restored:document.activeElement === remembered
    };
  })()`);
  assert.equal(navigation.first.tag, "BUTTON",
    `ArrowDown enters the first popup action from unfocused chrome: ${JSON.stringify(navigation)}`);
  assert.equal(navigation.second.tag, "BUTTON",
    `ArrowRight moves across the popup action line: ${JSON.stringify(navigation)}`);
  assert.notEqual(navigation.second.label, navigation.first.label,
    `ArrowRight reaches a different action: ${JSON.stringify(navigation)}`);
  assert.equal(navigation.third.tag, "BUTTON",
    `ArrowDown moves to another popup action line: ${JSON.stringify(navigation)}`);
  assert.ok(navigation.third.top > navigation.second.top + 1,
    `ArrowDown advances vertically: ${JSON.stringify(navigation)}`);
  assert.ok(navigation.suggestion && navigation.restored,
    `Escape from a highlighted Search suggestion returns to popup arrow navigation: ${JSON.stringify(navigation)}`);
  console.log(`PASS: real toolbar popup frame ${JSON.stringify({ ...state, navigation })}`);
} finally {
  popup?.close();
  sender?.close();
  if (browser) await terminateOwnedChrome(browser);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
