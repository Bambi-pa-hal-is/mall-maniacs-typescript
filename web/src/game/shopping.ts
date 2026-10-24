import { simRandom } from './random';
import * as THREE from 'three';
import type { TextureBank } from '../engine/materials';
import { buildMesh } from '../engine/meshFactory';
import { detailLevel, type SenScene } from '../formats/sen';
import type { GameConfig } from './config';
import type { EventObject } from './events';

export const LIST_LENGTH = 10;
/** Item spots are "_001".."_025" and "_031"; shopping lists draw from 1..24 (rand() % 24 + 1). */
const LIST_MAX_TYPE = 24;
/**
 * Item spots, item meshes and the checkout goal for one mall. The spinning markers over wanted
 * items are drawn by `ItemMarkers` (markers.ts).
 */
export class Shop {
  readonly spots: EventObject[];
  readonly goal: EventObject | null;
  private readonly templates = new Map<number, THREE.Mesh>();

  constructor(
    events: EventObject[],
    private readonly cfg: GameConfig,
    objects: SenScene,
    bank: TextureBank,
  ) {
    // Item spots _001.._030; the static "_031" burger spots are ignored at load ("Burger EventObject
    // found and ignored."): the McDonald's man throws the burger at run time (mallScript.ts).
    this.spots = events.filter((e) => e.type >= 1 && e.type <= 30);
    this.goal = events.find((e) => e.name === 'goal') ?? null;
    for (const spot of this.spots) this.itemMesh(spot.type, objects, bank);
  }

  private itemMesh(type: number, objects?: SenScene, bank?: TextureBank): THREE.Mesh | null {
    let t = this.templates.get(type);
    if (!t && objects && bank) {
      const meshName = this.cfg.items[type - 1]?.mesh.toUpperCase();
      const obj = meshName ? objects.objects.find((o) => detailLevel(o.name).base === meshName && detailLevel(o.name).level === 0) : undefined;
      if (!obj) return null;
      t = buildMesh(objects, obj.mesh, bank).object;
      this.templates.set(type, t);
    }
    return t ? new THREE.Mesh(t.geometry, t.material) : null;
  }

  /** A copy of an item's mesh, e.g. to carry or put in a cart. */
  createItem(type: number): THREE.Mesh | null {
    return this.itemMesh(type);
  }

  itemName(type: number): string {
    return this.cfg.items[type - 1]?.name ?? `Vara ${type}`;
  }

  /**
   * Ten distinct random item types 1..24, as LoadPlayerConfig (0x410e90) does (rand() % 24 + 1,
   * drawing again on a repeat). Every shipped mall has spots for all 24 types, so the filter to
   * stocked types below never removes one; it only guards against a mall without them.
   */
  createList(random: () => number = simRandom): number[] {
    const available = [...new Set(this.spots.map((s) => s.type))].filter((t) => t <= LIST_MAX_TYPE);
    const pool = available.length >= LIST_LENGTH ? available : Array.from({ length: LIST_MAX_TYPE }, (_, i) => i + 1);
    const list: number[] = [];
    while (list.length < LIST_LENGTH && list.length < pool.length) {
      const t = pool[Math.floor(random() * pool.length)];
      if (!list.includes(t)) list.push(t);
    }
    return list;
  }

  private readonly dropped = new Map<EventObject, THREE.Object3D>();

  /** A thrown item that came to rest on the floor becomes a pickup anyone can take (0x40f950). */
  addDropped(type: number, pos: THREE.Vector3, mesh: THREE.Object3D): EventObject {
    const spot: EventObject = { name: 'dropped', type, x: pos.x, y: pos.y, z: pos.z, h2: 0, values: [], edges: [], bounds: null };
    this.spots.push(spot);
    this.dropped.set(spot, mesh);
    return spot;
  }

  isDropped(spot: EventObject): boolean {
    return this.dropped.has(spot);
  }

  removeDropped(spot: EventObject): void {
    this.dropped.get(spot)?.removeFromParent();
    this.dropped.delete(spot);
    const i = this.spots.indexOf(spot);
    if (i >= 0) this.spots.splice(i, 1);
  }

  /** Spots of a given item type. */
  spotsOf(type: number): EventObject[] {
    return this.spots.filter((s) => s.type === type);
  }
}
