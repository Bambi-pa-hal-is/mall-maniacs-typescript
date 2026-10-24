import * as THREE from 'three';
import type { TextureBank } from '../engine/materials';
import { buildMesh } from '../engine/meshFactory';
import { ANGLE_TO_RAD, createEngineRoot } from '../engine/coords';
import { detailLevel, type SenScene } from '../formats/sen';
import { insideArea, type EventObject } from './events';
import type { Player } from './player';
import type { Shop } from './shopping';
import { GameMode, type ModeRules } from './modes';

/**
 * Guide arrows from OBJECTS.SEN (CreateObjects 0x411550 requires 'VARUPIL' and 'VAGNPIL').
 * GuideArrow_Update (0x40cf40) positions them relative to the camera object (DAT_004588f8) with a
 * sine wobble, i.e. a 3D compass on screen. The two arrows are independent [O]:
 * - VARUPIL (pivot DAT_00458118 at camera (-800, 590, 1200)) points at the current target (the
 *   nearest still-needed item, the next checkpoint, or the checkout) whenever there is one;
 * - VAGNPIL (pivot DAT_0045811c at camera (800, 590, 1200)) points at the player's cart whenever
 *   it is not being pushed (+0x174 = 0).
 * Both are hidden once the race is over.
 *
 * Routing (0x40cf40, from the .eo file): when the player and the target are in different areas,
 * the arrow points at a waypoint instead. Area tests are 2D. This applies to the cart arrow always,
 * and to the item arrow except in Matkrig.
 * - Future (mall 4): areas ARE1/ARE2 (anything else counts as ARE4). From ARE1 go to EXI1, from
 *   ARE4 to EXI4, from ARE2 to EXI2 when the target is in ARE1, otherwise EXI3.
 * - Other malls: PUNK areas, each with a waypoint at its anchor and a "reached" box of v0 (engine
 *   Z) by v1 (engine X) around it. Inside a PUNK area and not yet at its waypoint: go there.
 *   Otherwise, if the target's PUNK waypoint is not reached yet, go there first.
 */
export interface GuideRoutes {
  future: boolean;
  punk: EventObject[];
  areas: Map<string, EventObject>;
}
/**
 * Screen placement. The original hangs the pivots at camera (+-800, 590, 1200), engine Y down, so
 * the item arrow sits lower left and the cart arrow lower right. [I] With the original camera's
 * focal length 1.0 (0x4318e0, read as a 90 degree horizontal view on a 4:3 screen) that is
 * +-0.667 across and -0.656 down in normalised screen coordinates; the anchors are placed there
 * for the port's camera at this depth.
 */
const ARROW_NDC = { x: 800 / 1200, y: -(590 / 1200) / 0.75 };
const ARROW_DEPTH = 1500;
/**
 * Orientation [O] (0x40cf40): each pivot gets the camera's rotation change when the camera is
 * aimed at the target at its own height, which cancels the camera's pitch, so the arrow lies flat
 * in the world. The arrow turns by the yaw to the target and wobbles about x and z by
 * sin(phase + offset) * (turn rate + speed) * scale int16 units, the phase growing 0.3 every second
 * tick. [offset, scale] for z then x, walking / pushing:
 */
const WOBBLE = {
  item: { walk: [[0.23, 14], [0.43, 10]], push: [[0.14, 12], [0.3, 17]] },
  cart: { walk: [[0.97, 14], [1.37, 13]], push: [[0.123, 11], [0.21, 16]] },
} as const;
const WOBBLE_STEP = 0.3 / 2;
const SCALE = 1.1;

function meshNamed(scene: SenScene, name: string): number | null {
  const o = scene.objects.find((x) => detailLevel(x.name).base === name && detailLevel(x.name).level === 0);
  return o ? o.mesh : null;
}

export class GuideArrows {
  private readonly itemArrow: THREE.Object3D | null;
  private readonly cartArrow: THREE.Object3D | null;
  /** Wobble phases of the item and cart arrows (DAT_00458960 / DAT_0045895c). */
  private readonly phase = { item: 0, cart: 0 };
  /** The list slot the item arrow keeps pointing at (+0x1d4), -1 = choose again. */
  private sticky = -1;
  private stickyBlocked = 0;
  private readonly tmp = new THREE.Vector3();
  /** Rendered after the scene with a cleared depth buffer, so the arrow is always on top. */
  readonly overlay = new THREE.Scene();
  private readonly root = createEngineRoot();
  /** Compass discs (item, cart): positioned at their anchors, yawed with the camera, pitched towards it. */
  private readonly discs = [new THREE.Group(), new THREE.Group()];
  private readonly camEngine = new THREE.Vector3();

  constructor(
    objects: SenScene,
    bank: TextureBank,
    private readonly player: Player,
    private readonly shop: Shop,
    private readonly rules: ModeRules,
    private readonly routes: GuideRoutes = { future: false, punk: [], areas: new Map() },
  ) {
    this.overlay.add(this.root);
    for (const d of this.discs) {
      d.rotation.order = 'YXZ';
      this.root.add(d);
    }
    const make = (name: string, disc: THREE.Group) => {
      const m = meshNamed(objects, name);
      if (m === null) return null;
      const o = buildMesh(objects, m, bank).object;
      // Own material copies (the bank's are shared with the rest of the mall).
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((mat) => {
        const c = mat.clone();
        // The arrow is not a closed solid (it was only seen from the original's fixed angle), so
        // backface culling leaves holes once it is tilted towards the viewer.
        c.side = THREE.DoubleSide;
        return c;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
      o.rotation.order = 'YXZ';
      o.scale.setScalar(SCALE);
      disc.add(o);
      return o;
    };
    this.itemArrow = make('VARUPIL', this.discs[0]);
    this.cartArrow = make('VAGNPIL', this.discs[1]);
  }

  /** VARUPIL's target (routed except in Matkrig). */
  private target(): { x: number; z: number } | null {
    const p = this.player;
    if (p.finishedRank !== null) return null;
    const t = this.itemTarget();
    if (!t || this.rules.mode === GameMode.Matkrig) return t;
    return this.route(t.x, t.z);
  }

  /** VAGNPIL's target: the cart while it is not pushed (always routed). */
  private cartTarget(): { x: number; z: number } | null {
    const p = this.player;
    if (p.finishedRank !== null || !p.cart || p.holdingCart) return null;
    return this.route(p.cartPos.x, p.cartPos.z);
  }

  /** The waypoint to head for on the way to (tx, tz), or the target itself. */
  private route(tx: number, tz: number): { x: number; z: number } {
    const { x: px, z: pz } = this.player.pos;
    const r = this.routes;
    if (r.future) {
      const a = r.areas;
      const areaOf = (x: number, z: number) =>
        ['ARE1', 'ARE2'].find((n) => a.has(n) && insideArea(a.get(n)!, x, z)) ?? 'ARE4';
      const from = areaOf(px, pz), to = areaOf(tx, tz);
      if (from !== to) {
        const exit = a.get(from === 'ARE1' ? 'EXI1' : from === 'ARE4' ? 'EXI4' : to === 'ARE1' ? 'EXI2' : 'EXI3');
        if (exit) return exit;
      }
      return { x: tx, z: tz };
    }
    const punkAt = (x: number, z: number) => r.punk.find((o) => insideArea(o, x, z)) ?? null;
    const reached = (o: EventObject) => Math.abs(o.z - pz) < o.values[0] && Math.abs(o.x - px) < o.values[1];
    const from = punkAt(px, pz), to = punkAt(tx, tz);
    if (from !== to) {
      if (from && !reached(from)) return from;
      if (to && !reached(to)) return to;
    }
    return { x: tx, z: tz };
  }

  private itemTarget(): { x: number; z: number; cart: boolean } | null {
    const p = this.player;
    if (this.rules.mode === GameMode.Vagnrace && !p.allFound) {
      const c = this.rules.nextCheckpoint(p);
      return c ? { x: c.x, z: c.z, cart: false } : null;
    }
    if (p.allFound) {
      const b = this.shop.goal?.bounds;
      return b ? { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, cart: false } : null;
    }
    // 0x40cf40 [O]: no item target while the hands are full. The target sticks: once the nearest
    // still-needed item is chosen, its list slot (+0x1d4) is kept until it is found (then the first
    // spot of that type is used); a wrong quiz answer clears it (-1).
    if (p.inHand !== 0) return null;
    if (p.blockedType !== this.stickyBlocked) {
      this.stickyBlocked = p.blockedType;
      if (p.blockedType !== 0) this.sticky = -1;
    }
    if (this.sticky >= 0 && !p.found[this.sticky]) {
      const s = this.shop.spotsOf(p.list[this.sticky])[0];
      if (s) return { x: s.x, z: s.z, cart: false };
    }
    let best: { x: number; z: number; cart: boolean } | null = null;
    let bestD = Infinity;
    p.list.forEach((t, i) => {
      if (p.found[i] || t === p.blockedType) return;
      for (const s of this.shop.spotsOf(t)) {
        if (!p.canTakeFrom(s)) continue;
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d < bestD) {
          bestD = d;
          best = { x: s.x, z: s.z, cart: false };
          this.sticky = i;
        }
      }
    });
    return best;
  }

  update(camera: THREE.Camera, frameTicks: number): void {
    this.phase.item += WOBBLE_STEP * frameTicks;
    this.phase.cart += WOBBLE_STEP * frameTicks;
    const p = this.player;
    const motion = p.angVel + p.speed;
    camera.updateMatrixWorld();
    this.root.updateMatrixWorld();
    this.root.worldToLocal(camera.getWorldPosition(this.camEngine));
    const cam = camera as THREE.PerspectiveCamera;
    const halfH = Math.tan(((cam.fov ?? 60) * Math.PI) / 360) * ARROW_DEPTH;
    const halfW = halfH * (cam.aspect ?? 4 / 3);
    const show = (arrow: THREE.Object3D | null, disc: THREE.Group, side: number, t: { x: number; z: number } | null, kind: 'item' | 'cart') => {
      if (!arrow) return;
      arrow.visible = !!t;
      if (!t) return;
      // Camera-space anchor -> engine coordinates.
      this.root.worldToLocal(camera.localToWorld(this.tmp.set(side * ARROW_NDC.x * halfW, ARROW_NDC.y * halfH, -ARROW_DEPTH)));
      // Camera heading in engine space (horizontal direction from the eye to the anchor).
      const camYaw = Math.atan2(this.tmp.x - this.camEngine.x, this.tmp.z - this.camEngine.z);
      const targetYaw = Math.atan2(t.x - this.tmp.x, t.z - this.tmp.z);
      disc.position.copy(this.tmp);
      disc.rotation.set(0, camYaw, 0, 'YXZ');
      const [[oz, kz], [ox, kx]] = WOBBLE[kind][p.holdingCart ? 'push' : 'walk'];
      const ph = this.phase[kind];
      arrow.position.set(0, 0, 0);
      arrow.rotation.set(
        Math.trunc(Math.sin(ph + ox) * motion * kx) * ANGLE_TO_RAD,
        targetYaw - camYaw,
        Math.trunc(Math.sin(ph + oz) * motion * kz) * ANGLE_TO_RAD,
        'YXZ',
      );
    };
    show(this.itemArrow, this.discs[0], -1, this.target(), 'item');
    show(this.cartArrow, this.discs[1], 1, this.cartTarget(), 'cart');
  }
}
