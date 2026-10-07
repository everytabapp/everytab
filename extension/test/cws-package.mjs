import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCwsPackage, runtimeSourcePath } from "../../tools/package-cws.mjs";
import { extractZipArchive } from "../../tools/zip-archive.mjs";

const testRoot = mkdtempSync(path.join(tmpdir(), "everytab-cws-test-"));
const outputRoot = path.join(testRoot, "first");

try {
  const { archivePath, receiptPath, receipt } = buildCwsPackage({ outputRoot });
  const second = buildCwsPackage({ outputRoot: path.join(testRoot, "second") });
  const persisted = JSON.parse(readFileSync(receiptPath, "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  if (receipt.version !== manifest.version) throw new Error("package version does not match the manifest");
  if (receipt.fileCount < 100) throw new Error("runtime package is unexpectedly sparse");
  if (!receipt.entries.includes("manifest.json") || !receipt.entries.includes("js/background.js")) {
    throw new Error("essential runtime entries are missing");
  }
  if (!receipt.entries.includes("LICENSE")) throw new Error("the package does not carry the MPL-2.0 license text");
  if (receipt.entries.some((entry) => /^(?:LICENSE|manifest\.json)$/.test(entry) && entry.includes("/"))) {
    throw new Error("root notices must sit at the archive root");
  }
  if (receipt.entries.some((entry) => entry.startsWith("test/") || entry.startsWith("tools/"))) {
    throw new Error("development directories entered the package");
  }
  if (persisted.sha256 !== receipt.sha256 || !readFileSync(archivePath).length) {
    throw new Error("package receipt does not describe its archive");
  }
  if (second.receipt.sha256 !== receipt.sha256) {
    throw new Error("identical runtime sources did not produce an identical archive");
  }
  const unpackedRoot = path.join(testRoot, "unpacked");
  extractZipArchive(archivePath, unpackedRoot);
  for (const entry of receipt.entries) {
    if (!readFileSync(path.join(unpackedRoot, entry)).equals(readFileSync(runtimeSourcePath(entry)))) {
      throw new Error(`extracted runtime entry differs from its source: ${entry}`);
    }
  }
  console.log(`PASS: CWS archive contains ${receipt.fileCount} verified runtime files only`);
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
