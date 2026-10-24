/**
 * Bitmap font descriptors (font.txt, hudfont.txt, tinyfont.txt, menyfont.txt), loaded like
 * Font_Load 0x4090c0:
 *   width / heigth      cell size in texels; every character defaults to `width` wide
 *   posa / posA / pos0  cell index of 'a', 'A' and '0' (letters and digits run consecutively)
 *   positions{ c n }    cell index overrides (å ä ö, punctuation)
 *   widths{ c n }       advance width per character
 *   squeeze             cells per row = 256 / width + squeeze
 *   globalspace         extra advance after every character
 *   spacewidth          advance of ' ' (plus globalspace)
 * Cell n sits at u = (n*width) mod rowStride, v = floor(n*width / rowStride) * heigth.
 * Text_Draw 0x409420 draws glyph quads of (charWidth x heigth) from (u, v).
 */
export interface BitmapFont {
  cellW: number;
  cellH: number;
  /** advance width per byte value (Windows-1252) */
  widths: Uint8Array;
  u: Uint16Array;
  v: Uint16Array;
  globalSpace: number;
  spaceWidth: number;
}

const cp1252 = new TextDecoder('windows-1252');
const CP1252_TABLE = (() => {
  const map = new Map<string, number>();
  const bytes = new Uint8Array(256).map((_, i) => i);
  const chars = cp1252.decode(bytes);
  for (let i = 0; i < 256; i++) map.set(chars[i], i);
  return map;
})();

/** Byte value of a character in the game's Windows-1252 text. */
export function charCode(ch: string): number {
  return CP1252_TABLE.get(ch) ?? 63; // '?'
}

export function parseFont(bytes: Uint8Array): BitmapFont {
  const text = cp1252.decode(bytes);
  const num = (key: string, def = 0) => {
    const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(-?\\d+)`).exec(text);
    return m ? Number(m[1]) : def;
  };
  const table = (key: string): Array<[number, number]> => {
    const start = text.indexOf(key + '{');
    if (start < 0) return [];
    const end = text.indexOf('}', start);
    const out: Array<[number, number]> = [];
    for (const line of text.slice(start + key.length + 1, end).split(/\r?\n/)) {
      if (!line.length) continue;
      const m = /^(.)\s+(-?\d+)/.exec(line);
      if (m) out.push([charCode(m[1]), Number(m[2])]);
    }
    return out;
  };

  const cellW = num('width', 8);
  const cellH = num('heigth', 8);
  const squeeze = num('squeeze');
  const index = new Uint8Array(256);
  const posa = num('posa'), posA = num('posA'), pos0 = num('pos0');
  for (let c = 97; c <= 122; c++) index[c] = posa + c - 97;
  for (let c = 65; c <= 90; c++) index[c] = posA + c - 65;
  for (let c = 48; c <= 57; c++) index[c] = pos0 + c - 48;
  for (const [c, n] of table('positions')) index[c] = n;

  const widths = new Uint8Array(256).fill(cellW);
  let lower = false, upper = false;
  for (const [c, w] of table('widths')) {
    widths[c] = w;
    if (c === 97) lower = true;
    if (c === 65) upper = true;
  }
  // When the letters share cells, copy widths between cases (Font_Load does the same).
  if (posa === posA) {
    if (lower && !upper) for (let c = 65; c <= 90; c++) widths[c] = widths[c + 32];
    else if (upper && !lower) for (let c = 97; c <= 122; c++) widths[c] = widths[c - 32];
  }
  const spaceWidth = num('spacewidth', cellW);
  widths[32] = spaceWidth;

  const rowStride = (Math.floor(256 / cellW) + squeeze) * cellW;
  const u = new Uint16Array(256), v = new Uint16Array(256);
  for (let c = 0; c < 256; c++) {
    const p = index[c] * cellW;
    u[c] = p % rowStride;
    v[c] = Math.floor(p / rowStride) * cellH;
  }
  return { cellW, cellH, widths, u, v, globalSpace: num('globalspace'), spaceWidth };
}

/** Advance width of a string (Text_Width 0x409810). */
export function textWidth(font: BitmapFont, s: string): number {
  let w = 0;
  for (const ch of s.replace(/[´’‘`]/g, "'")) w += font.widths[charCode(ch)] + font.globalSpace;
  return w;
}
