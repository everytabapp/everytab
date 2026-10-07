// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Native installed-tab races. Timing gates are deliberate instrumentation, not user gestures. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget, CdpClient, attachTarget,
  evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end("<!doctype html><title>Synthetic action fixture</title><p>Disposable page</p>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), "everytab-action-races-"));
const browser = spawnOwnedChrome(chromeBin, [
  "--headless=new", "--disable-gpu", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  `--user-data-dir=${profile}`, "--no-first-run",
  "--disable-background-networking", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
const sessions = [];
let browserClient;
try {
  const debug = await debuggingUrl(browser);
  browserClient = new CdpClient(debug);
  const manager = await createTarget(debug, "chrome://extensions");
  sessions.push(manager);
  await prepareSession(manager);
  await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await browserClient.send("Extensions.loadUnpacked", { path: extensionRoot });
  const id = await detectExtension(debug);
  async function openController() {
    const session = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
    sessions.push(session);
    await prepareSession(session);
    await evaluate(session, `(async () => {
      window.store = await import(chrome.runtime.getURL('js/lib/store.js'));
      window.closeDay = await import(chrome.runtime.getURL('js/lib/close-day.js'));
      window.fixtureOrigin = ${JSON.stringify(origin)};
      await store.listItems('inbox');
    })()`);
    return session;
  }
  const observer = await openController();
  await evaluate(observer, `(async () => {
    await store.patchSettings({ suspendLazyReload: true, suspendEnabled: false,
      suspendMaxTabs: 0, oneNewTabPerWindow: false });
    window.focusGuard = await import(chrome.runtime.getURL('js/lib/focus-guard.js'));
    window.suspension = await import(chrome.runtime.getURL('js/lib/suspend.js'));
  })()`);

  for (const kind of ["focus", "suspend"]) {
    await evaluate(observer, `(async () => {
      window.actionTab = await chrome.tabs.create({
        url: ${kind === "focus" ? "chrome.runtime.getURL('focus.html#fixture-attempt')" : "fixtureOrigin + '/before'"}, active: false
      });
      if (${JSON.stringify(kind)} === 'focus') {
        await chrome.storage.local.set({ focusBlockedAttempts: { [actionTab.id]: {
          id: 'fixture-attempt', url: fixtureOrigin + '/saved-focus', domain: '127.0.0.1', title: 'Fixture'
        } } });
      }
      window.tabLoaded = false;
      window.loadPoll = setInterval(async () => {
        const tab = await chrome.tabs.get(actionTab.id);
        if (tab.status === 'complete') { clearInterval(loadPoll); tabLoaded = true; }
      }, 30);
    })()`);
    await waitFor(observer, "tabLoaded", `${kind} target loaded`);
    // This is a real Web Lock. Track the controller's next request so an unrelated
    // worker request cannot accidentally stand in for the operation under test.
    await evaluate(observer, `(() => {
      window.storeHold = navigator.locks.request('everytab-store', () =>
        new Promise(resolve => { window.releaseStore = resolve; }));
    })()`);
    await waitFor(observer, "typeof releaseStore === 'function'", "store lock held");
    await evaluate(observer, `(() => {
      window.nativeRequest = navigator.locks.request.bind(navigator.locks);
      window.operationQueued = false;
      navigator.locks.request = (name, ...args) => {
        if (name === 'everytab-store') operationQueued = true;
        return nativeRequest(name, ...args);
      };
      window.actionResult = undefined;
      window.actionPending = (${kind === "focus"
        ? "focusGuard.returnAndClose(actionTab.id, 'fixture-attempt', true)"
        : "suspension.suspendTab(actionTab.id)"}).then(result => { actionResult = result; });
    })()`);
    await waitFor(observer, "operationQueued", `${kind} reached persistence`);
    await evaluate(observer, `(async () => {
      await chrome.tabs.update(actionTab.id, { url: fixtureOrigin + '/after-${kind}' });
      navigator.locks.request = nativeRequest;
      releaseStore();
      await actionPending;
    })()`);
    const result = await evaluate(observer, `(async () => ({
      result: actionResult,
      survivingUrl: (await chrome.tabs.get(actionTab.id)).pendingUrl || (await chrome.tabs.get(actionTab.id)).url,
      saved: (await store.listItems('inbox')).filter(item => item.id === 'fixture-attempt').length,
      registered: Boolean((await suspension.getSuspendRegistry())[actionTab.id])
    }))()`);
    assert.equal(result.survivingUrl, `${origin}/after-${kind}`);
    if (kind === "focus") {
      assert.deepEqual(result.result, { ok: false, reason: "close-failed", saved: true });
      assert.equal(result.saved, 1);
    } else {
      assert.equal(result.result, false);
      assert.equal(result.registered, false);
    }
    await evaluate(observer, "chrome.tabs.remove(actionTab.id)");
    console.log(`PASS: native ${kind} navigation survives a pending saved-data operation`);
  }

  for (const boundary of ["before-close", "after-close"]) {
    const owner = await openController();
    const ownerId = await evaluate(owner, "chrome.tabs.getCurrent().then(tab => tab.id)");
    await evaluate(owner, `(async () => {
      // Keep the target in its own window: destroying the controller must not
      // change the target's index and correctly invalidate its close identity.
      const targetWindow = await chrome.windows.create({ url: fixtureOrigin + '/${boundary}' });
      window.closeTarget = targetWindow.tabs[0];
      window.targetLoaded = false;
      const timer = setInterval(async () => {
        if ((await chrome.tabs.get(closeTarget.id)).status === 'complete') {
          clearInterval(timer); targetLoaded = true;
        }
      }, 30);
    })()`);
    await waitFor(owner, "targetLoaded", "Close-the-day target loaded");
    await evaluate(owner, `(async () => {
      const draft = await closeDay.captureCloseDayReview({ refresh: true });
      for (const row of draft.plan.groups.flatMap(group => group.rows)) {
        if (!row.locked) await closeDay.updateCloseDayChoice(draft.draftId, row.fingerprintKey,
          { action: row.tabId === closeTarget.id ? 'inbox' : 'stay' });
      }
      window.closeBoundaryReached = false;
      const nativeRemove = chrome.tabs.remove.bind(chrome.tabs);
      chrome.tabs.remove = async ids => {
        if (${JSON.stringify(boundary)} === 'after-close') await nativeRemove(ids);
        closeBoundaryReached = true;
        await new Promise(() => {});
      };
      // Intentionally leave this promise in the owner that will be destroyed.
      void closeDay.commitCloseDay(draft.draftId);
    })()`);
    await waitFor(owner, "closeBoundaryReached", `${boundary} interruption boundary`);
    const receipt = await evaluate(observer, "closeDay.closeDayStatus().then(state => state.latest)");
    assert.equal(receipt.phase, "closing");
    assert.deepEqual(receipt.windows.flatMap(window => window.tabs.map(tab => tab.status)), ["attempted"]);
    assert.equal(receipt.storeChanges.length, 1, "saved work exists before interruption");
    await evaluate(observer, `chrome.tabs.remove(${ownerId})`);
    owner.client.close();
    const undo = await evaluate(observer, `(async () => {
      const journal = await import(chrome.runtime.getURL('js/lib/journal.js'));
      const result = await journal.undoActionResult(${JSON.stringify(receipt.journalId)});
      const again = await journal.undoActionResult(${JSON.stringify(receipt.journalId)});
      const receipt = (await closeDay.closeDayStatus()).latest;
      const tabs = await chrome.tabs.query({});
      return { status: result.status, repeat: again.status, phase: receipt.phase,
        result: receipt.reopenResult,
        matchingTabs: tabs.filter(tab => (tab.pendingUrl || tab.url) === fixtureOrigin + '/${boundary}').length,
        savedCount: (await store.listItems('inbox')).filter(item =>
          item.tabs.some(tab => tab.url === fixtureOrigin + '/${boundary}')).length };
    })()`);
    assert.deepEqual(undo, { status: "undone", repeat: "unavailable", phase: "undone",
      result: { reopened: 1, expected: 1 }, matchingTabs: 1, savedCount: 0 });
    console.log(`PASS: owner destroyed ${boundary}; native durable Undo restores exactly one occurrence`);
  }

  // Unlike the page-owner cases above, these interrupt the actual production
  // worker during Undo and let its replacement perform startup recovery.
  for (const boundary of ["before-reopen", "after-reopen"]) {
    const controller = await openController();
    const receipt = await evaluate(controller, `(async () => {
      const url = fixtureOrigin + '/${boundary}';
      const win = await chrome.windows.create({ url: [url, url] });
      const targetIds = win.tabs.map(tab => tab.id);
      window.undoTargetsLoaded = false;
      const timer = setInterval(async () => {
        const tabs = await Promise.all(targetIds.map(id => chrome.tabs.get(id)));
        if (tabs.every(tab => tab.status === 'complete')) {
          clearInterval(timer); undoTargetsLoaded = true;
        }
      }, 30);
      window.undoTargetIds = targetIds;
      return { targetIds };
    })()`);
    assert.equal(receipt.targetIds.length, 2);
    await waitFor(controller, "undoTargetsLoaded", "Undo targets loaded");
    const committed = await evaluate(controller, `(async () => {
      const draft = await closeDay.captureCloseDayReview({ refresh: true });
      for (const row of draft.plan.groups.flatMap(group => group.rows)) {
        if (!row.locked) await closeDay.updateCloseDayChoice(draft.draftId, row.fingerprintKey,
          { action: undoTargetIds.includes(row.tabId) ? 'inbox' : 'stay' });
      }
      return await closeDay.commitCloseDay(draft.draftId);
    })()`);
    assert.equal(committed.ok, true, `${boundary}: forward commit did not succeed (${[
      "missing", "nothing-to-close", "stale-browser", "stale-store", "not-committed"
    ].includes(committed.status) ? committed.status : "unexpected-status"})`);
    assert.equal(committed.receipt.result.closed, 2);
    const transactionId = committed.transactionId;
    const { targetInfos } = await browserClient.send("Target.getTargets");
    const oldWorker = targetInfos.find(target => target.type === "service_worker" &&
      target.url === `chrome-extension://${id}/js/background.js`);
    assert.ok(oldWorker, "production worker available for the controlled interruption");
    const worker = await attachTarget(debug, oldWorker.targetId);
    sessions.push(worker);
    const recoveryDiagnostics = [];
    worker.client.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method !== "Runtime.consoleAPICalled") return;
      for (const argument of message.params.args ?? []) {
        if (/^EveryTab: (interrupted Undo recovery|pending live-close recovery) failed \[(name|code):[A-Za-z-]+\]$/.test(argument.value ?? "")) {
          recoveryDiagnostics.push(argument.value);
        }
      }
    });
    await worker.send("Runtime.enable");
    assert.deepEqual(recoveryDiagnostics, [], "startup action recovery diagnostics");
    await evaluate(worker, `(() => {
      globalThis.undoBoundaryReached = false;
      const nativeCreate = chrome.windows.create.bind(chrome.windows);
      chrome.windows.create = async options => {
        if (${JSON.stringify(boundary)} === 'after-reopen') await nativeCreate(options);
        undoBoundaryReached = true;
        return await new Promise(() => {});
      };
    })()`);
    await evaluate(controller, `(() => {
      void chrome.runtime.sendMessage({ type: 'close-day-undo', transactionId: ${JSON.stringify(transactionId)} })
        .catch(() => {});
    })()`);
    await waitFor(worker, "undoBoundaryReached", `${boundary} worker effect boundary`);
    const before = await evaluate(controller, `(async () => {
      const receipt = (await store.readStoreMap('closeDayReceipts'))[${JSON.stringify(transactionId)}];
      const journal = (await store.readStoreMap('journal')).find(entry => entry.id === receipt.journalId);
      const change = receipt.storeChanges[0];
      // A later saved edit must survive recovery: repeating the inverse would
      // destroy this newer state even if no extra browser tab were created.
      await store.mutateStores(['inbox'], maps => {
        const item = { ...change.after, ...maps.inbox[change.id], modifiedAt: Date.now() + 1 };
        delete item.deletedAt;
        delete item.deletionRevision;
        item.tabs = item.tabs.map(tab => ({ ...tab, title: 'Later synthetic edit' }));
        return { inbox: { ...maps.inbox, [change.id]: item } };
      });
      return { phase: receipt.phase, undone: journal.undone === true,
        claim: Boolean(journal.undoClaim), saved: (await store.readStoreMap('inbox'))[change.id],
        live: (await chrome.tabs.query({})).filter(tab =>
          (tab.pendingUrl || tab.url) === fixtureOrigin + '/${boundary}').length };
    })()`);
    assert.equal(before.phase, "undoing");
    assert.equal(before.undone, false);
    assert.equal(before.claim, true);
    assert.equal(before.live, boundary === "before-reopen" ? 0 : 2);
    await evaluate(worker, "setTimeout(() => chrome.runtime.reload(), 0); true");
    let newWorker;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await browserClient.send("Target.getTargets");
      newWorker = current.targetInfos.find(target => target.type === "service_worker" &&
        target.url === `chrome-extension://${id}/js/background.js` && target.targetId !== oldWorker.targetId);
      if (newWorker) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(newWorker, "extension reload replaced the interrupted worker");
    const afterController = await openController();
    const after = await evaluate(afterController, `(async () => {
      await chrome.runtime.sendMessage({ type: 'close-day-status' });
      const receipt = (await store.readStoreMap('closeDayReceipts'))[${JSON.stringify(transactionId)}];
      const journal = (await store.readStoreMap('journal')).find(entry => entry.id === receipt.journalId);
      const repeat = await chrome.runtime.sendMessage({ type: 'close-day-undo', transactionId: receipt.id });
      const resume = await chrome.runtime.sendMessage({ type: 'close-day-resume', transactionId: receipt.id });
      return { phase: receipt.phase, result: receipt.reopenResult,
        undone: journal.undone === true, undoStatus: journal.undoStatus,
        claim: Boolean(journal.undoClaim), repeat: repeat.status, resumedPhase: resume.receipt.phase,
        saved: (await store.readStoreMap('inbox'))[receipt.storeChanges[0].id],
        live: (await chrome.tabs.query({})).filter(tab =>
          (tab.pendingUrl || tab.url) === fixtureOrigin + '/${boundary}').length };
    })()`);
    assert.equal(after.phase, "undo-incomplete");
    assert.equal(after.undoStatus, "incomplete");
    assert.equal(after.undone, false);
    assert.equal(after.claim, false);
    assert.equal(after.repeat, "incomplete");
    assert.equal(after.resumedPhase, "undo-incomplete");
    assert.deepEqual(after.result, { reopened: 0, expected: 2, uncertain: 2 });
    assert.equal(after.live, before.live, "startup and retries never repeat an uncertain browser effect");
    assert.deepEqual(after.saved, before.saved, "startup never repeats the saved-data inverse");
    console.log(`PASS: production worker replaced ${boundary}; incomplete receipt, ${after.live} exact occurrences, later edit preserved`);
    console.log(JSON.stringify({ boundary, previousWorker: oldWorker.targetId,
      replacementWorker: newWorker.targetId, liveOccurrences: after.live, result: after.result }));
  }
} finally {
  for (const session of sessions) session.client.close();
  browserClient?.close();
  await terminateOwnedChrome(browser);
  await rm(profile, { recursive: true, force: true });
  await new Promise(resolve => server.close(resolve));
}
