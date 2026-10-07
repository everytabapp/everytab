import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";

const catalogue = JSON.parse(readFileSync(
  new URL("../_locales/en/messages.json", import.meta.url), "utf8"
));
const getMessage = (key, substitutions = []) => {
  const entry = catalogue[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let message = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(String(placeholder.content).match(/\$(\d+)/)?.[1] ?? 0) - 1;
    message = message.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
  }
  return message;
};

const dom = installDomFixture();
try {
  document.addEventListener = () => {};
  document.contains = (node) => document.documentElement.contains(node);
  Element.prototype.hasAttribute = function hasAttribute(name) {
    return this.getAttribute(name) !== null;
  };
  window.addEventListener = () => {};
  window.innerWidth = 1280;
  window.innerHeight = 800;
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.chrome = {
    i18n: { getMessage },
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: { getAll: async () => [{ id: 7 }] }
  };
  const {
    createDuplicatesSurface, duplicateGroupHostname, duplicateIdentityBanner, withDuplicateRule
  } = await import("../js/ui/duplicates-surface.js");

  const normalizedGroup = {
    data: {
      key: "https://tickets.example.test/view",
      canonicalUrl: "https://tickets.example.test/view"
    },
    refs: [{ url: "https://tickets.example.test/view#ticket-1" }]
  };
  assert.equal(duplicateGroupHostname(normalizedGroup), "tickets.example.test");
  assert.deepEqual(withDuplicateRule([
    { hostname: "tickets.example.test", mode: "skip" }
  ], "tickets.example.test", "standard"), [], "Standard removes the exact-host exception");

  let invoked = null;
  const banner = duplicateIdentityBanner(normalizedGroup, (group, anchor) => {
    invoked = { group, anchor };
  });
  const explanation = banner.querySelector(".dup-rule-trigger");
  assert.equal(explanation?.textContent, "Not the same page?");
  await explanation.dispatch("click");
  assert.equal(invoked?.group, normalizedGroup);
  assert.equal(invoked?.anchor, explanation);

  const tabs = [{
    id: 1, windowId: 7, index: 0, active: true,
    url: "https://tickets.example.test/view#ticket-1", title: "Ticket one"
  }, {
    id: 2, windowId: 7, index: 1,
    url: "https://tickets.example.test/view#ticket-2", title: "Ticket two"
  }];
  const groups = [{
    key: "https://tickets.example.test/view",
    keep: tabs[0], close: [tabs[1]], tabs
  }];
  const body = document.createElement("div");
  document.body.append(body);
  const surface = createDuplicatesSurface({
    getBody: () => body,
    setHeading: () => {},
    msg: async () => ({ ok: true })
  });
  await surface.render({
    groups: async () => groups,
    tabs: async () => tabs,
    rules: async () => []
  });
  const labels = body.querySelectorAll("button").map((button) => button.textContent);
  assert.ok(labels.includes("Matching rules"), "Duplicates exposes its rule manager");
  assert.ok(labels.includes("Not the same page?"), "each duplicate group exposes rule creation");

  const matchingRules = body.querySelectorAll("button")
    .find((button) => button.textContent === "Matching rules");
  await matchingRules.dispatch("click");
  assert.ok(document.querySelector(".action-popover")?.textContent.includes("No matching exceptions yet"),
    "the matching rules manager opens in the shared anchored panel");
  await matchingRules.dispatch("click");

  const notSamePage = body.querySelectorAll("button")
    .find((button) => button.textContent === "Not the same page?");
  await notSamePage.dispatch("click");
  const editor = document.querySelector(".dup-rule-editor");
  assert.equal(editor?.querySelectorAll(".dup-rule-choice").length, 3,
    "the domain editor exposes the three approved matching modes");
  const includeFragment = editor.querySelector('[data-rule-mode="include-fragment"]');
  await includeFragment.dispatch("click");
  assert.equal(includeFragment.getAttribute("aria-pressed"), "true");
  assert.ok(editor.querySelector(".dup-rule-preview")?.textContent.startsWith("0 extra copies"),
    "the rule preview reflects fragment-aware matching before save");
} finally {
  dom.restore();
}

console.log("PASS: duplicate matching rule controls are discoverable and exact-domain scoped");
