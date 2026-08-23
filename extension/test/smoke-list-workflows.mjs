export async function runSmokeListWorkflows({ check, local, browserEffects }) {
  const mem = local;
  const { STORE_KEYS } = await import("../js/lib/types.js");
  const { listItems, newMeta, upsertItem } = await import("../js/lib/store.js");

  /* --- P2e-1: unified list — adapters, pure helpers, store-generic Archive exits --- */
  {
    const {
      fromArchiveItems, selectionSummary, visibleGroupActions, rowActionsFor,
      selectableFor, isImmutableGroup
    } = await import("../js/ui/tablist.js");
    const { restoreTabsFromItems, deleteTabsFromItems } = await import("../js/lib/actions.js");
    const { labelTabsFromItems } = await import("../js/lib/labels.js");
    const { listActions } = await import("../js/lib/journal.js");
  
    // isolate a fresh Archive store
    mem[STORE_KEYS.archive] = {};
    const winItem = { ...(await newMeta()), kind: "window", source: "dump", archivedAt: Date.now(),
      labels: ["research"], tabs: [
        { url: "https://a1.com", title: "A1" },
        { url: "https://a2.com", title: "A2" },
        { url: "https://a3.com", title: "A3" }] };
    const tabItem = { ...(await newMeta()), kind: "tab", source: "manual", archivedAt: Date.now(),
      labels: [], tabs: [{ url: "https://solo.com", title: "Solo" }] };
    await upsertItem(STORE_KEYS.archive, winItem);
    await upsertItem(STORE_KEYS.archive, tabItem);
  
    // adapter is a pure store-shape → normalized-groups map
    const groups = fromArchiveItems(await listItems(STORE_KEYS.archive));
    check(groups.length === 2, "P2e-1: fromArchiveItems → one group per item");
    const wg = groups.find((g) => g.kind === "window");
    check(wg && wg.refs.length === 3, "P2e-1: window group carries all refs");
    check(wg && wg.title === "Window · 3 tabs", "P2e-1: window group title");
    check(wg && JSON.stringify(wg.chips) === JSON.stringify(["research"]), "P2e-1: labels → chips");
    const tg = groups.find((g) => g.kind === "tab");
    check(tg && tg.title === "Single tab", "P2e-1 / item3: single-tab archive card headed 'Single tab'");
    check(tg && tg.data && tg.data.id === tg.id, "P2e-1: group.data is the source item");
  
    // shared bulk-count phrasing
    check(selectionSummary(0, 0) === "0 selected", "P2e-1: summary 0");
    check(selectionSummary(1, 1) === "1 tab selected", "P2e-1: summary 1 tab");
    check(selectionSummary(3, 2) === "3 tabs selected (across 2 items)", "P2e-1: summary across items");
  
    // immutability is structural, not per-button (list-ui.md criterion 3)
    check(isImmutableGroup({}, () => true) === true && isImmutableGroup({}, null) === false,
      "P2e-1: isImmutableGroup honors predicate / null");
    const gacts = [{ id: "restore", always: true }, { id: "delete", always: true }, { id: "rename" }];
    check(visibleGroupActions(gacts, true).length === 2, "P2e-1: immutable hides non-always group actions (rename)");
    check(visibleGroupActions(gacts, false).length === 3, "P2e-1: mutable shows all group actions");
    check(rowActionsFor([{ id: "x" }], true).length === 0, "P2e-1: immutable drops all row actions");
    check(selectableFor("tab", true) === "none" && selectableFor("tab", false) === "tab",
      "P2e-1: immutable forces selectable off");
  
    // the split-aware exits now run over the ARCHIVE store (what the unified list needs)
    browserEffects.clearTabs();
    const live0 = (await listItems(STORE_KEYS.archive)).find((i) => i.kind === "window");
    await restoreTabsFromItems([{ item: live0, indexes: [0] }], STORE_KEYS.archive);
    check(browserEffects.tabs.includes("https://a1.com"), "P2e-1: restore-from-archive opens the tab");
    const afterRestore = (await listItems(STORE_KEYS.archive)).find((i) => i.id === live0.id);
    check(afterRestore && afterRestore.tabs.length === 2, "P2e-1: restore splits the archive item (2 left)");
  
    await deleteTabsFromItems([{ item: afterRestore, indexes: [0] }], STORE_KEYS.archive);
    const afterDelete = (await listItems(STORE_KEYS.archive)).find((i) => i.id === live0.id);
    check(afterDelete && afterDelete.tabs.length === 1 && afterDelete.kind === "tab",
      "P2e-1: delete-from-archive splits + downgrades kind");
  
    const soloLive = (await listItems(STORE_KEYS.archive)).find((i) => i.tabs[0]?.url === "https://solo.com");
    await labelTabsFromItems([{ item: soloLive, indexes: [0] }], ["keep"], STORE_KEYS.archive);
    const soloAfter = (await listItems(STORE_KEYS.archive)).find((i) => i.id === soloLive.id);
    check(soloAfter && soloAfter.tabs[0].labels?.includes("keep"),
      "P2e-1/P2g-2: label-from-archive tags the tab in place at TAB grain (Archive store)");
  
    const head = (await listActions())[0];
    check(head && (head.puts ?? []).every((p) => p.store === STORE_KEYS.archive),
      "P2e-1: archive exits journal puts against STORE_KEYS.archive (Undo target)");
  }
  
  /* --- P2e-2: sessions/snapshots + snoozed adapters; immutable enforcement --- */
  {
    const { fromSessions, fromSnoozes, visibleGroupActions, isImmutableGroup, rowActionsFor } =
      await import("../js/ui/tablist.js");
  
    // fromSessions → one group per session, body split into per-window sub-blocks
    const namedS = { id: "s1", name: "Trip", auto: false, modifiedAt: Date.now(),
      windows: [[{ url: "https://w0a.com", title: "W0a" }, { url: "https://w0b.com", title: "W0b" }],
                [{ url: "https://w1.com", title: "W1" }]] };
    const snapS = { id: "s2", name: "Snapshot", auto: true, modifiedAt: Date.now(),
      windows: [[{ url: "https://x.com", title: "X" }]] };
    const sgroups = fromSessions([namedS, snapS]);
    check(sgroups[0].windows.length === 2 && sgroups[0].windows[0].refs.length === 2,
      "P2e-2: fromSessions splits windows into sub-blocks");
    check(sgroups[0].kind === "session" && sgroups[1].kind === "snapshot",
      "P2e-2: kind reflects auto (session vs snapshot)");
    check(sgroups[0].refs === undefined, "P2e-2: multi-window group carries no flat refs");
  
    // criterion 3: snapshots are immutable — Rename dropped structurally, not per-button
    const immutable = (g) => !!g.data.auto;
    const gActs = [{ id: "restore-all", always: true }, { id: "rename" },
                   { id: "delete", danger: true, always: true }];
    const namedImm = isImmutableGroup(sgroups[0], immutable);
    const snapImm = isImmutableGroup(sgroups[1], immutable);
    check(namedImm === false && snapImm === true, "P2e-2: immutable predicate true only for snapshots");
    check(visibleGroupActions(gActs, snapImm).map((a) => a.id).join(",") === "restore-all,delete",
      "P2e-2: snapshot drops Rename, keeps Restore all + Delete (criterion 3)");
    check(visibleGroupActions(gActs, namedImm).length === 3, "P2e-2: named session keeps all group actions");
    check(rowActionsFor([{ id: "restore-tab", always: true }, { id: "del", danger: true }], snapImm)
      .map((a) => a.id).join(",") === "restore-tab",
      "P2e-2: snapshot keeps read row actions, drops mutating ones");
  
    // fromSnoozes → bundle vs single-tab; recurrence chip
    const winSnooze = { id: "z1", title: "Window (2 tabs)", url: "", dueAt: Date.now() + 1e6,
      tabs: [{ url: "https://a.com", title: "A" }, { url: "https://b.com", title: "B" }], recurrence: "weekly" };
    const oneSnooze = { id: "z2", title: "One", url: "https://one.com", dueAt: Date.now() + 2e6 };
    const zgroups = fromSnoozes([winSnooze, oneSnooze]);
    check(zgroups[0].refs.length === 2, "P2e-2: window snooze → bundle GroupCard rows (details hack gone)");
    check(JSON.stringify(zgroups[0].chips) === JSON.stringify(["Weekly"]), "P2e-2: recurrence → chip");
    check(zgroups[1].refs.length === 1 && zgroups[1].refs[0].url === "https://one.com",
      "P2e-2: legacy single snooze → one-row group");
    check((zgroups[1].chips ?? []).length === 0, "P2e-2: non-recurring snooze has no chip");
  }
  
  /* --- P2e-3: inbox adapter (U2 triage config ports onto the shared component) --- */
  {
    const { fromInboxItems } = await import("../js/ui/tablist.js");
    const win = { id: "i1", kind: "window", source: "dump", createdAt: Date.now(),
      labels: ["read"], tabs: [{ url: "https://p1.com", title: "P1" }, { url: "https://p2.com", title: "P2" }] };
    const one = { id: "i2", kind: "tab", source: "manual", createdAt: Date.now(),
      labels: [], tabs: [{ url: "https://solo.com", title: "Solo" }] };
    const g = fromInboxItems([win, one]);
    check(g[0].kind === "window" && g[0].title === "Window · 2 tabs" && g[0].refs.length === 2,
      "P2e-3: inbox window bundle → GroupCard carrying all tab rows");
    check(JSON.stringify(g[0].chips) === JSON.stringify(["read"]), "P2e-3: inbox labels → chips");
    check(g[1].kind === "tab" && g[1].title === "Single tab",
      "P2e-3 / item3: a single-tab card is headed 'Single tab', not the repeated tab title");
    check(g[1].data === one, "P2e-3: group.data is the source inbox item (row/card actions close over it)");
  }
  
  /* --- P2e-4: open-tabs adapter (live handles, canonical display, selectability) --- */
  {
    const { fromOpenWindows } = await import("../js/ui/tablist.js");
    const suspendUrl = chrome.runtime.getURL("suspend.html") +
      "?originalUrl=" + encodeURIComponent("https://real.com") + "&title=" + encodeURIComponent("Real page");
    const win = { id: 7, focused: true, tabs: [
      { id: 101, index: 0, url: "https://a.com", title: "A", pinned: true, audible: false },
      { id: 102, index: 1, url: "chrome://settings", title: "Settings" },
      { id: 103, index: 2, url: suspendUrl, title: "suspended", pinned: false }
    ] };
    const [g] = fromOpenWindows([win]);
    check(g.id === "7" && g.kind === "openwindow", "P2e-4: one group per open window");
    check(g.refs.length === 3 && g.live.length === 3, "P2e-4: refs + live handle per tab");
    check(g.live[0].tabId === 101 && g.live[0].pinned === true && g.live[0].selectable === true,
      "P2e-4: http tab is selectable; tabId + pinned carried");
    check(g.live[1].selectable === false, "P2e-4: chrome:// tab is non-selectable (disabled checkbox)");
    check(g.refs[2].url === "https://real.com" && g.live[2].suspended === true,
      "P2e-4: suspended tab displays its underlying page and is flagged suspended");
    check(g.live[0].chromeIndex === 0 && g.live[2].chromeIndex === 2,
      "P2e-4: chrome index carried per tab (drag/move target)");
  
    /* --- N9 (P2f): suspended tabs are selectable in Open tabs --- */
    check(g.live[2].selectable === true,
      "N9: suspended tab is selectable (canonical ref carries the underlying page)");
  
    /* --- P2g-2r: open rows surface labels of a labeled SAVED copy (read-only) --- */
    const saved = { "https://a.com": ["work", "reading"] };
    const [g2] = fromOpenWindows([win], (url) => saved[url]);
    check(JSON.stringify(g2.refs[0].labels) === JSON.stringify(["work", "reading"]),
      "P2g-2r: an open tab with a labeled saved copy carries those labels on its ref");
    check(!("labels" in g2.refs[1]), "P2g-2r: unlabeled open tabs gain no labels field");
    check(g2.refs[2].url === "https://real.com" && !g2.refs[2].labels,
      "P2g-2r: the lookup runs on the CANONICAL url (suspended tab unchanged here)");
  }
  
  /* --- N10 (P2f) + W1: InboxSource display mapping — the stored enums map to the
     settled "save" wording (display only; the stored `dump`/`auto-archive` values
     never change). --- */
  {
    const { SOURCE_LABELS, sourceLabel, fromInboxItems, fromArchiveItems } =
      await import("../js/ui/tablist.js");
    check(SOURCE_LABELS["auto-archive"] === "auto-saved" && SOURCE_LABELS["dump"] === "saved",
      "W1: SOURCE_LABELS maps the stored enum to save wording (display only)");
    check(sourceLabel("something-new") === "something-new",
      "N10: unknown source passes through sourceLabel unchanged");
    const swept = { id: "n1", kind: "window", source: "auto-archive", createdAt: Date.now(),
      labels: [], tabs: [{ url: "https://x.com", title: "X" }, { url: "https://y.com", title: "Y" }] };
    const [ig] = fromInboxItems([swept]);
    check(ig.meta.startsWith("auto-saved · ") && !ig.meta.includes("archive"),
      "W1: inbox meta renders 'auto-saved', never the raw 'auto-archive' enum");
    const filed = { id: "n2", kind: "tab", source: "dump", archivedAt: Date.now(),
      labels: ["read"], tabs: [{ url: "https://z.com", title: "Z" }] };
    const [ag] = fromArchiveItems([filed]);
    check(ag.meta.startsWith("saved · archived "),
      "W1: archive meta renders the mapped source ('archived' here is the real Archive — correct)");
  }
  
  /* --- P2g-3 (U6): session tab-grain ops — remove / merge / label / restore --- */
  {
    const { removeSessionTabs, moveSessionTabs, restoreSessionTabs, createSessionFromWindows } =
      await import("../js/lib/sessions.js");
    const { labelSessionTabs } = await import("../js/lib/labels.js");
    const { undoAction, clearJournal } = await import("../js/lib/journal.js");
    await clearJournal();
    const bySid = async (id) => (await listItems(STORE_KEYS.sessions)).find((s) => s.id === id);
    const mkSession = (name, wins) =>
      createSessionFromWindows(wins.map((w) => w.map((u) => ({ url: u, title: u }))), name);
  
    // removeSessionTabs: picked tabs leave; an emptied window collapses
    const sA = await mkSession("Src A", [["https://a1.com", "https://a2.com", "https://a3.com"], ["https://b1.com"]]);
    await removeSessionTabs(sA, [{ windowIndex: 0, indexes: [1] }, { windowIndex: 1, indexes: [0] }]);
    const aNow = await bySid(sA.id);
    check(aNow.windows.length === 1 && aNow.windows[0].map((t) => t.url).join() === "https://a1.com,https://a3.com",
      "P2g-3: removeSessionTabs drops picked tabs; an emptied window collapses");
  
    // a fully-emptied session tombstones (rule 8)
    const sB = await mkSession("Src B", [["https://only.com"]]);
    const rem = await removeSessionTabs(sB, [{ windowIndex: 0, indexes: [0] }]);
    check(rem === null && !(await bySid(sB.id)), "P2g-3: a fully-emptied session tombstones");
  
    // merge → NEW target: moved tabs arrive as their own window, source splits
    await clearJournal();
    const sC = await mkSession("Src C", [["https://c1.com", "https://c2.com"]]);
    const res = await moveSessionTabs([{ session: sC, picks: [{ windowIndex: 0, indexes: [0] }] }], "__new", "Target T");
    const target = (await listItems(STORE_KEYS.sessions)).find((s) => s.name === "Target T");
    const cNow = await bySid(sC.id);
    check(res?.moved === 1 && target?.windows.length === 1 && target.windows[0][0].url === "https://c1.com",
      "P2g-3: merge to a new session carries the picked tabs as a window");
    check(cNow.windows[0].length === 1 && cNow.windows[0][0].url === "https://c2.com",
      "P2g-3: merge splits the picked tabs out of the source");
    await undoAction(res.entry.id);
    check(!(await bySid(target.id)) && (await bySid(sC.id)).windows[0].length === 2,
      "P2g-3: one undo removes the new target AND restores the source membership");
  
    // merge that empties the source tombstones it; one undo restores both sides
    const sD = await mkSession("Src D", [["https://d1.com"]]);
    const sE = await mkSession("Target E", [["https://e1.com"]]);
    const res2 = await moveSessionTabs([{ session: sD, picks: [{ windowIndex: 0, indexes: [0] }] }], sE.id);
    check(!(await bySid(sD.id)) && (await bySid(sE.id)).windows.length === 2,
      "P2g-3: a merge that empties the source tombstones it, target gains the window");
    await undoAction(res2.entry.id);
    check((await bySid(sD.id))?.windows[0][0].url === "https://d1.com" && (await bySid(sE.id)).windows.length === 1,
      "P2g-3: undo revives the emptied source and restores the target");
  
    // a session can't merge into itself; snapshots are never a target (N8)
    const eFresh = await bySid(sE.id);
    check((await moveSessionTabs([{ session: eFresh, picks: [{ windowIndex: 0, indexes: [0] }] }], sE.id)) === null,
      "P2g-3: self-target picks are skipped (merge into itself = no-op)");
    const snapT = { ...(await newMeta()), name: "Snap T", auto: true,
      windows: [[{ url: "https://snap.com", title: "S" }]], labels: [] };
    await upsertItem(STORE_KEYS.sessions, snapT);
    check((await moveSessionTabs([{ session: await bySid(sE.id), picks: [{ windowIndex: 0, indexes: [0] }] }], snapT.id)) === null &&
      (await bySid(sE.id)).windows.length === 1,
      "P2g-3/N8: a snapshot target is refused and nothing moves");
  
    // labelSessionTabs with an ARRAY of picks labels exactly those tabs
    const sF = await mkSession("Lbl F", [["https://f1.com", "https://f2.com"], ["https://f3.com"]]);
    await labelSessionTabs(sF, "picked", [{ wi: 0, i: 1 }, { wi: 1, i: 0 }]);
    const fNow = await bySid(sF.id);
    check(!fNow.windows[0][0].labels && fNow.windows[0][1].labels?.includes("picked") &&
      fNow.windows[1][0].labels?.includes("picked"),
      "P2g-3: bulk label (array picks) labels exactly the selected tabs");
  
    // restoreSessionTabs: window slice > 1 → ONE new window; lone pick → tab; session unmutated
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    const sG = await mkSession("Res G", [["https://g1.com", "https://g2.com", "https://g3.com"], ["https://h1.com"]]);
    const opened = await restoreSessionTabs(sG, [{ windowIndex: 0, indexes: [0, 2] }, { windowIndex: 1, indexes: [0] }]);
    const gNow = await bySid(sG.id);
    check(opened === 3 && browserEffects.windows.length === 1 &&
      browserEffects.windows[0].tabs.map((t) => t.url).join() === "https://g1.com,https://g3.com" &&
      browserEffects.tabs.includes("https://h1.com"),
      "P2g-3: bulk restore opens one window per source window slice, lone picks as tabs");
    check(gNow.windows.length === 2 && gNow.windows[0].length === 3,
      "P2g-3: restore never mutates the session (sessions are templates)");
  }
  
  /* --- P2g-3 (U7): snooze tab-grain ops — wake / cancel with subset split --- */
  {
    const { createSnooze, wakeSnoozeTabs, cancelSnoozeTabs, snoozeRefs, SNOOZE_ALARM_PREFIX } =
      await import("../js/lib/snooze.js");
    const { undoAction, clearJournal } = await import("../js/lib/journal.js");
    await clearJournal();
    const bySnid = async (id) => (await listItems(STORE_KEYS.snoozes)).find((s) => s.id === id);
    const due = Date.now() + 86_400_000;
  
    // subset wake: picked tabs open as one window, the snooze splits, alarm survives
    mem.settings = { snoozeWakeQuiet: false };
    const bundle = await createSnooze({ title: "Window (3 tabs)", dueAt: due,
      tabs: [{ url: "https://w1.com", title: "W1" }, { url: "https://w2.com", title: "W2" },
        { url: "https://w3.com", title: "W3" }] });
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    await wakeSnoozeTabs([{ snooze: bundle, indexes: [0, 2] }]);
    const bNow = await bySnid(bundle.id);
    check(browserEffects.windows.length === 1 && browserEffects.windows[0].tabs.map((t) => t.url).join() === "https://w1.com,https://w3.com",
      "P2g-3/U7: subset wake opens the picked tabs as one window");
    check(bNow?.tabs.length === 1 && bNow.tabs[0].url === "https://w2.com" && bNow.title === "W2" &&
      !!browserEffects.alarms[SNOOZE_ALARM_PREFIX + bundle.id],
      "P2g-3/U7: the remainder keeps its due time and alarm; title re-derives");
    await undoAction();
    check((await bySnid(bundle.id)).tabs.length === 3, "P2g-3/U7: undo restores the pre-split snooze");
  
    // full wake ends the snooze — alarm cleared, tombstoned
    const full = await bySnid(bundle.id);
    await wakeSnoozeTabs([{ snooze: full, indexes: [0, 1, 2] }]);
    check(!(await bySnid(bundle.id)) && !browserEffects.alarms[SNOOZE_ALARM_PREFIX + bundle.id],
      "P2g-3/U7: waking every tab ends the snooze and clears its alarm");
  
    // A stored legacy quiet preference cannot redirect a manual wake to Inbox.
    mem.settings = { snoozeWakeQuiet: true };
    delete mem[STORE_KEYS.inbox];
    browserEffects.clearWindows();
    await clearJournal();
    const quiet = await createSnooze({ title: "Window (2 tabs)", dueAt: due,
      tabs: [{ url: "https://q1.com", title: "Q1" }, { url: "https://q2.com", title: "Q2" }] });
    await wakeSnoozeTabs([{ snooze: quiet, indexes: [0, 1] }]);
    const inboxNow = await listItems(STORE_KEYS.inbox);
    check(browserEffects.windows.length === 1 && browserEffects.windows[0].tabs.length === 2 && inboxNow.length === 0,
      "P2g-3/U7: retired quiet preference cannot redirect a manual wake to Inbox");
    await undoAction();
    check((await listItems(STORE_KEYS.inbox)).length === 0 && (await bySnid(quiet.id))?.tabs.length === 2,
      "P2g-3/U7: undo restores a wake without creating an Inbox delivery");
    mem.settings = { snoozeWakeQuiet: false };
  
    // subset cancel splits without opening anything; full cancel ends it; undo works
    await clearJournal();
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    const canc = await createSnooze({ title: "Window (2 tabs)", dueAt: due,
      tabs: [{ url: "https://x1.com", title: "X1" }, { url: "https://x2.com", title: "X2" }] });
    await cancelSnoozeTabs([{ snooze: canc, indexes: [1] }]);
    check(browserEffects.windows.length === 0 && browserEffects.tabs.length === 0 &&
      (await bySnid(canc.id)).tabs.length === 1,
      "P2g-3/U7: subset cancel splits the snooze and opens nothing");
    await cancelSnoozeTabs([{ snooze: await bySnid(canc.id), indexes: [0] }]);
    check(!(await bySnid(canc.id)) && !browserEffects.alarms[SNOOZE_ALARM_PREFIX + canc.id],
      "P2g-3/U7: cancelling the last tab tombstones the snooze and clears its alarm");
    await undoAction(); // last entry: the full cancel
    check((await bySnid(canc.id))?.tabs.length === 1, "P2g-3/U7: undo revives the cancelled snooze");
  
    // legacy single-tab snooze: snoozeRefs presents its one ref; cancel ends it
    const single = await createSnooze({ url: "https://solo.com", title: "Solo", dueAt: due });
    check(snoozeRefs(single).length === 1 && snoozeRefs(single)[0].url === "https://solo.com",
      "P2g-3/U7: snoozeRefs presents a legacy single snooze as one ref");
    await cancelSnoozeTabs([{ snooze: single, indexes: [0] }]);
    check(!(await bySnid(single.id)), "P2g-3/U7: cancelling a single snooze's tab ends it");
  }
  
  /* --- P2g-5: remove-from-session × + snooze-a-session (scheduled Restore-all) --- */
  {
    const { removeSessionTab, createSessionFromWindows } = await import("../js/lib/sessions.js");
    const { snoozeSession, cancelSnoozeJournaled, fireSnooze, SNOOZE_ALARM_PREFIX } =
      await import("../js/lib/snooze.js");
    const { tombstoneItem } = await import("../js/lib/store.js");
    const { fromSnoozes } = await import("../js/ui/tablist.js");
    const { undoAction, clearJournal } = await import("../js/lib/journal.js");
    await clearJournal();
    const bySid = async (id) => (await listItems(STORE_KEYS.sessions)).find((s) => s.id === id);
    const bySnid = async (id) => (await listItems(STORE_KEYS.snoozes)).find((s) => s.id === id);
    const mkSession = (name, wins) =>
      createSessionFromWindows(wins.map((w) => w.map((u) => ({ url: u, title: u }))), name);
    mem.settings = { snoozeWakeQuiet: false };
  
    // removeSessionTab: one tab out, journaled; undo restores exactly
    const sR = await mkSession("Rm", [["https://r1.com", "https://r2.com"], ["https://r3.com"]]);
    await removeSessionTab(sR, 0, 1);
    let rNow = await bySid(sR.id);
    check(rNow.windows[0].length === 1 && rNow.windows[0][0].url === "https://r1.com" && rNow.windows.length === 2,
      "P2g-5: removeSessionTab drops exactly the one tab");
    await undoAction();
    rNow = await bySid(sR.id);
    check(rNow.windows[0].length === 2, "P2g-5: undo restores the removed tab");
  
    // removing the last tab of the last window tombstones the session (rule 8)
    const sR2 = await mkSession("Rm2", [["https://only.com"]]);
    await removeSessionTab(sR2, 0, 0);
    check(!(await bySid(sR2.id)), "P2g-5: removing the last tab tombstones the session");
    await undoAction();
    check((await bySid(sR2.id))?.windows[0][0].url === "https://only.com",
      "P2g-5: undo revives the emptied session");
  
    // snoozeSession: entry references the session, alarm set, session untouched
    await clearJournal();
    const sS = await mkSession("Trip", [["https://t1.com", "https://t2.com"], ["https://t3.com"]]);
    const due = Date.now() + 3_600_000;
    const sn = await snoozeSession(sS, due);
    check(sn?.sessionId === sS.id && sn.url === "" && sn.title === "Trip" &&
      !!browserEffects.alarms[SNOOZE_ALARM_PREFIX + sn.id],
      "P2g-5: snoozeSession creates a session-referencing snooze with an alarm");
    check((await bySid(sS.id)).windows.length === 2,
      "P2g-5: snoozing never mutates the session (it is a template)");
    const snapS = { ...(await newMeta()), name: "SnapS", auto: true,
      windows: [[{ url: "https://s.com", title: "S" }]], labels: [] };
    await upsertItem(STORE_KEYS.sessions, snapS);
    check((await snoozeSession(snapS, due)) === null, "P2g-5: a snapshot refuses to be snoozed");
  
    // fromSnoozes renders it as a live bundle named after the session
    const sessionsById = new Map([[sS.id, await bySid(sS.id)]]);
    const [sg] = fromSnoozes([sn], sessionsById);
    check(sg.kind === "session-snooze" && sg.title === "Session · Trip" && sg.refs.length === 3 &&
      sg.meta.startsWith("restores "),
      "P2g-5: a session snooze renders as a bundle with the session's LIVE tabs");
    const [sgGone] = fromSnoozes([sn], new Map());
    check(sgGone.refs.length === 0 && sgGone.meta.includes("session deleted"),
      "P2g-5: a deleted session leaves an empty, labeled snooze card");
  
    // undo of snoozeSession removes the snooze
    await undoAction();
    check(!(await bySnid(sn.id)), "P2g-5: undo of snoozeSession removes the snooze");
  
    // fire: one window opens per session window; session survives; snooze ends
    const sn2 = await snoozeSession(await bySid(sS.id), due);
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    await fireSnooze(sn2.id);
    check(browserEffects.windows.length === 2 &&
      browserEffects.windows[0].tabs.map((t) => t.url).join() === "https://t1.com,https://t2.com" &&
      browserEffects.windows[1].tabs[0].url === "https://t3.com",
      "P2g-5: firing a session snooze restores every window of the session");
    check((await bySid(sS.id)).windows.length === 2 && !(await bySnid(sn2.id)),
      "P2g-5: after firing, the session remains and the one-shot snooze is gone");
  
    // recurring session snooze reschedules instead of ending
    const sn3 = await snoozeSession(await bySid(sS.id), Date.now() - 1000, "daily");
    browserEffects.clearWindows();
    await fireSnooze(sn3.id);
    const sn3Now = await bySnid(sn3.id);
    check(browserEffects.windows.length === 2 && sn3Now && sn3Now.dueAt > Date.now(),
      "P2g-5: a recurring session snooze fires and reschedules (session kept)");
    await cancelSnoozeJournaled(sn3Now);
    check(!(await bySnid(sn3.id)) && !browserEffects.alarms[SNOOZE_ALARM_PREFIX + sn3.id],
      "P2g-5: cancelSnoozeJournaled ends the snooze and clears the alarm");
    await undoAction();
    check((await bySnid(sn3.id))?.sessionId === sS.id,
      "P2g-5: undo revives the cancelled session snooze");
    await cancelSnoozeJournaled(await bySnid(sn3.id)); // clean up for later blocks
  
    // A stored legacy quiet preference cannot redirect a Session wake to Inbox.
    mem.settings = { snoozeWakeQuiet: true };
    delete mem[STORE_KEYS.inbox];
    browserEffects.clearWindows();
    const sn4 = await snoozeSession(await bySid(sS.id), due);
    await fireSnooze(sn4.id);
    const inboxNow = await listItems(STORE_KEYS.inbox);
    check(browserEffects.windows.length === 2 && inboxNow.length === 0 &&
      (await bySid(sS.id)).windows.length === 2,
      "P2g-5: retired quiet preference reopens every Session window and keeps the Session");
    mem.settings = { snoozeWakeQuiet: false };
  
    // session deleted before the due time: fires as a clean no-op
    const sGone = await mkSession("Gone", [["https://gone.com"]]);
    const sn5 = await snoozeSession(sGone, due);
    await tombstoneItem(STORE_KEYS.sessions, sGone.id);
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    await fireSnooze(sn5.id);
    check(browserEffects.windows.length === 0 && browserEffects.tabs.length === 0 && !(await bySnid(sn5.id)),
      "P2g-5: a session snooze whose session was deleted fires as a no-op and ends");
  }
  
  /* --- P2g-4a: journal `moves` op — best-effort undo for live Open-tabs drags --- */
  {
    const { recordAction, undoAction, clearJournal } = await import("../js/lib/journal.js");
    await clearJournal();
    const movedCalls = [];
    chrome.tabs.move = async (tabId, { windowId, index }) => {
      if (tabId === 404) throw new Error("no such tab");
      movedCalls.push({ tabId, windowId, index });
    };
    const e1 = await recordAction("Moved “X” to a new window (undo is best-effort)",
      { moves: [{ tabId: 7, windowId: 100, index: 2 }] });
    check(!!e1, "P2g-4a: a moves-only entry records (no puts/dels needed)");
    await undoAction();
    check(movedCalls.length === 1 && movedCalls[0].tabId === 7 &&
      movedCalls[0].windowId === 100 && movedCalls[0].index === 2,
      "P2g-4a: undo re-moves the tab to its pre-drag window/index");
    await recordAction("Moved “gone” (undo is best-effort)",
      { moves: [{ tabId: 404, windowId: 1, index: 0 }] });
    const e2 = await undoAction();
    check(e2?.undone === true && movedCalls.length === 1,
      "P2g-4a: undoing a move of a since-closed tab is a silent no-op (best effort)");
  }
  
  /* --- P2g-4b: moveInboxTab — inbox drag with stale guard + exact undo --- */
  {
    const { moveInboxTab } = await import("../js/lib/actions.js");
    const { undoAction, clearJournal, listActions } = await import("../js/lib/journal.js");
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    const byId = async (id) => (await listItems(STORE_KEYS.inbox)).find((i) => i.id === id);
    const mk = async (urls, labels = []) => {
      const it = { ...(await newMeta()), kind: urls.length > 1 ? "window" : "tab",
        tabs: urls.map((u, i) => ({ url: u, title: u, ...(labels[i] ? { labels: labels[i] } : {}) })),
        source: "dump", labels: [] };
      await upsertItem(STORE_KEYS.inbox, it);
      return byId(it.id); // re-read: upsert stamps modifiedAt (the guard's input)
    };
  
    // cross-bundle move: ref (with its labels) inserted at position, kinds adjust
    const A = await mk(["https://a1.com", "https://a2.com"], [["keep"]]);
    const B = await mk(["https://b1.com"]);
    const r1 = await moveInboxTab(A.id, 0, B.id, 0, { source: A.modifiedAt, target: B.modifiedAt });
    let aNow = await byId(A.id), bNow = await byId(B.id);
    check(r1.ok && bNow.tabs.map((t) => t.url).join() === "https://a1.com,https://b1.com" &&
      bNow.kind === "window" && bNow.tabs[0].labels?.includes("keep"),
      "P2g-4b: cross-bundle move inserts at position, labels ride the ref");
    check(aNow.tabs.length === 1 && aNow.kind === "tab",
      "P2g-4b: the source bundle splits and its kind downgrades");
    await undoAction();
    aNow = await byId(A.id); bNow = await byId(B.id);
    check(aNow.tabs.length === 2 && bNow.tabs.length === 1,
      "P2g-4b: ONE undo restores BOTH bundles exactly");
  
    // emptied source tombstones; undo revives it and restores the target
    const C = await mk(["https://c1.com"]);
    const bFresh = await byId(B.id);
    const r2 = await moveInboxTab(C.id, 0, B.id, -1, { source: C.modifiedAt, target: bFresh.modifiedAt });
    check(r2.ok && !(await byId(C.id)) && (await byId(B.id)).tabs.length === 2,
      "P2g-4b: a move that empties the source tombstones it (append via header)");
    await undoAction();
    check((await byId(C.id))?.tabs.length === 1 && (await byId(B.id)).tabs.length === 1,
      "P2g-4b: undo revives the emptied source and restores the target");
  
    // between-bundles zone: a NEW ordinary bundle; undo removes it
    const aFresh = await byId(A.id);
    const r3 = await moveInboxTab(A.id, 0, null, -1, { source: aFresh.modifiedAt });
    const fresh = (await listItems(STORE_KEYS.inbox)).find((i) =>
      i.tabs.length === 1 && i.tabs[0].url === "https://a1.com" && i.id !== A.id);
    check(r3.ok && fresh?.source === "manual" && fresh.kind === "tab",
      "P2g-4b: the new-bundle zone creates an ordinary manual item");
    await undoAction();
    check(!(await byId(fresh.id)) && (await byId(A.id)).tabs.length === 2,
      "P2g-4b: undo removes the created bundle and restores the source");
  
    // stale guard: a bumped modifiedAt (sweep/sync/another window) aborts cleanly
    const a2 = await byId(A.id);
    const b2 = await byId(B.id);
    // bump the target's modifiedAt EXPLICITLY (upsertItem stamps Date.now(),
    // which can be the same millisecond in a fast test run)
    mem[STORE_KEYS.inbox][b2.id] = { ...mem[STORE_KEYS.inbox][b2.id], modifiedAt: b2.modifiedAt + 5 };
    const before = await listActions();
    const r4 = await moveInboxTab(A.id, 0, B.id, 0, { source: a2.modifiedAt, target: b2.modifiedAt });
    check(r4.ok === false && r4.stale === true &&
      (await byId(A.id)).tabs.length === 2 && (await listActions()).length === before.length,
      "P2g-4b: the stale-drop guard aborts — nothing written, nothing journaled");
    const r5 = await moveInboxTab("no-such-id", 0, null, -1, { source: 0 });
    check(r5.ok === false && r5.stale === true,
      "P2g-4b: a vanished source aborts the same way");
  
    // same-item reorder + the dropped-where-it-was no-op
    const D = await mk(["https://d1.com", "https://d2.com", "https://d3.com"]);
    const r6 = await moveInboxTab(D.id, 0, D.id, 2, { source: D.modifiedAt, target: D.modifiedAt });
    check(r6.ok && (await byId(D.id)).tabs.map((t) => t.url).join() ===
      "https://d2.com,https://d1.com,https://d3.com",
      "P2g-4b: same-bundle drop reorders (insert-before semantics)");
    const d2 = await byId(D.id);
    const cnt = (await listActions()).length;
    const r7 = await moveInboxTab(D.id, 1, D.id, 1, { source: d2.modifiedAt, target: d2.modifiedAt });
    check(r7.ok && r7.noop === true && (await listActions()).length === cnt,
      "P2g-4b: dropping a row where it already sits is a journal-free no-op");
  }
  
  /* --- P2g-4c: moveSessionTab — in-session drag with stale guard + one-undo --- */
  {
    const { moveSessionTab, createSessionFromWindows } = await import("../js/lib/sessions.js");
    const { undoAction, clearJournal, listActions } = await import("../js/lib/journal.js");
    await clearJournal();
    const bySid = async (id) => (await listItems(STORE_KEYS.sessions)).find((s) => s.id === id);
    const urlsOf = (s) => s.windows.map((w) => w.map((t) => t.url).join()).join("|");
    const S0 = await createSessionFromWindows(
      [["https://u1.com", "https://u2.com", "https://u3.com"].map((u) => ({ url: u, title: u })),
        [{ url: "https://v1.com", title: "https://v1.com" }]], "Drag");
    let s = await bySid(S0.id);
  
    // cross-window: insert before the hovered row
    const r1 = await moveSessionTab(s.id, 0, 0, { wi: 1, index: 0 }, s.modifiedAt);
    s = await bySid(s.id);
    check(r1.ok && urlsOf(s) === "https://u2.com,https://u3.com|https://u1.com,https://v1.com",
      "P2g-4c: cross-window drop inserts before the hovered row");
    await undoAction();
    s = await bySid(s.id);
    check(urlsOf(s) === "https://u1.com,https://u2.com,https://u3.com|https://v1.com",
      "P2g-4c: one undo restores the exact pre-drag session");
  
    // same-window reorder + drop-in-place no-op
    const r2 = await moveSessionTab(s.id, 0, 0, { wi: 0, index: 2 }, s.modifiedAt);
    s = await bySid(s.id);
    check(r2.ok && s.windows[0].map((t) => t.url).join() === "https://u2.com,https://u1.com,https://u3.com",
      "P2g-4c: same-window drop reorders (insert-before semantics)");
    const cnt = (await listActions()).length;
    const r3 = await moveSessionTab(s.id, 0, 1, { wi: 0, index: 1 }, s.modifiedAt);
    check(r3.ok && r3.noop === true && (await listActions()).length === cnt,
      "P2g-4c: dropping a row where it already sits is a journal-free no-op");
  
    // window-header append; the emptied source block collapses
    const r4 = await moveSessionTab(s.id, 1, 0, { wi: 0, index: -1 }, s.modifiedAt);
    s = await bySid(s.id);
    check(r4.ok && s.windows.length === 1 && s.windows[0].length === 4 &&
      s.windows[0][3].url === "https://v1.com",
      "P2g-4c: header drop appends; the emptied source window collapses");
  
    // between-blocks zone: a new window block at that position
    const r5 = await moveSessionTab(s.id, 0, 0, { newAt: 1 }, s.modifiedAt);
    s = await bySid(s.id);
    check(r5.ok && s.windows.length === 2 && s.windows[1].length === 1 &&
      s.windows[1][0].url === "https://u2.com",
      "P2g-4c: the between-blocks zone creates a new window block in place");
    await undoAction();
    s = await bySid(s.id);
    check(s.windows.length === 1, "P2g-4c: undo collapses the created block back");
  
    // stale guard + snapshot refusal
    const before = (await listActions()).length;
    const r6 = await moveSessionTab(s.id, 0, 0, { wi: 0, index: 2 }, s.modifiedAt + 5);
    check(r6.ok === false && r6.stale === true && (await listActions()).length === before &&
      urlsOf(await bySid(s.id)) === urlsOf(s),
      "P2g-4c: the stale-drop guard aborts — nothing written, nothing journaled");
    const snapD = { ...(await newMeta()), name: "SnapD", auto: true,
      windows: [[{ url: "https://sd.com", title: "SD" }]], labels: [] };
    await upsertItem(STORE_KEYS.sessions, snapD);
    const snapNow = await bySid(snapD.id);
    check((await moveSessionTab(snapD.id, 0, 0, { newAt: 1 }, snapNow.modifiedAt)).ok === false,
      "P2g-4c/N8: a snapshot refuses drag moves");
  }
  
}
