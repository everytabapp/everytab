import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDomTestReceipt, runOwnedChrome } from "./chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((path) => existsSync(path));
if (!chromeBin) throw new Error("Chrome is required for the organization-controls DOM test");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const target = resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("outside fixture root");
    const body = await readFile(target);
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});

const widths = (process.env.ORGANIZATION_TEST_WIDTHS ?? "320,800")
  .split(",").map(Number).filter(Number.isFinite);
try {
  for (const width of widths) {
    const profile = await mkdtemp(`${tmpdir()}/everytab-organization-ui-`);
    try {
      const page = process.env.ORGANIZATION_TEST_URL ??
        `http://127.0.0.1:${server.address().port}/test/organization-controls-dom.html`;
      const { stdout: output } = await runOwnedChrome(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        `--user-data-dir=${profile}`, `--window-size=${width},900`,
        "--virtual-time-budget=8000", "--dump-dom", page
      ], { timeoutMs: 20_000, maxBuffer: 4 * 1024 * 1024, completeWhen: hasDomTestReceipt });
      const match = output.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      const text = (match?.[2] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
        .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
      if (match?.[1] !== "pass") throw new Error(`${width}px: ${text || "No result"}`);
      console.log(`${width}px ${text}`);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
