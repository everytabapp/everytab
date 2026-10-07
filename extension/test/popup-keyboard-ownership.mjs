import fs from "node:fs";
import { eventOwnsTextEntry } from "../js/ui/dom.js";

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

const input = { tagName: "INPUT", isContentEditable: false };
const textarea = { tagName: "TEXTAREA", isContentEditable: false };
const editable = { tagName: "DIV", isContentEditable: true };
const button = { tagName: "BUTTON", isContentEditable: false };
const docTarget = { nodeType: 9 };

check(eventOwnsTextEntry({ target: input, composedPath: () => [input] }, button),
  "the event target owns ordinary input typing");
check(eventOwnsTextEntry({ target: docTarget, composedPath: () => [docTarget] }, input),
  "the focused input retains ownership when a document-level event has a non-input target");
check(eventOwnsTextEntry({ target: button, composedPath: () => [editable, button] }, button),
  "a composed-path contenteditable owns typing");
check(eventOwnsTextEntry({ target: textarea, composedPath: () => [] }, null),
  "textarea typing is protected without an active-element fallback");
check(!eventOwnsTextEntry({ target: button, composedPath: () => [button] }, button),
  "ordinary action buttons do not suppress popup shortcuts");

const popup = fs.readFileSync(new URL("../js/ui/popup.js", import.meta.url), "utf8");
const listConfigs = fs.readFileSync(new URL("../js/ui/list-configs.js", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
check(popup.includes("eventOwnsTextEntry(e, document.activeElement)"),
  "the popup shortcut boundary checks the focused text entry as well as the raw event target");
check(popup.includes('p: () => keepAwakeBtn') &&
  popup.includes('actionRow("shield", popupStatic.keepAwake(), "P")'),
  "the popup exposes the same P protection shortcut as Open rows");
check(popup.includes('t: () => tabSessionBtn') &&
  popup.includes('sessionComboboxButton(localeMessage("popup_save_in_session")') &&
  popup.includes('data-shortcut-key", "t"'),
  "the popup names the tab action Save in Session and exposes the shared T shortcut");
check(listConfigs.includes('{ id: "session", label: localeMessage("list_save_as_session"), key: "t"') &&
  sidepanel.includes('import { createOpenSurface } from "./open-surface.js"') &&
  sidepanel.includes("createOpenSurface({"),
  "Dashboard and Side Panel share the Open-row T Session shortcut from one config");
check(popup.includes('buildProtectionPanel({ windowId: active.windowId }'),
  "the popup window shield delegates to the shared scoped picker");
const toggleStart = popup.indexOf("function toggleLabel(");
const toggleEnd = popup.indexOf("\nfunction renderTabLabels(", toggleStart);
const toggleLabel = popup.slice(toggleStart, toggleEnd);
check(toggleLabel.indexOf('panel.style.display = "block"') >= 0 &&
  toggleLabel.indexOf('panel.style.display = "block"') < toggleLabel.indexOf("buildLabelPanel(panel"),
"the popup reveals the label panel before building and focusing its text field");
check(popup.includes('.querySelector(".taginput")?.focus({ preventScroll: true })'),
  "the visible popup label field receives immediate focus without scrolling the popup");

if (failures) process.exit(1);
console.log("PASS: popup text-entry shortcut ownership");
