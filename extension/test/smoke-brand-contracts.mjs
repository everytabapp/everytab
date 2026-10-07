import fs from "node:fs";
import { createHash } from "node:crypto";

function projectEvidence(primary, ciFixture) {
  const primaryUrl = new URL(primary, import.meta.url);
  return fs.existsSync(primaryUrl) ? primaryUrl : new URL(ciFixture, import.meta.url);
}

/** Static brand assets and Chrome identity contracts. */
export function runSmokeBrandContracts(check) {
  const source = fs.readFileSync(
    projectEvidence(
      "../../campaign-assets/everytab-final-source-teal.svg",
      "./ci-evidence/everytab-final-source-teal.svg"
    ),
    "utf8"
  );
  const generator = fs.readFileSync(
    projectEvidence(
      "../../campaign-assets/make-final-source-icons.mjs",
      "./ci-evidence/make-final-source-icons.mjs"
    ),
    "utf8"
  );
  const icons = fs.readFileSync(new URL("../js/ui/icons.js", import.meta.url), "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  check(
    sourceHash === "868ff50ab4335089d706adceca0c4328fe8a0dfbe25b9992ee5922962e96355c",
    "D2d: canonical SVG remains the exact approved pointed source"
  );
  check(
    generator.includes('viewBox="0 0 1024 1024"') &&
      !generator.includes('viewBox="334 329 352 352"'),
    "D2d: icon generation preserves the supplied square canvas"
  );
  check(
    icons.includes('transform="scale(.0234375)"') &&
      ["#1E4A49", "#286766", "#378A89", "#47ADAA", "#FEFEFE"]
        .every((fill) => icons.includes(`fill="${fill}"`)),
    "D2d: inline product mark uses the approved geometry scale and full palette"
  );

  const manifest = JSON.parse(
    fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8")
  );
  check(
    manifest.icons?.["16"] === "icon16.png" &&
      manifest.icons?.["32"] === "icon32.png" &&
      manifest.icons?.["48"] === "icon48.png" &&
      manifest.icons?.["128"] === "icon.png" &&
      manifest.action?.default_icon?.["24"] === "icon24.png",
    "D2d: manifest keeps the full generated icon family wired to Chrome surfaces"
  );

  const english = JSON.parse(
    fs.readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8")
  );
  const name = english.manifest_name?.message;
  const shortName = english.manifest_short_name?.message;
  check(
    manifest.default_locale === "en" && manifest.name === "__MSG_manifest_name__" &&
      manifest.short_name === "__MSG_manifest_short_name__" &&
      name === "EveryTab" && shortName === "EveryTab",
    "L6: manifest carries the bare EveryTab identity in primary and compact Chrome surfaces"
  );
  check(
    name.length <= 75 && shortName.length <= 12,
    "L6: primary and compact EveryTab names respect Chrome's length limits"
  );
  const description = english.manifest_description?.message ?? "";
  check(
    description.length <= 132 &&
      description.includes("no account required") &&
      !description.includes("Plain JSON files you own"),
    "L5: manifest description fits Chrome and states the account-free product boundary"
  );
}
