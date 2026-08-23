export async function runSmokeSavedDataWorkflows({ check, local, browserEffects }) {
  const mem = local;
  const { STORE_KEYS } = await import("../js/lib/types.js");
  const { listItems, newMeta, upsertItem } = await import("../js/lib/store.js");
  const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");

  /* --- M6: labels (collections merged away) --- */
  const { collectLabels, labelAndArchive, addLabel, removeLabel, migrateCollectionsToLabels } =
    await import("../js/lib/labels.js");
  
  delete mem[STORE_KEYS.inbox];
  delete mem[STORE_KEYS.archive];
  delete mem[STORE_KEYS.collections];
  
  // migration: collection → labeled archive bundle
  await upsertItem(STORE_KEYS.collections, {
    ...(await newMeta()),
    name: "Research",
    tabs: [{ url: "https://p1.com", title: "P1" }, { url: "https://p2.com", title: "P2" }],
    labels: ["old"]
  });
  check((await migrateCollectionsToLabels()) === 1, "migration converts the collection");
  let archv = await listItems(STORE_KEYS.archive);
  check(
    archv.length === 1 && archv[0].kind === "window" &&
      archv[0].labels.includes("Research") && archv[0].labels.includes("old") &&
      Number.isFinite(archv[0].archivedAt),
    "collection became a labeled archive bundle"
  );
  check((await listItems(STORE_KEYS.collections)).length === 0, "collection tombstoned after migration");
  check((await migrateCollectionsToLabels()) === 0, "migration is idempotent");
  
  // label & archive from inbox (the new triage action)
  const inbItem = {
    ...(await newMeta()), kind: "tab",
    tabs: [{ url: "https://l1.com", title: "L1" }], source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, inbItem);
  await labelAndArchive([inbItem], "Research");
  check(
    !(await listItems(STORE_KEYS.inbox)).some((i) => i.id === inbItem.id),
    "labelAndArchive removes the item from the Inbox"
  );
  const movedItem = (await listItems(STORE_KEYS.archive)).find((i) => i.id === inbItem.id);
  check(
    movedItem?.labels.includes("Research") && Number.isFinite(movedItem.archivedAt),
    "labelAndArchive tags and stamps archivedAt (same id)"
  );
  
  // aggregation across stores
  const inb2 = {
    ...(await newMeta()), kind: "tab",
    tabs: [{ url: "https://l2.com", title: "L2" }], source: "dump", labels: ["todo"]
  };
  await upsertItem(STORE_KEYS.inbox, inb2);
  const labelGroups = await collectLabels();
  const research = labelGroups.find((g) => g.label === "Research");
  check(
    research && research.entries.length === 2 && research.tabs === 3,
    "collectLabels aggregates items and tab counts across Inbox + Archive"
  );
  check(labelGroups.some((g) => g.label === "todo"), "inbox labels included");
  
  // add/remove
  await addLabel(STORE_KEYS.inbox, inb2, "todo"); // duplicate → no-op
  check(
    (await listItems(STORE_KEYS.inbox)).find((i) => i.id === inb2.id).labels.length === 1,
    "addLabel dedupes"
  );
  await removeLabel(
    STORE_KEYS.inbox,
    (await listItems(STORE_KEYS.inbox)).find((i) => i.id === inb2.id),
    "todo"
  );
  check(!(await collectLabels()).some((g) => g.label === "todo"), "removeLabel drops the label");
  
  // labels belong to TABS: labeling a window bundle splits it per tab
  const { applyLabels } = await import("../js/lib/labels.js");
  const winA = {
    ...(await newMeta()), kind: "window",
    tabs: [{ url: "https://w1.com", title: "W1" }, { url: "https://w2.com", title: "W2" }],
    source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, winA);
  await applyLabels(STORE_KEYS.inbox, winA, ["proj"]);
  let inbNow = await listItems(STORE_KEYS.inbox);
  const labeledA = inbNow.find((i) => i.id === winA.id);
  check(
    labeledA && labeledA.kind === "window" && labeledA.tabs.length === 2 &&
      labeledA.tabs.every((t) => t.labels?.includes("proj")),
    "P2g-2: applyLabels labels every tab IN PLACE — bundle intact, same id, no split (N11)"
  );
  check(inbNow.filter((i) => i.tabs.some((t) => t.labels?.includes("proj"))).length === 1,
    "P2g-2: applyLabels creates no new items");
  
  const winB = {
    ...(await newMeta()), kind: "window",
    tabs: [{ url: "https://w3.com", title: "W3" }, { url: "https://w4.com", title: "W4" }],
    source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, winB);
  await labelAndArchive([winB], ["proj", "later"]);
  const archNow = await listItems(STORE_KEYS.archive);
  const splitArch = archNow.filter((i) => i.labels.includes("later"));
  check(
    splitArch.length === 2 && splitArch.every((i) => i.kind === "tab" && i.labels.includes("proj")),
    "labelAndArchive splits bundles per tab with all labels applied"
  );
  
  // plain archiving (no labels) keeps the bundle whole, same id
  const winC = {
    ...(await newMeta()), kind: "window",
    tabs: [{ url: "https://w5.com", title: "W5" }, { url: "https://w6.com", title: "W6" }],
    source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, winC);
  await labelAndArchive([winC]);
  const kept = (await listItems(STORE_KEYS.archive)).find((i) => i.id === winC.id);
  check(kept && kept.kind === "window" && kept.tabs.length === 2,
    "plain archive (no labels) keeps window bundles whole");
  
  /* --- F21: precise per-label "last used" recency ------------------------------
     Recency is now a dedicated grow-only register bumped ONLY on apply/rename, not
     the L-nav-5 proxy (max carrier modifiedAt) that any unrelated touch inflated. */
  {
    const { LABEL_META_KEY, touchedLabelMeta, renamedLabelMeta, touchLabels, getLabelMeta } =
      await import("../js/lib/label-meta.js");
    const { mergeLabelMeta } = await import("../js/lib/merge.js");
    const { collectLabels: collectL, sortLabelGroups: sortL, applyLabels: applyL,
      labelTabsFromItems: labelTFI, renameLabel: renameL, deleteLabelEverywhere: delLabelEvery } =
      await import("../js/lib/labels.js");
  
    // pure seams
    check(touchedLabelMeta({}, ["a"], 100).a === 100 &&
          touchedLabelMeta({ a: 200 }, ["a"], 100).a === 200 && // older now never lowers
          touchedLabelMeta({ a: 100 }, ["a"], 200).a === 200,
      "F21: touchedLabelMeta is grow-only max (an older now never lowers an entry)");
    check(JSON.stringify(touchedLabelMeta({}, [" x ", "x", ""], 5)) === JSON.stringify({ x: 5 }),
      "F21: touchedLabelMeta trims, dedups, and drops empty labels");
    { const r = renamedLabelMeta({ from: 100, to: 50, other: 9 }, "from", "to", 80);
      check(!("from" in r) && r.to === 100 && r.other === 9,
        "F21: renamedLabelMeta moves recency to the target (max of from/to/now), drops the source"); }
    check(JSON.stringify(mergeLabelMeta({ a: 5, b: 9 }, { a: 8, c: 3 })) === JSON.stringify({ a: 8, b: 9, c: 3 }),
      "F21: mergeLabelMeta unions two registers by per-key max");
    { const m = mergeLabelMeta({ a: 5 }, { a: "x", b: NaN });
      check(m.a === 5 && !("b" in m), "F21: mergeLabelMeta ignores non-finite remote values (self-heals a corrupt file)"); }
  
    // behavioral: the reported bug. A bundle carries an OLD label X; applying a
    // DIFFERENT label Y to the same bundle must NOT lift X's recency.
    mem[STORE_KEYS.inbox] = {}; mem[STORE_KEYS.archive] = {}; mem[STORE_KEYS.sessions] = {};
    delete mem[LABEL_META_KEY];
    const bundle = { ...(await newMeta()), kind: "window", source: "dump",
      tabs: [{ url: "https://f21-a.com", labels: ["X"] }, { url: "https://f21-b.com" }] };
    await upsertItem(STORE_KEYS.inbox, bundle);
    mem[LABEL_META_KEY] = { X: 1000 }; // X really used long ago
    const t0 = Date.now();
    await labelTFI([{ item: bundle, indexes: [1] }], "Y"); // re-upserts the whole bundle
    const metaAfter = await getLabelMeta();
    check(metaAfter.Y >= t0 && metaAfter.X === 1000,
      "F21 (the bug): applying Y bumps Y but leaves X's recency untouched (no false inflation)");
  
    const groups = await collectL();
    const gX = groups.find((g) => g.label === "X");
    const gY = groups.find((g) => g.label === "Y");
    check(gX.lastUsedAt === 1000 && gY.lastUsedAt >= t0,
      "F21: collectLabels attaches precise lastUsedAt from labelMeta");
    const order = sortL(groups, "recent").map((g) => g.label);
    check(order.indexOf("Y") < order.indexOf("X"),
      "F21: 'recent' ranks the actually-used Y above the incidentally-touched X");
  
    // read-path fallback: with no meta, a label uses the modifiedAt proxy (upgrade
    // day is unchanged and self-corrects on next use).
    delete mem[LABEL_META_KEY];
    const storedBundle = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === bundle.id);
    const gX2 = (await collectL()).find((g) => g.label === "X");
    check(gX2.lastUsedAt === storedBundle.modifiedAt,
      "F21: with no labelMeta, lastUsedAt falls back to the max-modifiedAt proxy");
  
    // applyLabels (site 1) bumps in-commit
    delete mem[LABEL_META_KEY];
    const inbA = { ...(await newMeta()), kind: "tab", tabs: [{ url: "https://f21-c.com" }], source: "dump", labels: [] };
    await upsertItem(STORE_KEYS.inbox, inbA);
    const t1 = Date.now();
    await applyL(STORE_KEYS.inbox, inbA, "W");
    check((await getLabelMeta()).W >= t1, "F21: applyLabels bumps the applied label's recency in-commit");
  
    // touchLabels standalone (the direct-upsert + background sites' mechanism)
    delete mem[LABEL_META_KEY];
    const t2 = Date.now();
    await touchLabels(["  V  ", ""]);
    check((await getLabelMeta()).V >= t2, "F21: touchLabels bumps trimmed labels (direct-upsert/background sites)");
    const snap = JSON.stringify(await getLabelMeta());
    await touchLabels([]);
    check(JSON.stringify(await getLabelMeta()) === snap, "F21: touchLabels is a no-op for an empty label set");
  
    // rename moves recency; delete leaves the register (existence via carriers)
    mem[STORE_KEYS.inbox] = {}; mem[STORE_KEYS.archive] = {}; mem[STORE_KEYS.sessions] = {};
    const rbundle = { ...(await newMeta()), kind: "tab", source: "dump",
      tabs: [{ url: "https://f21-r.com", labels: ["Y"] }] };
    await upsertItem(STORE_KEYS.inbox, rbundle);
    mem[LABEL_META_KEY] = { X: 1000, Y: 5000 };
    await renameL("Y", "Z");
    const mR = await getLabelMeta();
    check(!("Y" in mR) && mR.Z >= 5000, "F21: renameLabel moves recency to the new name and drops the old");
    const beforeDel = (await getLabelMeta()).X;
    await delLabelEvery("Z");
    check((await getLabelMeta()).X === beforeDel && (await getLabelMeta()).Z === mR.Z,
      "F21: deleteLabelEverywhere leaves labelMeta untouched (existence comes from carriers)");
    check(!(await collectL()).some((g) => g.label === "Z"),
      "F21: a deleted label no longer appears (no carriers), regardless of a lingering meta entry");
    delete mem[LABEL_META_KEY];
    mem[STORE_KEYS.inbox] = {}; mem[STORE_KEYS.archive] = {}; mem[STORE_KEYS.sessions] = {};
  }
  
  /* --- P2g-2: labels at TRUE tab grain (N11 no-split, U9 sessions, rename/delete) --- */
  {
    const { labelTabsFromItems, removeLabelFromTab, collectLabels, tabLabels,
      labelSessionTabs, removeSessionLabel, renameLabel, deleteLabelEverywhere } =
      await import("../js/lib/labels.js");
    const { searchAll } = await import("../js/lib/search.js");
    const { fromSessions } = await import("../js/ui/tablist.js");
  
    mem[STORE_KEYS.inbox] = {};
    mem[STORE_KEYS.archive] = {};
    mem[STORE_KEYS.sessions] = {};
  
    // N11: labeling a SUBSET of a bundle labels the refs in place — NO split
    const bundle = { ...(await newMeta()), kind: "window", source: "dump", labels: [],
      tabs: [{ url: "https://n1.com", title: "N1" }, { url: "https://n2.com", title: "N2" }, { url: "https://n3.com", title: "N3" }] };
    await upsertItem(STORE_KEYS.inbox, bundle);
    await labelTabsFromItems([{ item: bundle, indexes: [0, 2] }], ["research"]);
    const after = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === bundle.id);
    check(after && after.kind === "window" && after.tabs.length === 3,
      "P2g-2/N11: labeling a bundle subset never splits — same id, same 3 tabs");
    check(after.tabs[0].labels.includes("research") && !after.tabs[1].labels && after.tabs[2].labels.includes("research"),
      "P2g-2/N11: only the targeted refs carry the label (true tab grain)");
    check((await listItems(STORE_KEYS.inbox)).length === 1, "P2g-2/N11: no new items created");
  
    check(JSON.stringify(tabLabels({ labels: ["a"] }, { labels: ["b"] })) === JSON.stringify(["a", "b"]),
      "P2g-2: tabLabels unions the item grain with the tab grain");
  
    // removing an item-grain label from ONE tab demotes it to the other tabs
    const legacy = { ...(await newMeta()), kind: "window", source: "dump", labels: ["old"],
      tabs: [{ url: "https://l1.com", title: "L1" }, { url: "https://l2.com", title: "L2" }] };
    await upsertItem(STORE_KEYS.inbox, legacy);
    await removeLabelFromTab(STORE_KEYS.inbox, legacy, 0, "old");
    const demoted = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === legacy.id);
    check(demoted && !demoted.labels.includes("old") && !(demoted.tabs[0].labels ?? []).includes("old") &&
      demoted.tabs[1].labels.includes("old"),
      "P2g-2: removing an item-grain label from ONE tab keeps it on the others (demotion)");
  
    // U9: sessions — card + row labeling, snapshot refusal, union chips
    const sess = { ...(await newMeta()), name: "Trip", auto: false, labels: [],
      windows: [[{ url: "https://s1.com", title: "S1" }], [{ url: "https://s2.com", title: "S2" }]] };
    const snap = { ...(await newMeta()), name: "Snap", auto: true, labels: [],
      windows: [[{ url: "https://x.com", title: "X" }]] };
    await upsertItem(STORE_KEYS.sessions, sess);
    await upsertItem(STORE_KEYS.sessions, snap);
    check((await labelSessionTabs(snap, ["nope"])) === 0, "P2g-2/U9: snapshots refuse labels (immutable)");
    await labelSessionTabs(sess, ["travel"]);
    let sNow = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === sess.id);
    check(sNow.windows.every((w) => w.every((t) => t.labels.includes("travel"))),
      "P2g-2/U9: card-level label lands on every ref of the session");
    await labelSessionTabs(sNow, ["hotels"], { wi: 1, i: 0 });
    sNow = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === sess.id);
    check(!(sNow.windows[0][0].labels ?? []).includes("hotels") && sNow.windows[1][0].labels.includes("hotels"),
      "P2g-2/U9: row-level label targets exactly one tab of one window");
    const [sg] = fromSessions([sNow]);
    check(sg.chips.includes("travel") && sg.chips.includes("hotels"),
      "P2g-2/U9: fromSessions surfaces the union of per-tab labels as card chips");
    await removeSessionLabel(sNow, "hotels", { wi: 1, i: 0 });
    sNow = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === sess.id);
    check(!(sNow.windows[1][0].labels ?? []).includes("hotels"),
      "P2g-2/U9: session row-chip removal strips just that tab's label");
  
    // collectLabels: tab grain, sessions included, snapshots excluded, precise locations
    const groups = await collectLabels();
    const research = groups.find((g) => g.label === "research");
    check(research && research.tabs === 2, "P2g-2: collectLabels counts per-tab labels (2 of 3 bundle tabs)");
    const travel = groups.find((g) => g.label === "travel");
    check(travel && travel.tabs === 2 && travel.entries[0].store === STORE_KEYS.sessions,
      "P2g-2/U9: collectLabels includes session tabs with their store");
    check(!groups.some((g) => g.label === "nope"), "P2g-2: snapshots contribute no labels");
    const old = groups.find((g) => g.label === "old");
    check(old && old.tabs === 1 && old.entries[0].tabs[0].i === 1,
      "P2g-2: collectLabels records the precise tab index carrying the label");
  
    // search matches labels, both grains, sessions included
    check((await searchAll("research")).some((r) => r.url === "https://n1.com"),
      "P2g-2: search matches per-tab labels");
    check((await searchAll("travel")).some((r) => r.type === "session" && r.url === "https://s1.com"),
      "P2g-2: search matches labels inside sessions");
  
    // rename / delete everywhere
    await renameLabel("research", "reading");
    const renamed = await collectLabels();
    check(renamed.some((g) => g.label === "reading") && !renamed.some((g) => g.label === "research"),
      "P2g-2: renameLabel renames across stores");
    await deleteLabelEverywhere("travel");
    const sFinal = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === sess.id);
    check(!(await collectLabels()).some((g) => g.label === "travel") &&
      sFinal.windows.flat().length === 2,
      "P2g-2: deleteLabelEverywhere strips the label from sessions too — tabs stay");
  }
  
  /* --- M6: undo journal --- */
  const { recordAction, listActions, undoAction, clearJournal } = await import("../js/lib/journal.js");
  const { updateSessionWindow, addWindowsToSession, createSessionFromWindows, renameSession } =
    await import("../js/lib/sessions.js");
  
  /* --- F22: Starred identity, atomic journal contract, exact Undo --- */
  {
    const {
      canonicalStarUrl, starIdForUrl, starTab, unstarTab, listStarred
    } = await import("../js/lib/starred.js");
    await clearJournal();
    delete mem[STORE_KEYS.starred];
    check(
      canonicalStarUrl("https://Example.com/path/#one") === "https://example.com/path" &&
        await starIdForUrl("https://example.com/path#two") ===
          await starIdForUrl("https://EXAMPLE.com/path/") &&
        canonicalStarUrl("chrome://settings") === null,
      "F22: canonical HTTP(S) identity ignores fragment/case/trailing slash and rejects privileged URLs"
    );
    const ref = {
      url: "https://example.com/path#reading",
      title: "Reference",
      favIconUrl: "data:image/png;base64,AA=="
    };
    check(await starTab(ref) === true && await starTab(ref) === false,
      "F22: starring is idempotent for one global canonical URL");
    let starred = await listStarred();
    let actions = await listActions();
    check(
      starred.length === 1 && starred[0].position === 0 &&
        actions.length === 1 &&
        actions[0].dels?.[0]?.store === STORE_KEYS.starred,
      "F22: Star commits one stable shortcut and its inverse journal entry"
    );
    const original = starred[0];
    check(await unstarTab(original.id) === true && (await listStarred()).length === 0,
      "F22: Unstar writes a mergeable tombstone");
    actions = await listActions();
    check(
      actions[0].puts?.[0]?.item.position === 0 &&
        actions[0].puts?.[0]?.store === STORE_KEYS.starred,
      "F22: Unstar journals the exact prior record and position"
    );
    await undoAction(actions[0].id);
    starred = await listStarred();
    check(starred.length === 1 && starred[0].id === original.id && starred[0].position === 0,
      "F22: Undo restores the exact Starred shortcut at its prior position");
  }
  
  await clearJournal();
  delete mem[STORE_KEYS.inbox];
  delete mem[STORE_KEYS.archive];
  
  // delete-undo: puts revive the item
  const victim = {
    ...(await newMeta()), kind: "tab",
    tabs: [{ url: "https://victim.com", title: "V" }], source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, victim);
  await deleteSavedItem(STORE_KEYS.inbox, victim, "Deleted an Inbox item");
  check((await listItems(STORE_KEYS.inbox)).length === 0, "journal: item gone before undo");
  const undone1 = await undoAction();
  check(undone1?.undone === true, "undoAction returns the entry, marked undone");
  check(
    (await listItems(STORE_KEYS.inbox)).some((i) => i.id === victim.id),
    "undo revives a deleted item"
  );
  check((await undoAction(undone1.id)) === null, "same entry cannot be undone twice");
  
  // close-undo: reopen creates tabs/windows
  browserEffects.clearTabs();
  browserEffects.clearWindows();
  await recordAction("Closed 1 tab", { reopen: [[{ url: "https://closed.com", title: "C" }]] });
  await undoAction();
  check(browserEffects.tabs.includes("https://closed.com"), "undo reopens a single closed tab");
  await recordAction("Closed 3 tabs", {
    reopen: [[{ url: "https://c1.com" }, { url: "https://c2.com" }, { url: "https://c3.com" }]]
  });
  await undoAction();
  check(browserEffects.windows.length === 1 && browserEffects.windows[0].tabs.length === 3,
    "undo reopens multiple tabs as one window");
  
  // archive-undo: puts + dels reverse a labelAndArchive
  const arcItem = {
    ...(await newMeta()), kind: "tab",
    tabs: [{ url: "https://arc.com", title: "A" }], source: "dump", labels: []
  };
  await upsertItem(STORE_KEYS.inbox, arcItem);
  await labelAndArchive([arcItem], ["undo-test"]); // records its own journal entry
  await undoAction();
  check(
    (await listItems(STORE_KEYS.inbox)).some((i) => i.id === arcItem.id) &&
      !(await listItems(STORE_KEYS.archive)).some((i) => i.id === arcItem.id),
    "undo of archive returns the item to the Inbox and clears the archive copy"
  );
  
  // journal cap (F46r: 50 -> 200; the cap is the single source, not a literal)
  const { JOURNAL_CAP } = await import("../js/lib/journal.js");
  await clearJournal();
  for (let i = 0; i < JOURNAL_CAP + 5; i++) {
    await recordAction(`a${i}`, { reopen: [[{ url: "https://x.com" }]] });
  }
  check(JOURNAL_CAP === 200 && (await listActions()).length === JOURNAL_CAP,
    "F46r: the journal keeps the newest JOURNAL_CAP (200) entries");
  
  /* --- M6: session windows (drift support) --- */
  const baseSession = await createSessionFromWindows(
    [[{ url: "https://s1.com", title: "S1" }]], "Drift"
  );
  await addWindowsToSession(baseSession.id, [[{ url: "https://s2.com", title: "S2" }]]);
  let drift = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === baseSession.id);
  check(drift.windows.length === 2, "addWindowsToSession appends a window");
  await updateSessionWindow(baseSession.id, 0, [
    { url: "https://s1.com", title: "S1" },
    { url: "https://s1b.com", title: "S1b" }
  ]);
  drift = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === baseSession.id);
  check(
    drift.windows[0].length === 2 && drift.windows[1].length === 1,
    "updateSessionWindow replaces only the targeted window"
  );
  await undoAction(); // update was journaled
  drift = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === baseSession.id);
  check(drift.windows[0].length === 1, "undo restores the pre-update session");
  
  // P2a-1: renameSession (the popup's "Saved: {name} + Rename" path) is undoable.
  await renameSession(baseSession.id, "Renamed Drift");
  drift = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === baseSession.id);
  check(drift.name === "Renamed Drift", "renameSession changes the name");
  await undoAction(); // rename was journaled
  drift = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === baseSession.id);
  check(drift.name === "Drift", "undo restores the previous session name");
  
  // N8: snapshots (auto sessions) are immutable — the lib guards reject them.
  const autoSnap = { ...(await newMeta()), name: "Snapshot X", auto: true,
    windows: [[{ url: "https://snap1.com", title: "Snap" }]], labels: [] };
  await upsertItem(STORE_KEYS.sessions, autoSnap);
  check((await addWindowsToSession(autoSnap.id, [[{ url: "https://add.com", title: "Add" }]])) === null,
    "N8: addWindowsToSession refuses an auto snapshot");
  check((await renameSession(autoSnap.id, "Renamed")) === null, "N8: renameSession refuses an auto snapshot");
  check((await updateSessionWindow(autoSnap.id, 0, [{ url: "https://x.com", title: "X" }])) === null,
    "N8: updateSessionWindow refuses an auto snapshot");
  const snapUnchanged = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === autoSnap.id);
  check(snapUnchanged && snapUnchanged.name === "Snapshot X" && snapUnchanged.windows.length === 1 &&
    snapUnchanged.windows[0].length === 1,
    "N8: the snapshot is untouched after every rejected mutation");
  
  /* --- P2d-1: inbox triage lib (split / tombstone / undo / window structure) --- */
  {
    const { removeTabsFromInboxItem, restoreTabsFromItems, deleteTabsFromItems, snoozeTabRefs } =
      await import("../js/lib/actions.js");
    const { archiveTabsFromItems } = await import("../js/lib/labels.js");
    const { undoAction, clearJournal } = await import("../js/lib/journal.js");
  
    const mkBundle = async (urls) => ({
      ...(await newMeta()), kind: urls.length > 1 ? "window" : "tab",
      tabs: urls.map((u, i) => ({ url: u, title: "T" + i })), source: "dump", labels: []
    });
  
    // split: removing a middle tab keeps the rest and the window kind
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    const b = await mkBundle(["https://a.com", "https://b.com", "https://c.com"]);
    await upsertItem(STORE_KEYS.inbox, b);
    const afterSplit = await removeTabsFromInboxItem(b, [1]);
    check(
      afterSplit && afterSplit.tabs.map((t) => t.url).join() === "https://a.com,https://c.com" &&
        afterSplit.kind === "window",
      "P2d-1 split: acted tab leaves, siblings stay, window kind kept"
    );
    const b2 = await mkBundle(["https://x.com", "https://y.com"]);
    await upsertItem(STORE_KEYS.inbox, b2);
    const afterD = await removeTabsFromInboxItem(b2, [0]);
    check(afterD && afterD.tabs.length === 1 && afterD.kind === "tab",
      "P2d-1 split: kind downgrades to tab when one remains");
  
    // empty-item tombstone
    const b3 = await mkBundle(["https://only.com"]);
    await upsertItem(STORE_KEYS.inbox, b3);
    const emptied = await removeTabsFromInboxItem(b3, [0]);
    check(emptied === null && !(await listItems(STORE_KEYS.inbox)).some((i) => i.id === b3.id),
      "P2d-1 tombstone: an emptied item disappears");
  
    // undo round-trip: delete a subset, then undo → pre-split item back exactly
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    const del = await mkBundle(["https://d1.com", "https://d2.com", "https://d3.com"]);
    await upsertItem(STORE_KEYS.inbox, del);
    await deleteTabsFromItems([{ item: del, indexes: [0, 2] }]);
    const shrunk = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === del.id);
    check(shrunk && shrunk.tabs.length === 1 && shrunk.tabs[0].url === "https://d2.com",
      "P2d-1 delete: subset split out, remainder stays");
    await undoAction();
    const revived = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === del.id);
    check(revived && revived.tabs.map((t) => t.url).join() === "https://d1.com,https://d2.com,https://d3.com",
      "P2d-1 undo: delete restores the exact pre-split item");
  
    // snooze: one snooze per source item, bundles preserved; undo revives + drops snoozes
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    delete mem[STORE_KEYS.snoozes];
    mem.settings = {};
    const loose = await mkBundle(["https://loose.com"]);
    const win = await mkBundle(["https://w1.com", "https://w2.com", "https://w3.com"]);
    await upsertItem(STORE_KEYS.inbox, loose);
    await upsertItem(STORE_KEYS.inbox, win);
    const n = await snoozeTabRefs(
      [{ item: loose, indexes: [0] }, { item: win, indexes: [0, 1] }],
      Date.now() + 3600_000
    );
    const snz = await listItems(STORE_KEYS.snoozes);
    check(n === 3 && snz.length === 2, "P2d-1 snooze: one snooze per source item (2 items → 2 snoozes)");
    check(
      snz.some((s) => Array.isArray(s.tabs) && s.tabs.length === 2) &&
        snz.some((s) => !s.tabs && s.url === "https://loose.com"),
      "P2d-1 snooze: window subset → one window snooze (tabs[]), loose → single snooze"
    );
    const inboxAfterSnooze = await listItems(STORE_KEYS.inbox);
    check(
      !inboxAfterSnooze.some((i) => i.id === loose.id) &&
        inboxAfterSnooze.find((i) => i.id === win.id)?.tabs.length === 1,
      "P2d-1 snooze: sources split (loose tombstoned, window shrunk to remainder)"
    );
    await undoAction();
    check(
      (await listItems(STORE_KEYS.inbox)).find((i) => i.id === loose.id)?.tabs.length === 1 &&
        (await listItems(STORE_KEYS.inbox)).find((i) => i.id === win.id)?.tabs.length === 3 &&
        (await listItems(STORE_KEYS.snoozes)).length === 0,
      "P2d-1 undo: snooze restores both pre-split items and drops the snoozes"
    );
  
    // window-structure preservation on restore
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    browserEffects.clearWindows();
    browserEffects.clearTabs();
    const rWin = await mkBundle(["https://r1.com", "https://r2.com", "https://r3.com"]);
    const rTab = await mkBundle(["https://solo.com"]);
    await upsertItem(STORE_KEYS.inbox, rWin);
    await upsertItem(STORE_KEYS.inbox, rTab);
    await restoreTabsFromItems([{ item: rWin, indexes: [0, 1] }, { item: rTab, indexes: [0] }]);
    check(browserEffects.windows.length === 1 && browserEffects.windows[0].tabs.length === 2,
      "P2d-1 restore: a window bundle's picked tabs reopen as ONE window");
    check(browserEffects.tabs.includes("https://solo.com"), "P2d-1 restore: a loose tab reopens as a tab");
    check((await listItems(STORE_KEYS.inbox)).find((i) => i.id === rWin.id)?.tabs.length === 1,
      "P2d-1 restore: source window split, remainder stays in the Inbox");
  
    // archive at tab grain (labels split per tab); undo revives inbox + clears archive
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    delete mem[STORE_KEYS.archive];
    const arc = await mkBundle(["https://arc1.com", "https://arc2.com", "https://arc3.com"]);
    await upsertItem(STORE_KEYS.inbox, arc);
    const na = await archiveTabsFromItems([{ item: arc, indexes: [0, 1] }], "Ref");
    const arch = await listItems(STORE_KEYS.archive);
    check(na === 2 && arch.length === 2 && arch.every((i) => i.labels.includes("Ref") && i.kind === "tab"),
      "P2d-1 archive: labeled subset splits into per-tab archive items");
    check((await listItems(STORE_KEYS.inbox)).find((i) => i.id === arc.id)?.tabs.length === 1,
      "P2d-1 archive: source item split to the remainder");
    await undoAction();
    check(
      (await listItems(STORE_KEYS.inbox)).find((i) => i.id === arc.id)?.tabs.length === 3 &&
        (await listItems(STORE_KEYS.archive)).length === 0,
      "P2d-1 undo: archive restores the pre-split inbox item and clears the archive copies"
    );
  }
  
  /* --- N6: Inbox → Session moves (not copies) and is undoable --- */
  {
    const { moveTabsToSession } = await import("../js/lib/actions.js");
    const { undoAction, clearJournal } = await import("../js/lib/journal.js");
    const mk = async (urls) => ({
      ...(await newMeta()), kind: urls.length > 1 ? "window" : "tab",
      tabs: urls.map((u, i) => ({ url: u, title: "T" + i })), source: "dump", labels: []
    });
  
    // new session from a selection spanning two items — moves tabs out, preserves windows
    await clearJournal();
    delete mem[STORE_KEYS.inbox]; delete mem[STORE_KEYS.sessions];
    const A = await mk(["https://a1.com", "https://a2.com", "https://a3.com"]);
    const B = await mk(["https://b1.com"]);
    await upsertItem(STORE_KEYS.inbox, A);
    await upsertItem(STORE_KEYS.inbox, B);
    const res = await moveTabsToSession([{ item: A, indexes: [0, 1] }, { item: B, indexes: [0] }], "__new", "Work");
    check(res?.moved === 3 && res.name === "Work", "N6: reports moved count + session name");
    const sess = (await listItems(STORE_KEYS.sessions)).find((s) => s.name === "Work");
    check(sess && sess.windows.length === 2 && sess.windows[0].length === 2 && sess.windows[1].length === 1,
      "N6: window structure preserved (one session window per source item)");
    const inboxA = (await listItems(STORE_KEYS.inbox)).find((i) => i.id === A.id);
    check(
      inboxA?.tabs.length === 1 && inboxA.tabs[0].url === "https://a3.com" &&
        !(await listItems(STORE_KEYS.inbox)).some((i) => i.id === B.id),
      "N6: selected tabs MOVE out of the Inbox (split), not copy"
    );
    await undoAction();
    check(
      (await listItems(STORE_KEYS.inbox)).find((i) => i.id === A.id)?.tabs.length === 3 &&
        (await listItems(STORE_KEYS.inbox)).find((i) => i.id === B.id)?.tabs.length === 1 &&
        !(await listItems(STORE_KEYS.sessions)).some((s) => s.name === "Work"),
      "N6 undo: restores the pre-move Inbox items and removes the new session"
    );
  
    // append to an existing named session
    await clearJournal();
    delete mem[STORE_KEYS.inbox];
    const existing = { ...(await newMeta()), name: "Proj", auto: false, windows: [[{ url: "https://x.com", title: "X" }]], labels: [] };
    await upsertItem(STORE_KEYS.sessions, existing);
    const C = await mk(["https://c1.com", "https://c2.com"]);
    await upsertItem(STORE_KEYS.inbox, C);
    const r2 = await moveTabsToSession([{ item: C, indexes: [0, 1] }], existing.id);
    check(r2?.moved === 2 && (await listItems(STORE_KEYS.sessions)).find((s) => s.id === existing.id).windows.length === 2,
      "N6: appending to an existing session adds the moved window");
    await undoAction();
    check(
      (await listItems(STORE_KEYS.sessions)).find((s) => s.id === existing.id)?.windows.length === 1 &&
        (await listItems(STORE_KEYS.inbox)).find((i) => i.id === C.id)?.tabs.length === 2,
      "N6 undo: append restores the session's prior windows and the Inbox item"
    );
  
    // never append to an auto snapshot (N8)
    const snap = { ...(await newMeta()), name: "Snapshot 1", auto: true, windows: [[{ url: "https://s.com", title: "S" }]], labels: [] };
    await upsertItem(STORE_KEYS.sessions, snap);
    const D = await mk(["https://d.com"]);
    await upsertItem(STORE_KEYS.inbox, D);
    const r3 = await moveTabsToSession([{ item: D, indexes: [0] }], snap.id);
    check(r3 === null && (await listItems(STORE_KEYS.inbox)).some((i) => i.id === D.id),
      "N6/N8: moveTabsToSession refuses an auto snapshot (Inbox untouched)");
  }
  
}
