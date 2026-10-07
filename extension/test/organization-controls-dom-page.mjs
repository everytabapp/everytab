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
Object.defineProperty(globalThis, "process", {
  configurable: true,
  value: { versions: { node: "browser-fixture" } }
});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

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
  const [{ createIndexBar }, { createAnchoredPanel, dismissAnchoredPanel }, organization, controlsModule, { coalesce }, listHelpers] = await Promise.all([
    import("../js/ui/indexbar.js"),
    import("../js/ui/tablist.js"),
    import("../js/lib/organization.js"),
    import("../js/ui/organization-controls.js"),
    import("../js/ui/dom.js"),
    import("../js/ui/list-helpers.js")
  ]);
  await organization.createOrganizationGroup("label", "Work", ["Research"]);
  await organization.createOrganizationGroup("label", "Personal", []);
  const members = [{ label: "Research", tabs: 3 }, { label: "Inbox", tabs: 1 }];
  const state = await organization.readOrganizationState("label");
  const projection = organization.projectOrganization("label", members, state,
    { memberKey: (member) => member.label });
  const work = projection.groups.find((entry) => entry.name === "Work");
  const personal = projection.groups.find((entry) => entry.name === "Personal");

  const sessionPickerHost = document.createElement("div");
  host.append(sessionPickerHost);
  let pickedSession = null;
  const creationPicker = listHelpers.sessionComboboxButton("Save as Session", {
    onPick: (value) => { pickedSession = value; }
  });
  sessionPickerHost.append(creationPicker);
  creationPicker.click();
  stage("new Session organization step");
  await wait();
  let creationPopover = document.querySelector(".action-popover");
  const sessionNameInput = creationPopover.querySelector(".session-picker-field .taginput");
  sessionNameInput.value = "Roadmap Session";
  sessionNameInput.dispatchEvent(new Event("input", { bubbles: true }));
  sessionNameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  creationPopover = document.querySelector(".action-popover");
  check(creationPopover.querySelector('[data-inline-organization-editor="session"]') &&
      creationPopover.textContent.includes("Roadmap Session") && !pickedSession,
    "a newly named Session stays selected beside an inline Organize disclosure");
  buttonNamed(creationPopover, "Organize…").click();
  await wait();
  check(!creationPopover.querySelector(".organization-inline-body")?.textContent.includes("null"),
    "the inline Group field never renders an implementation null");
  const creationGroupInput = creationPopover.querySelector(".organization-inline-entry .taginput");
  creationGroupInput.value = "Roadmaps";
  creationGroupInput.dispatchEvent(new Event("input", { bubbles: true }));
  creationGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  creationGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  check(pickedSession?.isNew && pickedSession.name === "Roadmap Session" &&
      pickedSession.organization?.createNames?.join() === "Roadmaps",
    "the Session picker returns its new name and optional group assignment together");

  const ungroupedPickerHost = document.createElement("div");
  host.append(ungroupedPickerHost);
  let ungroupedSession = null;
  const ungroupedPicker = listHelpers.sessionComboboxButton("Save as Session", {
    onPick: (value) => { ungroupedSession = value; }
  });
  ungroupedPickerHost.append(ungroupedPicker);
  ungroupedPicker.click();
  stage("new ungrouped Session");
  await wait();
  let ungroupedPopover = document.querySelector(".action-popover");
  const ungroupedInput = ungroupedPopover.querySelector(".session-picker-field .taginput");
  ungroupedInput.value = "Ungrouped Session";
  ungroupedInput.dispatchEvent(new Event("input", { bubbles: true }));
  ungroupedInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  ungroupedPopover = document.querySelector(".action-popover");
  const ungroupedApply = buttonNamed(ungroupedPopover, "Save as Session");
  const applyOwnsFocus = document.activeElement === ungroupedApply;
  ungroupedApply.click();
  await wait();
  check(applyOwnsFocus && ungroupedSession?.isNew &&
      ungroupedSession.name === "Ungrouped Session" &&
      !("organization" in ungroupedSession),
    "an ungrouped new Session focuses Apply and omits the optional organization field");

  const labelCreationSlot = document.createElement("span");
  const labelCreationOpener = document.createElement("button");
  labelCreationOpener.textContent = "Label";
  labelCreationSlot.append(labelCreationOpener);
  host.append(labelCreationSlot);
  const labelCreationPanel = createAnchoredPanel(labelCreationSlot);
  labelCreationPanel.anchor(labelCreationOpener);
  let appliedCreationLabels = [];
  labelCreationPanel.toggle(() => listHelpers.cardLabelPanel((labels) => {
    appliedCreationLabels = labels;
  }, "Add labels", labelCreationPanel), "label");
  stage("new Label organization step");
  await wait();
  creationPopover = document.querySelector(".action-popover");
  const labelCreationInput = creationPopover.querySelector(".palette-label-field .taginput");
  labelCreationInput.value = "Fresh Label";
  labelCreationInput.dispatchEvent(new Event("input", { bubbles: true }));
  labelCreationInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  creationPopover = document.querySelector(".action-popover");
  check(creationPopover.querySelector('[data-inline-organization-editor="label"]') &&
      appliedCreationLabels.length === 0,
    "a newly typed Label keeps its Apply action and reveals inline Organize");
  buttonNamed(creationPopover, "Organize…").click();
  await wait();
  const labelGroupInput = creationPopover.querySelector(".organization-inline-entry .taginput");
  labelGroupInput.value = "Personal";
  labelGroupInput.dispatchEvent(new Event("input", { bubbles: true }));
  labelGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  labelGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitSettled();
  const creationLabelProjection = organization.projectOrganization(
    "label", [{ label: "Fresh Label" }], await organization.readOrganizationState("label")
  );
  check(appliedCreationLabels.join() === "Fresh Label" &&
      creationLabelProjection.groupIdsByMemberKey.get("Fresh Label")?.has(personal.id),
    "the Label picker applies its target and durable group membership from one confirmed flow");

  labelCreationPanel.anchor(labelCreationOpener);
  labelCreationPanel.toggle(() => listHelpers.cardLabelPanel((labels) => {
    appliedCreationLabels = labels;
  }, "Add labels", labelCreationPanel), "label");
  stage("multiple Label organization");
  await wait();
  creationPopover = document.querySelector(".action-popover");
  const multiLabelInput = creationPopover.querySelector(".palette-label-field .taginput");
  for (const name of ["Research", "Inbox"]) {
    multiLabelInput.value = name;
    multiLabelInput.dispatchEvent(new Event("input", { bubbles: true }));
    multiLabelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await wait();
  buttonNamed(creationPopover, "Organize…").click();
  await wait();
  let sharedGroupInput = creationPopover.querySelector(".organization-inline-entry .taginput");
  sharedGroupInput.value = "Work";
  sharedGroupInput.dispatchEvent(new Event("input", { bubbles: true }));
  sharedGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  buttonNamed(creationPopover, "Set groups separately").click();
  await wait();
  const separateEntries = [...creationPopover.querySelectorAll(".organization-inline-entry")];
  check(separateEntries.length === 2 &&
      separateEntries.every((entry) => entry.querySelector(".chip")?.textContent.includes("Work")),
    "multiple Labels default to one shared addition and can expand to one exact input each");
  const inboxEntry = separateEntries.find((entry) => entry.textContent.includes("Inbox"));
  inboxEntry.querySelector(".chip .x").click();
  const inboxGroupInput = inboxEntry.querySelector(".taginput");
  inboxGroupInput.value = "Personal";
  inboxGroupInput.dispatchEvent(new Event("input", { bubbles: true }));
  inboxGroupInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  buttonNamed(creationPopover, "Add labels").click();
  await waitSettled();
  const exactLabelProjection = organization.projectOrganization(
    "label", [{ label: "Research" }, { label: "Inbox" }],
    await organization.readOrganizationState("label")
  );
  check(exactLabelProjection.groupIdsByMemberKey.get("Research")?.has(work.id) &&
      !exactLabelProjection.groupIdsByMemberKey.get("Research")?.has(personal.id) &&
      exactLabelProjection.groupIdsByMemberKey.get("Inbox")?.has(personal.id) &&
      !exactLabelProjection.groupIdsByMemberKey.get("Inbox")?.has(work.id),
    "separate Label inputs commit exact memberships together without a second screen");

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
  const addLabelsButton = buttonNamed(index, "Manage labels");
  check(addLabelsButton, "active group exposes its inverse Manage labels action");
  addLabelsButton.click();
  stage("active picker");
  await wait();
  popover = document.querySelector(".action-popover");
  check(popover, "active group opens its anchored member picker");
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
  check(popover.textContent.includes("Enter adds a group.") &&
      popover.textContent.includes("Enter again applies."),
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

  dismissAnchoredPanel();
  await wait();
  result.dataset.status = "pass";
  result.textContent = `PASS ${checks.length}: ${checks.join(" | ")}`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack ?? error}`;
}
