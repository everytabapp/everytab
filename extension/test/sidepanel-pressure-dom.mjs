/** Real-Chrome compact folded-header and expanded-copy regression. */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runOwnedChrome } from "./chrome-test-process.mjs";

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
const decodeReceipt = (output, id, specimen) => {
  const match = output.match(new RegExp(`<pre id="${id}"[^>]*>([\\s\\S]*?)</pre>`));
  const decoded = (match?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    .replaceAll("&gt;", ">").replaceAll("&lt;", "<");
  if (!decoded.trim()) {
    throw new Error(`${id} receipt missing at ${specimen.width}px/${specimen.zoom}% (fixture or page error)`);
  }
  try { return JSON.parse(decoded); }
  catch (error) {
    throw new Error(`${id} receipt invalid at ${specimen.width}px/${specimen.zoom}%: ${decoded}`, { cause: error });
  }
};

for (const specimen of [{ width: 320, zoom: 100 }, { width: 520, zoom: 200 }]) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-selection-keeper-dom-`);
  const page = new URL("../../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("keeperSelection", "1");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const { stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=3000", "--dump-dom", page.href
    ], {
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      completeWhen: (output) => output.includes('<pre id="selection-keeper-result"')
    });
    const result = decodeReceipt(output, "selection-keeper-result", specimen);
    if (!result.pass) throw new Error(
      `Selection keeper pressure failed at ${specimen.width}px/${specimen.zoom}%: ${JSON.stringify(result)}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

for (const specimen of [{ width: 320, zoom: 100 }, { width: 520, zoom: 200 }]) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-open-header-dom-`);
  const page = new URL("../../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("copy", "expanded");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const { stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=3000", "--dump-dom", page.href
    ], {
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      completeWhen: (output) => output.includes('id="header-readability-result"')
    });
    const result = decodeReceipt(output, "header-readability-result", specimen);
    if (!result.pass) throw new Error(
      `Open header readability failed at ${specimen.width}px/${specimen.zoom}%: ${JSON.stringify(result)}`);
    console.log(`PASS: Open header keeps ${Math.round(result.titleWidth)}px for its title at ` +
      `${specimen.width}px@${specimen.zoom}%`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

for (const specimen of cases) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-sidepanel-dom-`);
  const page = new URL("../../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("folded", "1");
  page.searchParams.set("copy", "expanded");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const { stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=3000", "--dump-dom", page.href
    ], {
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      completeWhen: (output) => output.includes('id="pressure-result"') &&
        output.includes('id="open-filter-layout-result"')
    });
    const result = decodeReceipt(output, "pressure-result", specimen);
    if (!result.pass) throw new Error(`Pressure failed at ${specimen.width}px/${specimen.zoom}%: ${JSON.stringify(result)}`);
    const filterResult = decodeReceipt(output, "open-filter-layout-result", specimen);
    if (!filterResult.pass) throw new Error(
      `Open filter placement failed at ${specimen.width}px/${specimen.zoom}%: ${JSON.stringify(filterResult)}`);
    results.push({ ...specimen, overflow: result.overflow });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

console.log(`PASS: side-panel pressure ${results.map((r) =>
  `${r.width}px@${r.zoom}% overflow=${r.overflow}`).join(", ")}`);

for (const specimen of [{ width: 320, zoom: 100 }, { width: 520, zoom: 200 }]) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-session-header-dom-`);
  const page = new URL("../../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("view", "sessions");
  page.searchParams.set("sessionHeader", "1");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const { stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=3000", "--dump-dom", page.href
    ], {
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      completeWhen: (output) => output.includes('id="session-pressure-result"')
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
  const page = new URL("../../tools/sidepanel-harness.html", import.meta.url);
  page.searchParams.set("view", "labels");
  page.searchParams.set("width", String(specimen.width));
  page.searchParams.set("zoom", String(specimen.zoom));
  try {
    const { stdout: output } = await runOwnedChrome(chromeBin, [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--no-first-run",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--virtual-time-budget=3000", "--dump-dom", page.href
    ], {
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      completeWhen: (output) => output.includes('id="group-nav-result"')
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
