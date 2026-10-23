import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const W = 1200, H = 600;
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const stride = 1 + W * 3;
const raw = Buffer.alloc(H * stride);
const horizon = 300;
for (let y = 0; y < H; y++) {
  raw[y * stride] = 0;
  for (let x = 0; x < W; x++) {
    let r, g, b;
    if (y < horizon) {
      const t = y / horizon;
      r = 126 + t * 120; g = 200 + t * 15; b = 227 - t * 59;
      const dx = x - 900, dy = y - 120;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 55) { r = 255; g = 246; b = 210; }
      else if (d < 150) { const f = 1 - (d - 55) / 95; r += f * 55; g += f * 35; b -= f * 18; }
    } else {
      const t = (y - horizon) / (H - horizon);
      const m1 = horizon - 95 - 40 * Math.sin(x / 90) - 25 * Math.sin(x / 33 + 2);
      if (y > m1 && y < m1 + 5 + (1 - t) * 70) { r = 92; g = 102; b = 122; }
      else { r = 74 + t * 42; g = 96 + t * 12; b = 48 - t * 10; }
    }
    const n = (rnd() - 0.5) * 14;
    const i = y * stride + 1 + x * 3;
    raw[i] = Math.max(0, Math.min(255, r + n));
    raw[i + 1] = Math.max(0, Math.min(255, g + n));
    raw[i + 2] = Math.max(0, Math.min(255, b + n));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("demo-site/assets", { recursive: true });
writeFileSync("demo-site/assets/scenery.png", png);
console.log("wrote demo-site/assets/scenery.png (" + png.length + " bytes)");
