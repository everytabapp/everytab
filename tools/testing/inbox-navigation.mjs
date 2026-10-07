// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Own focus setup, navigation boundaries and private document-root capture. */
import assert from "node:assert/strict";

/**
 * Setup runs against the outgoing document. The destination receipt must still
 * independently verify visibility/focus when its Inbox frame is observed.
 * Reload returns no loader identity; callers must independently verify a fresh
 * destination document and its URL. Acceptance of either command is not completion.
 * @param {{page:{send:Function},evaluate:Function,url:string,reload?:boolean,profile?:boolean,beforeNavigate?:()=>Promise<void>|void}} options
 * @returns {Promise<{loaderId:string,frameId?:string}|null>} Navigation identity, or null for reload.
 */
export async function navigateInboxTrial({ page, evaluate, url, reload = false, profile = false, beforeNavigate }) {
  assert.equal(typeof reload, "boolean", "Reload mode must be boolean");
  await page.send("Page.bringToFront");
  await evaluate(page, `(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  })()`);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (beforeNavigate) await beforeNavigate();
  if (profile) await page.send("Profiler.start");
  if (reload) {
    await page.send("Page.reload", { ignoreCache: false });
    return null;
  }
  const navigation = await page.send("Page.navigate", { url });
  assert.ok(typeof navigation?.loaderId === "string" && navigation.loaderId.length > 0 && !navigation.errorText,
    "Fresh Dashboard navigation must succeed");
  return navigation;
}


/**
 * Capture the current HTML root's backend identity without a full DOM snapshot.
 * The caller keeps this number private and emits only derived ownership labels.
 * Release the remote object even when description/validation fails. Fixed errors
 * prevent protocol payloads from entering diagnostic logs.
 * @param {{send:Function}} page
 * @returns {Promise<number>} Positive backend node identity, never a receipt field.
 */
export async function captureInboxDocumentRoot(page) {
  let objectId;
  try {
    try {
      const response = await page.send("Runtime.evaluate", { expression: "document.documentElement", returnByValue: false });
      if (typeof response?.result?.objectId === "string" && response.result.objectId.length > 0) {
        objectId = response.result.objectId;
      }
      assert.ok(objectId && !response.exceptionDetails);
      const { node } = await page.send("DOM.describeNode", { objectId, depth: 0 });
      assert.ok(node?.nodeType === 1 && node.localName === "html" &&
        Number.isSafeInteger(node.backendNodeId) && node.backendNodeId > 0);
      return node.backendNodeId;
    } finally {
      if (objectId) await page.send("Runtime.releaseObject", { objectId });
    }
  } catch {
    throw new Error("Inbox document root capture failed");
  }
}
