/** Real-Chrome Scheme Lab production-CSS contract at its three capture widths. */
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
if (!chromeBin) throw new Error("Chrome is required for the Scheme Lab DOM regression");

const cases = [
  { kind: "wide", expected: 5 },
  { kind: "narrow", expected: 5 },
  { kind: "pressure", expected: 4 }
];
const results = [];

for (const specimen of cases) {
  const profile = await mkdtemp(`${tmpdir()}/everytab-scheme-lab-dom-`);
  const page = new URL("../../tools/scheme-lab.html", import.meta.url);
  page.searchParams.set("contact", specimen.kind);
  page.searchParams.set("page", "1");
  try {
    let output;
    try {
      ({ stdout: output } = await runOwnedChrome(chromeBin, [
        "--headless=new", "--disable-gpu", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-first-run",
        "--allow-file-access-from-files", `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000", "--dump-dom", page.href
      ], {
        maxBuffer: 12 * 1024 * 1024,
        timeoutMs: 15_000,
        completeWhen: (dump) => dump.includes(`data-contact-kind="${specimen.kind}"`) &&
          (dump.match(/data-lab-shell-contract="(?:pass|fail|pending-mount)"/g)?.length ?? 0) >=
            specimen.expected
      }));
    } catch (error) {
      // Chrome 150 on macOS can leave --dump-dom alive after emitting its one
      // complete document. Validate that captured document instead of turning
      // a browser teardown defect into a product failure.
      if (!error.stdout) throw error;
      output = error.stdout;
    }
    const entries = output.match(/class="lab-contact-entry"/g)?.length ?? 0;
    const passes = output.match(/data-lab-shell-contract="pass"/g)?.length ?? 0;
    const failures = output.match(/data-lab-shell-contract="(?:fail|pending-mount)"/g)?.length ?? 0;
    const kind = output.match(/data-contact-kind="([^"]+)"/)?.[1] ?? null;
    if (entries !== specimen.expected || passes !== specimen.expected || failures || kind !== specimen.kind) {
      const runtimeError = output.match(
        /<pre id="lab-runtime-error"[^>]*>([\s\S]*?)<\/pre>/
      )?.[1]?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
      throw new Error(`${specimen.kind} contract failed: ` +
        JSON.stringify({
          entries, passes, failures, kind, expected: specimen.expected,
          runtimeError: runtimeError || null
        }));
    }
    results.push(`${specimen.kind}=${passes}/${entries}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

console.log(`PASS: Scheme Lab real Chrome ${results.join(", ")}`);
