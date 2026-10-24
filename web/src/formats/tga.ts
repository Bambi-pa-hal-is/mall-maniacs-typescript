/**
 * Truevision TGA decoder for the game's HUD/menu pictures (allahN.tga, load.tga, intro_*.tga ...):
 * colour-mapped, true-colour and greyscale images, uncompressed or RLE. Returns top-down RGBA.
 */
export interface Image {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export function parseTga(buf: ArrayBuffer): Image {
  const d = new Uint8Array(buf);
  const dv = new DataView(buf);
  const idLen = d[0], cmType = d[1], type = d[2];
  const cmLen = dv.getUint16(5, true), cmBits = d[7];
  const width = dv.getUint16(12, true), height = dv.getUint16(14, true);
  const bpp = d[16], desc = d[17];
  let o = 18 + idLen;
  const cmBytes = cmBits >> 3;
  const palette = cmType ? d.subarray(o, o + cmLen * cmBytes) : null;
  if (cmType) o += cmLen * cmBytes;
  const bypp = bpp >> 3;
  const count = width * height;
  let raw: Uint8Array;
  if (type === 1 || type === 2 || type === 3) {
    raw = d.subarray(o, o + count * bypp);
  } else if (type === 9 || type === 10 || type === 11) {
    raw = new Uint8Array(count * bypp);
    let w = 0;
    while (w < raw.length && o < d.length) {
      const hdr = d[o++];
      const n = (hdr & 0x7f) + 1;
      if (hdr & 0x80) {
        for (let k = 0; k < n; k++) raw.set(d.subarray(o, o + bypp), w + k * bypp);
        o += bypp;
      } else {
        raw.set(d.subarray(o, o + n * bypp), w);
        o += n * bypp;
      }
      w += n * bypp;
    }
  } else {
    throw new Error(`TGA: unsupported image type ${type}`);
  }

  const rgba = new Uint8ClampedArray(count * 4);
  const bottomUp = (desc & 0x20) === 0;
  for (let i = 0; i < count; i++) {
    let r: number, g: number, b: number, a = 255;
    if (palette && bypp === 1) {
      const e = raw[i] * cmBytes;
      b = palette[e];
      g = palette[e + 1];
      r = palette[e + 2];
      if (cmBytes === 4) a = palette[e + 3];
    } else if (bypp === 1) {
      r = g = b = raw[i];
    } else if (bypp === 2) {
      const v = raw[i * 2] | (raw[i * 2 + 1] << 8);
      r = (((v >> 10) & 31) * 255) / 31;
      g = (((v >> 5) & 31) * 255) / 31;
      b = ((v & 31) * 255) / 31;
    } else {
      b = raw[i * bypp];
      g = raw[i * bypp + 1];
      r = raw[i * bypp + 2];
      if (bypp === 4) a = raw[i * bypp + 3];
    }
    const x = i % width, y = Math.floor(i / width);
    const o2 = ((bottomUp ? height - 1 - y : y) * width + x) * 4;
    rgba[o2] = r;
    rgba[o2 + 1] = g;
    rgba[o2 + 2] = b;
    rgba[o2 + 3] = a;
  }
  return { width, height, rgba };
}
