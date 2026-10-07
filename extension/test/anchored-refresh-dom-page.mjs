import {
  anchoredPanelOpenWithin, createAnchoredPanel, subscribeAnchoredPanelChange
} from "../js/ui/tablist.js";
import { createInteractionRefreshGate } from "../js/ui/refresh-scheduler.js";

const fixture = document.querySelector("#fixture");
const result = document.querySelector("#result");
const catalogue = await fetch("../_locales/en/messages.json").then((response) => response.json());
chrome.i18n.getMessage = (key, substitutions = []) => {
  if (key === "@@ui_locale") return "en";
  if (key === "@@bidi_dir") return "ltr";
  const entry = catalogue[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let text = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Math.max(0, Number(String(placeholder.content).replace("$", "")) - 1);
    text = text.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
  }
  return text;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const check = (condition, message, detail = "") => {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ""}`);
};

try {
  let panel;
  let input;
  let options;
  let trigger;
  const buildRow = () => {
    const row = document.createElement("div");
    row.className = "trow";
    row.dataset.tablistRow = "t42";
    const slot = document.createElement("div");
    trigger = document.createElement("button");
    trigger.type = "button";
    trigger.dataset.actionId = "label";
    trigger.textContent = "Label";
    panel = createAnchoredPanel(slot);
    row.append(trigger, slot);
    return row;
  };

  fixture.append(buildRow());
  let commits = 0;
  const gate = createInteractionRefreshGate(() => {
    commits += 1;
    fixture.replaceChildren(buildRow());
  }, {
    isHeld: () => anchoredPanelOpenWithin(fixture),
    subscribe: subscribeAnchoredPanelChange
  });

  const originalRow = fixture.firstElementChild;
  panel.anchor(trigger);
  panel.toggle(() => {
    const form = document.createElement("div");
    input = document.createElement("input");
    options = document.createElement("div");
    options.textContent = "Existing label";
    form.append(input, options);
    return form;
  }, "label");
  const pickerImmediately = Boolean(document.querySelector('.action-popover[data-kind="label"]')?.isConnected);
  const heldImmediately = anchoredPanelOpenWithin(fixture);
  await settle();
  const pickerAtOpen = Boolean(document.querySelector('.action-popover[data-kind="label"]')?.isConnected);
  const heldAtOpen = anchoredPanelOpenWithin(fixture);
  await gate.request();
  input.value = "wor";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  options.replaceChildren(document.createTextNode("Create wor"));
  await settle();

  const openPicker = document.querySelector('.action-popover[data-kind="label"]');
  check(commits === 0 && originalRow.isConnected && openPicker?.isConnected,
    "typing in a row picker did not survive a live Open refresh",
    JSON.stringify({ pickerImmediately, heldImmediately, pickerAtOpen, heldAtOpen, commits,
      rowConnected: originalRow.isConnected,
      pickerConnected: Boolean(openPicker?.isConnected) }));

  panel.close();
  await settle();
  await settle();
  check(commits === 1 && !originalRow.isConnected,
    "closing the row picker did not release exactly one deferred refresh",
    JSON.stringify({ commits, oldRowConnected: originalRow.isConnected }));
  gate.dispose();

  result.dataset.status = "pass";
  result.textContent = "PASS: row picker holds and releases live Open refreshes";
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error.stack || error.message}`;
}
