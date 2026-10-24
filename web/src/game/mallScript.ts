import * as THREE from 'three';
import { AnimClip, AnimPlayer } from '../engine/animation';
import { ANGLE_TO_RAD, engineEuler } from '../engine/coords';
import type { Anm } from '../formats/anm';
import type { SenScene } from '../formats/sen';
import type { BuiltMesh } from '../engine/meshFactory';
import type { EventObject } from './events';
import type { Shop } from './shopping';

/**
 * Per-mall level scripts (init/tick pairs: ICA 0x416db0/0x416fd0, Woodshop 0x4175e0/0x4178c0,
 * Orient 0x417dc0/0x418000, Aqua 0x4186c0/0x418a30, Future 0x418f30/0x4192a0).
 * Every mall has a cashier (KASSOERSKA, cash_sit.anm, s_winner.anm once the race is over) and a
 * McDonald's man (MCDMAN) who, every 10 s while no burger is out, picks a burger up (s_flpick1,
 * s_flpick2), throws it (s_throw1 with the BURGER on hand node 8, s_throw2) onto his counter where
 * it slides five steps and becomes a pickup of item 31 that only the human player can take
 * (eating it gives the speed boost, see Player.energy). NPC animations advance every other tick.
 * Aqua's tick also spins its SKYLT%d signs (i = 0..6; SKYLT1..6 exist) about y by (5i + 40) * 10
 * angle units per tick. ICA and Orient animate the nodes of a SIGN_FELIXPO object, but no scene
 * has one (only the single-node SIGN_FELIX), so that code never runs in the original.
 */
const AQUA = 3;
export const BURGER_TYPE = 31;

interface MallLayout {
  cashier: [number, number, number, number]; // x y z ry
  mcd: [number, number, number, number];
  burger: [number, number, number];
  /** Slide direction of the burger after landing (unit axis). */
  slide: [number, number];
}

const LAYOUTS: MallLayout[] = [
  { cashier: [12500, 0, 8500, 16000], mcd: [8000, 0, -21200, 0], burger: [8200, -1010, -21000], slide: [0, 1] },
  { cashier: [-8500, 0, 4500, 16000], mcd: [-35000, -3000, -300, 0], burger: [-34800, -4010, 0], slide: [0, 1] },
  { cashier: [-10500, -500, -20500, 16000], mcd: [33200, -500, 1000, -16000], burger: [33200, -1510, 800], slide: [-1, 0] },
  { cashier: [31500, 8000, -34500, 32000], mcd: [-39200, 4000, -23000, 16000], burger: [-39000, 3010, -23200], slide: [1, 0] },
  { cashier: [23500, 2000, 4500, 32000], mcd: [55200, 0, 4000, -16000], burger: [54800, -1010, 4200], slide: [-1, 0] },
];

const BURGER_DELAY_MS = 10000;
const HAND_NODE = 8;

export interface ScriptAnims {
  stand: Anm;
  flpick1: Anm;
  flpick2: Anm;
  throw1: Anm;
  throw2: Anm;
  cashSit: Anm;
  winner: Anm;
}

type Phase = 'wait' | 'pick1' | 'pick2' | 'throw1' | 'throw2' | 'slide' | 'out';

export class MallScript {
  private readonly cashier: { obj: THREE.Object3D; anim: AnimPlayer; sit: AnimClip; win: AnimClip } | null;
  private readonly mcd: { obj: THREE.Object3D; bones: THREE.Bone[]; anim: AnimPlayer; clips: Record<string, AnimClip> } | null;
  private readonly burger: THREE.Object3D | null;
  private phase: Phase = 'wait';
  private phaseTicks = 0;
  private waitMs = 0;
  private slideStep = 0;
  private burgerSpot: EventObject | null = null;
  private readonly layout: MallLayout | undefined;
  /** Spinning signs and their speed in radians per tick. */
  private readonly spinners: Array<{ obj: THREE.Object3D; speed: number }> = [];

  constructor(
    mallIndex: number,
    private readonly root: THREE.Object3D,
    private readonly shop: Shop,
    private readonly tickMs: number,
    chars: SenScene,
    build: (name: string) => BuiltMesh | null,
    anims: ScriptAnims,
    sceneObjects: Map<string, THREE.Object3D> = new Map(),
  ) {
    this.layout = LAYOUTS[mallIndex];
    if (mallIndex === AQUA) {
      for (let i = 0; i < 7; i++) {
        const obj = sceneObjects.get(`SKYLT${i}`);
        if (obj) this.spinners.push({ obj, speed: (5 * i + 40) * 10 * ANGLE_TO_RAD });
      }
    }
    const place = (o: THREE.Object3D, [x, y, z, ry]: [number, number, number, number]) => {
      o.position.set(x, y, z);
      engineEuler(0, ry, 0, o.rotation);
      root.add(o);
    };
    const clip = (name: string, a: Anm, bones: THREE.Bone[]) => new AnimClip(name, a, bones.length);
    void chars;

    const c = this.layout ? build('KASSOERSKA') : null;
    if (c && c.bones && this.layout) {
      const holder = new THREE.Group();
      holder.add(c.object);
      place(holder, this.layout.cashier);
      const anim = new AnimPlayer(c.bones);
      const sit = clip('cash_sit', anims.cashSit, c.bones);
      anim.play(sit);
      anim.rate = 0.5;
      this.cashier = { obj: holder, anim, sit, win: clip('winner', anims.winner, c.bones) };
    } else this.cashier = null;

    const m = this.layout ? build('MCDMAN') : null;
    if (m && m.bones && this.layout) {
      const holder = new THREE.Group();
      holder.add(m.object);
      place(holder, this.layout.mcd);
      const anim = new AnimPlayer(m.bones);
      const clips = {
        stand: clip('stand', anims.stand, m.bones),
        pick1: clip('flpick1', anims.flpick1, m.bones),
        pick2: clip('flpick2', anims.flpick2, m.bones),
        throw1: clip('throw1', anims.throw1, m.bones),
        throw2: clip('throw2', anims.throw2, m.bones),
      };
      anim.play(clips.stand);
      anim.rate = 0.5;
      this.mcd = { obj: holder, bones: m.bones, anim, clips };
    } else this.mcd = null;

    const b = this.layout ? build('BURGER') : null;
    this.burger = b ? b.object : null;
    if (this.burger) this.burger.visible = false;
  }

  /** Length of a clip in ticks at the scripts' half-speed animation. */
  private clipTicks(c: AnimClip): number {
    return c.frames.length * 2;
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseTicks = 0;
    const m = this.mcd;
    if (!m) return;
    const clip = { wait: m.clips.stand, pick1: m.clips.pick1, pick2: m.clips.pick2, throw1: m.clips.throw1, throw2: m.clips.throw2, slide: m.clips.stand, out: m.clips.stand }[phase];
    m.anim.play(clip, true);
  }

  tick(raceOver: boolean): void {
    if (this.cashier && raceOver && this.cashier.anim.current !== this.cashier.win) this.cashier.anim.play(this.cashier.win, true);
    const m = this.mcd, b = this.burger, L = this.layout;
    if (!m || !b || !L) return;
    this.phaseTicks++;
    switch (this.phase) {
      case 'out':
        // Wait until the burger has been taken (its spot removed), then start over.
        if (this.burgerSpot && !this.shop.spots.includes(this.burgerSpot)) {
          this.burgerSpot = null;
          this.waitMs = 0;
          this.enter('wait');
        }
        return;
      case 'wait':
        this.waitMs += this.tickMs;
        if (this.waitMs > BURGER_DELAY_MS - 1) this.enter('pick1');
        return;
      case 'pick1':
        if (this.phaseTicks >= this.clipTicks(m.clips.pick1)) this.enter('pick2');
        return;
      case 'pick2':
        if (this.phaseTicks >= this.clipTicks(m.clips.pick2)) {
          // Burger in the right hand (node 8), 120 units along it.
          b.removeFromParent();
          b.position.set(0, 120, 0);
          b.rotation.set(0, 0, 0);
          (m.bones[HAND_NODE] ?? m.obj).add(b);
          b.visible = true;
          this.enter('throw1');
        }
        return;
      case 'throw1':
        if (this.phaseTicks >= this.clipTicks(m.clips.throw1)) {
          b.removeFromParent();
          b.position.set(...L.burger);
          b.rotation.set(0, 0, 0);
          this.root.add(b);
          this.slideStep = 0;
          this.enter('throw2');
        }
        return;
      case 'throw2':
      case 'slide': {
        // Five slide steps of (40 - n) * 4 units (one per tick), then the burger becomes a pickup.
        if (this.slideStep < 5) {
          this.slideStep++;
          const d = (40 - this.slideStep) * 4;
          b.position.x += L.slide[0] * d;
          b.position.z += L.slide[1] * d;
        }
        if (this.phase === 'throw2' && this.phaseTicks >= this.clipTicks(m.clips.throw2)) this.enter('slide');
        if (this.phase === 'slide' && this.slideStep >= 5) {
          // Spot height is the floor below the counter top (the burger lies ~1010 above the floor).
          const p = b.position.clone();
          const spot = this.shop.addDropped(BURGER_TYPE, new THREE.Vector3(p.x, p.y + 1010, p.z), b);
          this.burgerSpot = spot;
          this.enter('out');
        }
        return;
      }
    }
  }

  render(frameTicks: number): void {
    // Spun per tick in the original (FUN_004307d0 mode 5); per frame here, for smooth motion.
    for (const s of this.spinners) s.obj.rotation.y += s.speed * frameTicks;
    for (const n of [this.cashier, this.mcd]) {
      if (!n) continue;
      n.anim.advance(frameTicks);
      n.anim.apply();
    }
  }
}
