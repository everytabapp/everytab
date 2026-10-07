import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const dom = installDomFixture();
const sent = [];
let inspections = 0;
let snapshotReviews = 0;
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: {
    sendMessage: async (message) => {
      sent.push(structuredClone(message));
      if (message.type === "inspect-recently-closed-suspended") {
        inspections += 1;
        return inspections === 1 ? {
          ok: true,
          candidates: [
            { sessionId: "one", title: "First lost tab", domain: "one.example", closedAt: 1_786_000_000_000 },
            { sessionId: "two", title: "Second lost tab", domain: "two.example", closedAt: 1_786_000_100_000 }
          ]
        } : { ok: true, candidates: [] };
      }
      if (message.type === "recover-recently-closed-suspended") {
        return { ok: true, requested: 1, restored: 1, failed: 0, unavailable: 0 };
      }
      if (message.type === "inspect-snapshot-recovery") {
        return {
          ok: true,
          snapshots: [{
            snapshotId: "before-loss", name: "Snapshot before loss",
            createdAt: 1_786_000_000_000, modifiedAt: 1_786_000_000_000,
            tabCount: 60, windowCount: 5, missingCount: 2
          }]
        };
      }
      if (message.type === "review-snapshot-recovery") {
        snapshotReviews += 1;
        return {
          ok: true,
          snapshot: {
            snapshotId: "before-loss", name: "Snapshot before loss",
            createdAt: 1_786_000_000_000, modifiedAt: 1_786_000_000_000,
            tabCount: 60, windowCount: 5, missingCount: snapshotReviews === 1 ? 2 : 0
          },
          candidates: snapshotReviews === 1 ? [
            { key: "0:4", windowIndex: 0, tabIndex: 4, title: "Older lost tab", domain: "old.example" },
            { key: "3:8", windowIndex: 3, tabIndex: 8, title: "Another lost tab", domain: "other.example" }
          ] : []
        };
      }
      if (message.type === "recover-snapshot-missing-tabs") {
        return { ok: true, requested: 2, restored: 2, windows: 2, failed: 0, unavailable: 0 };
      }
      return null;
    }
  }
};

const { createDataSurface } = await import("../js/ui/data-surface.js");
const body = document.createElement("main");
document.body.append(body);
const surface = createDataSurface({
  getBody: () => body,
  setHeading: () => {},
  onChanged: async () => {}
});
await surface.render();

const buttonByText = (text) => [...body.querySelectorAll("button")]
  .find((button) => button.textContent === text);

await buttonByText("Check recently closed").dispatch("click");
assert.equal(body.querySelectorAll(".data-recovery-row").length, 2,
  "inspection renders every recoverable suspended tab before any restore");
assert.equal(buttonByText("Recover 2 tabs")?.disabled, false,
  "all reviewed candidates start selected with an exact action count");

const checkboxes = body.querySelectorAll(".data-recovery-row input");
checkboxes[1].checked = false;
await checkboxes[1].dispatch("change");
assert.ok(buttonByText("Recover 1 tab"), "selection changes update the explicit recovery count");

await buttonByText("Recover 1 tab").dispatch("click");
assert.deepEqual(sent.find((message) => message.type === "recover-recently-closed-suspended"), {
  type: "recover-recently-closed-suspended",
  sessionIds: ["one"]
}, "only the reviewed selection reaches the worker");
assert.equal(body.querySelectorAll(".data-recovery-row").length, 0,
  "consumed recently closed entries leave the review after recovery");
assert.match(body.querySelector(".data-recovery-status").textContent, /1 recovered/,
  "the completed recovery remains visibly acknowledged");

await buttonByText("Check automatic snapshots").dispatch("click");
const snapshotSelect = [...body.querySelectorAll("select")]
  .find((select) => select.getAttribute("aria-label") === "Automatic snapshot to compare");
assert.equal(snapshotSelect?.value, "before-loss",
  "the local snapshot review names the exact source before opening anything");
await buttonByText("Review missing tabs").dispatch("click");
assert.ok(buttonByText("Recover 2 missing tabs"),
  "the deeper review shows only missing occurrences with an exact selected count");
await buttonByText("Recover 2 missing tabs").dispatch("click");
assert.deepEqual(sent.find((message) => message.type === "recover-snapshot-missing-tabs"), {
  type: "recover-snapshot-missing-tabs",
  snapshotId: "before-loss",
  pickKeys: ["0:4", "3:8"]
}, "only selected snapshot occurrences reach the worker");
assert.match([...body.querySelectorAll(".data-recovery-status")].at(-1).textContent,
  /2 recovered in 2 new windows/,
  "snapshot recovery stays visibly acknowledged after the fresh comparison consumes its rows");

dom.restore();
console.log("PASS: Data reviews and explicitly recovers selected suspended tabs");
