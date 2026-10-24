import * as THREE from 'three';
import { PRIM_COLORED, PRIM_TEXTURED, type SenMesh, type SenScene } from '../formats/sen';
import type { TextureBank } from './materials';

/**
 * MAPI corners are texel indices (e.g. 128..191 for a 64-texel region). Mapping index / 256 puts
 * a corner on the border between two texels, so bilinear filtering blends in the atlas neighbour
 * and every polygon edge shows a thin line of it. Using texel centres keeps the filter inside the
 * region. [I] The gx drivers' exact convention is not decoded.
 */
export function texelUV(index: number): number {
  return (index + 0.5) / 256;
}

export interface BuiltMesh {
  object: THREE.Mesh;
  /** Present for multi-node (character) meshes; index = engine node number. */
  bones: THREE.Bone[] | null;
}

interface Batch {
  material: THREE.Material;
  positions: number[];
  uvs: number[];
  /** Scene MAPI index (-1 for none) and corner per vertex, for texture animation. */
  uvSource: number[];
  colors: number[];
  skinIndex: number[];
}

function append(dst: number[], src: number[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/** World offset of each node in the bind pose (translation only; bind rotations are zero). */
function bindOffsets(mesh: SenMesh): THREE.Vector3[] {
  const out: THREE.Vector3[] = [new THREE.Vector3()];
  mesh.nodes.forEach((n, i) => {
    const parent = out[n.parent] ?? out[0];
    out[i + 1] = new THREE.Vector3(...n.offset).add(parent);
  });
  return out;
}

/**
 * Build a Three.js mesh from LOD 0 of a SEN mesh. Multi-node meshes become a SkinnedMesh with one
 * bone per engine node and rigid (weight 1) vertex assignment, so ANM rotations drive the bones.
 */
export function buildMesh(scene: SenScene, meshIndex: number, bank: TextureBank): BuiltMesh {
  const mesh = scene.meshes[meshIndex];
  const lod = mesh.lods[0];
  const vertexNode = new Uint8Array(lod.vertexCount);
  let v = 0;
  for (const g of lod.vertexGroups) for (let k = 0; k < g.count && v < lod.vertexCount; k++) vertexNode[v++] = g.node;
  const skinned = mesh.nodes.length > 0 && lod.vertexGroups.some((g) => g.node > 0);
  const offsets = bindOffsets(mesh);

  const batches = new Map<THREE.Material, Batch>();
  for (const group of lod.primGroups) {
    if (group.vertsPerPrim < 3) continue; // points/lines are not used by the shipped scenes' visible geometry
    for (const prim of group.prims) {
      const mapi = prim.mapi !== null ? scene.mapi[prim.mapi] : undefined;
      const texName = group.flags & PRIM_TEXTURED && mapi ? scene.textureNames[mapi.texture] ?? null : null;
      const material = bank.material(texName, group.flags, skinned);
      let batch = batches.get(material);
      if (!batch) {
        batch = { material, positions: [], uvs: [], uvSource: [], colors: [], skinIndex: [] };
        batches.set(material, batch);
      }
      let r = 1, g = 1, b = 1;
      if (group.flags & PRIM_COLORED && prim.color !== null) {
        const c = prim.color * 4;
        r = (scene.colors[c] ?? 255) / 255;
        g = (scene.colors[c + 1] ?? 255) / 255;
        b = (scene.colors[c + 2] ?? 255) / 255;
      }
      const n = prim.indices.length;
      // Engine winding is clockwise seen from the visible side; emit fans reversed.
      for (let k = 1; k + 1 < n; k++) {
        for (const corner of [0, k + 1, k]) {
          const vi = prim.indices[corner];
          const node = vertexNode[vi];
          const o = offsets[node] ?? offsets[0];
          batch.positions.push(lod.positions[vi * 3] + o.x, lod.positions[vi * 3 + 1] + o.y, lod.positions[vi * 3 + 2] + o.z);
          batch.uvs.push(mapi ? texelUV(mapi.u[corner]) : 0, mapi ? texelUV(mapi.v[corner]) : 0);
          batch.uvSource.push(mapi ? prim.mapi! : -1, corner);
          const s0 = lod.shade[vi * 2] / 255, s1 = lod.shade[vi * 2 + 1] / 255;
          batch.colors.push(r * s0, g * s1, b * s0);
          batch.skinIndex.push(node, 0, 0, 0);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const materials: THREE.Material[] = [];
  const pos: number[] = [], uv: number[] = [], uvSource: number[] = [], col: number[] = [], skin: number[] = [];
  for (const batch of batches.values()) {
    const start = pos.length / 3;
    append(pos, batch.positions);
    append(uv, batch.uvs);
    append(uvSource, batch.uvSource);
    append(col, batch.colors);
    append(skin, batch.skinIndex);
    geometry.addGroup(start, batch.positions.length / 3, materials.length);
    materials.push(batch.material);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.computeBoundingSphere();
  geometry.userData.uvSource = uvSource;

  if (!skinned) {
    const object = new THREE.Mesh(geometry, materials);
    object.name = mesh.name;
    return { object, bones: null };
  }

  const vertexCount = pos.length / 3;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const bones = offsets.map((_, i) => {
    const bone = new THREE.Bone();
    bone.name = `node${i}`;
    bone.rotation.order = 'YXZ';
    return bone;
  });
  mesh.nodes.forEach((n, i) => {
    bones[i + 1].position.set(...n.offset);
    (bones[n.parent] ?? bones[0]).add(bones[i + 1]);
  });
  const object = new THREE.SkinnedMesh(geometry, materials);
  object.name = mesh.name;
  object.add(bones[0]);
  object.updateMatrixWorld(true);
  object.bind(new THREE.Skeleton(bones));
  object.frustumCulled = false; // bones move vertices outside the bind-pose bounds
  return { object, bones };
}
