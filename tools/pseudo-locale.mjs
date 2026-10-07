// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const ACCENTS = Object.freeze({
  a: "á", b: "ƀ", c: "ç", d: "ď", e: "ë", f: "ƒ", g: "ğ", h: "ħ", i: "ï",
  j: "ĵ", k: "ķ", l: "ľ", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ʠ", r: "ř",
  s: "š", t: "ŧ", u: "ü", v: "ṽ", w: "ŵ", x: "ẋ", y: "ÿ", z: "ž"
});

const PROTECTED = /\$[A-Z][A-Z0-9_]*\$|\b(?:in|label|session|view|domain):/g;

function accent(text) {
  return [...text].map((character) => {
    const replacement = ACCENTS[character.toLowerCase()];
    if (!replacement) return character;
    return character === character.toUpperCase() ? replacement.toUpperCase() : replacement;
  }).join("");
}

/** Development-only copy expansion. It is imported by tests/tools, never by product runtime. */
export function pseudoExpand(message, { expansion = 0.35 } = {}) {
  const protectedValues = [];
  const masked = message.replace(PROTECTED, (value) => {
    protectedValues.push(value);
    return `\u0000${protectedValues.length - 1}\u0000`;
  });
  let expanded = accent(masked);
  const targetLength = Math.ceil(message.length * (1 + Math.max(0, expansion))) - 2;
  const filler = " ·ëxŧrá";
  while (expanded.length < targetLength) expanded += filler;
  expanded = expanded.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedValues[Number(index)]);
  return `［${expanded}］`;
}
