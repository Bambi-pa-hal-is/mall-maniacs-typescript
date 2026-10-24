import type * as THREE from 'three';
import type { AudioEngine, SoundEmitter } from '../engine/audio';
import type { Impact } from './crowd';
import type { EventObject } from './events';
import type { Player } from './player';

/** Sound ids (file numbers in sound\). */
export const SND = {
  cartBump: [1, 2, 3], // Vagnkoll1-3
  wind: 5,
  computerLoop: 6,
  goal: 8,
  footsteps: 10, // Steg2
  cartRoll: 11, // Vagnrull1
  mallJingle: 15, // 15 + mall index: Mini, Woods, Asia, Aqua, Future
  bubbling: 25, // Porl
  rapids: 27, // Fors1
  splash: 26, // Plask
  doorbell: 28, // Dorrbell (played by the HUD)
  inCart: 22,
  birds: 31,
  birds2: 32,
  gong: 35,
  blast: 7, // Blast
  bounce: 20, // Bounce
  throw: 21, // Throw
  punchHit: 22, // Throw-Hit
} as const;

/**
 * Positional ambience started by each mall's level script (ICA 0x416db0, Woodshop 0x4175e0,
 * Orient 0x417dc0, Aqua 0x4186c0, Future 0x418f30): [sound id, x, y, z] in engine units.
 */
const AMBIENCE: Array<Array<[number, number, number, number]>> = [
  [],
  [
    [SND.birds2, -50000, -5000, 3000],
    [SND.birds, -3700, -4000, 16500],
    [SND.birds, 6400, -2000, -16000],
  ],
  [],
  [
    [SND.rapids, 8200, 8000, -39000],
    [SND.rapids, -25500, 4000, -29000],
    [SND.bubbling, 30500, -1000, -29000],
    [SND.rapids, 3500, -1000, -17000],
  ],
  [
    [SND.computerLoop, 500, -2000, 0],
    [SND.computerLoop, 42250, -1000, 200],
    [SND.wind, 42800, -1000, 11000],
    [SND.wind, 42800, -1000, -11000],
    [SND.wind, 11250, -1000, 38500],
  ],
];

const BUMP_COOLDOWN_MS = 600;
/** Orient's tick (0x418000): the gong sounds once when you come within 2500 (each axis) of it. */
const ORIENT = 2;
const GONG_RANGE = 2500;
/** Cart rolling sound thresholds (0x40c800). */
const ROLL_SPEED = 45;
const ROLL_TURN = 0.012;

/**
 * Level audio: mall ambience, per-player footsteps and cart rolling, bumps and event sounds.
 * The loops [O] (0x40c800, full volume): footsteps (10) on the character while the throttle is
 * held; cart rolling (11) on the cart while its speed exceeds 45 or its turn rate 0.012 (floats
 * 0x44b4a0..0x44b4a4, 0x44b490..0x44b498), pushed or free.
 * The doorbell (28) belongs to the HUD (GameHud); an item going into the cart plays 22 (0x40f420).
 */
export class LevelSound {
  private readonly ambience: SoundEmitter[] = [];
  private readonly loops = new Map<Player, { steps: SoundEmitter | null; roll: SoundEmitter | null }>();
  private readonly lastBump = new Map<string, number>();

  private readonly gong: EventObject | null;
  private atGong = false;

  constructor(
    private readonly audio: AudioEngine,
    private readonly root: THREE.Object3D,
    private readonly human: Player,
    players: Player[],
    private readonly mallIndex: number,
    events: EventObject[] = [],
  ) {
    this.gong = mallIndex === ORIENT ? (events.find((e) => e.name === 'gong') ?? null) : null;
    for (const [id, x, y, z] of AMBIENCE[mallIndex] ?? []) {
      const e = audio.emitter(id, true, 4000, 60000);
      if (!e) continue;
      e.setPosition(root, x, y, z);
      e.setVolume(0.9);
      this.ambience.push(e);
    }
    for (const p of players) {
      const steps = audio.emitter(SND.footsteps, true, 1200);
      const roll = p.cart ? audio.emitter(SND.cartRoll, true, 1500) : null;
      steps?.setVolume(0);
      roll?.setVolume(0);
      this.loops.set(p, { steps, roll });
    }
  }

  /** Per frame: move loops with their players and set volume from speed. */
  update(): void {
    this.loops.forEach((l, p) => {
      const walking = p.throttleInput !== 0 && !p.sliding && !p.raceEnd;
      l.steps?.setPosition(this.root, p.pos.x, p.pos.y - 100, p.pos.z);
      l.steps?.setVolume(walking ? 1 : 0);
      const m = p.cartMotion;
      const rolling = !p.cartSliding && (Math.abs(m.speed) > ROLL_SPEED || Math.abs(m.turn) > ROLL_TURN);
      l.roll?.setPosition(this.root, p.cartPos.x, p.cartPos.y - 300, p.cartPos.z);
      l.roll?.setVolume(rolling ? 1 : 0);
    });
  }

  /** Per tick: consume player events and collision impacts. */
  tick(impacts: Impact[], finished: Player[], bounces: THREE.Vector3[] = []): void {
    for (const b of bounces) {
      const e = this.audio.emitter(SND.bounce, false, 1200);
      e?.setPosition(this.root, b.x, b.y, b.z);
    }
    for (const p of this.loops.keys()) {
      for (const e of p.events) {
        if (e === 'splash' || e === 'launch' || e === 'cart-launch') {
          // Positional for every player: attached to the walker / the cart (0x426fd0, 0x427730).
          const at = e === 'cart-launch' ? p.cartPos : p.pos;
          this.audio.emitter(e === 'splash' ? SND.splash : SND.blast, false, 1500)?.setPosition(this.root, at.x, at.y - 600, at.z);
          continue;
        }
        if (e === 'punched') {
          // [I] Unofficial punch rule: a hit plays Throw-Hit; the swing itself is silent.
          this.audio.emitter(SND.punchHit, false, 1500)?.setPosition(this.root, p.pos.x, p.pos.y - 400, p.pos.z);
          continue;
        }
        if (p !== this.human) continue;
        // The quiz answer itself is silent in the original (0x40b510 mode 1): a right answer goes on
        // to the normal pickup, a wrong one blocks the item. 33/34 (Red1/Green1) are the start lights.
        if (e === 'item-in-cart') this.audio.play(SND.inCart);
        else if (e === 'item-thrown') this.audio.play(SND.throw);
        else if (e === 'burger') this.audio.play(SND.mallJingle + this.mallIndex);
      }
      p.events.length = 0;
    }
    const now = performance.now();
    for (const im of impacts) {
      if (!im.carts || im.depth < 30) continue;
      if (now - (this.lastBump.get(im.key) ?? 0) < BUMP_COOLDOWN_MS) continue;
      this.lastBump.set(im.key, now);
      const id = SND.cartBump[Math.floor(Math.random() * SND.cartBump.length)];
      const e = this.audio.emitter(id, false, 1500);
      if (e) {
        e.setPosition(this.root, im.x, im.y - 400, im.z);
        e.setVolume(Math.min(1, im.depth / 120));
      }
    }
    // 0x40c450 plays it for whoever checks out (the race ends then).
    if (finished.length) this.audio.play(SND.goal);
    if (this.gong) {
      const h = this.human.pos;
      const near = Math.abs(this.gong.x - h.x) < GONG_RANGE && Math.abs(this.gong.z - h.z) < GONG_RANGE;
      if (near && !this.atGong) this.audio.play(SND.gong);
      this.atGong = near;
    }
  }

  dispose(): void {
    this.ambience.forEach((e) => e.stop());
    this.loops.forEach((l) => {
      l.steps?.stop();
      l.roll?.stop();
    });
  }
}
