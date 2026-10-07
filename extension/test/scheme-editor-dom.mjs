/** Mounted dedicated scheme editor workflow in Chrome's real DOM and CSS. */
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
const chromeBin = candidates.find((path) => existsSync(path));
if (!chromeBin) throw new Error("Chrome is required for the scheme editor DOM regression");

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(extensionRoot, "..");
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

try {
  const requestedWidth = Number(process.argv[2]);
  const viewports = requestedWidth ? [[requestedWidth, 820]] : [[1280, 820], [400, 820]];
  for (const [width, height] of viewports) {
    const profile = await mkdtemp(`${tmpdir()}/everytab-scheme-editor-dom-`);
    const page = `http://127.0.0.1:${server.address().port}/extension/test/scheme-editor-dom.html?source=builtin%3Acream&return=dashboard`;
    try {
      const { stdout: output } = await runOwnedChrome(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        `--window-size=${width},${height}`, `--user-data-dir=${profile}`,
        "--virtual-time-budget=18000", "--dump-dom", page
      ], { maxBuffer: 6 * 1024 * 1024, timeoutMs: 20_000, completeWhen: hasDomTestReceipt });
      const match = output.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/);
      const message = match?.[1]?.replaceAll("&gt;", ">").replaceAll("&lt;", "<") ?? "No result";
      if (!/data-status="pass"/.test(output)) throw new Error(`${width}px: ${message}`);
      console.log(message);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
