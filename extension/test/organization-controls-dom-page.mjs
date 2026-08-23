import { createBrowserI18nMock } from "./browser-message-fixture.js";

const result = document.querySelector("#result");
const host = document.querySelector("#host");
const checks = [];
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const memory = { organizationGroups: {}, organizationMemberships: {}, journal: [] };
const listeners = new Set();

function selected(keys) {
  if (keys == null) return clone(memory);
  if (typeof keys === "string") return memory[keys] === undefined ? {} : { [keys]: clone(memory[keys]) };
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => memory[key] !== undefined)
    .map((key) => [key, clone(memory[key])]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(memory[key] ?? fallback)]));
}

globalThis.chrome = {
  i18n: await createBrowserI18nMock(),
  storage: {
    local: {
      get: async (keys) => selected(keys),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: clone(memory[key]), newValue: clone(value) };
          memory[key] = clone(value);
        }
        queueMicrotask(() => listeners.forEach((listener) => listener(changes, "local")));
      },
      remove: async (keys) => { for (const key of [].concat(keys)) delete memory[key]; }
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  },
  runtime: { getURL: (path) => path }
};
Object.defineProperty(navigator, "locks", { configurable: true, value: {
  request: async (_name, options, callback) => callback(options?.ifAvailable ? {} : {})
} });

function check(condition, name, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
}
const wait = async () => {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
};
const waitSettled = async () => {
  await wait();
  await wait();
  for (let frame = 0; frame < 4; frame += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};
const buttonNamed = (root, name) => [...root.querySelectorAll("button")]
  .find((button) => button.textContent.trim() === name);

try {
  const stage = (name) => { result.textContent = `RUNNING: ${name}`; };
  stage("imports");
  const [{ createIndexBar }, { createAnchoredPanel }, organization, controlsModule, { coalesce }] = await Promise.all([
    import("../js/ui/indexbar.js"),
    import("../js/ui/tablist.js"),
    import("../js/lib/organization.js"),
    import("../js/ui/organization-controls.js"),
    import("../js/ui/dom.js")
  ]);
  await organization.createOrganizationGroup("label", "Work", ["Research"]);
  await organization.createOrganizationGroup("label", "Personal", []);
  const members = [{ label: "Research", tabs: 3 }, { label: "Inbox", tabs: 1 }];
  const state = await organization.readOrganizationState("label");
  const projection = organization.projectOrganization("label", members, state,
    { memberKey: (member) => member.label });
  const work = projection.groups.find((entry) => entry.name === "Work");
  let lensTarget = null;
  let refreshes = 0;
  const controls = controlsModule.createOrganizationControls({
    kind: "label", members, memberKey: (member) => member.label,
    projection, activeLens: work.id,
    onLensChange: (id) => { lensTarget = id; },
    onChange: () => { refreshes++; }
  });
  const index = createIndexBar({
    placeholder: "Filter labels…", filterAria: "Filter labels", items: [
      { key: "Research", text: "Research", count: 3 }
    ], onJump: () => {}, groupRow: controls.groupRow
  });
  host.append(index);
  check(index.children[1]?.classList.contains("organization-row"),
    "group row follows filter and sort");
  check(index.children[2]?.classList.contains("label-chip-line"),
    "item jumps follow the group row");
  check(buttonNamed(index, "Work1")?.classList.contains("on"),
    "active group is explicit with its count");
  buttonNamed(index, "Ungrouped1")?.click();
  check(lensTarget === controlsModule.UNGROUPED_ORGANIZATION_LENS,
    "Ungrouped selects the projected zero-membership lens");
  check(index.scrollWidth <= index.clientWidth + 1,
    "group rail contains its pressure instead of widening the page",
    `${index.scrollWidth}/${index.clientWidth}`);

  let popover = null;
  buttonNamed(index, "Add labels")?.click();
  stage("active picker");
  await wait();
  popover = document.querySelector(".action-popover");
  const internalScroller = popover.querySelector(".organization-checks");
  internalScroller.dispatchEvent(new Event("scroll"));
  await wait();
  check(popover.isConnected && popover.matches(":popover-open"),
    "scrolling choices inside Add labels keeps the anchored palette open");
  const nestedNew = buttonNamed(popover, "+ New group");
  check(nestedNew, "active-group member picker can create another group");
  nestedNew.click();
  await wait();
  check(document.activeElement === popover.querySelector(".organization-name-input"),
    "nested New group moves focus to its revealed name field");
  popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait();

  buttonNamed(index, "+ Group")?.click();
  stage("root create");
  await wait();
  popover = document.querySelector(".action-popover");
  check(popover?.querySelector(".organization-name-input"),
    "new group uses the shared anchored top-layer palette");
  popover.querySelector(".organization-name-input").value = "Projects";
  const lensBeforeCreate = lensTarget;
  buttonNamed(popover, "Create group")?.click();
  await wait();
  check(Object.values(memory.organizationGroups).some((group) => group.name === "Projects"),
    "anchored creation commits a real group");
  check(lensTarget === lensBeforeCreate,
    "creating an empty root group preserves the current populated lens");

  const slot = document.createElement("span");
  const opener = document.createElement("button");
  opener.textContent = "Groups…";
  slot.append(opener);
  host.append(slot);
  const panel = createAnchoredPanel(slot);
  panel.anchor(opener);
  controls.cardAction.run({ group: { data: members[0] }, panel });
  stage("card apply");
  await wait();
  popover = document.querySelector(".action-popover");
  const groupInput = popover?.querySelector(".organization-group-entry .taginput");
  check(groupInput && popover.querySelectorAll('.organization-check input[type="checkbox"]').length === 0,
    "card Groups uses one tag-style text entry instead of a checkbox ledger");
  check(popover.textContent.includes("Enter adds a group. Enter again applies."),
    "card Groups explains the two-Enter keyboard flow");
  groupInput.value = "Pers";
  groupInput.dispatchEvent(new Event("input", { bubbles: true }));
  check([...popover.querySelectorAll(".tagopt")].some((option) => option.textContent === "Personal"),
    "typing filters existing group suggestions");
  groupInput.value = "Personal";
  groupInput.dispatchEvent(new Event("input", { bubbles: true }));
  groupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  groupInput.value = "Inline group";
  groupInput.dispatchEvent(new Event("input", { bubbles: true }));
  groupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  check(!Object.values(memory.organizationGroups).some((group) => group.name === "Inline group"),
    "the first Enter keeps an unmatched group pending until Apply");
  check([...popover.querySelectorAll(".chip")].some((chip) => chip.textContent.includes("Personal")) &&
      [...popover.querySelectorAll(".chip")].some((chip) => chip.textContent.includes("Inline group")),
    "existing and newly created groups become pending chips");
  groupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitSettled();
  const changed = organization.projectOrganization("label", members,
    await organization.readOrganizationState("label"), { memberKey: (member) => member.label });
  check(Object.values(memory.organizationGroups).some((group) => group.name === "Inline group") &&
      changed.groupIdsByMemberKey.get("Research").size === 3,
    "one label belongs to multiple existing and newly created groups after the second Enter");

  buttonNamed(index, "Manage")?.click();
  stage("first delete");
  await wait();
  popover = document.querySelector(".action-popover");
  const danger = buttonNamed(popover, "Delete group");
  danger?.click();
  check(danger?.textContent === "Confirm delete", "group deletion uses a P4 second step");
  danger?.click();
  await wait();
  check(lensTarget === controlsModule.UNGROUPED_ORGANIZATION_LENS,
    "deleting the active group lands on Ungrouped");
  check(!Object.values(memory.organizationGroups).some((group) => group.name === "Work" && !group.deletedAt),
    "the P4 confirmation commits the active group tombstone");
  check(refreshes > 0, "successful mutations request a shared-surface refresh");

  const focusHost = document.createElement("section");
  host.append(focusHost);
  const sessionRow = document.createElement("div");
  sessionRow.className = "organization-row";
  sessionRow.setAttribute("aria-label", "Session groups");
  const sessionUngrouped = document.createElement("button");
  sessionUngrouped.dataset.organizationLens = controlsModule.UNGROUPED_ORGANIZATION_LENS;
  sessionUngrouped.textContent = "Ungrouped";
  sessionRow.append(sessionUngrouped);
  let focusLens = controlsModule.ALL_ORGANIZATION_LENS;
  let focusControls = null;
  let renderFocusFixture;
  const renderFocusBody = async () => {
    const nextState = await organization.readOrganizationState("label");
    const nextProjection = organization.projectOrganization("label", members, nextState,
      { memberKey: (member) => member.label });
    focusControls = controlsModule.createOrganizationControls({
      kind: "label", members, memberKey: (member) => member.label,
      projection: nextProjection, activeLens: focusLens,
      onLensChange: (id) => { focusLens = id; return renderFocusFixture(); },
      // Match a production storage refresh arriving while the explicit refresh
      // is in flight: coalesce one trailing render behind the returned promise.
      onChange: () => { const current = renderFocusFixture(); renderFocusFixture(); return current; },
      focusRoot: () => focusHost
    });
    const dummyCard = document.createElement("div");
    dummyCard.dataset.tablistCard = "label::Research";
    const dummyGroups = document.createElement("button");
    dummyGroups.dataset.actionId = "groups";
    dummyGroups.textContent = "Groups…";
    dummyCard.append(dummyGroups);
    focusHost.replaceChildren(sessionRow, focusControls.groupRow, dummyCard);
  };
  renderFocusFixture = coalesce(renderFocusBody);
  await renderFocusFixture();
  stage("focus lens");
  const focusUngrouped = [...focusHost.querySelectorAll("[data-organization-lens]")]
    .find((button) => button.dataset.organizationLens === controlsModule.UNGROUPED_ORGANIZATION_LENS &&
      button.closest(".organization-row")?.getAttribute("aria-label") === "Label groups");
  focusUngrouped.focus();
  focusUngrouped.click();
  await waitSettled();
  check(document.activeElement?.dataset.organizationLens === controlsModule.UNGROUPED_ORGANIZATION_LENS &&
      document.activeElement?.closest(".organization-row")?.getAttribute("aria-label") === "Label groups",
    "ordinary lens activation preserves focus inside its owning surface");
  stage("focus create");
  buttonNamed(focusHost, "+ Group")?.click();
  await wait();
  popover = document.querySelector(".action-popover");
  popover.querySelector(".organization-name-input").value = "Keyboard focus";
  buttonNamed(popover, "Create group")?.click();
  await waitSettled();
  check(document.activeElement?.dataset.organizationCommand === "create" &&
      document.activeElement?.closest(".organization-row")?.getAttribute("aria-label") === "Label groups",
    "successful create preserves the lens and restores focus to its creation command after a real rerender",
    document.activeElement?.outerHTML ?? "no active element");

  const focusGroupId = Object.values(memory.organizationGroups)
    .find((group) => group.name === "Keyboard focus" && !group.deletedAt)?.id;
  const focusGroupLens = [...focusHost.querySelectorAll("[data-organization-lens]")]
    .find((button) => button.dataset.organizationLens === focusGroupId);
  focusGroupLens?.click();
  await waitSettled();
  buttonNamed(focusHost, "Manage")?.click();
  stage("focus rename");
  await wait();
  popover = document.querySelector(".action-popover");
  const renameInput = popover.querySelector(".organization-name-input");
  renameInput.value = "Keyboard renamed";
  renameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitSettled();
  check(document.activeElement?.dataset.organizationCommand === "manage",
    "Rename submits on Enter and restores focus to Manage after rerender",
    document.activeElement?.outerHTML ?? "no active element");

  const cardSlot = document.createElement("span");
  const cardOpener = focusHost.querySelector('[data-action-id="groups"]');
  cardSlot.append(cardOpener);
  focusHost.append(cardSlot);
  const focusPanel = createAnchoredPanel(cardSlot);
  focusPanel.anchor(cardOpener);
  focusControls.cardAction.run({ group: { data: members[0] }, panel: focusPanel });
  stage("focus card apply");
  await wait();
  popover = document.querySelector(".action-popover");
  buttonNamed(popover, "Apply groups")?.click();
  await waitSettled();
  check(document.activeElement?.dataset.actionId === "groups",
    "card membership Apply restores focus to the equivalent Groups action");

  buttonNamed(focusHost, "Manage")?.click();
  stage("focus delete");
  await wait();
  popover = document.querySelector(".action-popover");
  const focusDanger = buttonNamed(popover, "Delete group");
  focusDanger.focus();
  focusDanger.click();
  popover.querySelector(".organization-name-input").focus();
  check(focusDanger.textContent === "Delete group", "armed group delete disarms on focusout");
  focusDanger.click();
  focusDanger.click();
  await waitSettled();
  check(document.activeElement?.dataset.organizationLens === controlsModule.UNGROUPED_ORGANIZATION_LENS &&
      document.activeElement?.closest(".organization-row")?.getAttribute("aria-label") === "Label groups",
    "successful delete restores focus to Ungrouped after rerender");

  result.dataset.status = "pass";
  result.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack ?? error}`;
}
