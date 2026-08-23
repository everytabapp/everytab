import fs from "node:fs";
import { createChromeI18nMock } from "./message-fixture.mjs";

globalThis.chrome = { i18n: createChromeI18nMock() };

const {
  createSearchSnapshot, matchSearchSnapshot, searchResultTarget
} = await import("../js/lib/search.js");
const {
  decodeOmniboxTarget, encodeOmniboxTarget, executeOmniboxPlan,
  formatOmniboxDescription, omniboxNavigationPlan, omniboxSuggestion
} = await import("../js/lib/omnibox.js");

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const meta = (id) => ({
  id, deviceId: "device", createdAt: 1, modifiedAt: 1, schemaVersion: 1
});
const labelGroup = { ...meta("label-group"), organizationKind: "label", name: "Work" };
const labelAlias = {
  ...meta("label-group-alias"), createdAt: 2, modifiedAt: 2,
  organizationKind: "label", name: "WORK"
};
const sessionGroup = { ...meta("session-group"), organizationKind: "session", name: "Work" };
const snapshot = createSearchSnapshot({
  inbox: [{
    ...meta("inbox"), kind: "tab", source: "manual", labels: [],
    tabs: [
      { title: "Plan", url: "https://plan.example", labels: ["project"] },
      { title: "Notes", url: "https://notes.example", labels: ["other"] }
    ]
  }],
  sessions: [{
    ...meta("session"), name: "Client review", auto: false, labels: [],
    windows: [[{ title: "Roadmap", url: "https://roadmap.example" }]]
  }],
  organizationGroups: [labelGroup, labelAlias, sessionGroup],
  organizationMemberships: [
    { ...meta("label-edge"), organizationKind: "label", groupId: labelGroup.id, memberKey: "project" },
    { ...meta("label-alias-edge"), organizationKind: "label", groupId: labelAlias.id, memberKey: "other" },
    { ...meta("session-edge"), organizationKind: "session", groupId: sessionGroup.id, memberKey: "session" },
    { ...meta("orphan-edge"), organizationKind: "session", groupId: sessionGroup.id, memberKey: "missing" }
  ]
});

const one = await matchSearchSnapshot(snapshot, "w");
check(one.every((result) => !result.type.endsWith("group-entity")),
  "one-character Search never adds organization navigation");

const two = await matchSearchSnapshot(snapshot, "wo");
check(two.length === 2 &&
  two.some((result) => result.type === "label-group-entity" && result.memberCount === 2 &&
    result.groupId === labelGroup.id) &&
  two.some((result) => result.type === "session-group-entity" && result.memberCount === 1),
"same-named Label and Session groups remain two entities while Vault aliases collapse to one union lens");

const scoped = await matchSearchSnapshot(snapshot, "label:project plan");
check(scoped.some((result) => result.type === "inbox") &&
  scoped.every((result) => !result.type.endsWith("group-entity")),
"existing label scope remains a tab filter and never becomes group grammar");

const crowded = createSearchSnapshot({
  sessions: Array.from({ length: 4 }, (_, index) => ({
    ...meta(`crowded-session-${index}`), name: `Work ${index + 1}`,
    auto: false, labels: [], windows: []
  })),
  inbox: [{
    ...meta("crowded-inbox"), kind: "tab", source: "manual", labels: [],
    tabs: [{ title: "Project", url: "https://project.example", labels: ["project"] }]
  }],
  organizationGroups: [labelGroup, sessionGroup],
  organizationMemberships: [
    { ...meta("crowded-label-edge"), organizationKind: "label", groupId: labelGroup.id, memberKey: "project" },
    { ...meta("crowded-session-edge"), organizationKind: "session", groupId: sessionGroup.id,
      memberKey: "crowded-session-0" }
  ]
});
const crowdedResults = await matchSearchSnapshot(crowded, "wo");
check(crowdedResults.filter((result) => result.type.endsWith("group-entity")).length === 2,
  "matching Label and Session groups remain discoverable when many named Sessions also match");

for (const result of two) {
  const target = searchResultTarget(result);
  check(target?.type === "open-organization-group" && target.groupId === result.groupId,
    "group result resolves to an explicit navigation-only target");
  const encoded = encodeOmniboxTarget(target);
  check(encoded && JSON.stringify(decodeOmniboxTarget(encoded)) === JSON.stringify(target),
    "omnibox preserves the exact group target without worker memory");
  check(omniboxSuggestion(result)?.content === encoded &&
    /<match>View<\/match>/.test(formatOmniboxDescription(result)),
  "omnibox presents group entities as View, not Restore/Open all");
  const plan = omniboxNavigationPlan(target, "newForegroundTab");
  check(plan?.kind === "open-group", "group target ignores tab disposition and plans one lens open");
  const calls = [];
  check(await executeOmniboxPlan(plan, {
    openOrganizationGroup: async (...args) => { calls.push(args); return true; }
  }) && calls.length === 1 && calls[0][0] === result.organizationKind && calls[0][1] === result.groupId,
  "omnibox executes only Dashboard group navigation");
}

const dashboardSource = fs.readFileSync(
  new URL("../js/ui/dashboard.js", import.meta.url), "utf8"
);
check(
  dashboardSource.includes('/^(label|session)-group:(.+)$/') &&
  dashboardSource.includes('history.replaceState(null, "", kind === "label" ? "#labels" : "#sessions")') &&
  dashboardSource.includes("await goToLabelGroup(groupId)") &&
  dashboardSource.includes("await goToSessionGroup(groupId)"),
"Dashboard consumes either group deep link, settles its hash, and selects the shared surface lens"
);

console.log("PASS: Label/Session groups are two-character navigation entities only");
