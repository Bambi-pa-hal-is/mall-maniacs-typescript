/**
 * TPG texture: 256x256 bytes of 8-bit palette indices followed by 256 RGBX palette entries
 * (Tpg_LoadTexture 0x416060 hands pixels and pixels+0x10000 to the driver).
 */
export const TPG_SIZE = 256;

export interface Tpg {
  indices: Uint8Array;
  palette: Uint8Array;
}

export function parseTpg(buf: ArrayBuffer): Tpg {
  const bytes = new Uint8Array(buf);
  const pixelBytes = TPG_SIZE * TPG_SIZE;
  if (bytes.length < pixelBytes + 1024) throw new Error(`TPG: unexpected size ${bytes.length}`);
  return { indices: bytes.subarray(0, pixelBytes), palette: bytes.subarray(pixelBytes, pixelBytes + 1024) };
}

/**
 * Expand to RGBA. With colorKey, pure black texels become transparent; the Glide driver
 * enables grChromakeyMode, which the 0x4000 primitive flag is inferred to select.
 */
export function tpgToRgba(tpg: Tpg, colorKey: boolean): Uint8Array {
  const out = new Uint8Array(TPG_SIZE * TPG_SIZE * 4);
  const { indices, palette } = tpg;
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i] * 4;
    const r = palette[p], g = palette[p + 1], b = palette[p + 2];
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = colorKey && r === 0 && g === 0 && b === 0 ? 0 : 255;
  }
  return out;
}
