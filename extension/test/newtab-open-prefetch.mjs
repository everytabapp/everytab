import assert from "node:assert/strict";

import { createNewTabOpenPrefetch } from "../js/lib/newtab-open-prefetch.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const loads = [];
const published = [];
let activeLoads = 0;
let maxActiveLoads = 0;
const prefetch = createNewTabOpenPrefetch({
  load: () => {
    const task = deferred();
    loads.push(task);
    activeLoads += 1;
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    return task.promise.finally(() => { activeLoads -= 1; });
  },
  publish: (snapshot) => published.push(snapshot)
});

const first = prefetch.request();
const duringFirstA = prefetch.request();
const duringFirstB = prefetch.request();

assert.equal(loads.length, 1,
  "an event burst shares one populated-window query while it is in flight");
assert.equal(duringFirstA, first);
assert.equal(duringFirstB, first);
assert.deepEqual(published, [first],
  "one stable promise is exposed to the Dashboard for the whole burst");

let exposedResult = null;
void first.then((value) => { exposedResult = value; });
loads[0].resolve("stale-first-read");
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(loads.length, 2,
  "events during the first query collapse into exactly one trailing refresh");
assert.equal(exposedResult, null,
  "the stable promise does not expose a result made stale by a later event");
assert.equal(maxActiveLoads, 1,
  "the trailing refresh begins only after the prior query settles");

loads[1].resolve("fresh-trailing-read");
assert.equal(await first, "fresh-trailing-read",
  "the Dashboard receives the newest quiet-generation snapshot");
assert.equal(maxActiveLoads, 1);

const afterSettle = prefetch.request();
assert.notEqual(afterSettle, first,
  "an event after settlement starts a new owned prefetch cycle");
assert.equal(loads.length, 3);
assert.deepEqual(published, [first, afterSettle]);
loads[2].resolve("later-cycle");
assert.equal(await afterSettle, "later-cycle");

console.log("PASS: New Tab Open prefetch is single-owner and newest-generation only");
