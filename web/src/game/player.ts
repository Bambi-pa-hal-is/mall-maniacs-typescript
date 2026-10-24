import { simRandom } from './random';
import * as THREE from 'three';
import type { AnimClip, AnimPlayer } from '../engine/animation';
import { solveTwoBone } from '../engine/ik';
import type { CollisionWorld } from '../engine/collision';
import { ANGLE_TO_RAD } from '../engine/coords';
import type { Controls } from './input';
import type { CartConfig, MasterConfig } from './config';
import { insideArea, type EventObject } from './events';
import type { Shop } from './shopping';
import type { QuizQuestion } from '../formats/quiz';
import { BURGER_TYPE } from './mallScript';

/**
 * Movement constants derived like LoadPlayerConfig (0x410e90):
 *   acc  = master.acc * (speedStat * 0.06 + 0.7)
 *   racc = master.rotate_acc * (agilityStat * 0.1 + 0.5)
 *   top speed = acc / (1 - friction)
 * "_WC" variants apply while holding a cart. speedStat is the character's Snabbhet and
 * agilityStat its Smidighet (table 0x4501b4, see CHARACTER_STATS).
 */
export interface MovementParams {
  acc: number;
  rotateAcc: number;
  accWC: number;
  rotateAccWC: number;
  friction: number;
}

export function movementParams(master: MasterConfig, speedStat = 5, agilityStat = 5): MovementParams {
  const speedK = speedStat * 0.06 + 0.7;
  const turnK = agilityStat * 0.1 + 0.5;
  return {
    acc: master.acc * speedK,
    rotateAcc: master.rotateAcc * turnK,
    accWC: master.accWC * speedK,
    rotateAccWC: master.rotateAccWC * turnK,
    friction: master.friction,
  };
}


/**
 * PhysWorld bodies (LoadPlayerConfig 0x410e90 builds three per player with 0x4053a0) [O]. Parts
 * are circles at (z, x) in the body's frame, turned with its heading. Masses depend on Styrka:
 *   walker (+0x224): the character, radius 230, mass Styrka*25 + 90
 *   free cart (+0x264): two circles at z +-150 (radius 270 / 300) and four corner circles of 20
 *     at (300, +-190) and (-300, +-240), mass 75 each
 *   pushing (+0x2a4): the character plus the cart parts 750 ahead (corner radius 5), the cart
 *     parts weighing Styrka*25 + 75; active instead of the other two while the cart is held.
 */
/** [I] Unofficial rules a network host can switch on (not in the original game). */
export interface HouseRules {
  /** E / Ctrl (or Space with nothing else to do) punches; a hit player lets go of their cart. */
  punch: boolean;
  /** Any free cart can be grabbed and dragged away (to hide it). */
  grabCarts: boolean;
}

export interface PhysPart {
  z: number;
  x: number;
  r: number;
  m: number;
}

export interface PhysBody {
  owner: Player;
  /** The free cart (else the walker or pushing body, both at the character). */
  cart: boolean;
  z: number;
  x: number;
  /** Position and heading before this tick's movement (+0x28 / previous part offsets). */
  pz: number;
  px: number;
  heading: number;
  prevHeading: number;
  y: number;
  /** Velocity as the original keeps it: speed (+0x3c) and direction (+0x38) in the (z, x) plane. */
  speed: number;
  angle: number;
  parts: PhysPart[];
}

const CART_PARTS: Array<[number, number, number]> = [
  [150, 0, 270],
  [-150, 0, 300],
  [300, 190, 20],
  [300, -190, 20],
  [-300, 240, 20],
  [-300, -240, 20],
];
/**
 * The cart's four corner parts, in the order the tilt code reads them (the part list is built
 * last-first): back left, back right, front left, front right as (z, x) in the cart's frame.
 */
const CART_WHEELS: Array<[number, number]> = [
  [-300, -240],
  [-300, 240],
  [300, -190],
  [300, 190],
];
/** A wheel may hang at most this far below the highest one (float 0x44b6f4). */
const WHEEL_DROP = 300;
/** A wheel hitting the floor faster than gravity bounces back at this factor (0x44b700). */
const WHEEL_BOUNCE = -0.75;
const WALKER_RADIUS = 230;
/** [I] Unofficial punch rule: reach, half-angle in front, ticks between punches. */
const PUNCH_RANGE = 1400;
const PUNCH_ARC = 0.8;
const PUNCH_COOLDOWN = 20;
/**
 * Knockback of a punch: a push of its own (units per tick), kept apart from the velocity, which the
 * body physics clamps to the walking speed, and fading by KNOCKBACK_DECAY per tick (about 800 in all).
 */
const PUNCH_KNOCKBACK = 110;
const KNOCKBACK_DECAY = 0.86;
/** Stun after a punch: base + per point of the puncher's Styrka, in ticks (25 per second). */
const STUN_BASE = 10;
const STUN_PER_STRENGTH = 10;
/** Turn lean scale (float 0x44b4a8). */
const LEAN = 5600;
const _euler = new THREE.Euler();
/** Grab: facing window (doubles 0x44b548/0x44b550) and walk-up distance (0x44b540). */
const GRAB_FACING = 0.1;
const GRAB_REACH = 1000;
/** Step heights of the parts (0x4053a0 param 7): a floor this much higher can be walked onto. */
const WALKER_STEP = 300;
const CART_STEP = 240;
const HELD_CART_Z = 750;
const HELD_CORNER_RADIUS = 5;
/** Fall speed gained per tick in the air (0x44b58c, walker 0x426fd0 and cart bodies). */
const GRAVITY = 18;
/**
 * Mall-specific movement triggers from the .eo file, checked every tick by the walker (0x426fd0),
 * a free cart (0x427730) and a pushed cart (0x4280b0). Each needs the body's height within
 * [h2, h] and its position inside the object's area; the first match of each type applies.
 *
 * Aqua's water slide (mall 3). The currents are the mvnc event objects:
 * while the player's height is within [h2, h] and they stand inside one's area, the velocity is
 * set to 300 per tick towards the object's anchor (x, z), the turn speed to 0.23 rad per tick
 * (the player spins), and player flag 4 is set. That flag makes 0x40c800 play s_oops instead of
 * run/stand. The SPLASH sprite pair is shown and turned 0x1a0a per tick (not with the software
 * driver), and Plask (26) plays on entering and with 5% chance every tick after that.
 * A pushed cart is let go when it or its player is in a current (0x4280b0, every 5 ticks).
 * A free cart in a current (0x427730) is pushed at 350 with a turn speed of 0.2 and shows its own
 * SPLASH pair. Elsewhere its speed and turn decay by the cart's friction (objects/carts[n],
 * stored at +0x22c/+0x23c by 0x410e90), and it stops within 1100 of its own player.
 */
const SLIDE_SPEED = 300;
const SLIDE_SPIN = 0.23;
/** [I] Slide safety net (see Player.slideStuck). */
const SLIDE_STUCK_TICKS = 25;
const SLIDE_STUCK_DISTANCE = 300;
const SLIDE_OFF_TICKS = 75;
const CART_SLIDE_SPEED = 350;
const CART_SLIDE_SPIN = 0.2;
const SPLASH_SPIN = 0x1a0a * ((Math.PI * 2) / 65536);
/**
 * Orient and Future (malls 2 and 4):
 * - mvnc is a launch pad: speed 0, turn 0.23, fall speed -200 (a free cart: -250 and lifted 250),
 *   with Blast (7) when stepping on. Future's pads throw you up a tube and onto a hurl.
 * - hurl pushes at 400 towards its anchor with turn 0.23 (a free cart: 450 and 0.2).
 * - tele moves the body to (x, v0, z) and turns it by v1 (int16 angle); the velocity is kept
 *   (0x404e00). Orient and Future use them between floors. Computer players re-plan their route
 *   afterwards (0x4020c0 sets their +0x51).
 * A pushed cart only teleports; a pad makes you let go of it first (the rule above).
 */
const LAUNCH_SPEED = 200;
const CART_LAUNCH_SPEED = 250;
const HURL_SPEED = 400;
const CART_HURL_SPEED = 450;
const ANGLE = (Math.PI * 2) / 65536;

export interface MoveTriggers {
  /** Aqua: mvnc are water currents; elsewhere launch pads. */
  water: boolean;
  mvnc: EventObject[];
  hurl: EventObject[];
  tele: EventObject[];
}

/** First object of a list whose height range and area contain the point. */
function triggerAt(list: EventObject[], p: THREE.Vector3): EventObject | null {
  for (const r of list) {
    if (p.y <= r.y && r.h2 <= p.y && insideArea(r, p.x, p.z)) return r;
  }
  return null;
}

/** Velocity of `speed` from a point towards an object's anchor. */
function towards(out: THREE.Vector2, from: THREE.Vector3, to: EventObject, speed: number): void {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  out.set((dx / len) * speed, (dz / len) * speed);
}
/** CanGrabCart (0x40e180): character within 3000 units of its cart with empty hands. */
const GRAB_CART_RANGE = 3000;
/** Item pickup (0x40ed10): within 1000 units (squared 1e6) and +-500 in height of a spot. */
const PICKUP_RANGE = 1000;
const PICKUP_HEIGHT = 500;
/** Item_ThrowCheck (0x40f4d0): the item goes straight into the own cart within 1300 units (1.69e6). */
const DROP_RANGE = 1300;
/**
 * Item_Take (0x40ea20) parents the taken item to node 8 of the character (the right hand, as the
 * McDonald's man's burger) at (0, 300, 0), unrotated. [O]
 */
const HOLD_NODE = 8;
const HOLD_OFFSET = 300;
/** Arm chains (shoulder, elbow, wrist) from the character node table; node 3 sits at x = -180. */
const ARMS: Array<{ chain: [number, number, number]; side: number }> = [
  { chain: [3, 4, 5], side: -1 },
  { chain: [6, 7, 8], side: 1 },
];
const _target = new THREE.Vector3();
/** Cart_AddItem (0x40f1f0): in Varujakten/Frågesporten only the first three items stay visible. */
const CART_ITEMS_SHOWN = 3;
const _pole = new THREE.Vector3();

export type PlayerEvent =
  | 'item-picked'
  | 'item-in-cart'
  | 'item-dropped'
  | 'cart-grabbed'
  | 'cart-released'
  | 'quiz-start'
  | 'quiz-right'
  | 'quiz-wrong'
  | 'punch'
  | 'punched'
  | 'item-thrown'
  | 'burger'
  | 'splash'
  | 'launch'
  | 'cart-launch';

export interface CartRig {
  object: THREE.Object3D;
  config: CartConfig;
  /** Height offset of the cart mesh origin above the floor (from its lowest vertex). */
  yOffset: number;
}

export class Player {
  readonly object = new THREE.Group();
  readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  heading = 0;
  private prevHeading = 0;
  readonly vel = new THREE.Vector2();
  angVel = 0;
  private fallSpeed = 0;
  /** Carried by an mvnc water current (player flag 4). */
  sliding = false;
  /** This mall's movement triggers (empty lists where there are none). */
  triggers: MoveTriggers = { water: false, mvnc: [], hurl: [], tele: [] };
  /** On a launch pad this tick (player flag 8; the free cart uses flag 0x10). */
  private launched = false;
  private cartLaunched = false;
  /** Counts teleports, so computer players know to re-plan. */
  teleports = 0;
  /** Two crossed SPLASH quads around the player, shown while sliding. */
  splash: THREE.Object3D | null = null;
  /** The software driver (retro mode) does not show the splash. */
  showSplash = true;
  private splashAngle = 0;
  private prevSplashAngle = 0;
  private tickCount = 0;
  /** This tick's turn control (player +0x2e0); the camera updates every tick while it is non-zero. */
  turnInput = 0;
  /** This tick's throttle (+0x2e4): the run animation and the footsteps follow it (0x40c800). */
  throttleInput = 0;
  /** A let-go cart's own motion (it only moves when pushed by a current or a collision). */
  private readonly cartVel = new THREE.Vector2();
  private cartAngVel = 0;
  /** Walking to the cart's handle (action state 3): whose cart (own, or another's with cart theft). */
  private grabbing = false;
  private grabTargetPlayer: Player | null = null;
  /**
   * Unofficial network rules ([I], not in the original): punching knocks the cart out of others'
   * hands; cart theft lets a player drag another player's free cart away to hide it.
   */
  rules: HouseRules = { punch: false, grabCarts: false };
  /** Everyone in the race (set by the level), for punches and cart theft. */
  others: Player[] = [];
  /** The other player's cart this player is dragging, and who is dragging this player's cart. */
  dragging: Player | null = null;
  draggedBy: Player | null = null;
  private punchCooldown = 0;
  /** [I] Ticks left stunned by a punch: no control, the oops animation plays. */
  stunTicks = 0;
  /** [I] Slide safety net: where the slide progress was last checked, ticks since, ticks the currents let go. */
  private readonly slideCheck = new THREE.Vector2();
  private slideCheckTicks = 0;
  private slideOff = 0;
  private readonly knockback = new THREE.Vector2();
  /** Set when the race is over: the winner celebrates, the others stand (0x40c800). */
  raceEnd: 'winner' | 'other' | null = null;
  private cartFall = 0;
  cartSliding = false;
  cartSplash: THREE.Object3D | null = null;
  private cartSplashAngle = 0;
  private prevCartSplashAngle = 0;
  holdingCart = false;
  readonly cartPos = new THREE.Vector3();
  private readonly prevCartPos = new THREE.Vector3();
  cartHeading = 0;
  private prevCartHeading = 0;
  /** Cart tilt (0x4280b0 / +0x28c, +0x290): pitch and roll from the wheel heights. */
  private cartPitch = 0;
  private cartRoll = 0;
  private prevCartPitch = 0;
  private prevCartRoll = 0;
  private readonly wheelY = [0, 0, 0, 0];
  private readonly wheelFall = [0, 0, 0, 0];
  private wheelsPlaced = false;

  /** Shopping list (item types) and which entries are already in the cart. */
  list: number[] = [];
  found: boolean[] = [];
  /** Name shown on the HUD (the lobby name in a network race, else the character object). */
  displayName = '';
  /** Menu character index (custom characters after the originals); picks the HUD portrait. */
  character = 0;
  /** Item type carried in the hands, 0 = none (player struct +0x17c). */
  inHand = 0;
  /** Finishing position (1 = winner) once checked out at the goal. */
  finishedRank: number | null = null;
  /**
   * Varujakten quiz (0x40b510, mode 1): reaching a needed item asks a yes/no question and freezes the
   * player until it is answered. Right: the item is taken. Wrong: that item type is blocked
   * (+0x1d8) until the next right answer, as long as more than one item is still missing.
   */
  quiz: QuizQuestion | null = null;
  /**
   * Pause after taking an item (0x40b510 state 10): 24 ticks for a human (while the full-screen
   * allahN.tga picture shows), (4 - difficulty) * 24 ticks for a computer player.
   */
  pickupPauseTicks = 24;
  /** Only the local player may eat the McDonald's burger (0x40ed10 skips it for AI players). */
  isHuman = false;
  /** Styrka (player +0x164). */
  strength = 3;
  /**
   * Burger energy (player +0x16c, the HUD bar): set to 100 when eating, drains by 1 every 5 ticks;
   * while above 0 the turn and throttle controls are multiplied by 1.3 (0x44b478, end of 0x40b510).
   */
  energy = 0;
  private energyTick = 0;
  /** Matkrig: any item scores (Cart_AddItem 0x40f1f0 mode 3), not only listed ones. */
  anyItemScores = false;
  /** Which shelf items may be taken (Matkrig: only the announced one); dropped items always can. */
  shelfFilter: ((type: number) => boolean) | null = null;
  /** Throws an item that is not close enough to the own cart (set by the level). */
  onThrow: ((p: Player, type: number, from: THREE.Vector3) => void) | null = null;
  pauseLeft = 0;
  private quizSpot: EventObject | null = null;
  blockedType = 0;
  private drawQuestion: (() => QuizQuestion | null) | null = null;
  /** Things that happened this tick, for sound/HUD; cleared by the consumer. */
  readonly events: PlayerEvent[] = [];
  private handMesh: THREE.Object3D | null = null;
  /** Ticks left of a one-shot animation (throw) before run/stand resumes. */
  private actionTicks = 0;
  private readonly cartItems = new THREE.Group();
  private shop: Shop | null = null;

  constructor(
    readonly name: string,
    readonly slot: number,
    model: THREE.Object3D,
    private readonly bones: THREE.Bone[],
    readonly anim: AnimPlayer,
    private readonly clips: { stand: AnimClip; run: AnimClip; throw?: AnimClip; oops?: AnimClip; winner?: AnimClip },
    private readonly params: MovementParams,
    readonly cart: CartRig | null,
  ) {
    this.object.add(model);
    this.object.rotation.order = 'YXZ';
    anim.play(clips.stand);
    // The cart's own origin sits yOffset below the holder (see the SPLASH placement).
    this.cartItems.position.y = -(cart?.yOffset ?? 0);
    cart?.object.add(this.cartItems);
  }

  get maxSpeed(): number {
    return (this.holdingCart ? this.params.accWC : this.params.acc) / (1 - this.frictionNow);
  }

  /**
   * Turn lean (0x40c800) [O]: while turning, node 1 gets the yaw 2L and node 2 the yaw L, with
   * L = 5600 * turn rate / top turn rate in int16 angle units (the pusher's or the walker's).
   */
  private leanIntoTurn(): void {
    if (this.turnInput === 0 || this.sliding || this.raceEnd) return;
    const racc = this.holdingCart ? this.params.rotateAccWC : this.params.rotateAcc;
    const top = racc / (1 - this.frictionNow);
    const lean = Math.trunc((LEAN * this.angVel) / top);
    for (const [node, k] of [[1, 2], [2, 1]] as const) {
      const bone = this.bones[node];
      if (!bone) continue;
      _euler.setFromQuaternion(bone.quaternion, 'YXZ');
      _euler.y = lean * k * ANGLE_TO_RAD;
      bone.quaternion.setFromEuler(_euler);
    }
  }

  /** Cart speed and turn rate for the rolling sound (pushed: +0x274/+0x284, free: +0x234/+0x244). */
  get cartMotion(): { speed: number; turn: number } {
    return this.holdingCart ? { speed: this.vel.length(), turn: this.angVel } : { speed: this.cartVel.length(), turn: this.cartAngVel };
  }

  /** Speed and turn friction: the master friction, averaged with the cart's while pushing. */
  private get frictionNow(): number {
    return this.holdingCart && this.cart ? (this.params.friction + this.cart.config.friction) / 2 : this.params.friction;
  }

  get speed(): number {
    return this.vel.length();
  }

  /**
   * Goal condition: enough items in the cart / checkpoints passed (player struct +0x180 counts
   * them; modes 1-2 need 10, Matkrig 5, Vagnrace every checkpoint).
   */
  collected = 0;
  required = 0;

  get allFound(): boolean {
    return this.required > 0 && this.collected >= this.required;
  }

  setShopping(shop: Shop, list: number[], drawQuestion: (() => QuizQuestion | null) | null = null, required = list.length): void {
    this.shop = shop;
    this.drawQuestion = drawQuestion;
    this.setList(list);
    this.required = required;
    this.collected = 0;
  }

  /** Replace the current list (Matkrig announcements, Vagnrace checkpoints). */
  setList(list: number[]): void {
    this.list = list;
    this.found = list.map(() => false);
  }

  spawn(x: number, y: number, z: number, heading: number, world: CollisionWorld | null): void {
    this.pos.set(x, y, z);
    const floor = world?.floorAt(x, z, y, 2000);
    if (floor !== null && floor !== undefined) this.pos.y = floor;
    this.heading = heading;
    this.prevPos.copy(this.pos);
    this.prevHeading = heading;
    this.vel.set(0, 0);
    this.angVel = 0;
    this.cartVel.set(0, 0);
    this.cartAngVel = 0;
    if (this.cart) {
      this.holdingCart = true;
      this.placeCartInFront();
      this.prevCartPos.copy(this.cartPos);
      this.prevCartHeading = this.cartHeading;
    }
  }

  private cartDistance(): number {
    return this.cart ? Math.hypot(this.cartPos.x - this.pos.x, this.cartPos.z - this.pos.z) : Infinity;
  }

  private placeCartInFront(): void {
    if (!this.cart) return;
    const d = this.cart.config.objectPos[2] ?? 750;
    this.cartHeading = this.heading;
    this.cartPos.set(this.pos.x + Math.sin(this.heading) * d, this.pos.y, this.pos.z + Math.cos(this.heading) * d);
  }

  // ---- actions (the original issues these as "action ..." console commands) ----

  canGrabCart(): boolean {
    return this.cartGrabbableBy(this);
  }

  /** Whether `by` may take this player's cart now (own cart, or another's with cart theft). */
  private cartGrabbableBy(by: Player): boolean {
    if (!this.cart || this.holdingCart || this.draggedBy) return false;
    if (by.holdingCart || by.dragging || by.inHand !== 0) return false;
    if (by !== this && !by.rules.grabCarts) return false;
    return Math.hypot(this.cartPos.x - by.pos.x, this.cartPos.z - by.pos.z) <= GRAB_CART_RANGE;
  }

  /** The cart "action grab cart" goes for: the own one, or with cart theft the nearest free one. */
  private grabTarget(): Player | null {
    if (!this.rules.grabCarts) return this.cartGrabbableBy(this) ? this : null;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const o of this.others.includes(this) ? this.others : [this, ...this.others]) {
      if (!o.cartGrabbableBy(this)) continue;
      const d = Math.hypot(o.cartPos.x - this.pos.x, o.cartPos.z - this.pos.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** "action grab cart" (state 3 of 0x40b510): start walking to the cart's handle. */
  grabCart(): boolean {
    const target = this.grabTarget();
    if (!target) return false;
    this.grabbing = true;
    this.grabTargetPlayer = target;
    return true;
  }

  /** Let go of a dragged (stolen) cart; it stays where it is. */
  stopDragging(): void {
    const t = this.dragging;
    if (!t) return;
    this.dragging = null;
    t.draggedBy = null;
    t.cartFall = 1;
  }

  /**
   * [I] Punch (unofficial rule): E / Ctrl, or Space when there is no cart to grab and no item to take
   * or throw. The throw animation plays; anyone
   * within PUNCH_RANGE in front (within PUNCH_ARC of the heading) is knocked back and stunned for
   * STUN_BASE + STUN_PER_STRENGTH * the puncher's Styrka ticks, and lets go of their cart or of
   * the cart they are dragging. PUNCH_COOLDOWN ticks between punches.
   */
  private punch(): void {
    if (!this.rules.punch || this.holdingCart || this.punchCooldown > 0) return;
    this.punchCooldown = PUNCH_COOLDOWN;
    if (this.clips.throw) {
      this.anim.play(this.clips.throw, true);
      this.anim.rate = 1;
      this.actionTicks = this.clips.throw.frames.length;
    }
    this.events.push('punch');
    for (const o of this.others) {
      if (o === this) continue;
      const dx = o.pos.x - this.pos.x, dz = o.pos.z - this.pos.z;
      if (Math.hypot(dx, dz) > PUNCH_RANGE || Math.abs(o.pos.y - this.pos.y) > 500) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - this.heading)) > PUNCH_ARC) continue;
      if (o.holdingCart) o.releaseCart();
      o.stopDragging();
      o.grabbing = false;
      const d = Math.hypot(dx, dz) || 1;
      o.knockback.set((dx / d) * PUNCH_KNOCKBACK, (dz / d) * PUNCH_KNOCKBACK);
      o.stunTicks = Math.max(o.stunTicks, STUN_BASE + STUN_PER_STRENGTH * this.strength);
      o.events.push('punched');
    }
  }

  /**
   * [I] Not in the original: a current pushes towards its anchor, which normally lies at or past
   * the far end of its area, so the walker leaves the area. If a wall or ledge stops the walker
   * inside the area instead, it would slide on the spot for ever with no control. So when a
   * sliding walker has moved less than SLIDE_STUCK_DISTANCE in SLIDE_STUCK_TICKS, the currents
   * let go of it for SLIDE_OFF_TICKS and it can walk out.
   */
  private slideStuck(): boolean {
    if (!this.sliding) {
      this.slideCheck.set(this.pos.x, this.pos.z);
      this.slideCheckTicks = 0;
      return false;
    }
    if (++this.slideCheckTicks < SLIDE_STUCK_TICKS) return false;
    const moved = Math.hypot(this.pos.x - this.slideCheck.x, this.pos.z - this.slideCheck.y);
    this.slideCheck.set(this.pos.x, this.pos.z);
    this.slideCheckTicks = 0;
    if (moved >= SLIDE_STUCK_DISTANCE) return false;
    this.slideOff = SLIDE_OFF_TICKS;
    return true;
  }

  /** Keep a dragged cart in front of the character; its walls push the character back too. */
  private dragCart(world: CollisionWorld): void {
    const t = this.dragging;
    if (!t || !t.cart) return;
    const d = t.cart.config.objectPos[2] ?? 750;
    t.prevCartPos.copy(t.cartPos);
    t.prevCartHeading = t.cartHeading;
    t.cartHeading = this.heading;
    t.cartPos.set(this.pos.x + Math.sin(this.heading) * d, this.pos.y, this.pos.z + Math.cos(this.heading) * d);
    t.cartVel.set(0, 0);
    t.cartAngVel = 0;
    const x = t.cartPos.x, z = t.cartPos.z;
    t.sweepWalls(world, true);
    this.pos.x += t.cartPos.x - x;
    this.pos.z += t.cartPos.z - z;
  }

  /**
   * Walking to the handle, every tick while grabbing (0x40e1d0) [O]: turn towards the cart until it
   * is within 0.1 rad of straight ahead, walk until within 1000, then swing the cart round (its turn
   * rate grows by the walker's rotate acceleration) until it points the way the character faces.
   * Then the cart is taken (0x40e5b0): the pushing body is placed at the character, keeping its
   * heading, speed and turn rate, so the cart comes to the character (never the other way round).
   */
  private grabStep(c: Controls): Controls {
    if (!this.grabbing) return c;
    const t = this.grabTargetPlayer ?? this;
    if (!t.cartGrabbableBy(this) || !t.cart) {
      this.grabbing = false;
      return c;
    }
    const a = Math.atan2(t.cartPos.x - this.pos.x, t.cartPos.z - this.pos.z);
    const diff = wrapAngle(a - this.heading);
    if (Math.abs(diff) > GRAB_FACING) return { turn: Math.sign(diff), throttle: 0, action: false };
    if (Math.hypot(t.cartPos.x - this.pos.x, t.cartPos.z - this.pos.z) > GRAB_REACH) return { turn: 0, throttle: 1, action: false };
    const swing = wrapAngle(a - t.cartHeading);
    if (Math.abs(swing) > Math.abs(t.cartAngVel)) {
      t.cartAngVel += Math.sign(swing) * this.params.rotateAcc;
      return { turn: 0, throttle: 0, action: false };
    }
    this.grabbing = false;
    if (t !== this) {
      // [I] Cart theft: drag the other player's cart.
      this.dragging = t;
      t.draggedBy = this;
      this.events.push('cart-grabbed');
      return { turn: 0, throttle: 0, action: false };
    }
    this.holdingCart = true;
    this.cartVel.set(0, 0);
    this.cartAngVel = 0;
    this.placeCartInFront();
    this.prevCartPos.copy(this.cartPos);
    this.prevCartHeading = this.cartHeading;
    this.events.push('cart-grabbed');
    return { turn: 0, throttle: 0, action: false };
  }

  /**
   * Player_BumpLoseCart (0x409b10), called by the collision response (0x405e10) for each side of a
   * contact between two players: while pushing a cart, the chance in percent to let go of it is
   * (attacker Styrka * 5 + 60 - own Styrka * 10) * 0.2.
   */
  bumpedBy(attacker: Player, rand: () => number = simRandom): void {
    if (!this.holdingCart) return;
    const chance = (attacker.strength * 5 + 60 - this.strength * 10) * 0.2;
    if (Math.floor(rand() * 100) < chance) this.releaseCart();
  }

  releaseCart(): void {
    if (!this.holdingCart) return;
    this.holdingCart = false;
    // Let the free cart settle onto the floor under its centre (it rode on its wheels while held).
    this.cartFall = 1;
    this.events.push('cart-released');
  }

  /** Whether this player may take an item from this spot at all (ignoring distance). */
  canTakeFrom(s: EventObject): boolean {
    if (s.type === BURGER_TYPE) return this.isHuman;
    if (s.type === this.blockedType) return false;
    if (this.shelfFilter && !this.shop?.isDropped(s) && !this.shelfFilter(s.type)) return false;
    return this.list.some((t, i) => t === s.type && !this.found[i]);
  }

  /** The nearest spot of an item still needed from this player's list, within pickup range. */
  pickupSpot(): EventObject | null {
    if (!this.shop || this.holdingCart || this.inHand !== 0) return null;
    let best: EventObject | null = null;
    let bestD = PICKUP_RANGE;
    for (const s of this.shop.spots) {
      if (Math.abs(s.y - this.pos.y) >= PICKUP_HEIGHT || !this.canTakeFrom(s)) continue;
      const d = Math.hypot(s.x - this.pos.x, s.z - this.pos.z);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Reach for an item: starts the quiz when one is configured, otherwise takes it directly. */
  getItem(): boolean {
    if (this.quiz) return false;
    const spot = this.pickupSpot();
    if (!spot) return false;
    const question = spot.type === BURGER_TYPE ? null : this.drawQuestion?.() ?? null;
    if (question) {
      this.quiz = question;
      this.quizSpot = spot;
      this.vel.set(0, 0);
      this.events.push('quiz-start');
      return false;
    }
    this.takeItem(spot);
    return true;
  }

  /** Answer the pending question (true = "J"). */
  answerQuiz(yes: boolean): void {
    const q = this.quiz, spot = this.quizSpot;
    if (!q || !spot) return;
    this.quiz = null;
    this.quizSpot = null;
    if (yes === q.answer) {
      this.blockedType = 0;
      this.events.push('quiz-right');
      this.takeItem(spot);
    } else {
      this.events.push('quiz-wrong');
      if (this.required - this.collected > 1) this.blockedType = spot.type;
    }
  }

  private takeItem(spot: EventObject): void {
    if (this.shop?.isDropped(spot)) this.shop.removeDropped(spot);
    if (spot.type === BURGER_TYPE) {
      // Eaten on the spot (0x40b510 case 6): full energy and the mall's jingle.
      this.energy = 100;
      this.energyTick = 0;
      this.pauseLeft = this.pickupPauseTicks;
      this.events.push('burger');
      return;
    }
    this.inHand = spot.type;
    this.pauseLeft = this.pickupPauseTicks;
    this.events.push('item-picked');
    this.handMesh = this.shop?.createItem(spot.type) ?? null;
    if (this.handMesh) {
      this.handMesh.position.set(0, HOLD_OFFSET, 0);
      (this.bones[HOLD_NODE] ?? this.object).add(this.handMesh);
    }
  }

  /**
   * Checkout (RaceStart_Tick 0x40c450): the KUNDKORT customer card appears in the right hand
   * (node 8) at (0, 150, 0), turned 32000 about x. [O]
   */
  holdCard(card: THREE.Object3D): void {
    card.position.set(0, 150, 0);
    card.rotation.set(32000 * ANGLE_TO_RAD, 0, 0, 'YXZ');
    (this.bones[HOLD_NODE] ?? this.object).add(card);
  }

  /** Whether an item landing in this player's cart counts (Cart_AddItem 0x40f1f0). */
  acceptsItem(type: number): boolean {
    if (this.finishedRank !== null) return false;
    return this.anyItemScores || this.list.some((t, i) => t === type && !this.found[i]);
  }

  /**
   * Put an item into this player's cart (by hand or caught from the air). Cart_AddItem (0x40f1f0)
   * [O] moves the item's own mesh onto the cart at (rand%250-125, -500, rand%500-250), turned
   * (rand%32000, rand%3200, rand%32000); in modes 1-2 it is deleted instead once three listed
   * items are already found (Matkrig keeps them all). The placement is cosmetic, so it does not use
   * the lockstep random numbers.
   */
  receiveItem(type: number, mesh: THREE.Object3D | null = null): void {
    const shownBefore = this.found.filter(Boolean).length;
    const idx = this.list.findIndex((t, i) => t === type && !this.found[i]);
    if (idx >= 0) this.found[idx] = true;
    this.collected++;
    this.events.push('item-in-cart');
    if (!this.anyItemScores && shownBefore >= CART_ITEMS_SHOWN) {
      mesh?.removeFromParent();
      return;
    }
    mesh ??= this.shop?.createItem(type) ?? null;
    if (!mesh) return;
    const r = (n: number) => Math.floor(Math.random() * n);
    mesh.removeFromParent();
    mesh.scale.setScalar(1);
    mesh.position.set(r(250) - 125, -500, r(500) - 250);
    mesh.rotation.set(r(32000) * ANGLE_TO_RAD, r(3200) * ANGLE_TO_RAD, r(32000) * ANGLE_TO_RAD, 'YXZ');
    this.cartItems.add(mesh);
  }

  /**
   * Drop the carried item (0x40b510 case 3): within 1300 units of the own cart it goes in;
   * otherwise it is thrown along the heading (sound 21) and may land in any cart or on the floor.
   */
  dropItem(): boolean {
    if (this.inHand === 0) return false;
    const type = this.inHand;
    if (this.cartDistance() <= DROP_RANGE && this.acceptsItem(type)) {
      // Item_ThrowCheck (0x40f420): the carried mesh goes straight onto the cart (sound 22).
      this.receiveItem(type, this.handMesh);
      this.handMesh = null;
    } else if (this.onThrow) {
      const from = new THREE.Vector3(this.pos.x, this.pos.y - 1000, this.pos.z);
      this.onThrow(this, type, from);
      this.events.push('item-thrown');
    } else {
      this.events.push('item-dropped');
    }
    // Either way the throw animation plays (state 4 with +0x2bc).
    if (this.clips.throw) {
      this.anim.play(this.clips.throw, true);
      this.actionTicks = this.clips.throw.frames.length;
    }
    this.handMesh?.removeFromParent();
    this.handMesh = null;
    this.inHand = 0;
    return true;
  }

  /** One-button play ("action smart"): release / drop / pick up / grab, whichever applies. */
  smartAction(): void {
    if (this.grabbing) this.grabbing = false;
    else if (this.dragging) this.stopDragging();
    else if (this.holdingCart) this.releaseCart();
    else if (this.inHand !== 0) this.dropItem();
    else if (this.pickupSpot()) this.getItem();
    // [I] Punch rule: Space with nothing else to do punches.
    else if (!this.grabCart()) this.punch();
  }

  private runCommand(c: Controls): void {
    switch (c.command) {
      case 'grab cart':
        this.grabCart();
        break;
      case 'release cart':
        this.releaseCart();
        break;
      case 'get item':
        this.getItem();
        break;
      case 'drop item':
        this.dropItem();
        break;
    }
    if (c.answer !== undefined) this.answerQuiz(c.answer);
    else if (c.action && !this.quiz) this.smartAction();
  }

  tick(c: Controls, world: CollisionWorld): void {
    this.prevPos.copy(this.pos);
    this.prevHeading = this.heading;
    this.prevCartPos.copy(this.cartPos);
    this.prevCartHeading = this.cartHeading;

    if (this.stunTicks > 0) {
      // Stunned by a punch: the controls do nothing while the knockback slides out.
      this.stunTicks--;
      c = { turn: 0, throttle: 0, action: false };
    }
    this.runCommand(c);
    c = this.grabStep(c);
    if (this.punchCooldown > 0) this.punchCooldown--;
    if (c.punch) this.punch();

    const p = this.params;
    if (this.energy > 0) {
      if (++this.energyTick % 5 === 0) this.energy--;
      c = { ...c, turn: c.turn * 1.3, throttle: c.throttle * 1.3 };
    }
    if (this.pauseLeft > 0) this.pauseLeft--;
    if (this.quiz || this.pauseLeft > 0) {
      // Frozen while the question is open / after a pickup (velocities zeroed in 0x40b510).
      c = { turn: 0, throttle: 0, action: false };
      this.vel.set(0, 0);
      this.angVel = 0;
    }
    this.tickCount++;
    this.turnInput = c.turn;
    this.throttleInput = c.throttle;
    const t = this.triggers;
    if (this.holdingCart && this.tickCount % 5 === 0 && (triggerAt(t.mvnc, this.pos) || triggerAt(t.mvnc, this.cartPos))) this.releaseCart();
    const acc = this.holdingCart ? p.accWC : p.acc;
    const racc = this.holdingCart ? p.rotateAccWC : p.rotateAcc;
    // Walker 0x426fd0 / pushing 0x4280b0 [O]:
    //   turn rate = racc * turn + friction * turn rate; heading += turn rate
    //   velocity  = velocity * friction + acc * throttle along the heading
    // While pushing, both frictions are (master + cart friction) / 2 (0x410e90), and turning adds
    // acc * throttle / 2 towards heading - throttle * turn * pi (a brake while turning at speed).
    const friction = this.frictionNow;
    this.angVel = racc * c.turn + friction * this.angVel;
    this.heading += this.angVel;
    const throttle = c.throttle;
    this.vel.multiplyScalar(friction);
    this.vel.x += Math.sin(this.heading) * acc * throttle;
    this.vel.y += Math.cos(this.heading) * acc * throttle;
    if (this.holdingCart && c.turn !== 0) {
      const a = this.heading - throttle * c.turn * Math.PI;
      this.vel.x += Math.sin(a) * acc * throttle * 0.5;
      this.vel.y += Math.cos(a) * acc * throttle * 0.5;
    }
    this.prevSplashAngle = this.splashAngle;
    let current: EventObject | null = null;
    if (t.water) {
      if (this.slideOff > 0) this.slideOff--;
      current = this.slideOff > 0 ? null : triggerAt(t.mvnc, this.pos);
      if (current && this.slideStuck()) current = null;
      if (current) {
        if (!this.sliding || Math.random() < 0.05) this.events.push('splash');
        towards(this.vel, this.pos, current, SLIDE_SPEED);
        this.angVel = SLIDE_SPIN;
        this.splashAngle += SPLASH_SPIN;
      }
    } else if (!this.holdingCart) {
      const wasLaunched = this.launched;
      this.launched = false;
      if (triggerAt(t.mvnc, this.pos)) {
        if (!wasLaunched) this.events.push('launch');
        this.vel.set(0, 0);
        this.angVel = SLIDE_SPIN;
        this.fallSpeed = -LAUNCH_SPEED;
        this.launched = true;
      }
      const hurl = triggerAt(t.hurl, this.pos);
      if (hurl) {
        towards(this.vel, this.pos, hurl, HURL_SPEED);
        this.angVel = SLIDE_SPIN;
      }
    }
    this.sliding = current !== null;
    if (!t.water) {
      const tele = triggerAt(t.tele, this.pos);
      if (tele) this.teleport(tele, world);
    }

    this.pos.x += this.vel.x + this.knockback.x;
    this.pos.z += this.vel.y + this.knockback.y;
    this.knockback.multiplyScalar(KNOCKBACK_DECAY);
    if (this.knockback.lengthSq() < 1) this.knockback.set(0, 0);
    if (this.holdingCart && this.cart) this.placeCartInFront();
    // The floor-region edges stop the walker or the pushing body (character plus cart parts).
    this.sweepWalls(world, false);
    this.dragCart(world);

    let floor = world.floorAt(this.pos.x, this.pos.z, this.pos.y);
    if (floor === null) {
      // [I] Safety net: still off every floor after the edge walls (e.g. a gap between regions);
      // keep whichever axis of the move has floor, else refuse the move.
      const tryX = world.floorAt(this.pos.x, this.prevPos.z, this.pos.y);
      const tryZ = tryX === null ? world.floorAt(this.prevPos.x, this.pos.z, this.pos.y) : null;
      const dx = this.pos.x - this.prevPos.x, dz = this.pos.z - this.prevPos.z;
      if (tryX !== null) {
        this.pos.z = this.prevPos.z;
        this.vel.set(dx, 0);
        if (this.holdingCart) this.cartPos.z -= dz;
      } else if (tryZ !== null) {
        this.pos.x = this.prevPos.x;
        this.vel.set(0, dz);
        if (this.holdingCart) this.cartPos.x -= dx;
      } else {
        if (this.holdingCart) {
          this.cartPos.x -= dx;
          this.cartPos.z -= dz;
        }
        this.pos.x = this.prevPos.x;
        this.pos.z = this.prevPos.z;
        this.vel.set(0, 0);
      }
      floor = world.floorAt(this.pos.x, this.pos.z, this.pos.y); // the surface we stay on
    } else if (floor > this.pos.y + 5) {
      this.fallSpeed += GRAVITY;
      this.pos.y = Math.min(floor, this.pos.y + this.fallSpeed);
    } else if (this.fallSpeed < 0) {
      this.pos.y += this.fallSpeed; // launched off the floor
    } else {
      this.fallSpeed = 0;
      this.pos.y = floor;
    }
    if (this.holdingCart) {
      this.placeCartInFront();
      this.cartPos.y = this.pos.y;
      this.cartSliding = false;
    } else if (this.cart) this.tickFreeCart(world, this.cart.config.friction);
    if (this.cart) this.tiltCart(world);
    // A pushed cart rides on its wheels (they follow the floor under each corner), not at the
    // character's height: on a ramp it is 750 further up the slope.
    if (this.holdingCart && this.cart) this.cartPos.y = (this.wheelY[0] + this.wheelY[1] + this.wheelY[2] + this.wheelY[3]) / 4;

    if (this.raceEnd) {
      // 0x40c800 once the race is over: the winner plays s_winner.anm, everyone else stands. Both
      // step only every second tick (DAT_00458954 toggles; the winner blends halfway, 0x4347c0, on
      // the other ticks), and the hands leave the handle (no IK in this branch).
      this.anim.play(this.raceEnd === 'winner' && this.clips.winner ? this.clips.winner : this.clips.stand);
      this.anim.rate = 0.5;
    } else if (this.actionTicks > 0) {
      this.actionTicks--;
    } else if ((this.sliding || this.stunTicks > 0) && this.clips.oops) {
      this.anim.play(this.clips.oops);
      this.anim.rate = 1;
    } else if (this.throttleInput !== 0) {
      // 0x40c800 [O]: while the throttle is held the run animation advances one frame per tick,
      // whatever the speed; without it the run animation is reset and the stand plays.
      this.anim.play(this.clips.run);
      this.anim.rate = 1;
    } else {
      // The stand animation steps every second tick (DAT_00458954 toggles in 0x40c800).
      this.anim.play(this.clips.stand);
      this.anim.rate = 0.5;
    }
  }

  /**
   * Cart tilt [O] (end of 0x4280b0, same for the free cart): each corner part keeps its own height,
   * falling with gravity onto the floor under it (bouncing at -0.75 when it lands fast) and never
   * hanging more than 300 below the highest corner. Then
   *   pitch (rx) = -atan2(front - back, 1200), roll (rz) = atan2(right - left, 860)
   * from the sums of the corner heights (engine Y is down).
   */
  private tiltCart(world: CollisionWorld): void {
    this.prevCartPitch = this.cartPitch;
    this.prevCartRoll = this.cartRoll;
    const h = this.cartHeading;
    const cos = Math.cos(h), sin = Math.sin(h);
    const y = this.wheelY;
    CART_WHEELS.forEach(([z, x], i) => {
      const wz = this.cartPos.z + z * cos - x * sin;
      const wx = this.cartPos.x + z * sin + x * cos;
      const floor = world.floorAt(wx, wz, this.cartPos.y) ?? this.cartPos.y;
      if (!this.wheelsPlaced) {
        y[i] = floor;
        this.wheelFall[i] = 0;
        return;
      }
      if (floor <= y[i]) {
        // On or under the floor: settle, or bounce when arriving fast.
        if (this.wheelFall[i] < GRAVITY) {
          this.wheelFall[i] = 0;
          y[i] = floor;
        } else {
          this.wheelFall[i] *= WHEEL_BOUNCE;
          y[i] += this.wheelFall[i];
        }
      } else {
        this.wheelFall[i] += GRAVITY;
        y[i] += this.wheelFall[i];
        if (floor <= y[i]) {
          this.wheelFall[i] -= y[i] - floor;
          y[i] = floor;
        }
      }
    });
    this.wheelsPlaced = true;
    const highest = Math.min(...y) + WHEEL_DROP;
    for (let i = 0; i < 4; i++) {
      if (y[i] > highest) {
        y[i] = highest;
        this.wheelFall[i] = 0;
      }
    }
    this.cartPitch = -Math.atan2(y[3] + y[2] - y[1] - y[0], 1200);
    this.cartRoll = Math.atan2(y[3] + y[1] - y[2] - y[0], 860);
  }

  private tickFreeCart(world: CollisionWorld, friction: number): void {
    // A stolen cart is moved by the player dragging it.
    if (this.draggedBy) return;
    this.cartVel.multiplyScalar(friction);
    this.cartAngVel *= friction;
    // 0x427730: a free cart within 1100 of its own player stops.
    if (this.cartDistance() < 1100) this.cartVel.set(0, 0);
    const t = this.triggers;
    this.prevCartSplashAngle = this.cartSplashAngle;
    let current: EventObject | null = null;
    let moved = false;
    if (t.water) {
      current = triggerAt(t.mvnc, this.cartPos);
      if (current) {
        towards(this.cartVel, this.cartPos, current, CART_SLIDE_SPEED);
        this.cartAngVel = CART_SLIDE_SPIN;
        this.cartSplashAngle += SPLASH_SPIN;
      }
    } else {
      const wasLaunched = this.cartLaunched;
      this.cartLaunched = false;
      if (triggerAt(t.mvnc, this.cartPos)) {
        if (!wasLaunched) this.events.push('cart-launch');
        this.cartVel.set(0, 0);
        this.cartAngVel = SLIDE_SPIN;
        this.cartPos.y -= CART_LAUNCH_SPEED;
        this.cartFall = -CART_LAUNCH_SPEED;
        this.cartLaunched = moved = true;
      }
      const hurl = triggerAt(t.hurl, this.cartPos);
      if (hurl) {
        towards(this.cartVel, this.cartPos, hurl, CART_HURL_SPEED);
        this.cartAngVel = CART_SLIDE_SPIN;
      }
      const tele = triggerAt(t.tele, this.cartPos);
      if (tele) {
        this.placeAt(this.cartPos, tele, world);
        this.cartHeading += tele.values[1] * ANGLE;
        this.prevCartPos.copy(this.cartPos);
        this.prevCartHeading = this.cartHeading;
        moved = true;
      }
    }
    this.cartSliding = current !== null;
    if (!current && !moved && this.cartVel.lengthSq() < 1 && Math.abs(this.cartAngVel) < 1e-3 && this.cartFall === 0) return;
    this.cartHeading += this.cartAngVel;
    const from = this.cartPos.clone();
    this.cartPos.x += this.cartVel.x;
    this.cartPos.z += this.cartVel.y;
    this.sweepWalls(world, true);
    const floor = world.floorAt(this.cartPos.x, this.cartPos.z, this.cartPos.y);
    if (floor === null) {
      this.cartPos.copy(from);
      this.cartVel.set(0, 0);
    } else if (floor > this.cartPos.y + 5) {
      this.cartFall += GRAVITY;
      this.cartPos.y = Math.min(floor, this.cartPos.y + this.cartFall);
    } else if (this.cartFall < 0) {
      this.cartPos.y += this.cartFall;
    } else {
      this.cartFall = 0;
      this.cartPos.y = floor;
    }
  }

  /** Body position after a teleport: the anchor at height v0, on a floor within 1000 of it (0x404e00). */
  private placeAt(out: THREE.Vector3, tele: EventObject, world: CollisionWorld): void {
    const y = tele.values[0] ?? 0;
    out.set(tele.x, y, tele.z);
    const floor = world.floorAt(tele.x, tele.z, y, 1000);
    if (floor !== null && floor <= y + 1000) out.y = floor;
  }

  /** tele: jump to the anchor, turned by v1, keeping the velocity; a pushed cart comes along. */
  private teleport(tele: EventObject, world: CollisionWorld): void {
    this.placeAt(this.pos, tele, world);
    this.heading += tele.values[1] * ANGLE;
    this.prevPos.copy(this.pos);
    this.prevHeading = this.heading;
    this.fallSpeed = 0;
    if (this.holdingCart) {
      this.placeCartInFront();
      this.prevCartPos.copy(this.cartPos);
      this.prevCartHeading = this.cartHeading;
    }
    this.teleports++;
  }

  render(alpha: number, frameTicks: number): void {
    this.object.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.object.rotation.y = lerpAngle(this.prevHeading, this.heading, alpha);
    if (this.splash) {
      this.splash.visible = this.sliding && this.showSplash;
      this.splash.rotation.y = this.prevSplashAngle + (this.splashAngle - this.prevSplashAngle) * alpha;
    }
    this.anim.advance(frameTicks);
    this.anim.apply();
    this.leanIntoTurn();
    if (this.cart) {
      const o = this.cart.object;
      o.position.lerpVectors(this.prevCartPos, this.cartPos, alpha);
      o.position.y += this.cart.yOffset;
      const pitch = this.prevCartPitch + (this.cartPitch - this.prevCartPitch) * alpha;
      const roll = this.prevCartRoll + (this.cartRoll - this.prevCartRoll) * alpha;
      o.rotation.set(pitch, lerpAngle(this.prevCartHeading, this.cartHeading, alpha), roll, 'YXZ');
      // The hands hold the handle helpers on the (tilted) cart.
      if (this.holdingCart && !this.raceEnd) this.holdHandles(this.cart);
      if (this.cartSplash) {
        this.cartSplash.visible = this.cartSliding && this.showSplash;
        this.cartSplash.rotation.y = this.prevCartSplashAngle + (this.cartSplashAngle - this.prevCartSplashAngle) * alpha;
        this.cartSplash.position.y = -1200 - this.cart.yOffset;
      }
    }
    // [I] Cart theft: the hands hold the dragged cart's handle.
    if (this.dragging?.cart && !this.raceEnd) {
      this.dragging.cart.object.updateMatrixWorld(true);
      this.holdHandles(this.dragging.cart);
    }
  }

  /**
   * [I] Put the hands on the cart handle: objects/carts[n]/handle_pos gives the two handle points
   * relative to the cart ({ +-260 -1030 -400 }); the original stores them on per-cart helper objects
   * (LoadPlayerConfig 0x411b70). Here a two-bone IK per arm reaches for them after the animation.
   */
  private holdHandles(cart: CartRig): void {
    const h = cart.config.handlePos;
    if (h.length < 6) return;
    this.object.updateMatrixWorld(true);
    cart.object.updateMatrixWorld(true);
    for (const arm of ARMS) {
      const [s, e, w] = arm.chain.map((i) => this.bones[i]);
      if (!s || !e || !w) return;
      // Pick the handle on the same side as the shoulder.
      const hx = Math.sign(h[0]) === arm.side ? h[0] : h[3];
      const hi = hx === h[0] ? 0 : 3;
      // handle_pos is relative to the cart's origin, which sits yOffset below the holder.
      cart.object.localToWorld(_target.set(hx, h[hi + 1] - cart.yOffset, h[hi + 2]));
      // Elbows bend outwards, down and back.
      this.object.localToWorld(_pole.set(arm.side * 700, -900, -300));
      solveTwoBone(s, e, w, _target, _pole);
    }
  }

  /**
   * Floor-edge walls (0x405680 -> 0x4035e0) for the walker / pushing body (cart = false) or the free
   * cart: every part is swept from its previous to its current position; the fastest bounce wins
   * and is applied like a collision contact (position, velocity, spin).
   */
  sweepWalls(world: CollisionWorld, cart: boolean): void {
    for (const b of this.physBodies()) {
      if (b.cart !== cart) continue;
      const c = Math.cos(b.heading), s = Math.sin(b.heading);
      const pc = Math.cos(b.prevHeading), ps = Math.sin(b.prevHeading);
      let best: { x: number; z: number; speed: number; angle: number; spin: number } | null = null;
      for (const part of b.parts) {
        const oz = part.z * c - part.x * s, ox = part.z * s + part.x * c;
        const pz = part.z * pc - part.x * ps, px = part.z * ps + part.x * pc;
        const step = part.r === WALKER_RADIUS ? WALKER_STEP : CART_STEP;
        const hit = world.floorEdges.sweep(b.px + px, b.pz + pz, b.x + ox, b.z + oz, part.r, b.y, step);
        if (!hit || (best && hit.speed <= best.speed)) continue;
        const x = hit.x - ox, z = hit.z - oz;
        // Spin kick: (cut point - new body position) . edge direction * speed * 1.5e-6.
        const spin = ((hit.x - hit.speed * Math.sin(hit.angle) - x) * hit.ex + (hit.z - hit.speed * Math.cos(hit.angle) - z) * hit.ez) * hit.speed * 1.5e-6;
        best = { x, z, speed: hit.speed, angle: hit.angle, spin };
      }
      if (best) this.applyPhys(b.cart, best.z, best.x, best.speed, best.angle, best.spin);
    }
  }

  /** The active PhysWorld bodies: pushing while the cart is held, else walker and free cart. */
  physBodies(): PhysBody[] {
    const walker: PhysPart = { z: 0, x: 0, r: WALKER_RADIUS, m: this.strength * 25 + 90 };
    const body = (cart: boolean, at: THREE.Vector3, prev: THREE.Vector3, h: number, ph: number, v: THREE.Vector2, parts: PhysPart[]): PhysBody => ({
      owner: this,
      cart,
      z: at.z,
      x: at.x,
      pz: prev.z,
      px: prev.x,
      heading: h,
      prevHeading: ph,
      y: at.y,
      speed: v.length(),
      angle: Math.atan2(v.x, v.y),
      parts,
    });
    if (this.holdingCart && this.cart) {
      const m = this.strength * 25 + 75;
      const cart = CART_PARTS.map(([z, x, r]) => ({ z: z + HELD_CART_Z, x, r: r === 20 ? HELD_CORNER_RADIUS : r, m }));
      return [body(false, this.pos, this.prevPos, this.heading, this.prevHeading, this.vel, [walker, ...cart])];
    }
    const out = [body(false, this.pos, this.prevPos, this.heading, this.prevHeading, this.vel, [walker])];
    if (this.cart) {
      const parts = CART_PARTS.map(([z, x, r]) => ({ z, x, r, m: 75 }));
      out.push(body(true, this.cartPos, this.prevCartPos, this.cartHeading, this.prevCartHeading, this.cartVel, parts));
    }
    return out;
  }

  /**
   * The collision response for one body: new position (z, x), velocity (speed, direction) and a
   * spin kick. The post-physics sync (0x428a70 for the pushing body) copies the body's speed back,
   * clamped to +-top speed, takes its direction after a contact, and adds the spin to the turn
   * rate, clamped to +-the top turn rate.
   */
  applyPhys(cart: boolean, z: number, x: number, speed: number, angle: number, spin: number): void {
    const s = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, speed));
    if (cart) {
      this.cartPos.x = x;
      this.cartPos.z = z;
      this.cartVel.set(Math.sin(angle) * s, Math.cos(angle) * s);
      return;
    }
    const dx = x - this.pos.x, dz = z - this.pos.z;
    this.pos.x = x;
    this.pos.z = z;
    this.vel.set(Math.sin(angle) * s, Math.cos(angle) * s);
    const racc = this.holdingCart ? this.params.rotateAccWC : this.params.rotateAcc;
    const maxTurn = racc / (1 - this.frictionNow);
    this.angVel = Math.max(-maxTurn, Math.min(maxTurn, this.angVel + spin));
    if (this.holdingCart) {
      this.cartPos.x += dx;
      this.cartPos.z += dz;
    }
  }

  /** Interpolated feet position/heading for the camera. */
  interpolated(alpha: number, out: THREE.Vector3): number {
    out.lerpVectors(this.prevPos, this.pos, alpha);
    return lerpAngle(this.prevHeading, this.heading, alpha);
  }
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** An angle wrapped to -pi..pi. */
function wrapAngle(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
