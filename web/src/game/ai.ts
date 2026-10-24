import { simRandom } from './random';
import type { Controls, PlayerCommand } from './input';
import type { NavGraph, NavNode } from './navGraph';
import type { Player } from './player';
import type { Shop } from './shopping';
import type { EventObject } from './events';
import { GameMode, type ModeRules } from './modes';

/**
 * Computer opponent, ported from the AI in maniac.exe:
 *   Ai_Update 0x401160 (state machine), Ai_ChooseTarget 0x4015c0, Ai_Navigate 0x401800,
 *   Ai_Steer 0x401ae0, Ai_GoToCart 0x401e40, Ai_GrabObject 0x401eb0, Ai_PutInCart 0x401fb0,
 *   Ai_GoToGoal 0x402060. Constants are the floats/doubles at 0x44b23c..0x44b2b4.
 * Each AI thinks every 4th tick (two players per tick, Ai_TickAll 0x4010e0) and replays its last
 * turn/throttle in between.
 */
export enum AiMode {
  SetTargetItem = 0,
  GotoItem = 1,
  GotoRandItem = 2,
  GrabObject = 3,
  PutObjectInCart = 4,
  ReleaseCart = 5,
  GrabCart = 6,
  Goal = 7,
  /** Port-specific: Vagnrace driving to the next checkpoint (the original uses a separate branch). */
  Checkpoint = 8,
  End = 9,
}

/** AI speed factor per difficulty (table at 0x44b230). */
export const AI_SPEED = [0.72, 0.84, 0.96] as const;
/**
 * [I] Quiz accuracy per difficulty. The original never writes an AI answer (only mm_key 0x40db80
 * sets +0x1e0), so how computer players get past the question is not decoded.
 */
export const AI_QUIZ_ACCURACY = [0.6, 0.75, 0.9] as const;
const AI_QUIZ_THINK_MS = 1500;

const ARRIVE_SQ = 1210000; // 1100^2
const WAYPOINT_LOOKAHEAD = 800;
const WAYPOINT_REACHED = 700;
const WAYPOINT_REACHED_SQ = 490000; // 700^2
const SLOWDOWN_DIST = 2000;
const NEAR_DIST = 1100;
const STUCK_MOVE_SQ = 2250000; // 1500^2
const STUCK_MS = 875; // 0x36b
const NAV_BELOW = 1000; // buoy height window: y-400 .. y+1000 (engine Y is down)
const NAV_ABOVE = 400;
/** The held cart sits this far ahead of the character (carts[n].object_pos z). */
const CART_REACH = 750;

interface Point {
  x: number;
  z: number;
  y: number;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export class AiController {
  mode = AiMode.SetTargetItem;
  private curNode: NavNode | null = null;
  private destNode: NavNode | null = null;
  private waypoint: NavNode | null = null;
  private arrivedFinal = false; // +0x50
  private replan = false; // +0x51
  /** Vagnrace: use the buoys instead of driving straight at the checkpoint (+0x52). */
  private useBuoys = false;
  private seenTeleports = 0;
  private target: Point = { x: 0, z: 0, y: 0 };
  private targetSpot: EventObject | null = null;
  private stuckMs = 0;
  private checkpoint = { x: 0, z: 0 };
  private turn = 0;
  private throttle = 0;
  private command: PlayerCommand | undefined;
  private answer: boolean | undefined;
  private quizMs = 0;

  constructor(
    readonly player: Player,
    private readonly nav: NavGraph,
    private readonly shop: Shop,
    private readonly speed: number,
    private readonly tickMs: number,
    private readonly rules: ModeRules,
    private readonly quizAccuracy = 0.75,
    private readonly random: () => number = simRandom,
  ) {}

  /** Controls for this tick: a full think when `think` is set, otherwise the cached values. */
  controls(think: boolean): Controls {
    if (think) this.update();
    const command = this.command;
    const answer = this.answer;
    this.command = undefined;
    this.answer = undefined;
    return { turn: this.turn, throttle: this.throttle, action: false, command, answer };
  }

  private get pos(): Point {
    return { x: this.player.pos.x, z: this.player.pos.z, y: this.player.pos.y };
  }

  private get cart(): Point {
    const c = this.player.cartPos;
    return { x: c.x, z: c.z, y: c.y };
  }

  private update(): void {
    const p = this.player;
    this.turn = 0;
    this.throttle = 0;
    if (p.teleports !== this.seenTeleports) {
      // A tele trigger moved us (0x4020c0): plan the route again from here.
      this.seenTeleports = p.teleports;
      this.replan = true;
    }
    this.curNode = this.nav.nearest(p.pos.x, p.pos.z, p.pos.y - NAV_ABOVE, p.pos.y + NAV_BELOW);
    if (p.finishedRank !== null) {
      this.mode = AiMode.End;
      return;
    }
    if (p.quiz) {
      // Think, then answer (AI updates arrive every 4th tick).
      this.quizMs += this.tickMs * 4;
      if (this.quizMs >= AI_QUIZ_THINK_MS) {
        this.quizMs = 0;
        this.answer = this.random() < this.quizAccuracy ? p.quiz.answer : !p.quiz.answer;
      }
      return;
    }
    this.quizMs = 0;
    const wanted = this.shop.spots.some((s) => p.canTakeFrom(s));
    if (this.rules.mode === GameMode.Matkrig && !wanted && p.inHand === 0 && !p.allFound) {
      // The announced item was claimed by someone else (DAT_00458128 = 0): back to wandering.
      if (this.mode === AiMode.GotoItem || this.mode === AiMode.ReleaseCart || this.mode === AiMode.GrabObject) {
        this.mode = AiMode.GrabCart;
      }
    }
    switch (this.mode) {
      case AiMode.SetTargetItem:
        if (p.allFound) this.mode = AiMode.Goal;
        else if (this.rules.mode === GameMode.Vagnrace) this.mode = AiMode.Checkpoint;
        else if (this.chooseTarget()) this.mode = AiMode.GotoItem;
        else if (this.rules.mode === GameMode.Matkrig) this.chooseRandomTarget();
        else this.mode = AiMode.Goal;
        return;
      case AiMode.GotoRandItem:
        // Matkrig before an item is announced (0x401160 case 2): roam with the cart.
        if (p.allFound || wanted) {
          this.mode = AiMode.SetTargetItem;
          return;
        }
        if (!p.holdingCart) return this.goToCart();
        if (this.navigate(this.cart, this.target) !== 0) this.chooseRandomTarget();
        return;
      case AiMode.Checkpoint: {
        // 0x401160 mode 4 [O]: drive the cart straight at the next checkpoint (0x401ae0); once the
        // stuck detector asks for a re-plan (or right after grabbing the cart) follow the buoys
        // until the final buoy is reached, then drive straight again.
        if (!p.holdingCart) {
          this.goToCart();
          if (this.replan) this.useBuoys = true;
          return;
        }
        const c = this.rules.nextCheckpoint(p);
        if (!c) {
          this.mode = AiMode.Goal;
          return;
        }
        const target = { x: c.x, z: c.z, y: c.y };
        if (this.useBuoys) {
          const r = this.navigate(this.cart, target);
          if (r === 1 || r === 2) this.useBuoys = false;
          return;
        }
        this.steer(this.cart, target);
        if (this.replan) this.useBuoys = true;
        return;
      }
      case AiMode.GotoItem:
        if (!p.holdingCart) return this.goToCart();
        {
          const r = this.navigate(this.cart, this.target);
          if (r === 1 || r === 2) this.mode = AiMode.ReleaseCart;
        }
        return;
      case AiMode.ReleaseCart:
        if (p.holdingCart) this.command = 'release cart';
        else this.mode = AiMode.GrabObject;
        return;
      case AiMode.GrabObject:
        if (this.targetSpot && p.inHand === 0 && (!this.shop.spots.includes(this.targetSpot) || !p.canTakeFrom(this.targetSpot))) {
          // Blocked by a wrong answer, claimed by someone else, or a floor item already taken:
          // go back to the cart and pick another target.
          this.mode = AiMode.GrabCart;
          return;
        }
        if (this.grabObject()) this.mode = AiMode.PutObjectInCart;
        return;
      case AiMode.PutObjectInCart:
        if (this.putInCart()) this.mode = AiMode.GrabCart;
        return;
      case AiMode.GrabCart:
        if (!p.holdingCart) return this.goToCart();
        this.mode = AiMode.SetTargetItem;
        return;
      case AiMode.Goal:
        if (!p.holdingCart) return this.goToCart();
        this.goToGoal();
        return;
      default:
        return;
    }
  }

  /** A random buoy to roam to (NavBuoy_Random 0x425aa0). */
  private chooseRandomTarget(): void {
    const n = this.nav.nodes[Math.floor(this.random() * this.nav.nodes.length)];
    if (n) this.target = { x: n.x, z: n.z, y: n.y };
    this.replan = true;
    this.mode = AiMode.GotoRandItem;
  }

  /** Nearest still-needed item spot; the cart is driven to the buoy nearest that spot. */
  private chooseTarget(): boolean {
    const p = this.player;
    let best: EventObject | null = null;
    let bestD = Infinity;
    p.list.forEach((type, i) => {
      if (p.found[i] || type <= 0 || type === p.blockedType) return;
      for (const s of this.shop.spotsOf(type)) {
        if (!p.canTakeFrom(s)) continue;
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    });
    if (!best) return false;
    const spot: EventObject = best;
    this.targetSpot = spot;
    const node = this.nav.nearest(spot.x, spot.z, spot.y - NAV_ABOVE, spot.y + NAV_BELOW);
    this.target = node ? { x: node.x, z: node.z, y: node.y } : { x: spot.x, z: spot.z, y: spot.y };
    this.replan = true;
    return true;
  }

  private goToCart(): void {
    const p = this.player;
    if (p.inHand !== 0) {
      this.command = 'drop item';
      return;
    }
    // 0x401e40: drop what is carried, grab the cart when CanGrabCart (3000) allows, else walk to it.
    if (p.canGrabCart()) {
      this.command = 'grab cart';
      this.replan = true;
      return;
    }
    this.navigate(this.pos, this.cart);
  }

  private grabObject(): boolean {
    const p = this.player;
    const spot = this.targetSpot;
    if (!spot) return true;
    if (p.inHand === spot.type) return true;
    if (p.inHand !== 0) {
      this.command = 'drop item';
      return false;
    }
    if (p.pickupSpot()) this.command = 'get item';
    else this.navigate(this.pos, { x: spot.x, z: spot.z, y: spot.y });
    return false;
  }

  private putInCart(): boolean {
    const p = this.player;
    if (p.inHand === 0) return true;
    const dx = p.pos.x - p.cartPos.x, dz = p.pos.z - p.cartPos.z;
    if (dx * dx + dz * dz >= ARRIVE_SQ) {
      this.navigate(this.pos, this.cart);
      return false;
    }
    this.command = 'drop item';
    return false;
  }

  private goToGoal(): void {
    const g = this.shop.goal;
    if (!g) return;
    const b = g.bounds;
    const target = b ? { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, y: g.y } : { x: g.x, z: g.z, y: g.y };
    this.navigate(this.cart, target);
  }

  /**
   * Buoy-to-buoy navigation (0x401800). Returns 0 while travelling, 2 at the final buoy and
   * 1 once within 1100 units of the target.
   */
  private navigate(from: Point, target: Point): number {
    const targetNode = this.nav.nearest(target.x, target.z, target.y - NAV_ABOVE, target.y + NAV_BELOW);
    if (!targetNode) {
      this.steer(from, target);
      return 0;
    }
    if (this.waypoint === targetNode) {
      if (!this.arrivedFinal) {
        if ((from.x - targetNode.x) ** 2 + (from.z - targetNode.z) ** 2 < ARRIVE_SQ) {
          this.arrivedFinal = true;
          return 2;
        }
        this.steer(from, targetNode);
        return 0;
      }
      this.steer(from, target);
      return (from.x - target.x) ** 2 + (from.z - target.z) ** 2 < ARRIVE_SQ ? 1 : 2;
    }
    this.arrivedFinal = false;
    if (targetNode !== this.destNode || this.replan || !this.waypoint) {
      this.replan = false;
      this.destNode = targetNode;
      // Join the graph at the buoy nearest the character (ai[2], 0x401160).
      this.waypoint = this.curNode;
      // [I] Steering from the cart, a start buoy under the character lies behind the cart and can
      // never be reached (the cart stays 750 ahead, the waypoint radius is 700): the AI would spin
      // on the spot. Start from that buoy's next hop instead.
      const wp0 = this.waypoint;
      if (wp0 && this.player.holdingCart && Math.hypot(wp0.x - this.player.pos.x, wp0.z - this.player.pos.z) < CART_REACH) {
        this.waypoint = this.nav.nextHop(wp0, targetNode) ?? wp0;
      }
      return 0;
    }
    const wp = this.waypoint;
    let aimX = wp.x, aimZ = wp.z;
    const d = Math.hypot(from.x - wp.x, from.z - wp.z);
    if (d < WAYPOINT_LOOKAHEAD) {
      // Blend the aim point towards the following buoy so the AI rounds corners.
      const next = this.nav.nextHop(wp, targetNode);
      if (next && next !== wp) {
        const len = Math.hypot(next.x - wp.x, next.z - wp.z) || 1;
        aimX += ((next.x - wp.x) / len) * (WAYPOINT_LOOKAHEAD - d);
        aimZ += ((next.z - wp.z) / len) * (WAYPOINT_LOOKAHEAD - d);
      }
    }
    if (d >= WAYPOINT_REACHED && (from.x - aimX) ** 2 + (from.z - aimZ) ** 2 >= WAYPOINT_REACHED_SQ) {
      this.steer(from, { x: aimX, z: aimZ });
      return 0;
    }
    this.waypoint = this.nav.nextHop(wp, targetNode) ?? targetNode;
    return 0;
  }

  /** Turn/throttle towards a point (0x401ae0), including stuck detection. */
  private steer(from: Point, target: { x: number; z: number }): void {
    const p = this.player;
    const vx = target.x - from.x, vz = target.z - from.z;
    const dist = Math.hypot(vx, vz);
    const diff = wrap(Math.atan2(vx, vz) - p.heading);
    this.turn = Math.max(-1, Math.min(1, diff * (4 / Math.PI)));
    const ad = Math.abs(diff);
    const S = this.speed;
    const shaped = () => {
      const f = ad <= Math.PI / 2 ? Math.cos(ad) ** 2 * 0.9 + 0.1 : 0;
      return dist < SLOWDOWN_DIST ? (((1 - f) * SLOWDOWN_DIST + dist) * S * f) / ((2 - f) * SLOWDOWN_DIST) : f * S;
    };
    let throttle: number;
    if (dist >= NEAR_DIST || ad < 2 || p.speed <= p.maxSpeed * S * 0.5) throttle = shaped();
    else throttle = -S;
    this.throttle = Math.max(-1, Math.min(1, throttle));

    const mx = p.pos.x - this.checkpoint.x, mz = p.pos.z - this.checkpoint.z;
    if (mx * mx + mz * mz <= STUCK_MOVE_SQ) {
      this.stuckMs += this.tickMs;
    } else {
      this.checkpoint = { x: p.pos.x, z: p.pos.z };
      this.stuckMs = 0;
    }
    // Stuck: under 1500 units of progress for 875 ms forces a re-plan; nothing else (0x401ae0).
    if (this.stuckMs > STUCK_MS) {
      this.stuckMs = 0;
      this.replan = true;
      this.arrivedFinal = false;
    }
  }
}
