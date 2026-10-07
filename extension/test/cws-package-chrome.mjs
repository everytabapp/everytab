import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCwsPackage } from "../../tools/package-cws.mjs";
import { extractZipArchive } from "../../tools/zip-archive.mjs";

const testRoot = mkdtempSync(path.join(tmpdir(), "everytab-cws-chrome-"));
const unpackedRoot = path.join(testRoot, "unpacked");

try {
  const { archivePath, receipt } = buildCwsPackage({ outputRoot: path.join(testRoot, "dist") });
  extractZipArchive(archivePath, unpackedRoot);

  process.env.EVERYTAB_EXTENSION_ROOT = unpackedRoot;
  process.env.EVERYTAB_OPEN_COUNT ??= "2";
  await import("./theme-on-open-extension.mjs");
  console.log(`PASS: exact CWS archive ${receipt.sha256.slice(0, 12)} loaded and ran in Chrome`);
} finally {
  delete process.env.EVERYTAB_EXTENSION_ROOT;
  rmSync(testRoot, { recursive: true, force: true });
}
