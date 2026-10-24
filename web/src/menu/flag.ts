import * as THREE from 'three';
import type { Atlas } from '../engine/hud2d';

/**
 * The menu's waving background cloth (Menu_Frame 0x41a8c0). fling00 is stretched over a 16x16
 * vertex grid with columns 44 px apart (x = 44r) and rows 33.3 px apart (y = 33.3c). Every frame:
 *   t += dt * 0.003
 *   A = 0.1 + 0.04 sin t,  B = 16 sin 1.3t,  C = 16 cos 1.2t
 *   s = sin((c - C) * (r - B) * A)
 *   vertex = (44r + 10s - 10, 33.3c + 10s - 10), grey shade 208 + 31s (of 255)
 * [I] The original fills 640x480; here the cloth is stretched to the window width.
 */
const N = 16;

export class MenuFlag {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 640, 0, 480, -1, 1);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(N * N * 3);
  private readonly colors = new Float32Array(N * N * 3);
  private t = 0;
  private readonly texture: THREE.CanvasTexture;

  constructor(atlas: Atlas) {
    this.texture = new THREE.CanvasTexture(atlas.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    const uvs = new Float32Array(N * N * 2);
    const index: number[] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        uvs[i * 2] = r / (N - 1);
        uvs[i * 2 + 1] = c / (N - 1);
        if (r < N - 1 && c < N - 1) index.push(i, i + N, i + N + 1, i, i + N + 1, i + 1);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(index);
    const mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ map: this.texture, vertexColors: true, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.step(0);
  }

  /** One menu frame; dt is the elapsed time in 25 ms units (0x45a6cc). */
  step(dt: number): void {
    this.t += dt * 0.003;
    const t = this.t;
    const A = Math.sin(t) * 0.04 + 0.1;
    const B = Math.sin(t * 1.3) * 16;
    const C = Math.cos(t * 1.2) * 16;
    for (let r = 0; r < N; r++) {
      const R = r - B;
      for (let c = 0; c < N; c++) {
        const s = Math.sin((c - C) * R * A);
        const i = (r * N + c) * 3;
        this.positions[i] = Math.trunc(r * 44 + 10 * s - 10);
        this.positions[i + 1] = Math.trunc(Math.trunc((c * 500) / 15) + 10 * s - 10);
        const shade = (208 + Math.trunc(31 * s)) / 255;
        this.colors[i] = this.colors[i + 1] = this.colors[i + 2] = shade;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  /** The camera shows the original 640x480 area, stretched over the whole window. */
  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
  }
}
