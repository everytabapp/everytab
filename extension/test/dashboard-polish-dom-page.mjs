import { createAnchoredPanel, createTabList } from "../js/ui/tablist.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";

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
globalThis.chrome = { i18n: browserI18n };

try {
  const navFrame = document.createElement("iframe");
  navFrame.style.cssText = "position:fixed;left:-1600px;top:0;width:1440px;height:720px;visibility:hidden";
  navFrame.src = "../tools/shell-harness.html";
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

  const runwayFixture = document.createElement("div");
  runwayFixture.className = "sections";
  document.body.append(runwayFixture);
  const runwayPadding = Number.parseFloat(getComputedStyle(runwayFixture).paddingBottom);
  check(runwayPadding <= 64,
    "a short Dashboard section ends near its final row instead of reserving an empty viewport",
    String(runwayPadding));
  runwayFixture.remove();

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

  const appendTarget = document.createElement("div");
  appendTarget.className = "drop-zone-window-end";
  appendTarget.setAttribute("aria-label", "Move to end of Window 1");
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
    rowCap: 1
  });
  document.body.append(dragPolishList);
  document.body.classList.add("tab-dragging");
  const dragPreview = document.createElement("div");
  dragPreview.className = "open-drag-preview";
  dragPreview.textContent = "2 tabs";
  document.body.append(dragPreview);
  await frame();
  const appendStyle = getComputedStyle(appendTarget);
  const appendLineStyle = getComputedStyle(appendTarget, "::before");
  const finalRenderedRow = [...dragPolishList.querySelectorAll(".trow")].at(-1);
  const rowBottom = finalRenderedRow.getBoundingClientRect().bottom;
  const appendTop = appendTarget.getBoundingClientRect().top;
  const previewRect = dragPreview.getBoundingClientRect();
  check(appendStyle.display === "flex" &&
      appendTarget.nextElementSibling?.classList.contains("disclosure-row") &&
      Number.parseFloat(appendStyle.minHeight) <= 20 &&
      Number.parseFloat(appendLineStyle.height) >= 2,
    "Open drag reveals a compact terminal bar after the final row and before Show fewer",
    JSON.stringify({ display: appendStyle.display, minHeight: appendStyle.minHeight,
      lineHeight: appendLineStyle.height,
      next: appendTarget.nextElementSibling?.className ?? null }));
  check(appendStyle.position === "relative" && appendLineStyle.position === "absolute" &&
      appendLineStyle.top === "0px" && Math.abs(appendTop - rowBottom) <= 1,
    "the terminal target paints on the last row separator instead of below it",
    JSON.stringify({ position: appendStyle.position, linePosition: appendLineStyle.position,
      lineTop: appendLineStyle.top, appendTop, rowBottom }));
  check(previewRect.width >= 55 && previewRect.height >= 30 &&
      getComputedStyle(dragPreview).borderStyle !== "none",
    "the selected-tab count has a compact themed native-drag surface",
    JSON.stringify({ width: previewRect.width, height: previewRect.height,
      border: getComputedStyle(dragPreview).border }));
  document.body.classList.remove("tab-dragging");
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
  const recentTab = { id: 502, windowId: 71, title: "Recent page", url: "https://recent.test/" };
  globalThis.chrome = {
    i18n: browserI18n,
    runtime: {
      sendMessage: async () => ({ ok: true }),
      getURL: (path = "") => `chrome-extension://fixture/${path}`
    },
    permissions: { contains: async () => false, onAdded: eventChannel, onRemoved: eventChannel },
    storage: { local: { get: async () => ({}) }, onChanged: eventChannel },
    tabs: { query: async () => [activeTab] },
    windows: { getAll: async () => [{ id: 71, type: "normal", tabs: [activeTab, recentTab] }] }
  };
  const { createSearchBox } = await import("../js/ui/searchbox.js");
  const keyboardSearch = createSearchBox();
  document.querySelector("#search-keyboard-fixture").append(keyboardSearch);
  const keyboardInput = keyboardSearch.querySelector("input");
  keyboardInput.focus();
  keyboardInput.dispatchEvent(new FocusEvent("focus"));
  for (let attempt = 0; attempt < 20 && !keyboardSearch.querySelector(".search-row"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ghostChips = [...keyboardSearch.querySelectorAll(".ghost-chip")];
  const initialRecentRow = keyboardSearch.querySelector(".search-row");
  check(ghostChips.length >= 2 && initialRecentRow,
    "focused empty Search mounts Jump to actions followed by recent tabs");
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
  await wait(180);
  const keyboardScopedTitles = [...keyboardSearch.querySelectorAll(".search-row .rtitle")]
    .map((node) => node.textContent);
  check(keyboardSearch.querySelector(".search-scope-chip")?.textContent.includes("in:open") &&
    keyboardScopedTitles.length === 1 && keyboardScopedTitles[0] === "EveryTab",
  "activating a Jump to scope with Enter immediately shows that scope's tabs",
  JSON.stringify({ chip: keyboardSearch.querySelector(".search-scope-chip")?.textContent ?? null,
    titles: keyboardScopedTitles,
    active: document.activeElement?.className ?? null }));
  keyboardSearch.remove();

  const { buildInboxListConfig } = await import("../js/ui/list-configs.js");
  const { cardLabelPanel, sessionComboboxButton } = await import("../js/ui/list-helpers.js");
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
    inboxHeaderButtons.every((button) => button.querySelector(":scope > .action-icon")) &&
    inboxHeaderBulk.scrollWidth <= inboxHeaderBulk.clientWidth + 1,
  "Inbox card selection uses the current compact action anatomy without an inline field or overflow",
  JSON.stringify({ buttons: inboxHeaderButtons.length,
    tagbox: Boolean(inboxHeaderBulk?.querySelector(".tagbox")),
    iconButtons: inboxHeaderButtons.filter((button) => button.querySelector(":scope > .action-icon")).length,
    clientWidth: inboxHeaderBulk?.clientWidth ?? null,
    scrollWidth: inboxHeaderBulk?.scrollWidth ?? null }));
  inboxBulkHost.remove();

  const focusMotionFixture = document.querySelector("#focus-motion-fixture");
  const focusAction = document.createElement("button");
  focusAction.type = "button";
  focusAction.className = "hero-focus-action";
  const focusState = (id, label, shape) => {
    const state = document.createElement("span");
    state.className = `hero-focus-state is-${id}${id === "ready" ? " is-current" : ""}`;
    state.dataset.focusState = id;
    state.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>` +
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
  check(restingFilterRect.width >= 100 && Math.abs(focusedFilterRect.width - restingFilterRect.width) <= 1 &&
    filterInput.getBoundingClientRect().width >= 80 && filterClose.getClientRects().length === 1 &&
    filterControl.children.length === 1,
  "Open filter is a stable, permanently expanded field beside Close the day",
  JSON.stringify({ restingWidth: restingFilterRect.width, focusedWidth: focusedFilterRect.width,
    inputWidth: filterInput.getBoundingClientRect().width, closeVisible: filterClose.getClientRects().length }));

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
  const action = (label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
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
      groupActions: [{ id: "copy", label: "Copy", run: () => {} }],
      bulkActions: () => ["Inbox", "Session", "Label", "Snooze", "Close", "Keep"].map(action),
      onChange: render
    });
    listHost.replaceChildren(list);
  };
  render();
  const pinned = listHost.querySelector(".pinned-state");
  const currentWindow = listHost.querySelector(".item-badge");
  check(pinned && getComputedStyle(pinned).display !== "none" &&
    getComputedStyle(pinned).color === getComputedStyle(currentWindow).color,
  "Pinned remains visible in clean row mode and shares the current-window accent",
  JSON.stringify({
    pinned: Boolean(pinned),
    pinnedDisplay: pinned ? getComputedStyle(pinned).display : null,
    pinnedColor: pinned ? getComputedStyle(pinned).color : null,
    currentColor: currentWindow ? getComputedStyle(currentWindow).color : null
  }));
  const overlayStyle = getComputedStyle(document.querySelector(".hero-search-overlay"));
  check(overlayStyle.borderTopColor !== "rgba(0, 0, 0, 0)" &&
    !overlayStyle.clipPath.startsWith("inset(0px"),
  "Search content starts with a neutral separator and no clipped focus-ring stub",
  JSON.stringify({ borderTopColor: overlayStyle.borderTopColor, clipPath: overlayStyle.clipPath }));
  const target = listHost.querySelectorAll(".trow")[18];
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
  check(renderCount === 2, "row selection performs one list replacement", String(renderCount));
  check(Math.abs(afterScroll - beforeScroll) <= 1 && Math.abs(afterTop - beforeTop) <= 1,
    "row selection preserves scroll and the selected row's viewport position",
    JSON.stringify({ beforeScroll, afterScroll, beforeTop, afterTop }));

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
