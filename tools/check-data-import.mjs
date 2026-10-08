// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Mounted Data Import with native IndexedDB in a disposable unpacked extension. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHROME_FIXTURE_ARGS, spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "everytab-import-"));
const chrome = spawnOwnedChrome(chromeBin, [...CHROME_FIXTURE_ARGS,
  "--headless=new", "--disable-gpu", "--remote-debugging-port=0",
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  `--user-data-dir=${profile}`, `--load-extension=${extensionRoot}`,
  `--disable-extensions-except=${extensionRoot}`, "--no-first-run",
  "--disable-background-networking", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let page;
try {
  const debug = await debuggingUrl(chrome);
  const id = await detectExtension(debug);
  page = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
  await prepareSession(page);
  await evaluate(page, `(async () => {
    const { createDataSurface } = await import(chrome.runtime.getURL('js/ui/data-surface.js'));
    window.importStore = await import(chrome.runtime.getURL('js/lib/store.js'));
    await importStore.listItems('inbox');
    window.importHost = document.createElement('div');
    document.body.append(importHost);
    window.importChanges = 0;
    await createDataSurface({ getBody: () => importHost, setHeading() {},
      onChanged: async () => { importChanges++; } }).render();
    window.importArea = importHost.querySelector('textarea');
    const selects = importHost.querySelectorAll('.data-import-controls select');
    selects[0].value = ''; selects[1].value = 'inbox';
    importArea.value = 'https://fixture.example/first\\nhttps://fixture.example/second';
    importArea.dispatchEvent(new Event('input', { bubbles: true }));
    window.importButton = importHost.querySelector('.data-import-outcome button');
    window.importLock = navigator.locks.request('everytab-store', () =>
      new Promise(resolve => { window.releaseImportLock = resolve; }));
  })()`);
  await waitFor(page, "typeof releaseImportLock === 'function'", "held import persistence boundary");
  const pending = await evaluate(page, `(() => {
    importButton.click(); importButton.click();
    const disabledImmediately = importButton.disabled;
    importArea.value = 'https://fixture.example/newer-draft';
    importArea.dispatchEvent(new Event('input', { bubbles: true }));
    return { disabledImmediately, disabledAfterEdit: importButton.disabled, changes: importChanges };
  })()`);
  assert.deepEqual(pending, { disabledImmediately: true, disabledAfterEdit: true, changes: 0 });
  await evaluate(page, "releaseImportLock(); undefined");
  await waitFor(page, "importChanges === 1 && !importButton.disabled", "first import committed");
  const first = await evaluate(page, `(async () => ({
    records: (await importStore.listItems('inbox')).map(item => item.tabs.map(tab => tab.url)),
    draft: importArea.value,
    status: importHost.querySelector('.data-import-outcome .item-meta').textContent
  }))()`);
  assert.deepEqual(first.records, [["https://fixture.example/first", "https://fixture.example/second"]]);
  assert.equal(first.draft, "https://fixture.example/newer-draft");
  assert.match(first.status, /Imported 1 bundle \(2 tabs\)/);
  await evaluate(page, "importButton.click(); undefined");
  await waitFor(page, "importChanges === 2 && importButton.disabled", "newer draft committed separately");
  assert.deepEqual(await evaluate(page, `(async () => ({
    count: (await importStore.listItems('inbox')).length, draft: importArea.value,
    status: importHost.querySelector('.data-import-outcome .item-meta').textContent
  }))()`), { count: 2, draft: "", status: "Imported 1 bundle (1 tabs) to Inbox." });
  console.log("PASS: native Data Import prevents double save, retains newer drafts and reports committed counts");
} finally {
  page?.client.close();
  await terminateOwnedChrome(chrome);
  await rm(profile, { recursive: true, force: true });
}
