/** Real-Chrome compact folded-header and expanded-copy regression. */
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
if (!chromeBin) throw new Error("Chrome is required for the side-panel pressure regression");

const cases = [
  { width: 320, zoom: 100 },
  { width: 400, zoom: 100 },
  { width: 520, zoom: 100 },
  { width: 520, zoom: 200 }
];
const results = [];

for (const specimen of cases) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-sidepanel-dom-`);
  const page = new URL("../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("folded", "1");
  page.searchParams.set("copy", "expanded");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        "--allow-file-access-from-files", `--user-data-dir=${profile}`,
        "--virtual-time-budget=3000", "--dump-dom", page.href
      ], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout);
      });
    });
    const match = output.match(/<pre id="pressure-result"[^>]*>([\s\S]*?)<\/pre>/);
    const encoded = match?.[1] ?? "";
    const decoded = encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
    const result = JSON.parse(decoded);
    if (!result.pass) throw new Error(`Pressure failed at ${specimen.width}px/${specimen.zoom}%: ${decoded}`);
    results.push({ ...specimen, overflow: result.overflow });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

console.log(`PASS: side-panel pressure ${results.map((r) =>
  `${r.width}px@${r.zoom}% overflow=${r.overflow}`).join(", ")}`);

for (const specimen of [{ width: 320, zoom: 100 }, { width: 520, zoom: 200 }]) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-session-header-dom-`);
  const page = new URL("../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("view", "sessions");
  page.searchParams.set("sessionHeader", "1");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        "--allow-file-access-from-files", `--user-data-dir=${profile}`,
        "--virtual-time-budget=3000", "--dump-dom", page.href
      ], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout);
      });
    });
    const match = output.match(/<pre id="session-pressure-result"[^>]*>([\s\S]*?)<\/pre>/);
    const decoded = (match?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
    const result = JSON.parse(decoded);
    if (!result.pass) throw new Error(
      `Session header pressure failed at ${specimen.width}px/${specimen.zoom}%: ${decoded}`);
    console.log(`PASS: seven Session actions at ${specimen.width}px@${specimen.zoom}% overflow=${result.overflow}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

for (const specimen of [{ width: 320, zoom: 100 }, { width: 520, zoom: 200 }]) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-group-nav-dom-`);
  const page = new URL("../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("view", "labels");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        "--allow-file-access-from-files", `--user-data-dir=${profile}`,
        "--virtual-time-budget=3000", "--dump-dom", page.href
      ], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout);
      });
    });
    const match = output.match(/<pre id="group-nav-result"[^>]*>([\s\S]*?)<\/pre>/);
    const decoded = (match?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
    const result = JSON.parse(decoded);
    if (!result.pass) throw new Error(
      `Group navigation failed at ${specimen.width}px@${specimen.zoom}%: ${decoded}`);
    console.log(`PASS: side-panel group navigation at ${specimen.width}px@${specimen.zoom}% overflow=${result.overflow}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
