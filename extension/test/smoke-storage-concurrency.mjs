import { runSmokeBrandContracts } from "./smoke-brand-contracts.mjs";
import { runSmokeStoragePolicy } from "./smoke-storage-policy.mjs";
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "../js/lib/types.js";
import {
  NAMED_SESSION_RECORDS_KEY, buildSessionIdentityIndex
} from "../js/lib/session-identity-index.js";

export async function runSmokeStorageConcurrency({ check, browserEffects }) {
  const stepWhenPending = async (storage) => {
    while (storage.pending() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await storage.step();
  };
  /* ═══ E2-0 — storage-concurrency characterization + lock-primitive tests
     (e2-0-storage-concurrency.md §5). E2-0a wrote C-R1…C-R6 as documented
     current behavior; E2-0b (the "everytab-store" Web Lock in store.js/
     journal.js/counters.js) FLIPPED C-R1, C-R4 (patchSettings), and C-R5 part B;
     E2-0c (atomic multi-set commits) FLIPPED C-R2 + C-R5 part A; E2-0d
     (Vault serialization) FLIPPED C-R3 (remote commits under the store lock)
     and C-R6 (the protocol owns "everytab-vault-sync" with ifAvailable). Only the
     stale-base saveSettings call-site pattern (second half of C-R4) remains
     CURRENT BEHAVIOR, until E2-0e migrates those call sites to patchSettings. */
  {
    const { createInterleavableStorage, createMockLockManager } = await import("./e2-mocks.mjs");
    const { upsertItem, tombstoneItem, listItems: readItems, countItems,
      getSettings, saveSettings, patchSettings, mutateStores, withStoreLock,
      ensureSessionIdentityIndex } =
      await import("../js/lib/store.js");
    const { mergeMaps } = await import("../js/lib/merge.js");
    const { recordAction } = await import("../js/lib/journal.js");
    const {
      bindSearchSnapshotInvalidation,
      buildSearchSnapshot,
      createSearchSession
    } = await import("../js/lib/search.js");
    const fs = await import("node:fs");
    const realLocal = chrome.storage.local;
    const realOnChanged = chrome.storage.onChanged;
    const rec = (id, extra = {}) => ({
      id,
      deviceId: "dev-e2",
      createdAt: 1000,
      modifiedAt: 1000,
      schemaVersion: 1,
      kind: "tab",
      tabs: [{ url: `https://${id}.example` }],
      ...extra
    });
  
    /* — mock self-checks (§5.1 fidelity: deep copies, deterministic FIFO/stepAt release, set ledger) — */
    {
      const ist = createInterleavableStorage({ seeded: { v: 1 } });
      chrome.storage.local = ist.local;
      const got = await chrome.storage.local.get("seeded");
      got.seeded.v = 99;
      const again = await chrome.storage.local.get("seeded");
      check(
        again.seeded.v === 1,
        "E2-0 mock: get returns independent deep copies (real chrome.storage semantics)"
      );
      ist.pause();
      const g = chrome.storage.local.get("seeded");
      const s = chrome.storage.local.set({ other: 2 });
      check(
        ist.pending() === 2 && ist.pendingOps()[0].kind === "get" && ist.pendingOps()[1].kind === "set",
        "E2-0 mock: paused ops queue FIFO with descriptors"
      );
      await ist.stepAt(1); // release the set out of order
      check(ist.snapshot().other === 2 && ist.pending() === 1, "E2-0 mock: stepAt releases out of order");
      await ist.resume();
      await g;
      await s;
      check(
        ist.setLog.length === 1 && ist.setLog[0][0] === "other",
        "E2-0 mock: set-call ledger records every commit's key list (§7.3)"
      );
    }
  
    /* — N46 · pre-index mature-profile backfill is additive and locked. — */
    {
      navigator.locks = createMockLockManager();
      const named = {
        id: "n46-named", name: "Daily work", auto: false, modifiedAt: 2,
        windows: [[{ url: "https://named.example" }]]
      };
      const auto = {
        id: "n46-auto", name: "Snapshot", auto: true, modifiedAt: 1,
        windows: [[{ url: "https://snapshot.example" }]]
      };
      const ist = createInterleavableStorage({
        [STORE_KEYS.sessions]: { [named.id]: named, [auto.id]: auto },
        sessionIdentityIndex: {
          version: 1,
          sessionsById: { [named.id]: { id: named.id, name: named.name } }
        }
      });
      chrome.storage.local = ist.local;
      const before = JSON.stringify(ist.snapshot()[STORE_KEYS.sessions]);
      const index = await ensureSessionIdentityIndex();
      const after = ist.snapshot();
      check(
        JSON.stringify(after[STORE_KEYS.sessions]) === before &&
          JSON.stringify(Object.values(index.sessionsById)) ===
            JSON.stringify([{
              id: named.id, name: named.name,
              windowUrls: [["https://named.example/"]]
            }]) &&
          index.version === 2 &&
          ist.setLog.length === 1 &&
          JSON.stringify(ist.setLog[0]) === JSON.stringify([
            NAMED_SESSION_RECORDS_KEY, "sessionIdentityIndex"
          ]),
        "N46r: v1 backfill preserves the complete Session/snapshot store and writes only its compact read/write projections"
      );
    }
  
    /* — C-R1 · §2.3 R1 (lost record: same-key RMW overlap) — FLIPPED at E2-0b.
       Two contexts upsert different items into the inbox map (concrete pairing:
       background auto-save alarm + dashboard labeling). Under the store lock,
       context B cannot even issue its read until A's set committed, so B's map
       includes A's record: no more lost update. store.js upsertItem is the real
       code under test. — */
    {
      const ist = createInterleavableStorage({});
      chrome.storage.local = ist.local;
      ist.pause();
      const a = upsertItem(STORE_KEYS.inbox, rec("cr1-a")); // context A (background)
      const b = upsertItem(STORE_KEYS.inbox, rec("cr1-b")); // context B (dashboard) — queued on the lock
      // The explicit authority seam resolves before the adapter issues its
      // browser-map test read. Let that microtask boundary settle first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(
        ist.pending() === 1,
        "E2-0 C-R1 (FIXED): B holds no storage op while A owns the lock (serialized, not interleaved)"
      );
      await stepWhenPending(ist); // A.get (empty map)
      await stepWhenPending(ist); // A.set commits {cr1-a}; lock releases; B acquires
      await stepWhenPending(ist); // B.get — sees A's committed record
      await stepWhenPending(ist); // B.set — whole map now carries BOTH
      await a;
      await b;
      const map = ist.snapshot()[STORE_KEYS.inbox];
      check(
        !!map["cr1-a"] && !!map["cr1-b"],
        "E2-0 C-R1 (FIXED at E2-0b): overlapped inbox RMW serializes — both records present"
      );
      check(
        ist.setLog.length === 2,
        "E2-0 C-R1 (FIXED): two sequential whole-map commits in the ledger, no overwrite"
      );
    }
  
    /* — C-R2 · §2.3 R2 (torn multi-key operation) — FLIPPED at E2-0c for the
       archive move: sweepInboxExpiry (the REAL domain function) now commits the
       Archive copy + Inbox tombstone + itemsExpired counter in ONE set. At every
       interleaving boundary the store is either the full pre-state or the full
       post-state — the tab can never be live in BOTH stores. (Remaining
       multi-set sequences in labels/actions/sessions/snooze flip with their own
       E2-0c sub-batches.) — */
    {
      const { sweepInboxExpiry: sweepE2 } = await import("../js/lib/archive.js");
      const DAY2 = 86_400_000;
      const x = { ...rec("cr2-x"), source: "dump", modifiedAt: 1000 };
      const ist = createInterleavableStorage({
        settings: { inboxExpiryDays: 1 },
        [STORE_KEYS.inbox]: { [x.id]: x }
      });
      chrome.storage.local = ist.local;
      const tornFree = () => {
        const snap = ist.snapshot();
        const inA = snap[STORE_KEYS.archive]?.[x.id];
        const inI = snap[STORE_KEYS.inbox]?.[x.id];
        return !((!!inA && !inA.deletedAt) && (!!inI && !inI.deletedAt));
      };
      ist.pause();
      const sweep = sweepE2(1000 + 2 * DAY2);
      let everTorn = false;
      let guard = 0;
      while ((ist.pending() > 0 || guard === 0) && guard < 20) {
        if (!tornFree()) everTorn = true;
        await stepWhenPending(ist);
        guard++;
      }
      const movedN = await sweep;
      check(
        !everTorn && tornFree(),
        "E2-0 C-R2 (FIXED at E2-0c): at every boundary of the archive move the store is all-pre or all-post — never live in both stores"
      );
      const fin = ist.snapshot();
      check(
        movedN === 1 &&
          fin[STORE_KEYS.archive][x.id].archivedAt === 1000 + 2 * DAY2 &&
          !!fin[STORE_KEYS.inbox][x.id].deletedAt,
        "E2-0 C-R2 (FIXED): the move itself is unchanged — archived with archivedAt, tombstoned in Inbox"
      );
      check(
        ist.setLog.length === 1 && ist.setLog[0].length === 5 &&
          ist.setLog[0].includes(ARCHIVE_OVERLAY_KEY) && ist.setLog[0].includes("journal") &&
          fin.journal?.[0]?.auto === true &&
          fin.journal[0].puts.length === 1 && fin.journal[0].puts[0].store === STORE_KEYS.inbox,
        "E2-0 C-R2 (FIXED)/F46: ONE commit carries archive + overlay clear + inbox + counter + the auto undo entry"
      );
    }
  
    /* — C-R3 · §2.3 R3 (vault pull stale overwrite) — FLIPPED at E2-0d. The
       merge phase (local read → in-memory merge → whole-map set) now runs UNDER
       the "everytab-store" lock (js/vault/sync.js syncItemStore), so a record
       upserted mid-sync can only land before the pull's read (merged in) or after
       its set (survives) — never in the read-set window where the whole-map set
       used to drop it. This mirrors the locked structure and races it against the
       REAL production upsertItem, which takes the same lock. — */
    {
      const r0 = rec("cr3-existing");
      const remoteNew = rec("cr3-remote", { modifiedAt: 3000 });
      const ist = createInterleavableStorage({ [STORE_KEYS.inbox]: { [r0.id]: r0 } });
      chrome.storage.local = ist.local;
      // The pull's merge phase, under the store lock (as E2-0d structures it).
      const pull = withStoreLock(async () => {
        const local = (await chrome.storage.local.get(STORE_KEYS.inbox))[STORE_KEYS.inbox] ?? {};
        const { merged, pulled } = mergeMaps(local, { [remoteNew.id]: remoteNew });
        if (pulled.length > 0) await chrome.storage.local.set({ [STORE_KEYS.inbox]: merged });
      });
      // A user creates a record mid-sync via the REAL production path — also
      // lock-guarded, so it serializes with the pull rather than interleaving.
      const localUp = upsertItem(STORE_KEYS.inbox, rec("cr3-fresh"));
      await pull;
      await localUp;
      const map = ist.snapshot()[STORE_KEYS.inbox];
      check(
        !!map["cr3-fresh"] && !!map["cr3-remote"] && !!map["cr3-existing"],
        "E2-0 C-R3 (FIXED at E2-0d): the merge phase and the mid-sync upsert serialize on the store lock — the fresh record survives, nothing dropped"
      );
    }
  
    /* — C-R4 · §2.3 R4 (settings clobber) — FLIPPED at E2-0b via patchSettings.
       Part 1: two concurrent patchSettings of different fields read fresh under
       the lock, so BOTH fields stick. Part 2 documents the stale-base pattern
       saveSettings({...await getSettings(), patch}) — the base is read OUTSIDE
       the lock, so it still clobbers. E2-0e migrated every individual-field call
       site to patchSettings; the ONLY remaining saveSettings caller is the
       settings-form whole-form submit, where whole-object LWW is the intended
       design (Part 2 stays as the documented contract for that path). — */
    {
      const ist = createInterleavableStorage({});
      chrome.storage.local = ist.local;
      ist.pause();
      const p1 = patchSettings({ inboxExpiryDays: 5 }); // popup
      const p2 = patchSettings({ uiScheme: "matcha" }); // options — queued on the lock
      await stepWhenPending(ist); // p1 fresh read under the lock
      await stepWhenPending(ist); // p1 one-set commit; lock passes to p2
      await stepWhenPending(ist); // p2 fresh read — sees p1's field
      await stepWhenPending(ist); // p2 one-set commit
      await p1;
      await p2;
      const s1 = ist.snapshot().settings;
      check(
        s1.uiScheme === "matcha" && s1.inboxExpiryDays === 5,
        "E2-0 C-R4 (FIXED at E2-0b): concurrent patchSettings of different fields — both stick"
      );
    }
    {
      const ist = createInterleavableStorage({
        settings: { suspendWhitelist: ["https://one.example/"] }
      });
      chrome.storage.local = ist.local;
      ist.pause();
      const append = (url) => patchSettings((current) => ({
        suspendWhitelist: [...current.suspendWhitelist, url]
      }));
      const p1 = append("https://two.example/");
      const p2 = append("https://three.example/");
      await stepWhenPending(ist);
      await stepWhenPending(ist);
      await stepWhenPending(ist);
      await stepWhenPending(ist);
      await p1;
      await p2;
      check(
        JSON.stringify(ist.snapshot().settings.suspendWhitelist) === JSON.stringify([
          "https://one.example/", "https://two.example/", "https://three.example/"
        ]),
        "E2-0 C-R4: functional patchSettings updates compose from the latest locked value"
      );
    }
    {
      const ist = createInterleavableStorage({});
      chrome.storage.local = ist.local;
      ist.pause();
      const popup = (async () => saveSettings({ ...(await getSettings()), inboxExpiryDays: 5 }))();
      const options = (async () => saveSettings({ ...(await getSettings()), uiScheme: "matcha" }))();
      await stepWhenPending(ist); // popup's stale base read (outside the lock)
      await stepWhenPending(ist); // options' stale base read (same stale base)
      await stepWhenPending(ist); // popup's whole-object write (locked, serialized)
      check(
        ist.snapshot().settings.inboxExpiryDays === 5,
        "E2-0 C-R4: the first surface's field did commit"
      );
      await stepWhenPending(ist); // options' whole-object write from the stale base
      await popup;
      await options;
      const s = ist.snapshot().settings;
      check(
        s.uiScheme === "matcha" && s.inboxExpiryDays !== 5,
        "E2-0 C-R4 (whole-form contract): stale-base saveSettings still clobbers by design LWW — individual-field call sites migrated to patchSettings at E2-0e"
      );
    }
  
    /* — C-R5 · context death. Part A FLIPPED at E2-0c for the archive move: the
       REAL sweepInboxExpiry has one atomic commit point, so a worker killed
       mid-operation leaves the FULL pre-state — never the old torn "in both
       stores" half. (Sequences not yet converted — labels/actions/sessions/
       snooze — flip with their own E2-0c sub-batches.) Part B (below) was
       flipped at E2-0b: the lock auto-releases on death and the next writer
       proceeds. — */
    {
      // fresh LockManager: this sub-block deliberately abandons a critical
      // section (the dead worker's pending commit holds the lock), so it must
      // not share the lock partition with later tests.
      navigator.locks = createMockLockManager();
      const { sweepInboxExpiry: sweepE2 } = await import("../js/lib/archive.js");
      const DAY2 = 86_400_000;
      const x = { ...rec("cr5-x"), source: "dump", modifiedAt: 1000 };
      const ist = createInterleavableStorage({
        settings: { inboxExpiryDays: 1 },
        [STORE_KEYS.inbox]: { [x.id]: x }
      });
      chrome.storage.local = ist.local;
      ist.pause();
      void sweepE2(1000 + 2 * DAY2);
      await stepWhenPending(ist); // settings read
      await stepWhenPending(ist); // the mutator's fresh 3-key read under the lock
      // …the single atomic set is now pending — the worker dies HERE (the one
      // moment that used to persist the torn state): the op is simply abandoned.
      const snap = ist.snapshot();
      const inA = snap[STORE_KEYS.archive]?.[x.id];
      const inI = snap[STORE_KEYS.inbox]?.[x.id];
      check(
        !inA && !!inI && !inI.deletedAt && ist.setLog.length === 0,
        "E2-0 C-R5 (FIXED at E2-0c): context death before the archive move's single commit leaves the FULL pre-state — all-or-nothing, nothing torn"
      );
    }
    {
      // Part B — real primitive: SW dies while holding "everytab-store".
      navigator.locks = createMockLockManager();
      const lm = navigator.locks;
      const ist = createInterleavableStorage({});
      chrome.storage.local = ist.local; // unpaused: ops run as released by the lock
      lm.setDefaultContext("sw");
      let swEntered = false;
      void withStoreLock(() => {
        swEntered = true;
        return new Promise(() => {}); // the SW is killed mid-critical-section
      });
      lm.setDefaultContext("page");
      const write = upsertItem(STORE_KEYS.inbox, rec("cr5-next")); // real production path, queued
      check(
        swEntered &&
          lm.heldBy("everytab-store") === "sw" &&
          lm.queuedCount("everytab-store") === 1,
        "E2-0 C-R5 (FIXED path): a withStoreLock holder blocks the next production writer"
      );
      const skipped = await lm.request(
        "everytab-store",
        { ifAvailable: true, context: "sync" },
        async (lock) => (lock === null ? "skipped" : "ran")
      );
      check(
        skipped === "skipped",
        "E2-0 C-R5: ifAvailable skips while held (§4.1 vault-sync contract, used by E2-0d)"
      );
      lm.die("sw"); // MV3 kills the service worker while it holds the lock
      await write;
      check(
        !!ist.snapshot()[STORE_KEYS.inbox]["cr5-next"] && lm.heldBy("everytab-store") === null,
        "E2-0 C-R5 (FIXED at E2-0b): context death auto-releases the store lock; the queued writer proceeds and commits"
      );
      navigator.locks = createMockLockManager(); // clean partition for the rest of the block
    }
  
    /* — E2-0b · mutateStores (§4.2): the atomic-batch seam E2-0c converts the
       multi-set domain sequences to. Two overlapped batches must serialize, and
       each must commit ALL its keys in exactly ONE set (the ledger proves the
       single atomic commit point); a null mutator result is a validated no-op. — */
    {
      const JKEY = "journal";
      const ist = createInterleavableStorage({});
      chrome.storage.local = ist.local;
      ist.pause();
      const m1 = mutateStores([STORE_KEYS.inbox, JKEY], (maps) => ({
        [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), "mb-a": rec("mb-a") },
        [JKEY]: [...(maps[JKEY] ?? []), { id: "j-a" }]
      }));
      const m2 = mutateStores([STORE_KEYS.inbox, JKEY], (maps) => ({
        [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), "mb-b": rec("mb-b") },
        [JKEY]: [...(maps[JKEY] ?? []), { id: "j-b" }]
      }));
      await stepWhenPending(ist); // m1 fresh read (both keys, one get)
      await stepWhenPending(ist); // m1 single two-key commit; lock passes to m2
      await stepWhenPending(ist); // m2 fresh read — sees m1's commit
      await stepWhenPending(ist); // m2 single two-key commit
      check((await m1) === true && (await m2) === true, "E2-0b mutateStores: both batches report committed");
      const fin = ist.snapshot();
      check(
        !!fin[STORE_KEYS.inbox]["mb-a"] &&
          !!fin[STORE_KEYS.inbox]["mb-b"] &&
          fin[JKEY].length === 2,
        "E2-0b mutateStores: overlapped batches serialize — no lost record, no lost journal entry"
      );
      check(
        ist.setLog.length === 2 && ist.setLog.every((keys) => keys.length === 2),
        "E2-0b mutateStores: each batch committed its TWO keys in exactly ONE set (atomic commit point)"
      );
      await ist.resume(); // unpause: the no-op path runs its read immediately
      const noop = await mutateStores([STORE_KEYS.inbox], () => null);
      check(
        noop === false && ist.setLog.length === 2,
        "E2-0b mutateStores: a null mutator result is a validated no-op — no set issued"
      );
    }
  
    /* — E2-0c-2 · actions.js atomic commits: the pure exits now commit their
       whole mutation + undo entry in ONE set (the ledger proves it). — */
    {
      navigator.locks = createMockLockManager();
      const { deleteTabsFromItems, moveTabsToSession } = await import("../js/lib/actions.js");
      const a = { ...rec("c2-a"), source: "dump" };
      const b = { ...rec("c2-b"), source: "dump" };
      const ist = createInterleavableStorage({ [STORE_KEYS.inbox]: { [a.id]: a, [b.id]: b } });
      chrome.storage.local = ist.local;
      const n = await deleteTabsFromItems([{ item: a, indexes: [0] }, { item: b, indexes: [0] }]);
      const s1 = ist.snapshot();
      check(
        n === 2 && ist.setLog.length === 1 && ist.setLog[0].length === 2 &&
          !!s1[STORE_KEYS.inbox][a.id].deletedAt && !!s1[STORE_KEYS.inbox][b.id].deletedAt &&
          s1.journal.length === 1 && s1.journal[0].puts.length === 2,
        "E2-0c-2: deleteTabsFromItems commits every split + its undo entry in ONE set"
      );
  
      const c = { ...rec("c2-c"), source: "dump" };
      const ist2 = createInterleavableStorage({
        deviceId: "dev-e2",
        [STORE_KEYS.inbox]: { [c.id]: c },
        [NAMED_SESSION_RECORDS_KEY]: {},
        sessionIdentityIndex: buildSessionIdentityIndex({})
      });
      chrome.storage.local = ist2.local;
      const res = await moveTabsToSession([{ item: c, indexes: [0] }], "__new", "E2 test");
      const s2 = ist2.snapshot();
      const sess = Object.values(s2[NAMED_SESSION_RECORDS_KEY] ?? {})[0];
      check(
        !!res && res.moved === 1 && ist2.setLog.length === 1 &&
          ist2.setLog[0].length === 4 &&
          ist2.setLog[0].includes("sessionIdentityIndex") &&
          !!sess && sess.name === "E2 test" && !!s2[STORE_KEYS.inbox][c.id].deletedAt &&
          s2.journal[0].id === res.entry.id,
        "E2-0c-2: moveTabsToSession commits session + identity index + splits + undo in ONE set"
      );
    }
  
    /* — E2-0c-3 · labels.js atomic commits: the label-&-archive move (split
       into per-tab archive items) commits creations + tombstone + undo entry — and,
       since F21, the label-recency bump — in ONE 4-key set. — */
    {
      navigator.locks = createMockLockManager();
      const { labelAndArchive } = await import("../js/lib/labels.js");
      const w = {
        ...rec("c3-w"), kind: "window", source: "dump",
        tabs: [{ url: "https://c3-1.example" }, { url: "https://c3-2.example" }]
      };
      const ist = createInterleavableStorage({
        deviceId: "dev-e2",
        [STORE_KEYS.inbox]: { [w.id]: w }
      });
      chrome.storage.local = ist.local;
      const n = await labelAndArchive([w], "e2");
      const s = ist.snapshot();
      const archived = Object.values(s[STORE_KEYS.archive] ?? {});
      check(
        n === 1 && ist.setLog.length === 1 && ist.setLog[0].length === 5 &&
          ist.setLog[0].includes(ARCHIVE_OVERLAY_KEY) &&
          archived.length === 2 && archived.every((a) => a.labels.includes("e2")) &&
          !!s[STORE_KEYS.inbox][w.id].deletedAt && s.journal.length === 1 &&
          s.journal[0].dels.length === 2 &&
          typeof s.labelMeta?.e2 === "number",
        "E2-0c-3: labelAndArchive atomically folds overlay + Archive items + Inbox tombstone + undo + recency"
      );
    }
  
    /* — E2-0c-4 · sessions.js atomic commits: the cross-session →Session merge
       (create target + drain sources, rule-8 tombstone) commits with its undo
       entry in ONE set. — */
    {
      navigator.locks = createMockLockManager();
      const { moveSessionTabs: msT } = await import("../js/lib/sessions.js");
      const src = {
        ...rec("c4-src"), auto: false, name: "Source",
        windows: [[{ url: "https://c4-1.example" }, { url: "https://c4-2.example" }]]
      };
      delete src.tabs;
      const ist = createInterleavableStorage({
        deviceId: "dev-e2",
        [STORE_KEYS.sessions]: { [src.id]: src },
        [NAMED_SESSION_RECORDS_KEY]: { [src.id]: src },
        sessionIdentityIndex: buildSessionIdentityIndex({ [src.id]: src })
      });
      chrome.storage.local = ist.local;
      const res = await msT(
        [{ session: src, picks: [{ windowIndex: 0, indexes: [0, 1] }] }], "__new", "Merged E2");
      const s = ist.snapshot();
      const sessions = Object.values(s[NAMED_SESSION_RECORDS_KEY]);
      const target = sessions.find((x) => x.name === "Merged E2");
      check(
        !!res && res.moved === 2 && ist.setLog.length === 1 && ist.setLog[0].length === 3 &&
          ist.setLog[0].includes("sessionIdentityIndex") &&
          !!target && !target.deletedAt && !!s[NAMED_SESSION_RECORDS_KEY][src.id].deletedAt &&
          s.journal[0].id === res.entry.id,
        "E2-0c-4: moveSessionTabs commits target + drained source + identity index + undo in ONE set"
      );
    }
  
    /* — MH 2026-07-20 fix · Open-tabs bulk "→ Session": window structure is
       preserved (one session window per source browser window) and the new
       session is journaled ("Created session" undo entry), committed atomically. — */
    {
      navigator.locks = createMockLockManager();
      const { createSessionFromWindowsJournaled } = await import("../js/lib/sessions.js");
      const ist = createInterleavableStorage({
        deviceId: "dev-e2",
        [NAMED_SESSION_RECORDS_KEY]: {},
        sessionIdentityIndex: buildSessionIdentityIndex({})
      });
      chrome.storage.local = ist.local;
      const created = await createSessionFromWindowsJournaled(
        [[{ url: "https://w1a.example" }, { url: "https://w1b.example" }],
         [{ url: "https://w2a.example" }]],
        "Two windows"
      );
      const s = ist.snapshot();
      const stored = s[NAMED_SESSION_RECORDS_KEY]?.[created.id];
      check(
        !!stored && stored.windows.length === 2 && stored.windows[0].length === 2 &&
          stored.windows[1].length === 1 && ist.setLog.length === 1 && ist.setLog[0].length === 3 &&
          ist.setLog[0].includes("sessionIdentityIndex") &&
          s.journal.length === 1 && s.journal[0].label === "Created session “Two windows”" &&
          s.journal[0].dels[0].id === created.id,
        "session-save fix: journaled create preserves windows + commits record, identity index, and undo in ONE set"
      );
      // F14: the Open-tabs bulk → Session moved to list-configs.js.
      const db = fs.readFileSync(new URL("../js/ui/list-configs.js", import.meta.url), "utf8");
      const pickStart = db.indexOf('sessionComboboxButton(localeMessage("list_to_session")');
      const pick = db.slice(pickStart, pickStart + 1_800);
      check(
        pick.includes("s.group.refs[i]") && pick.includes("createSessionFromWindowsJournaled(") &&
          pick.includes("windows, v.name || undefined, v.organization") &&
          pick.includes("v.organization") && pick.includes("addWindowsToSession(v.id, windows") &&
          !pick.includes("[refs]"),
        "session-save fix: the Open-tabs bulk → Session groups the selection per source window (no flatten) on BOTH branches"
      );
    }
  
    /* — E3 live B10 follow-up · confirming one or many Open-tab labels commits
       every Archive copy + the F21 recency bump in one atomic set. — */
    {
      navigator.locks = createMockLockManager();
      const { saveLabeledCopies } = await import("../js/lib/labels.js");
      const ist = createInterleavableStorage({ deviceId: "dev-e3-label" });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      const saved = await saveLabeledCopies([
        { url: "https://label-one.example", title: "One" },
        { url: "https://label-two.example", title: "Two" }
      ], ["work"]);
      const s = ist.snapshot();
      const archived = Object.values(s[ARCHIVE_OVERLAY_KEY] ?? {});
      check(
        saved.length === 2 && archived.length === 2 &&
          archived.every((item) => item.labels[0] === "work") &&
          Number.isFinite(s.labelMeta?.work) &&
          ist.setLog.length === 1 &&
          JSON.stringify(ist.setLog[0]) ===
            JSON.stringify([ARCHIVE_OVERLAY_KEY, "labelMeta", "journal"].sort()) &&
          !(STORE_KEYS.archive in s),
        "E3 B10/N41: labeled copies, recency, and the undo entry commit in ONE set to the small overlay, never the Archive base"
      );
      check(
        (s.journal ?? []).length === 1 &&
          s.journal[0].label === "Saved 2 labeled copies" &&
          s.journal[0].dels.length === 2 &&
          s.journal[0].dels.every((d) => d.store === STORE_KEYS.archive) &&
          JSON.stringify(s.journal[0].dels.map((d) => d.id).sort()) ===
            JSON.stringify(saved.map((r) => r.id).sort()),
        "N41: labeling from Open tabs journals an inverse that tombstones exactly the copies it created"
      );
      const configs = fs.readFileSync(new URL("../js/ui/list-configs.js", import.meta.url), "utf8");
      check(
        configs.includes("saveLabeledCopies([ctx.ref], labels)") &&
          configs.includes("saveLabeledCopies(refsOf(sel), labels)") &&
          !configs.includes("await touchLabels(labels)"),
        "E3 B10: Open single/bulk confirmation use one shared atomic helper"
      );
      const labelsSource = fs.readFileSync(new URL("../js/lib/labels.js", import.meta.url), "utf8");
      const storeSource = fs.readFileSync(new URL("../js/lib/store.js", import.meta.url), "utf8");
      check(
        labelsSource.includes('pspan("label:metadata")') &&
          labelsSource.includes('pspan("label:locked-commit")') &&
          labelsSource.includes('pspan("label:confirm-total")'),
        "E3 B10: label confirmation exposes metadata, locked commit, and total live spans"
      );
      check(
        storeSource.includes('pspan("store:lock-wait")') &&
          storeSource.includes('pspan("store:locked-read")') &&
          storeSource.includes('pspan("store:mutate")') &&
          storeSource.includes('pspan("store:commit")'),
        "E3 B10: atomic mutations expose lock wait, read, merge, and commit live spans"
      );
    }
  
    /* — E3 Archive overlay · one logical Archive over a backward-compatible
       whole-map base plus fast small writes. — */
    {
      navigator.locks = createMockLockManager();
      const { saveLabeledCopies } = await import("../js/lib/labels.js");
      const base = rec("overlay-base", { modifiedAt: 1000 });
      const over = rec("overlay-new", { modifiedAt: 2000 });
      const ist = createInterleavableStorage({
        [STORE_KEYS.archive]: { [base.id]: base },
        [ARCHIVE_OVERLAY_KEY]: { [over.id]: over }
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      const first = await readItems(STORE_KEYS.archive);
      check(
        first.some((item) => item.id === base.id) && first.some((item) => item.id === over.id),
        "E3 Archive overlay: logical reads merge the legacy base and live overlay"
      );
  
      ist.pauseChanges();
      const [own] = await saveLabeledCopies(
        [{ url: "https://overlay-own.example", title: "Own write" }],
        ["overlay"]
      );
      check(
        (await readItems(STORE_KEYS.archive)).some((item) => item.id === own.id),
        "E3 Archive overlay: this context reads its own overlay commit before onChanged"
      );
      ist.flushChanges();
  
      const external = rec("overlay-external", { modifiedAt: 3000 });
      await chrome.storage.local.set({
        [ARCHIVE_OVERLAY_KEY]: {
          ...(ist.snapshot()[ARCHIVE_OVERLAY_KEY] ?? {}),
          [external.id]: external
        }
      });
      check(
        (await readItems(STORE_KEYS.archive)).some((item) => item.id === external.id),
        "E3 Archive overlay: an external overlay commit invalidates the logical Archive cache"
      );
  
      ist.setLog.length = 0;
      await mutateStores([STORE_KEYS.archive], (maps) => ({
        [STORE_KEYS.archive]: {
          ...maps[STORE_KEYS.archive],
          folded: rec("folded", { modifiedAt: 4000 })
        }
      }));
      const folded = ist.snapshot();
      check(
        ist.setLog.length === 1 &&
          JSON.stringify(ist.setLog[0]) ===
            JSON.stringify([STORE_KEYS.archive, ARCHIVE_OVERLAY_KEY].sort()) &&
          Object.keys(folded[ARCHIVE_OVERLAY_KEY]).length === 0 &&
          !!folded[STORE_KEYS.archive][base.id] &&
          !!folded[STORE_KEYS.archive][over.id] &&
          !!folded[STORE_KEYS.archive][own.id] &&
          !!folded[STORE_KEYS.archive][external.id] &&
          !!folded[STORE_KEYS.archive].folded,
        "E3 Archive overlay: a full mutation atomically folds every overlay record into the base"
      );
    }
  
    /* — E2-0c-5 · Snooze delivery persists its single-owner claim before Chrome,
       then commits the counter + one-shot tombstone + completed receipt together.
       A stored retired quiet value still cannot redirect the wake. — */
    {
      navigator.locks = createMockLockManager();
      const { fireSnooze: fireE2 } = await import("../js/lib/snooze.js");
      const sn = {
        id: "c5-snooze", deviceId: "dev-e2", createdAt: 1000, modifiedAt: 1000,
        schemaVersion: 1, url: "https://c5.example", title: "C5", dueAt: 2000
      };
      const ist = createInterleavableStorage({
        deviceId: "dev-e2",
        settings: { snoozeWakeQuiet: true },
        [STORE_KEYS.snoozes]: { [sn.id]: sn }
      });
      chrome.storage.local = ist.local;
      browserEffects.clearTabs();
      await fireE2(sn.id);
      const s = ist.snapshot();
      const delivered = Object.values(s[STORE_KEYS.inbox] ?? {});
      check(
        ist.setLog.length === 2 &&
          JSON.stringify(ist.setLog[0]) === JSON.stringify(["snoozeDeliveryReceipts"]) &&
          JSON.stringify(ist.setLog[1]) ===
            JSON.stringify(["counters", "snoozeDeliveryReceipts", STORE_KEYS.snoozes].sort()) &&
          delivered.length === 0 && browserEffects.tabs.includes("https://c5.example") &&
          !!s[STORE_KEYS.snoozes][sn.id].deletedAt && s.counters.snoozesFired === 1,
        "E2-0c-5: retired quiet cannot redirect wake; claim precedes Chrome and final state is atomic"
      );
    }
  
    /* — E3-3 · one per-context read cache behind getMap. The interleavable
       storage's onChanged double represents the exact committed-write signal
       Chrome sends to every extension context. — */
    {
      navigator.locks = createMockLockManager();
      const old = rec("e3-cache-old");
      const fresh = rec("e3-cache-external", { modifiedAt: 2000 });
      const ist = createInterleavableStorage({
        [STORE_KEYS.inbox]: { [old.id]: old }
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
  
      const miss = await readItems(STORE_KEYS.inbox);
      const hit = await readItems(STORE_KEYS.inbox);
      check(
        JSON.stringify(miss) === JSON.stringify(hit) && ist.getLog.length === 1,
        "E3-3: cache miss and hit are deep-equal, and the hit issues no storage read"
      );
      miss[0].tabs[0].url = "https://mutated-caller.example";
      check(
        (await readItems(STORE_KEYS.inbox))[0].tabs[0].url === "https://e3-cache-old.example",
        "E3-3: every cache read is an independent clone (a caller cannot contaminate the cache)"
      );
  
      // Raw set = another extension context. Its committed onChanged event must
      // evict this context's cached Inbox snapshot by key.
      await chrome.storage.local.set({
        [STORE_KEYS.inbox]: { [old.id]: old, [fresh.id]: fresh }
      });
      check(
        (await readItems(STORE_KEYS.inbox)).some((item) => item.id === fresh.id),
        "E3-3: a read after another context's committed write returns the NEW value"
      );
    }
    {
      navigator.locks = createMockLockManager();
      const old = rec("e3-own-old");
      const own = rec("e3-own-new");
      const ist = createInterleavableStorage({
        [STORE_KEYS.inbox]: { [old.id]: old }
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      await readItems(STORE_KEYS.inbox); // prime the old value
      ist.pauseChanges();
      await upsertItem(STORE_KEYS.inbox, own);
      check(
        (await readItems(STORE_KEYS.inbox)).some((item) => item.id === own.id),
        "E3-3: this context reads its own committed write without waiting for onChanged"
      );
      ist.flushChanges();
    }
    {
      navigator.locks = createMockLockManager();
      const restoredInbox = rec("e3-undo-inbox");
      const restoredArchive = rec("e3-undo-archive");
      const removedSession = {
        ...rec("e3-undo-session"),
        name: "Undo target",
        auto: false,
        windows: [[{ url: "https://session.example" }]]
      };
      delete removedSession.tabs;
      const inverse = {
        puts: [
          { store: STORE_KEYS.inbox, item: restoredInbox },
          { store: STORE_KEYS.archive, item: restoredArchive }
        ],
        dels: [{ store: STORE_KEYS.sessions, id: removedSession.id }]
      };
      const ist = createInterleavableStorage({
        journal: [],
        [STORE_KEYS.inbox]: {},
        [STORE_KEYS.archive]: {},
        [STORE_KEYS.sessions]: { [removedSession.id]: removedSession }
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      const entry = await recordAction("Undo cache test", inverse);
      await Promise.all([
        readItems(STORE_KEYS.inbox),
        readItems(STORE_KEYS.archive),
        readItems(STORE_KEYS.sessions)
      ]);
      ist.pauseChanges();
      const { undoAction } = await import("../js/lib/journal.js");
      await undoAction(entry.id);
      const [inboxAfter, archiveAfter, sessionsAfter] = await Promise.all([
        readItems(STORE_KEYS.inbox),
        readItems(STORE_KEYS.archive),
        readItems(STORE_KEYS.sessions)
      ]);
      check(
        inboxAfter.some((item) => item.id === restoredInbox.id) &&
          archiveAfter.some((item) => item.id === restoredArchive.id) &&
          !sessionsAfter.some((item) => item.id === removedSession.id),
        "E3-3: undo invalidates every section it writes before onChanged delivery"
      );
      ist.flushChanges();
    }
    {
      navigator.locks = createMockLockManager();
      const inbox = rec("e3-reads-inbox");
      const session = {
        ...rec("e3-reads-session"),
        name: "Read count",
        auto: false,
        windows: [[{ url: "https://reads.example" }]]
      };
      delete session.tabs;
      const ist = createInterleavableStorage({
        settings: { uiScheme: "cream" },
        [STORE_KEYS.inbox]: { [inbox.id]: inbox },
        [STORE_KEYS.sessions]: { [session.id]: session }
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      await Promise.all([
        countItems(STORE_KEYS.inbox),
        readItems(STORE_KEYS.inbox),
        countItems(STORE_KEYS.sessions),
        readItems(STORE_KEYS.sessions),
        getSettings(),
        getSettings(),
        getSettings()
      ]);
      check(
        ist.getLog.length === 3 &&
          JSON.stringify(ist.getLog.map((keys) => keys.length).sort()) ===
            JSON.stringify([1, 1, 2]),
        "E3-3 measurement: representative 7-read render fan-out coalesces to 3 unique-key reads (57% fewer)"
      );
    }
  
    /* — E3-5/F22/P11-14: the first interaction snapshot is one tab query + eight searched
       stores. Later keystrokes are pure; exact-key invalidation rebuilds while
       E3-3 limits storage IPC to the changed key. — */
    {
      const ist = createInterleavableStorage({
        [STORE_KEYS.inbox]: {},
        [STORE_KEYS.snoozes]: {},
        [STORE_KEYS.archive]: {},
        [STORE_KEYS.collections]: {},
        [STORE_KEYS.sessions]: {},
        [STORE_KEYS.starred]: {},
        [STORE_KEYS.organizationGroups]: {},
        [STORE_KEYS.organizationMemberships]: {}
      });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      const realTabsQuery = chrome.tabs.query;
      let tabQueries = 0;
      chrome.tabs.query = async () => {
        tabQueries += 1;
        return [{ id: 991, windowId: 99, url: "https://snapshot.example/needle", title: "Needle" }];
      };
      const session = createSearchSession({ buildSnapshot: buildSearchSnapshot });
      const unbind = bindSearchSnapshotInvalidation(session, chrome);
      await session.search("needle");
      const firstReads = ist.getLog.length;
      await session.search("need");
      await session.search("snapshot");
      check(firstReads === 8 && ist.getLog.length === 8 && tabQueries === 1,
        "F22/E3-5/P11-14 measurement: first query reads 8 stores + tabs; two later queries read 0 stores + 0 tabs");
      await ist.local.set({ [STORE_KEYS.archive]: {} });
      await session.search("needle");
      check(ist.getLog.length === 9 && tabQueries === 2,
        "E3-5 measurement: one store invalidation rebuilds, with E3-3 issuing only 1 changed-key storage read");
      unbind();
      chrome.tabs.query = realTabsQuery;
    }
  
    /* — E3-4: one prioritized frame scheduler owns dashboard refresh bursts.
       These pure characterizations freeze the event dependency matrix and the
       no-lost-dirt lifecycle before the UI wiring changes. — */
    {
      const {
        TAB_REFRESH_TASKS,
        dashboardTasksForStorage,
        createForegroundTrailingRefresh,
        createForegroundTaskQueue,
        createFrameRefreshScheduler,
        createLeadingTrailingRefresh
      } = await import("../js/ui/refresh-scheduler.js");
  
      check(
        JSON.stringify(TAB_REFRESH_TASKS) ===
          // F34-4: `starred` is deliberately absent. The launcher reads no live
          // tabs, so a tab event must not re-render it. Needs you and the
          // navigation counts run their live-only variants: the saved library
          // refreshes through storage changes alone.
          JSON.stringify(["open", "attentionLive", "duplicates", "navOpen"]),
        "E3-4/F34-4: tab events refresh the collection, live attention, dedupe and live nav counts only"
      );
  
      const matrixCases = [
        ["inbox", ["inbox", "labels", "nav", "attention"]],
        ["archive", ["archive", "labels", "navLibrary"]],
        [ARCHIVE_OVERLAY_KEY, ["archive", "labels", "navLibrary"]],
        ["sessions", ["sessions", "snapshots", "snoozes", "navSessions", "attention", "openWarm"]],
        ["smartviews", []],
        ["snoozes", ["snoozes", "sessions", "nav", "attention"]],
        ["starred", ["starred"]],
        ["vaultMetaV2", ["vault", "vaultPill", "attention"]],
        ["journal", ["activity", "attention"]],
        ["sessionWindows", ["attention", "openWarm"]],
        ["sessionIdentityIndex", ["attention", "openWarm", "open"]],
        ["focusGuardState", ["focus"]],
        ["focusTemporaryAccess", ["focus"]],
        ["settings", ["open", "inbox", "duplicates", "attention", "nav", "focus", "settings"]],
        [STORE_KEYS.organizationGroups, ["labels", "sessions"]],
        [STORE_KEYS.organizationMemberships, ["labels", "sessions"]],
        ["labelMeta", ["navLibrary"]],
        ["counters", []]
      ];
      check(
        matrixCases.every(([key, expected]) =>
          JSON.stringify(dashboardTasksForStorage({ [key]: {} })) === JSON.stringify(expected)),
        "E3-4: each storage key preserves its exact section/global refresh pairing"
      );
      check(
        JSON.stringify(dashboardTasksForStorage({
          settings: {
            oldValue: { uiScheme: "ink", uiMode: "scheme" },
            newValue: { uiScheme: "laser", uiMode: "scheme" }
          },
          schemeRotationPrepared: { newValue: { next: "nord" } }
        })) === JSON.stringify([]) &&
        JSON.stringify(dashboardTasksForStorage({
          settings: {
            oldValue: { uiScheme: "ink", uiMode: "scheme" },
            newValue: { uiScheme: "laser", uiMode: "dark" }
          },
          schemeRotationPrepared: { newValue: { next: "nord" } }
        })) === JSON.stringify(["focus", "settings", "nav", "attention"]),
        "On-open scheme rotation paints through theme.js without rebuilding Dashboard content"
      );
      check(
        dashboardTasksForStorage({ archive: {} }).length === 3 &&
          JSON.stringify(dashboardTasksForStorage({ archive: {} })) ===
            JSON.stringify(["archive", "labels", "navLibrary"]),
        "E3 follow-up measurement: Archive-only labeling is 4 → 3 tasks and uses the library-only nav path"
      );
      const dashboardSource = fs.readFileSync(
        new URL("../js/ui/dashboard.js", import.meta.url), "utf8"
      );
      const libraryNavSource = dashboardSource.slice(
        dashboardSource.indexOf("async function readNavLibraryData"),
        dashboardSource.indexOf("const renderNav = coalesceLatest")
      );
      const liveNavSource = dashboardSource.slice(
        dashboardSource.indexOf("async function renderNavInner("),
        dashboardSource.indexOf("/* ---- hero")
      );
      check(liveNavSource.includes("reads.tabs()") &&
          liveNavSource.includes("await reads.groups()") &&
          !liveNavSource.includes("chrome.tabs.query("),
        "Dashboard navigation derives Open and duplicate counts from one live-tab snapshot");
      check(
        libraryNavSource.includes("readLabelNavigationSnapshot()") &&
          !libraryNavSource.includes("countItems(STORE_KEYS.archive)") &&
          !libraryNavSource.includes("listItems(STORE_KEYS.sessions)") &&
          !libraryNavSource.includes("chrome.tabs.query") &&
          !libraryNavSource.includes("findDuplicateGroups") &&
          !libraryNavSource.includes("getVaultStatus"),
        "E3 B10: library-only nav refresh shares saved reads and skips live tabs, duplicates, and Vault"
      );
      check(
        JSON.stringify(dashboardTasksForStorage({ counters: {} }, { statsVisible: true })) ===
          JSON.stringify(["stats"]) &&
        JSON.stringify(dashboardTasksForStorage({ inbox: {} }, { statsVisible: true })) ===
          JSON.stringify(["inbox", "labels", "nav", "attention", "stats"]),
        "E3-4: Stats is dirtied only while visible, for counters or rendered data"
      );
      const archiveMutationTasks = dashboardTasksForStorage({
        inbox: {}, archive: {}, journal: {}, counters: {}
      });
      check(
        archiveMutationTasks.length === 6 &&
          JSON.stringify(archiveMutationTasks) ===
            JSON.stringify(["inbox", "labels", "archive", "activity", "attention", "nav"]),
        "P11-25/E3-4: an automatic Inbox→Archive commit refreshes Activity and Needs you once"
      );
  
      const frames = [];
      const flushes = [];
      const scheduler = createFrameRefreshScheduler(
        async (tasks) => { flushes.push(tasks); },
        { requestFrame: (cb) => { frames.push(cb); } }
      );
      scheduler.request(["open", "nav"]);
      scheduler.request(["nav", "statsline"]);
      check(frames.length === 1,
        "E3-4: two or more changes in one frame schedule one flush");
      await frames.shift()();
      check(
        JSON.stringify(flushes) === JSON.stringify([["open", "nav", "statsline"]]),
        "E3-4: one frame deduplicates repeated dirty work without dropping tasks"
      );
  
      const followFrames = [];
      const followFlushes = [];
      let releaseFirst;
      const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
      const followScheduler = createFrameRefreshScheduler(
        async (tasks) => {
          followFlushes.push(tasks);
          if (followFlushes.length === 1) await firstHeld;
        },
        { requestFrame: (cb) => { followFrames.push(cb); } }
      );
      followScheduler.request(["open"]);
      const firstFlush = followFrames.shift()();
      await Promise.resolve();
      followScheduler.request(["nav"]);
      followScheduler.request(["nav", "statsline"]);
      check(followFrames.length === 0,
        "E3-4: dirt arriving during a flush does not start a concurrent frame");
      releaseFirst();
      await firstFlush;
      check(followFrames.length === 1,
        "E3-4: dirt arriving during a flush schedules exactly one follow-up");
      await followFrames.shift()();
      check(
        JSON.stringify(followFlushes) ===
          JSON.stringify([["open"], ["nav", "statsline"]]),
        "E3-4: the follow-up flush keeps every mid-flush task"
      );
  
      const timers = [];
      const refreshes = [];
      const burst = createLeadingTrailingRefresh(
        () => refreshes.push("refresh"),
        {
          delay: 120,
          setTimer: (cb, ms) => {
            const timer = { cb, ms, cleared: false };
            timers.push(timer);
            return timer;
          },
          clearTimer: (timer) => { timer.cleared = true; }
        }
      );
      for (let i = 0; i < 5; i++) burst();
      const liveTimer = timers.findLast((timer) => !timer.cleared);
      check(refreshes.length === 1 && liveTimer?.ms === 120,
        "E3-4 measurement: 5 tab-move events start 1 leading refresh with no 400ms wait");
      liveTimer.cb();
      check(refreshes.length === 2,
        "E3-4 measurement: 5 tab-move events produce exactly 2 refreshes incl. the 120ms tail");

      const foregroundTimers = [];
      const foregroundRefreshes = [];
      let foreground = false;
      const foregroundBurst = createForegroundTrailingRefresh(
        () => foregroundRefreshes.push("refresh"),
        {
          delay: 180,
          isForeground: () => foreground,
          setTimer: (cb, ms) => {
            const timer = { cb, ms, cleared: false };
            foregroundTimers.push(timer);
            return timer;
          },
          clearTimer: (timer) => { timer.cleared = true; }
        }
      );
      for (let i = 0; i < 5; i++) foregroundBurst.request();
      let foregroundTimer = foregroundTimers.findLast((timer) => !timer.cleared);
      check(foregroundRefreshes.length === 0 && foregroundTimer?.ms === 180,
        "live Dashboard events wait behind one 180ms paint-first boundary");
      foregroundTimer.cb();
      check(foregroundRefreshes.length === 0,
        "an inactive Dashboard retains dirty live-browser work without running it");
      foreground = true;
      foregroundBurst.foreground();
      foregroundTimer = foregroundTimers.findLast((timer) => !timer.cleared);
      check(foregroundTimer?.ms === 0,
        "returning to a dirty Dashboard schedules one immediate reconciliation");
      foregroundTimer.cb();
      check(foregroundRefreshes.length === 1,
        "a dirty Dashboard reconciles exactly once when it returns to the foreground");

      const foregroundTaskFlushes = [];
      foreground = false;
      const foregroundTasks = createForegroundTaskQueue(
        (tasks) => foregroundTaskFlushes.push(tasks),
        { isForeground: () => foreground }
      );
      foregroundTasks.request(["settings", "nav"]);
      foregroundTasks.request(["nav", "attention"]);
      check(foregroundTaskFlushes.length === 0,
        "an inactive Dashboard does no storage-driven presentation work");
      foreground = true;
      foregroundTasks.foreground();
      check(
        JSON.stringify(foregroundTaskFlushes) ===
          JSON.stringify([["settings", "nav", "attention"]]),
        "returning to a Dashboard reconciles all deferred storage tasks once"
      );
  
      const db = fs.readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
      const routeBody = db.match(/function route\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
      check(
        routeBody.indexOf("syncNavSelection()") >= 0 &&
          routeBody.indexOf("syncNavSelection()") < routeBody.indexOf("renderOpen()") &&
          !routeBody.includes("renderNav()"),
        "E3-4: route updates selected nav state synchronously before async content/counts"
      );
      check(
        db.includes("renderNavShell(); // synchronous route targets; no storage/tab reads") &&
          db.includes('bootTimed("nav", renderNav())'),
        "E3-4: a synchronous nav shell paints before its full read/render waits behind Open"
      );
    }
  
    /* — E3-4 cold-Overview follow-up: section identity cannot depend on lazy
       render completion, and collapsed Open must not pay its live/saved reads. — */
    {
      const { liveSessionBindings } = await import("../js/lib/sessions.js");
      const { buildSavedLabelsByUrl } = await import("../js/lib/saved-label-index.js");
      const {
        buildSessionIdentityIndex, isSessionIdentityIndex, sessionUrlsForWindow
      } = await import("../js/lib/session-identity-index.js");
      const bindings = {
        1: { sessionId: "keep", windowIndex: 0 },
        9: { sessionId: "stale", windowIndex: 1 }
      };
      check(
        JSON.stringify(liveSessionBindings(bindings, [1, 2])) ===
          JSON.stringify({ 1: bindings[1] }),
        "E3-4r: Open uses only bindings belonging to the current live windows"
      );
      const labelIndex = buildSavedLabelsByUrl(
        [{ labels: ["project"], tabs: [
          { url: "https://example.com/path#first", labels: ["read"] }
        ] }],
        [{ tabs: [
          { url: "https://example.com/path#second", labels: ["later", "read"] },
          { url: "chrome://settings", labels: ["private"] }
        ] }]
      );
      check(
        JSON.stringify(labelIndex.get("https://example.com/path")) ===
          JSON.stringify(["project", "read", "later"]),
        "N45: saved-label enrichment canonicalizes URLs and unions item/tab labels once"
      );
      const identityIndex = buildSessionIdentityIndex({
        named: { id: "named", name: "Client review", windows: [[{ url: "https://example.com" }]] },
        auto: { id: "auto", name: "Snapshot", auto: true, windows: [[{ url: "https://large.example" }]] },
        deleted: { id: "deleted", name: "Old", deletedAt: 1, windows: [[]] }
      });
      check(
        JSON.stringify(Object.values(identityIndex.sessionsById)) ===
          JSON.stringify([{
            id: "named", name: "Client review",
            windowUrls: [["https://example.com/"]]
          }]) &&
          !("windows" in identityIndex.sessionsById.named),
        "N46r: Open's Session identity index keeps drift URL membership while excluding snapshots, tombstones, and window/tab payloads"
      );
      check(
        sessionUrlsForWindow(identityIndex.sessionsById.named, 0)?.[0] ===
          "https://example.com/" &&
          sessionUrlsForWindow({ id: "old", name: "Old" }, 0) === null &&
          !isSessionIdentityIndex({
            version: 1,
            sessionsById: { old: { id: "old", name: "Old" } }
          }),
        "N46r: restored-window drift consumes the safe URL projection and forces v1 indexes through backfill"
      );
  
      const db = fs.readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
      const openSurface = fs.readFileSync(new URL("../js/ui/open-surface.js", import.meta.url), "utf8");
      const sidePanel = fs.readFileSync(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
      const newTabEntry = fs.readFileSync(new URL("../js/ui/newtab-entry.js", import.meta.url), "utf8");
      const store = fs.readFileSync(new URL("../js/lib/store.js", import.meta.url), "utf8");
      const boot = fs.readFileSync(new URL("../js/boot.js", import.meta.url), "utf8");
      const theme = fs.readFileSync(new URL("../js/ui/theme.js", import.meta.url), "utf8");
      const background = fs.readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
      const tokens = fs.readFileSync(new URL("../css/tokens.css", import.meta.url), "utf8");
      check(
        db.includes('const h2 = el("h2", {}, shellSectionTitle(id));') &&
          db.includes('import {') && db.includes('from "./shell-copy.js"'),
        "E3-4r: every lazy section has a synchronous human-readable heading"
      );
      const openBody = db.match(/async function renderOpenInner\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
      check(
        openBody.indexOf("if (!openSectionVisible())") >= 0 &&
          openBody.indexOf("if (!openSectionVisible())") < openBody.indexOf("getOpenSurface().render()") &&
          openBody.includes('staleSections.add("open")'),
        "E3-4r: collapsed Open records staleness before any live-window read"
      );
      check(
        db.includes("const primaryOpenReady = bootTimed(") &&
          db.includes("await primaryOpenReady.catch(() => {});"),
        "E3-4r: live/settings refresh work cannot jump ahead of the primary cold Open render"
      );
      check(
        /savedSnapshots[\s\S]*Promise\.all\(\[[\s\S]*readSessionIdentities\(\)[\s\S]*getSessionBindings\(\)/.test(openSurface) &&
          /startSavedLabelEnrichment[\s\S]*listItems\(STORE_KEYS\.inbox\)[\s\S]*listItems\(STORE_KEYS\.archive\)/.test(openSurface) &&
          openSurface.includes("scheduleBindingPrune();") &&
          store.includes("buildSessionIdentityIndex(") &&
          store.includes("committed[SESSION_IDENTITY_INDEX_KEY]") &&
          db.includes("dashboardStorageRefresh.request(dashboardTasksForStorage(changes") &&
          db.includes("openWarm: warmHiddenOpen"),
        "E3-4r/N45/N46: Open uses compact Session identities, defers saved-label enrichment, and maintains the index atomically"
      );
      const newTabPrefetch = newTabEntry.match(/const startOpenPrefetch = \(\) => \{([\s\S]*?)\n    \};/)?.[1] ?? "";
      const freshOpen = db.match(/function freshOpenSnapshot\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
      check(
        openSurface.includes("startSavedLabelEnrichment") &&
          openSurface.includes("invalidateSavedLabels") &&
          openSurface.includes("afterFirstPaint") &&
          openSurface.includes('pspan("open:saved-label-enrichment")') &&
          !newTabPrefetch.includes("STORE_KEYS.inbox") &&
          !newTabPrefetch.includes("STORE_KEYS.archive") &&
          !freshOpen.includes("STORE_KEYS.inbox") &&
          !freshOpen.includes("STORE_KEYS.archive") &&
          db.includes("getOpenSurface().invalidateSavedLabels()") &&
          sidePanel.includes("getOpenSurface().invalidateSavedLabels()"),
        "N45: mature-profile Open paints from live/session data before exact-invalidated saved-label enrichment"
      );
      check(
        /import \{[^}]*\bgetSessionBindings\b[^}]*\} from "\.\.\/lib\/sessions\.js";/.test(db) &&
          /function freshOpenSnapshot\(\)[\s\S]*getSessionBindings\(\)/.test(db),
        "E3-5 hotfix: the hidden-Open warmer imports every dependency it calls"
      );
      check(
        boot.includes('root.setAttribute("data-gradient", t.gradient ? "true" : "false")') &&
          tokens.includes('[data-gradient="true"] body'),
        "E3-4r: the cached gradient is applied by pre-paint boot, not after the dashboard module loads"
      );
      check(
        boot.includes("t.preparedTheme") &&
          theme.includes("cachePreparedTheme") &&
          theme.includes("preparedThemeFor("),
        "E3-4r2: on-open rotation caches the next scheme, mode, and background for first paint"
      );
      check(
        boot.includes("__everyTabBootThemeSelection") &&
          theme.includes("if (!globalThis.__everyTabBootThemeSelection) applyCached();"),
        "D3/E3: New Tab consumes pre-paint before its worker handshake can advance the shared cache"
      );
      check(
        newTabEntry.includes("__everyTabOpenPrefetch") &&
          boot.includes("__everyTabEarlyOpenWindows") &&
          boot.includes('preload.rel = "modulepreload"') &&
          !newTabEntry.includes('collapsed.has("open")') &&
        newTabEntry.includes('readStoreMap("sessionWindows")') &&
          newTabEntry.includes("readSessionIdentities()") &&
          newTabEntry.includes("__everyTabWarmOpen?.(snapshot)") &&
          db.includes("globalThis.__everyTabWarmOpen =") &&
          openSurface.includes("takeInitialSnapshot") &&
          db.includes("takeInitialSnapshot:"),
        "E3-4r3: New Tab prewarms Open before CSS/module evaluation, including while collapsed"
      );
      check(
        !db.includes('import { mountSettingsForm } from "./settings-form.js"') &&
          db.includes('import("./settings-form.js")') &&
          !db.includes('import { maybeShowOnboarding, openOnboardingPage } from "./onboarding.js"') &&
          db.includes('import("./onboarding.js")') &&
          /primaryPaintReady\.then\(\(\) =>\s*import\("\.\/onboarding\.js"\)/.test(db),
        "E3-4r3: Settings and onboarding leave the primary cold Open module path"
      );
    }
  
    /* — E3-0: perf instrumentation never ships enabled + stays a guarded no-op
       when inactive; the B6 spans measure BOTH first-anchor and refresh-settled
       (e3-performance-pass.md §9). — */
    {
      const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
      check(DEFAULT_SETTINGS.perfHud === false,
        "E3-0: perfHud defaults to false — instrumentation never ships enabled");
  
      const perf = await import("../js/lib/perf.js");
      check(perf.perfActive() === false,
        "E3-0: perf.js is inactive in a context with no ?perf=1 and no perfHud");
      const noopEnd = perf.pspan("smoke-test");
      check(typeof noopEnd === "function" && noopEnd() === undefined && perf.preport() === null,
        "E3-0: inactive perf calls are no-ops (pspan end callable, preport null)");
      perf.activateFromSettings({ perfHud: false });
      check(perf.perfActive() === false,
        "E3-0: activateFromSettings ignores a false perfHud");
      perf.activateFromSettings({ perfHud: true });
      const end = perf.pspan("store:commit");
      end("detail");
      perf.pcount("refresh tasks (total)", 3, 1.5);
      const blob = perf.preport();
      check(perf.perfActive() === true && typeof blob === "string" &&
          blob.includes("store:commit") && blob.includes("refresh tasks (total)"),
        "E3-0: active perf records spans + counters and reports a JSON blob");
  
      const db = fs.readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
      const labelsSurface = fs.readFileSync(new URL("../js/ui/labels-surface.js", import.meta.url), "utf8");
      check(labelsSurface.includes('pspan("goToLabel:first-anchor")') &&
          labelsSurface.includes('pspan("goToLabel:refresh-settled")') &&
          labelsSurface.includes('jumpAnchorMark?.("cold-quick-pass")'),
        "E3-0 (§9): goToLabel instruments BOTH first-anchor (incl. the cold quick pass) and refresh-settled");
      check(db.includes("const started = perfActive() ? performance.now() : 0;") &&
          db.includes('precord("refresh:flush"'),
        "E3-0: scheduled refresh instrumentation is gated on perfActive");
      const perfSrc = fs.readFileSync(new URL("../js/lib/perf.js", import.meta.url), "utf8");
      check(!perfSrc.includes("chrome.storage.local.set"),
        "E3-0: perf.js never writes storage (read-only activation)");
    }
  
    runSmokeBrandContracts(check);
    runSmokeStoragePolicy(check);
  
    {
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const root = fileURLToPath(new URL("../", import.meta.url));
      const dashboardSource = fs.readFileSync(path.join(root, "js/ui/dashboard.js"), "utf8");
      check(
        dashboardSource.includes("'.close-day-review'") &&
          dashboardSource.includes('currentPage === "close-day" && vertical'),
        "P11-15: Dashboard enters Close-the-day rows and leaves their complete arrow model to the review"
      );
    }
  
    chrome.storage.local = realLocal;
    chrome.storage.onChanged = realOnChanged;
  }
  
}
