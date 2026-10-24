import * as THREE from 'three';
import { detailLevel, type SenObject, type SenScene } from '../formats/sen';
import { engineEuler } from './coords';
import { buildMesh } from './meshFactory';
import type { TextureBank } from './materials';

export interface BuiltScene {
  group: THREE.Group;
  byName: Map<string, THREE.Object3D>;
}

/** Object transform from an OBJI record (float position, int16 'YXZ' rotation). */
export function applyObjectTransform(target: THREE.Object3D, obj: SenObject): void {
  target.position.set(...obj.position);
  engineEuler(...obj.rotation, target.rotation);
}

/**
 * Instantiate every mesh object of a scene. Detail-level variants ("_N<name>") are hidden when the
 * full-detail object exists, matching DetailLevels_Setup; orphans without a base stay visible.
 */
export function buildScene(scene: SenScene, bank: TextureBank, filter: (o: SenObject) => boolean = () => true): BuiltScene {
  const group = new THREE.Group();
  const byName = new Map<string, THREE.Object3D>();
  const names = new Set(scene.objects.map((o) => o.name));
  const shared = new Map<number, THREE.Mesh>();

  for (const obj of scene.objects) {
    if (obj.type !== 1 || obj.mesh < 0 || obj.mesh >= scene.meshes.length || !filter(obj)) continue;
    const { base, level } = detailLevel(obj.name);
    if (level > 0 && names.has(base)) continue;

    let object: THREE.Object3D;
    const template = shared.get(obj.mesh);
    if (template) {
      object = new THREE.Mesh(template.geometry, template.material);
    } else {
      const built = buildMesh(scene, obj.mesh, bank);
      object = built.object;
      if (!built.bones) shared.set(obj.mesh, built.object);
    }
    object.name = obj.name;
    applyObjectTransform(object, obj);
    group.add(object);
    byName.set(obj.name, object);
  }
  return { group, byName };
}
