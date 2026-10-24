import { charCode, textWidth, type BitmapFont } from '../formats/font';

/**
 * [I] Characters without a glyph fall back to cell 0 ('A') in the original (e.g. "Let´s" shows as
 * "LetAs"); typographic apostrophes are mapped to "'" instead.
 */
function displayText(s: string): string {
  return s.replace(/[´’‘`]/g, "'");
}
import { parseTpg, tpgToRgba, TPG_SIZE } from '../formats/tpg';

/**
 * 2D HUD layer drawing the original 640x480 HUD (Hud_Draw 0x412810) on a canvas over the 3D view.
 * Sprites and glyphs come from 256x256 TPG atlases; black texels are transparent (the Glide driver
 * uses chroma keying for these 0x2004-flagged draws [I]).
 * Coordinates are the original 640x480 ones. The height is scaled to the window (or the width,
 * centred vertically, when the window is narrower than 4:3); elements are
 * anchored left, centre or right so the layout keeps working on wide screens.
 */
export type Anchor = 'left' | 'center' | 'right';

export interface Atlas {
  canvas: HTMLCanvasElement;
}

export function atlasFromTpg(buf: ArrayBuffer): Atlas {
  const rgba = tpgToRgba(parseTpg(buf), true);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TPG_SIZE;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), TPG_SIZE, TPG_SIZE), 0, 0);
  return { canvas };
}

/**
 * Atlas regions cut into their own canvases. Drawing a sub-rectangle of a shared atlas with
 * smoothing samples the texels around it (usually colour-keyed black), which shows as dark seams
 * along glyph, arrow and sign edges. A whole canvas is clamped to its own edge texels instead.
 */
const regions = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

function region(src: HTMLCanvasElement, u: number, v: number, w: number, h: number): HTMLCanvasElement {
  let cache = regions.get(src);
  if (!cache) regions.set(src, (cache = new Map()));
  const key = `${u},${v},${w},${h}`;
  let c = cache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    c.getContext('2d')!.drawImage(src, u, v, w, h, 0, 0, w, h);
    cache.set(key, c);
  }
  return c;
}

export interface HudFont {
  font: BitmapFont;
  atlas: Atlas;
}

export class Hud2D {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private width = 640;
  /** Vertical offset of the 640x480 area when the window is narrower than 4:3. */
  private oy = 0;

  constructor(parent: HTMLElement) {
    this.canvas.className = 'hud2d';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  begin(pixelated: boolean): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = Math.min(h / 480, w / 640);
    this.width = w;
    this.oy = (h - 480 * this.scale) / 2;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.imageSmoothingEnabled = !pixelated;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Screen x for an original x coordinate under an anchor. */
  private sx(x: number, anchor: Anchor): number {
    const s = this.scale;
    if (anchor === 'left') return x * s;
    if (anchor === 'right') return this.width - (640 - x) * s;
    return this.width / 2 + (x - 320) * s;
  }

  /** FUN_00414470: textured rectangle (x0,y0)-(x1,y1) from atlas texels (u0,v0)-(u1,v1). */
  sprite(atlas: Atlas, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, anchor: Anchor = 'center', alpha = 1): void {
    // u1 < u0 mirrors the quad horizontally (the right-hand start light).
    const mirror = u1 < u0;
    if (mirror) [u0, u1] = [u1, u0];
    if (u1 <= u0 || v1 <= v0) return;
    const s = this.scale;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    // The original passes texel edges, so the source size is u1-u0 (not +1).
    // Whole device pixels, so quads that share an edge (the sign parts, frames) leave no seam.
    const dx0 = Math.round(this.sx(x0, anchor)), dx1 = Math.round(this.sx(x1, anchor));
    const dy0 = Math.round(this.oy + y0 * s), dy1 = Math.round(this.oy + y1 * s);
    const src = region(atlas.canvas, u0, v0, u1 - u0, v1 - v0);
    if (mirror) {
      ctx.save();
      ctx.translate(dx1, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, dy0, dx1 - dx0, dy1 - dy0);
      ctx.restore();
    } else ctx.drawImage(src, dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.globalAlpha = 1;
  }

  /** Text_Draw 0x409420: left-aligned bitmap text; returns the end x (original units). */
  text(f: HudFont, x: number, y: number, s: string, anchor: Anchor = 'left'): number {
    const { font, atlas } = f;
    const sc = this.scale;
    let cx = x;
    for (const ch of displayText(s)) {
      const c = charCode(ch);
      const w = font.widths[c];
      if (ch !== ' ' && w > 0) {
        this.ctx.drawImage(region(atlas.canvas, font.u[c], font.v[c], w, font.cellH), this.sx(cx, anchor), this.oy + y * sc, w * sc, font.cellH * sc);
      }
      cx += w + font.globalSpace;
    }
    return cx;
  }

  /** FUN_00409860: text centred on 320 + dx. */
  textCentered(f: HudFont, dx: number, y: number, s: string, anchor: Anchor = 'center'): void {
    this.text(f, 320 + dx - textWidth(f.font, s) / 2, y, s, anchor);
  }

  width_(f: HudFont, s: string): number {
    return textWidth(f.font, s);
  }

  /** Word-wrap text inside a box (Quiz_DrawText 0x4101d0 [I]). */
  wrapped(f: HudFont, x: number, y: number, maxWidth: number, s: string, anchor: Anchor = 'center'): void {
    const words = s.split(/\s+/);
    let line = '';
    let cy = y;
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && textWidth(f.font, next) > maxWidth) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      this.text(f, x + (maxWidth - textWidth(f.font, l)) / 2, cy, l, anchor);
      cy += f.font.cellH + 2;
    }
  }
}
