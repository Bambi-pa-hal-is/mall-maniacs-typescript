import * as THREE from 'three';
import type { CollisionWorld } from '../engine/collision';
import type { CameraConfig } from './config';
import { insideArea, type EventObject } from './events';
import type { Player } from './player';

/**
 * Chase camera (Camera_Update 0x4020d0). maniac.cfg objects/camera pos { 0 -1990 -2200 } and
 * aim { 0 -1900 0 } are dummies fixed in the player's frame (engine units, Y-down). Each update
 * the camera position moves 1/rot_max (4) of the way to the pos dummy on every axis, or snaps to
 * it when that axis is within rot_speed (20). It then looks at the aim dummy.
 * The game runs the update every tick while the player is turning, otherwise every 4th tick
 * (0x40b3d0). Here the 4-tick steps become the equivalent per-tick rate so the camera moves smoothly.
 *
 * Camera_ClipToFloorEdges (0x4023e0) pulls the camera in where the line from the player crosses
 * a wall edge, both for the wanted and the eased position. This is what brings it close behind
 * the player in Aqua's tunnels.
 *
 * Fixed cameras (c_ac event objects, checked first, first match wins): while the wanted camera
 * height is within [v2, v0] (v2 = 0: no lower limit) and the player stands inside the area, the
 * camera jumps to (object X, v1, object Z) and keeps aiming at the player; v3 = 1 skips the wall
 * pull. Aqua uses them along the water slide, Future has one too. Afterwards the normal easing
 * brings the camera back.
 */
const CAMERA_WALL_MARGIN = 150;

export class ChaseCamera {
  private readonly feet = new THREE.Vector3();
  private readonly want = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  /** The camera's eased position. */
  private readonly current = new THREE.Vector3();
  private readonly fixed: EventObject[];

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly root: THREE.Object3D,
    private readonly cfg: CameraConfig,
    private readonly world: CollisionWorld | null = null,
    events: EventObject[] = [],
  ) {
    root.add(camera);
    this.fixed = events.filter((e) => e.name === 'c_ac' && e.edges.length > 0);
  }

  /** Put the camera straight at its wanted position (FUN_004020c0 does this on teleports). */
  snap(player: Player): void {
    this.dummies(player, 1);
    this.pullIn(this.want);
    this.current.copy(this.want);
  }

  /** The c_ac camera covering this spot, if any. */
  private fixedCamera(eyeY: number, x: number, z: number): EventObject | null {
    for (const c of this.fixed) {
      const [max, , min] = c.values;
      if (eyeY <= max && (!min || min <= eyeY) && insideArea(c, x, z)) return c;
    }
    return null;
  }

  /** World positions of the pos and aim dummies for the interpolated player. */
  private dummies(player: Player, alpha: number): void {
    const h = player.interpolated(alpha, this.feet);
    const s = Math.sin(h), c = Math.cos(h);
    const [px, py, pz] = this.cfg.pos;
    const [ax, ay, az] = this.cfg.aim;
    this.want.set(this.feet.x + px * c + pz * s, this.feet.y + py, this.feet.z - px * s + pz * c);
    this.aim.set(this.feet.x + ax * c + az * s, this.feet.y + ay, this.feet.z - ax * s + az * c);
  }

  /** Keep a camera position on the player's side of walls (ray from the player's head). */
  private pullIn(eye: THREE.Vector3): void {
    if (!this.world) return;
    this.pivot.set(this.feet.x, this.feet.y + this.cfg.aim[1], this.feet.z);
    const len = this.pivot.distanceTo(eye);
    const hit = this.world.raycast(this.pivot, eye);
    if (hit < 1 && len > 0) eye.lerpVectors(this.pivot, eye, Math.max(0.05, hit - CAMERA_WALL_MARGIN / len));
  }

  update(player: Player, alpha: number, frameTicks: number): void {
    this.dummies(player, alpha);
    const fixed = this.fixedCamera(this.want.y, this.feet.x, this.feet.z);
    if (fixed) {
      this.current.set(fixed.x, fixed.values[1], fixed.z);
      if (!fixed.values[3]) this.pullIn(this.current);
    } else {
      this.pullIn(this.want);
      const step = 1 / Math.max(1, this.cfg.rotMax);
      const perTick = player.turnInput !== 0 ? step : 1 - Math.pow(1 - step, 1 / 4);
      const k = 1 - Math.pow(1 - perTick, frameTicks);
      for (const axis of ['x', 'y', 'z'] as const) {
        const d = this.want[axis] - this.current[axis];
        this.current[axis] = Math.abs(d) < this.cfg.rotSpeed ? this.want[axis] : this.current[axis] + d * k;
      }
      this.pullIn(this.current);
    }
    this.camera.position.copy(this.current);
    this.camera.lookAt(this.root.localToWorld(this.aim.clone()));
  }
}
