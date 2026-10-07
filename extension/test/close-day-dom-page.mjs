import * as planner from "../js/lib/close-day-planner.js";
import { coalesce } from "../js/ui/dom.js";
import { createBrowserI18nMock } from "./i18n-browser-mock.mjs";

const organizationStores = { organizationGroups: {}, organizationMemberships: {}, sessions: {} };
globalThis.chrome = {
  ...(globalThis.chrome ?? {}),
  i18n: await createBrowserI18nMock(),
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .map((key) => [key, structuredClone(organizationStores[key])])),
      set: async (patch) => Object.assign(organizationStores, structuredClone(patch))
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};
const { createCloseDaySurface, reviewDestinationOptions } =
  await import("../js/ui/close-day-surface.js");

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
    windows, sessions, inbox: {}, archive: {
      archivedResearch: {
        id: "archivedResearch", modifiedAt: now, labels: [],
        tabs: [{ ...ref("https://example.com/new", "New research"), labels: ["web_design", "to_buy"] }]
      },
      archivedSaved: {
        id: "archivedSaved", modifiedAt: now, labels: [],
        tabs: [{ ...ref("https://example.com/a", "Saved A"), labels: ["project"] }]
      }
    }, bindings: { 1: { sessionId: "sessionA", windowIndex: 0 } },
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
  let openedSessionId = "";
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
    onNavigate: () => {}, onSessionOpen: (id) => { openedSessionId = id; },
    onLeave: () => {}, decisionTimeoutMs: 60_000 });
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
  const multiplySavedRow = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Saved A"));
  const savedLabelChip = multiplySavedRow.querySelector(".close-day-labels .chip");
  const savedSessionLink = multiplySavedRow.querySelector(".session-membership-link");
  savedSessionLink.click();
  check(savedLabelChip?.textContent === "project" &&
    multiplySavedRow.querySelector(".session-memberships")?.textContent === "In Session:Client review" &&
    openedSessionId === "sessionA",
  "a Close-the-day row distinguishes its label from a linked named Session membership");
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
  const shortcutPairs = {
    close: "w", inbox: "i", snooze: "s", "add-session": "a",
    session: "t", "archive-label": "l", stay: "o", "close-unfiled": "w"
  };
  check([...host.querySelectorAll(".close-day-row .close-day-action-option")].every((button) =>
    button.dataset.shortcutKey === shortcutPairs[button.dataset.action] &&
    button.dataset.tip?.endsWith(` (${shortcutPairs[button.dataset.action].toUpperCase()})`)),
  "Close the day advertises shared action keys plus mnemonic keys for its local actions");
  check(!host.querySelector(".close-day-choice-current") &&
    host.querySelector(".close-day-action-copy")?.textContent.startsWith("Action: "),
  "the selected action moves into the ordinary row copy instead of a second full-width band");
  check(host.querySelector('.close-day-row .close-day-action-option[data-action="close"]')
    ?.getAttribute("aria-label")?.includes("Session “Client review”"),
  "an already-saved close choice names the durable destination");
  host.querySelector('.close-day-row .close-day-action-option[data-action="snooze"]')?.click();
  await waitUntil(() => document.querySelector(".action-popover .snoozebar"));
  check(document.querySelector('.action-popover input[type="datetime-local"]') &&
    document.querySelectorAll(".action-popover .palette-choice-grid button").length >= 5,
  "Close the day uses the complete shared Snooze picker with presets and Custom time");
  document.querySelector(".action-popover .action-popover-close")?.click();
  await wait();
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
    currentSummary.bottom - 8));
  const regularLink = host.querySelector('.close-day-stage-link[data-stage-target="regular"]');
  check(await waitUntil(() => regularLink?.getAttribute("aria-current") === "true"),
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
  const looseCopy = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("Loose tab")).querySelector(".close-day-copy");
  looseCopy.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await wait();
  const ranged = [...host.querySelectorAll('.close-day-row-select:not(:disabled)')]
    .filter((checkbox) => checkbox.checked);
  check(ranged.length >= 2 && ranged[0].closest("[data-close-day-row]").textContent.includes("New research") &&
    ranged.at(-1).closest("[data-close-day-row]").textContent.includes("Loose tab"),
  "Shift-click selects the visual range from the last individually selected Close-the-day row");
  const rangeEnd = ranged.at(-1);
  rangeEnd.focus();
  const shiftX = new KeyboardEvent("keydown", {
    key: "X", code: "KeyX", shiftKey: true, bubbles: true, cancelable: true
  });
  rangeEnd.dispatchEvent(shiftX);
  await wait();
  check(shiftX.defaultPrevented &&
    [...host.querySelectorAll('.close-day-row-select:not(:disabled)')].every((checkbox) => !checkbox.checked),
  "Shift+X mirrors Shift-click and toggles the anchored range off from the keyboard");
  const shortcutOwner = [...host.querySelectorAll("[data-close-day-row]")]
    .find((row) => row.textContent.includes("New research"))
    .querySelector(".close-day-row-select");
  shortcutOwner.focus();
  const labelKey = new KeyboardEvent("keydown", { key: "l", code: "KeyL", bubbles: true, cancelable: true });
  shortcutOwner.dispatchEvent(labelKey);
  check(labelKey.defaultPrevented && await waitUntil(() =>
    Boolean(document.querySelector('input[aria-label^="Labels for"]'))),
  "a Close-the-day row action fires from its advertised key while the row owns focus");
  document.querySelector(".action-popover .action-popover-close")?.click();
  await wait();
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
  check(sessionCard.querySelectorAll(".close-day-row .close-day-action-option").length === 0 &&
    sessionCard.querySelectorAll(".close-day-bulk-action").length > 0,
  "multiple selected rows expose only the window bulk actions");
  const bulkButtons = [...sessionCard.querySelectorAll(".close-day-bulk-action")];
  const selectedHeaderCheckbox = sessionCard.querySelector(".close-day-window-select");
  selectedHeaderCheckbox.focus();
  const headerArrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  selectedHeaderCheckbox.dispatchEvent(headerArrow);
  check(headerArrow.defaultPrevented && document.activeElement === bulkButtons[0],
    "right arrow enters the window header action rail from its select-all control");
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
  const sessionOrganizer = document.querySelector('[data-inline-organization-editor="session"]');
  check(sessionOrganizer && !sessionOrganizer.textContent.includes("null") &&
    sessionOrganizer.textContent.includes("You can change them later in Sessions"),
  "Close the day keeps Session organization on the same screen with user-facing guidance");
  [...document.querySelectorAll(".action-popover button")]
    .find((button) => button.textContent.trim() === "Apply Session")?.click();
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
  await wait();
  const labelOrganizer = document.querySelector('[data-inline-organization-editor="label"]');
  check(labelOrganizer && !labelOrganizer.textContent.includes("null") &&
    labelOrganizer.textContent.includes("You can change them later in Labels"),
  "Close the day keeps Label organization on the same screen without implementation text");
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
  check(buttonNamed("Confirm actions for 2 tabs"),
    "the final P4 step confirms the reviewed actions without sounding like advice");
  buttonNamed("Confirm actions for 2 tabs").click();
  await wait();
  check(host.textContent.includes("The day is closed") && buttonNamed("Undo Close the day"),
    "successful completion replaces the review with receipt-backed Undo");
  check(buttonNamed("Start another review"), "completion always offers another review");
  buttonNamed("Undo Close the day").click();
  await wait();
  check(host.textContent.includes("Close the day undone"), "Undo has a distinct terminal result");
  check(messages.filter((type) => type === "close-day-commit").length === 1,
    "the P4 flow emits exactly one close transaction");

  buttonNamed("Start another review").click();
  await wait();
  const reusableRows = plan.groups.flatMap((group) => group.rows)
    .filter((entry) => entry.availableActions.includes(planner.CLOSE_DAY_ACTIONS.newSession));
  check(reusableRows.length >= 2, "the synthetic review has following tabs for destination reuse");
  const pendingSessionName = "Evening research";
  check(planner.applyCloseDayChoice(plan, reusableRows[0].fingerprintKey, {
    action: planner.CLOSE_DAY_ACTIONS.newSession, newSessionName: pendingSessionName
  }), "a new named Session choice can be recorded in the review draft");
  await renderSurface();
  const followingSessionAction = [...host.querySelectorAll("[data-close-day-row]")]
    .find((node) => node.dataset.closeDayRow === reusableRows[1].fingerprintKey)
    ?.querySelector('.close-day-action-option[data-action="session"]');
  check(followingSessionAction,
    "a following tab has a mounted Session picker action");
  followingSessionAction.click();
  await waitUntil(() => document.querySelector('.action-popover input[role="combobox"]'));
  check(document.querySelector('.action-popover input[role="combobox"]'),
    "the following Session picker opened");
  await waitUntil(() => [...document.querySelectorAll('.action-popover [role="option"]')]
    .some((node) => node.textContent.trim() === "Reading"));
  const pendingSessionOptions = [...document.querySelectorAll('.action-popover [role="option"]')]
    .map((node) => node.textContent.trim());
  check(pendingSessionOptions.includes(pendingSessionName),
    "a newly named Session is offered again for following tabs without retyping",
    pendingSessionOptions.join("|"));
  [...document.querySelectorAll('.action-popover [role="option"]')]
    .find((node) => node.textContent.trim() === pendingSessionName)
    ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await wait();
  [...document.querySelectorAll('.action-popover button')]
    .find((node) => node.textContent.trim() === "Apply Session")?.click();
  await wait();
  check(reusableRows[1].choice.action === planner.CLOSE_DAY_ACTIONS.newSession &&
    reusableRows[1].choice.newSessionName === pendingSessionName,
    "reusing the pending Session assigns the same new destination to the following tab");
  check(reviewDestinationOptions(plan).sessions.some((session) =>
    session.name === pendingSessionName), "the draft carries the reusable Session destination");
  let pendingBulkCard = [...host.querySelectorAll("[data-close-day-row]")]
    .find((node) => node.dataset.closeDayRow === reusableRows[1].fingerprintKey)
    ?.closest(".close-day-window");
  pendingBulkCard.querySelector(".close-day-window-select").click();
  await wait();
  pendingBulkCard = [...host.querySelectorAll("[data-close-day-row]")]
    .find((node) => node.dataset.closeDayRow === reusableRows[1].fingerprintKey)
    ?.closest(".close-day-window");
  pendingBulkCard.querySelector('.close-day-bulk-action[data-action="session"]').click();
  await waitUntil(() => [...document.querySelectorAll('.action-popover [role="option"]')]
    .some((node) => node.textContent.trim() === "Reading"));
  check([...document.querySelectorAll('.action-popover [role="option"]')]
    .some((node) => node.textContent.trim() === pendingSessionName),
    "the window bulk Session picker also offers the pending name",
    [...document.querySelectorAll('.action-popover [role="option"]')]
      .map((node) => node.textContent.trim()).join("|"));
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown",
    { key: "Escape", bubbles: true, cancelable: true }));
  await wait();
  pendingBulkCard.querySelector(".close-day-window-select").click();
  await wait();

  const reusableLabelRows = plan.groups.flatMap((group) => group.rows)
    .filter((entry) => entry.availableActions.includes(planner.CLOSE_DAY_ACTIONS.archiveLabel));
  check(reusableLabelRows.length >= 2, "the synthetic review has following tabs for Label reuse");
  const pendingLabelName = "evening_notes";
  check(planner.applyCloseDayChoice(plan, reusableLabelRows[0].fingerprintKey, {
    action: planner.CLOSE_DAY_ACTIONS.archiveLabel, labels: [pendingLabelName]
  }), "a new Label choice can be recorded in the review draft");
  await renderSurface();
  const followingLabelAction = [...host.querySelectorAll("[data-close-day-row]")]
    .find((node) => node.dataset.closeDayRow === reusableLabelRows[1].fingerprintKey)
    ?.querySelector('.close-day-action-option[data-action="archive-label"]');
  check(followingLabelAction, "a following tab has a mounted Label picker action");
  followingLabelAction.click();
  await waitUntil(() => document.querySelector('.action-popover input[role="combobox"]'));
  const labelInputForReuse = document.querySelector('.action-popover input[role="combobox"]');
  labelInputForReuse.value = "evening";
  labelInputForReuse.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
  const pendingLabelOptions = [...document.querySelectorAll('.action-popover [role="option"]')]
    .map((node) => node.textContent.trim());
  check(pendingLabelOptions.includes(pendingLabelName),
    "a newly named Label is offered again for following tabs without retyping",
    pendingLabelOptions.join("|"));
  [...document.querySelectorAll('.action-popover [role="option"]')]
    .find((node) => node.textContent.trim() === pendingLabelName)
    ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await wait();
  [...document.querySelectorAll('.action-popover button')]
    .find((node) => node.textContent.trim() === "Apply labels")?.click();
  await wait();
  check(reusableLabelRows[1].choice.action === planner.CLOSE_DAY_ACTIONS.archiveLabel &&
    reusableLabelRows[1].choice.labels.includes(pendingLabelName),
    "reusing the pending Label assigns the same name to the following tab");

  for (const uncertain of [false, true]) for (const restore of [false, true]) {
    const receipt = {
      id: "incomplete-receipt", phase: "undo-incomplete", updatedAt: Date.now(),
      reopenResult: uncertain
        ? { reopened: 0, expected: 3, uncertain: 3 }
        : { reopened: 2, expected: 3, failed: 1 },
      storeUndo: { conflicts: 0 }
    };
    const notices = [];
    const undoMessages = [];
    let finishUndo;
    surface = createCloseDaySurface({
      msg: async (message) => {
        undoMessages.push(message.type);
        if (message.type === "close-day-status") return {
          latest: restore ? receipt : {
            id: receipt.id, phase: "complete", updatedAt: Date.now(),
            result: { closed: 3, skipped: 0 }
          }
        };
        if (message.type === "close-day-undo") {
          if (undoMessages.filter((type) => type === "close-day-undo").length === 1) {
            return { ok: false, status: "busy" };
          }
          return new Promise((resolve) => { finishUndo = resolve; });
        }
        throw new Error(`Unexpected incomplete Undo message ${message.type}`);
      },
      rerender: renderSurface, showNotice: (notice) => notices.push(notice),
      onNavigate: () => {}, onLeave: () => {}
    });
    await renderSurface();
    await wait();
    if (!restore) {
      buttonNamed("Undo Close the day").click();
      await wait();
      check(notices.at(-1) === "Undo is already in progress." &&
        host.textContent.includes("The day is closed"),
      "a concurrent Undo reports busy without claiming success");
      buttonNamed("Undo Close the day").click();
      await wait();
      finishUndo({ ok: false, status: "incomplete", receipt });
      await wait();
      await frame();
      check(document.activeElement === host.querySelector(".close-day-complete h3"),
        "an asynchronous incomplete Undo focuses its result heading");
    }
    const context = `${restore ? "restored" : "asynchronous"} ${uncertain ? "uncertain" : "partial"} Undo`;
    check(host.textContent.includes("Undo did not finish") &&
      !host.textContent.includes("Close the day undone") && !host.textContent.includes("The day is closed"),
    `${context} renders the incomplete outcome instead of a success receipt`);
    check(host.textContent.includes(uncertain
      ? "0 of 3 saved addresses confirmed reopened. EveryTab could not confirm the rest."
      : "2 of 3 saved addresses reopened. Some addresses could not be reopened."),
    `${context} uses confirmed counts and distinguishes unknown browser effects`);
    check(!buttonNamed("Undo Close the day") && buttonNamed("Start another review"),
      `${context} cannot replay browser creation and retains the next review action`);
    check(undoMessages.filter((type) => type === "close-day-undo").length === (restore ? 0 : 2),
      `${context} never replays Undo while rendering its receipt`);
  }

    result.dataset.status = "pass";
    result.textContent = `PASS: ${checks.length} Close-the-day mounted checks`;
  }
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack || error}`;
}
