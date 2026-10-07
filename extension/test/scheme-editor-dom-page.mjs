await import("../../tools/scheme-editor-harness.js");

const result = document.getElementById("result");
const checks = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  checks.push(message);
};
const waitFor = async (fn, message, limit = 2500) => {
  for (let index = 0; index < limit; index++) {
    if (globalThis.__schemeEditorHarnessErrors?.length) {
      throw new Error(globalThis.__schemeEditorHarnessErrors.join("\n"));
    }
    const fatal = document.querySelector(".scheme-editor-fatal");
    if (fatal) throw new Error(fatal.textContent);
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`${message}\nAPP: ${document.getElementById("app")?.innerHTML.slice(0, 1200)}`);
};
const button = (name) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.trim() === name);
const field = (name) => document.querySelector(`[aria-label="${name} hex value"]`);
const setText = (input, value) => {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};
const startFrom = (source) => {
  const select = document.querySelector('[aria-label="Starting scheme"]');
  select.value = source;
  button("Start from selection").click();
  const confirm = button("Confirm replace draft");
  if (confirm) confirm.click();
};

try {
  await waitFor(() => field("Page") && button("Save copy and apply"), "dedicated editor did not mount");
  check(document.querySelectorAll(".scheme-editor-workbench > *").length === 3,
    "editor mounts the approved inspector, preview, and validation panes");
  check(button("Advanced").classList.contains("is-active") && field("Page").value === "#F5EFE3",
    "Cream opens from its exact production map in Advanced mode");
  check(document.querySelectorAll(".scheme-color-field").length === 17,
    "Advanced exposes fourteen roles and three gradient stops for the active mode");
  check(document.querySelectorAll(".scheme-atlas-section").length === 5 &&
    document.querySelectorAll(".scheme-editor-preview [data-tablist-row]").length === 4,
  "preview is a complete scrollable atlas with real shared tab-list anatomy");
  check(getComputedStyle(document.querySelector(
    ".scheme-editor-preview .item-head-shell"
  )).position === "static",
  "preview window headers scroll with the atlas instead of floating mid-canvas");
  check(!document.querySelector('optgroup[label="Candidate schemes"]'),
    "the accepted Aladdin scheme closes the temporary candidate group");
  check(button("Save custom copy").classList.contains("scheme-editor-primary") &&
    !button("Save custom copy").disabled &&
    document.querySelector(".scheme-editor-save-state").textContent.includes("Not yet in Yours"),
  "Save is visibly available and states that the starting scheme is not yet saved");
  check(document.querySelector(".scheme-preview-navigation .navitem.active") &&
    document.querySelector(".scheme-preview-results .search-row.selected .rtype") &&
    !document.querySelector(".scheme-preview-results > button"),
  "navigation and Search reuse the real production class and lane anatomy");
  const activeNav = document.querySelector(".scheme-preview-navigation .navitem.active");
  const previewRoot = document.querySelector(".scheme-editor-preview");
  // This assertion checks token ownership, not animation timing. Chrome can
  // pause CSS transitions in a backgrounded compact test page.
  activeNav.style.transition = "none";
  const colorProbe = document.createElement("span");
  colorProbe.style.color = "var(--accent)";
  previewRoot.append(colorProbe);
  const previewAccent = getComputedStyle(colorProbe).color;
  check(getComputedStyle(activeNav).backgroundColor === previewAccent,
    "the selected section uses the production accent treatment");
  colorProbe.remove();

  startFrom("builtin:oblivion");
  await waitFor(() => field("Page")?.value === "#D7DDE0", "Oblivion built-in did not load");
  check(document.querySelector("#scheme-editor-source-note").textContent.includes("Built-ins are protected") &&
    document.querySelector('[aria-label="Scheme name"]').value === "Oblivion custom",
  "the accepted Oblivion composition loads as a protected built-in source");
  startFrom("builtin:cream");
  await waitFor(() => field("Page")?.value === "#F5EFE3", "Cream did not reload after Oblivion");

  startFrom("builtin:aladdin");
  await waitFor(() => field("Page")?.value === "#EFA36F", "Aladdin built-in did not load");
  check(document.querySelector("#scheme-editor-source-note").textContent.includes("Built-ins are protected") &&
    document.querySelector('[aria-label="Scheme name"]').value === "Aladdin custom",
  "Aladdin loads as the protected built-in promoted from Crimson Peach");
  button("Dark").click();
  check(field("Page").value === "#101B42",
    "the promoted Aladdin scheme switches to its complete Dark map");
  startFrom("builtin:cream");
  await waitFor(() => field("Page")?.value === "#F5EFE3", "Cream did not reload after Aladdin");

  const liveRootBefore = document.documentElement.dataset.scheme;
  setText(field("Page"), "0af");
  check(field("Page").value === "0af" &&
    document.querySelector(".scheme-editor-preview").style.getPropertyValue("--bg-solid") === "#00aaff",
  "paste-friendly short hex updates the isolated preview without interrupting typing");
  field("Page").dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  check(field("Page").value === "#00AAFF" && document.documentElement.dataset.scheme === liveRootBefore,
    "hex normalizes on commit and the editor chrome keeps the active EveryTab theme");
  const pageField = field("Page").closest(".scheme-color-field");
  pageField.querySelector(".scheme-field-copy").click();
  await waitFor(() => globalThis.__schemeEditorCopied, "copy control did not settle");
  check(globalThis.__schemeEditorCopied === "#00AAFF", "copy exports the exact normalized hex value");
  pageField.querySelector(".scheme-field-show").click();
  check(document.querySelectorAll(".scheme-highlight-direct").length > 0 &&
    document.querySelectorAll(".scheme-highlight-derived").length > 0,
  "Show uses distinguishes direct and derived preview dependencies");
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(!document.querySelector(".scheme-highlight-direct, .scheme-highlight-derived"),
    "Escape clears temporary dependency highlighting immediately");

  startFrom("builtin:cream");
  await waitFor(() => field("Page")?.value === "#F5EFE3", "Cream did not reload after draft confirmation");
  setText(field("Page"), field("Primary text").value);
  check(button("Save custom copy").disabled &&
    document.querySelector(".scheme-editor-validation").textContent.includes("need attention"),
  "a failing production pairing is linked and blocks both save paths");
  const issue = document.querySelector(".scheme-validation-issue");
  issue.click();
  check(document.activeElement?.closest(".scheme-color-field"),
    "selecting a validation issue moves focus to a likely source field");

  startFrom("builtin:ink");
  await waitFor(() => document.querySelector('[aria-label="Scheme name"]').value.includes("Ink"),
    "built-in source selector did not load Ink");
  check(button("Advanced").classList.contains("is-active"),
    "each protected built-in remains exact until Guided is explicitly chosen");
  button("Guided").click();
  check(button("Confirm Guided"), "Advanced to Guided conversion requires a second press");
  button("Confirm Guided").click();
  check(document.querySelectorAll(".scheme-color-field").length === 7 &&
    button("Guided").classList.contains("is-active"),
  "confirmed Guided conversion exposes exactly seven source colors");

  const name = document.querySelector('[aria-label="Scheme name"]');
  name.value = "Mounted Ink Copy";
  name.dispatchEvent(new InputEvent("input", { bubbles: true }));
  button("Save custom copy").click();
  await waitFor(() => Object.values(globalThis.__schemeEditorHarnessState.customSchemes ?? {})
    .some((record) => record.name === "Mounted Ink Copy"), "built-in copy did not save");
  const saved = Object.values(globalThis.__schemeEditorHarnessState.customSchemes)
    .find((record) => record.name === "Mounted Ink Copy");
  const savedButton = button("Saved");
  const savedState = document.querySelector(".scheme-editor-save-state")?.textContent ?? "";
  check(Boolean(saved) && document.documentElement.dataset.scheme === liveRootBefore &&
    savedButton?.disabled && savedState.includes("All changes saved"),
    "saving a protected built-in creates a custom record without applying it: " +
      JSON.stringify({ found: Boolean(saved), scheme: document.documentElement.dataset.scheme,
        savedButton: Boolean(savedButton), disabled: savedButton?.disabled, savedState }));
  button("Apply").click();
  await waitFor(() => globalThis.__schemeEditorHarnessState.settings?.uiScheme?.startsWith("custom:"),
    "save and apply did not update Settings");
  check(document.documentElement.dataset.scheme === "custom" &&
    document.documentElement.dataset.customScheme === saved.id,
  "save and apply promotes only the validated saved custom scheme to the live theme");

  const workbenchDisplay = getComputedStyle(document.querySelector(".scheme-editor-workbench")).display;
  const narrow = workbenchDisplay === "block";
  check(document.documentElement.scrollWidth === document.documentElement.clientWidth,
    "dedicated editor has no horizontal page overflow");
  if (narrow) {
    check(workbenchDisplay === "block",
      "400px editor stacks into one readable workbench");
  } else {
    check(workbenchDisplay === "grid",
      "wide editor keeps the approved three-pane workbench");
  }
  check(!(globalThis.__schemeEditorHarnessErrors?.length),
    `editor raised no background error: ${globalThis.__schemeEditorHarnessErrors?.join("\n")}`);

  result.dataset.status = "pass";
  result.textContent = `Scheme editor mounted DOM passed: ${checks.length} checks at ${innerWidth}px.`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = error?.stack ?? String(error);
}
