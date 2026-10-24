import * as THREE from 'three';
import type { SenScene } from '../formats/sen';
import { texelUV } from './meshFactory';

/**
 * Runs a scene's TANI records (TexAnim_Tick 0x434b00): per game tick, moves the UV bytes of the
 * listed MAPI records, which scrolls textures such as Aqua's water. Geometry built by buildMesh
 * remembers which MAPI record and corner each vertex came from (geometry.userData.uvSource).
 */
export class TextureAnimator {
  private readonly state: Array<{ tick: number; step: number }>;
  /** Accumulated byte offset (u, v) per animated MAPI record. */
  private readonly offset = new Map<number, [number, number]>();
  private readonly tracked: Array<{ attr: THREE.BufferAttribute; vertices: number[]; mapi: number[]; corner: number[] }> = [];
  private dirty = false;

  constructor(private readonly scene: SenScene) {
    this.state = scene.textureAnims.map(() => ({ tick: 0, step: 0 }));
    for (const a of scene.textureAnims) for (const m of a.mapi) this.offset.set(m, [0, 0]);
  }

  get active(): boolean {
    return this.offset.size > 0;
  }

  /** Remember the vertices of every mesh under root that use an animated MAPI record. */
  track(root: THREE.Object3D): void {
    if (!this.active) return;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const src = mesh.isMesh ? (mesh.geometry.userData.uvSource as number[] | undefined) : undefined;
      if (!src) return;
      const vertices: number[] = [], mapi: number[] = [], corner: number[] = [];
      for (let v = 0; v < src.length / 2; v++) {
        if (!this.offset.has(src[v * 2])) continue;
        vertices.push(v);
        mapi.push(src[v * 2]);
        corner.push(src[v * 2 + 1]);
      }
      if (vertices.length) this.tracked.push({ attr: mesh.geometry.getAttribute('uv') as THREE.BufferAttribute, vertices, mapi, corner });
    });
  }

  tick(): void {
    this.scene.textureAnims.forEach((a, i) => {
      const s = this.state[i];
      if (++s.tick < a.period) return;
      s.tick %= a.period;
      let du = a.du, dv = a.dv;
      if (++s.step === a.cycles) {
        s.step = 0;
        du += a.du2;
        dv += a.dv2;
      }
      if (!du && !dv) return;
      for (const m of a.mapi) {
        const o = this.offset.get(m)!;
        o[0] = (o[0] + du) & 255;
        o[1] = (o[1] + dv) & 255;
      }
      this.dirty = true;
    });
  }

  /** Write the current UVs (bytes wrap at 256, like the original's in-place byte adds). */
  apply(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const t of this.tracked) {
      for (let k = 0; k < t.vertices.length; k++) {
        const rec = this.scene.mapi[t.mapi[k]];
        const o = this.offset.get(t.mapi[k])!;
        const c = t.corner[k];
        t.attr.setXY(t.vertices[k], texelUV((rec.u[c] + o[0]) & 255), texelUV((rec.v[c] + o[1]) & 255));
      }
      t.attr.needsUpdate = true;
    }
  }
}
