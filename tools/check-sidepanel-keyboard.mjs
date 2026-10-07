// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Mounted Side Panel keyboard-entry and arrow-navigation regression. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import {
  createTarget, detectExtension, evaluate, waitFor, prepareSession,
  startFixtureServer, captureFixture, seedExpression, debuggingUrl,
  chromeBin, extensionRoot, SITES
} from "./capture-store-screenshots.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "everytab-sidepanel-keyboard-"));
const server = await startFixtureServer();
const hosts = [...new Set(Object.values(SITES).map((site) => site.host))]
  .map((host) => `MAP ${host} 127.0.0.1`).join(",");
let browser;
let sender;
let panel;

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
  panel = await createTarget(debug, `chrome-extension://${id}/sidepanel.html`);
  await prepareSession(panel);
  await panel.send("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 712, deviceScaleFactor: 1, mobile: false
  });
  await waitFor(panel,
    "document.querySelector('.sidepanel-shell') && document.querySelectorAll('[data-panel-section=\"open\"] .trow').length >= 3",
    "Side Panel Open rows", 20_000);

  const registeredCommands = await evaluate(sender,
    "chrome.commands.getAll().then(commands => commands.map(({name,shortcut}) => ({name,shortcut})))");
  const requiredCommands = ["open-popup", "open-search-popup", "dump-window", "open-side-panel"];
  for (const name of requiredCommands) {
    assert.ok(registeredCommands.find((command) => command.name === name)?.shortcut,
      `${name} has a live Chrome shortcut: ${JSON.stringify(registeredCommands)}`);
  }

  const arrowState = await evaluate(panel, `(async () => {
    const press = (key, target = document.activeElement) =>
      (target || document).dispatchEvent(new KeyboardEvent('keydown', {
        key, code:key, bubbles:true, cancelable:true
      }));
    const selectedTab = document.querySelector('.switch-tab[aria-selected="true"]');
    selectedTab.focus({preventScroll:true});
    press('ArrowDown');
    const firstUnit = document.activeElement?.closest?.('.trow, .item');
    press('ArrowDown');
    const secondUnit = document.activeElement?.closest?.('.trow, .item');
    const remembered = document.activeElement;
    const rememberedUnit = secondUnit;
    const unitKey = (unit) => unit?.dataset?.tablistRow || unit?.dataset?.tablistCard || '';
    const unitsBefore = [...document.querySelectorAll('.panel-body .trow, .panel-body .item')]
      .filter(node => node.offsetParent !== null);
    const rememberedOrdinal = unitsBefore.indexOf(rememberedUnit);
    const rememberedKey = unitKey(rememberedUnit);
    const input = document.querySelector('.search-input');
    input.focus({preventScroll:true});
    const started = performance.now();
    while (!document.querySelector('.ghost-chip') && performance.now() - started < 3000) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const suggestion = document.querySelector('.ghost-chip');
    suggestion?.focus({preventScroll:true});
    press('Escape');
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const activeUnit = document.activeElement?.closest?.('.trow, .item');
    const unitsAfter = [...document.querySelectorAll('.panel-body .trow, .panel-body .item')]
      .filter(node => node.offsetParent !== null);
    return {
      first:Boolean(firstUnit),
      second:Boolean(secondUnit),
      advanced:Boolean(firstUnit && secondUnit && firstUnit !== secondUnit),
      suggestion:Boolean(suggestion),
      restored:document.activeElement === remembered,
      restoredUnit:activeUnit === rememberedUnit,
      restoredPosition:Boolean(activeUnit && ((rememberedKey && unitKey(activeUnit) === rememberedKey) ||
        unitsAfter.indexOf(activeUnit) === rememberedOrdinal)),
      rememberedTag:remembered?.tagName ?? '',
      activeTag:document.activeElement?.tagName ?? '',
      activeClass:document.activeElement?.className ?? ''
    };
  })()`);
  assert.ok(arrowState.first && arrowState.second && arrowState.advanced &&
    arrowState.suggestion && arrowState.restoredPosition,
  `Side Panel arrows enter and resume its current list position: ${JSON.stringify(arrowState)}`);

  const windowId = await evaluate(sender, "chrome.windows.getCurrent().then(win => win.id)");
  await evaluate(sender,
    `chrome.runtime.sendMessage({type:'focus-side-panel-navigation',windowId:${Number(windowId)}})`);
  await waitFor(panel,
    "document.activeElement?.matches?.('.switch-tab[aria-selected=\"true\"]')",
    "shortcut focus handoff to selected Side Panel section");
  const focusState = await evaluate(panel, `({
    selected:document.activeElement?.textContent?.trim() ?? '',
    focused:document.activeElement?.matches?.('.switch-tab[aria-selected="true"]') === true
  })`);
  assert.equal(focusState.focused, true,
    `the shortcut handoff makes Side Panel arrows immediately available: ${JSON.stringify(focusState)}`);
  console.log(`PASS: Side Panel keyboard entry ${JSON.stringify({
    shortcuts: registeredCommands.filter((command) => requiredCommands.includes(command.name)),
    arrowState, focusState
  })}`);
} finally {
  panel?.close();
  sender?.close();
  if (browser) await terminateOwnedChrome(browser);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
