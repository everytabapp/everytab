/** Pure content contract for the generated, non-authoritative Vault views. */
import assert from "node:assert/strict";
import {
  buildReadableIndex,
  buildReadableLibrary
} from "../js/vault/readable-views.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const FAVICON = "data:image/png;base64,AQIDBA==";
const meta = (id) => ({ id, createdAt: 1, modifiedAt: 1, schemaVersion: 1 });
const live = (family, id, value, assetDigests = []) => ({
  family,
  id,
  lifecycle: "live",
  value,
  assetDigests
});

const checkpoint = {
  contentHash: `sha256:${"b".repeat(64)}`,
  assets: [{ digest: DIGEST, dataUrl: FAVICON, mimeType: "image/png", byteLength: 4 }],
  entities: [
    live("inbox", "inbox-one", {
      ...meta("inbox-one"),
      kind: "tab",
      tabs: [{
        url: "https://inbox.example/a_(b)",
        title: "Inbox [one]",
        everytabAsset: DIGEST,
        labels: ["Read [later]"]
      }],
      labels: []
    }, [DIGEST]),
    live("archive", "archive-one", {
      ...meta("archive-one"),
      kind: "tab",
      tabs: [{ url: "https://archive.example", title: "Archive" }],
      labels: []
    }),
    live("sessions", "session-one", {
      ...meta("session-one"),
      name: "Research [2026]",
      auto: false,
      windows: [[{ url: "https://session.example", title: "Session tab" }]],
      labels: []
    }),
    live("organizationGroups", "label-group", {
      ...meta("label-group"), organizationKind: "label", name: "Reading"
    }),
    live("organizationGroups", "session-group", {
      ...meta("session-group"), organizationKind: "session", name: "Projects"
    }),
    live("organizationMemberships", "label-edge", {
      ...meta("label-edge"), organizationKind: "label",
      memberKey: "Read [later]", groupId: "label-group"
    }),
    live("organizationMemberships", "session-edge", {
      ...meta("session-edge"), organizationKind: "session",
      memberKey: "session-one", groupId: "session-group"
    }),
    {
      family: "inbox",
      id: "removed",
      lifecycle: "deleted",
      deletedAt: 2,
      assetDigests: []
    }
  ]
};

const readable = buildReadableLibrary(checkpoint, {
  vaultId: "vault-readable",
  inputHash: `sha256:${"c".repeat(64)}`,
  generatedAt: Date.UTC(2026, 8, 3)
});
assert.equal(readable.kind, "vault-v2-readable-library");
assert.equal(readable.summary.records, 7);
assert.equal(readable.families.inbox["inbox-one"].tabs[0].favIconUrl, FAVICON,
  "the readable JSON restores the original embedded favicon value");
assert.ok(!Object.hasOwn(readable.families.inbox, "removed"),
  "compact deletion state stays in the sync protocol rather than the live-data view");
assert.ok(!JSON.stringify(readable).includes("everytabAsset"),
  "private asset references do not leak into the self-contained readable view");

const index = buildReadableIndex(readable);
assert.ok(index.includes("# EveryTab Vault"));
assert.ok(index.includes("Inbox: 1 item, 1 tab"));
assert.ok(index.includes("### Reading (1)"));
assert.ok(index.includes("Read \\[later\\]"), "Markdown text is escaped");
assert.ok(index.includes("### Projects (1)"));
assert.ok(index.includes("Research \\[2026\\]"));
assert.ok(index.includes("[Session tab](<https://session.example>)"));
assert.ok(!index.includes("removed"), "the Markdown view also excludes tombstones");

console.log("PASS: Vault readable Library and Markdown view content");
