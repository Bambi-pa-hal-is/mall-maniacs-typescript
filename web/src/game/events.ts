import type { DffBlock } from '../formats/dff';

/**
 * Event objects from a mall's *.eo file (EventObjects_Load 0x406cb0). The file is 2D:
 * `x` is engine Z, `y` is engine X and `h` the floor height (engine Y). Names encode the type:
 * "_001".."_025","_031" item spots (type = number), "_2xx" food-fight spots, "goal" the checkout
 * area (with relative boundary lines), AR/IN visibility areas, c_ac fixed cameras and mvnc water
 * currents (Aqua's slide).
 */
export interface EventObject {
  name: string;
  /** numeric type for "_NNN" names, otherwise -1 */
  type: number;
  x: number;
  y: number;
  z: number;
  /** Second height (+0x44); with `y` it gives a height range for mvnc. */
  h2: number;
  /** The five `values { v … }` (+0x10..+0x20). */
  values: number[];
  /** Boundary lines in engine X/Z: [x1, z1, x2, z2]. */
  edges: Array<[number, number, number, number]>;
  /** Axis-aligned bounds of the boundary lines in engine X/Z, when present. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

export function parseEventObjects(file: DffBlock): EventObject[] {
  // "name[N]" is followed by N blocks; the parser stores the extra ones as unnamed children.
  let last = '';
  const named = file.children.map(([n, b]): [string, DffBlock] => {
    if (n) last = n.replace(/\[\d+\]$/, '');
    return [last, b];
  });
  return named
    .filter(([, b]) => b.has('x'))
    .map(([name, b]) => {
      const m = /^_(\d+)$/.exec(name);
      const X = b.num('y'), Z = b.num('x');
      // Line endpoints are relative to the object, in the file's (x = Z, y = X) axes.
      const edges = b
        .array('line')
        .map((l): [number, number, number, number] => [l.num('y1') + X, l.num('x1') + Z, l.num('y2') + X, l.num('x2') + Z]);
      let bounds: EventObject['bounds'] = null;
      if (edges.length) {
        const xs = edges.flatMap((e) => [e[0], e[2]]);
        const zs = edges.flatMap((e) => [e[1], e[3]]);
        bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
      }
      const values = (b.optBlock('values')?.all('v') ?? []).map(Number);
      return { name, type: m ? Number(m[1]) : -1, x: X, y: b.num('h', 0), z: Z, h2: b.num('h2', 0), values, edges, bounds };
    });
}

export function insideBounds(e: EventObject, x: number, z: number): boolean {
  const b = e.bounds;
  return !!b && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/**
 * Point inside the area enclosed by the boundary lines (EventObject_Contains 0x414bb0; the
 * original takes the nearest crossing edge and checks its side, which equals an even-odd test
 * for the closed outlines in the .eo files). Some areas are L-shaped, so bounds are not enough.
 */
export function insideArea(e: EventObject, x: number, z: number): boolean {
  let inside = false;
  for (const [x1, z1, x2, z2] of e.edges) {
    if (z1 > z !== z2 > z && x < x1 + ((z - z1) / (z2 - z1)) * (x2 - x1)) inside = !inside;
  }
  return inside;
}
