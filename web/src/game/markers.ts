import * as THREE from 'three';
import { ANGLE_TO_RAD } from '../engine/coords';
import type { EventObject } from './events';
import { GameMode, type ModeRules } from './modes';
import type { Player } from './player';

/**
 * Item / checkpoint markers, from LoadLevelContent (0x4108a0) and GuideArrow_Update (0x40cf40).
 * Each of the 30 item slots owns a group placed at its event spot (items 1000 units above the floor,
 * Vagnrace flags on the floor) holding a mesh: the item's mesh, or CHECKFLAG in Vagnrace.
 * The groups are hidden and only shown while the local player wants that slot:
 *   Frågesporten/Varujakten: on the list, not found, not blocked and not in hand
 *   Matkrig: the announced item
 *   Vagnrace: one of the next 3 checkpoints (the list window +0x184..)
 * A shown mesh tumbles with a relative rotation of (100, 1550, 200) int16 units per update (every
 * second 40 ms tick) and bobs 100 units on a sine whose phase grows 0.3 per update.
 */
const ITEM_HEIGHT = 1000;
const SPIN = new THREE.Euler(100 * ANGLE_TO_RAD, 1550 * ANGLE_TO_RAD, 200 * ANGLE_TO_RAD, 'YXZ');
const SPIN_TICKS = 2;
/** The bob sets y = 100 * sin(phase) (double 0x44b2b8); the phase grows 0.3 per update (0x44b530). [O] */
const BOB_HEIGHT = 100;
const BOB_SPEED = 0.3 / SPIN_TICKS; // radians per tick

interface Marker {
  spot: EventObject;
  group: THREE.Object3D;
  mesh: THREE.Object3D;
}

export class ItemMarkers {
  private readonly markers: Marker[] = [];
  private readonly spinStep = new THREE.Quaternion();
  private bob = 0;

  constructor(
    root: THREE.Object3D,
    spots: EventObject[],
    private readonly rules: ModeRules,
    meshFor: (spot: EventObject) => THREE.Object3D | null,
  ) {
    for (const spot of spots) {
      const mesh = meshFor(spot);
      if (!mesh) continue;
      const group = new THREE.Group();
      const race = spot.type >= 201;
      group.position.set(spot.x, spot.y - (race ? 0 : ITEM_HEIGHT), spot.z);
      group.visible = false;
      group.add(mesh);
      root.add(group);
      this.markers.push({ spot, group, mesh });
    }
  }

  private wanted(p: Player, type: number): boolean {
    switch (this.rules.mode) {
      case GameMode.Matkrig:
        return type === this.rules.announced && p.inHand !== type;
      case GameMode.Vagnrace: {
        const next = p.found.indexOf(false);
        if (next < 0) return false;
        return p.list.slice(next, next + 3).includes(type);
      }
      default:
        return p.list.some((t, i) => t === type && !p.found[i]) && type !== p.blockedType && type !== p.inHand;
    }
  }

  /** Per frame; the spin is applied continuously at the original's per-update rate. */
  update(player: Player, frameTicks: number): void {
    this.bob += BOB_SPEED * frameTicks;
    const k = frameTicks / SPIN_TICKS;
    this.spinStep.setFromEuler(SPIN);
    const step = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), this.spinStep, Math.min(1, k));
    for (const m of this.markers) {
      m.group.visible = player.finishedRank === null && this.wanted(player, m.spot.type);
      if (!m.group.visible) continue;
      m.mesh.quaternion.multiply(step);
      m.mesh.position.y = Math.sin(this.bob) * BOB_HEIGHT;
    }
  }
}
