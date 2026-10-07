import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildCwsPackage } from "../../tools/package-cws.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(extensionRoot, "..");
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const distArgIndex = process.argv.indexOf("--dist-dir");
const distRoot = distArgIndex >= 0
  ? path.resolve(process.cwd(), process.argv[distArgIndex + 1] ?? "")
  : path.join(repositoryRoot, "dist");
const archiveName = `everytab-${manifest.version}.zip`;
const receiptName = `everytab-${manifest.version}-package.json`;
const archivePath = path.join(distRoot, archiveName);
const receiptPath = path.join(distRoot, receiptName);
const testRoot = mkdtempSync(path.join(tmpdir(), "everytab-cws-artifact-"));
const regenerationHint = "Regenerate the final artifact with node tools/package-cws.mjs";

try {
  assert.ok(existsSync(archivePath), `Checked-in release archive is missing. ${regenerationHint}`);
  assert.ok(existsSync(receiptPath), `Checked-in package receipt is missing. ${regenerationHint}`);
  const checkedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const archiveHash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  assert.equal(checkedReceipt.sha256, archiveHash,
    `Checked-in receipt does not describe its archive. ${regenerationHint}`);

  const fresh = buildCwsPackage({ outputRoot: testRoot });
  if (!isDeepStrictEqual(checkedReceipt, fresh.receipt)) {
    throw new Error(
      `Checked-in package is stale relative to the runtime source ` +
      `(${checkedReceipt.fileCount} files / ${checkedReceipt.sha256} checked in; ` +
      `${fresh.receipt.fileCount} files / ${fresh.receipt.sha256} current). ${regenerationHint}`
    );
  }
  console.log(`PASS: checked-in CWS artifact ${archiveHash.slice(0, 12)} matches runtime source`);
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
