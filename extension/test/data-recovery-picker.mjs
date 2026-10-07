import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";

const dom = installDomFixture();
const { createDataRecoveryPicker } = await import("../js/ui/data-recovery-picker.js");

const body = document.createElement("div");
const status = document.createElement("div");
const check = document.createElement("button");
document.body.append(body, status, check);

const recovered = [];
const refreshed = [];
let nextResult = { restored: 1 };
const picker = createDataRecoveryPicker({
  body,
  status,
  checkControl: check,
  adapter: {
    candidateKey: (candidate) => candidate.id,
    candidateContent: (candidate) => {
      const content = document.createElement("span");
      content.textContent = candidate.title;
      return content;
    },
    actionText: (count) => `Recover ${count}`,
    progressText: (count) => `Recovering ${count}`,
    foundText: (count) => `Found ${count}`,
    emptyText: () => "Nothing to recover",
    failureText: () => "Try again",
    resultText: (result) => `Recovered ${result.restored}`,
    recover: async (context, keys) => {
      recovered.push({ context, keys });
      return nextResult;
    },
    refresh: async (context, options) => refreshed.push({ context, options })
  }
});

picker.render({ source: "checkpoint-a" }, [
  { id: "one", title: "First" },
  { id: "two", title: "Second" }
]);
assert.equal(status.textContent, "Found 2");
assert.equal(body.querySelectorAll(".data-recovery-row").length, 2);
assert.equal(body.querySelector("button").textContent, "Recover 2");

const checkboxes = body.querySelectorAll("input[type='checkbox']");
checkboxes[1].checked = false;
await checkboxes[1].dispatch("change");
assert.equal(body.querySelector("button").textContent, "Recover 1",
  "the module owns selection-derived action state");

await body.querySelector("button").dispatch("click");
assert.deepEqual(recovered, [{ context: { source: "checkpoint-a" }, keys: ["one"] }]);
assert.deepEqual(refreshed, [{
  context: { source: "checkpoint-a" }, options: { preserveStatus: true }
}]);
assert.equal(status.textContent, "Recovered 1");
assert.equal(check.disabled, false, "the inspection control is restored after recovery");

let finishPending;
nextResult = new Promise((resolve) => { finishPending = resolve; });
picker.render({ source: "checkpoint-pending" }, [{ id: "pending", title: "Pending" }]);
const pendingAction = body.querySelector("button");
const pending = pendingAction.dispatch("click");
assert.equal(pendingAction.disabled, true);
assert.equal(check.disabled, true);
assert.equal(status.textContent, "Recovering 1",
  "one pending state owns the action, inspection control, and live status");
finishPending({ restored: 1 });
await pending;

nextResult = null;
picker.render({ source: "checkpoint-b" }, [{ id: "three", title: "Third" }]);
await body.querySelector("button").dispatch("click");
assert.equal(status.textContent, "Try again");
assert.equal(body.querySelector("button").disabled, false,
  "a failed request restores the selected action for retry");
assert.equal(check.disabled, false);

picker.render(null, []);
assert.equal(body.children.length, 0);
assert.equal(status.textContent, "Nothing to recover");

dom.restore();
console.log("PASS: shared Data recovery picker owns selection, pending, retry, and refresh");
