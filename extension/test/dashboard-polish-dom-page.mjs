import {
  createAnchoredPanel, createTabList, dismissAnchoredPanel, fromDuplicateGroups
} from "../js/ui/tablist.js";
import { createIndexBar } from "../js/ui/indexbar.js";
import { buildSnoozePanel } from "../js/ui/list-helpers.js";
import { duplicateIdentityBanner } from "../js/ui/duplicates-surface.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";
import { createIntrinsicBlockMotion } from "../js/ui/intrinsic-block-motion.js";
import { minimalSearchResultsRoom } from "../js/ui/minimal-search-layout.js";
import { createMinimalNavigation } from "../js/ui/minimal-navigation.js";
import { createDataHub, dataRoute } from "../js/ui/data-hub.js";
import { createDataSurface } from "../js/ui/data-surface.js";

const resultNode = document.querySelector("#result");
const listHost = document.querySelector("#list-host");
const checks = [];
const check = (condition, name, detail = "") => {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browserI18n = await createBrowserI18nMock();
globalThis.chrome = {
  i18n: browserI18n,
  runtime: {
    getURL: (path) => `chrome-extension://everytab${path}`,
    sendMessage: async (message) => message.type === "inspect-snapshot-recovery"
      ? { ok: true, snapshots: [{ snapshotId: "snapshot-1", at: Date.now(), missingCount: 1 }] }
      : { ok: false }
  }
};

try {
  const dataJumps = [];
  const dataHub = createDataHub({ onJump: (area) => dataJumps.push(area) });
  const dataHost = document.createElement("div");
  dataHost.style.cssText = "position:fixed;left:-2000px;top:0;width:800px";
  dataHost.append(dataHub.element);
  document.body.append(dataHost);
  const dataSurface = createDataSurface({
    getBody: () => dataHub.coreHost,
    setHeading: () => {},
    onChanged: async () => {}
  });
  await dataSurface.render();
  dataHub.buttons.transfer.click();
  const nativeImportInput = dataHub.coreHost.querySelector("#data-area-transfer textarea");
  const nativeImportPreview = dataHub.coreHost.querySelector(".data-import-preview");
  nativeImportInput.value = "## Reading\n- [Example](https://example.com/article)";
  nativeImportInput.dispatchEvent(new Event("input", { bubbles: true }));
  const previewText = nativeImportPreview.textContent;
  await dataSurface.render();
  const nativeVaultProgress = document.createElement("div");
  nativeVaultProgress.textContent = "Syncing Library";
  dataHub.vaultBody.replaceChildren(nativeVaultProgress);
  await dataSurface.render();
  const dataAreas = [...dataHub.element.querySelectorAll(".data-area")];
  const directVaultTarget = document.getElementById(`data-area-${dataRoute("data:vault").area}`);
  check(dataRoute("data")?.area === null && dataRoute("vault")?.area === "vault" &&
      dataRoute("data:vault")?.area === "vault" &&
      directVaultTarget === dataHub.element.querySelector("#data-area-vault") &&
      dataJumps.join(",") === "transfer" &&
      dataAreas.length === 3 && dataAreas.every((area) => !area.hidden) &&
      dataHub.nav.getAttribute("role") === "navigation" &&
      dataHub.buttons.transfer.getAttribute("role") === null &&
      dataHub.coreHost.querySelector("#data-area-transfer textarea") === nativeImportInput &&
      dataHub.coreHost.querySelector(".data-import-preview") === nativeImportPreview &&
      nativeImportInput.value.includes("example.com/article") &&
      nativeImportPreview.textContent === previewText && previewText.includes("Links: 1") &&
      dataHub.vaultBody.firstChild === nativeVaultProgress,
    "Data keeps all sections continuously visible and retains typed import, parsed preview, and Vault progress state");

  const snapshotButton = [...dataHub.coreHost.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Check automatic snapshots"));
  const snapshotRow = snapshotButton.closest(".setrow");
  check(snapshotRow?.contains(snapshotButton) &&
      snapshotRow.querySelector(".tw") && snapshotRow.querySelector(".d") &&
      snapshotRow.nextElementSibling?.classList.contains("data-recovery-actions"),
    "the automatic snapshot action aligns with its description and keeps later review controls separate");
  snapshotButton.click();
  await wait(0);
  const snapshotActions = snapshotRow.nextElementSibling;
  check(snapshotActions.querySelector("select") && snapshotActions.querySelector("button"),
    "snapshot inspection reveals the selector and review action in their own full-width row");
  dataHost.style.width = "420px";
  await frame();
  check(getComputedStyle(snapshotRow).flexDirection === "column" &&
      getComputedStyle(snapshotActions).flexDirection === "column" &&
      [...snapshotActions.children].every((control) =>
        Math.abs(control.getBoundingClientRect().width - snapshotActions.getBoundingClientRect().width) < 1),
    "Data snapshot controls stack without clipping at a narrow workspace width");
  dataHost.style.width = "220px";
  await frame();
  dataHub.buttons.transfer.focus();
  const chipLines = new Set([...dataHub.nav.children]
    .map((chip) => Math.round(chip.getBoundingClientRect().top)));
  check(chipLines.size > 1 && getComputedStyle(dataHub.nav).overflow === "visible" &&
      getComputedStyle(dataHub.buttons.transfer).outlineStyle === "solid",
    "wrapped Data jump chips retain an unclipped visible keyboard focus outline");
  dataHost.remove();

  const { createPageUtilities } = await import("../js/ui/command-box.js");
  const activityUtilities = createPageUtilities({ go: () => {} });
  check(activityUtilities.attention.getAttribute("aria-label") === "Activity" &&
      !activityUtilities.attention.querySelector(".page-attention-label") &&
      !activityUtilities.attention.textContent.includes("Needs you"),
    "the compact activity line has an accessible name without a visible Needs-you heading");

  const coldHost = document.createElement("div");
  coldHost.className = "minimal-horizon";
  coldHost.style.cssText = [
    "position:fixed", "left:-2000px", "bottom:0", "width:1440px", "height:720px",
    "display:flex", "align-items:flex-end", "justify-content:center", "padding:28px 18px 86px"
  ].join(";");
  const coldLauncher = document.createElement("div");
  coldLauncher.className = "minimal-launcher";
  const coldAccess = document.createElement("div");
  coldAccess.className = "focus-access hidden newtab-focus-access";
  coldAccess.innerHTML = '<span class="focus-access-head">Available now</span><div class="focus-access-rows"><div class="focus-access-row"><span class="focus-access-domain">example.com</span><span class="focus-access-time">4:58</span></div></div>';
  const coldDeck = document.createElement("section");
  coldDeck.className = "minimal-deck";
  coldDeck.innerHTML = '<div class="search-field"><input class="search-input" placeholder="Search open, saved, and browser History..."></div>';
  const coldFooter = document.createElement("div");
  coldFooter.className = "links";
  coldFooter.innerHTML = '<a href="#">Dashboard</a><button type="button">Settings</button><span class="minimal-focus-action-host" aria-hidden="true"></span>';
  coldDeck.append(coldAccess, coldLauncher, coldFooter);
  coldHost.append(coldDeck);
  document.body.append(coldHost);
  const coldMotion = createIntrinsicBlockMotion(coldDeck);
  await frame();
  await frame();
  const coldFrames = [{
    top: coldDeck.getBoundingClientRect().top,
    height: coldDeck.getBoundingClientRect().height
  }];
  coldMotion.mutate(() => {
    coldLauncher.replaceChildren(...Array.from({ length: 10 }, (_, index) => {
      const item = document.createElement("div");
      item.className = "minimal-launch-item";
      item.innerHTML = `<button class="minimal-launch" type="button">Starred ${index + 1}</button>`;
      return item;
    }));
  });
  await frame();
  coldFrames.push({
    top: coldDeck.getBoundingClientRect().top,
    height: coldDeck.getBoundingClientRect().height
  });
  coldMotion.mutate(() => coldAccess.classList.remove("hidden"));
  for (let index = 0; index < 28; index += 1) {
    await frame();
    coldFrames.push({
      top: coldDeck.getBoundingClientRect().top,
      height: coldDeck.getBoundingClientRect().height
    });
  }
  const coldSteps = coldFrames.slice(1).map((value, index) => ({
    top: value.top - coldFrames[index].top,
    height: value.height - coldFrames[index].height
  }));
  check(
    coldSteps.every((step) => Math.abs(step.top) <= 21 && Math.abs(step.height) <= 21) &&
      coldSteps.every((step) => step.top <= 0.5 && step.height >= -0.5) &&
      Math.abs(coldFrames.at(-1).height - 292) <= 1,
    "Minimal cold hydration never moves the deck by a full content row in one frame",
    JSON.stringify({ frames: coldFrames, steps: coldSteps })
  );
  coldMotion.mutate(() => coldAccess.classList.add("hidden"));
  await frame();
  coldMotion.finish();
  check(!coldDeck.classList.contains("is-hydrating-layout") && !coldDeck.style.blockSize,
    "the first Search interaction can take block-size ownership from cold hydration immediately");
  coldMotion.destroy();
  coldHost.remove();

  const faviconFallbackList = createTabList({
    section: "favicon-fallback-fixture",
    groups: [{
      id: "missing-favicons",
      title: "Missing favicons",
      refs: [
        { title: "YouTube", url: "https://youtube.com/watch?v=one" },
        { title: "Extensions", url: "chrome://extensions" },
        { title: "Local document", url: "file:///Users/example/document.pdf" },
        {
          title: "Broken captured icon",
          url: "https://broken.example/page",
          favIconUrl: "https://broken.example/missing.ico"
        }
      ]
    }]
  });
  document.body.append(faviconFallbackList);
  const faviconRows = [...faviconFallbackList.querySelectorAll(".trow")];
  const cachedSiteFavicon = faviconRows[0].querySelector('[data-favicon-source="cache"]');
  const browserFallback = faviconRows[1].querySelector(".fv-placeholder");
  const fileFallback = faviconRows[2].querySelector(".fv-placeholder");
  const failedCapturedFavicon = faviconRows[3].querySelector('[data-favicon-source="captured"]');
  failedCapturedFavicon.dispatchEvent(new Event("error"));
  const retriedCachedFavicon = faviconRows[3].querySelector('[data-favicon-source="cache"]');
  retriedCachedFavicon.dispatchEvent(new Event("error"));
  const failedSiteFallback = faviconRows[3].querySelector(".fv-placeholder");
  check(
    cachedSiteFavicon?.getAttribute("src")?.includes("/_favicon/") &&
      cachedSiteFavicon.getAttribute("src").includes(
        "pageUrl=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Done"
      ) &&
      browserFallback?.dataset.fallbackKind === "browser" &&
      browserFallback.querySelector("svg") &&
      fileFallback?.dataset.fallbackKind === "file" &&
      fileFallback.querySelector("svg") &&
      retriedCachedFavicon?.getAttribute("src")?.includes("/_favicon/") &&
      failedSiteFallback?.dataset.fallbackKind === "site" &&
      failedSiteFallback.textContent === "B",
    "missing site, browser, and local favicons render intentional identity fallbacks"
  );
  faviconFallbackList.remove();

  const duplicateGroups = fromDuplicateGroups([{
    key: "https://example.com/research/article?edition=complete",
    keep: {
      id: 71, windowId: 4, index: 1,
      url: "https://example.com/research/article?edition=complete",
      title: "Current research article"
    },
    close: [{
      id: 72, windowId: 8, index: 6,
      url: "https://example.com/research/article?edition=complete",
      title: "Earlier page title"
    }],
    tabs: [{
      id: 71, windowId: 4, index: 1,
      url: "https://example.com/research/article?edition=complete",
      title: "Current research article"
    }, {
      id: 72, windowId: 8, index: 6,
      url: "https://example.com/research/article?edition=complete",
      title: "Earlier page title"
    }]
  }]);
  const duplicateList = createTabList({
    section: "duplicates",
    foldable: true,
    groups: duplicateGroups,
    groupBanner: duplicateIdentityBanner,
    rowMeta: (_ref, group, index) => {
      const tab = group.live[index];
      return `tab ${(tab.index ?? 0) + 1} · ${tab.id === group.data.keepId ? "kept copy" : "extra"}`;
    },
    rowBadges: (ctx) => {
      const badges = [];
      if (ctx.live.id === ctx.group.data.keepId) {
        const keep = document.createElement("span");
        keep.className = "dup-role";
        keep.textContent = "Keep";
        badges.push(keep);
      }
      const window = document.createElement("span");
      window.className = "dup-window";
      window.textContent = ctx.live.windowId === 4 ? "Window 1" : "Window 2";
      return [...badges, window];
    },
    groupActions: [{ id: "close-extras", label: "Close extras", danger: true, run: () => {} }]
  });
  duplicateList.style.width = "320px";
  document.body.append(duplicateList);
  const duplicateCard = duplicateList.querySelector("[data-tablist-card]");
  const duplicateHeader = duplicateCard.querySelector(".item-title");
  const duplicateIdentity = duplicateCard.querySelector(".dup-identity");
  const duplicateAddress = duplicateCard.querySelector(".dup-identity-url");
  const duplicateNote = duplicateCard.querySelector(".dup-title-note");
  const duplicateRows = [...duplicateCard.querySelectorAll(".trow")];
  const duplicateAction = duplicateCard.querySelector('[data-action-id="close-extras"]');
  check(
    duplicateHeader?.textContent === "Current research article" &&
      duplicateIdentity?.querySelector(".dup-identity-label")?.textContent === "Same address" &&
      duplicateAddress?.textContent === "https://example.com/research/article?edition=complete" &&
      getComputedStyle(duplicateAddress).textOverflow === "ellipsis" &&
      duplicateNote?.textContent.includes("older title") &&
      duplicateRows.map((row) => row.querySelector(".t a")?.textContent).join("|") ===
        "Current research article|Earlier page title" &&
      duplicateRows[0].querySelector(".dup-role")?.textContent === "Keep" &&
      duplicateRows[0].querySelector(".dup-window")?.textContent === "Window 1" &&
      duplicateRows[1].querySelector(".dup-window")?.textContent === "Window 2" &&
      duplicateAction?.getBoundingClientRect().width >= 28 &&
      duplicateCard.scrollWidth <= duplicateCard.clientWidth + 1,
    "canonical Duplicates identity keeps differing Chrome titles, context, and actions legible at 320px"
  );
  duplicateList.remove();

  const navFrame = document.createElement("iframe");
  navFrame.style.cssText = "position:fixed;left:-1600px;top:0;width:1440px;height:720px;visibility:hidden";
  navFrame.src = "../../tools/shell-harness.html";
  document.body.append(navFrame);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Navigation harness timed out")), 5_000);
    navFrame.addEventListener("load", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
  const navDoc = navFrame.contentDocument;
  const navRoot = navDoc.documentElement;
  const navMain = navDoc.querySelector(".content");
  const navButton = navDoc.querySelector(".nav-collapse");
  navDoc.body.classList.add("gradient");

  const checkNavReveal = async (expectedMode) => {
    navButton.click();
    await frame();
    const backdrop = navDoc.querySelector(".nav-resize-backdrop");
    const activeMainTransforms = navMain.getAnimations({ subtree: false })
      .filter((animation) => animation.playState === "running");
    const backdropZ = Number.parseFloat(navFrame.contentWindow.getComputedStyle(backdrop).zIndex);
    const contentZ = Number.parseFloat(navFrame.contentWindow.getComputedStyle(navMain).zIndex);
    check(activeMainTransforms.length === 0,
      `collapsing to ${expectedMode} keeps the fully painted content plane stationary`,
      String(activeMainTransforms.length));
    check(backdropZ > contentZ,
      `collapsing to ${expectedMode} reveals the final page behind the moving navigation edge`,
      JSON.stringify({ backdropZ, contentZ }));
    await wait(260);
    check(navRoot.dataset.nav === expectedMode &&
        !navRoot.classList.contains("nav-morphing") &&
        !navDoc.querySelector(".nav-resize-backdrop"),
      `collapsing to ${expectedMode} leaves no temporary paint layer behind`);
  };
  await checkNavReveal("rail");
  await checkNavReveal("expanded");
  navFrame.remove();

  const sidePanelFrame = document.createElement("iframe");
  sidePanelFrame.style.cssText =
    "position:fixed;left:-1600px;top:0;width:320px;height:720px;visibility:hidden";
  sidePanelFrame.src = "../../tools/sidepanel-harness.html?focus=0&width=320";
  document.body.append(sidePanelFrame);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Side-panel harness timed out")), 5_000);
    sidePanelFrame.addEventListener("load", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
  await frame();
  await frame();
  const openFilterLayout = JSON.parse(
    sidePanelFrame.contentDocument.querySelector("#open-filter-layout-result")?.textContent ?? "{}"
  );
  check(openFilterLayout.pass === true,
    "the side-panel Open filter occupies the measured local row below its section heading",
    JSON.stringify(openFilterLayout));
  sidePanelFrame.remove();

  const runwayFixture = document.createElement("div");
  runwayFixture.className = "sections";
  document.body.append(runwayFixture);
  const runwayPadding = Number.parseFloat(getComputedStyle(runwayFixture).paddingBottom);
  check(runwayPadding <= 64,
    "a short Dashboard section ends near its final row instead of reserving an empty viewport",
    String(runwayPadding));
  runwayFixture.remove();

  const dragLayout = document.createElement("div");
  dragLayout.dataset.tablist = "open";
  dragLayout.style.cssText = "position:fixed;left:24px;top:260px;width:360px";
  const dragCardA = document.createElement("div");
  dragCardA.style.height = "48px";
  const dragZone = document.createElement("div");
  dragZone.className = "drop-zone-new";
  dragZone.textContent = "Drag here to move to a new window";
  const dragCardB = document.createElement("div");
  dragCardB.style.height = "48px";
  dragLayout.append(dragCardA, dragZone, dragCardB);
  document.body.append(dragLayout);
  const dragNextTop = dragCardB.getBoundingClientRect().top;
  document.body.classList.add("tab-dragging");
  await frame();
  check(Math.abs(dragCardB.getBoundingClientRect().top - dragNextTop) <= 0.5,
    "revealing the new-window drag target does not move the Open ledger",
    JSON.stringify({ before: dragNextTop, after: dragCardB.getBoundingClientRect().top }));
  document.body.classList.remove("tab-dragging");
  dragLayout.remove();

  const makeDragZone = (className, copy = "") => {
    const zone = document.createElement("div");
    zone.className = className;
    zone.textContent = copy;
    return zone;
  };
  const dragLedger = createTabList({
    section: "open",
    groups: [1, 2].map((id) => ({
      id: `drag-window-${id}`, title: `Window ${id}`, meta: "1 tab", data: { id },
      refs: [{ title: `Tab ${id}`, url: `https://drag-${id}.test/` }],
      live: [{ tabId: id }]
    })),
    groupEndZone: () => makeDragZone("drop-zone-window-end"),
    betweenZone: () => makeDragZone("drop-zone-new", "Drag here to move to a new window")
  });
  dragLedger.style.cssText = "position:fixed;left:410px;top:220px;width:420px";
  document.body.append(dragLedger);
  const dragItems = [...dragLedger.querySelectorAll(":scope > .item")];
  const dragSecondTop = dragItems[1].getBoundingClientRect().top;
  const dragEndZones = [...dragLedger.querySelectorAll(".drop-zone-window-end")];
  const dragNewZones = [...dragLedger.querySelectorAll(".drop-zone-new")];
  dragEndZones.forEach((zone) => { zone.style.display = "flex"; });
  await frame();
  const endOnlyShift = dragItems[1].getBoundingClientRect().top - dragSecondTop;
  dragEndZones.forEach((zone) => { zone.style.display = "none"; });
  dragNewZones.forEach((zone) => { zone.style.display = "block"; });
  await frame();
  const newOnlyShift = dragItems[1].getBoundingClientRect().top - dragSecondTop;
  dragNewZones.forEach((zone) => { zone.style.display = ""; });
  dragEndZones.forEach((zone) => { zone.style.display = ""; });
  document.body.classList.add("tab-dragging");
  await frame();
  check(Math.abs(dragItems[1].getBoundingClientRect().top - dragSecondTop) <= 0.5,
    "revealing every real Open drag destination leaves later windows stationary",
    JSON.stringify({ before: dragSecondTop, after: dragItems[1].getBoundingClientRect().top,
      endOnlyShift, newOnlyShift }));
  const newWindowRect = dragNewZones[0].getBoundingClientRect();
  const firstWindowBottom = dragItems[0].getBoundingClientRect().bottom;
  const secondWindowTop = dragItems[1].getBoundingClientRect().top;
  check(newWindowRect.height >= 30 &&
      newWindowRect.top >= firstWindowBottom - 1 &&
      newWindowRect.bottom <= secondWindowTop &&
      getComputedStyle(dragNewZones[0]).backgroundColor !== "rgba(0, 0, 0, 0)",
    "the stationary new-window destination retains its full, legible landing surface",
    JSON.stringify({ target: { top: newWindowRect.top, height: newWindowRect.height },
      boundaries: { firstWindowBottom, secondWindowTop },
      background: getComputedStyle(dragNewZones[0]).backgroundColor }));
  document.body.classList.remove("tab-dragging");
  dragLedger.remove();

  const themeSheet = document.createElement("div");
  themeSheet.className = "theme-pop";
  themeSheet.textContent = "Scheme catalogue";
  themeSheet.style.backgroundColor = "rgb(20, 20, 20)";
  document.body.append(themeSheet);
  document.documentElement.dataset.schemeTransition = "true";
  check(getComputedStyle(themeSheet).viewTransitionName !== "none",
    "an open scheme sheet owns a stationary view-transition layer",
    getComputedStyle(themeSheet).viewTransitionName);
  if (typeof document.startViewTransition === "function") {
    const pickerTransition = document.startViewTransition(() => {
      themeSheet.style.backgroundColor = "rgb(235, 235, 235)";
    });
    await pickerTransition.ready;
    await wait(70);
    const pickerOld = getComputedStyle(document.documentElement,
      "::view-transition-old(everytab-theme-picker)");
    const pickerNew = getComputedStyle(document.documentElement,
      "::view-transition-new(everytab-theme-picker)");
    check(Number.parseFloat(pickerOld.opacity) === 0 && Number.parseFloat(pickerNew.opacity) === 1,
      "the picker snapshot remains fully opaque while the page crossfades behind it",
      JSON.stringify({ oldOpacity: pickerOld.opacity, newOpacity: pickerNew.opacity,
        oldAnimation: pickerOld.animationName, newAnimation: pickerNew.animationName }));
    pickerTransition.skipTransition();
    await pickerTransition.finished.catch(() => {});
  }
  delete document.documentElement.dataset.schemeTransition;
  themeSheet.remove();

  let openedMembership = "";
  const membershipList = createTabList({
    section: "session-membership-fixture",
    groups: [{ id: "w1", title: "Window 1", chips: [], refs: [{
      url: "https://example.com", title: "Example", sessionMemberships: [
        { id: "s2", name: "Daily" }, { id: "s1", name: "Research" }
      ]
    }] }],
    onSessionOpen: (id) => { openedMembership = id; }
  });
  document.body.append(membershipList);
  const membershipCopy = membershipList.querySelector(".session-memberships");
  const researchLink = [...membershipList.querySelectorAll(".session-membership-link")]
    .find((button) => button.textContent === "Research");
  researchLink.click();
  check(membershipCopy?.textContent === "In Sessions:Daily, Research" &&
    membershipCopy.closest(".row-subline") &&
    !membershipCopy.closest(".row-chip-slot") &&
    membershipCopy.getBoundingClientRect().width > 0 && openedMembership === "s1",
  "Session membership uses linked row context beside This tab and routes by stable Session id");
  membershipList.remove();

  // Measure the actual system font's ink, not just textContent or line boxes:
  // the reported lowercase j lost its tail at the link's clipping edge.
  const membershipStyle = document.documentElement.dataset.interfaceStyle;
  const textContext = document.createElement("canvas").getContext("2d");
  try {
    for (const style of ["soft", "crisp", "terminal"]) {
      document.documentElement.dataset.interfaceStyle = style;
      for (const presentation of ["default", "compact"]) {
        const names = ["job search", "gypq", "Égyptologie", "job search ".repeat(30)];
        const glyphList = createTabList({
          section: `membership-glyph-${style}-${presentation}`,
          presentation,
          groups: [{ id: "glyphs", title: "Window", refs: names.map((name, index) => ({
            title: "Example", url: `https://example.com/${index}`,
            sessionMemberships: [{ id: `session-${index}`, name }]
          })) }],
          onSessionOpen: () => {}
        });
        document.body.append(glyphList);
        try {
          const links = [...glyphList.querySelectorAll(".session-membership-link")];
          for (const link of links.slice(0, 3)) {
            const computed = getComputedStyle(link);
            textContext.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
            const metrics = textContext.measureText(link.textContent);
            const marker = document.createElement("span");
            marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
            link.prepend(marker);
            const { left: origin, top: baseline } = marker.getBoundingClientRect();
            marker.remove();
            const ink = {
              left: origin - metrics.actualBoundingBoxLeft,
              right: origin + metrics.actualBoundingBoxRight,
              top: baseline - metrics.actualBoundingBoxAscent,
              bottom: baseline + metrics.actualBoundingBoxDescent
            };
            for (const clippingNode of [link, link.closest(".session-memberships")]) {
              const box = clippingNode.getBoundingClientRect();
              check(ink.left >= box.left - 0.5 && ink.right <= box.right + 0.5 &&
                ink.top >= box.top - 0.5 && ink.bottom <= box.bottom + 0.5,
              `${style}/${presentation}: ${link.textContent} ink fits ${clippingNode.className}`,
              JSON.stringify({ ink, box: box.toJSON() }));
            }
          }
          const longLink = links.at(-1);
          check(longLink.scrollWidth > longLink.clientWidth &&
            getComputedStyle(longLink).textOverflow === "ellipsis",
          `${style}/${presentation}: long Session names still truncate`);
          if (presentation === "default") {
            check([...glyphList.querySelectorAll(".trow")].every((row) =>
              Math.abs(row.getBoundingClientRect().height - 40) < 0.5),
            `${style}: Session text clearance preserves 40px rows`);
          }
        } finally {
          glyphList.remove();
        }
      }
    }
  } finally {
    if (membershipStyle === undefined) delete document.documentElement.dataset.interfaceStyle;
    else document.documentElement.dataset.interfaceStyle = membershipStyle;
  }

  const labelIndexHost = document.createElement("div");
  labelIndexHost.style.cssText = "position:fixed;left:24px;top:90px;width:300px;z-index:80";
  document.body.append(labelIndexHost);
  const labelInterfaceStyle = document.documentElement.dataset.interfaceStyle;
  document.documentElement.dataset.interfaceStyle = "soft";
  const labelItems = [
    { key: "Work", text: "Work", count: 8 },
    { key: "Urgent", text: "Urgent", count: 4 },
    { key: "Home", text: "Home", count: 3 }
  ];
  let labelSelection = ["Work"];
  let labelJump = null;
  const renderLabelIndex = () => {
    const index = createIndexBar({
      placeholder: "Filter by labels…",
      filterAria: "Select labels to show tabs that have all of them",
      items: labelItems,
      onJump: (key) => { labelJump = key; },
      chipLabel: "Jump to:",
      facetSelection: {
        selectedKeys: labelSelection,
        onChange: async (next) => {
          labelSelection = next;
          renderLabelIndex();
          requestAnimationFrame(() => labelIndexHost.querySelector(".label-filter")?.focus());
        }
      }
    });
    labelIndexHost.replaceChildren(index);
  };
  const openLabelChoices = async () => {
    const input = labelIndexHost.querySelector(".label-filter");
    const focusOrigin = document.createElement("button");
    focusOrigin.type = "button";
    focusOrigin.textContent = "Label fixture focus origin";
    labelIndexHost.before(focusOrigin);
    focusOrigin.focus();
    input.focus();
    input.click();
    await frame();
    await frame();
    focusOrigin.remove();
    const id = input.getAttribute("aria-controls");
    if (!id) throw new Error(`Label choices did not open: ${JSON.stringify({
      active: document.activeElement?.className,
      expanded: input.getAttribute("aria-expanded"),
      menus: [...document.querySelectorAll(".label-facet-suggestions")].map((menu) => ({
        id: menu.id, hidden: menu.hidden, open: menu.matches(":popover-open"),
        parent: menu.parentElement?.tagName, text: menu.textContent
      }))
    })}`);
    return document.getElementById(id);
  };
  renderLabelIndex();
  let labelChoices = await openLabelChoices();
  const labelFacetField = labelIndexHost.querySelector(".label-facet-field");
  const labelFacetInput = labelIndexHost.querySelector(".label-filter");
  const labelFacetRect = labelFacetField.getBoundingClientRect();
  const labelChoicesRect = labelChoices.getBoundingClientRect();
  const labelFacetStyle = getComputedStyle(labelFacetField);
  check(labelFacetInput.placeholder === "Filter by labels…" &&
      labelFacetStyle.boxShadow.includes("inset") &&
      labelChoicesRect.top - labelFacetRect.bottom >= 7,
    "the Label facet describes filtering and keeps its complete focus contour clear of choices",
    JSON.stringify({ placeholder: labelFacetInput.placeholder,
      boxShadow: labelFacetStyle.boxShadow,
      fieldBottom: labelFacetRect.bottom, choicesTop: labelChoicesRect.top }));
  const workChoice = [...labelChoices.querySelectorAll(".label-facet-option")]
    .find((option) => option.textContent.includes("Work"));
  check(Boolean(workChoice) && labelChoices.parentElement === document.body &&
      (labelChoices.matches(":popover-open") || labelChoices.dataset.open === "true") &&
      workChoice.getAttribute("aria-selected") === "true" &&
      workChoice.classList.contains("is-selected") &&
      getComputedStyle(workChoice).backgroundColor !== "rgba(0, 0, 0, 0)" &&
      workChoice.querySelector(".label-facet-option-check")?.textContent === "✓",
    "Labels choices stay above sticky overflow and visibly mark active filters",
    JSON.stringify({
      parent: labelChoices.parentElement?.tagName,
      open: labelChoices.matches(":popover-open"),
      fallbackOpen: labelChoices.dataset.open,
      hidden: labelChoices.hidden,
      menuText: labelChoices.textContent,
      optionCount: labelChoices.querySelectorAll(".label-facet-option").length,
      ariaSelected: workChoice?.getAttribute("aria-selected"),
      classes: workChoice?.className,
      background: workChoice ? getComputedStyle(workChoice).backgroundColor : null,
      check: workChoice?.querySelector(".label-facet-option-check")?.textContent
    }));
  const urgentChoice = [...labelChoices.querySelectorAll(".label-facet-option")]
    .find((option) => option.textContent.includes("Urgent"));
  urgentChoice.click();
  await frame();
  await frame();
  labelChoices = await openLabelChoices();
  check(labelSelection.join("|") === "Work|Urgent" &&
      labelChoices.querySelectorAll('.label-facet-option[aria-selected="true"]').length === 2,
    "clicking a choice toggles an additive Label filter and keeps its checked state visible");
  labelChoices.scrollTop = 10;
  labelChoices.dispatchEvent(new Event("scroll", { bubbles: true }));
  await frame();
  check(labelChoices.matches(":popover-open") || labelChoices.dataset.open === "true",
    "scrolling inside the Label choices does not dismiss the top-layer menu");
  const homeJump = [...labelIndexHost.querySelectorAll(".label-chip")]
    .find((button) => button.textContent.includes("Home"));
  homeJump.click();
  check(labelJump === "Home" && labelSelection.join("|") === "Work|Urgent" &&
      labelIndexHost.querySelector(".label-chip-line-label")?.textContent === "Jump to:",
    "the explicitly labelled lower shortcuts only navigate and never change Label filters");
  labelIndexHost.remove();
  labelChoices.remove();
  document.documentElement.dataset.interfaceStyle = labelInterfaceStyle;

  /* One focus vocabulary for every typed filter and Settings field. The
   * installed defects appeared on the plain Sessions filter and on controls
   * generated by Settings, while the Label facet happened to own a separate
   * focus implementation. Keep a mounted contract for all three paths. */
  const fieldFixture = document.createElement("div");
  fieldFixture.style.cssText =
    "position:fixed;left:920px;top:70px;width:420px;z-index:95;--hero-h:0px;--section-lead-h:40px";
  const sessionIndex = createIndexBar({
    placeholder: "Filter Sessions…",
    filterAria: "Filter Sessions",
    items: [{ key: "daily", text: "Daily", count: 2 }],
    onFilter: () => {},
    onJump: () => {}
  });
  const settingsToolbar = document.createElement("div");
  settingsToolbar.className = "settings-toolbar section-local-sticky";
  const settingsFilter = document.createElement("input");
  settingsFilter.type = "search";
  settingsFilter.className = "settings-filter";
  const settingsText = document.createElement("input");
  settingsText.type = "text";
  const settingsNumber = document.createElement("input");
  settingsNumber.type = "number";
  const settingsSelect = document.createElement("select");
  settingsSelect.append(new Option("One hour", "60"));
  const settingsTextarea = document.createElement("textarea");
  const settingsRow = document.createElement("div");
  settingsRow.className = "setrow";
  settingsRow.append(settingsText, settingsNumber, settingsSelect, settingsTextarea);
  settingsToolbar.append(settingsFilter, settingsRow);
  fieldFixture.append(sessionIndex, settingsToolbar);
  document.body.append(fieldFixture);
  const sessionFilter = sessionIndex.querySelector(".label-filter");
  const focusStyles = [];
  for (const control of [sessionFilter, settingsFilter, settingsText, settingsNumber,
    settingsSelect, settingsTextarea]) {
    control.focus();
    await frame();
    const style = getComputedStyle(control);
    focusStyles.push({
      active: document.activeElement === control,
      matchesFocus: control.matches(":focus"),
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
      border: style.borderColor,
      shadow: style.boxShadow
    });
  }
  const referenceFocus = focusStyles[0];
  const toolbarPaddingTop = Number.parseFloat(getComputedStyle(settingsToolbar).paddingTop);
  check(focusStyles.every((style) => style.outline.startsWith("none") &&
      style.border === referenceFocus.border && style.shadow === referenceFocus.shadow) &&
      referenceFocus.shadow.includes("inset") && toolbarPaddingTop >= 4,
    "Session filters and Settings fields share one unclipped focus boundary",
    JSON.stringify({ focusStyles, toolbarPaddingTop }));
  fieldFixture.remove();

  const railFixture = document.createElement("div");
  railFixture.className = "app";
  const railSidebar = document.createElement("aside");
  railSidebar.className = "sidebar";
  const railBackdrop = document.createElement("div");
  railBackdrop.className = "nav-resize-backdrop";
  const railPageMaterial = document.createElement("div");
  railPageMaterial.style.background = "var(--bg-solid)";
  railFixture.append(railBackdrop, railSidebar, railPageMaterial);
  document.body.append(railFixture);
  document.documentElement.dataset.nav = "rail";
  const expectedRailMaterial = getComputedStyle(railPageMaterial).backgroundColor;
  check(getComputedStyle(railSidebar).backgroundColor === expectedRailMaterial &&
      getComputedStyle(railBackdrop).backgroundColor === expectedRailMaterial,
    "the collapsed navigation and its resize layer use the continuous page material",
    JSON.stringify({ expected: expectedRailMaterial,
      sidebar: getComputedStyle(railSidebar).backgroundColor,
      backdrop: getComputedStyle(railBackdrop).backgroundColor }));
  document.body.classList.add("gradient");
  railPageMaterial.style.background = "var(--bg-grad, var(--bg-solid))";
  const expectedRailGradient = getComputedStyle(railPageMaterial).backgroundImage;
  check(expectedRailGradient !== "none" &&
      getComputedStyle(railSidebar).backgroundImage === expectedRailGradient &&
      getComputedStyle(railBackdrop).backgroundImage === expectedRailGradient,
    "the collapsed navigation stays continuous when the scheme gradient is enabled",
    JSON.stringify({ expected: expectedRailGradient,
      sidebar: getComputedStyle(railSidebar).backgroundImage,
      backdrop: getComputedStyle(railBackdrop).backgroundImage }));
  document.body.classList.remove("gradient");
  delete document.documentElement.dataset.nav;
  railFixture.remove();

  const paletteSlot = document.createElement("div");
  const paletteTrigger = document.createElement("button");
  paletteTrigger.type = "button";
  paletteTrigger.textContent = "Label selected tabs";
  paletteTrigger.style.cssText = "position:fixed;left:520px;top:18px;z-index:90";
  document.body.prepend(paletteSlot, paletteTrigger);
  const palette = createAnchoredPanel(paletteSlot);
  palette.anchor(paletteTrigger);
  paletteTrigger.focus();
  palette.toggle(() => {
    const body = document.createElement("div");
    body.textContent = "Bulk label fixture";
    return body;
  }, "bulk-label");
  await frame();
  const bulkLabelPopover = document.querySelector('.action-popover[data-kind="bulk-label"]');
  const bulkLabelHeading = bulkLabelPopover?.querySelector(".action-popover-heading");
  const headingRect = bulkLabelHeading?.getBoundingClientRect();
  check(bulkLabelPopover?.querySelector('.action-popover-icon') && headingRect?.width >= 220,
    "the bulk-label palette keeps a normal-width titled header",
    JSON.stringify({ icon: Boolean(bulkLabelPopover?.querySelector('.action-popover-icon')),
      headingWidth: headingRect?.width ?? null,
      copy: bulkLabelHeading?.textContent ?? null }));
  palette.close();
  paletteTrigger.remove();
  paletteSlot.remove();

  const snoozeSlot = document.createElement("div");
  const snoozeTrigger = document.createElement("button");
  snoozeTrigger.type = "button";
  snoozeTrigger.textContent = "Snooze fixture";
  snoozeTrigger.style.cssText = "position:fixed;left:520px;top:220px;z-index:90";
  document.body.prepend(snoozeSlot, snoozeTrigger);
  const snoozePalette = createAnchoredPanel(snoozeSlot);
  let snoozeCommits = 0;
  let finishSnooze;
  const snoozePending = new Promise((resolve) => { finishSnooze = resolve; });
  snoozePalette.anchor(snoozeTrigger);
  snoozeTrigger.focus();
  snoozePalette.toggle(() => buildSnoozePanel(async () => {
    snoozeCommits += 1;
    await snoozePending;
  }), "snooze");
  await frame();
  const snoozePopover = document.querySelector('.action-popover[data-kind="snooze"]');
  const snoozeChoices = [...(snoozePopover?.querySelectorAll(".palette-choice-grid button") ?? [])];
  const firstSnoozeChoice = snoozeChoices[0];
  const snoozeArrowPath = [];
  firstSnoozeChoice?.focus();
  firstSnoozeChoice?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowDown", bubbles: true, cancelable: true
  }));
  snoozeArrowPath.push(snoozeChoices.indexOf(document.activeElement));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowRight", bubbles: true, cancelable: true
  }));
  snoozeArrowPath.push(snoozeChoices.indexOf(document.activeElement));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowUp", bubbles: true, cancelable: true
  }));
  snoozeArrowPath.push(snoozeChoices.indexOf(document.activeElement));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowLeft", bubbles: true, cancelable: true
  }));
  snoozeArrowPath.push(snoozeChoices.indexOf(document.activeElement));
  firstSnoozeChoice?.click();
  firstSnoozeChoice?.click();
  await frame();
  check(snoozeCommits === 1 && !snoozePopover?.isConnected,
    "one Snooze choice dismisses immediately and can commit only once",
    JSON.stringify({ commits: snoozeCommits, connected: snoozePopover?.isConnected ?? null }));
  finishSnooze();
  await Promise.resolve();
  snoozePalette.close();
  snoozeTrigger.remove();
  snoozeSlot.remove();

  const bottomPaletteSlot = document.createElement("div");
  const bottomPaletteTrigger = document.createElement("button");
  bottomPaletteTrigger.type = "button";
  bottomPaletteTrigger.textContent = "Session near the viewport edge";
  bottomPaletteTrigger.style.cssText =
    "position:fixed;left:520px;bottom:12px;z-index:90";
  document.body.prepend(bottomPaletteSlot, bottomPaletteTrigger);
  const bottomPalette = createAnchoredPanel(bottomPaletteSlot);
  let growingPaletteBody;
  bottomPalette.anchor(bottomPaletteTrigger);
  bottomPaletteTrigger.focus();
  bottomPalette.toggle(() => {
    growingPaletteBody = document.createElement("div");
    growingPaletteBody.textContent = "Session picker";
    return growingPaletteBody;
  }, "session");
  await frame();
  const lateOptions = document.createElement("div");
  lateOptions.style.height = "520px";
  lateOptions.textContent = "Late-loaded Session choices";
  growingPaletteBody.append(lateOptions);
  await frame();
  await frame();
  const bottomPalettePopover = document.querySelector('.action-popover[data-kind="session"]');
  const bottomPaletteRect = bottomPalettePopover?.getBoundingClientRect();
  check(bottomPaletteRect && bottomPaletteRect.top >= 9 &&
    bottomPaletteRect.bottom <= innerHeight - 9,
  "a row picker that grows after opening remains completely inside the viewport",
  JSON.stringify({ top: bottomPaletteRect?.top ?? null,
    bottom: bottomPaletteRect?.bottom ?? null, viewport: innerHeight }));
  const stablePaletteTop = bottomPaletteRect?.top;
  const stablePaletteLeft = bottomPaletteRect?.left;
  lateOptions.remove();
  await frame();
  await frame();
  const filteredPaletteRect = bottomPalettePopover?.getBoundingClientRect();
  check(filteredPaletteRect && Math.abs(filteredPaletteRect.top - stablePaletteTop) <= 1 &&
    Math.abs(filteredPaletteRect.left - stablePaletteLeft) <= 1,
  "filtering a populated row picker does not make its anchored surface jump",
  JSON.stringify({ before: { top: stablePaletteTop, left: stablePaletteLeft },
    after: { top: filteredPaletteRect?.top ?? null, left: filteredPaletteRect?.left ?? null } }));
  window.dispatchEvent(new Event("scroll"));
  await frame();
  check(bottomPalettePopover?.isConnected &&
    (bottomPalettePopover.matches(":popover-open") || bottomPalettePopover.dataset.open === "true"),
  "scrolling the page keeps an anchored row picker open and attached to its action");
  bottomPalette.close();
  bottomPaletteTrigger.remove();
  bottomPaletteSlot.remove();

  const appendTarget = document.createElement("div");
  appendTarget.className = "drop-zone-window-end";
  appendTarget.setAttribute("aria-label", "Move to end of Window 1");
  const newWindowTarget = document.createElement("div");
  newWindowTarget.className = "drop-zone-new";
  newWindowTarget.textContent = "Move to a new window";
  const dragPolishList = createTabList({
    section: "open",
    groups: [{
      id: "window-1", title: "Window 1", meta: "2 tabs", data: { id: 1 },
      refs: [
        { title: "First", url: "https://first.test/" },
        { title: "Second", url: "https://second.test/" }
      ],
      live: [{ tabId: 1 }, { tabId: 2 }]
    }],
    groupEndZone: () => appendTarget,
    betweenZone: () => newWindowTarget,
    rowCap: 1
  });
  document.body.append(dragPolishList);
  document.body.classList.add("tab-dragging");
  const dragPreview = document.createElement("div");
  dragPreview.className = "tab-drag-preview";
  dragPreview.textContent = "2 tabs";
  document.body.append(dragPreview);
  await frame();
  const appendStyle = getComputedStyle(appendTarget);
  const appendLineStyle = getComputedStyle(appendTarget, "::before");
  const finalRenderedRow = [...dragPolishList.querySelectorAll(".trow")].at(-1);
  const rowBottom = finalRenderedRow.getBoundingClientRect().bottom;
  const appendRect = appendTarget.getBoundingClientRect();
  const previewRect = dragPreview.getBoundingClientRect();
  const terminalHit = document.elementFromPoint(
    appendTarget.getBoundingClientRect().left + 20, rowBottom - 4);
  check(appendStyle.display === "flex" &&
      appendTarget.nextElementSibling?.classList.contains("disclosure-row") &&
      Number.parseFloat(appendStyle.minHeight) <= 20 &&
      Number.parseFloat(appendLineStyle.height) >= 2,
    "Open drag reveals a compact terminal bar after the final row and before Show fewer",
    JSON.stringify({ display: appendStyle.display, minHeight: appendStyle.minHeight,
      lineHeight: appendLineStyle.height,
      next: appendTarget.nextElementSibling?.className ?? null }));
  check(appendStyle.position === "absolute" && appendLineStyle.position === "absolute" &&
      appendLineStyle.bottom === "0px" && Math.abs(appendRect.bottom - rowBottom) <= 1,
    "the non-load-bearing terminal target paints on the last row separator instead of below it",
    JSON.stringify({ position: appendStyle.position, linePosition: appendLineStyle.position,
      lineBottom: appendLineStyle.bottom, appendBottom: appendRect.bottom, rowBottom }));
  check(terminalHit === appendTarget || appendTarget.contains(terminalHit),
    "the final-position rail wins the pointer area before the new-window destination",
    JSON.stringify({ hit: terminalHit?.className ?? terminalHit?.tagName ?? null,
      append: appendTarget.getBoundingClientRect(), next: newWindowTarget.getBoundingClientRect() }));
  const dragNewWindowRect = newWindowTarget.getBoundingClientRect();
  const newWindowHit = document.elementFromPoint(
    dragNewWindowRect.left + 20, dragNewWindowRect.top + 4);
  check(newWindowHit === newWindowTarget || newWindowTarget.contains(newWindowHit),
    "the new-window destination remains reachable beyond the final-position rail",
    JSON.stringify({ hit: newWindowHit?.className ?? newWindowHit?.tagName ?? null,
      append: appendRect, next: dragNewWindowRect }));
  check(previewRect.width >= 55 && previewRect.height >= 30 &&
      getComputedStyle(dragPreview).borderStyle !== "none",
    "the selected-tab count has a compact themed native-drag surface",
    JSON.stringify({ width: previewRect.width, height: previewRect.height,
      border: getComputedStyle(dragPreview).border }));
  document.body.classList.remove("tab-dragging");

  const inboxEnds = [];
  const inboxGaps = [];
  const inboxDragList = createTabList({
    section: "inbox",
    groups: [1, 2].map((id) => ({
      id: `inbox-group-${id}`, title: `Inbox group ${id}`,
      refs: [{ title: `Saved tab ${id}`, url: `https://inbox-${id}.test/` }]
    })),
    groupEndZone: () => {
      const node = document.createElement("div");
      node.className = "drop-zone-window-end";
      inboxEnds.push(node);
      return node;
    },
    betweenZone: () => {
      const node = document.createElement("div");
      node.className = "drop-zone-new";
      node.textContent = "Start a new group";
      inboxGaps.push(node);
      return node;
    }
  });
  document.body.append(inboxDragList);
  document.body.classList.add("inbox-dragging");
  await frame();
  const inboxEndRect = inboxEnds[0].getBoundingClientRect();
  const inboxGapRect = inboxGaps[0].getBoundingClientRect();
  const inboxEndHit = document.elementFromPoint(
    inboxEndRect.left + 20, inboxEndRect.bottom - 4);
  const inboxGapHit = document.elementFromPoint(
    inboxGapRect.left + 20, inboxGapRect.top + 4);
  check((inboxEndHit === inboxEnds[0] || inboxEnds[0].contains(inboxEndHit)) &&
      (inboxGapHit === inboxGaps[0] || inboxGaps[0].contains(inboxGapHit)),
    "Inbox keeps both final-position and new-group destinations reachable",
    JSON.stringify({ hits: {
      end: inboxEndHit?.className ?? null, gap: inboxGapHit?.className ?? null
    }, end: inboxEndRect, gap: inboxGapRect }));
  document.body.classList.remove("inbox-dragging");
  inboxDragList.remove();

  const sessionEnds = [];
  const sessionGaps = [];
  const sessionDragList = createTabList({
    section: "sessions",
    groups: [{
      id: "saved-session", title: "Saved Session", data: { id: "saved-session" },
      windows: [
        { meta: "Window 1", refs: [{ title: "A", url: "https://a.test/" }] },
        { meta: "Window 2", refs: [{ title: "B", url: "https://b.test/" }] }
      ]
    }],
    windowEndZone: () => {
      const node = document.createElement("div");
      node.className = "drop-zone-window-end";
      sessionEnds.push(node);
      return node;
    },
    windowGap: () => {
      const node = document.createElement("div");
      node.className = "drop-zone-new";
      node.textContent = "Start a new window";
      sessionGaps.push(node);
      return node;
    }
  });
  document.body.append(sessionDragList);
  sessionDragList.querySelector(".item")?.classList.add("drag-home");
  document.body.classList.add("session-dragging");
  await frame();
  const sessionEndRect = sessionEnds[0].getBoundingClientRect();
  const sessionGapRect = sessionGaps[0].getBoundingClientRect();
  const sessionEndHit = document.elementFromPoint(
    sessionEndRect.left + 20, sessionEndRect.bottom - 4);
  const sessionGapHit = document.elementFromPoint(
    sessionGapRect.left + 20, sessionGapRect.top + 4);
  check(getComputedStyle(sessionEnds[0]).display === "flex" &&
      getComputedStyle(sessionGaps[0]).display === "block" &&
      sessionEndRect.bottom <= sessionGapRect.top + 1 &&
      (sessionEndHit === sessionEnds[0] || sessionEnds[0].contains(sessionEndHit)) &&
      (sessionGapHit === sessionGaps[0] || sessionGaps[0].contains(sessionGapHit)),
    "Session drag separates append-to-window and start-new-window destinations",
    JSON.stringify({ end: { top: sessionEndRect.top, bottom: sessionEndRect.bottom },
      gap: { top: sessionGapRect.top, bottom: sessionGapRect.bottom },
      hits: { end: sessionEndHit?.className ?? null, gap: sessionGapHit?.className ?? null } }));
  document.body.classList.remove("session-dragging");
  sessionDragList.remove();

  const restoredSessionWindows = [];
  const sessionWindowRestoreList = createTabList({
    section: "session-window-restore",
    groups: [{
      id: "two-window-session", title: "Two-window Session",
      windows: [
        { id: "two-window-session::0", meta: "Window 1", refs: [
          { title: "First saved tab", url: "https://restore-first.test/" }
        ] },
        { id: "two-window-session::1", meta: "Window 2", refs: [
          { title: "Second saved tab", url: "https://restore-second.test/" }
        ] }
      ],
      data: { id: "two-window-session" }
    }],
    windowActions: [{
      id: "restore-window", label: "Restore window", icon: "refresh", always: true,
      run: (context) => restoredSessionWindows.push(context.windowIndex)
    }]
  });
  document.body.append(sessionWindowRestoreList);
  const windowRestoreButtons = [
    ...sessionWindowRestoreList.querySelectorAll('[data-action-id="restore-window"]')
  ];
  windowRestoreButtons[1]?.click();
  check(windowRestoreButtons.length === 2 &&
      windowRestoreButtons.every((button) => button.getAttribute("aria-label") === "Restore window") &&
      JSON.stringify(restoredSessionWindows) === JSON.stringify([1]),
    "every saved window in a multi-window Session exposes its own Restore action",
    JSON.stringify({ buttons: windowRestoreButtons.length, restoredSessionWindows }));
  sessionWindowRestoreList.remove();

  dragPreview.remove();
  dragPolishList.remove();

  /* Source-bound regression for the actual popup CSS. The unsupported-page
   * branch sets `hidden` on the four tab actions; computed layout, not a source
   * string, decides whether those actions still consume popup height. */
  const popupSource = await fetch("../popup.html").then((response) => response.text());
  const popupStyle = popupSource.slice(
    popupSource.indexOf("<style>") + "<style>".length,
    popupSource.indexOf("</style>")
  );
  const popupFixture = document.createElement("div");
  const popupShadow = popupFixture.attachShadow({ mode: "open" });
  popupShadow.innerHTML = `<style>${popupStyle}</style>` +
    `<div class="actgrid tab-actions" hidden>` +
    `<button disabled>Save to Inbox</button><button disabled>Snooze</button>` +
    `<button disabled>Label</button><button disabled>Suspend</button></div>`;
  document.body.append(popupFixture);
  const unsupportedTabActions = popupShadow.querySelector(".tab-actions");
  check(getComputedStyle(unsupportedTabActions).display === "none" &&
    unsupportedTabActions.getClientRects().length === 0,
  "unsupported popup pages remove the unavailable tab-action grid from layout",
  JSON.stringify({ display: getComputedStyle(unsupportedTabActions).display,
    rects: unsupportedTabActions.getClientRects().length }));
  popupFixture.remove();

  const eventChannel = { addListener() {}, removeListener() {} };
  const activeTab = { id: 501, windowId: 71, title: "EveryTab", url: "https://everytab.test/" };
  const recentTabs = Array.from({ length: 6 }, (_, index) => ({
    id: 502 + index,
    windowId: 71,
    title: `Recent page ${index + 1}`,
    url: `https://recent-${index + 1}.test/`
  }));
  const searchDatabaseSuffix = crypto.randomUUID();
  const searchLibraryName = `everytab-dashboard-search-${searchDatabaseSuffix}`;
  const searchRecoveryName = `everytab-dashboard-recovery-${searchDatabaseSuffix}`;
  let searchWindowReadCount = 0;
  const { createStorageAuthorityRecord } = await import(
    "../js/lib/storage/authority-record.js"
  );
  const storedSearchFixture = {
    deviceId: "dashboard-search-fixture",
    storageAuthority: createStorageAuthorityRecord({
      runId: `dashboard-search-${searchDatabaseSuffix}`,
      databases: { library: searchLibraryName, recovery: searchRecoveryName }
    }),
    inbox: {
      "facet-inbox": {
        id: "facet-inbox", modifiedAt: 2, labels: [], tabs: [
          { title: "Facet roadmap", url: "https://facets.test/roadmap",
            labels: ["Work", "Urgent"] },
          { title: "Work notes", url: "https://facets.test/notes", labels: ["Work"] }
        ]
      }
    }
  };
  globalThis.chrome = {
    i18n: browserI18n,
    runtime: {
      sendMessage: async () => ({ ok: true }),
      getURL: (path = "") => `chrome-extension://fixture/${path}`
    },
    permissions: { contains: async () => false, onAdded: eventChannel, onRemoved: eventChannel },
    storage: { local: { get: async (keys) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => key in storedSearchFixture)
        .map((key) => [key, storedSearchFixture[key]]));
    } }, onChanged: eventChannel },
    tabs: { query: async () => [activeTab] },
    windows: { getAll: async () => {
      searchWindowReadCount += 1;
      if (searchWindowReadCount === 1) await wait(90);
      return [{ id: 71, type: "normal", tabs: [activeTab, ...recentTabs] }];
    } }
  };
  // This mounted fixture predates the current storage authority. Seed the same permanent
  // IndexedDB authority used by production so Search cannot accidentally pass
  // through a retired browser-map path.
  const { openLibraryStore } = await import("../js/lib/storage/library-store.js");
  const searchLibrary = openLibraryStore({
    databaseName: searchLibraryName,
    deviceId: storedSearchFixture.deviceId
  });
  try {
    await searchLibrary.transact([{
      type: "put",
      family: "inbox",
      id: "facet-inbox",
      value: storedSearchFixture.inbox["facet-inbox"]
    }]);
  } finally {
    await searchLibrary.close();
  }
  const { activeStorageAuthority } = await import(
    "../js/lib/storage/authority-runtime.js"
  );
  const seededSearchMaps = await (await activeStorageAuthority()).readMaps(["inbox"]);
  check(seededSearchMaps.inbox?.["facet-inbox"]?.tabs?.length === 2,
    "the mounted Search fixture reads its seed through the permanent storage authority");
  const { createSearchBox } = await import("../js/ui/searchbox.js");
  const preloadReadStart = searchWindowReadCount;
  const preloadedSearch = createSearchBox({ preloadEmptySuggestions: true });
  const preloadedInput = preloadedSearch.querySelector("input");
  const preloadedResults = preloadedSearch.querySelector(".search-results");
  document.querySelector("#search-keyboard-fixture").append(preloadedSearch);
  await frame();
  check(searchWindowReadCount > preloadReadStart &&
      document.activeElement !== preloadedInput && preloadedResults.childElementCount === 0,
    "Minimal can prepare empty Search suggestions before its first focus without opening them");
  await preloadedSearch.prepareEmptySuggestions();
  let initialSuggestionScrolls = 0;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    if (preloadedSearch.contains(this)) initialSuggestionScrolls += 1;
    return originalScrollIntoView?.apply(this, args);
  };
  preloadedInput.focus();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  const firstFocusedSuggestionMarkup = preloadedResults.innerHTML;
  check(preloadedSearch.querySelectorAll(".ghost-chip").length >= 2 &&
      Boolean(preloadedSearch.querySelector(".search-row")),
    "a preloaded first focus paints navigation and recent-tab suggestions together");
  check(initialSuggestionScrolls === 0,
    "opening preloaded Minimal suggestions does not scroll past their first lines",
    JSON.stringify({ initialSuggestionScrolls }));
  await wait(120);
  check(preloadedResults.innerHTML === firstFocusedSuggestionMarkup,
    "a preloaded first focus does not add a second suggestion stage afterward");
  preloadedInput.value = "Facet roadmap";
  preloadedInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  for (let attempt = 0;
    attempt < 100 && ![...preloadedSearch.querySelectorAll(".search-row .rtitle")]
      .some((node) => node.textContent.includes("Facet roadmap"));
    attempt += 1) {
    await wait(10);
  }
  check([...preloadedSearch.querySelectorAll(".search-row .rtitle")]
    .some((node) => node.textContent.includes("Facet roadmap")),
  "Search can settle on a matching saved result before the miss transition");
  preloadedInput.value = "Facet roadmap no longer matches anything";
  preloadedInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  for (let attempt = 0;
    attempt < 100 && (preloadedResults.hasAttribute("inert") ||
      ![...preloadedSearch.querySelectorAll(".search-row .rtitle")]
        .some((node) => node.textContent === "Facet roadmap no longer matches anything") ||
      ![...preloadedSearch.querySelectorAll(".search-row .rtype")]
        .some((node) => node.textContent.includes("Search web")));
    attempt += 1) {
    await wait(10);
  }
  check([...preloadedSearch.querySelectorAll(".search-row .rtype")]
      .some((node) => node.textContent.includes("Search web")) &&
      preloadedSearch.querySelectorAll(".search-row").length === 1,
    "a longer unmatched query replaces the last positive result with Search web",
    JSON.stringify({
      busy: preloadedResults.getAttribute("aria-busy"),
      inert: preloadedResults.hasAttribute("inert"),
      rows: [...preloadedSearch.querySelectorAll(".search-row")]
        .map((node) => node.textContent.trim())
    }));
  const priorSearchSurface = preloadedResults.innerHTML;
  preloadedInput.value = "no-local-result-unique";
  preloadedInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  check(preloadedResults.innerHTML === priorSearchSurface &&
      preloadedResults.hasAttribute("inert") &&
      preloadedResults.getAttribute("aria-busy") === "true",
    "typing keeps the prior Search surface mounted but inert until replacement rows are ready");
  for (let attempt = 0;
    attempt < 100 && (preloadedResults.hasAttribute("inert") ||
      ![...preloadedSearch.querySelectorAll(".search-row .rtitle")]
        .some((node) => node.textContent === "no-local-result-unique") ||
      ![...preloadedSearch.querySelectorAll(".search-row .rtype")]
        .some((node) => node.textContent.includes("Search web")));
    attempt += 1) {
    await wait(10);
  }
  check([...preloadedSearch.querySelectorAll(".search-row .rtype")]
    .some((node) => node.textContent.includes("Search web")) &&
      !preloadedResults.hasAttribute("inert") &&
      preloadedResults.getAttribute("aria-busy") !== "true",
    "an unscoped local miss settles to the default-browser Search action",
    JSON.stringify({
      busy: preloadedResults.getAttribute("aria-busy"),
      inert: preloadedResults.hasAttribute("inert"),
      rows: [...preloadedSearch.querySelectorAll(".search-row")]
        .map((node) => node.textContent.trim())
    }));
  preloadedSearch.dismissSearch({ blur: true });
  preloadedSearch.remove();
  let settleSlowCompletion;
  const slowCompletion = new Promise((resolve) => { settleSlowCompletion = resolve; });
  const failingCompletionSession = {
    invalidate() {},
    scopeNames: async () => [],
    labelCounts: async () => [],
    resolveFilters: async (query) => ({ scope: null, labels: [], query }),
    searchProgressively: async (query) => {
      if (query === "matching page") return {
          results: [{
            type: "inbox",
            title: "Matching page",
            url: "https://matching.test/"
          }],
          complete: null
        };
      if (query === "matching page slow") {
        return { results: [], complete: slowCompletion };
      }
      return { results: [], complete: Promise.resolve(null) };
    }
  };
  const completionFailureSearch = createSearchBox({
    searchSession: failingCompletionSession
  });
  const completionFailureInput = completionFailureSearch.querySelector("input");
  const completionFailureResults = completionFailureSearch.querySelector(".search-results");
  document.querySelector("#search-keyboard-fixture").append(completionFailureSearch);
  completionFailureInput.focus();
  completionFailureInput.value = "matching page";
  completionFailureInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(140);
  check([...completionFailureSearch.querySelectorAll(".search-row .rtitle")]
    .some((node) => node.textContent === "Matching page"),
  "Search paints a positive result before a completion failure");
  const missStartedAt = performance.now();
  completionFailureInput.value = "matching page slow";
  completionFailureInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  for (let attempt = 0;
    attempt < 24 && ![...completionFailureSearch.querySelectorAll(".search-row .rtype")]
      .some((node) => node.textContent.includes("Search web"));
    attempt += 1) {
    await wait(10);
  }
  const missElapsed = performance.now() - missStartedAt;
  check([...completionFailureSearch.querySelectorAll(".search-row .rtype")]
      .some((node) => node.textContent.includes("Search web")) &&
      !completionFailureResults.hasAttribute("inert") &&
      completionFailureResults.getAttribute("aria-busy") !== "true" &&
      missElapsed < 250,
    "a primary miss offers Search web without waiting for slow optional completion",
    JSON.stringify({
      elapsedMs: Math.round(missElapsed),
      busy: completionFailureResults.getAttribute("aria-busy"),
      inert: completionFailureResults.hasAttribute("inert"),
      rows: [...completionFailureSearch.querySelectorAll(".search-row")]
        .map((node) => node.textContent.trim())
    }));
  settleSlowCompletion([{
    type: "session",
    title: "Matching page slow saved",
    url: "https://matching.test/saved"
  }]);
  await wait(20);
  const enrichedRows = [...completionFailureSearch.querySelectorAll(".search-row")];
  check([...completionFailureSearch.querySelectorAll(".search-row .rtitle")]
      .some((node) => node.textContent === "Matching page slow saved") &&
      [...completionFailureSearch.querySelectorAll(".search-row .rtype")]
        .some((node) => node.textContent.includes("Search web")) &&
      new Set(enrichedRows.map((node) => node.id)).size === enrichedRows.length,
    "late complete results enrich the immediate Search web choice without removing it");
  completionFailureInput.value = "matching page failure";
  completionFailureInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(140);
  check([...completionFailureSearch.querySelectorAll(".search-row .rtype")]
      .some((node) => node.textContent.includes("Search web")) &&
      !completionFailureResults.hasAttribute("inert") &&
      completionFailureResults.getAttribute("aria-busy") !== "true",
    "a failed optional completion cannot leave the last positive Search result forever");
  completionFailureSearch.dismissSearch({ blur: true });
  completionFailureSearch.remove();
  const keywordContinuitySession = {
    invalidate() {},
    scopeNames: async () => [],
    labelCounts: async () => [],
    resolveFilters: async (query) => ({ scope: null, labels: [], query }),
    searchProgressively: async (query) => ({
      results: Array.from({ length: 4 }, (_, index) => ({
        type: "inbox",
        title: `${query} result ${index + 1}`,
        url: `https://keyword-continuity.test/${index + 1}`
      })),
      complete: null
    })
  };
  const keywordContinuitySearch = createSearchBox({
    searchSession: keywordContinuitySession
  });
  const keywordContinuityInput = keywordContinuitySearch.querySelector("input");
  const keywordContinuityResults = keywordContinuitySearch.querySelector(".search-results");
  document.querySelector("#search-keyboard-fixture").append(keywordContinuitySearch);
  keywordContinuityInput.focus();
  keywordContinuityInput.value = "seed";
  keywordContinuityInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(140);
  check(keywordContinuitySearch.querySelectorAll(".search-row").length === 4,
    "the keyword-continuity fixture begins with a complete result surface");
  const keywordPrefixFrames = [];
  for (const query of ["l", "la", "lab", "label", "d", "do", "domain", "i", "in"]) {
    keywordContinuityInput.value = query;
    keywordContinuityInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await frame();
    keywordPrefixFrames.push({
      query,
      rows: keywordContinuitySearch.querySelectorAll(".search-row").length,
      height: Math.round(keywordContinuityResults.getBoundingClientRect().height),
      busy: keywordContinuityResults.getAttribute("aria-busy")
    });
    await wait(110);
  }
  check(keywordPrefixFrames.every((sample) => sample.rows >= 4 && sample.height > 0),
    "keyword-prefix completion never collapses the visible Search findings between keystrokes",
    JSON.stringify(keywordPrefixFrames));
  keywordContinuitySearch.dismissSearch({ blur: true });
  keywordContinuitySearch.remove();
  const expansionSearch = createSearchBox();
  const expansionInput = expansionSearch.querySelector("input");
  const expansionResults = expansionSearch.querySelector(".search-results");
  const expansionBoundary = expansionSearch.querySelector(".search-connected-boundary");
  const expansionHost = document.createElement("div");
  expansionHost.className = "minimal-horizon";
  expansionHost.style.cssText = [
    "position:fixed", "left:-2000px", "bottom:0", "width:1440px", "height:720px",
    "display:flex", "align-items:flex-end", "justify-content:center", "padding:28px 18px 86px"
  ].join(";");
  const expansionDeck = document.createElement("section");
  expansionDeck.className = "minimal-deck";
  const expansionLauncher = document.createElement("div");
  expansionLauncher.className = "minimal-launcher";
  expansionLauncher.replaceChildren(...Array.from({ length: 5 }, (_, index) => {
    const item = document.createElement("div");
    item.className = "minimal-launch-item";
    item.innerHTML = `<button class="minimal-launch" type="button">Starred ${index + 1}</button>`;
    return item;
  }));
  const expansionFooter = document.createElement("div");
  expansionFooter.className = "links";
  expansionFooter.innerHTML = '<a href="#">Dashboard</a><button type="button">Settings</button><span class="minimal-focus-action-host"></span>';
  expansionDeck.append(expansionSearch, expansionLauncher, expansionFooter);
  expansionHost.append(expansionDeck);
  document.body.append(expansionHost);
  const expansionHydration = createIntrinsicBlockMotion(expansionDeck, {
    shouldAnimate: () => !expansionDeck.classList.contains("is-search-expanded")
  });
  const fitExpansionResults = () => {
    const field = expansionSearch.querySelector(".search-field");
    const fieldBox = field.getBoundingClientRect();
    const deckBox = expansionDeck.getBoundingClientRect();
    const available = minimalSearchResultsRoom({
      viewportHeight: document.documentElement.clientHeight,
      fieldBottom: fieldBox.bottom,
      deckHeight: deckBox.height,
      expanded: expansionDeck.classList.contains("is-search-expanded")
    });
    expansionSearch.style.setProperty("--search-results-max-h",
      `${Math.max(0, Math.floor(available))}px`);
  };
  const syncExpansion = () => {
    const expanded = expansionSearch.contains(document.activeElement);
    const applyExpansion = () => expansionDeck.classList.toggle("is-search-expanded", expanded);
    if (!(expanded && expansionHydration.handoff(applyExpansion))) applyExpansion();
    fitExpansionResults();
  };
  expansionSearch.addEventListener("focusin", syncExpansion);
  expansionSearch.addEventListener("focusout", () => requestAnimationFrame(syncExpansion));
  expansionDeck.addEventListener("transitionend", (event) => {
    if (event.target === expansionDeck && event.propertyName === "block-size") {
      fitExpansionResults();
    }
  });
  requestAnimationFrame(fitExpansionResults);
  await frame();
  await frame();
  const expansionFrame = () => {
    const deck = expansionDeck.getBoundingClientRect();
    const results = expansionResults.getBoundingClientRect();
    const boundary = expansionBoundary.getBoundingClientRect();
    return {
      top: deck.top,
      width: deck.width,
      height: deck.height,
      resultsHeight: results.height,
      boundaryGap: expansionResults.childElementCount
        ? Math.abs(boundary.bottom - results.bottom) : 0
    };
  };
  const sampleExpansion = async () => {
    const frames = [expansionFrame()];
    expansionInput.focus();
    frames.push(expansionFrame());
    for (let index = 0; index < 26; index += 1) {
      await frame();
      frames.push(expansionFrame());
    }
    return frames;
  };
  const expansionStats = (frames) => {
    const widthSteps = frames.slice(1).map((value, index) =>
      value.width - frames[index].width);
    const heightSteps = frames.slice(1).map((value, index) =>
      value.height - frames[index].height);
    const firstWidthMovement = widthSteps.findIndex((step) => Math.abs(step) > 0.5);
    const firstHeightMovement = heightSteps.findIndex((step) => Math.abs(step) > 0.5);
    const visibleResultsHeights = frames.slice(2)
      .map((value) => value.resultsHeight)
      .filter((height) => height > 0);
    const resultHeightChanges = visibleResultsHeights.slice(1)
      .filter((height, index) => Math.abs(height - visibleResultsHeights[index]) > 0.5).length;
    return {
      widthSteps,
      heightSteps,
      firstWidthMovement,
      firstHeightMovement,
      maxHeightStep: Math.max(...heightSteps.map(Math.abs)),
      reversals: heightSteps.filter((step) => step < -0.5).length,
      maxBoundaryGap: Math.max(...frames.slice(2).map((value) => value.boundaryGap)),
      resultHeightChanges,
      boundaryGaps: frames.map((value) => value.boundaryGap),
      resultsHeights: frames.map((value) => value.resultsHeight)
    };
  };
  expansionHydration.mutate(() => {
    expansionLauncher.append(...Array.from({ length: 5 }, (_, index) => {
      const item = document.createElement("div");
      item.className = "minimal-launch-item";
      item.innerHTML = `<button class="minimal-launch" type="button">Late ${index + 1}</button>`;
      return item;
    }));
  });
  await frame();
  const firstExpansionFrames = await sampleExpansion();
  const firstExpansion = expansionStats(firstExpansionFrames);
  check(expansionResults.scrollHeight <= expansionResults.clientHeight + 1 &&
      expansionResults.scrollTop === 0,
    "Minimal shows its complete initial suggestion set without scrolling when the viewport has room",
    JSON.stringify({
      clientHeight: expansionResults.clientHeight,
      scrollHeight: expansionResults.scrollHeight,
      scrollTop: expansionResults.scrollTop
    }));
  expansionSearch.dismissSearch({ blur: true });
  expansionDeck.classList.remove("is-search-expanded");
  for (let index = 0; index < 18; index += 1) await frame();
  const secondExpansionFrames = await sampleExpansion();
  const secondExpansion = expansionStats(secondExpansionFrames);
  check(firstExpansion.reversals === 0 && firstExpansion.maxBoundaryGap <= 1 &&
      firstExpansion.resultHeightChanges === 0 &&
      firstExpansion.firstWidthMovement === firstExpansion.firstHeightMovement &&
      firstExpansion.maxHeightStep <= secondExpansion.maxHeightStep + 2,
    "Minimal's first Search expansion is as continuous as its warmed expansion",
    JSON.stringify({ first: firstExpansion, second: secondExpansion }));
  expansionSearch.dismissSearch({ blur: true });
  expansionHydration.destroy();
  expansionHost.remove();

  const keyboardSearch = createSearchBox();
  document.querySelector("#search-keyboard-fixture").append(keyboardSearch);
  const keyboardInput = keyboardSearch.querySelector("input");
  keyboardInput.focus();
  keyboardInput.dispatchEvent(new FocusEvent("focus"));
  for (let attempt = 0; attempt < 20 && !keyboardSearch.querySelector(".search-row"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ghostChips = [...keyboardSearch.querySelectorAll(".ghost-chip")];
  let initialRecentRow = keyboardSearch.querySelector(".search-row");
  check(ghostChips.length >= 2 && initialRecentRow,
    "focused empty Search mounts Jump to actions followed by recent tabs");
  keyboardSearch.dismissSearch();
  check(document.activeElement === keyboardInput &&
      keyboardSearch.querySelector(".search-results").childElementCount === 0,
    "Search can close without taking focus away from its field");
  keyboardInput.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    pointerType: "mouse"
  }));
  await frame();
  check(keyboardSearch.querySelectorAll(".ghost-chip").length >= 2,
    "clicking an already-focused empty Search field reopens its suggestions");
  keyboardSearch.dismissSearch({ blur: true });
  keyboardInput.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    pointerType: "mouse"
  }));
  keyboardInput.focus();
  await frame();
  check(keyboardSearch.querySelectorAll(".ghost-chip").length >= 2,
    "an inside pointer-down paints the empty Search suggestions");
  // Minimal expands as the pointer gesture is in flight. Once the field has
  // moved away from the original coordinate, Chrome can synthesize the final
  // click at their common deck ancestor rather than at the input itself.
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await frame();
  check(keyboardSearch.querySelectorAll(".ghost-chip").length >= 2 &&
      document.activeElement === keyboardInput,
    "a Search gesture that began inside is not dismissed by its post-motion click target");
  document.body.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    pointerType: "mouse"
  }));
  await frame();
  check(keyboardSearch.querySelector(".search-results").childElementCount === 0,
    "a pointer gesture that begins outside still dismisses Search");

  const escapeDeck = document.createElement("section");
  escapeDeck.className = "minimal-deck";
  const escapeSearch = createSearchBox({
    escapeToList: () => requestAnimationFrame(() => escapeNavigation.focusBoundary())
  });
  const escapeLauncher = document.createElement("button");
  escapeLauncher.className = "minimal-launch";
  escapeLauncher.type = "button";
  escapeLauncher.textContent = "First launcher";
  escapeDeck.append(escapeSearch, escapeLauncher);
  document.querySelector("#search-keyboard-fixture").append(escapeDeck);
  const escapeNavigation = createMinimalNavigation(
    escapeDeck, escapeSearch.querySelector("input")
  );
  const escapeInput = escapeSearch.querySelector("input");
  escapeInput.focus();
  escapeInput.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true
  }));
  await frame();
  check(document.activeElement === escapeDeck,
    "an empty Minimal Search Escape retains a neutral keyboard boundary");
  escapeDeck.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowDown", bubbles: true, cancelable: true
  }));
  check(document.activeElement === escapeLauncher,
    "Down after Minimal Search Escape enters the first Starred launcher");
  escapeInput.focus();
  escapeInput.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true
  }));
  await frame();
  escapeDeck.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowRight", bubbles: true, cancelable: true
  }));
  check(document.activeElement === escapeLauncher,
    "Right after Minimal Search Escape enters the first Starred launcher");
  escapeNavigation.destroy();
  escapeDeck.remove();
  keyboardInput.focus();
  keyboardInput.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    pointerType: "mouse"
  }));
  await frame();
  initialRecentRow = keyboardSearch.querySelector(".search-row");
  const originalInterfaceStyle = document.documentElement.dataset.interfaceStyle;
  document.documentElement.dataset.interfaceStyle = "soft";
  await frame();
  const sharedSearchResults = keyboardSearch.querySelector(".search-results");
  const sharedSearchResultsStyle = getComputedStyle(sharedSearchResults);
  const sharedFirstDividerStyle = getComputedStyle(sharedSearchResults, "::before");
  const sharedSearchField = keyboardSearch.querySelector(".search-field");
  const sharedSearchFieldStyle = getComputedStyle(sharedSearchField);
  const sharedSearchBoundary = keyboardSearch.querySelector(".search-connected-boundary");
  const sharedSearchBoundaryStyle = sharedSearchBoundary
    ? getComputedStyle(sharedSearchBoundary) : null;
  check(sharedFirstDividerStyle.content !== "none" &&
      sharedFirstDividerStyle.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      Number.parseFloat(sharedFirstDividerStyle.marginInlineStart) >= 10 &&
      sharedFirstDividerStyle.marginInlineStart === sharedFirstDividerStyle.marginInlineEnd,
    "shared Search hosts use one inset first divider instead of a full-width seam",
    JSON.stringify({
      content: sharedFirstDividerStyle.content,
      background: sharedFirstDividerStyle.backgroundColor,
      start: sharedFirstDividerStyle.marginInlineStart,
      end: sharedFirstDividerStyle.marginInlineEnd
    }));
  check(sharedSearchBoundary && sharedSearchBoundaryStyle?.display !== "none" &&
      sharedSearchFieldStyle.borderColor === "rgba(0, 0, 0, 0)" &&
      sharedSearchResultsStyle.borderColor === "rgba(0, 0, 0, 0)" &&
      sharedSearchFieldStyle.boxShadow === "none" &&
      sharedSearchResultsStyle.boxShadow === "none",
    "compact Search delegates every open contour layer to one shared boundary",
    JSON.stringify({ boundaryDisplay: sharedSearchBoundaryStyle?.display,
      fieldBorder: sharedSearchFieldStyle.borderColor,
      resultsBorder: sharedSearchResultsStyle.borderColor,
      fieldShadow: sharedSearchFieldStyle.boxShadow,
      resultsShadow: sharedSearchResultsStyle.boxShadow }));
  const sharedSearchFieldRect = sharedSearchField.getBoundingClientRect();
  const sharedSearchResultsRect = sharedSearchResults.getBoundingClientRect();
  const sharedSearchBoundaryRect = sharedSearchBoundary?.getBoundingClientRect();
  check(sharedSearchBoundaryRect &&
      Math.abs(sharedSearchBoundaryRect.top - sharedSearchFieldRect.top) <= 0.1 &&
      Math.abs(sharedSearchBoundaryRect.bottom - sharedSearchResultsRect.bottom) <= 0.1,
    "the one compact Search boundary spans the field and complete result surface",
    JSON.stringify({ boundary: sharedSearchBoundaryRect,
      field: sharedSearchFieldRect, results: sharedSearchResultsRect }));
  document.documentElement.dataset.interfaceStyle = originalInterfaceStyle;
  await frame();
  ghostChips.at(-1).focus();
  ghostChips.at(-1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await frame();
  check(document.activeElement === keyboardInput && initialRecentRow.isConnected &&
    keyboardSearch.querySelector(".search-row") === initialRecentRow &&
    initialRecentRow.classList.contains("selected"),
  "leaving Jump to by keyboard preserves the mounted results and selects the first row",
  JSON.stringify({ active: document.activeElement?.className,
    connected: initialRecentRow?.isConnected,
    same: keyboardSearch.querySelector(".search-row") === initialRecentRow,
    selected: initialRecentRow?.classList.contains("selected") }));
  const keyboardScope = ghostChips[0];
  keyboardScope.focus();
  // Exercise the component's keyboard contract directly rather than relying on
  // a headless browser to synthesize a button click as the default action.
  keyboardScope.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true
  }));
  const pendingScopeTitles = [...keyboardSearch.querySelectorAll(".search-row .rtitle")]
    .map((node) => node.textContent);
  check(!pendingScopeTitles.includes("Recent page"),
    "changing Search scope immediately retires the previous Recent-tab action",
    JSON.stringify({ titles: pendingScopeTitles }));
  for (let attempt = 0;
    attempt < 100 && !keyboardSearch.querySelector(".search-row");
    attempt += 1) {
    await wait(10);
  }
  const keyboardScopedTitles = [...keyboardSearch.querySelectorAll(".search-row .rtitle")]
    .map((node) => node.textContent);
  check(keyboardSearch.querySelector(".search-scope-chip")?.textContent.includes("in:open") &&
    keyboardScopedTitles.length === 1 && keyboardScopedTitles[0] === "EveryTab",
  "activating a Jump to scope with Enter immediately shows that scope's tabs",
  JSON.stringify({ chip: keyboardSearch.querySelector(".search-scope-chip")?.textContent ?? null,
    titles: keyboardScopedTitles,
    active: document.activeElement?.className ?? null }));

  keyboardSearch.querySelector(".search-scope-chip .x")?.click();
  await wait(120);
  keyboardInput.value = "label:Work label:Urgent";
  keyboardInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(240);
  const facetChips = [...keyboardSearch.querySelectorAll(".search-scope-chip")]
    .map((chip) => chip.textContent.replace("×", ""));
  const facetTitles = [...keyboardSearch.querySelectorAll(".search-row .rtitle")]
    .map((node) => node.textContent);
  check(JSON.stringify(facetChips) === JSON.stringify(["label:Work", "label:Urgent"]) &&
      JSON.stringify(facetTitles) === JSON.stringify(["Facet roadmap"]),
  "pasted label facets become removable chips and show only the exact AND intersection",
  JSON.stringify({ facetChips, facetTitles }));
  keyboardInput.value = "";
  keyboardInput.setSelectionRange(0, 0);
  keyboardInput.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Backspace", bubbles: true, cancelable: true
  }));
  await wait(160);
  check(keyboardSearch.querySelectorAll(".search-scope-chip").length === 1 &&
      keyboardSearch.querySelector(".search-scope-chip")?.textContent.includes("label:Work"),
  "Backspace removes the last additive label facet without clearing the first");
  keyboardSearch.remove();

  const { buildInboxListConfig } = await import("../js/ui/list-configs.js");
  const { cardLabelPanel, sessionComboboxButton } = await import("../js/ui/list-helpers.js");

  const sessionPickerHost = document.createElement("div");
  sessionPickerHost.style.cssText = "position:fixed;left:80px;top:260px;z-index:40";
  let finishSessionCommit;
  const sessionCommit = new Promise((resolve) => { finishSessionCommit = resolve; });
  const sessionPickerButton = sessionComboboxButton("Save as Session", {
    actionId: "save-session",
    onPick: () => sessionCommit
  });
  const siblingAction = document.createElement("button");
  siblingAction.textContent = "Snooze";
  let siblingClicks = 0;
  siblingAction.addEventListener("click", () => { siblingClicks += 1; });
  sessionPickerHost.append(sessionPickerButton, siblingAction);
  document.body.append(sessionPickerHost);
  sessionPickerButton.click();
  await frame();
  const sessionPopover = document.querySelector('body > .action-popover[data-kind="session"]');
  const sessionInput = sessionPopover?.querySelector('.cbx input');
  const sessionMenu = sessionPopover?.querySelector('.tagmenu');
  check(sessionInput && sessionMenu && sessionPickerButton.getAttribute("aria-expanded") === "true",
    "the Session action stays in place and opens the shared anchored palette",
    JSON.stringify({ input: Boolean(sessionInput), menu: Boolean(sessionMenu),
      expanded: sessionPickerButton.getAttribute("aria-expanded") }));
  sessionInput.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true
  }));
  await frame();
  const sessionApply = [...sessionPopover.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save as Session");
  check(sessionPopover.querySelector('[data-inline-organization-editor="session"]') && sessionApply,
    "choosing a Session keeps its inline Organize and final Apply controls on one screen");
  sessionApply.click();
  await frame();
  check(sessionPickerHost.querySelector('[data-action-id="save-session"]') === sessionPickerButton &&
      !document.querySelector('body > .action-popover[data-kind="session"]'),
    "applying a Session closes the palette without replacing the action");
  siblingAction.click();
  check(siblingClicks === 1,
    "Session creation leaves neighboring actions interactive while the write settles");
  finishSessionCommit();
  await sessionCommit;
  sessionPickerHost.remove();

  const inboxBulkHost = document.createElement("div");
  inboxBulkHost.style.width = "880px";
  document.body.append(inboxBulkHost);
  const inboxRefs = Array.from({ length: 4 }, (_, index) => ({
    title: `Saved tab ${index + 1}`, url: `https://saved-${index + 1}.example/`
  }));
  const inboxGroup = {
    id: "inbox-window", title: "Window", meta: "4 tabs",
    data: { id: "inbox-window", kind: "window", modifiedAt: 1, labels: [], tabs: inboxRefs },
    refs: inboxRefs
  };
  let inboxBulkConfig;
  const renderInboxBulk = () => inboxBulkHost.replaceChildren(createTabList(inboxBulkConfig));
  const noop = () => {};
  inboxBulkConfig = buildInboxListConfig({
    data: { groups: [inboxGroup] }, renderInbox: renderInboxBulk, renderLabels: noop,
    goToLabel: noop, buildSnooze: () => document.createElement("div"),
    inboxRowDrag: {}, newBundleZone: () => null, inboxDrag: () => null,
    dropInboxTab: noop, showNotice: noop, copyRefs: noop, sessionComboboxButton,
    saveWindowItemToSession: noop, cardLabelPanel, confirmDelete: (run) => {
      const button = document.createElement("button");
      button.onclick = run;
      return button;
    }, delInboxItem: noop, flashNote: noop, showToast: noop, openRowLabel: noop
  });
  renderInboxBulk();
  inboxBulkHost.querySelectorAll('.trow input[type="checkbox"]')[0].click();
  await frame();
  inboxBulkHost.querySelectorAll('.trow input[type="checkbox"]')[1].click();
  await frame();
  const inboxHeaderBulk = inboxBulkHost.querySelector(".header-bulk-actions");
  const inboxHeaderButtons = [...(inboxHeaderBulk?.querySelectorAll(":scope > button") ?? [])];
  check(inboxHeaderBulk && !inboxHeaderBulk.querySelector(".tagbox") &&
    inboxHeaderButtons.length >= 5 &&
    inboxHeaderButtons[0]?.dataset.actionId === "session" &&
    inboxHeaderButtons.every((button) => button.querySelector(":scope > .action-icon")) &&
    inboxHeaderBulk.scrollWidth <= inboxHeaderBulk.clientWidth + 1,
  "Inbox one-card selection keeps its compact actions local without an inline field or wide-layout overflow",
  JSON.stringify({ buttons: inboxHeaderButtons.length,
    tagbox: Boolean(inboxHeaderBulk?.querySelector(".tagbox")),
    iconButtons: inboxHeaderButtons.filter((button) => button.querySelector(":scope > .action-icon")).length,
    clientWidth: inboxHeaderBulk?.clientWidth ?? null,
    scrollWidth: inboxHeaderBulk?.scrollWidth ?? null }));
  const shortcutCycle = async (key, actionId, kind, cycles = 3) => {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const actionButton = inboxBulkHost.querySelector(`[data-bulk-action="${actionId}"]`);
      let clickCount = 0;
      const countClick = () => { clickCount += 1; };
      actionButton?.addEventListener("click", countClick, true);
      const owner = cycle === 0 ? document.body : document.activeElement;
      if (cycle === 0) {
        document.body.tabIndex = -1;
        document.body.focus();
      }
      owner.dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true
      }));
      await frame();
      const popover = document.querySelector(`.action-popover[data-kind="${kind}"]`);
      const buttonRect = actionButton?.getBoundingClientRect();
      const popoverRect = popover?.getBoundingClientRect();
      const stem = Number.parseFloat(popover
        ? getComputedStyle(popover).getPropertyValue("--palette-stem-x")
        : "NaN");
      const stemCenter = (popoverRect?.left ?? 0) + stem;
      const buttonCenter = buttonRect ? buttonRect.left + buttonRect.width / 2 : Number.NaN;
      actionButton?.removeEventListener("click", countClick, true);
      check(actionButton?.getAttribute("aria-expanded") === "true" && popover &&
          Math.abs(stemCenter - buttonCenter) <= 6,
        `the ${key.toLocaleUpperCase()} shortcut cycle ${cycle + 1} stays anchored to its visible action`,
        JSON.stringify({ actionId, expanded: actionButton?.getAttribute("aria-expanded") ?? null,
          popover: Boolean(popover), clickCount, stemCenter, buttonCenter }));
      if (cycle % 2 === 1) {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true
        }));
      } else {
        popover.querySelector(".action-popover-close")?.click();
      }
      await frame();
      check(document.activeElement === actionButton,
        `closing the ${key.toLocaleUpperCase()} palette returns focus to the same action`,
        JSON.stringify({ cycle: cycle + 1,
          expected: actionButton?.dataset.bulkAction ?? null,
          actual: document.activeElement?.outerHTML?.slice(0, 240) ?? null,
          expectedConnected: Boolean(actionButton?.isConnected) }));
    }
  };
  await shortcutCycle("l", "label", "bulk-label");
  await shortcutCycle("s", "snooze", "snooze");
  await shortcutCycle("t", "session", "session");
  check(JSON.stringify(snoozeArrowPath) === JSON.stringify([2, 3, 1, 0]),
    "Snooze arrow keys follow the two-dimensional choice layout",
    JSON.stringify({ actual: snoozeArrowPath, expected: [2, 3, 1, 0] }));
  inboxBulkHost.remove();

  const focusMotionFixture = document.querySelector("#focus-motion-fixture");
  const focusAction = document.createElement("button");
  focusAction.type = "button";
  focusAction.className = "hero-focus-action";
  const focusState = (id, label, shape) => {
    const state = document.createElement("span");
    state.className = `hero-focus-state is-${id}${id === "ready" ? " is-current" : ""}`;
    state.dataset.focusState = id;
    state.innerHTML = `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>` +
      `<span class="hero-focus-label">${label}</span>`;
    return state;
  };
  const readyFocusState = focusState("ready", "Start Focus", '<path d="M7 4.5v15l12-7.5z"/>');
  const activeFocusState = focusState("active", "End Focus", '<rect x="6" y="6" width="12" height="12" rx="2"/>');
  focusAction.append(readyFocusState, activeFocusState);
  focusAction.disabled = true;
  const focusSettings = document.createElement("button");
  focusSettings.type = "button";
  focusSettings.className = "hero-focus-settings";
  focusSettings.textContent = "S";
  const focusControl = document.createElement("div");
  focusControl.className = "hero-focus";
  focusControl.append(focusAction, focusSettings);
  focusMotionFixture.append(focusControl);
  await frame();
  await frame();
  focusAction.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
  const pendingFocusCursor = getComputedStyle(focusAction).cursor;
  const startIconLeft = readyFocusState.querySelector(".ic").getBoundingClientRect().left;
  focusControl.classList.add("is-active");
  readyFocusState.classList.remove("is-current");
  activeFocusState.classList.add("is-current");
  await frame();
  focusAction.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
  const endIconLeft = activeFocusState.querySelector(".ic").getBoundingClientRect().left;
  check(Math.abs(endIconLeft - startIconLeft) <= 0.5,
    "Start and End Focus keep their icon on one fixed left axis",
    JSON.stringify({ startIconLeft, endIconLeft }));
  check(focusControl.getBoundingClientRect().width >= 159 &&
      focusAction.scrollWidth <= focusAction.clientWidth + 1,
    "Terminal Focus keeps its complete label inside one aligned control",
    JSON.stringify({ width: focusControl.getBoundingClientRect().width,
      clientWidth: focusAction.clientWidth, scrollWidth: focusAction.scrollWidth,
      readyWidth: readyFocusState.getBoundingClientRect().width,
      readyScroll: readyFocusState.scrollWidth,
      labelWidth: readyFocusState.querySelector(".hero-focus-label").getBoundingClientRect().width,
      settingsWidth: focusSettings.getBoundingClientRect().width,
      padding: getComputedStyle(focusAction).paddingInline }));

  let focusStatus = {
    active: true, guardedCount: 3, duringCount: 3, alwaysCount: 0,
    endsAt: Date.now() + 25 * 60_000, accesses: []
  };
  const chromeHost = globalThis.chrome ?? {};
  chromeHost.runtime = {
    sendMessage: async () => ({ status: focusStatus })
  };
  globalThis.chrome = chromeHost;
  const { createFocusStrip } = await import("../js/ui/focus-strip.js");
  const mountedFocus = createFocusStrip({
    getSearchInput: () => document.querySelector("#search-input"),
    onMeasure: () => {}
  });
  const focusLayout = mountedFocus.element;
  const focusStrip = mountedFocus.strip;
  document.querySelector(".hero").append(focusLayout);
  const firstOpening = mountedFocus.refresh();
  await frame();
  const focusStripContent = focusStrip.querySelector(".focus-strip-content");
  const contentStyle = getComputedStyle(focusStripContent);
  const stripStyle = getComputedStyle(focusStrip);
  const upperRailStyle = getComputedStyle(focusStrip, "::before");
  const lowerRailStyle = getComputedStyle(focusStrip, "::after");
  const recessStyle = getComputedStyle(focusLayout, "::before");
  check(focusLayout.classList.contains("is-open") &&
    !focusStrip.classList.contains("focus-enter") &&
    Number.parseFloat(contentStyle.opacity) > 0.95 && Number.parseFloat(stripStyle.opacity) > 0.95 &&
    stripStyle.backgroundColor === "rgba(0, 0, 0, 0)" &&
    upperRailStyle.animationName === "none" && lowerRailStyle.animationName === "none" &&
    ["none", "normal"].includes(upperRailStyle.content) &&
    ["none", "normal"].includes(lowerRailStyle.content) &&
    recessStyle.content !== "none" && recessStyle.boxShadow !== "none" &&
    recessStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
  "Focus copy is present from the first opening frame while the recessed material reveals without animated border rails",
  JSON.stringify({ layout: focusLayout.className, strip: focusStrip.className,
    contentOpacity: contentStyle.opacity, stripOpacity: stripStyle.opacity,
    upperRail: upperRailStyle.animationName,
    lowerRail: lowerRailStyle.animationName, recessShadow: recessStyle.boxShadow,
    recessBackground: recessStyle.backgroundColor }));
  await firstOpening;
  await mountedFocus.refresh();
  check(focusLayout.classList.contains("is-open") && !focusStrip.classList.contains("hidden"),
    "a duplicate active refresh cannot collapse the Focus layout");

  focusStatus = { active: false, guardedCount: 0, duringCount: 3, alwaysCount: 0, accesses: [] };
  const closingFocusContent = focusStrip.querySelector(".focus-strip-content");
  const activeFocusCopy = closingFocusContent.textContent;
  const exitRefresh = mountedFocus.refresh();
  await frame();
  const exitUpperRail = getComputedStyle(focusStrip, "::before");
  const exitContentStyle = getComputedStyle(closingFocusContent);
  check(focusLayout.getBoundingClientRect().height > 0 &&
    focusStrip.classList.contains("focus-exit") && !focusStrip.classList.contains("hidden") &&
    exitUpperRail.animationName === "none" && exitUpperRail.boxShadow === "none" &&
    Number.parseFloat(exitContentStyle.opacity || "1") > 0.95 &&
    closingFocusContent.getClientRects().length === 1 &&
    closingFocusContent.textContent === activeFocusCopy,
  "ending Focus keeps its copy present while the same layout seam closes without border effects",
  JSON.stringify({ layout: focusLayout.className, className: focusStrip.className,
    railAnimation: exitUpperRail.animationName, railGlow: exitUpperRail.boxShadow,
    contentOpacity: exitContentStyle.opacity || "1", copy: closingFocusContent.textContent,
    layoutHeight: focusLayout.getBoundingClientRect().height }));
  await exitRefresh;
  check(focusStrip.classList.contains("hidden") && !focusStrip.classList.contains("focus-exit"),
    "the Focus exit consumes its visual state after the inverse motion");
  check(pendingFocusCursor === "pointer",
    "Focus keeps the pointer while its async action is pending",
    pendingFocusCursor);

  const filterControl = document.querySelector("#filter-fixture .open-filter-control");
  const filterInput = filterControl.querySelector("input");
  const filterClose = document.querySelector("#filter-fixture > button");
  const restingFilterRect = filterControl.getBoundingClientRect();
  filterInput.focus();
  await frame();
  const focusedFilterRect = filterControl.getBoundingClientRect();
  check(getComputedStyle(filterControl).boxShadow.includes("inset") &&
    getComputedStyle(filterInput).outlineStyle === "none",
  "the filter keeps its one focus cue inside the field's sticky boundary",
  getComputedStyle(filterControl).boxShadow);
  check(restingFilterRect.width >= 100 && Math.abs(focusedFilterRect.width - restingFilterRect.width) <= 1 &&
    filterInput.getBoundingClientRect().width >= 80 && filterClose.getClientRects().length === 1 &&
    filterControl.children.length === 1,
  "Open filter is a stable, permanently expanded field beside Close the day",
  JSON.stringify({ restingWidth: restingFilterRect.width, focusedWidth: focusedFilterRect.width,
    inputWidth: filterInput.getBoundingClientRect().width, closeVisible: filterClose.getClientRects().length }));

  // The real Inbox is an active queue rather than a catalogue preview. Exercise
  // substantially more cards than the reported 66-item profile before keeping
  // the complete queue mounted by default.
  const inboxPerfHost = document.createElement("div");
  inboxPerfHost.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden";
  const inboxPerfGroups = Array.from({ length: 250 }, (_, index) => ({
    id: `inbox-perf-${index}`,
    title: "Single tab",
    meta: `${index + 1}m ago`,
    refs: [{ title: `Saved page ${index + 1}`, url: `https://saved-${index + 1}.test/` }],
    data: { id: `inbox-perf-${index}`, createdAt: Date.now() - index * 60_000 }
  }));
  const inboxPerfStarted = performance.now();
  const inboxPerfList = createTabList({
    section: "inbox-perf",
    groups: inboxPerfGroups,
    groupCap: inboxPerfGroups.length,
    selectable: "tab"
  });
  inboxPerfHost.append(inboxPerfList);
  document.body.append(inboxPerfHost);
  const inboxPerfCount = inboxPerfList.querySelectorAll("[data-tablist-card]").length;
  inboxPerfList.getBoundingClientRect();
  const inboxPerfMs = performance.now() - inboxPerfStarted;
  check(inboxPerfCount === inboxPerfGroups.length && inboxPerfMs < 200,
  "a complete 250-card Inbox mounts within the interaction budget",
  JSON.stringify({ count: inboxPerfCount, ms: inboxPerfMs }));
  resultNode.dataset.inboxPerfMs = inboxPerfMs.toFixed(1);
  inboxPerfHost.remove();

  const searchInterfaceStyle = document.documentElement.dataset.interfaceStyle;
  document.documentElement.dataset.interfaceStyle = "soft";
  document.querySelector("#search-input").focus();
  await frame();
  const panel = document.querySelector(".hero-panel");
  const result = document.querySelector(".search-row");
  const rr = result.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const x = Math.round(rr.left + Math.min(36, rr.width / 2));
  const y = Math.round(Math.max(pr.bottom + 6, rr.top + 4));
  const hit = document.elementFromPoint(x, y);
  check(rr.bottom > pr.bottom && hit?.closest?.(".hero-search-overlay"),
    "expanded Search is visible and hit-testable above section content",
    JSON.stringify({ panelBottom: pr.bottom, result: [rr.top, rr.bottom], hit: hit?.className ?? null }));
  const refs = Array.from({ length: 30 }, (_, index) => ({
    title: `Open tab ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    pinned: index === 0
  }));
  const group = { id: "window-1", title: "Window 1", badge: "(current window)", meta: "30 tabs", refs };
  let bulkLabelCount = 0;
  let rowLabelCount = 0;
  let bulkInboxCount = 0;
  let rowInboxCount = 0;
  let bulkSessionCount = 0;
  let rowSessionCount = 0;
  let bulkArchiveCount = 0;
  let rowArchiveCount = 0;
  let bulkSuspendCount = 0;
  let rowSuspendCount = 0;
  let groupInboxCount = 0;
  const action = (label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.bulkAction = label.toLocaleLowerCase();
    if (label === "Label") button.addEventListener("click", () => { bulkLabelCount += 1; });
    if (label === "Inbox") button.addEventListener("click", () => { bulkInboxCount += 1; });
    if (label === "Session") button.addEventListener("click", () => { bulkSessionCount += 1; });
    if (label === "Archive") button.addEventListener("click", () => { bulkArchiveCount += 1; });
    if (label === "Suspend") button.addEventListener("click", () => { bulkSuspendCount += 1; });
    return button;
  };
  let renderCount = 0;
  const render = () => {
    renderCount += 1;
    const list = createTabList({
      section: "dashboard-polish-selection",
      groups: [group],
      selectable: "tab",
      rowCap: 40,
      rowActions: [
        { id: "dump", label: "Save to Inbox", key: "i",
          run: () => { rowInboxCount += 1; } },
        { id: "session", label: "To Session", key: "t",
          run: () => { rowSessionCount += 1; } },
        { id: "label", label: "Label", key: "l",
          run: () => { rowLabelCount += 1; } },
        { id: "archive", label: "Archive", key: "a",
          run: () => { rowArchiveCount += 1; } },
        { id: "suspend", label: "Suspend", key: "z",
          run: () => { rowSuspendCount += 1; } }
      ],
      groupActions: [
        { id: "dump-window", label: "Save window to Inbox", key: "i",
          run: () => { groupInboxCount += 1; } },
        { id: "copy", label: "Copy", run: () => {} }
      ],
      bulkActions: () => [
        "Inbox", "Session", "Label", "Snooze", "Archive", "Suspend", "Close", "Keep"
      ].map(action),
      onChange: render
    });
    listHost.replaceChildren(list);
  };
  render();
  const pinned = listHost.querySelector(".pinned-state");
  const currentWindow = listHost.querySelector(".item-badge");
  check(listHost.querySelector('[data-action-id="label"]')?.title === "Label (L)",
    "row action hover tips name their available shortcut");
  check(pinned && getComputedStyle(pinned).display !== "none" &&
    getComputedStyle(pinned).color === getComputedStyle(currentWindow).color,
  "Pinned remains visible in clean row mode and shares the current-window accent",
  JSON.stringify({
    pinned: Boolean(pinned),
    pinnedDisplay: pinned ? getComputedStyle(pinned).display : null,
    pinnedColor: pinned ? getComputedStyle(pinned).color : null,
    currentColor: currentWindow ? getComputedStyle(currentWindow).color : null
  }));
  const enterCheckbox = listHost.querySelector('.trow input[type="checkbox"]');
  enterCheckbox.focus();
  enterCheckbox.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true
  }));
  await frame();
  check(listHost.querySelector('.trow input[type="checkbox"]')?.checked === true,
    "Enter checks a focused tab checkbox just like Space");
  const checkedByEnter = listHost.querySelector('.trow input[type="checkbox"]');
  checkedByEnter.focus();
  checkedByEnter.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true
  }));
  await frame();
  check(listHost.querySelector('.trow input[type="checkbox"]')?.checked === false,
    "Enter also unchecks a focused tab checkbox");
  document.querySelector("#search-input").focus();
  await frame();
  panel.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
  const overlayStyle = getComputedStyle(document.querySelector(".hero-search-overlay"));
  const panelStyle = getComputedStyle(panel);
  const searchField = document.querySelector(".search-field");
  const searchFieldStyle = getComputedStyle(searchField);
  const overlay = document.querySelector(".hero-search-overlay");
  const shellStyle = getComputedStyle(overlay, "::before");
  const firstDividerStyle = getComputedStyle(overlay, "::after");
  const recentDivider = document.createElement("div");
  recentDivider.className = "search-recent";
  overlay.querySelector(".search-results").append(recentDivider);
  const recentDividerStyle = getComputedStyle(recentDivider, "::before");
  const shellTop = Number.parseFloat(shellStyle.top);
  const combinedTop = overlay.getBoundingClientRect().top + shellTop;
  check(shellStyle.content !== "none" &&
    Math.abs(combinedTop - panel.getBoundingClientRect().top) <= 0.5 &&
    shellStyle.borderTopStyle === "solid" &&
    shellStyle.borderTopColor !== "rgba(0, 0, 0, 0)" &&
    shellStyle.borderTopLeftRadius === shellStyle.borderBottomLeftRadius &&
    shellStyle.boxShadow.includes("0px 0px 0px 3px") &&
    !panelStyle.boxShadow.includes("0px 0px 0px 3px") &&
    !overlayStyle.boxShadow.includes("0px 0px 0px 3px") &&
    panelStyle.clipPath === "none" && overlayStyle.clipPath === "none" &&
    panelStyle.borderBottomLeftRadius === "0px" &&
    panelStyle.borderBottomRightRadius === "0px" &&
    searchFieldStyle.borderBottomWidth === "0px" &&
    firstDividerStyle.backgroundColor === recentDividerStyle.backgroundColor &&
    firstDividerStyle.blockSize === recentDividerStyle.blockSize &&
    firstDividerStyle.insetInlineStart === recentDividerStyle.insetInlineStart &&
    firstDividerStyle.insetInlineEnd === recentDividerStyle.insetInlineEnd &&
    parseFloat(firstDividerStyle.insetInlineStart) >= 12,
  "Search uses one continuous rounded shell and one internal separator grammar",
  JSON.stringify({ shellContent: shellStyle.content, shellTop, combinedTop,
    panelTop: panel.getBoundingClientRect().top,
    shellBorder: shellStyle.borderTop,
    shellShadow: shellStyle.boxShadow,
    panelShadow: panelStyle.boxShadow,
    overlayShadow: overlayStyle.boxShadow,
    panelClip: panelStyle.clipPath,
    panelBottomRadius: [panelStyle.borderBottomLeftRadius, panelStyle.borderBottomRightRadius],
    overlayClip: overlayStyle.clipPath,
    firstDivider: {
      background: firstDividerStyle.backgroundColor,
      size: firstDividerStyle.blockSize,
      start: firstDividerStyle.insetInlineStart,
      end: firstDividerStyle.insetInlineEnd
    },
    recentDivider: {
      background: recentDividerStyle.backgroundColor,
      size: recentDividerStyle.blockSize,
      start: recentDividerStyle.insetInlineStart,
      end: recentDividerStyle.insetInlineEnd
    } }));
  recentDivider.remove();
  document.documentElement.dataset.interfaceStyle = searchInterfaceStyle;
  const target = listHost.querySelectorAll(".trow")[18];
  const selectionRenderStart = renderCount;
  target.scrollIntoView({ block: "center" });
  await frame();
  const beforeScroll = scrollY;
  const beforeTop = target.getBoundingClientRect().top;
  target.querySelector("input").click();
  await frame();
  await frame();
  await frame();
  const replacement = listHost.querySelectorAll(".trow")[18];
  const afterScroll = scrollY;
  const afterTop = replacement.getBoundingClientRect().top;
  check(renderCount === selectionRenderStart + 1,
    "row selection performs one list replacement", String(renderCount - selectionRenderStart));
  check(Math.abs(afterScroll - beforeScroll) <= 1 && Math.abs(afterTop - beforeTop) <= 1,
    "row selection preserves scroll and the selected row's viewport position",
    JSON.stringify({ beforeScroll, afterScroll, beforeTop, afterTop }));
  listHost.querySelectorAll(".trow input")[19].click();
  await frame();
  check(listHost.querySelector('[data-bulk-action="label"]')?.title === "Label (L)",
    "selected-set hover tips retain the matching row shortcut");
  check(listHost.querySelector('[data-bulk-action="inbox"]')?.title === "Inbox (I)",
    "semantic selected-set actions expose their matching row shortcut");
  check(listHost.querySelector('[data-bulk-action="session"]')?.title === "Session (T)",
    "Session selected-set actions expose the T shortcut");
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
  await frame();
  check(bulkLabelCount === 1 && rowLabelCount === 0,
    "the Label shortcut targets the complete selected set even after row focus is lost",
    JSON.stringify({ bulkLabelCount, rowLabelCount }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
  await frame();
  check(bulkInboxCount === 1 && rowInboxCount === 0,
    "the Inbox shortcut also targets the complete selected set through its semantic alias",
    JSON.stringify({ bulkInboxCount, rowInboxCount }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
  await frame();
  check(bulkSessionCount === 1 && rowSessionCount === 0,
    "the Session shortcut targets the complete selected set through T",
    JSON.stringify({ bulkSessionCount, rowSessionCount }));
  const selectedCardCheckbox = listHost.querySelector('.item-head input[type="checkbox"]');
  selectedCardCheckbox.focus();
  selectedCardCheckbox.dispatchEvent(new KeyboardEvent("keydown", {
    key: "i", bubbles: true, cancelable: true
  }));
  await frame();
  check(bulkInboxCount === 2 && groupInboxCount === 0,
    "a selected-set shortcut wins over the whole-window action even from the card header",
    JSON.stringify({ bulkInboxCount, groupInboxCount }));
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key: "a", bubbles: true, cancelable: true
  }));
  await frame();
  check(bulkArchiveCount === 1 && rowArchiveCount === 0,
    "a selected-only Archive shortcut remains available from the card header",
    JSON.stringify({ bulkArchiveCount, rowArchiveCount }));
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key: "z", bubbles: true, cancelable: true
  }));
  await frame();
  check(bulkSuspendCount === 1 && rowSuspendCount === 0,
    "a selected-only Suspend shortcut remains available after another selected action",
    JSON.stringify({ bulkSuspendCount, rowSuspendCount }));

  /* Regression for the installed Focus seam. The band and the first ledger row
   * must travel through ordinary flow on every frame. A display:none/full-height
   * swap produces a 30-50px first/last-frame jump even when a later scroll FLIP
   * looks smooth in isolation, which is the exact opening/closing jitter the
   * installed Dashboard exposed. */
  const motionHero = document.createElement("section");
  motionHero.className = "hero focus-flow-fixture";
  motionHero.style.cssText = "position:sticky;top:0;margin:0;padding-top:0;z-index:20";
  listHost.before(motionHero);
  motionHero.append(focusLayout);
  const motionCap = listHost.querySelector(".item-head-shell");
  const motionRow = listHost.querySelectorAll(".trow")[18];
  document.documentElement.style.setProperty("--hero-base-h", "0px");
  document.documentElement.style.setProperty(
    "--hero-h",
    "calc(var(--hero-base-h) + var(--focus-layout-h, 0px))"
  );
  motionRow.scrollIntoView({ block: "center" });
  await frame();
  await frame();
  const sampleFlow = async (trigger, duration = 400) => {
    const frames = [{
      capTop: motionCap.getBoundingClientRect().top,
      rowTop: motionRow.getBoundingClientRect().top,
      heroHeight: motionHero.getBoundingClientRect().height,
      surfaceOpacity: Number.parseFloat(getComputedStyle(focusStrip).opacity)
    }];
    document.documentElement.classList.add("focus-layout-transition");
    const pending = trigger();
    const started = performance.now();
    while (performance.now() - started < duration) {
      await frame();
      frames.push({
        capTop: motionCap.getBoundingClientRect().top,
        rowTop: motionRow.getBoundingClientRect().top,
        heroHeight: motionHero.getBoundingClientRect().height,
        surfaceOpacity: Number.parseFloat(getComputedStyle(focusStrip).opacity)
      });
    }
    await pending;
    document.documentElement.classList.remove("focus-layout-transition");
    return frames;
  };
  const flowStats = (frames) => {
    const capSteps = frames.slice(1).map((value, index) => value.capTop - frames[index].capTop);
    const rowSteps = frames.slice(1).map((value, index) => value.rowTop - frames[index].rowTop);
    const heightSteps = frames.slice(1).map((value, index) => value.heroHeight - frames[index].heroHeight);
    return {
      capSteps,
      rowSteps,
      heightSteps,
      maxCapStep: Math.max(...capSteps.map(Math.abs)),
      maxRowStep: Math.max(...rowSteps.map(Math.abs)),
      maxHeightStep: Math.max(...heightSteps.map(Math.abs)),
      maxRowDesync: Math.max(...rowSteps.map((step, index) => Math.abs(step - heightSteps[index]))),
      maxCapDesync: Math.max(...capSteps.map((step, index) => Math.abs(step - heightSteps[index])))
    };
  };

  focusStatus = {
    active: true, guardedCount: 3, duringCount: 3, alwaysCount: 0,
    endsAt: Date.now() + 25 * 60_000, accesses: []
  };
  const openingFrames = await sampleFlow(() => mountedFocus.refresh());
  const openingFlow = flowStats(openingFrames);
  check(openingFlow.maxCapStep <= 12 && openingFlow.maxRowStep <= 12 &&
    openingFlow.maxHeightStep <= 12 && openingFlow.maxRowDesync <= 1 &&
    openingFlow.maxCapDesync <= 1 && openingFlow.capSteps.every((step) => step >= -0.5) &&
    openingFlow.rowSteps.every((step) => step >= -0.5),
  "Focus opening has no jump, reversal, or header/row desynchronization",
  JSON.stringify(openingFlow));

  focusStatus = { active: false, guardedCount: 0, duringCount: 3, alwaysCount: 0, accesses: [] };
  const closingFrames = await sampleFlow(() => mountedFocus.refresh());
  const closingFlow = flowStats(closingFrames);
  check(closingFlow.maxCapStep <= 12 && closingFlow.maxRowStep <= 12 &&
    closingFlow.maxHeightStep <= 12 && closingFlow.maxRowDesync <= 1 &&
    closingFlow.maxCapDesync <= 1 && closingFlow.capSteps.every((step) => step <= 0.5) &&
    closingFlow.rowSteps.every((step) => step <= 0.5),
  "Focus closing is the smooth inverse of opening",
  JSON.stringify(closingFlow));

  resultNode.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
  resultNode.dataset.status = "pass";
} catch (error) {
  resultNode.textContent = `FAIL: ${error?.stack ?? error}`;
  resultNode.dataset.status = "fail";
}
