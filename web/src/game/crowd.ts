import type { CollisionWorld } from '../engine/collision';
import type { PhysBody, Player } from './player';

export interface Impact {
  key: string;
  x: number;
  z: number;
  y: number;
  /** Penetration depth before separation (engine units). */
  depth: number;
  carts: boolean;
  a: Player;
  b: Player;
}

export interface CrowdResult {
  impacts: Impact[];
  /** [player, other] for every body in contact this tick; 0x405e10 calls 0x409b10 for each. */
  bumps: Array<[Player, Player]>;
}

/** Parts only touch within this height difference (float 0x44b2e4). */
const HEIGHT_WINDOW = 500;

interface Contact {
  z: number;
  x: number;
  speed: number;
  angle: number;
  /** Spin kick for the body's turn rate (+0x40). */
  spin: number;
  other: PhysBody;
}

/** A part's offset in the body frame turned by heading h, in the (z, x) plane (0x404f70). */
function offset(p: { z: number; x: number }, h: number): [number, number] {
  const c = Math.cos(h), s = Math.sin(h);
  return [p.z * c - p.x * s, p.z * s + p.x * c];
}

/** Add two polar vectors (0x435090). */
function addPolar(m1: number, a1: number, m2: number, a2: number): [number, number] {
  const z = Math.cos(a1) * m1 + Math.cos(a2) * m2;
  const x = Math.sin(a1) * m1 + Math.sin(a2) * m2;
  return [Math.hypot(z, x), Math.atan2(x, z)];
}

/**
 * Body-vs-body collisions of the original's PhysWorld (contacts 0x404ac0, response 0x405e10) [O].
 * For each part a of body A touching a part b of another body B (within 500 in height):
 *   pen = ra + rb - distance, n = direction from b to a
 *   A's new position: its part's previous position moved pen/2 along n, minus the part offset
 *   m = 0.5 * mass_a / mass_b
 *   A's new velocity = (pen / m * 0.125 along n) + A's velocity * m * 0.5 + B's velocity * 0.333 / m
 * Every contact is found first from the state before the response; a body with several contacts
 * takes the one with the highest resulting speed, plus a spin kick
 *   spin = dot(part's previous position - new body position, B's sideways direction) * B.speed / 4 * 1.5e-6
 * The player then takes the body's speed (clamped to its top speed), its direction and the spin
 * added to the turn rate (post-physics sync 0x428a70).
 * Afterwards the bodies are kept out of walls as before.
 */
export function separatePlayers(players: Player[], world: CollisionWorld): CrowdResult {
  const bodies = players.flatMap((p) => p.physBodies());
  const impacts = new Map<string, Impact>();
  const bumps: Array<[Player, Player]> = [];
  const chosen = new Map<PhysBody, Contact>();
  for (const A of bodies) {
    for (const a of A.parts) {
      const [oz, ox] = offset(a, A.heading);
      const [pz, px] = offset(a, A.prevHeading);
      const az = A.z + oz, ax = A.x + ox;
      const prevZ = A.pz + pz, prevX = A.px + px;
      for (const B of bodies) {
        if (B === A || Math.abs(B.y - A.y) > HEIGHT_WINDOW) continue;
        for (const b of B.parts) {
          const [bz, bx] = offset(b, B.heading);
          const dz = az - (B.z + bz), dx = ax - (B.x + bx);
          const reach = a.r + b.r;
          const d2 = dz * dz + dx * dx;
          if (d2 > reach * reach) continue;
          const pen = reach - Math.sqrt(d2);
          const n = Math.atan2(dx, dz);
          const m = (0.5 * a.m) / b.m;
          let [speed, angle] = addPolar((pen / m) * 0.125, n, m * A.speed * 0.5, A.angle);
          [speed, angle] = addPolar(speed, angle, (B.speed / m) * 0.333, B.angle);
          const z = prevZ + Math.cos(n) * pen * 0.5 - oz;
          const x = prevX + Math.sin(n) * pen * 0.5 - ox;
          const side = B.angle - Math.PI / 2;
          const spin = ((prevZ - z) * Math.cos(side) + (prevX - x) * Math.sin(side)) * B.speed * 0.25 * 1.5e-6;
          const c: Contact = { z, x, speed, angle, spin, other: B };
          const best = chosen.get(A);
          if (!best || c.speed > best.speed) chosen.set(A, c);
          // One impact per pair of bodies for the bump sounds, with the deepest overlap.
          const key = A.owner.slot < B.owner.slot || (A.owner === B.owner && !A.cart) ? `${A.owner.slot}${+A.cart}|${B.owner.slot}${+B.cart}` : `${B.owner.slot}${+B.cart}|${A.owner.slot}${+A.cart}`;
          const im = impacts.get(key);
          if (!im || pen > im.depth) {
            impacts.set(key, { key, x: (ax + B.x + bx) / 2, z: (az + B.z + bz) / 2, y: A.y, depth: pen, carts: A.cart || B.cart || A.parts.length > 1 || B.parts.length > 1, a: A.owner, b: B.owner });
          }
        }
      }
    }
  }
  for (const [A, c] of chosen) {
    A.owner.applyPhys(A.cart, c.z, c.x, c.speed, c.angle, c.spin);
    if (c.other.owner !== A.owner) bumps.push([A.owner, c.other.owner]);
  }
  // 0x405680 runs the floor-edge walls again after the body response.
  for (const p of players) {
    p.sweepWalls(world, false);
    p.sweepWalls(world, true);
  }
  return { impacts: [...impacts.values()], bumps };
}
