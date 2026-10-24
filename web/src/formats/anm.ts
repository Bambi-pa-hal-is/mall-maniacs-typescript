/**
 * Animation (.anm) parser, layout from Anm_Parse 0x433a90. Little-endian.
 *   "ANM" + version(1|2)
 *   u16 nObjects, (u8 len, name)*
 *   u16 nNodes,   (u8 len, name, u16 nodeIndex)*
 *   u16 nFrames,  (u16 nCmds, cmd*)*
 * Commands: 5 = node rotation (u16 node, i16 x3), 6 = node position (u16 node, i32 x3),
 * 1/2 = 3x4 bytes, 3 = u16 obj + 3x4 bytes, 4 = u16 obj + i16 x3 (1-4 unused by shipped files).
 */

export interface AnmFrame {
  /** node index -> rotation (i16 angles, 65536 per turn) */
  rotations: Map<number, [number, number, number]>;
  /** node index -> position (engine units) */
  positions: Map<number, [number, number, number]>;
}

export interface Anm {
  version: number;
  objects: string[];
  nodes: Array<{ name: string; index: number }>;
  frames: AnmFrame[];
}

export function parseAnm(buf: ArrayBuffer): Anm {
  const d = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (d[0] !== 0x41 || d[1] !== 0x4e || d[2] !== 0x4d || (d[3] !== 1 && d[3] !== 2)) {
    throw new Error('ANM: bad header');
  }
  let o = 4;
  const u16 = () => {
    const v = dv.getUint16(o, true);
    o += 2;
    return v;
  };
  const pstr = () => {
    const n = d[o];
    const s = new TextDecoder('windows-1252').decode(d.subarray(o + 1, o + 1 + n));
    o += 1 + n;
    return s;
  };

  const objects: string[] = [];
  for (let i = u16(); i > 0; i--) objects.push(pstr());
  const nodes: Anm['nodes'] = [];
  for (let i = u16(); i > 0; i--) {
    const name = pstr();
    nodes.push({ name, index: u16() });
  }

  const frames: AnmFrame[] = [];
  for (let f = u16(); f > 0; f--) {
    const frame: AnmFrame = { rotations: new Map(), positions: new Map() };
    for (let c = u16(); c > 0; c--) {
      const cmd = d[o++];
      switch (cmd) {
        case 1:
        case 2:
          o += 12;
          break;
        case 3:
          o += 14;
          break;
        case 4:
          o += 8;
          break;
        case 5: {
          const node = dv.getUint16(o, true);
          frame.rotations.set(node, [dv.getInt16(o + 2, true), dv.getInt16(o + 4, true), dv.getInt16(o + 6, true)]);
          o += 8;
          break;
        }
        case 6: {
          const node = dv.getUint16(o, true);
          frame.positions.set(node, [dv.getInt32(o + 2, true), dv.getInt32(o + 6, true), dv.getInt32(o + 10, true)]);
          o += 14;
          break;
        }
        default:
          throw new Error(`ANM: unknown command ${cmd} at ${o - 1}`);
      }
    }
    frames.push(frame);
  }
  return { version: d[3], objects, nodes, frames };
}
