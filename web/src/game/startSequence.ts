import type * as THREE from 'three';
import { ANGLE_TO_RAD } from '../engine/coords';

/**
 * Race start, ported from 0x40beb0 (called every game tick):
 * - a 7000 ms countdown (DAT_004588f0) during which every player's velocity is zeroed;
 *   the HUD number is ((7000 - tick*obj_update_time) + 500) / 1000, minimum 1.
 * - during the last 250 ms each start gate GRIND2, GRIND4 ... GRIND16 (Gates_Init 0x40bdf0)
 *   is rotated relative to itself about Y by obj_update_time * +-56.60377 int16 angle units per
 *   tick (constants at 0x44b488/0x44b48c, sign alternating by gate index), i.e. a double door
 *   swinging open by about 75 degrees.
 * - afterwards the countdown value becomes -20 ("go").
 * The gates are only visual: the original gives them no collision (only floor-region edges stop
 * bodies, see CollisionWorld.openGatesOnFloor), and the zeroed velocities hold everyone back.
 */
export const START_COUNTDOWN_MS = 7000;
const GATE_OPEN_WINDOW_MS = 250;
const GATE_SPEED = 56.60377502441406;

export class StartSequence {
  private tick = 0;
  private readonly totalTicks: number;
  private readonly openFromTick: number;
  private readonly gates: Array<{ object: THREE.Object3D; sign: number }> = [];
  /** Value shown on the HUD: seconds left while counting, -20 after the start. */
  countdown: number;

  constructor(
    private readonly tickMs: number,
    byName: Map<string, THREE.Object3D>,
  ) {
    this.totalTicks = Math.trunc(START_COUNTDOWN_MS / tickMs);
    this.openFromTick = Math.trunc((START_COUNTDOWN_MS - GATE_OPEN_WINDOW_MS) / tickMs);
    this.countdown = Math.trunc((START_COUNTDOWN_MS + 500) / 1000);
    for (let i = 0, n = 2; n < 18; i++, n += 2) {
      const object = byName.get(`GRIND${n}`);
      if (object) this.gates.push({ object, sign: i % 2 === 0 ? 1 : -1 });
    }
  }

  /** True while players must stand still. */
  get frozen(): boolean {
    return this.tick < this.totalTicks;
  }

  get gateCount(): number {
    return this.gates.length;
  }

  update(): void {
    if (this.tick < this.totalTicks) {
      this.countdown = Math.max(1, Math.trunc((START_COUNTDOWN_MS - this.tickMs * this.tick + 500) / 1000));
      this.tick++;
      if (this.tick > this.openFromTick) {
        const step = this.tickMs * GATE_SPEED * ANGLE_TO_RAD;
        for (const g of this.gates) g.object.rotateY(step * g.sign);
      }
    } else {
      if (this.countdown > 0) this.countdown = -20;
      else if (this.countdown < 0) this.countdown++;
    }
  }
}
