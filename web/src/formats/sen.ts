/**
 * Spitfire scene (.SEN, "REV2") parser. Layout recovered from maniac.exe:
 * Sen_Load 0x432320, Sen_FixupMesh 0x4320f0, Spitfire_DrawObject 0x42f8c0,
 * Spitfire_DrawPrimGroup 0x42e940. See re/ANALYSIS.md section 4.1.
 * Coordinates are engine units (mm), Y-down.
 */

export const PRIM_TEXTURED = 0x04;
export const PRIM_COLORED = 0x08;
export const PRIM_GOURAUD = 0x10;
export const PRIM_TRANSLUCENT = 0x20;
export const PRIM_COLORKEY = 0x4000; // [I] selects Glide chroma key
export const PRIM_DOUBLE_SIDED = 0x8000; // driver disables GL_CULL_FACE

export interface SenPrim {
  indices: number[];
  color: number | null;
  mapi: number | null;
}

export interface SenPrimGroup {
  flags: number;
  vertsPerPrim: number;
  prims: SenPrim[];
}

export interface SenLod {
  distance: number;
  vertexCount: number;
  /** x, y, z per vertex (frame 0). */
  positions: Int16Array;
  /** Two bytes per vertex copied into the projected vertex; [I] pre-lit shade. */
  shade: Uint8Array;
  /** Vertices are assigned to nodes sequentially by these groups. */
  vertexGroups: Array<{ count: number; node: number }>;
  primGroups: SenPrimGroup[];
}

export interface SenNode {
  offset: [number, number, number];
  parent: number;
}

export interface SenMesh {
  name: string;
  lods: SenLod[];
  /** Entry i describes node i+1; node 0 is the object root. */
  nodes: SenNode[];
}

export interface SenObject {
  name: string;
  type: number;
  parent: number;
  position: [number, number, number];
  rotation: [number, number, number];
  mesh: number;
}

export interface SenMapi {
  texture: number;
  u: [number, number, number, number];
  v: [number, number, number, number];
}

/**
 * TANI texture animation record (TexAnim_Register 0x434a90, TexAnim_Tick 0x434b00, once per game
 * tick). Every `period` ticks the UV bytes of all listed MAPI records move by (du, dv); every
 * `cycles` steps the extra (du2, dv2) is added as well, which lets a scroll jump back. UV bytes
 * wrap at 256. Aqua's water: dv = 8 per tick, dv2 = -128 every 16 steps.
 */
export interface SenTextureAnim {
  du2: number;
  dv2: number;
  du: number;
  dv: number;
  period: number;
  cycles: number;
  /** Scene-wide MAPI indices. */
  mapi: number[];
}

export interface SenScene {
  meshes: SenMesh[];
  objects: SenObject[];
  textureNames: string[];
  mapi: SenMapi[];
  /** RGBA quadruplets (A is the COLS flag byte). */
  colors: Uint8Array;
  textureAnims: SenTextureAnim[];
}

export function parseTextureAnims(b: Uint8Array): SenTextureAnim[] {
  const out: SenTextureAnim[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const s8 = (o: number) => (b[o] << 24) >> 24;
  for (let o = 0; o + 10 <= b.length; ) {
    const count = dv.getUint16(o + 8, true);
    if (o + 10 + count * 2 > b.length) break;
    const mapi: number[] = [];
    for (let i = 0; i < count; i++) mapi.push(dv.getUint16(o + 10 + i * 2, true));
    out.push({ du2: s8(o), dv2: s8(o + 1), du: s8(o + 2), dv: s8(o + 3), period: b[o + 4] || 1, cycles: b[o + 5], mapi });
    o += 10 + count * 2;
  }
  return out;
}

const tag = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

function cString(bytes: Uint8Array, start: number): string {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('windows-1252').decode(bytes.subarray(start, end));
}

function cStrings(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(new TextDecoder('windows-1252').decode(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  return out;
}

export function parseSen(buf: ArrayBuffer): SenScene {
  const all = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (tag(dv, 0) !== 'REV2') throw new Error('SEN: missing REV2 header');

  const chunks = new Map<string, Uint8Array[]>();
  for (let off = 8; off + 8 <= all.length; ) {
    const t = tag(dv, off);
    const size = dv.getUint32(off + 4, true);
    const list = chunks.get(t) ?? [];
    list.push(all.subarray(off + 8, off + 8 + size));
    chunks.set(t, list);
    off += 8 + size;
  }
  const one = (t: string) => chunks.get(t)?.[0] ?? new Uint8Array(0);
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  const subo = one('SUBO');
  const suboView = view(subo);
  const mapiBytes = one('MAPI');
  const mapiView = view(mapiBytes);
  const mapi: SenMapi[] = [];
  for (let o = 0; o + 16 <= mapiBytes.length; o += 16) {
    mapi.push({
      texture: mapiView.getInt32(o, true),
      u: [mapiBytes[o + 8], mapiBytes[o + 10], mapiBytes[o + 12], mapiBytes[o + 14]],
      v: [mapiBytes[o + 9], mapiBytes[o + 11], mapiBytes[o + 13], mapiBytes[o + 15]],
    });
  }

  const names = chunks.get('NAME') ?? [];
  const meshes: SenMesh[] = (chunks.get('MESH') ?? []).map((m, mi) => {
    const mv = view(m);
    const h = (i: number) => mv.getInt32(i * 4, true);
    const lodCount = h(1);
    const nodeCount = h(2);
    // Mesh-level MAPI/COLS pointers are offsets into the shared scene chunks (Sen_FixupMesh).
    const mapiBase = h(8) / 16;
    const colsBase = h(10) / 4;

    const lods: SenLod[] = [];
    for (let li = 0; li < lodCount; li++) {
      const base = h(5) + li * 48;
      const f = (o: number) => mv.getInt32(base + o, true);
      const vertexCount = f(0x04);
      const vptr = f(0x08);
      const positions = new Int16Array(vertexCount * 3);
      const shade = new Uint8Array(vertexCount * 2);
      for (let v = 0; v < vertexCount; v++) {
        const o = vptr + v * 8;
        positions[v * 3] = mv.getInt16(o, true);
        positions[v * 3 + 1] = mv.getInt16(o + 2, true);
        positions[v * 3 + 2] = mv.getInt16(o + 4, true);
        shade[v * 2] = m[o + 6];
        shade[v * 2 + 1] = m[o + 7];
      }
      const vertexGroups: SenLod['vertexGroups'] = [];
      for (let g = 0; g < f(0x1c); g++) {
        const o = f(0x20) + g * 12;
        vertexGroups.push({ count: mv.getInt32(o, true), node: mv.getInt32(o + 8, true) });
      }
      const primGroups: SenPrimGroup[] = [];
      for (let pi = 0; pi < f(0x14); pi++) {
        const p = mv.getInt32(f(0x18) + pi * 4, true);
        const count = subo[p];
        const vertsPerPrim = subo[p + 1];
        const flags = suboView.getUint16(p + 2, true);
        const stride = suboView.getUint16(p + 6, true) & 0xff;
        const hasColor = (flags & PRIM_COLORED) !== 0;
        const hasUv = (flags & PRIM_TEXTURED) !== 0;
        // Points/lines keep their colour index in the second u16, triangles/quads in the third.
        const colorOffset = vertsPerPrim <= 2 ? 2 : 4;
        const prims: SenPrim[] = [];
        let q = p + 8;
        for (let k = 0; k < count; k++) {
          const indices = Array.from(subo.subarray(q, q + vertsPerPrim));
          const color = hasColor ? suboView.getUint16(q + colorOffset, true) + colsBase : null;
          const uv = hasUv ? suboView.getUint16(q + colorOffset + (hasColor ? 2 : 0), true) + mapiBase : null;
          prims.push({ indices, color, mapi: uv });
          q += stride * 2;
        }
        primGroups.push({ flags, vertsPerPrim, prims });
      }
      lods.push({ distance: f(0), vertexCount, positions, shade, vertexGroups, primGroups });
    }

    const nodes: SenNode[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const o = h(3) + i * 8;
      nodes.push({
        offset: [mv.getInt16(o, true), mv.getInt16(o + 2, true), mv.getInt16(o + 4, true)],
        parent: m[h(4) + i * 4],
      });
    }
    return { name: names[mi] ? cString(names[mi], 0) : `mesh${mi}`, lods, nodes };
  });

  const onam = one('ONAM');
  const obji = one('OBJI');
  const ov = view(obji);
  const objects: SenObject[] = [];
  for (let o = 0; o + 32 <= obji.length; o += 32) {
    const nameOffset = ov.getInt32(o, true); // byte offset into ONAM
    objects.push({
      name: nameOffset >= 0 && nameOffset < onam.length ? cString(onam, nameOffset) : '?',
      type: ov.getInt32(o + 4, true),
      parent: ov.getInt32(o + 8, true),
      position: [ov.getFloat32(o + 12, true), ov.getFloat32(o + 16, true), ov.getFloat32(o + 20, true)],
      rotation: [ov.getInt16(o + 24, true), ov.getInt16(o + 26, true), ov.getInt16(o + 28, true)],
      mesh: ov.getInt16(o + 30, true),
    });
  }

  return { meshes, objects, textureNames: cStrings(one('TNAM')), mapi, colors: one('COLS'), textureAnims: parseTextureAnims(one('TANI')) };
}

/** Detail-level naming (DetailLevels_Setup 0x42ad00): "_N<name>" is level N of <name>. */
export function detailLevel(name: string): { base: string; level: number } {
  const m = /^_(\d)(.*)$/.exec(name);
  return m ? { base: m[2], level: Number(m[1]) } : { base: name, level: 0 };
}
