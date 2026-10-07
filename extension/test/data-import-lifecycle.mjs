/** Data Import owns one pending operation, through the production authority. */
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const dom = installDomFixture();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const { createDataSurface } = await import("../js/ui/data-surface.js");
const { listItems } = await import("../js/lib/store.js");

async function fixture(destination = "inbox") {
  const storage = createInterleavableStorage({ deviceId: "import-lifecycle" });
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    runtime: { sendMessage: async () => ({ ok: false }) },
    storage: { local: storage.local, onChanged: storage.onChanged }
  };
  const memory = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
  const entered = deferred();
  const release = deferred();
  let pauseWrite = true;
  let rejectWrite = false;
  let rejectRefresh = false;
  let notifications = 0;
  const library = createLibraryStore({ deviceId: "import-lifecycle", adapter: {
    ...memory,
    async transaction(stores, mode, work) {
      if (mode === "readwrite" && pauseWrite) {
        pauseWrite = false;
        entered.resolve();
        await release.promise;
        if (rejectWrite) throw new Error("Synthetic private error https://secret.example/");
      }
      return memory.transaction(stores, mode, work);
    }
  } });
  setStorageAuthorityForTests(createStorageAuthority({ library,
    recovery: createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) }),
    readBrowserLocal: (keys) => storage.local.get(keys)
  }));
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  await createDataSurface({ getBody: () => host, setHeading() {}, onChanged: async () => {
    notifications++;
    if (rejectRefresh) throw new Error("Synthetic host refresh failure");
  } }).render();
  const area = host.querySelector("textarea");
  const [format, dest] = host.querySelectorAll(".data-import-controls select");
  const labels = host.querySelector(".data-import-controls input");
  format.value = "";
  dest.value = destination;
  const draft = async (text) => { area.value = text; await area.dispatch("input"); };
  await draft("https://first.example/\nhttps://second.example/");
  return { area, dest, labels, draft, library, entered, release,
    button: host.querySelector(".data-import-outcome button"),
    info: host.querySelector(".data-import-outcome span"),
    notifications: () => notifications,
    failWrite: () => { rejectWrite = true; },
    failRefresh: () => { rejectRefresh = true; }
  };
}

try {
  for (const destination of ["inbox", "archive", "session"]) {
    const f = await fixture(destination);
    const first = f.button.dispatch("click");
    const second = f.button.dispatch("click"); // even synthetic activation must be guarded
    await f.entered.promise;
    assert.equal(f.button.disabled, true, "pending import must disable repeat activation synchronously");
    f.release.resolve();
    assert.ok((await Promise.allSettled([first, second])).every((r) => r.status === "fulfilled"));
    const items = await listItems(destination === "session" ? "sessions" : destination);
    assert.equal(items.length, 1, "double activation creates exactly one saved import");
    assert.equal(f.notifications(), 1);
    assert.equal(f.area.value, "");
    assert.match(f.info.textContent, /Imported .*2/, "the success receipt remains visible after clearing preview");
    assert.equal((await f.library.readLocal(["journal"])).journal.length, 1);
  }

  const edit = await fixture("archive");
  const importing = edit.button.dispatch("click");
  await edit.entered.promise;
  await edit.draft("https://new-draft.example/");
  edit.dest.value = "inbox";
  await edit.dest.dispatch("change");
  edit.labels.checked = false;
  await edit.labels.dispatch("change");
  assert.equal(edit.button.disabled, true, "editing cannot enable another commit while one is pending");
  edit.release.resolve();
  await importing;
  assert.equal(edit.area.value, "https://new-draft.example/", "completion preserves the newer draft");
  assert.match(edit.info.textContent, /Imported 2 tabs to Archive with labels/,
    "feedback uses the committed count and captured destination/options");
  assert.equal(edit.button.disabled, false);
  assert.equal((await listItems("inbox")).length, 0);
  await edit.button.dispatch("click");
  assert.equal((await listItems("inbox"))[0].tabs[0].url, "https://new-draft.example/");

  const failed = await fixture();
  failed.failWrite();
  const attempt = failed.button.dispatch("click");
  await failed.entered.promise;
  failed.release.resolve();
  await attempt;
  assert.equal((await listItems("inbox")).length, 0);
  assert.equal(failed.notifications(), 0);
  assert.match(failed.info.textContent, /could not|couldn't/i);
  assert.doesNotMatch(failed.info.textContent, /secret|private/);
  assert.equal(failed.button.disabled, false);
  assert.match(failed.area.value, /first.example/);
  await failed.button.dispatch("click");
  assert.equal((await listItems("inbox")).length, 1, "the retained draft can retry a failed write");

  const refresh = await fixture();
  refresh.failRefresh();
  const committed = refresh.button.dispatch("click");
  await refresh.entered.promise;
  refresh.release.resolve();
  await committed;
  assert.equal((await listItems("inbox")).length, 1);
  assert.equal(refresh.area.value, "", "host refresh failure must not offer the committed draft again");
  assert.match(refresh.info.textContent, /saved|Imported/);
  assert.equal(refresh.button.disabled, true);
  console.log("PASS: Import owns one commit, captured options, newer drafts, failed writes and refresh outcomes");
} finally { dom.restore(); }
