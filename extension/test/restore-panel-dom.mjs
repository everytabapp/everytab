/** Mounted Restore workflow regression in Chrome's real DOM. */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDomTestReceipt, runOwnedChrome } from "./chrome-test-process.mjs";

const candidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const chromeBin = candidates.find((path) => {
  try { return existsSync(path); }
  catch { return false; }
});
if (!chromeBin) throw new Error("Chrome is required for the mounted Restore panel regression");

const profile = await mkdtemp(`${tmpdir()}/everytab-restore-dom-`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const target = resolve(root, `.${path}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("outside fixture root");
    const body = await readFile(target);
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    if (!response.writableEnded) response.end("Not found");
  }
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const page = `http://127.0.0.1:${server.address().port}/test/restore-panel-dom.html`;
try {
  const { stdout: output } = await runOwnedChrome(chromeBin, [
    "--headless=new", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--no-first-run",
    "--allow-file-access-from-files", `--user-data-dir=${profile}`,
    "--virtual-time-budget=10000", "--dump-dom", page
  ], { maxBuffer: 4 * 1024 * 1024, timeoutMs: 15_000, completeWhen: hasDomTestReceipt });
  const match = output.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/);
  const result = match?.[1]?.replaceAll("&gt;", ">").replaceAll("&lt;", "<") ?? "No result";
  if (!/data-status="pass"/.test(output)) throw new Error(result);
  console.log(result);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
}
