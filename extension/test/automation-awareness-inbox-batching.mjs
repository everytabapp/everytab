/**
 * Inbox awareness triggers are cached per saved item and re-painted on every
 * Inbox render. Sampling each cached trigger's reveal state (a computed-style
 * read) between paints of the others forced one full style recalc per trigger:
 * quadratic in the Inbox size, 1.2 s per filter keystroke at 400 saved tabs.
 * The Inbox build now runs inside withRowRender, which samples every cached
 * Open and Inbox trigger once before any write.
 *
 *     node test/automation-awareness-inbox-batching.mjs      (from extension/)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock(), runtime: { getURL: (p) => `chrome-extension://fixture/${p}` } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const savedStyle = globalThis.getComputedStyle;
const events = [];
let recording = false;
const watched = new Set();
globalThis.getComputedStyle = (node) => {
  if (recording && watched.has(node)) events.push("read");
  return { ...savedStyle?.(node), opacity: "1" };
};
const createElement = document.createElement.bind(document);
document.createElement = (tag) => {
  const node = createElement(tag);
  for (const [owner, method] of [[node, "setAttribute"], [node.classList, "add"], [node.classList, "toggle"], [node.style, "setProperty"]]) {
    const original = owner[method].bind(owner);
    owner[method] = (...args) => {
      if (recording && watched.has(node) && node.isConnected) events.push("write");
      return original(...args);
    };
  }
  node.getClientRects = () => node.isConnected ? [{}] : [];
  return node;
};

const { createAutomationAwareness } = await import("../js/ui/automation-awareness.js");
const awareness = createAutomationAwareness({ now: () => 10_000_000, openSettings() {} });
const view = { display: "timed", kind: "inbox", progress: 0.4, dueAt: 10_060_000, settingsGroup: "autosave" };

// First render: 40 cached Inbox triggers mounted inside connected cards.
const list = document.createElement("div");
document.body.append(list);
const ids = Array.from({ length: 40 }, (_, index) => `item-${index}`);
for (const id of ids) {
  const card = document.createElement("div");
  card.className = "item";
  const trigger = awareness.inbox(view, id);
  card.append(trigger);
  list.append(card);
  watched.add(trigger);
}

// Second render (a filter keystroke) inside withRowRender: every reveal sample
// happens before the first paint write.
recording = true;
awareness.withRowRender(() => { for (const id of ids) awareness.inbox(view, id); });
recording = false;
const firstWrite = events.indexOf("write");
const lastRead = events.lastIndexOf("read");
assert.ok(events.filter((e) => e === "read").length >= ids.length, `every cached trigger is sampled (${events.length} events)`);
assert.ok(firstWrite === -1 || lastRead < firstWrite,
  `all reveal reads precede the first write inside withRowRender (last read ${lastRead}, first write ${firstWrite})`);

// Without the guard, reads and writes interleave; this is what the Inbox did.
events.length = 0;
recording = true;
for (const id of ids) awareness.inbox(view, id);
recording = false;
assert.ok(events.lastIndexOf("read") > events.indexOf("write"),
  "an unguarded re-render interleaves reveal reads with paints (the quadratic path)");

const inboxSource = readFileSync(new URL("../js/ui/inbox-surface.js", import.meta.url), "utf8");
assert.match(inboxSource, /automationAwareness\?\.withRowRender\s*\?\s*ctx\.automationAwareness\.withRowRender\(buildList\)/,
  "the Inbox surface builds its list inside withRowRender");
console.log(`PASS: Inbox awareness triggers are sampled once before any paint inside withRowRender (${ids.length} cached triggers)`);
