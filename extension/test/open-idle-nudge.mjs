import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock() };

try {
  const { createIdleNudge } = await import("../js/ui/open-surface.js");
  let now = 10_000;
  let scheduled = null;
  const node = createIdleNudge({ tabs: [{ lastAccessed: now - 4 * 3600_000 + 1_000 }] }, {
    now: () => now,
    schedule: (run, delay) => { scheduled = { run, delay }; return 1; }
  });
  document.body.append(node);
  if (!node.hidden || !scheduled || scheduled.delay < 1_000 || scheduled.delay > 1_100) {
    throw new Error(`Idle nudge did not schedule its exact next boundary: ${JSON.stringify(scheduled)}`);
  }
  now += 1_020;
  scheduled.run();
  if (node.hidden || node.textContent !== "1 tab idle · oldest 4 hours" || !node.querySelector("svg")) {
    throw new Error(`Idle nudge did not evolve at the four-hour boundary: ${node.textContent}`);
  }
  if (!scheduled || scheduled.delay < 3_599_000 || scheduled.delay > 3_601_000) {
    throw new Error(`Idle nudge did not schedule its next displayed hour: ${JSON.stringify(scheduled)}`);
  }
  now += 6 * 3600_000;
  scheduled.run();
  if (node.textContent !== "1 tab idle · oldest 10 hours") {
    throw new Error(`Idle nudge did not show the real oldest age: ${node.textContent}`);
  }
  now += 15 * 3600_000;
  scheduled.run();
  if (node.textContent !== "1 tab idle · oldest 1 day") {
    throw new Error(`Idle nudge did not move from hours to days: ${node.textContent}`);
  }
  console.log("PASS: Open idle nudge evolves without a full section refresh");
} finally {
  fixture.restore();
}
