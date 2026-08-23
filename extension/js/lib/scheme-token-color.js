/** Pure sRGB and bounded gradient helpers for the Scheme Contract. */

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value);
}

export function normalizeHex(value) {
  return isHexColor(value) ? value.toLowerCase() : null;
}

/** @returns {[number, number, number] | null} encoded sRGB channels in 0..255 */
export function hexToRgb(value) {
  const hex = normalizeHex(value);
  if (!hex) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb) {
  if (!isRgb(rgb)) return null;
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16).padStart(2, "0")).join("")}`;
}

function isRgb(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function toRgb(value) {
  if (isRgb(value)) return value;
  return hexToRgb(value);
}

/** Mix opaque encoded-sRGB channels without quantizing the result. */
export function mixSrgb(background, foreground, amount) {
  const bg = toRgb(background);
  const fg = toRgb(foreground);
  if (!bg || !fg || !Number.isFinite(amount)) return null;
  const t = Math.max(0, Math.min(1, amount));
  return bg.map((value, index) => value + (fg[index] - value) * t);
}

/** Compiler-facing convenience. Validation uses mixSrgb directly. */
export function mixHex(background, foreground, amount) {
  const mixed = mixSrgb(background, foreground, amount);
  return mixed ? rgbToHex(mixed) : null;
}

export function colorToCss(value) {
  if (typeof value === "string") return value;
  const rgb = toRgb(value);
  if (!rgb) return "rgb(0 0 0)";
  return `rgb(${rgb.map((channel) => Number(channel.toFixed(8))).join(" ")})`;
}

export function relativeLuminance(value) {
  const rgb = toRgb(value);
  if (!rgb) return null;
  return rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) =>
    sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

export function contrastRatio(a, b) {
  const al = relativeLuminance(a);
  const bl = relativeLuminance(b);
  if (al == null || bl == null) return null;
  const hi = Math.max(al, bl);
  const lo = Math.min(al, bl);
  return (hi + 0.05) / (lo + 0.05);
}

export function averageSrgb(values) {
  const colors = values.map(toRgb);
  if (colors.some((value) => !value)) return null;
  return [0, 1, 2].map((index) =>
    colors.reduce((sum, color) => sum + color[index], 0) / colors.length);
}

/** Convert bounded gradient data into the only CSS gradient the Lab emits. */
export function gradientCss(stops, angle = 135, positions = null) {
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 3 ||
      stops.some((stop) => !isHexColor(stop))) return null;
  if (!Number.isFinite(angle) || angle < -360 || angle > 360) return null;
  const safePositions = positions ?? (stops.length === 2 ? [0, 100] : [0, 55, 100]);
  if (!Array.isArray(safePositions) || safePositions.length !== stops.length ||
      safePositions.some((position) => position != null &&
        (!Number.isFinite(position) || position < 0 || position > 100))) return null;
  const serialized = stops.map((color, index) => {
    const position = safePositions[index];
    return `${normalizeHex(color)}${position == null ? "" : ` ${position}%`}`;
  });
  return `linear-gradient(${angle}deg, ${serialized.join(", ")})`;
}

/** Parse a literal, data-only linear gradient and retain its authored geometry. */
export function parseGradientCss(value) {
  const failure = (code, message) => ({ ok: false, value: [], angle: null,
    positions: [], errors: [{ code, message }] });
  if (typeof value !== "string") {
    return failure("value.gradient", "Gradient must be literal data.");
  }
  const match = value.trim().match(
    /^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg\s*,([\s\S]+)\)$/i
  );
  if (!match) {
    return failure(
      "value.gradient",
      "Gradient must be a linear gradient made from two or three hex colours."
    );
  }
  const angle = Number(match[1]);
  if (!Number.isFinite(angle) || angle < -360 || angle > 360) {
    return failure("value.gradient-angle", "Gradient angle is out of range.");
  }
  const parts = match[2].split(",").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) {
    return failure("value.gradient-count", "Gradient must contain two or three colour stops.");
  }
  const stops = [];
  const positions = [];
  const errors = [];
  for (const [index, part] of parts.entries()) {
    const stop = part.match(/^(#[0-9a-f]{6})(?:\s+(\d+(?:\.\d+)?)%)?$/i);
    if (!stop || (stop[2] != null && Number(stop[2]) > 100)) {
      errors.push({
        code: "value.gradient-stop",
        message: `Gradient stop ${index + 1} must be a hex colour with an optional 0–100% position.`
      });
      continue;
    }
    stops.push(stop[1].toLowerCase());
    positions.push(stop[2] == null ? null : Number(stop[2]));
  }
  return { ok: errors.length === 0, value: stops, angle, positions, errors };
}
