#!/usr/bin/env node
/** Generate the user-approved pointed teal logo as the active EveryTab icon family.
 *
 * Geometry, colors, and the supplied 1024 square canvas are untouched so the
 * production assets match the final decision mocks exactly. Requires `sharp`
 * (available in the bundled Codex runtime).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const extension = path.join(root, "extension");
const sourcePath = path.join(here, "everytab-final-source-teal.svg");
const masterPath = path.join(here, "everytab-final-master.svg");

const outputNames = new Map([
  [16, "icon16.png"],
  [24, "icon24.png"],
  [32, "icon32.png"],
  [48, "icon48.png"],
  [128, "icon.png"],
]);

const source = await fs.readFile(sourcePath, "utf8");
const inner = source
  .replace(/^<\?xml[^>]*>\s*/i, "")
  .replace(/^<svg[^>]*>/i, "")
  .replace(/<\/svg>\s*$/i, "")
  .trim();

const master = `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n${inner}\n</svg>\n`;
await fs.writeFile(masterPath, master);

for (const [size, name] of outputNames) {
  await sharp(Buffer.from(master))
    .resize(size, size, { fit: "fill" })
    .png()
    .toFile(path.join(extension, name));
}

const encoded = Buffer.from(master).toString("base64");
const icon = (x, y, size) => `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${encoded}"/>`;
const badge = (x, y) => `<rect x="${x+9}" y="${y+9}" width="9" height="8" rx="3" fill="#B06000"/><text x="${x+13.5}" y="${y+16}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="white">2</text>`;
const qa = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620" viewBox="0 0 1100 620">
<rect width="1100" height="620" fill="#F4F2ED"/>
<style>.t{font:700 30px system-ui,sans-serif;fill:#26221C}.h{font:700 18px system-ui,sans-serif;fill:#26221C}.s{font:14px system-ui,sans-serif;fill:#6F6A62}</style>
<text x="55" y="55" class="t">EveryTab final pointed teal mark · production QA</text>
<text x="55" y="86" class="s">Exact approved source · supplied square canvas · transparent PNG outputs</text>
<text x="55" y="140" class="h">Responsive family</text>
${icon(55,170,128)}${icon(225,218,48)}${icon(315,226,32)}${icon(380,230,24)}${icon(435,234,16)}
<text x="55" y="330" class="s">128 px</text><text x="225" y="330" class="s">48</text><text x="315" y="330" class="s">32</text><text x="380" y="330" class="s">24</text><text x="435" y="330" class="s">16</text>
<rect x="55" y="380" width="460" height="90" rx="12" fill="#FFFFFF" stroke="#D8D4CC"/>
<rect x="555" y="380" width="460" height="90" rx="12" fill="#303134"/>
<text x="75" y="410" class="s">Light Chrome context</text><text x="575" y="410" font-family="system-ui,sans-serif" font-size="14" fill="#DADCE0">Dark Chrome context</text>
${icon(280,430,16)}${badge(280,430)}${icon(780,430,16)}${badge(780,430)}
<text x="55" y="535" class="h">Final call: pointed keeper</text>
<text x="55" y="570" class="s">The pointed silhouette stays identifiable at 16 px and under the orange badge; the teal ramp remains fixed across schemes.</text>
</svg>`;
await fs.writeFile(path.join(here, "everytab-final-icon-qa.svg"), qa + "\n");
await sharp(Buffer.from(qa)).png().toFile(path.join(here, "everytab-final-icon-qa.png"));

console.log("wrote final pointed teal master, active 16/24/32/48/128 icons, and QA board");
