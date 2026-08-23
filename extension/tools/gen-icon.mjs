/**
 * Generate icon.png (128×128) without any image library:
 * hand-built PNG chunks + zlib deflate. Dev placeholder icon —
 * a blue rounded square with a white "stack of tabs" glyph.
 * Run: node tools/gen-icon.mjs (from extension/)
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 128;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// pixel painting
const px = new Uint8Array(SIZE * SIZE * 4);
const inRounded = (x, y, r) => {
  const cx = x < r ? r : x >= SIZE - r ? SIZE - r - 1 : x;
  const cy = y < r ? r : y >= SIZE - r ? SIZE - r - 1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x < SIZE - r) || (y >= r && y < SIZE - r);
};
// three stacked "tab cards" as white rounded rects
const cards = [
  { x: 24, y: 30, w: 80, h: 14 },
  { x: 24, y: 54, w: 80, h: 14 },
  { x: 24, y: 78, w: 56, h: 14 }
];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (inRounded(x, y, 24)) {
      // background #1a73e8
      px[i] = 0x1a;
      px[i + 1] = 0x73;
      px[i + 2] = 0xe8;
      px[i + 3] = 255;
      for (const c of cards) {
        if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
          px[i] = px[i + 1] = px[i + 2] = 255;
        }
      }
    } else {
      px[i + 3] = 0; // transparent corner
    }
  }
}

// scanlines with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0))
]);
writeFileSync("icon.png", png);
console.log(`icon.png written (${png.length} bytes)`);
