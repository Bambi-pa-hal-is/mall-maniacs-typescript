/**
 * The original's walls: the edges of the floor regions (PhysWorld, Level_LoadPhysics 0x4104b0).
 *
 * Region building [O] (0x428d50, 0x429d60, 0x429e90, 0x42a1c0): every walkable polygon of a FLOOR
 * object (normal y >= 0.6) contributes its edges. An edge whose reverse lies on another polygon
 * within 2 units (x, z) is not a wall: first matching heights within 2 (the same floor), then
 * within 2500 (a "link" between floors at different heights, e.g. Aqua's walkway and the canal
 * below it). The edges left over are walls.
 *
 * Collision [O] (0x4035e0, called by 0x405680 for every part of every body): for each edge facing
 * the part's movement, the edge is moved inwards by the part's radius and the movement from the
 * previous to the current position is cut there. The part restarts from the cut with 0.2 of the
 * remaining movement mirrored about the edge normal (0x44b2d4), which also becomes its velocity.
 * A link edge acts the same way from its lower side when the floor beyond is more than the part's
 * step height (300 walker, 240 cart parts) higher. Only edges of the floor the part is on count
 * (within 500 in height, 0x42a750).
 * End points [O] (last pass of 0x4035e0): each edge's start point (every corner of an outline) is
 * also an obstacle. Where the part's circle first touches it along the movement, the part restarts
 * with 0.5 (0x44b274) of the remaining movement mirrored about the direction to the point.
 * [I] The collinear-edge merging (0x42a360) is not ported; the earliest hit along the movement is
 * used where the original keeps the fastest contact.
 */
const CELL = 1000;
const MATCH_XZ = 2;
const SAME_FLOOR_Y = 2;
const LINK_Y = 2500;
const FLOOR_WINDOW = 500;
const WALL_BOUNCE = 0.2;
const CORNER_BOUNCE = 0.5;

export interface FloorEdge {
  /** End points in engine coordinates (x, y, z). */
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  /** Outward unit normal in the x/z plane (away from the floor the edge belongs to). */
  nx: number;
  nz: number;
  /** Wall, or link: how much higher the neighbouring floor is (negative when lower). */
  rise: number | null;
}

export interface WallHit {
  x: number;
  z: number;
  /** Velocity after the bounce, as speed and direction (atan2(dx, dz), the engine heading). */
  speed: number;
  angle: number;
  /** Unit direction along the edge (for the spin kick). */
  ex: number;
  ez: number;
}

interface RawEdge {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  /** Third corner of the polygon (the inside of the floor). */
  ix: number;
  iz: number;
  partner: number;
}

export class FloorEdges {
  readonly edges: FloorEdge[] = [];
  private readonly grid = new Map<number, number[]>();

  /**
   * @param tris 9 floats per triangle (engine coordinates)
   * @param walkable whether triangle t belongs to a FLOOR object and faces up
   */
  constructor(tris: Float32Array, walkable: (t: number) => boolean) {
    const raw: RawEdge[] = [];
    const count = tris.length / 9;
    const r = Math.round;
    for (let t = 0; t < count; t++) {
      if (!walkable(t)) continue;
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const a = o + k * 3, b = o + ((k + 1) % 3) * 3, c = o + ((k + 2) % 3) * 3;
        raw.push({ x1: r(tris[a]), y1: r(tris[a + 1]), z1: r(tris[a + 2]), x2: r(tris[b]), y2: r(tris[b + 1]), z2: r(tris[b + 2]), ix: tris[c], iz: tris[c + 2], partner: -1 });
      }
    }
    // Match reversed edges: index by start point.
    const byStart = new Map<string, number[]>();
    const key = (x: number, z: number) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    raw.forEach((e, i) => {
      const k = key(e.x1, e.z1);
      const list = byStart.get(k);
      if (list) list.push(i);
      else byStart.set(k, [i]);
    });
    const pair = (yTol: number) => {
      raw.forEach((e, i) => {
        if (e.partner >= 0) return;
        const cx = Math.floor(e.x2 / 8), cz = Math.floor(e.z2 / 8);
        for (let dx = -1; dx <= 1 && e.partner < 0; dx++) {
          for (let dz = -1; dz <= 1 && e.partner < 0; dz++) {
            for (const j of byStart.get(`${cx + dx},${cz + dz}`) ?? []) {
              const f = raw[j];
              if (j === i || f.partner >= 0) continue;
              if (Math.abs(f.x1 - e.x2) > MATCH_XZ || Math.abs(f.z1 - e.z2) > MATCH_XZ || Math.abs(f.x2 - e.x1) > MATCH_XZ || Math.abs(f.z2 - e.z1) > MATCH_XZ) continue;
              if (Math.abs(f.y1 - e.y2) > yTol || Math.abs(f.y2 - e.y1) > yTol) continue;
              e.partner = j;
              f.partner = i;
              break;
            }
          }
        }
      });
    };
    pair(SAME_FLOOR_Y);
    const sameFloor = raw.map((e) => e.partner >= 0);
    pair(LINK_Y);
    raw.forEach((e, i) => {
      if (sameFloor[i]) return;
      // Outward normal: perpendicular to the edge, pointing away from the polygon's inside.
      let nx = e.z2 - e.z1, nz = -(e.x2 - e.x1);
      const len = Math.hypot(nx, nz);
      if (len < 1e-6) return;
      nx /= len;
      nz /= len;
      if ((e.ix - e.x1) * nx + (e.iz - e.z1) * nz > 0) {
        nx = -nx;
        nz = -nz;
      }
      let rise: number | null = null;
      if (e.partner >= 0) {
        const f = raw[e.partner];
        // Engine Y is down: the neighbour is higher when its y is smaller.
        rise = (e.y1 + e.y2) / 2 - (f.y1 + f.y2) / 2;
      }
      const index = this.edges.length;
      this.edges.push({ x1: e.x1, y1: e.y1, z1: e.z1, x2: e.x2, y2: e.y2, z2: e.z2, nx, nz, rise });
      for (let gx = Math.floor(Math.min(e.x1, e.x2) / CELL); gx <= Math.floor(Math.max(e.x1, e.x2) / CELL); gx++) {
        for (let gz = Math.floor(Math.min(e.z1, e.z2) / CELL); gz <= Math.floor(Math.max(e.z1, e.z2) / CELL); gz++) {
          const k = (gx + 32768) * 65536 + (gz + 32768);
          const list = this.grid.get(k);
          if (list) list.push(index);
          else this.grid.set(k, [index]);
        }
      }
    });
  }

  get wallCount(): number {
    return this.edges.filter((e) => e.rise === null).length;
  }

  private near(x0: number, z0: number, x1: number, z1: number): Set<number> {
    const out = new Set<number>();
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        for (const i of this.grid.get((gx + 32768) * 65536 + (gz + 32768)) ?? []) out.add(i);
      }
    }
    return out;
  }

  /**
   * One part moving from (px, pz) to (x, z) with radius r, standing on a floor at height y, able
   * to step up `step`. Returns the bounce at the first edge crossed, or null.
   */
  sweep(px: number, pz: number, x: number, z: number, r: number, y: number, step: number): WallHit | null {
    const mx = x - px, mz = z - pz;
    if (mx === 0 && mz === 0) return null;
    let best: WallHit | null = null;
    let bestT = Infinity;
    for (const i of this.near(Math.min(px, x) - r, Math.min(pz, z) - r, Math.max(px, x) + r, Math.max(pz, z) + r)) {
      const e = this.edges[i];
      if (e.rise !== null && e.rise <= step) continue;
      if (Math.abs((e.y1 + e.y2) / 2 - y) > FLOOR_WINDOW) continue;
      const elen0 = Math.hypot(e.x2 - e.x1, e.z2 - e.z1) || 1;
      // The start point: first touch of the moving circle, t along the movement.
      {
        const fx = px - e.x1, fz = pz - e.z1;
        const a = mx * mx + mz * mz, b = 2 * (fx * mx + fz * mz), c = fx * fx + fz * fz - r * r;
        const disc = b * b - 4 * a * c;
        if (disc >= 0 && c > 0) {
          const t = (-b - Math.sqrt(disc)) / (2 * a);
          if (t >= 0 && t <= 1 && t < bestT) {
            const cx = px + mx * t, cz = pz + mz * t;
            const nl = Math.hypot(e.x1 - cx, e.z1 - cz) || 1;
            const ux = (e.x1 - cx) / nl, uz = (e.z1 - cz) / nl;
            const vx = cx - x, vz = cz - z;
            const d = vx * ux + vz * uz;
            const rx = (2 * d * ux - vx) * CORNER_BOUNCE, rz = (2 * d * uz - vz) * CORNER_BOUNCE;
            bestT = t;
            best = { x: cx + rx, z: cz + rz, speed: Math.hypot(rx, rz), angle: Math.atan2(rx, rz), ex: (e.x2 - e.x1) / elen0, ez: (e.z2 - e.z1) / elen0 };
          }
        }
      }
      // Moving outwards and within reach of the edge line.
      if (mx * e.nx + mz * e.nz < 0) continue;
      if ((x - e.x1) * e.nx + (z - e.z1) * e.nz < -r) continue;
      // The edge moved inwards by the radius, cut with the movement.
      const ax = e.x1 - e.nx * r, az = e.z1 - e.nz * r;
      const bx = e.x2 - e.nx * r, bz = e.z2 - e.nz * r;
      const ex = bx - ax, ez = bz - az;
      const den = mx * ez - mz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - px) * ez - (az - pz) * ex) / den;
      const u = ((ax - px) * mz - (az - pz) * mx) / den;
      const len = Math.hypot(mx, mz), elen = Math.hypot(ex, ez);
      if (t < -1 / len || t > 1 + 1 / len || u < -1 / elen || u > 1 + 1 / elen || t >= bestT) continue;
      const cx = px + mx * t, cz = pz + mz * t;
      // Mirror the remaining movement (from the current position back to the cut) about the
      // inward normal and keep 0.2 of it.
      const vx = cx - x, vz = cz - z;
      const d = vx * -e.nx + vz * -e.nz;
      const rx = (2 * d * -e.nx - vx) * WALL_BOUNCE, rz = (2 * d * -e.nz - vz) * WALL_BOUNCE;
      bestT = t;
      best = { x: cx + rx, z: cz + rz, speed: Math.hypot(rx, rz), angle: Math.atan2(rx, rz), ex: ex / elen, ez: ez / elen };
    }
    return best;
  }
}
