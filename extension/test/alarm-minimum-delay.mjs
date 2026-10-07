import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Chrome clamps chrome.alarms in packed (released) extensions: an alarm set
 * less than 30 s ahead does not fire for at least 30 s, and delayInMinutes or
 * periodInMinutes below 0.5 are not honored. Unpacked loads have no limit, so
 * every acceptance run so far observed the short timings. This source guard
 * keeps each sub-30 s alarm an explicit, documented fallback: the call must
 * carry an `alarm-fallback` comment within the preceding lines, meaning the
 * prompt work runs on a retained timer or the delay is acceptable at 30 s.
 */

const MIN_ALARM_MS = 30_000;
const MIN_ALARM_MINUTES = 0.5;
const MARKER = "alarm-fallback";
const MARKER_WINDOW_LINES = 8;

// Sites this guard cannot fix from the owned modules. Each one is a known,
// reported exception; removing it from the source must also remove it here.
const KNOWN_UNMARKED = [];

const root = fileURLToPath(new URL("../js/", import.meta.url));

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (entry.endsWith(".js")) yield path;
  }
}

function balancedSpan(text, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  return text.slice(openIndex);
}

const numeric = (literal) => Number(literal.replaceAll("_", ""));

const sites = [];
for (const path of sourceFiles(root)) {
  const source = readFileSync(path, "utf8");
  const file = relative(join(root, ".."), path).split("\\").join("/");
  // Matches alarms.create(, alarms?.create(, and alarms?.create?.(.
  const pattern = /alarms(?:\?\.|\.)create(?:\?\.)?\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const call = balancedSpan(source, match.index + match[0].length - 1, "(", ")");
    const optionsStart = call.indexOf("{");
    const options = optionsStart >= 0 ? balancedSpan(call, optionsStart, "{", "}") : "";
    const line = source.slice(0, match.index).split("\n").length;
    const precedingLines = source.split("\n").slice(Math.max(0, line - 1 - MARKER_WINDOW_LINES), line - 1);
    const marked = precedingLines.some((text) => text.includes(MARKER));
    const literalMs = [...options.matchAll(/\+\s*(\d[\d_]*)\b/g)].map(([, literal]) => numeric(literal));
    const identifiers = [...options.matchAll(/\+\s*([A-Za-z_$][\w$.]*)\s*\(?/g)].map(([, name]) => name);
    const minutes = [...options.matchAll(/(?:delayInMinutes|periodInMinutes)\s*:\s*(\d[\d_.]*)/g)]
      .map(([, literal]) => numeric(literal));
    sites.push({ file, line, options, marked, literalMs, identifiers, minutes });
  }
}

assert.ok(sites.length >= 15, `expected the known alarm sites to be found, saw ${sites.length}`);

// Non-literal relative delays that are proven elsewhere to be at or above
// the minimum. The proof is asserted here so the exemption cannot go stale.
const backgroundSource = readFileSync(join(root, "background.js"), "utf8");
const dedupGrace = numeric(/const DEDUP_GRACE_MS = (\d[\d_]*)/.exec(backgroundSource)?.[1] ?? "0");
assert.ok(dedupGrace >= MIN_ALARM_MS, "duplicate grace is at least the packed alarm minimum");
const PROVEN_IDENTIFIERS = new Set(["duplicates.graceMs"]);

for (const site of sites) {
  for (const minute of site.minutes) {
    assert.ok(minute >= MIN_ALARM_MINUTES,
      `${site.file}:${site.line} uses a minute delay below ${MIN_ALARM_MINUTES}, which Chrome does not honor`);
  }
}

const unmarked = sites.filter((site) => {
  if (site.marked) return false;
  const shortLiteral = site.literalMs.some((ms) => ms < MIN_ALARM_MS);
  const unknownRelative = site.identifiers.some((name) => !PROVEN_IDENTIFIERS.has(name));
  return shortLiteral || unknownRelative;
}).map((site) => ({
  file: site.file,
  literalMs: site.literalMs.find((ms) => ms < MIN_ALARM_MS) ?? null,
  identifiers: site.identifiers.filter((name) => !PROVEN_IDENTIFIERS.has(name))
}));

assert.deepEqual(
  unmarked.map(({ file, literalMs }) => ({ file, literalMs })),
  KNOWN_UNMARKED.map(({ file, literalMs }) => ({ file, literalMs })),
  `every alarm created under ${MIN_ALARM_MS} ms must be marked "${MARKER}" or listed as a known exception; ` +
    `unmarked: ${JSON.stringify(unmarked)}`
);

// The marked fallbacks are the ones this batch decided; keep their identity
// visible so a new short alarm is a deliberate review item.
const marked = sites.filter((site) => site.marked).map((site) => site.file).sort();
assert.deepEqual([...new Set(marked)], [
  "js/background/runtime-lifecycle-owner.js",
  "js/background/suspend-recovery-owner.js",
  "js/lib/focus-guard.js",
  "js/lib/suspend.js"
], "the documented alarm fallbacks live in the lifecycle, recovery owner, Focus guard and suspend modules");

// The recovery owner's retry helper is one of those fallbacks: its first
// retry is shorter than the packed minimum and is acceptable at 30 s.
const { recoveryNotificationRetryDelay } = await import("../js/lib/suspend-recovery-schedule.js");
assert.ok(recoveryNotificationRetryDelay(0) < MIN_ALARM_MS);
assert.ok(recoveryNotificationRetryDelay(2) >= MIN_ALARM_MS,
  "later notification retries already respect the packed minimum");

// Prompt work must not depend on the clamped alarm: the lifecycle owner runs
// metadata repair on a retained timer and keeps only a 30 s alarm fallback.
const lifecycleSource = readFileSync(join(root, "background/runtime-lifecycle-owner.js"), "utf8");
assert.match(lifecycleSource, /SUSPEND_METADATA_REPAIR_ALARM, \{\s*when: Date\.now\(\) \+ 30_000/,
  "the metadata repair alarm is scheduled at the packed minimum");
assert.match(lifecycleSource, /scheduleRuntimeTask\("suspended metadata repair"/,
  "the prompt metadata repair runs on a retained worker timer");

console.log(`PASS: ${sites.length} alarm sites checked; ${unmarked.length} known sub-30 s exception(s) outside owned modules`);
