import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import manifest from 'virtual:game-manifest';
import type { Atlas } from '../engine/hud2d';
import type { BuiltMesh } from '../engine/meshFactory';
import { CHARACTER_COUNT, CHARACTER_STATS } from './setup';

/**
 * [I] Custom characters (not in the original): optional, listed in web/customcharachters/
 * characters.json (gitignored). Each one is a glTF model, unrigged, Y-up and facing +Z, plus a
 * face picture. The model is rigged at load time onto the skeleton of an original character
 * (`base`), so it plays the original animations: every vertex takes the bones of the nearest
 * vertices of the base character after both bodies are stretched onto the same bounding box,
 * and the joints are moved by the same stretch.
 *
 * Custom characters take the indices after the originals (CHARACTER_COUNT + n) and are always
 * unlocked. The computer players never pick them.
 */
export interface CustomCharacterDef {
  /** Short id ([a-z0-9_-]); identifies the character in network games. */
  id: string;
  /** Name in the menu. */
  name: string;
  /** Folder under customcharachters/. */
  folder: string;
  /** glTF binary model in the folder (default character.glb). */
  model?: string;
  /** Square portrait picture in the folder; without one the head of the model is rendered. */
  face?: string;
  /** Original character (0-9) whose skeleton the model gets; also the stand-in for players without this character. */
  base?: number;
  /** Snabbhet, Styrka, Smidighet (1-5); default the base character's. */
  stats?: [number, number, number];
  /** Height in engine units (default the base character's). */
  height?: number;
  /** Text on the character page's card, like the originals' descriptions. */
  description?: string;
}

export interface CustomCharacter {
  index: number;
  id: string;
  name: string;
  base: number;
  stats: [number, number, number];
  height: number | null;
  /** Model in its own frame (Y-up, facing +Z) with uv and normal. */
  geometry: THREE.BufferGeometry;
  texture: THREE.Texture | null;
  description: string;
  /** 64 x 64 portrait (HUD, waiting room, records). */
  face: HTMLCanvasElement;
}

export const customCharacters: CustomCharacter[] = [];

const ID = /^[a-z0-9_-]{1,24}$/;
const FACE = 64;
const CARD = 256;

/** Load customcharachters/characters.json and its models; missing or broken entries are skipped. */
export async function loadCustomCharacters(): Promise<void> {
  const custom = manifest.custom;
  if (!custom) return;
  const defs = Array.isArray(custom.characters) ? (custom.characters as CustomCharacterDef[]) : [];
  const loader = new GLTFLoader();
  for (const def of defs) {
    try {
      const id = String(def.id ?? '').toLowerCase();
      if (!ID.test(id) || customCharacters.some((c) => c.id === id)) throw new Error(`bad or duplicate id "${def.id}"`);
      const dir = `${custom.baseUrl}${encodeURIComponent(def.folder)}/`;
      const [gltf, picture] = await Promise.all([
        loader.loadAsync(dir + encodeURIComponent(def.model ?? 'character.glb')),
        def.face ? loadFace(dir + encodeURIComponent(def.face)) : null,
      ]);
      let mesh: THREE.Mesh | null = null;
      gltf.scene.traverse((o) => {
        if (!mesh && o instanceof THREE.Mesh) mesh = o;
      });
      if (!mesh) throw new Error('no mesh in the model');
      const m = mesh as THREE.Mesh;
      m.updateWorldMatrix(true, false);
      const geometry = m.geometry.clone().applyMatrix4(m.matrixWorld);
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      const material = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      const texture = material?.map ?? null;
      const portrait = picture ?? renderPortrait(geometry, texture);
      const face = document.createElement('canvas');
      face.width = face.height = FACE;
      face.getContext('2d')!.drawImage(portrait, 0, 0, FACE, FACE);
      const base = Math.max(0, Math.min(CHARACTER_COUNT - 1, Math.trunc(Number(def.base ?? 0)) || 0));
      const stat = (k: number) => Math.max(1, Math.min(5, Math.round(Number(def.stats?.[k] ?? CHARACTER_STATS[base][k]))));
      customCharacters.push({
        index: CHARACTER_COUNT + customCharacters.length,
        id,
        name: String(def.name ?? id).slice(0, 19),
        base,
        stats: [stat(0), stat(1), stat(2)],
        height: Number(def.height) > 0 ? Number(def.height) : null,
        geometry,
        texture,
        description: String(def.description ?? ''),
        face,
      });
    } catch (err) {
      console.warn(`custom character ${def?.id ?? '?'} skipped`, err);
    }
  }
}

interface Arm {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  /** End of the hand. */
  tip: THREE.Vector3;
  radius: number;
}

/**
 * Fit one arm (side -1: -x, 1: +x) of a model in the engine frame (y down, `top` the head's
 * top). The hand hangs lowest among the outermost vertices of that side (above the lowest
 * quarter: the shoes can reach out almost as far): the tip is its bottom, the wrist a tenth of
 * the height above, and the arm's thickness is measured around the wrist.
 */
function fitArm(pos: Float32Array, side: -1 | 1, shoulderY: number, top: number, height: number): Arm | null {
  const above = top + height * 0.75;
  let outer = 0;
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] < above) outer = Math.max(outer, side * pos[i]);
  if (outer <= 0) return null;
  let tipY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] < above && side * pos[i] >= outer * 0.8) tipY = Math.max(tipY, pos[i + 1]);
  const ring = (y: number) => {
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 1] - y) > height * 0.03 || side * pos[i] < outer * 0.6) continue;
      const p = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
      box.expandByPoint(p);
      c.add(p);
      n++;
    }
    return n ? { box, c: c.divideScalar(n).setY(y) } : null;
  };
  const end = ring(tipY), wristRing = ring(tipY - height * 0.1);
  if (!end || !wristRing) return null;
  const radius = Math.max(height * 0.02, (wristRing.box.max.x - wristRing.box.min.x) / 2, (wristRing.box.max.z - wristRing.box.min.z) / 2);
  // The body's outline at shoulder height.
  let edge = 0;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - shoulderY) < height * 0.04) edge = Math.max(edge, side * pos[i]);
  const wrist = wristRing.c;
  const shoulder = new THREE.Vector3(side * Math.max(radius, edge - radius), shoulderY, wrist.z);
  if (wrist.y <= shoulder.y + radius) return null; // the hands are not below the shoulders: no arms found
  const elbow = shoulder.clone().lerp(wrist, 0.5);
  return { shoulder, elbow, wrist, tip: end.c, radius };
}

/** Weights of an arm vertex (upper arm `b`, forearm b + 1, hand b + 2), or null when it is not part of the arm. */
function armWeightsAt(v: THREE.Vector3, arm: Arm, b: number): Array<[number, number]> | null {
  const { upper, hand } = armPlace(v, arm);
  if (hand.raw >= 0 && hand.dist < arm.radius * ARM_REACH) {
    // Near the wrist the hand blends into the forearm.
    const k = THREE.MathUtils.smoothstep(hand.raw, 0, 0.3);
    return [[b + 2, 0.5 + 0.5 * k], [b + 1, 0.5 - 0.5 * k]];
  }
  const t = upper.raw;
  // Elbow blend around the middle. As on the originals, where the top of the sleeve belongs to
  // the chest, the shoulder end of the upper arm fades into the chest: a rigid shoulder cap pokes
  // up behind the back when the arms reach forward for the cart.
  const fore = THREE.MathUtils.smoothstep(t, 0.45, 0.65);
  // The armpit (the inner side of the upper arm, against the body) stays mostly with the chest
  // too, or it swings out like a wing when the arm reaches forward.
  const inward = (Math.sign(arm.wrist.x) * (upper.axisX - v.x)) / arm.radius;
  const armpit = THREE.MathUtils.smoothstep(inward, 0.1, 0.6) * (1 - THREE.MathUtils.smoothstep(t, 0.3, 0.55));
  const chest = Math.max(1 - THREE.MathUtils.smoothstep(t, 0.05, 0.4), armpit * 0.8);
  return [[b, (1 - fore) * (1 - chest)], [b + 1, fore * (1 - chest)], [1, chest]];
}

/** How far out from the arm's line (in arm radii) a vertex can still be part of the arm. */
const ARM_REACH = 2.2;

/** A point's place along the arm: parameter and distance on shoulder-wrist and wrist-tip. */
function armPlace(v: THREE.Vector3, arm: Arm) {
  const seg = (a: THREE.Vector3, e: THREE.Vector3) => {
    const d = new THREE.Vector3().subVectors(e, a);
    const raw = new THREE.Vector3().subVectors(v, a).dot(d) / d.lengthSq();
    const axis = a.clone().addScaledVector(d, THREE.MathUtils.clamp(raw, 0, 1));
    return { raw, dist: v.distanceTo(axis), axisX: axis.x };
  };
  return { upper: seg(arm.shoulder, arm.wrist), hand: seg(arm.wrist, arm.tip) };
}

/**
 * The arm's vertices: a flood fill over the surface from the hand's tip, through vertices below
 * the shoulder joint and near the arm's line. A low-poly arm can share edges with the body along
 * its inner side, so vertices more than 0.6 arm radii in from the arm's line (towards the body)
 * are left out: the inner sleeve lies within that, a jacket's side beyond it.
 */
function armVertices(pos: Float32Array, index: ArrayLike<number> | null, arm: Arm, side: -1 | 1): Uint8Array {
  const count = pos.length / 3;
  // Weld vertices split by uv seams.
  const weld = new Int32Array(count);
  const keys = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[i * 3])},${Math.round(pos[i * 3 + 1])},${Math.round(pos[i * 3 + 2])}`;
    let w = keys.get(key);
    if (w === undefined) keys.set(key, (w = i));
    weld[i] = w;
  }
  const next = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = next.get(a);
    if (!s) next.set(a, (s = new Set()));
    s.add(b);
  };
  const tri = index ?? Array.from({ length: count }, (_, i) => i);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const [a, b, c] = [weld[tri[t]], weld[tri[t + 1]], weld[tri[t + 2]]];
    link(a, b), link(b, a), link(b, c), link(c, b), link(a, c), link(c, a);
  }
  const v = new THREE.Vector3();
  const inside = (w: number) => {
    if (side * pos[w * 3] <= 0) return false;
    const { upper, hand } = armPlace(v.set(pos[w * 3], pos[w * 3 + 1], pos[w * 3 + 2]), arm);
    const inward = (axisX: number) => side * (pos[w * 3] - axisX) >= -arm.radius * 0.6;
    return (
      (hand.raw >= 0 && hand.dist < arm.radius * ARM_REACH && inward(hand.axisX)) ||
      (upper.raw >= -0.05 && upper.dist < arm.radius * ARM_REACH && inward(upper.axisX))
    );
  };
  // Seeds: the vertex nearest to the hand's tip.
  let seed = 0, bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const d = v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).distanceToSquared(arm.tip);
    if (d < bestD) (bestD = d), (seed = weld[i]);
  }
  const seen = new Uint8Array(count);
  const stack = [seed];
  seen[seed] = 1;
  while (stack.length) {
    const w = stack.pop()!;
    for (const n of next.get(w) ?? []) {
      if (seen[n] || !inside(n)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = seen[weld[i]];
  return out;
}

/** Baked light for the model: the original characters carry per-vertex shade values instead. */
function shade(geometry: THREE.BufferGeometry): Float32Array {
  const normals = geometry.attributes.normal;
  const colors = new Float32Array(normals.count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) colors.fill(0.6 + 0.4 * Math.max(0, n.fromBufferAttribute(normals, i).dot(LIGHT)), i * 3, i * 3 + 3);
  return colors;
}

/** A portrait of the model's head (the top fifth), from the front, on a transparent background. */
function renderPortrait(source: THREE.BufferGeometry, texture: THREE.Texture | null): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = out.height = CARD;
  const geometry = source.clone();
  geometry.setAttribute('color', new THREE.BufferAttribute(shade(geometry), 3));
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const h = box.max.y - box.min.y;
  const head = new THREE.Box3();
  const p = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) if (v.fromBufferAttribute(p, i).y > box.max.y - h * 0.2) head.expandByPoint(v);
  const centre = head.getCenter(new THREE.Vector3());
  const size = Math.max(head.max.x - head.min.x, head.max.y - head.min.y) * 1.45;
  const camera = new THREE.PerspectiveCamera(20, 1, size * 0.1, size * 100);
  camera.position.set(centre.x + size * 0.6, centre.y + size * 0.15, centre.z + size / (2 * Math.tan((10 * Math.PI) / 180)));
  camera.lookAt(centre);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, map: texture })));
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(CARD, CARD, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.render(scene, camera);
    out.getContext('2d')!.drawImage(renderer.domElement, 0, 0, CARD, CARD);
  } catch (err) {
    console.warn('portrait not rendered', err);
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
    geometry.dispose();
  }
  return out;
}

async function loadFace(url: string): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CARD;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Centre crop to a square.
    const s = Math.min(img.width, img.height);
    canvas.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, CARD, CARD);
  } catch {
    /* no portrait: stays blank */
  }
  return canvas;
}

export function customCharacter(index: number): CustomCharacter | null {
  return customCharacters[index - CHARACTER_COUNT] ?? null;
}

/** All selectable characters: the originals, then the custom ones. */
export function characterTotal(): number {
  return CHARACTER_COUNT + customCharacters.length;
}

export function characterStats(index: number): readonly [number, number, number] {
  return customCharacter(index)?.stats ?? CHARACTER_STATS[index % CHARACTER_COUNT];
}

/** The original character whose model and skeleton a character uses. */
export function baseCharacter(index: number): number {
  return customCharacter(index)?.base ?? index % CHARACTER_COUNT;
}

const faceAtlases = new WeakMap<HTMLCanvasElement, Atlas>();

/** Where a character's 64 x 64 portrait is: a cell of the original char00 atlas, or the custom face. */
export function faceSprite(index: number, char00: Atlas): { atlas: Atlas; u: number; v: number } {
  const c = customCharacter(index);
  if (!c) return { atlas: char00, u: (index % 4) * 64, v: Math.floor(index / 4) * 64 };
  let atlas = faceAtlases.get(c.face);
  if (!atlas) faceAtlases.set(c.face, (atlas = { canvas: c.face }));
  return { atlas, u: 0, v: 0 };
}

export function customById(id: string | undefined): CustomCharacter | null {
  return (id && customCharacters.find((c) => c.id === id)) || null;
}

const NEIGHBOURS = 6;
const LIGHT = new THREE.Vector3(0.3, 1, 0.6).normalize();

/**
 * Rig a custom model onto `reference`, a built original character (skinned, rest pose). The
 * model is turned into the engine's model frame (y down, facing +z: (x, y, z) -> (-x, -y, z)),
 * scaled to the height and placed on the reference's feet.
 */
export function rigCustomCharacter(c: CustomCharacter, reference: BuiltMesh): BuiltMesh {
  const ref = reference.object as THREE.SkinnedMesh;
  const refBones = reference.bones ?? [];
  const refPos = ref.geometry.attributes.position;
  const refSkin = ref.geometry.attributes.skinIndex;
  const rMin = new THREE.Vector3(Infinity, Infinity, Infinity), rMax = rMin.clone().negate();
  const v = new THREE.Vector3();
  for (let i = 0; i < refPos.count; i++) {
    v.fromBufferAttribute(refPos, i);
    rMin.min(v);
    rMax.max(v);
  }

  // The model in the engine frame.
  const src = c.geometry;
  const sp = src.attributes.position;
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < sp.count; i++) {
    sMin = Math.min(sMin, sp.getY(i));
    sMax = Math.max(sMax, sp.getY(i));
  }
  const scale = (c.height ?? rMax.y - rMin.y) / Math.max(1e-6, sMax - sMin);
  const pos = new Float32Array(sp.count * 3);
  const pMin = new THREE.Vector3(Infinity, Infinity, Infinity), pMax = pMin.clone().negate();
  for (let i = 0; i < sp.count; i++) {
    v.set(-sp.getX(i) * scale, -sp.getY(i) * scale, sp.getZ(i) * scale);
    v.toArray(pos, i * 3);
    pMin.min(v);
    pMax.max(v);
  }
  // Feet on the reference's feet, centred over it in x and z.
  const shift = new THREE.Vector3((rMin.x + rMax.x - pMin.x - pMax.x) / 2, rMax.y - pMax.y, (rMin.z + rMax.z - pMin.z - pMax.z) / 2);
  for (let i = 0; i < sp.count; i++) {
    pos[i * 3] += shift.x;
    pos[i * 3 + 1] += shift.y;
    pos[i * 3 + 2] += shift.z;
  }
  pMin.add(shift);
  pMax.add(shift);

  // Stretch from the reference's box onto the model's.
  const k = new THREE.Vector3().subVectors(pMax, pMin).divide(new THREE.Vector3().subVectors(rMax, rMin).max(new THREE.Vector3(1, 1, 1)));
  const stretch = (r: THREE.Vector3) => r.sub(rMin).multiply(k).add(pMin);
  const refStretched = new Float32Array(refPos.count * 3);
  for (let i = 0; i < refPos.count; i++) stretch(v.fromBufferAttribute(refPos, i)).toArray(refStretched, i * 3);

  // Joints moved by the same stretch; the root stays at the origin as in buildMesh.
  const joints = ref.skeleton.boneInverses.map((m, i) => (i === 0 ? new THREE.Vector3() : stretch(new THREE.Vector3().setFromMatrixPosition(m.clone().invert()))));
  const height = pMax.y - pMin.y;

  // The arms are fitted to the model itself: in the originals the top of the sleeve belongs to
  // the chest, so copying their weights would glue the upper arm to the body. Per side (nodes
  // 3-5 at -x, 6-8 at +x): the hand is the outermost part of the model, the shoulder sits one
  // arm radius inside the body's outline at the original shoulder height, the elbow halfway.
  const arms = joints.length > 8 ? ([-1, 1] as const).map((side) => fitArm(pos, side, joints[side < 0 ? 3 : 6].y, pMin.y, height)) : [];
  arms.forEach((arm, k) => {
    if (!arm) return;
    const b = k === 0 ? 3 : 6;
    joints[b].copy(arm.shoulder);
    joints[b + 1].copy(arm.elbow);
    joints[b + 2].copy(arm.wrist);
  });

  // Skin weights: arm vertices by their place along the arm, the rest from the nearest vertices
  // of the reference (rigid in the original, so the nearest vertex's bone, blended with any other
  // bone found almost as near).
  const armBones = new Set([3, 4, 5, 6, 7, 8]);
  const armMasks = arms.map((arm, k) => (arm ? armVertices(pos, src.index ? src.index.array : null, arm, k === 0 ? -1 : 1) : null));
  const skinIndex = new Uint16Array(sp.count * 4);
  const skinWeight = new Float32Array(sp.count * 4);
  const best = new Array<[number, number]>(NEIGHBOURS);
  const put = (i: number, weights: Array<[number, number]>) => {
    const top = weights.filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0);
    top.forEach(([bone, w], n) => {
      skinIndex[i * 4 + n] = bone;
      skinWeight[i * 4 + n] = w / sum;
    });
  };
  for (let i = 0; i < sp.count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const k = x < 0 ? 0 : 1;
    const arm = arms[k];
    const armWeights = arm && armMasks[k]?.[i] ? armWeightsAt(v.set(x, y, z), arm, k === 0 ? 3 : 6) : null;
    if (armWeights) {
      put(i, armWeights);
      continue;
    }
    best.fill([Infinity, 0]);
    for (let j = 0; j < refPos.count; j++) {
      const bone = refSkin.getX(j);
      // Node 9 is a small part on the originals' crotch; the model's crotch follows the pelvis.
      if ((arms.length && armBones.has(bone)) || bone === 9) continue;
      const dx = refStretched[j * 3] - x, dy = refStretched[j * 3 + 1] - y, dz = refStretched[j * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d >= best[NEIGHBOURS - 1][0]) continue;
      let n = NEIGHBOURS - 1;
      while (n > 0 && best[n - 1][0] > d) {
        best[n] = best[n - 1];
        n--;
      }
      best[n] = [d, bone];
    }
    const near = Math.sqrt(best[0][0]);
    const weights = new Map<number, number>();
    for (const [d, bone] of best) {
      const dist = Math.sqrt(d);
      if (dist > near * 1.3 + 20) continue;
      weights.set(bone, (weights.get(bone) ?? 0) + 1 / (dist + 20));
    }
    put(i, [...weights].slice(0, 2));
  }

  const bones = refBones.map((rb) => {
    const bone = new THREE.Bone();
    bone.name = rb.name;
    bone.rotation.order = 'YXZ';
    return bone;
  });
  refBones.forEach((rb, i) => {
    if (i === 0) return;
    const parent = refBones.indexOf(rb.parent as THREE.Bone);
    const p = parent >= 0 ? parent : 0;
    bones[i].position.subVectors(joints[i], joints[p]);
    bones[p].add(bones[i]);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (src.attributes.uv) geometry.setAttribute('uv', src.attributes.uv);
  geometry.setAttribute('color', new THREE.BufferAttribute(shade(src), 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  if (src.index) geometry.setIndex(src.index);
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, map: c.texture });
  const object = new THREE.SkinnedMesh(geometry, material);
  object.name = c.id.toUpperCase();
  object.add(bones[0]);
  object.updateMatrixWorld(true);
  object.bind(new THREE.Skeleton(bones));
  object.frustumCulled = false;
  return { object, bones };
}
