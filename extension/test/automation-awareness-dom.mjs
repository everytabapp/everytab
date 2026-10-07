import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOwnedChrome } from "./chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the automation-awareness DOM test");

const profile = await mkdtemp(`${tmpdir()}/everytab-awareness-ui-`);
const extensionRoot = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = path.resolve(extensionRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (file !== extensionRoot && !file.startsWith(`${extensionRoot}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const screenshot = process.env.AWARENESS_SCREENSHOT;
const page = `http://127.0.0.1:${server.address().port}/test/automation-awareness-dom.html${screenshot ? "?preview" : ""}`;
try {
  let output;
  try {
    ({ stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--window-size=1440,1000", `--user-data-dir=${profile}`,
      ...(screenshot ? [`--screenshot=${path.resolve(screenshot)}`] : []),
      "--virtual-time-budget=5000", "--dump-dom", page
    ], {
      timeoutMs: 15_000,
      // Let Chrome finish writing the image before retiring a visual-preview run.
      ...(!screenshot ? { completeWhen: (dump) =>
        dump.includes('data-status="pass"') || dump.includes('data-status="fail"') } : {})
    }));
  } catch (error) {
    if (!error.stdout) throw error;
    output = error.stdout;
  }
  const status = output.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
  if (status?.[1] !== "pass") {
    throw new Error(status?.[2] || `Automation awareness DOM test failed\n${output.slice(-4000)}`);
  }
  console.log(status[2]);
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
}
