import * as THREE from 'three';
import type { Anm } from '../formats/anm';
import { engineEuler } from './coords';

interface FrameState {
  rotations: THREE.Quaternion[];
  root: THREE.Vector3 | null;
}

/** Frames with every node's state filled in (ANM commands persist until overwritten). */
export class AnimClip {
  readonly frames: FrameState[] = [];

  constructor(readonly name: string, anm: Anm, nodeCount: number) {
    const rot: Array<[number, number, number]> = Array.from({ length: nodeCount }, () => [0, 0, 0]);
    let root: [number, number, number] | null = null;
    const e = new THREE.Euler();
    for (const f of anm.frames) {
      // Rotation commands index the file's node table, which maps to engine node numbers.
      f.rotations.forEach((r, entry) => {
        const node = anm.nodes[entry]?.index ?? entry;
        if (node < nodeCount) rot[node] = r;
      });
      // Anm_Parse discards the node field of position commands: they always move the root.
      for (const p of f.positions.values()) root = p;
      this.frames.push({
        rotations: rot.map((r) => new THREE.Quaternion().setFromEuler(engineEuler(r[0], r[1], r[2], e))),
        root: root ? new THREE.Vector3(root[0], -root[1], root[2]) : null,
      });
    }
  }
}

/**
 * Plays clips on a character's bones: one ANM frame per 40 ms game tick, as 0x434540 steps one
 * frame per call (looping with flag 1) and the movers call it once per tick [O]. [I] Frames are
 * interpolated for smooth rendering at display rate (the original shows them unblended).
 */
export class AnimPlayer {
  private clip: AnimClip | null = null;
  private time = 0;
  rate = 1;
  private readonly qa = new THREE.Quaternion();

  constructor(private readonly bones: THREE.Bone[]) {}

  play(clip: AnimClip, restart = false): void {
    if (this.clip === clip && !restart) return;
    this.clip = clip;
    this.time = 0;
  }

  get current(): AnimClip | null {
    return this.clip;
  }

  /** Advance by a number of game ticks (may be fractional). */
  advance(ticks: number): void {
    if (!this.clip || !Number.isFinite(ticks)) return;
    const n = this.clip.frames.length;
    this.time = (((this.time + ticks * this.rate) % n) + n) % n;
  }

  apply(): void {
    const clip = this.clip;
    if (!clip || clip.frames.length === 0) return;
    const n = clip.frames.length;
    const i0 = Math.floor(this.time) % n;
    const i1 = (i0 + 1) % n;
    const t = this.time - Math.floor(this.time);
    const a = clip.frames[i0], b = clip.frames[i1];
    for (let i = 0; i < this.bones.length && i < a.rotations.length; i++) {
      this.bones[i].quaternion.copy(this.qa.copy(a.rotations[i]).slerp(b.rotations[i], t));
    }
    if (a.root && b.root) this.bones[0].position.lerpVectors(a.root, b.root, t);
  }
}
