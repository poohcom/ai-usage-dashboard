'use strict';
// 외부 이미지 파일 없이 런타임에 작은 PNG 아이콘을 생성 (트레이/창 아이콘용)
const zlib = require('zlib');
const { nativeImage } = require('electron');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** pixel(x, y) -> [r, g, b, a] */
function encodePng(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 둥근 사각형 배경 + 3개의 막대. fill(0~1)은 가장 높은 사용률로 마지막 막대 색을 바꾼다. */
function makeIcon(size = 64, fill = 0) {
  const r = size * 0.22;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars = [0.35, 0.65, Math.max(0.15, Math.min(1, fill || 0.9))];
  const hot = fill > 0.85 ? [239, 68, 68] : fill > 0.6 ? [245, 158, 11] : [34, 197, 94];
  const pad = size * 0.18, gap = size * 0.08;
  const barH = (size - pad * 2 - gap * 2) / 3;
  const png = encodePng(size, (x, y) => {
    if (!inRound(x, y)) return [0, 0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const y0 = pad + i * (barH + gap), y1 = y0 + barH;
      if (y >= y0 && y < y1) {
        const w = (size - pad * 2) * bars[i];
        if (x >= pad && x < pad + w) return i === 2 ? [...hot, 255] : [129, 140, 248, 255];
        if (x >= pad && x < size - pad) return [55, 65, 81, 255];
      }
    }
    return [17, 24, 39, 255];
  });
  return nativeImage.createFromBuffer(png);
}

module.exports = { makeIcon };
