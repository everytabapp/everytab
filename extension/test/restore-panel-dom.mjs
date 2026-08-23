/** Mounted Restore workflow regression in Chrome's real DOM. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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
const page = new URL("./restore-panel-dom.html", import.meta.url).href;
try {
  const output = await new Promise((resolve, reject) => {
    execFile(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=10000", "--dump-dom", page
    ], { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
  const match = output.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/);
  const result = match?.[1]?.replaceAll("&gt;", ">").replaceAll("&lt;", "<") ?? "No result";
  if (!/data-status="pass"/.test(output)) throw new Error(result);
  console.log(result);
} finally {
  await rm(profile, { recursive: true, force: true });
}
