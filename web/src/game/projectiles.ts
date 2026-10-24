import * as THREE from 'three';
import type { CollisionWorld } from '../engine/collision';
import type { Player } from './player';
import type { Shop } from './shopping';

/**
 * Thrown items, ported from Item_Throw (0x40b510 case 3, ctor 0x40f720) and Projectile_Tick
 * (0x40f950, run every tick from 0x426ee0). Engine units, Y-down.
 *   s = min(200, distance to own cart / 30)
 *   horizontal speed s + 25 along the heading, vertical speed -(s + 50), start 1000 above the feet
 *   gravity +18/tick; on the floor: vy < 18 -> rest vertically and halve the horizontal speed,
 *   otherwise bounce (vy * -0.4, sound 20); horizontal speed * 0.999 every tick;
 *   |horizontal| <= 15 on the floor -> the item lies there as a pickup anyone can take.
 *   A cart standing free (its owner is not pushing it, +0x174 = 0) within 1000 units (height window
 *   -1200..+500) whose owner accepts the item catches it.
 * The item is a PhysWorld body (0x402a20) with one part: radius 150, mass 2, step 500. The
 * floor-edge walls cut its position; its own speed and direction (+0x14/+0x18) are kept, so it
 * presses against a wall and slides along it rather than bouncing off.
 */
const RADIUS = 150;
const STEP = 500;
const GRAVITY = 18;
const BOUNCE = -0.4;
const DAMPING = 0.999;
const REST_SPEED = 15;
const CART_CATCH = 1000;
const CATCH_ABOVE = 1200;
const CATCH_BELOW = 500;

interface Projectile {
  type: number;
  thrower: Player;
  pos: THREE.Vector3;
  heading: number;
  speed: number;
  vy: number;
  mesh: THREE.Object3D;
}

export class Projectiles {
  private readonly list: Projectile[] = [];
  /** Positions where an item bounced this tick (for sound). */
  readonly bounces: THREE.Vector3[] = [];

  constructor(
    private readonly root: THREE.Object3D,
    private readonly shop: Shop,
    private readonly world: CollisionWorld,
  ) {}

  throw(thrower: Player, type: number, from: THREE.Vector3): void {
    const d = Math.hypot(thrower.cartPos.x - thrower.pos.x, thrower.cartPos.z - thrower.pos.z);
    const s = Math.min(200, d / 30);
    const mesh = this.shop.createItem(type) ?? new THREE.Object3D();
    mesh.position.copy(from);
    this.root.add(mesh);
    this.list.push({ type, thrower, pos: from.clone(), heading: thrower.heading, speed: s + 25, vy: -(s + 50), mesh });
  }

  tick(players: Player[]): void {
    this.bounces.length = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const prev = p.pos.clone();
      p.pos.x += Math.sin(p.heading) * p.speed;
      p.pos.z += Math.cos(p.heading) * p.speed;
      const hit = this.world.floorEdges.sweep(prev.x, prev.z, p.pos.x, p.pos.z, RADIUS, p.pos.y, STEP);
      if (hit) {
        p.pos.x = hit.x;
        p.pos.z = hit.z;
      }
      const floor = this.world.floorAt(p.pos.x, p.pos.z, p.pos.y + 50, 3000) ?? p.pos.y;
      let resting = false;
      if (p.pos.y + p.vy >= floor) {
        if (p.vy < GRAVITY) {
          p.vy = 0;
          p.pos.y = floor;
          p.speed *= 0.5;
          resting = Math.abs(p.speed) <= REST_SPEED;
        } else {
          p.vy *= BOUNCE;
          p.pos.y = floor;
          this.bounces.push(p.pos.clone());
        }
      } else {
        p.vy += GRAVITY;
        p.pos.y += p.vy;
      }
      p.speed *= DAMPING;
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += 0.25;

      const catcher = players.find((pl) => {
        if (!pl.cart || pl.holdingCart) return false;
        const dx = pl.cartPos.x - p.pos.x, dz = pl.cartPos.z - p.pos.z;
        const dy = p.pos.y - pl.cartPos.y;
        return dx * dx + dz * dz < CART_CATCH * CART_CATCH && dy > -CATCH_ABOVE && dy < CATCH_BELOW && pl.acceptsItem(p.type);
      });
      if (catcher) {
        // Cart_AddItem gets the flying mesh itself (0x40f950 -> 0x40f1f0).
        catcher.receiveItem(p.type, p.mesh);
        this.list.splice(i, 1);
        continue;
      }
      if (resting) {
        p.mesh.rotation.set(0, p.heading, 0);
        this.shop.addDropped(p.type, p.pos, p.mesh);
        this.list.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const p of this.list) p.mesh.removeFromParent();
    this.list.length = 0;
  }
}
