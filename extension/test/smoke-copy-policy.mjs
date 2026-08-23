import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function stringEmDashLines(source) {
  const hits = [];
  let index = 0;
  let lineNumber = 1;
  let state = "code";
  let buffer = "";
  let bufferLine = 0;
  const flush = () => {
    if (buffer.includes("—")) hits.push(bufferLine);
    buffer = "";
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "\n") lineNumber++;
    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        state = character;
        buffer = "";
        bufferLine = lineNumber;
        index++;
        continue;
      }
      index++;
      continue;
    }
    if (state === "line") {
      if (character === "\n") state = "code";
      index++;
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 2;
      } else index++;
      continue;
    }
    if (character === "\\") {
      buffer += (source[index] ?? "") + (source[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (character === state) {
      flush();
      state = "code";
      index++;
      continue;
    }
    buffer += character;
    index++;
  }
  return hits;
}

function walkJavaScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScript(file);
    return entry.name.endsWith(".js") ? [file] : [];
  });
}

/** Enforce the repo-wide user-facing copy rule without coupling it to UI scenarios. */
export function runSmokeCopyPolicy(check) {
  const jsRoot = fileURLToPath(new URL("../js/", import.meta.url));
  const offenders = [];
  for (const file of walkJavaScript(jsRoot)) {
    const lines = stringEmDashLines(fs.readFileSync(file, "utf8"));
    if (lines.length) {
      const relative = path.relative(jsRoot, file).split(path.sep).join("/");
      offenders.push(`js/${relative}:${lines.join(",")}`);
    }
  }
  for (const offender of offenders) {
    console.log(`  UI COPY VIOLATION: em dash in a user-facing string at ${offender}`);
  }
  check(
    offenders.length === 0,
    `UI copy carries no em dashes in string literals (AI tell): ${offenders.length} offending file(s)`
  );
}
