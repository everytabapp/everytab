/** Deterministic measurement inputs and independent expectations; no production imports. */
export const MIXED_SCENARIOS = [
  { records: 1_000, icons: 64, inboxTabs: 100, namedSessions: 10, snapshots: 20, tabsPerSession: 30 },
  { records: 10_000, icons: 64, inboxTabs: 1_000, namedSessions: 30, snapshots: 60, tabsPerSession: 100 }
];
export const WORKLOADS = ["selective", "broad", "facets"];
const BASE_TIME = 1_700_000_000_000;
const DOMAIN_COUNT = 16;
const DOMAIN_OFFSET = 5;
const padded = (value, width = 3) => String(value).padStart(width, "0");
const domain = index => `fixture${padded(index, 2)}.invalid`;
const nameOf = index => `Bundle ${padded(index)}`;

function validateScenario(scenario) {
  if (!scenario || ["records", "icons", "inboxTabs", "namedSessions", "snapshots", "tabsPerSession"]
    .some(key => !Number.isSafeInteger(scenario[key]) || scenario[key] <= 0) ||
      scenario.icons > scenario.records || scenario.inboxTabs < 50 || scenario.tabsPerSession < 2 ||
      scenario.tabsPerSession % 2 !== 0 || scenario.records !== scenario.inboxTabs +
        (scenario.namedSessions + scenario.snapshots) * scenario.tabsPerSession) {
    throw new Error("Invalid mixed Search fixture dimensions");
  }
}

function tabOrdinal(scenario, source, record, index = 0) {
  if (source === "inbox") return record;
  return scenario.inboxTabs + (source === "snapshot" ? scenario.namedSessions * scenario.tabsPerSession : 0) +
    record * scenario.tabsPerSession + index;
}
function tabUrl(scenario, source, record, index = 0) {
  const host = domain((tabOrdinal(scenario, source, record, index) + DOMAIN_OFFSET) % DOMAIN_COUNT);
  return `https://tabs.${host}/${source}/${padded(record)}/${padded(index)}`;
}
function tabTitle(source, record, index = 0, edited = false) {
  const selective = record === 0 && index === 0;
  return `commonfixture ${source} ${padded(record)} ${padded(index)}` +
    (selective ? " zebramixed" : "") + (edited && source === "named" && selective ? " revised" : "");
}
function timestamp(scenario, source, index) {
  return BASE_TIME - (source === "inbox" ? 0 : scenario.inboxTabs) -
    (source === "snapshot" ? scenario.namedSessions : 0) - index;
}
function recordMeta(scenario, source, index) {
  const at = timestamp(scenario, source, index);
  return { id: `mixed-${source}-${padded(index)}`, deviceId: "synthetic-mixed-search",
    schemaVersion: 1, createdAt: at, modifiedAt: at };
}
function iconValues(count) {
  return Array.from({ length: count }, (_, index) => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><!--${padded(index, 6)}${"x".repeat(900)}--><rect width="16" height="16" fill="#4285f4"/></svg>`
  )}`);
}

/** records counts all tabs, not records: Inbox has one tab; each Session has two windows. */
export function makeMixedFixture(scenario) {
  validateScenario(scenario);
  const icons = iconValues(scenario.icons);
  const tab = (source, record, index = 0) => {
    const ordinal = tabOrdinal(scenario, source, record, index);
    return { title: tabTitle(source, record, index), url: tabUrl(scenario, source, record, index),
      favIconUrl: icons[ordinal % icons.length], pinned: index === 0,
      labels: source === "inbox" ? [`inbox-tab-${record % 8}`, "shared-label"]
        : source === "named" ? [`named-label-${(record * scenario.tabsPerSession + index) % 8}`, "shared-label"]
        : ["snapshot-only", `snapshot-label-${index % 8}`] };
  };
  const session = (source, index) => {
    const tabs = Array.from({ length: scenario.tabsPerSession }, (_, tabIndex) => tab(source, index, tabIndex));
    return { ...recordMeta(scenario, source, index), auto: source === "snapshot",
      name: source === "named" ? nameOf(index) : `Automatic ${padded(index)}`,
      labels: ["record-only-ignored"],
      windows: [tabs.slice(0, scenario.tabsPerSession / 2), tabs.slice(scenario.tabsPerSession / 2)] };
  };
  return {
    inbox: Array.from({ length: scenario.inboxTabs }, (_, index) => ({ ...recordMeta(scenario, "inbox", index),
      kind: "tab", source: "manual", labels: [`inbox-item-${index % 4}`, "shared-label"], tabs: [tab("inbox", index)] })),
    named: Array.from({ length: scenario.namedSessions }, (_, index) => session("named", index)),
    snapshots: Array.from({ length: scenario.snapshots }, (_, index) => session("snapshot", index))
  };
}

/** A detached real edit; all URLs, window placement and favicon bytes stay intact. */
export function editedNamedRecord(fixture) {
  if (!fixture?.named?.[0]?.windows?.[0]?.[0]) throw new Error("Mixed fixture has no named edit target");
  const record = structuredClone(fixture.named[0]);
  const tab = record.windows[0][0];
  tab.title = tabTitle("named", 0, 0, true);
  tab.labels = ["named-edited", "shared-label"];
  record.modifiedAt = BASE_TIME + 1;
  return record;
}

/** Facets are API-only and must not prime a Search query. */
export function queryFor(workload) {
  if (workload === "selective") return "zebramixed";
  if (workload === "broad") return "commonfixture";
  if (workload === "facets") return null;
  throw new Error("Unknown mixed Search workload");
}

/** Construct exact expected SearchResult objects without evaluating production ranking. */
export function expectedMixedRows(scenario, { workload, edited = false, complete = false } = {}) {
  validateScenario(scenario);
  if (workload === "facets") throw new Error("Facet workload has no result rows");
  queryFor(workload);
  const inboxRow = index => ({ type: "inbox", title: tabTitle("inbox", index),
    url: tabUrl(scenario, "inbox", index) });
  if (workload === "broad") return Array.from({ length: 50 }, (_, index) => inboxRow(index));
  return [inboxRow(0), ...(complete ? [
    { type: "session", title: tabTitle("named", 0, 0, edited), url: tabUrl(scenario, "named", 0), sourceName: nameOf(0) },
    { type: "session", title: tabTitle("snapshot", 0), url: tabUrl(scenario, "snapshot", 0), sourceName: undefined,
      sourceCreatedAt: timestamp(scenario, "snapshot", 0), snapshot: true }
  ] : [])];
}

/** Searchbox renders at most 15 rows from Search's independently capped 50-result model. */
export function expectedMixedDomRows(scenario, options) {
  return expectedMixedRows(scenario, options).slice(0, 15);
}

const bucketCount = (total, bucket, buckets) => Math.floor(total / buckets) + Number(bucket < total % buckets);

/** Expected complete facets from fixture dimensions; Snapshot labels never count. */
export function expectedMixedFacets(scenario, edited = false) {
  validateScenario(scenario);
  const namedTabs = scenario.namedSessions * scenario.tabsPerSession;
  const labels = [
    ...Array.from({ length: 4 }, (_, index) => ({ label: `inbox-item-${index}`, tabs: bucketCount(scenario.inboxTabs, index, 4) })),
    ...Array.from({ length: 8 }, (_, index) => ({ label: `inbox-tab-${index}`, tabs: bucketCount(scenario.inboxTabs, index, 8) })),
    ...Array.from({ length: 8 }, (_, index) => ({ label: `named-label-${index}`,
      tabs: bucketCount(namedTabs, index, 8) - Number(edited && index === 0) })),
    { label: "shared-label", tabs: scenario.inboxTabs + namedTabs },
    ...(edited ? [{ label: "named-edited", tabs: 1 }] : [])
  ].filter(item => item.tabs > 0).sort((left, right) => left.label.localeCompare(right.label));
  const domains = Array.from({ length: DOMAIN_COUNT }, (_, index) => ({ domain: domain(index),
    tabs: bucketCount(scenario.records, (index - DOMAIN_OFFSET + DOMAIN_COUNT) % DOMAIN_COUNT, DOMAIN_COUNT) }))
    .sort((left, right) => right.tabs - left.tabs || left.domain.localeCompare(right.domain))
    .map(item => item.domain);
  return { labels, sessions: Array.from({ length: scenario.namedSessions }, (_, index) => nameOf(index)), domains };
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
export function assertMixedRows(actual, expected) {
  if (!Array.isArray(actual) || !sameValue(actual, expected)) throw new Error("Mixed Search rows differ from exact fixture expectations");
}
export function assertMixedFacets(actual, expected) {
  if (!sameValue(actual, expected)) throw new Error("Mixed Search facets differ from exact fixture expectations");
}

/** Observable cache contract: named edits invalidate Search, but retain cached Inbox data. */
export function assertMixedCache(workload, phase, current) {
  const fail = () => {
    const error = new Error("Mixed Search cache phase mismatch");
    error.code = "cache-phase";
    throw error;
  };
  if (!WORKLOADS.includes(workload) || !["first", "warm-immediate", "warm-expired", "after-edit"].includes(phase) ||
      !Array.isArray(current?.calls) || !current.requests || typeof current.requests !== "object" ||
      Array.isArray(current.requests)) fail();
  const count = (label, family) => current.calls.filter(call => call?.label === label &&
    (family === undefined || call.family === family)).length;
  const rebuild = phase === "first" || phase === "after-edit";
  const fullRead = workload !== "broad" && (rebuild || (workload === "selective" && phase === "warm-expired"));
  if (count("primarySnapshotBuild") !== Number(workload !== "facets" && rebuild) ||
      count("libraryFamilyRead", "inbox") !== Number(phase === "first") ||
      (count("libraryFamilyRead", "sessions") > 0) !== fullRead ||
      count("recoverySnapshotRead") !== Number(fullRead) || (current.requests["assets.get"] ?? 0) !== 0 ||
      (phase.startsWith("warm") && !fullRead &&
        (current.calls.length !== 0 || Object.keys(current.requests).length !== 0))) fail();
}
