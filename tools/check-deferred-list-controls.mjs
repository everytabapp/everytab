// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Native qualification of deferred list controls in an owned, empty profile.
 * Run explicitly with Node. JSON is emitted only after successful cleanup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";
import { cleanupInboxMeasurement } from "./testing/inbox-measurement-cleanup.mjs";

assert.equal(process.argv.length, 2, "This qualification takes no arguments");
const sourcePaths = ["manifest.json", "js/ui/list-helpers.js", "js/ui/tablist.js", "js/ui/combobox.js", "js/lib/i18n.js"];
async function hashes() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file,
    createHash("sha256").update(await readFile(path.join(extensionRoot, file))).digest("hex")])));
}
const sources = await hashes();
const profile = await mkdtemp(path.join(tmpdir(), "everytab-deferred-controls-"));
let browser, client, browserVersion, receipt;
let stage = "installation";
let diagnostic = null;
const sessions = [];
try {
  browser = spawnOwnedChrome(chromeBin, ["--headless=new", "--disable-gpu",
    "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-background-networking",
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, "--no-first-run", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debug = await debuggingUrl(browser);
  client = new CdpClient(debug);
  browserVersion = (await client.send("Browser.getVersion")).product;
  const manager = await createTarget(debug, "chrome://extensions");
  sessions.push(manager);
  await prepareSession(manager);
  await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await client.send("Extensions.loadUnpacked", { path: extensionRoot });
  const id = await detectExtension(debug);
  const url = `chrome-extension://${id}/dashboard.html#open`;
  const page = await createTarget(debug, url);
  sessions.push(page);
  await prepareSession(page);
  await evaluate(page, "chrome.storage.local.set({onboardingDone:true})");
  await page.send("Page.navigate", { url });
  await prepareSession(page);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Page.bringToFront");

  stage = "mount";
  await evaluate(page, `(async () => {
    const {confirmDelete, sessionComboboxButton} = await import(chrome.runtime.getURL('js/ui/list-helpers.js'));
    const original = chrome.i18n.getMessage;
    const keys = ['list_delete_question','action_cancel','list_session_picker_aria','list_session_picker_placeholder'];
    const expected = Object.fromEntries([...keys,'action_delete'].map(key => [key, original.call(chrome.i18n,key)]));
    const calls = Object.fromEntries(keys.map(key => [key,0]));
    const host = document.createElement('section');
    host.id = 'deferred-controls-fixture';
    host.style.cssText = 'position:fixed;inset:40px auto auto 40px;z-index:2147483647;padding:24px;background:white;color:black;display:flex;gap:24px';
    const state = window.deferredControls = {expected,calls,confirmed:{default:0,custom:0},picked:0};
    const mount = (id,node) => { const wrap=document.createElement('div'); wrap.id=id; wrap.append(node); host.append(wrap); };
    chrome.i18n.getMessage = function(key,...args) {
      if (Object.hasOwn(calls,key)) calls[key]++;
      return Reflect.apply(original,this,[key,...args]);
    };
    try {
      mount('confirm-default',confirmDelete(() => state.confirmed.default++));
      mount('confirm-custom',confirmDelete(() => state.confirmed.custom++,'Remove fixture','Confirm fixture removal'));
      mount('picker-default',sessionComboboxButton('Choose fixture',{onPick:() => {state.picked++;return true;}}));
      mount('picker-custom',sessionComboboxButton('Choose custom fixture',{
        ariaLabel:'Fixture destination',placeholder:'Find fixture Session',
        onPick:() => {state.picked++;return true;}
      }));
    } finally { chrome.i18n.getMessage=original; }
    document.body.append(host);
  })()`);
  const initial = await evaluate(page, `({calls:deferredControls.calls,
    confirmationButtons:[...document.querySelectorAll('#confirm-default button,#confirm-custom button')].length,
    pickerTriggers:['default','custom'].every(kind=>{
      const b=document.querySelector('#picker-'+kind+' button');
      const label=kind==='default'?'Choose fixture':'Choose custom fixture';
      return b.title===label && b.getAttribute('aria-label')===label &&
        b.querySelector('.action-label').textContent===label &&
        b.getAttribute('aria-haspopup')==='dialog' && b.getAttribute('aria-expanded')==='false';
    }),
    dialogs:document.querySelectorAll('.action-popover').length})`);
  assert.deepEqual(initial, { calls: { list_delete_question: 0, action_cancel: 0,
    list_session_picker_aria: 0, list_session_picker_placeholder: 0 }, confirmationButtons: 2, pickerTriggers: true, dialogs: 0 });

  async function click(selector) {
    const point = await evaluate(page, `(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({block:'center'});
      const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      return r.width>0 && r.height>0 && node.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`);
    assert.ok(point, "Fixture control must have an unobstructed pointer target");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  }
  async function enter(selector) {
    await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).focus()`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  async function confirmation(kind, custom) {
    const selector = `#confirm-${kind}`;
    async function check(armed) {
      diagnostic = await evaluate(page, `(() => {
        const wrap=document.querySelector(${JSON.stringify(selector)}),buttons=[...wrap.querySelectorAll('button')];
        const label=${custom ? "'Remove fixture'" : "deferredControls.expected.action_delete"};
        const confirm=${custom ? "'Confirm fixture removal'" : "deferredControls.expected.list_delete_question"};
        const expected=${armed ? "[confirm,deferredControls.expected.action_cancel]" : "[label]"};
        return {count:buttons.length===expected.length,
          hint:buttons.every((b,i)=>(b.getAttribute('title') ?? b.dataset.tip)===expected[i]),
          aria:buttons.every((b,i)=>b.getAttribute('aria-label')===expected[i]),
          text:buttons.every((b,i)=>b.querySelector('.action-label')?.textContent===expected[i]),
          focus:${armed ? "document.activeElement===buttons[0]" : "true"}};
      })()`);
      assert.deepEqual(diagnostic, {count:true,hint:true,aria:true,text:true,focus:true},
        "Confirmation copy, control count and armed focus must match");
      diagnostic = null;
    }
    stage = `confirmation-${kind}-initial`;
    await check(false);
    stage = `confirmation-${kind}-pointer-arm`;
    await click(`${selector} button`);
    stage = `confirmation-${kind}-pointer-armed-copy`;
    await check(true);
    stage = `confirmation-${kind}-cancel`;
    await click(`${selector} button:last-child`);
    await check(false);
    stage = `confirmation-${kind}-keyboard-arm`;
    await evaluate(page, "deferredControls.resetStarted=performance.now()");
    await enter(`${selector} button`);
    stage = `confirmation-${kind}-keyboard-armed-copy`;
    await check(true);
    stage = `confirmation-${kind}-timeout`;
    await waitFor(page, `document.querySelector('${selector} .confirm-inline').classList.contains('armed')===false`, "confirmation reset", 6500);
    const elapsed = await evaluate(page, "performance.now()-deferredControls.resetStarted");
    assert.ok(elapsed >= 3900, "Confirmation must retain its four-second reset interval");
    await check(false);
    assert.equal(await evaluate(page, `deferredControls.confirmed.${kind}`), 0,
      "Cancel and timeout must not confirm");
    stage = `confirmation-${kind}-confirm-arm`;
    await click(`${selector} button`);
    await check(true);
    stage = `confirmation-${kind}-confirm-callback`;
    await click(`${selector} button:first-child`);
    assert.equal(await evaluate(page, `deferredControls.confirmed.${kind}`), 1);
    // Disarm after the synthetic callback; real owners normally refresh their card.
    stage = `confirmation-${kind}-final-disarm`;
    await click(`${selector} button:last-child`);
    return { defaultCopy: !custom, cancel: true, keyboardRearm: true, timeout: true, callbackCount: 1 };
  }
  stage = "confirmation-default";
  const defaultConfirmation = await confirmation("default", false);
  stage = "confirmation-custom";
  const customConfirmation = await confirmation("custom", true);

  async function picker(kind, custom) {
    const selector = `#picker-${kind} button`;
    for (const activate of [click, enter]) {
      await activate(selector);
      await waitFor(page, "document.activeElement?.matches('.action-popover input[role=combobox]')", "picker focus");
      assert.equal(await evaluate(page, `(() => {
        const input=document.activeElement,button=document.querySelector(${JSON.stringify(selector)});
        return input.getAttribute('aria-label')===${custom ? "'Fixture destination'" : "deferredControls.expected.list_session_picker_aria"} &&
          input.placeholder===${custom ? "'Find fixture Session'" : "deferredControls.expected.list_session_picker_placeholder"} &&
          button.getAttribute('aria-expanded')==='true';
      })()`), true, "Picker field must retain exact default or supplied copy");
      await click(".action-popover-close");
      await waitFor(page, `!document.querySelector('.action-popover') && document.activeElement===document.querySelector(${JSON.stringify(selector)})`, "picker close focus");
      assert.equal(await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`), "false");
    }
    return { defaultCopy: !custom, pointerOpen: true, keyboardReopen: true, focusedInput: true, closeFocus: true };
  }
  stage = "picker-default";
  const defaultPicker = await picker("default", false);
  stage = "picker-custom";
  const customPicker = await picker("custom", true);
  assert.equal(await evaluate(page, "deferredControls.picked"), 0, "Opening pickers must not commit a selection");
  stage = "source-stability";
  assert.deepEqual(await hashes(), sources, "Qualification source must remain unchanged");
  receipt = { initial, confirmations: [defaultConfirmation, customConfirmation], pickers: [defaultPicker, customPicker] };
} catch {
  // CDP errors can include page content; only controlled stage names escape.
  throw new Error(`Deferred list controls qualification failed at ${stage}${diagnostic ? ` ${JSON.stringify(diagnostic)}` : ''}`);
} finally {
  try {
    await cleanupInboxMeasurement({ sessions, client, browser, profile }, {
      terminateOwnedChrome, removeProfile: folder => rm(folder, { recursive: true, force: true })
    });
  } catch { throw new Error("Deferred list controls cleanup failed"); }
}
console.log(JSON.stringify({ schemaVersion: 1, runtime: JSON.parse(await readFile(path.join(extensionRoot,"manifest.json"))).version,
  browser: browserVersion, method: "Real imported controls in installed Dashboard; owned disposable empty profile; native CDP pointer and Enter input; real confirmation timers. Counter covers only synchronous control construction.",
  cleanup: { browser: true, profile: true }, sources, ...receipt }, null, 2));
