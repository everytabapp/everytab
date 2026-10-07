// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Mounted Search backdrop checks. Only disposable Chrome data and local fixtures. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import {
  chromeBin, extensionRoot, SITES, startFixtureServer, debuggingUrl,
  detectExtension, createTarget, evaluate, prepareSession, waitFor,
  seedExpression, captureFixture
} from "./capture-store-screenshots.mjs";

const build = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8")).version;
const output = process.env.SEARCH_EMPHASIS_OUTPUT || path.resolve(`review-evidence/search-emphasis-v${build}`);
const profile = await mkdtemp(path.join(tmpdir(), "everytab-search-emphasis-"));
const server = await startFixtureServer();
const hosts = [...new Set(Object.values(SITES).map(site => site.host))]
  .map(host => `MAP ${host} 127.0.0.1`).join(",");
let browser;
let session;
const records = [];
const press = async key => {
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "Escape" ? 27 : 9 });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
};
try {
  await mkdir(output, { recursive: true });
  browser = spawnOwnedChrome(chromeBin, [
    "--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`, `--host-resolver-rules=${hosts}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debug = await debuggingUrl(browser);
  const id = await detectExtension(debug);
  session = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  await evaluate(session, seedExpression(captureFixture(server.port)));
  const surfaces = [
    { mode: "dashboard", selector: ".hero-top", page: "newtab.html" },
    { mode: "minimal", selector: ".search-box", page: "newtab.html" },
    { mode: "popup", selector: ".search-box", page: "popup.html" },
    { mode: "sidepanel", selector: ".search-box", page: "sidepanel.html" }
  ];
  const selectedModes = (process.env.SEARCH_EMPHASIS_SURFACES || "")
    .split(",").map((mode) => mode.trim()).filter(Boolean);
  for (const { mode, selector, page } of surfaces.filter(({ mode }) =>
    !selectedModes.length || selectedModes.includes(mode))) {
    for (const dark of [false, true]) {
      for (const reduced of [false, true]) {
        await evaluate(session, `import(chrome.runtime.getURL('js/lib/store.js')).then(s => s.patchSettings({
          newTabMode: '${mode}', uiScheme: '${dark ? "nautilus" : "matcha"}', uiMode: '${dark ? "dark" : "light"}', uiInterfaceStyle: 'soft'
        }))`);
        await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
        await session.send("Page.navigate", { url: `chrome-extension://${id}/${page}` });
        await waitFor(session, "document.querySelector('.search-input')", "Search input");
        await evaluate(session, `document.querySelector('.search-box').dismissSearch({blur:true})`);
        await evaluate(session, "new Promise(resolve => setTimeout(resolve, 400))");
        const geometry = await evaluate(session, `(() => {
          const rect = document.querySelector('.hero')?.getBoundingClientRect();
          return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
        })()`);
        const arrival = await evaluate(session, `new Promise(resolve => {
          const frames = []; const start = performance.now();
          const sample = () => {
            const field = document.querySelector('.search-input').getBoundingClientRect();
            const deck = document.querySelector('.minimal-deck')?.getBoundingClientRect();
            const overlay = document.querySelector('.hero-search-overlay');
            const style = overlay && getComputedStyle(overlay);
            frames.push({ at:performance.now()-start, top:field.top, left:field.left,
              width:field.width, deckHeight:deck?.height, opacity:style?.opacity,
              clip:style?.clipPath, overlayHeight:overlay?.getBoundingClientRect().height,
              opening:overlay?.classList.contains('is-search-opening'), displayed:style?.display });
            if (performance.now()-start < 420) requestAnimationFrame(sample); else resolve(frames);
          };
          sample(); document.querySelector('.search-box').setInputValue('design');
        })`);
        if (!reduced && mode === "minimal") {
          const first = arrival[0], last = arrival.at(-1);
          assert.ok(last.top < first.top - 40, "Minimal field travels from its resting position");
          assert.ok(arrival.some(f => f.top < first.top - 2 && f.top > last.top + 2), "Minimal paints an intermediate position");
          assert.ok(arrival.some(f => f.deckHeight > first.deckHeight + 2 && f.deckHeight < last.deckHeight - 2), "Minimal paints intermediate expansion geometry");
        }
        if (!reduced && mode === "dashboard") {
          assert.ok(arrival.some(f => f.displayed !== "none" && f.opening && f.overlayHeight > 5 && f.overlayHeight < arrival.at(-1).overlayHeight - 5), "Dashboard paints partially expanded results");
          assert.ok(arrival.every(f => Number(f.opacity) === 1), "Search material stays opaque while opening");
          assert.equal(arrival.at(-1).opening, false, "Dashboard releases its content crop");
          const released = arrival.findIndex((frame, index) => index > 0 && !frame.opening && arrival[index - 1].opening);
          assert.ok(released > 0);
          if (arrival[released].at - arrival[released - 1].at < 25) {
            assert.ok(Math.abs(arrival[released].overlayHeight - arrival[released - 1].overlayHeight) < 4,
              "releasing the Search shell introduces no late height jump");
          }
        }
        if (reduced && mode === "dashboard") assert.ok(arrival.every(f => !f.opening), "Reduced motion has no results crop");
        await waitFor(session, "document.querySelectorAll('.search-row').length > 0", "Search results");
        await waitFor(session, `Number(getComputedStyle(document.querySelector('${selector}'),'::before').opacity) === 1`, "Search emphasis visible");
        const state = await evaluate(session, `(() => {
          const parent = document.querySelector('${selector}');
          const style = getComputedStyle(parent, '::before');
          const input = document.querySelector('.search-input');
          const box = input.getBoundingClientRect();
          const row = document.querySelector('.search-row'); const r = row.getBoundingClientRect();
          const sessionAction = document.querySelector('.rtype-session-entity');
          const sessionRow = sessionAction?.closest('.search-row');
          const hero = document.querySelector('.hero')?.getBoundingClientRect();
          const deckStyle = document.querySelector('.minimal-deck') &&
            getComputedStyle(document.querySelector('.minimal-deck'));
          return { pointerEvents: style.pointerEvents, transition: style.transitionDuration,
            background: style.backgroundColor, schemeMode: document.documentElement.dataset.mode,
            focused: document.activeElement === input,
            inputHit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input,
            resultHit: row.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
            sessionMeta: sessionRow?.querySelector('.rmeta')?.textContent ?? null,
            hero: hero ? [hero.x, hero.y, hero.width, hero.height] : null,
            deck: deckStyle ? { border: deckStyle.borderTopColor,
              background: deckStyle.backgroundColor, shadow: deckStyle.boxShadow } : null };
        })()`);
        assert.equal(state.pointerEvents, "none");
        assert.ok(state.focused && state.inputHit && state.resultHit, "Search is focusable and hit-testable above its visual tint");
        assert.match(state.sessionMeta ?? "", /^Session · /,
          "a Named Session result identifies its entity kind before the counts");
        if (mode === "dashboard") assert.deepEqual(state.hero, geometry, "Search never changes sticky hero geometry");
        if (mode === "minimal") assert.deepEqual(state.deck, {
          border: "rgba(0, 0, 0, 0)", background: "rgba(0, 0, 0, 0)", shadow: "none"
        }, "Minimal Search has only its connected Search contour, not a second deck boundary");
        if (mode === "popup") {
          const footerLayer = await evaluate(session,
            "Number(getComputedStyle(document.querySelector('.linkrow')).zIndex)");
          assert.ok(footerLayer <= 0,
            "popup footer links sit below the active Search tint while remaining clickable");
          state.footerLayer = footerLayer;
        }
        if (mode === "dashboard") {
          const footer = await evaluate(session, `(() => {
            const node = document.querySelector('.search-footer');
            const prior = node.className;
            const withInvite = {display:getComputedStyle(node).display,height:node.getBoundingClientRect().height};
            node.classList.remove('has-history-invite','is-empty');
            const populated = getComputedStyle(node).display;
            node.classList.add('is-empty');
            const empty = getComputedStyle(node).display;
            node.className = prior;
            return {withInvite,populated,empty};
          })()`);
          assert.equal(footer.withInvite.display, "flex"); assert.ok(footer.withInvite.height >= 30);
          assert.equal(footer.populated, "flex"); assert.equal(footer.empty, "none");
          state.footerStyleCases = footer;
        }
        if (reduced) assert.ok(parseFloat(state.transition) < .001, "reduced motion is effectively immediate");
        if (!reduced) {
          const capture = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          await writeFile(path.join(output, `${mode}-${dark ? "dark" : "light"}.png`), Buffer.from(capture.data, "base64"));
        }
        await press("Escape");
        await waitFor(session, "!document.querySelector('.search-input').value", "Escape clears query");
        await press("Escape");
        await waitFor(session, `Number(getComputedStyle(document.querySelector('${selector}'),'::before').opacity) === 0`, "Escape clears backdrop");
        await evaluate(session, "document.querySelector('.search-box').setInputValue('design')");
        await waitFor(session, "document.querySelectorAll('.search-row').length > 0", "Search reopens");
        if (mode === "dashboard") {
          const point = await evaluate(session, `(() => {
            const node = [...document.querySelectorAll('.navitem')].find(n => n.textContent.includes('Inbox'));
            const b = node.getBoundingClientRect(); return { x:b.x+b.width/2,y:b.y+b.height/2 };
          })()`);
          await session.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
          await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
          await waitFor(session, "location.hash === '#inbox'", "outside click retains normal navigation");
        } else {
          await session.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: 10, y: 10 });
          await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: 10, y: 10 });
        }
        await waitFor(session, `Number(getComputedStyle(document.querySelector('${selector}'),'::before').opacity) === 0`, "outside click dismisses visual emphasis");
        records.push({ mode, dark, reduced, ...state, arrival });
        if (!dark && !reduced && (mode === "dashboard" || mode === "minimal")) {
          // Inspect the real opening at a paused intermediate time, rather than
          // assuming an animate() call guarantees a visible transition.
          await evaluate(session, "document.querySelector('.search-box').dismissSearch({blur:true})");
          await evaluate(session, "new Promise(resolve => setTimeout(resolve, 400))");
          const staged = await evaluate(session, `new Promise(resolve => {
            document.querySelector('.search-box').setInputValue('design');
            setTimeout(() => {
              const host = document.querySelector('${mode === "dashboard" ? ".hero-search-overlay" : ".minimal-deck"}');
              const effects = host.getAnimations();
              effects.forEach(effect => { effect.pause(); effect.currentTime = 55; });
              resolve(effects.length);
            }, 35);
          })`);
          assert.ok(staged > 0, "an actual connected opening can be inspected mid-flight");
          const stagedCapture = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          await writeFile(path.join(output, `${mode}-opening-55ms.png`), Buffer.from(stagedCapture.data, "base64"));
          await evaluate(session, `document.querySelector('${mode === "dashboard" ? ".hero-search-overlay" : ".minimal-deck"}').getAnimations().forEach(effect => effect.play())`);
          await evaluate(session, "new Promise(resolve => setTimeout(resolve, 300))");
          if (mode === "minimal") {
            const reversal = await evaluate(session, `new Promise(resolve => {
              const box = document.querySelector('.search-box');
              box.dismissSearch({blur:true});
              setTimeout(() => box.setInputValue('design'), 55);
              setTimeout(() => box.dismissSearch({blur:true}), 110);
              setTimeout(() => box.setInputValue('design'), 150);
              setTimeout(() => {
                const deck = document.querySelector('.minimal-deck');
                resolve({ open:deck.classList.contains('is-search-expanded'),
                  focus:box.contains(document.activeElement), block:deck.style.blockSize,
                  inline:deck.style.inlineSize, animations:deck.getAnimations().length });
              }, 600);
            })`);
            assert.ok(reversal.open && reversal.focus);
            assert.equal(reversal.block, ""); assert.equal(reversal.inline, "");
            assert.equal(reversal.animations, 0);
            records.at(-1).reversal = reversal;
            await evaluate(session, "document.querySelector('.search-box').dismissSearch({blur:true})");
            await evaluate(session, "new Promise(resolve => setTimeout(resolve, 300))");
            await evaluate(session, "document.querySelector('.search-box').setInputValue('design')");
            await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            await waitFor(session, "!document.querySelector('.minimal-deck').style.blockSize && !document.querySelector('.minimal-deck').classList.contains('is-search-morphing')", "live reduced motion releases Search geometry");
            const reducedMidway = await evaluate(session, "({ focus:document.querySelector('.search-box').contains(document.activeElement), inline:document.querySelector('.minimal-deck').style.inlineSize })");
            assert.ok(reducedMidway.focus); assert.equal(reducedMidway.inline, "");
            records.at(-1).reducedMidway = reducedMidway;
            await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
          }
          await session.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 600, deviceScaleFactor: 1, mobile: false });
          await evaluate(session, "document.querySelector('.search-box').setInputValue('design')");
          await waitFor(session, `Number(getComputedStyle(document.querySelector('${selector}'),'::before').opacity) === 1`, "narrow emphasis");
          const narrow = await evaluate(session, `(() => {
            const style = getComputedStyle(document.querySelector('${selector}'), '::before');
            const input = document.querySelector('.search-input'); const box = input.getBoundingClientRect();
            return { width:style.width, height:style.height, hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===input };
          })()`);
          assert.equal(narrow.width, "760px"); assert.equal(narrow.height, "600px");
          assert.ok(narrow.hit, "narrow Search remains above the full viewport tint");
          records.at(-1).narrow = narrow;
          await session.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
      }
    }
  }
  if (!selectedModes.length || selectedModes.includes("dashboard")) {
    await session.send("Page.navigate", { url: `chrome-extension://${id}/dashboard.html#inbox` });
    await waitFor(session,
      "[...document.querySelectorAll('.sections .trow, .sections .item')].filter(node => node.offsetParent !== null).length >= 6",
      "Dashboard has several visible keyboard units");
    const rememberedUnit = await evaluate(session, `(() => {
      const units=[...document.querySelectorAll('.sections .trow, .sections .item')]
        .filter(node=>node.offsetParent!==null);
      const target=units[3].querySelector('input:not([disabled]),button,a');
      target.focus(); target.blur();
      document.body.dispatchEvent(new KeyboardEvent('keydown',
        {key:'ArrowDown',bubbles:true,cancelable:true}));
      const active=document.activeElement.closest('.trow,.item');
      return {from:3,to:units.indexOf(active),first:units.indexOf(units[0])};
    })()`);
    assert.equal(rememberedUnit.to, 4,
      `an arrow after a row action loses focus resumes at the next list position: ${JSON.stringify(rememberedUnit)}`);
    records.push({ mode: "remembered-list-position", ...rememberedUnit });
    const rememberedFirstExit = await evaluate(session, `(() => {
      const first=[...document.querySelectorAll('.sections .trow, .sections .item')]
        .find(node=>node.offsetParent!==null);
      first.querySelector('input:not([disabled]),button,a').focus();
      document.activeElement.blur();
      document.body.dispatchEvent(new KeyboardEvent('keydown',
        {key:'ArrowUp',bubbles:true,cancelable:true}));
      return document.activeElement===document.querySelector('.search-input');
    })()`);
    assert.equal(rememberedFirstExit, true,
      "Up from a remembered first unit still exits to Dashboard Search");
    records.push({ mode: "remembered-first-unit-exit", focused: rememberedFirstExit });
    const headerWalk = await evaluate(session, `(() => {
      const head=document.querySelector('.sections [data-tablist-card] .item-head');
      const entry=head.querySelector('input:not([disabled]),.item-head-toggle,button,a');
      entry.focus();
      for(let i=0;i<16 && !head.querySelector('.gacts')?.contains(document.activeElement);i++){
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
          {key:'ArrowRight',bubbles:true,cancelable:true}));
      }
      return {entered:head.querySelector('.gacts')?.contains(document.activeElement)===true,
        label:document.activeElement?.getAttribute('aria-label')};
    })()`);
    assert.equal(headerWalk.entered, true,
      `horizontal arrows reach group-header action buttons: ${JSON.stringify(headerWalk)}`);
    records.push({ mode: "group-header-keyboard", ...headerWalk });
    const multipleSelection = await evaluate(session, `new Promise(async resolve => {
      const groups=[...document.querySelectorAll('.sections [data-tablist-card]')];
      const first=groups[0]?.querySelector('.trow .row-select-slot input:not([disabled])');
      const secondGroup=groups.find(group=>group!==groups[0] && group.querySelector('.trow .row-select-slot input:not([disabled])'));
      first?.click(); await new Promise(done=>setTimeout(done,160));
      const second=[...document.querySelectorAll('.sections [data-tablist-card]')]
        .find(group=>group.dataset.tablistCard===secondGroup?.dataset.tablistCard)
        ?.querySelector('.trow .row-select-slot input:not([disabled])');
      second?.click(); await new Promise(done=>setTimeout(done,220));
      resolve({rowButtons:document.querySelectorAll('.sections .trow .tacts button').length,
        headerButtons:document.querySelectorAll('.sections .item-head .gacts button').length,
        bulkButtons:document.querySelectorAll('.sections .bulk-bar.has-selection button').length});
    })`);
    assert.equal(multipleSelection.rowButtons, 0,
      `multi-row selection removes individual row action buttons: ${JSON.stringify(multipleSelection)}`);
    assert.equal(multipleSelection.headerButtons, 0,
      "multi-group selection removes individual group action buttons");
    assert.ok(multipleSelection.bulkButtons > 0,
      "the selected-set action toolbar remains available");
    records.push({ mode: "multiple-selection-action-ownership", ...multipleSelection });
  }
  if (!selectedModes.length || selectedModes.includes("minimal")) {
    await evaluate(session, "import(chrome.runtime.getURL('js/lib/store.js')).then(s => s.patchSettings({newTabMode:'minimal'}))");
    await session.send("Page.navigate", { url: `chrome-extension://${id}/newtab.html` });
    await waitFor(session, "document.querySelector('.search-input')", "Minimal recent-tab input");
    await evaluate(session, "document.querySelector('.search-input').focus({preventScroll:true})");
    await waitFor(session,
      "document.querySelectorAll('.search-recent-group .search-row').length === 10",
      "ten Minimal recent tabs");
    await waitFor(session,
      "document.querySelector('.minimal-deck').classList.contains('is-search-expanded') && document.querySelector('.minimal-deck').getBoundingClientRect().height > 500",
      "Minimal Search reaches reading height");
    const minimalFit = await evaluate(session, `(() => {
      const results = document.querySelector('.search-results');
      const last = document.querySelector('.search-recent-group .search-row:last-child');
      return {client:results.clientHeight,scroll:results.scrollHeight,
        lastBottom:last.getBoundingClientRect().bottom,
        resultsBottom:results.getBoundingClientRect().bottom};
    })()`);
    assert.ok(minimalFit.scroll <= minimalFit.client + 1 &&
      minimalFit.lastBottom <= minimalFit.resultsBottom + 1,
      `Minimal expands its Search surface to fit all ten recents when viewport space permits: ${JSON.stringify(minimalFit)}`);
    records.push({ mode: "minimal-recent-fit", ...minimalFit });
    await evaluate(session, "document.querySelector('.search-box').dismissSearch({blur:true})");
    await evaluate(session, "document.querySelector('.search-input').focus({preventScroll:true})");
    await waitFor(session, "document.querySelectorAll('.ghost-chip').length > 0", "Minimal Search suggestion chips");
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38
    });
    const highlightedSuggestion = await evaluate(session,
      "document.activeElement?.classList.contains('ghost-chip') === true");
    assert.equal(highlightedSuggestion, true,
      "ArrowUp highlights a Search suggestion chip");
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
    });
    await waitFor(session,
      "!document.querySelector('.minimal-deck').classList.contains('is-search-expanded')",
      "Escape collapses Minimal Search from a highlighted suggestion");
    const suggestionEscape = await evaluate(session, `(() => ({
      focused:document.activeElement?.classList.contains('ghost-chip') === true,
      results:document.querySelector('.search-results').childElementCount,
      expanded:document.querySelector('.minimal-deck').classList.contains('is-search-expanded')
    }))()`);
    await evaluate(session, `Promise.all([
      import(chrome.runtime.getURL('js/lib/store.js')),
      import(chrome.runtime.getURL('js/lib/types.js'))
    ]).then(([store, types]) => store.mutateStores([types.STORE_KEYS.starred], maps => {
      const starred = {...(maps[types.STORE_KEYS.starred] ?? {})};
      const source = Object.values(starred)[0];
      for (let index = Object.keys(starred).length; index < 10; index += 1) {
        const id = 'laptop-star-' + index;
        starred[id] = {...source, id, title:'Fixture item ' + (index + 1),
          position:index, createdAt:Date.now() + index, modifiedAt:Date.now() + index};
      }
      return {[types.STORE_KEYS.starred]:starred};
    }))`);
    await evaluate(session, `import(chrome.runtime.getURL('js/lib/store.js')).then(store =>
      store.patchSettings({uiScheme:'sunset',uiMode:'scheme',uiGradient:true}))`);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 1655, height: 904, deviceScaleFactor: 1, mobile: false
    });
    await session.send("Page.navigate", { url: `chrome-extension://${id}/newtab.html` });
    await waitFor(session, "document.querySelector('.minimal-clock .date')?.textContent", "laptop Minimal layout");
    await waitFor(session,
      "!document.querySelector('.minimal-deck').classList.contains('is-hydrating-layout') && !document.querySelector('.minimal-deck').style.blockSize",
      "laptop Minimal deck settles after Starred hydration");
    const laptopMinimal = await evaluate(session, `(() => {
      const clock=document.querySelector('.minimal-clock .clock').getBoundingClientRect();
      const date=document.querySelector('.minimal-clock .date').getBoundingClientRect();
      const deck=document.querySelector('.minimal-deck').getBoundingClientRect();
      const contentTop=28;
      return {font:Number.parseFloat(getComputedStyle(document.querySelector('.minimal-clock .clock')).fontSize),
        clockTop:clock.top,dateBottom:date.bottom,deckTop:deck.top,
        gap:deck.top-date.bottom,topGap:clock.top-contentTop,
        balance:Math.abs((clock.top-contentTop)-(deck.top-date.bottom)),viewport:innerHeight};
    })()`);
    assert.ok(laptopMinimal.gap >= 12 && laptopMinimal.balance <= 72,
      `laptop Minimal composition fits and balances above its deck: ${JSON.stringify(laptopMinimal)}`);
    const laptopCapture = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(output, "minimal-laptop-screen.png"), Buffer.from(laptopCapture.data, "base64"));
    records.push({ mode: "minimal-laptop-screen", ...laptopMinimal });
    assert.deepEqual(suggestionEscape, { focused: false, results: 0, expanded: false },
      `Escape exits Search from a highlighted suggestion: ${JSON.stringify(suggestionEscape)}`);
    records.push({ mode: "highlighted-suggestion-escape", ...suggestionEscape });
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 2504, height: 1238, deviceScaleFactor: 1, mobile: false
    });
    await session.send("Page.navigate", { url: `chrome-extension://${id}/newtab.html` });
    await waitFor(session, "document.querySelector('.minimal-clock .clock') && document.querySelector('.minimal-deck')", "large-screen Minimal layout");
    await waitFor(session,
      "!document.querySelector('.minimal-deck').classList.contains('is-hydrating-layout') && !document.querySelector('.minimal-deck').style.blockSize",
      "large-screen Minimal deck settles after Starred hydration");
    const largeMinimal = await evaluate(session, `(() => {
      const clock=document.querySelector('.minimal-clock .clock');
      const date=document.querySelector('.minimal-clock .date');
      const deck=document.querySelector('.minimal-deck');
      return {font:Number.parseFloat(getComputedStyle(clock).fontSize),
        clockWidth:clock.getBoundingClientRect().width,
        gap:deck.getBoundingClientRect().top-date.getBoundingClientRect().bottom,
        deckBottom:deck.getBoundingClientRect().bottom,viewport:innerHeight};
    })()`);
    assert.ok(largeMinimal.font >= 650 && largeMinimal.gap <= 250,
      `27-inch Minimal composition uses its available height: ${JSON.stringify(largeMinimal)}`);
    const largeCapture = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(output, "minimal-large-screen.png"), Buffer.from(largeCapture.data, "base64"));
    records.push({ mode: "minimal-large-screen", ...largeMinimal });
  }
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 400, height: 600, deviceScaleFactor: 1, mobile: false
  });
  await evaluate(session, `chrome.storage.session.set({searchPopupMode:{requestedAt:Date.now()}})`);
  await session.send("Page.navigate", { url: `chrome-extension://${id}/popup.html` });
  await waitFor(session, "document.querySelector('.search-input')", "shortcut popup Search input");
  await waitFor(session, "document.activeElement === document.querySelector('.search-input')",
    "shortcut popup Search focus handoff");
  await waitFor(session,
    "document.querySelectorAll('.search-recent-group .search-row').length === 10",
    "ten mounted recent tabs");
  const shortcutFocus = await evaluate(session,
    `(() => { const results=document.querySelector('.search-results');
      const last=document.querySelector('.search-recent-group .search-row:last-child');
      return {focused:document.activeElement===document.querySelector('.search-input'),
        recentCount:document.querySelectorAll('.search-recent-group .search-row').length,
        client:results.clientHeight,scroll:results.scrollHeight,
        lastBottom:last.getBoundingClientRect().bottom,
        resultsBottom:results.getBoundingClientRect().bottom}; })()`);
  assert.equal(shortcutFocus.focused, true, "the Search popup handoff wins Chrome's initial-focus pass");
  assert.equal(shortcutFocus.recentCount, 10, "mounted Search exposes ten recent tabs when space permits");
  assert.ok(shortcutFocus.scroll <= shortcutFocus.client + 1 &&
    shortcutFocus.lastBottom <= shortcutFocus.resultsBottom + 1,
    "popup Search expands to fit all ten recents when its 600px surface has room");
  records.push({ mode: "shortcut-focus", ...shortcutFocus });
  await evaluate(session, "document.querySelector('.search-input').blur()");
  const sender = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(sender);
  const focusReply = await evaluate(sender,
    "chrome.runtime.sendMessage({type:'focus-popup-search'})");
  assert.equal(focusReply?.focused, true,
    "an existing popup accepts a Search-focus request from another extension context");
  assert.equal(await evaluate(session,
    "document.activeElement === document.querySelector('.search-input')"), true,
    "the existing popup focuses its own Search field");
  records.push({ mode: "existing-popup-focus", reply: focusReply });
  await session.send("Page.navigate", { url: `chrome-extension://${id}/popup.html` });
  await waitFor(session, "document.querySelector('.search-input')", "plain popup Search input");
  await evaluate(session, "new Promise(resolve => setTimeout(resolve, 100))");
  const plainPopupFocused = await evaluate(session,
    "document.activeElement === document.querySelector('.search-input')");
  assert.equal(plainPopupFocused, false, "an ordinary popup open leaves Search unfocused");
  records.push({ mode: "plain-popup", focused: plainPopupFocused });
  const labelledPopupUrl = captureFixture(server.port).sites.gutenbergShelf.url;
  const labelledPopupTab = await evaluate(sender, `(async () => {
    const current = await chrome.tabs.getCurrent();
    const tab = await chrome.tabs.create({
      windowId: current.windowId,
      active: true,
      url: ${JSON.stringify(captureFixture(server.port).sites.gutenbergShelf.url)}
    });
    const labels = await import(chrome.runtime.getURL('js/lib/labels.js'));
    await labels.saveLabeledCopies([{
      url: ${JSON.stringify(captureFixture(server.port).sites.gutenbergShelf.url)},
      title: 'Bookshelves', favIconUrl: ''
    }], ['Reading', 'Reference', 'Research']);
    await new Promise(resolve => setTimeout(resolve, 250));
    return {id: tab.id, windowId: tab.windowId};
  })()`);
  assert.ok(labelledPopupTab?.id, "a labelled public tab is available for popup sizing");
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 400, height: 600, deviceScaleFactor: 1, mobile: false
  });
  await session.send("Page.navigate", { url: `chrome-extension://${id}/popup.html` });
  await waitFor(session,
    "document.body.classList.contains('popup-ready') && document.querySelectorAll('.tablabels .labelchip').length === 2",
    "labelled popup hydration");
  await waitFor(session,
    "document.querySelector('#app').scrollHeight <= document.querySelector('#app').clientHeight + 1",
    "labelled popup adaptive fit");
  const labelledPopupFit = await evaluate(session, `(() => {
    const app = document.querySelector('#app');
    const footer = document.querySelector('.linkrow').getBoundingClientRect();
    return {client:app.clientHeight, scroll:app.scrollHeight,
      documentClient:document.documentElement.clientHeight,
      documentScroll:document.documentElement.scrollHeight,
      footerBottom:footer.bottom, viewport:innerHeight,
      labels:document.querySelectorAll('.tablabels .labelchip').length};
  })()`);
  assert.ok(labelledPopupFit.scroll <= labelledPopupFit.client + 1 &&
    labelledPopupFit.documentScroll <= labelledPopupFit.documentClient + 1 &&
    labelledPopupFit.footerBottom <= labelledPopupFit.viewport + 1,
    `a tab with labels keeps the ordinary 600px popup surface free of incidental scrolling: ${JSON.stringify(labelledPopupFit)}`);
  records.push({ mode: "labelled-popup-fit", url: labelledPopupUrl, ...labelledPopupFit });
  const popupSessionShortcut = await evaluate(session, `(() => {
    const button = document.querySelector('[data-shortcut-key="t"]');
    const event = new KeyboardEvent('keydown', {
      key:'t', code:'KeyT', bubbles:true, cancelable:true
    });
    document.dispatchEvent(event);
    return {prevented:event.defaultPrevented,
      label:button?.querySelector('.lbl')?.textContent,
      key:button?.querySelector('.k')?.textContent};
  })()`);
  await waitFor(session,
    "document.querySelector('.action-popover .session-picker-form input')",
    "popup T Session picker");
  assert.deepEqual(popupSessionShortcut, { prevented: true, label: "Save in Session", key: "T" },
    "T opens the current tab's plainly named Session picker in the popup");
  records.push({ mode: "popup-session-shortcut", ...popupSessionShortcut });
  await evaluate(session, "document.querySelector('.action-popover .action-popover-close')?.click()");
  const syntheticSuspendedUrl = captureFixture(server.port).sites.mdnStorage.url;
  await session.send("Page.navigate", { url:
    `chrome-extension://${id}/suspend.html?originalUrl=${encodeURIComponent(syntheticSuspendedUrl)}&title=Fixture` });
  await waitFor(session, "document.querySelector('#wake-btn')", "synthetic suspended page");
  await evaluate(session, `document.dispatchEvent(new KeyboardEvent('keydown',
    {key:'r',code:'KeyR',metaKey:true,bubbles:true,cancelable:true}))`);
  await evaluate(sender, `new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = async () => {
      const tabs = await chrome.tabs.query({});
      if (tabs.some(tab => tab.url === ${JSON.stringify(syntheticSuspendedUrl)})) resolve(true);
      else if (performance.now() - started >= 4_000) reject(new Error('Command+R did not wake the synthetic suspended page'));
      else setTimeout(inspect, 40);
    };
    inspect();
  })`);
  records.push({ mode: "suspended-reload-key", woke: true });
  const browserSuspendedUrl = `${syntheticSuspendedUrl}#browser-shortcut`;
  await session.send("Page.navigate", { url:
    `chrome-extension://${id}/suspend.html?originalUrl=${encodeURIComponent(browserSuspendedUrl)}&title=Fixture` });
  await waitFor(session, "document.querySelector('#wake-btn')", "second synthetic suspended page");
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 4
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 4
  });
  await evaluate(sender, `new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = async () => {
      const tabs = await chrome.tabs.query({});
      if (tabs.some(tab => tab.url === ${JSON.stringify(browserSuspendedUrl)})) resolve(true);
      else if (performance.now() - started >= 4_000) reject(new Error('browser Command+R did not wake the synthetic suspended page'));
      else setTimeout(inspect, 40);
    };
    inspect();
  })`);
  records.push({ mode: "suspended-browser-reload-key", woke: true });
  await writeFile(path.join(output, "verification.json"), JSON.stringify({ records }, null, 2));
  console.log(`PASS: ${records.length} mounted Search cases across all four hosts, light/dark, reduced motion, focus handoff, hit testing, Escape, outside dismissal and navigation`);
} finally {
  session?.close();
  if (browser) await terminateOwnedChrome(browser);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
