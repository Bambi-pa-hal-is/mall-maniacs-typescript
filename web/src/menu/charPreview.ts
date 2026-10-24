import * as THREE from 'three';
import { loadGameFile } from '../engine/assets';
import { AnimClip, AnimPlayer } from '../engine/animation';
import { createEngineRoot } from '../engine/coords';
import { TextureBank } from '../engine/materials';
import { buildMesh } from '../engine/meshFactory';
import { parseAnm, type Anm } from '../formats/anm';
import { detailLevel, parseSen, type SenScene } from '../formats/sen';

/** Character models per menu slot (0x450164); locked slots show QUESTION. */
export const CHARACTER_MODELS = ['ROLAND', 'KAJSA', 'BERRY', 'BRITTA', 'FLOTTY', 'MILOS', 'AXEL', 'NIKOLINA', 'VONKEL', 'PILOTTA'];

interface Runner {
  object: THREE.Object3D;
  anim: AnimPlayer;
  clip: AnimClip;
}

/**
 * The running character on the character page (0x41efa0), from menu/characters.sen with the
 * menu's MERGED textures and anim/s_run.anm. The camera stands at (0, -1600, -2000) looking at
 * (-2100, 0, 1000). The runner circles (-500, 800) at radius R: x = R sin a - 500,
 * z = R cos a + 800. Every frame a drops by 0.0628, the facing turns along (-653 angle units),
 * and R eases from 2000 down to 700 by 20. The animation advances one frame per frame. When the
 * character changes, the old model drops 500 per frame until it is 20000 below.
 */
export class CharacterPreview {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 4 / 3, 20, 500000);
  private readonly root = createEngineRoot();
  private current: Runner | null = null;
  private previous: THREE.Object3D | null = null;
  private angle = 0;
  private radius = 0;
  private shown = -1;

  private constructor(
    private readonly sen: SenScene,
    private readonly bank: TextureBank,
    private readonly run: Anm,
  ) {
    this.scene.add(this.root);
    this.root.add(this.camera);
    this.camera.position.set(0, -1600, -2000);
    this.root.updateMatrixWorld(true);
    this.camera.lookAt(this.root.localToWorld(new THREE.Vector3(-2100, 0, 1000)));
  }

  static async load(): Promise<CharacterPreview> {
    const [senBuf, runBuf] = await Promise.all([loadGameFile('menu/characters.sen'), loadGameFile('anim/s_run.anm')]);
    const sen = parseSen(senBuf);
    const bank = new TextureBank('menu');
    await bank.preload(sen.textureNames);
    return new CharacterPreview(sen, bank, parseAnm(runBuf));
  }

  private mesh(name: string): number | null {
    const o = this.sen.objects
      .filter((x) => detailLevel(x.name).base === name)
      .sort((a, b) => detailLevel(a.name).level - detailLevel(b.name).level)[0];
    return o ? o.mesh : null;
  }

  /** Show a character (or the QUESTION model when locked); restarts the run-in. */
  show(index: number, locked: boolean): void {
    const key = locked ? -1 - index : index;
    if (key === this.shown && this.current) return;
    this.shown = key;
    if (this.previous) this.root.remove(this.previous);
    this.previous = this.current?.object ?? null;
    this.current = null;
    const meshIndex = this.mesh(locked ? 'QUESTION' : CHARACTER_MODELS[index]);
    if (meshIndex === null) return;
    const built = buildMesh(this.sen, meshIndex, this.bank);
    const holder = new THREE.Group();
    holder.rotation.order = 'YXZ';
    holder.add(built.object);
    this.root.add(holder);
    const bones = built.bones ?? [];
    const anim = new AnimPlayer(bones);
    const clip = new AnimClip('run', this.run, bones.length);
    anim.play(clip);
    this.current = { object: holder, anim, clip };
    this.angle = 1.5339824;
    this.radius = 2000;
    this.place();
  }

  private place(): void {
    if (!this.current) return;
    const o = this.current.object;
    o.position.set(this.radius * Math.sin(this.angle) - 500, 0, this.radius * Math.cos(this.angle) + 800);
    // Facing along the circle, i.e. the direction of motion as the angle decreases.
    o.rotation.y = this.angle - Math.PI / 2;
  }

  /** One menu frame (dt in 25 ms units). */
  step(dt: number): void {
    if (this.current) {
      this.angle -= dt * 0.0628;
      if (this.radius > 700) this.radius -= dt * 20;
      this.place();
      this.current.anim.advance(dt);
      this.current.anim.apply();
    }
    if (this.previous && this.previous.position.y < 20000) this.previous.position.y += 500;
  }

  /** Draw into a viewport (the window, or the 4:3 area of a narrow window). */
  render(renderer: THREE.WebGLRenderer, x: number, y: number, w: number, h: number): void {
    if (this.camera.aspect !== w / h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.bank.dispose();
  }
}
