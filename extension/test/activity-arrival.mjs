import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const fixture = installDomFixture();
const previousCss = globalThis.CSS;
const previousFrame = globalThis.requestAnimationFrame;
globalThis.CSS = { escape: (value) => String(value) };
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
const createElement = document.createElement.bind(document);
document.createElement = (tag) => {
  const node = createElement(tag);
  // Native details owns disclosure interaction. This fixture supplies only its
  // reflected open property; browser keyboard/default-action coverage is separate.
  if (tag === "details") Object.defineProperty(node, "open", {
    get() { return node.getAttribute("open") !== null; },
    set(value) { if (value) node.setAttribute("open", ""); else node.removeAttribute("open"); }
  });
  return node;
};

const entry = {
  id: "auto-entry", at: Date.now(), auto: true,
  label: "Auto-saved 1 tab to the Inbox", actionKind: "auto-saved-tabs",
  actionParams: { count: 1, name: "Project brief" },
  dels: [{ store: "inbox", id: "saved" }]
};
let releaseRouteRead;
let releaseQueuedRead;
let blockedJournalReads = [];
const routeRead = new Promise((resolve) => { releaseRouteRead = resolve; });
const queuedRead = new Promise((resolve) => { releaseQueuedRead = resolve; });
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  storage: { local: { get: async () => ({}) } }
};
const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "activity-arrival"
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
await library.commit({ localSets: { journal: [entry] } });
const readLocal = library.readLocal;
library.readLocal = async (keys) => {
  if (keys.includes("journal") && blockedJournalReads.length) await blockedJournalReads.shift();
  return readLocal(keys);
};
setStorageAuthorityForTests(createStorageAuthority({ library, recovery }));

try {
  localStorage.setItem("tvActivityFilter", "manual");
  const body = document.createElement("div");
  const replaceChildren = body.replaceChildren.bind(body);
  body.replaceChildren = (...children) => {
    const focused = document.activeElement;
    replaceChildren(...children);
    // Native reparenting loses focus even if the same summary is mounted again.
    if (focused?.tagName === "SUMMARY") document.activeElement = document.body;
  };
  const heading = document.createElement("h2");
  document.body.append(heading, body);
  const { createActivitySurface } = await import("../js/ui/activity-surface.js");
  const refreshes = [];
  const surface = createActivitySurface({
    getBody: () => body,
    getHeading: () => heading,
    setHeading: (text) => { heading.textContent = text; },
    showNotice() {}, queueRefresh: (sections) => refreshes.push(sections), download() {}
  });
  await surface.render();
  assert.equal(body.querySelector("[data-activity-entry-id]"), null,
    "the starting manual filter hides automatic activity");
  blockedJournalReads = [routeRead, queuedRead];
  const routeRender = surface.render();
  await Promise.resolve();
  const arrival = surface.goToEntry(entry.id);
  releaseRouteRead();
  const [, arrived] = await Promise.all([routeRender, arrival]);
  releaseQueuedRead();
  // Let every bounded settleCue retry finish before restoring the DOM globals.
  await new Promise((resolve) => setTimeout(resolve, 660));
  assert.equal(arrived, true,
    "an exact Activity deep link resolves its durable entry");
  const row = body.querySelector('[data-activity-entry-id="auto-entry"]');
  assert.ok(row?.classList.contains("activity-arrival"),
    "the exact row receives the non-moving arrival cue");
  assert.equal(document.activeElement, row,
    "the exact row receives focus after the route settles");
  assert.equal(row.querySelector(".t")?.textContent,
    "Auto-saved “Project brief” to the Inbox",
    "the arrived row identifies the automatically saved tab");

  const { activityAffectedTabs } = await import("../js/ui/activity-copy.js");
  const repeated = { title: '<img src=x onerror="unsafe()">', url: 'https://fixture.test/same?q=1#part' };
  const last = { title: "Last recorded title", url: "javascript:fixture-only-text" };
  const saved = { ...entry, id: "saved-batch", actionParams: { count: 3 },
    reopen: [[repeated, { ...repeated }], [last]] };
  const archived = { ...entry, id: "archived-batch", actionKind: "auto-archived-items",
    actionParams: { count: 2 }, puts: [
      { store: "inbox", item: { id: "one", tabs: [last, repeated] } },
      { store: "inbox", item: { id: "two", tabs: [{ ...repeated }] } }
    ] };
  const legacy = { ...entry, id: "legacy", actionParams: { count: 4 } };
  const partial = { ...entry, id: "partial", actionParams: { count: 3 }, reopen: [[last]] };
  const manual = { ...entry, id: "manual", auto: false, actionKind: "saved-tabs-inbox", reopen: [[last]] };
  const records = [saved, archived, legacy, partial, manual];
  const beforeRecords = structuredClone(records);
  const writeJournal = (value) => library.commit({ localSets: { journal: value } });
  const detailsFor = (id) => body.querySelector(`[data-activity-details-id="${id}"]`);
  const rowsOf = (details) => [...details.querySelectorAll("li")].map((li) => ({
    title: li.querySelector(".activity-tab-title")?.textContent ?? "",
    url: li.querySelector(".activity-tab-url")?.textContent ?? ""
  }));
  await writeJournal(records); await surface.render();
  const details = detailsFor(saved.id), summary = details.querySelector("summary");
  assert.equal(details.tagName, "DETAILS");
  assert.equal(summary.textContent, "3 tabs");
  assert.deepEqual(rowsOf(details), [repeated, repeated, last], "all recorded occurrences retain window/order and duplicates");
  assert.equal(details.querySelector("img"), null, "titles are text, never markup");
  assert.equal(details.querySelector("a"), null, "recorded addresses never become executable links");
  assert.deepEqual(rowsOf(detailsFor(archived.id)), [last, repeated, repeated]);
  assert.equal(detailsFor(archived.id).querySelector(".activity-tab-note"), null,
    "two archived items can contain three tabs without claiming missing data");
  assert.equal(detailsFor(legacy.id), null);
  assert.match(body.querySelector('[data-activity-entry-id="legacy"]').parentElement.textContent,
    /Tab details were not recorded for this action/);
  assert.match(detailsFor(partial.id).textContent, /Only the recorded tab details are shown/);
  assert.equal(detailsFor(manual.id), null, "manual entries are outside this feature");
  assert.deepEqual(activityAffectedTabs({ ...saved, reopen: [null, [{}, null]] }),
    { tabs: [{ title: "", url: "" }, { title: "", url: "" }], partial: true });
  assert.deepEqual(records, beforeRecords, "presentation must not mutate the immutable journal refs");

  details.open = true; summary.focus();
  await surface.render();
  assert.equal(detailsFor(saved.id), details, "unchanged disclosure retains its DOM owner");
  assert.equal(details.open, true);
  assert.equal(document.activeElement, summary, "focused native summary restored after mounted refresh");
  const changed = { ...saved, reopen: [[{ ...repeated, title: "Updated recorded title" }, repeated], [last]] };
  await writeJournal([changed, archived, legacy, partial, manual]); await surface.render();
  const changedDetails = detailsFor(saved.id);
  assert.notEqual(changedDetails, details, "a changed durable payload refreshes the displayed content");
  assert.equal(changedDetails.open, true);
  assert.equal(document.activeElement, changedDetails.querySelector("summary"));
  assert.equal(rowsOf(changedDetails)[0].title, "Updated recorded title");
  await [...body.querySelectorAll(".activity-seg")].find((button) => button.textContent === "Yours").dispatch("click");
  assert.equal(detailsFor(saved.id), null);
  await [...body.querySelectorAll(".activity-seg")].find((button) => button.textContent === "All").dispatch("click");
  assert.equal(detailsFor(saved.id), changedDetails);
  assert.equal(changedDetails.open, true, "filtering retains the disclosure state for an existing entry");

  const undoCalls = [];
  chrome.runtime = { sendMessage: async (message) => {
    undoCalls.push(message);
    await writeJournal([{ ...changed, undone: true }, archived, legacy, partial, manual]);
    return { ok: true, status: "undone" };
  } };
  await body.querySelector('[data-activity-entry-id="saved-batch"] [data-action-id="undo"]').dispatch("click");
  assert.deepEqual(undoCalls, [{ type: "undo-last", id: saved.id }]);
  assert.equal(detailsFor(saved.id).open, true, "Undo does not discard recorded tab details");
  assert.deepEqual(rowsOf(detailsFor(saved.id)), [{ ...repeated, title: "Updated recorded title" }, repeated, last]);
  assert.equal(refreshes.length, 1, "existing cross-section Undo refresh remains intact");

  await writeJournal([]); await surface.render();
  assert.equal(body.querySelector(".activity-tab-details"), null);
  await writeJournal([saved]); await surface.render();
  assert.notEqual(detailsFor(saved.id), changedDetails, "cleared entries must not retain cached disclosure nodes");
  assert.equal(detailsFor(saved.id).open, false);
} finally {
  setStorageAuthorityForTests(null);
  await Promise.all([library.close(), recovery.close()]);
  fixture.restore();
  if (previousCss === undefined) delete globalThis.CSS; else globalThis.CSS = previousCss;
  if (previousFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousFrame;
}

console.log("PASS: Activity arrival and recorded tab disclosures preserve occurrences, refresh state, focus and Undo");
