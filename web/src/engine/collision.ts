import * as THREE from 'three';
import type { SenScene } from '../formats/sen';
import { engineEuler } from './coords';
import { FloorEdges } from './floorEdges';

/**
 * Collision world built from a mall's physics scene (ph*.sen): walkable floors and walls.
 * The original (PhysWorld init 0x42ed40, Level_LoadPhysics 0x4104b0) builds floor regions only
 * from objects whose name contains FLOOR and does not start with '_' (0x42b360, 0x428cf0); the
 * other physics objects get no collision code at all, and bodies are kept inside the floor
 * regions by their border edges (0x4035e0). Players and carts now collide with exactly those
 * edges (floorEdges.ts); the wall/fence meshes remain only for thrown items (resolveWalls) and the
 * camera's wall pull (raycast). Only FLOOR objects can be stood on.
 * '_' objects (lower-detail copies) are left out. [I] The approximation: a 2D grid, floor ray
 * casts and circle-vs-wall push-out. All values are engine units, Y-down.
 */
const CELL = 1000;
const WALKABLE_NY = 0.6;

export interface CollisionObject {
  name: string;
  /** World-space centre of the object's triangles (engine units). */
  center: THREE.Vector3;
  enabled: boolean;
  /** A floor region: name contains FLOOR (only these can be stood on). */
  floor: boolean;
  /** Lowest point of the object (largest engine Y). */
  bottom: number;
}

/** 0x42b360: FLOOR objects, skipping names that start with '_'. */
export function isFloorObject(name: string): boolean {
  return name.includes('FLOOR') && !name.startsWith('_');
}

export class CollisionWorld {
  private readonly tris: Float32Array; // 9 floats per triangle
  private readonly normals: Float32Array; // 3 floats per triangle
  private readonly owner: Uint16Array; // collision object index per triangle
  private readonly grid = new Map<number, number[]>();
  readonly objects: CollisionObject[] = [];
  readonly triangleCount: number;
  /** The original's walls: edges of the floor regions (see floorEdges.ts). */
  readonly floorEdges: FloorEdges;

  /**
   * @param ignore object names left out of collision. The entrance/exit doors: the original has no
   * door code at all (no DOOR string in maniac.exe), and like every non-FLOOR physics object they
   * have no collision of their own, so they are passable.
   */
  constructor(scene: SenScene, ignore: RegExp = /DOORS/) {
    const verts: number[] = [];
    const owners: number[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const e = new THREE.Euler();
    for (const obj of scene.objects) {
      if (obj.type !== 1 || obj.mesh < 0 || obj.mesh >= scene.meshes.length || obj.name.startsWith('_') || ignore.test(obj.name)) continue;
      const lod = scene.meshes[obj.mesh].lods[0];
      const index = this.objects.length;
      const center = new THREE.Vector3();
      let count = 0;
      let bottom = -Infinity;
      m.compose(new THREE.Vector3(...obj.position), q.setFromEuler(engineEuler(...obj.rotation, e)), new THREE.Vector3(1, 1, 1));
      for (const group of lod.primGroups) {
        if (group.vertsPerPrim < 3) continue;
        for (const prim of group.prims) {
          for (let k = 1; k + 1 < prim.indices.length; k++) {
            for (const c of [0, k, k + 1]) {
              const i = prim.indices[c] * 3;
              v.set(lod.positions[i], lod.positions[i + 1], lod.positions[i + 2]).applyMatrix4(m);
              verts.push(v.x, v.y, v.z);
              bottom = Math.max(bottom, v.y);
              center.add(v);
              count++;
            }
            owners.push(index);
          }
        }
      }
      this.objects.push({ name: obj.name, center: count ? center.divideScalar(count) : center, enabled: true, floor: isFloorObject(obj.name), bottom });
    }
    this.owner = new Uint16Array(owners);
    this.tris = new Float32Array(verts);
    this.triangleCount = this.tris.length / 9;
    this.normals = new Float32Array(this.triangleCount * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < this.triangleCount; t++) {
      a.fromArray(this.tris, t * 9);
      b.fromArray(this.tris, t * 9 + 3);
      c.fromArray(this.tris, t * 9 + 6);
      const n = b.sub(a).cross(c.sub(a)).normalize();
      this.normals.set([n.x, n.y, n.z], t * 3);
      const xs = [this.tris[t * 9], this.tris[t * 9 + 3], this.tris[t * 9 + 6]];
      const zs = [this.tris[t * 9 + 2], this.tris[t * 9 + 5], this.tris[t * 9 + 8]];
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
          const key = this.key(cx, cz);
          const list = this.grid.get(key);
          if (list) list.push(t);
          else this.grid.set(key, [t]);
        }
      }
    }
    this.openGatesOnFloor();
    this.floorEdges = new FloorEdges(this.tris, (t) => this.objects[this.owner[t]].floor && Math.abs(this.normals[t * 3 + 1]) >= WALKABLE_NY);
  }

  /**
   * Start and checkout gates (GATE*, GRIND*, KASSAGRIND*, GRINDKASSA*) have no collision in the
   * original either; what stops a body is a gap in the floor regions (0x4035e0). A gate standing on
   * unbroken floor is therefore passable, while one placed over a gap (e.g. Wood's GRINDKASSA,
   * Orient's GATE10/14/16, Aqua's canal railings) keeps acting as the wall that the gap is.
   * [O] rule, [I] sampled at the gate's centre: passable only with floor within 150 of its base
   * (a floor far below, such as Aqua's water, is a gap at walkway level).
   */
  private openGatesOnFloor(): void {
    for (const o of this.objects) {
      if (o.floor || !/^(GATE|GRIND|KASSAGRIND|GRINDKASSA)/.test(o.name)) continue;
      const f = this.floorAt(o.center.x, o.center.z, o.bottom);
      if (f !== null && f <= o.bottom + 150) this.setEnabled(o, false);
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  private cellTris(x: number, z: number): number[] {
    const all = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
    return this.anyDisabled ? all.filter((t) => this.objects[this.owner[t]].enabled) : all;
  }

  private anyDisabled = false;

  /** Enable or disable collision for one object (e.g. a start gate that has swung open). */
  setEnabled(object: CollisionObject, enabled: boolean): void {
    object.enabled = enabled;
    this.anyDisabled = this.objects.some((o) => !o.enabled);
  }

  /** Highest floor-region surface (smallest y) at x,z that is at most stepUp above footY. */
  floorAt(x: number, z: number, footY: number, stepUp = 450): number | null {
    let best: number | null = null;
    const T = this.tris;
    for (const t of this.cellTris(x, z)) {
      if (!this.objects[this.owner[t]].floor) continue;
      const ny = this.normals[t * 3 + 1];
      if (Math.abs(ny) < WALKABLE_NY) continue;
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-6) continue;
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const y = w0 * T[o + 1] + w1 * T[o + 4] + w2 * T[o + 7];
      if (y < footY - stepUp) continue;
      if (best === null || y < best) best = y;
    }
    return best;
  }

  /**
   * First hit of the segment from -> to against any triangle, as a fraction of its length
   * (1 when nothing is hit). Used to keep the camera on the player's side of walls.
   */
  raycast(from: THREE.Vector3, to: THREE.Vector3): number {
    const T = this.tris;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (CELL / 2)));
    const seen = new Set<number>();
    let best = 1;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      for (const t of this.cellTris(from.x + dx * f, from.z + dz * f)) {
        if (seen.has(t)) continue;
        seen.add(t);
        const o = t * 9;
        // Moller-Trumbore
        const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
        const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        const sx = from.x - T[o], sy = from.y - T[o + 1], sz = from.z - T[o + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const h = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (h > 0 && h < best) best = h;
      }
    }
    return best;
  }

  /** Push a vertical cylinder (radius, height above footY) out of non-walkable triangles. */
  resolveWalls(pos: THREE.Vector3, radius: number, height: number, stepUp = 450): boolean {
    let hit = false;
    const T = this.tris;
    const top = pos.y - height, bottom = pos.y - stepUp;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const seen = new Set<number>();
      for (const [dx, dz] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
        for (const t of this.cellTris(pos.x + dx * radius, pos.z + dz * radius)) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (Math.abs(this.normals[t * 3 + 1]) >= WALKABLE_NY) continue;
          const o = t * 9;
          const ymin = Math.min(T[o + 1], T[o + 4], T[o + 7]);
          const ymax = Math.max(T[o + 1], T[o + 4], T[o + 7]);
          if (ymax <= top || ymin >= bottom) continue;
          // Closest point on the triangle's XZ footprint (its edges) to the cylinder axis.
          let bestD = Infinity, px = 0, pz = 0;
          for (let e = 0; e < 3; e++) {
            const ax = T[o + e * 3], az = T[o + e * 3 + 2];
            const bx = T[o + ((e + 1) % 3) * 3], bz = T[o + ((e + 1) % 3) * 3 + 2];
            const ex = bx - ax, ez = bz - az;
            const len2 = ex * ex + ez * ez;
            const s = len2 > 0 ? Math.max(0, Math.min(1, ((pos.x - ax) * ex + (pos.z - az) * ez) / len2)) : 0;
            const qx = ax + ex * s, qz = az + ez * s;
            const d2 = (pos.x - qx) ** 2 + (pos.z - qz) ** 2;
            if (d2 < bestD) {
              bestD = d2;
              px = qx;
              pz = qz;
            }
          }
          const dist = Math.sqrt(bestD);
          if (dist >= radius) continue;
          let nx = pos.x - px, nz = pos.z - pz;
          if (dist < 1e-3) {
            nx = this.normals[t * 3];
            nz = this.normals[t * 3 + 2];
          }
          const nl = Math.hypot(nx, nz) || 1;
          pos.x += (nx / nl) * (radius - dist);
          pos.z += (nz / nl) * (radius - dist);
          moved = hit = true;
        }
      }
      if (!moved) break;
    }
    return hit;
  }
}
