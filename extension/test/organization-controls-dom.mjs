import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((path) => existsSync(path));
if (!chromeBin) throw new Error("Chrome is required for the organization-controls DOM test");

const widths = (process.env.ORGANIZATION_TEST_WIDTHS ?? "320,800")
  .split(",").map(Number).filter(Number.isFinite);
for (const width of widths) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-organization-ui-`);
  try {
    const page = process.env.ORGANIZATION_TEST_URL ??
      new URL("./organization-controls-dom.html", import.meta.url).href;
    const output = await new Promise((resolve, reject) => execFile(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      `--window-size=${width},900`, "--virtual-time-budget=8000", "--dump-dom", page
    ], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout);
    }));
    const match = output.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
    const text = (match?.[2] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
    if (match?.[1] !== "pass") throw new Error(`${width}px: ${text || "No result"}`);
    console.log(`${width}px ${text}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
