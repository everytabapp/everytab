import * as planner from "../js/lib/close-day-planner.js";
import { coalesce } from "../js/ui/dom.js";
import { createBrowserI18nMock } from "./i18n-browser-mock.mjs";

globalThis.chrome = { ...(globalThis.chrome ?? {}), i18n: await createBrowserI18nMock() };
const { createCloseDaySurface } = await import("../js/ui/close-day-surface.js");

const result = document.querySelector("#result");
const host = document.querySelector("#host");
const checks = [];

function check(condition, name, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
}

const wait = async () => {
  for (let index = 0; index < 48; index += 1) await Promise.resolve();
};
const waitUntil = async (predicate, timeoutMs = 1_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const buttonNamed = (name) => [...host.querySelectorAll("button")]
  .find((button) => button.textContent.trim() === name);

try {
  const now = Date.now();
  const ref = (url, title) => ({ url, title, favIconUrl: "", pinned: false, group: null });
  const sessions = {
    sessionA: { id: "sessionA", name: "Client review", auto: false, modifiedAt: now,
      windows: [[ref("https://example.com/a", "Saved A"), ref("https://example.com/missing", "Absent")]] },
    sessionB: { id: "sessionB", name: "Reading", auto: false, modifiedAt: now,
      windows: [[ref("https://example.com/reading", "Reading")]] }
  };
  const windows = [{ id: 1, tabs: [
    { id: 11, windowId: 1, index: 0, title: "Saved A", rawUrl: "https://example.com/a",
      ref: ref("https://example.com/a", "Saved A"), active: true },
    { id: 12, windowId: 1, index: 1, title: "New research", rawUrl: "https://example.com/new",
      ref: ref("https://example.com/new", "New research") }
  ] }, { id: 2, tabs: [
    { id: 21, windowId: 2, index: 0, title: "Loose tab", rawUrl: "https://example.com/loose",
      ref: ref("https://example.com/loose", "Loose tab"), active: true },
    { id: 22, windowId: 2, index: 1, title: "Pinned reference", rawUrl: "https://example.com/pinned",
      ref: ref("https://example.com/pinned", "Pinned reference"), pinned: true },
    { id: 23, windowId: 2, index: 2, title: "Chrome settings", rawUrl: "chrome://settings",
      ref: null }
  ] }];
  let plan = planner.buildCloseDayPlan({
    windows, sessions, inbox: {}, archive: { archivedResearch: {
      id: "archivedResearch", modifiedAt: now, labels: [],
      tabs: [{ ...ref("https://example.com/new", "New research"), labels: ["web_design", "to_buy"] }]
    } }, bindings: { 1: { sessionId: "sessionA", windowIndex: 0 } },
    extensionOrigin: "chrome-extension://fixture/", protectedTabId: null
  });
  // A resumable v0.8.325 draft persisted the active tab title as the window
  // heading. The mounted surface must derive Window N instead of trusting it.
  for (const group of plan.groups) if (!group.session) group.title = "New Tab";
  const legacyPlan = structuredClone(plan);
  delete legacyPlan.labels;
  const messages = [];
  let holdChoice = false;
  let releaseChoice = null;
  let surface;
  const renderSurface = coalesce(async () => host.replaceChildren(await surface.render()));
  const msg = async (message) => {
    messages.push(message.type);
    if (message.type === "close-day-status") return {
      draft: { id: "legacy-draft", plan: legacyPlan }, pending: null, latest: null
    };
    if (message.type === "close-day-capture") return { ok: true, draftId: "draft", plan };
    if (message.type === "close-day-check") return {
      ok: true, fresh: true, browserChanged: false, savedChanged: false
    };
    if (message.type === "close-day-choice") {
      if (holdChoice) await new Promise((resolve) => { releaseChoice = resolve; });
      const ok = planner.applyCloseDayChoice(plan, message.fingerprintKey, message.patch);
      return { ok, plan };
    }
    if (message.type === "close-day-bulk-choice") {
      const ok = planner.applyCloseDayChoices(plan, message.fingerprintKeys, message.patch);
      return { ok, plan };
    }
    if (message.type === "close-day-window-mode") {
      const ok = planner.applyCloseDayWindowMode(plan, message.windowId, message.mode);
      return { ok, plan };
    }
    if (message.type === "close-day-commit") return { ok: true, receipt: {
      id: "receipt", phase: "complete", updatedAt: Date.now(), result: { closed: 3, skipped: 0 }
    } };
    if (message.type === "close-day-undo") return { ok: true, receipt: {
      id: "receipt", phase: "undone", updatedAt: Date.now(), reopenResult: { reopened: 3 },
      storeUndo: { conflicts: 0 }
    } };
    throw new Error(`Unexpected message ${message.type}`);
  };
  surface = createCloseDaySurface({ msg, rerender: renderSurface, showNotice: () => {},
    onNavigate: () => {}, onLeave: () => {}, decisionTimeoutMs: 60_000 });
  await renderSurface();
  await wait();
  check(messages.filter((type) => type === "close-day-capture").length === 1,
    "a resumable draft without the current label catalogue is upgraded before its picker opens");

  await surface.checkFreshness();
  await wait();
  check(!host.textContent.includes("The browser changed"),
    "focus or app switching does not stale an unchanged review");

  const headings = [...host.querySelectorAll(".close-day-stage h3")].map((node) => node.textContent);
  check(headings.join("|") === "Restored Session windows|Regular windows|Tabs staying open",
    "review uses the approved three-stage hierarchy");
  check(host.querySelectorAll(".close-day-window").length === 3,
    "restored, ordinary, and exception tabs remain grouped by source window");
  const stageLinks = [...host.querySelectorAll(".close-day-stage-link")];
  const stageLinkText = stageLinks.map((node) => node.textContent.replace(/\s+/g, " ").trim()).join("|");
  check(stageLinkText === "Sessions2|Regular windows1|Staying open2",
    "the sticky summary uses tab counts for every stage", stageLinkText);
  const stageNav = host.querySelector(".close-day-stage-nav");
  check(stageNav.scrollWidth <= stageNav.clientWidth + 1,
    "all three section links remain visible without a hidden horizontal scroll",
    `${stageNav.scrollWidth}/${stageNav.clientWidth}`);
  check(host.textContent.includes("1 saved but not open") && host.textContent.includes("1 new"),
    "Session header distinguishes absent saved refs from new live tabs");
  const ordinaryCard = [...host.querySelectorAll(".close-day-window")]
    .find((card) => card.textContent.includes("Loose tab"));
  check(ordinaryCard?.querySelector(".close-day-window-copy h4")?.textContent === "Window 2",
    "ordinary groups use a stable browser window name instead of one tab title");
  check(ordinaryCard?.querySelector(".close-day-window-heading-row .close-day-window-bulk") &&
    !ordinaryCard.querySelector(".close-day-bulk-idle") &&
    ordinaryCard.querySelectorAll(".close-day-bulk-action").length,
  "the window heading owns one visible all-window action rail without an instruction row");
  const archivedRow = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("New research"));
  check([...archivedRow.querySelectorAll(".close-day-labels .chip")].map((chip) => chip.textContent)
    .join("|") === "web_design|to_buy",
  "Archive labels use the ordinary row-chip grammar");
  const savedLabelStyle = getComputedStyle(archivedRow.querySelector(".close-day-labels .chip"));
  check(savedLabelStyle.backgroundColor !== "rgba(0, 0, 0, 0)" &&
    savedLabelStyle.borderColor !== "rgba(0, 0, 0, 0)" &&
    archivedRow.querySelector(".close-day-labels .chip").classList.contains("is-accented"),
  "saved labels use the stronger accent treatment without moving from the subline");
  check(archivedRow.querySelector('.close-day-action-option[data-action="close"]')
    ?.getAttribute("aria-label") === "Close. Already saved with labels",
  "an Archive close choice explains the saved-label state without repeating names");
  check([...host.querySelectorAll('.close-day-action-option[aria-label^="Close without a permanent saved copy"]')].length,
    "unsaved rows expose a direct close-without-saving choice");
  const looseRow = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"));
  check(!looseRow.querySelector('.close-day-action-option[data-action="close"]'),
    "an unsaved tab never claims to be already kept");
  check(host.querySelector(".close-day-summary").compareDocumentPosition(
    host.querySelector(".close-day-stage")) & Node.DOCUMENT_POSITION_FOLLOWING,
  "the save-and-close summary precedes the review groups");
  await frame();
  const summaryRect = host.querySelector(".close-day-summary").getBoundingClientRect();
  const firstStageHeadingRect = host.querySelector(".close-day-stage h3").getBoundingClientRect();
  check(firstStageHeadingRect.top >= summaryRect.bottom + 4,
    "the sticky summary does not cover the first review heading",
    `${firstStageHeadingRect.top}/${summaryRect.bottom}`);
  const capStyle = getComputedStyle(host.querySelector(".close-day-window-head"));
  check(Number.parseFloat(capStyle.borderTopLeftRadius) > 0 &&
    Number.parseFloat(getComputedStyle(host.querySelector(".close-day-window")).borderTopWidth) === 0,
  "the sticky cap owns its rounded upper frame without a square parent border");
  document.documentElement.style.setProperty("--section-local-h", `${summaryRect.height}px`);
  document.body.style.paddingBottom = "180px";
  const capShell = host.querySelector(".close-day-window-head-shell");
  const capStickyTop = Number.parseFloat(getComputedStyle(capShell).top);
  window.scrollTo(0, Math.max(0,
    window.scrollY + capShell.getBoundingClientRect().top - capStickyTop + 10));
  await frame();
  const stuckSummary = host.querySelector(".close-day-summary").getBoundingClientRect();
  const stuckCap = capShell.getBoundingClientRect();
  const stickyGap = stuckCap.top - stuckSummary.bottom;
  check(stickyGap >= 15 && stickyGap <= 19,
    "a sticky ledger cap keeps the regular 16px section gap below the sticky summary",
    `${stuckCap.top}/${stuckSummary.bottom}`);
  check(getComputedStyle(host.querySelector(".close-day-summary"), "::after").backgroundImage !== "none" ||
    getComputedStyle(host.querySelector(".close-day-summary"), "::after").backgroundColor !== "rgba(0, 0, 0, 0)",
  "the sticky summary owns an opaque halo so passing rows cannot bleed around it");
  const bottomMask = getComputedStyle(host.querySelector(".close-day-summary"), "::before");
  check(Number.parseFloat(bottomMask.height) >= stickyGap + 2 &&
    bottomMask.backgroundColor !== "rgba(0, 0, 0, 0)",
    "the summary mask overlaps both edges of the breathing gap so no text antialias can bleed through");
  const capGapMask = getComputedStyle(capShell, "::before");
  check(Number.parseFloat(capGapMask.top) <= -stickyGap + 1 &&
    Number.parseFloat(capGapMask.height) >= stickyGap +
      Number.parseFloat(getComputedStyle(capShell.querySelector(".close-day-window-head")).borderTopLeftRadius) &&
    capGapMask.backgroundColor !== "rgba(0, 0, 0, 0)",
  "each sticky window cap paints the complete gap above it, including its rounded corners");
  check(Number.parseFloat(getComputedStyle(capShell.querySelector(".close-day-window-head"))
    .borderTopLeftRadius) > 0, "the stuck ledger cap keeps its rounded top corners");
  window.scrollTo(0, 0);
  await frame();
  document.body.style.paddingBottom = "";

  if (new URL(location.href).searchParams.has("review")) {
    result.dataset.status = "pass";
    result.textContent = `READY: ${checks.length} initial Close-the-day checks`;
  } else {
  const replaceWidth = buttonNamed("Replace saved arrangement").getBoundingClientRect().width;
  buttonNamed("Replace saved arrangement").click();
  await wait();
  check(host.querySelector(".close-day-replace-confirm") && buttonNamed("Replace saved arrangement") &&
    buttonNamed("Keep saved arrangement"),
    "Session replacement opens an explicit, stable confirmation");
  check(host.querySelector(".close-day-replace-confirm").getBoundingClientRect().width >= replaceWidth,
    "Session replacement confirmation has a deliberate header-owned layout");
  buttonNamed("Replace saved arrangement").click();
  await wait();
  check(host.textContent.includes("Open tabs will replace the saved arrangement") &&
    buttonNamed("Keep saved arrangement"),
  "confirmed replacement names both states and offers an understandable reversal");

  const firstAction = host.querySelector(".close-day-action-set");
  check(firstAction && !host.querySelector("select.close-day-action"),
    "tab choices use the shared icon action vocabulary instead of a native dropdown");
  check([...host.querySelectorAll(".close-day-action-option")].every((button) =>
    button.classList.contains("tip") && button.querySelector(".ic")),
  "every action uses the same centred icon and fast product tooltip grammar");
  check(host.querySelector('.close-day-action-option[data-action="stay"]')?.dataset.icon === "eye",
    "Leave open uses the explicit eye icon instead of the ambiguous pin");
  check(!host.querySelector(".close-day-choice-current") &&
    host.querySelector(".close-day-action-copy")?.textContent.startsWith("Action: "),
  "the selected action moves into the ordinary row copy instead of a second full-width band");
  check(host.querySelector('.close-day-row .close-day-action-option[data-action="close"]')
    ?.getAttribute("aria-label")?.includes("Session “Client review”"),
  "an already-saved close choice names the durable destination");
  const actionSetStyle = getComputedStyle(firstAction);
  check(Number.parseFloat(actionSetStyle.borderTopWidth) > 0 &&
    firstAction.getBoundingClientRect().height <= 36,
  "one compact continuous toolbar fits the ordinary row density");

  const ordinaryHeader = ordinaryCard.querySelector(".close-day-window-head");
  const headerCheckbox = ordinaryHeader.querySelector(".close-day-window-select");
  const ordinaryFirstRowCheckbox = ordinaryCard.querySelector(".close-day-row-select");
  check(Math.abs(headerCheckbox.getBoundingClientRect().left -
    ordinaryFirstRowCheckbox.getBoundingClientRect().left) <= 1,
  "the window checkbox uses the same leading column as ordinary row checkboxes");
  check(ordinaryHeader.querySelector(".close-day-bulk-actions + .close-day-bulk-scope"),
    "the all-tabs or selected-tabs scope sits directly beside the header actions");
  const sessionHeader = host.querySelector(".close-day-window-head");
  const sessionBulkActions = sessionHeader.querySelector(".close-day-bulk-actions");
  const sessionBulkScope = sessionHeader.querySelector(".close-day-bulk-scope");
  const sessionActionsRect = sessionBulkActions.getBoundingClientRect();
  const sessionScopeRect = sessionBulkScope.getBoundingClientRect();
  check(Math.abs((sessionActionsRect.top + sessionActionsRect.height / 2) -
    (sessionScopeRect.top + sessionScopeRect.height / 2)) <= 2,
  "even the longest Session action set keeps its scope text on the same compact line");
  if (innerWidth > 760) check(ordinaryHeader.getBoundingClientRect().height <= 54,
    "a normal window header stays at shared compact ledger density");

  document.body.style.paddingBottom = "480px";
  const stayingOpenLink = host.querySelector('.close-day-stage-link[data-stage-target="staying-open"]');
  stayingOpenLink.click();
  await frame();
  check(stayingOpenLink.getAttribute("aria-current") === "true" && scrollY > 0,
    "stage navigation scrolls to a section and updates the active lens");
  const otherStage = host.querySelector('[data-close-day-stage="regular"]');
  const currentSummary = host.querySelector(".close-day-summary").getBoundingClientRect();
  window.scrollTo(0, Math.max(0, window.scrollY + otherStage.getBoundingClientRect().top -
    currentSummary.bottom - 16));
  await frame();
  await frame();
  check(host.querySelector('.close-day-stage-link[data-stage-target="regular"]')
    ?.getAttribute("aria-current") === "true",
  "ordinary scrolling updates the active section link without a rerender");
  window.scrollTo(0, 0);
  await frame();
  document.body.style.paddingBottom = "";

  const commitButton = buttonNamed("Close the day");
  commitButton.focus();
  const enterRows = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  commitButton.dispatchEvent(enterRows);
  const firstRowCheckbox = host.querySelector('.close-day-row-select:not(:disabled)');
  check(enterRows.defaultPrevented && document.activeElement === firstRowCheckbox,
    "an arrow from the Close-the-day chrome enters the first row checkbox");
  const enterActions = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  firstRowCheckbox.dispatchEvent(enterActions);
  check(enterActions.defaultPrevented && document.activeElement?.matches(".close-day-action-option"),
    "right from a row checkbox enters that row action lane");
  const nextRowEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  const firstActionColumn = document.activeElement.dataset.action;
  document.activeElement.dispatchEvent(nextRowEvent);
  check(nextRowEvent.defaultPrevented &&
    document.activeElement?.matches(`.close-day-action-option[data-action="${firstActionColumn}"]`) &&
    document.activeElement.closest("[data-close-day-row]") !== firstRowCheckbox.closest("[data-close-day-row]"),
    "up and down retain the action column across rows instead of returning to the checkbox");

  const clickRow = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("New research")).querySelector(".close-day-copy");
  clickRow.click();
  await wait();
  check([...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("New research"))
    ?.querySelector(".close-day-row-select")?.checked,
  "clicking the non-interactive part of a row selects it");
  [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("New research"))?.querySelector(".close-day-copy")?.click();
  await wait();
  const firstSelected = host.querySelector('.close-day-action-set [role="radio"][aria-checked="true"]');
  firstSelected.focus();
  const scrollBeforeKeys = scrollY;
  const rightEvent = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  firstSelected.dispatchEvent(rightEvent);
  const nextAction = document.activeElement;
  check(rightEvent.defaultPrevented && nextAction?.getAttribute("role") === "radio" &&
    nextAction !== firstSelected && scrollY === scrollBeforeKeys,
  "left and right arrows move through tab actions without scrolling the page");
  nextAction.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  check(messages.filter((type) => type === "close-day-choice").length >= 1,
    "Enter applies the focused tab action");

  const looseBeforeSave = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"));
  const summaryHeightBeforeChoice = host.querySelector(".close-day-summary").getBoundingClientRect().height;
  const summaryTextBeforeChoice = host.querySelector(".close-day-summary").innerText;
  const looseTopBeforeChoice = looseBeforeSave.getBoundingClientRect().top;
  looseBeforeSave.querySelector('.close-day-action-option[data-action="close-unfiled"]').click();
  await wait();
  await frame();
  const looseAfterUnfiled = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"));
  const summaryHeightAfterChoice = host.querySelector(".close-day-summary")
    .getBoundingClientRect().height;
  const summaryTextAfterChoice = host.querySelector(".close-day-summary").innerText;
  const looseTopAfterChoice = looseAfterUnfiled.getBoundingClientRect().top;
  check(Math.abs(summaryHeightAfterChoice - summaryHeightBeforeChoice) < 1 &&
    Math.abs(looseTopAfterChoice - looseTopBeforeChoice) < 1,
  `changing a choice cannot resize the sticky summary or jump the clicked row ` +
    `(summary ${summaryHeightBeforeChoice}→${summaryHeightAfterChoice}, ` +
    `row ${looseTopBeforeChoice}→${looseTopAfterChoice}; ` +
    `${summaryTextBeforeChoice.replaceAll("\n", " / ")} → ` +
    `${summaryTextAfterChoice.replaceAll("\n", " / ")})`);
  looseAfterUnfiled.querySelector('.close-day-action-option[data-action="inbox"]').click();
  await wait();
  const looseChoice = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"))
    .querySelector('.close-day-action-option[data-action="stay"]');
  holdChoice = true;
  looseChoice.click();
  await wait();
  await frame();
  const liveLoose = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"));
  check(liveLoose.querySelector('.close-day-action-option[data-action="stay"]')
    ?.getAttribute("aria-checked") === "true",
  "a tab choice paints immediately before its background save completes");
  const optimisticStay = liveLoose.querySelector('.close-day-action-option[data-action="stay"]');
  check(document.activeElement === optimisticStay,
    "the optimistic choice keeps keyboard focus on its selected action");
  releaseChoice?.();
  holdChoice = false;
  await wait();
  await frame();
  const settledLoose = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab"));
  check(document.activeElement === settledLoose
    .querySelector('.close-day-action-option[data-action="stay"]'),
  "the serialized save keeps focus on the equivalent settled action");

  let sessionCard = [...host.querySelectorAll(".close-day-window")]
    .find((card) => card.textContent.includes("Client review"));
  const selectWindow = sessionCard.querySelector(".close-day-window-select");
  check(selectWindow, "each window header offers one select-all control for bulk choices");
  selectWindow.click();
  await wait();
  await frame();
  sessionCard = [...host.querySelectorAll(".close-day-window")]
    .find((card) => card.textContent.includes("Client review"));
  check(sessionCard.querySelector(".close-day-window-bulk")?.textContent.includes("2 selected"),
    "a window header exposes one bulk action rail for its selected tabs");
  const bulkButtons = [...sessionCard.querySelectorAll(".close-day-bulk-action")];
  bulkButtons[0].focus();
  const bulkArrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  bulkButtons[0].dispatchEvent(bulkArrow);
  check(bulkArrow.defaultPrevented && document.activeElement === bulkButtons[1],
    "arrow keys move through the window bulk actions without scrolling");
  const bulkSession = sessionCard.querySelector('.close-day-bulk-action[data-action="session"]');
  bulkSession.click();
  await waitUntil(() => [...document.querySelectorAll(".action-popover [role=option]")]
    .some((option) => option.textContent.trim() === "Reading"));
  const sessionInput = document.querySelector('input[aria-label="Session for selected tabs"]');
  const sessionOptions = [...document.querySelectorAll(".action-popover [role=option]")]
    .map((option) => option.textContent.trim());
  check(sessionInput && sessionOptions.includes("Reading"),
  "Session filing uses the shared searchable suggestion popover rather than a select menu",
  `input=${Boolean(sessionInput)} focused=${document.activeElement === sessionInput} expanded=${sessionInput?.getAttribute("aria-expanded")} options=${sessionOptions.join("|")} sessions=${(plan.sessions ?? []).map((session) => session.name).join("|")}`);
  [...document.querySelectorAll(".action-popover [role=option]")]
    .find((option) => option.textContent.trim() === "Reading")
    ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await wait();
  await frame();
  check([...host.querySelectorAll(".close-day-action-copy")]
    .filter((copy) => copy.textContent.includes("Session “Reading”")).length === 2,
  "a picked Session is named in every affected row outcome");
  sessionCard = [...host.querySelectorAll(".close-day-window")]
    .find((card) => card.textContent.includes("Client review"));
  sessionCard.querySelector(".close-day-window-select").click();
  await wait();
  await frame();
  sessionCard = [...host.querySelectorAll(".close-day-window")]
    .find((card) => card.textContent.includes("Client review"));
  const bulkLabel = sessionCard.querySelector('.close-day-bulk-action[data-action="archive-label"]');
  bulkLabel.click();
  await waitUntil(() => document.querySelector('input[aria-label="Label selected tabs"]'));
  const bulkInput = document.querySelector('input[aria-label="Label selected tabs"]');
  check(bulkInput, "Label selected tabs asks for the label once in the window header");
  bulkInput.value = "web";
  bulkInput.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
  check([...document.querySelectorAll(".action-popover [role=option]")]
    .some((option) => option.textContent.trim() === "web_design"),
  "Label filing reuses existing label suggestions in the searchable popover");
  bulkInput.value = "Project";
  bulkInput.dispatchEvent(new Event("input", { bubbles: true }));
  bulkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  bulkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  check(messages.includes("close-day-bulk-choice"),
    "one atomic bulk message applies the shared label choice to the selection");
  check([...host.querySelectorAll(".close-day-action-copy")]
    .filter((copy) => copy.textContent.includes("label “Project”")).length === 2,
  "a picked label is named in every affected row outcome");

  const commitStyle = getComputedStyle(buttonNamed("Close the day"));
  const accentProbe = document.body.appendChild(document.createElement("span"));
  accentProbe.style.color = "var(--accent-text)";
  const accent = getComputedStyle(accentProbe).color;
  accentProbe.remove();
  check(commitStyle.color === accent,
    "Close the day uses the contrast-safe primary accent for its resting text",
    `${commitStyle.color}/${accent}`);
  const openActionHost = document.body.appendChild(document.createElement("div"));
  openActionHost.className = "section-actions";
  const openActionProbe = openActionHost.appendChild(document.createElement("button"));
  openActionProbe.className = "mini2 section-primary-action";
  openActionProbe.textContent = "Close the day";
  check(getComputedStyle(openActionProbe).color === accent,
    "the Open-tabs Close-the-day action uses the same resting accent text");
  openActionHost.remove();

  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    "the full review has no horizontal overflow",
    `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);
  const row = host.querySelector(".close-day-row");
  check(row && row.getBoundingClientRect().width <= host.getBoundingClientRect().width,
    "review rows stay within the workbench axis");

  buttonNamed("Close the day").click();
  await wait();
  check(buttonNamed("Save first, then close 2 tabs"), "final close is a truthful P4 second step");
  buttonNamed("Save first, then close 2 tabs").click();
  await wait();
  check(host.textContent.includes("The day is closed") && buttonNamed("Undo Close the day"),
    "successful completion replaces the review with receipt-backed Undo");
  check(buttonNamed("Start another review"), "completion always offers another review");
  buttonNamed("Undo Close the day").click();
  await wait();
  check(host.textContent.includes("Close the day undone"), "Undo has a distinct terminal result");
  check(messages.filter((type) => type === "close-day-commit").length === 1,
    "the P4 flow emits exactly one close transaction");

    result.dataset.status = "pass";
    result.textContent = `PASS: ${checks.length} Close-the-day mounted checks`;
  }
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack || error}`;
}
