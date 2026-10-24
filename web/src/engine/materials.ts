import * as THREE from 'three';
import { loadGameFile } from './assets';
import { parseTpg, tpgToRgba, TPG_SIZE, type Tpg } from '../formats/tpg';
import { PRIM_COLORKEY, PRIM_DOUBLE_SIDED, PRIM_TEXTURED, PRIM_TRANSLUCENT } from '../formats/sen';

/**
 * Affine texture mapping: pre-multiply the UV by clip-space w in the vertex shader and divide by the
 * interpolated w per fragment. Interpolating uv*w and w linearly in screen space cancels the
 * hardware's perspective correction, giving the classic per-triangle texture swim.
 */
function applyAffineMapping(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vAffineW;')
    .replace(
      '#include <fog_vertex>',
      '#include <fog_vertex>\n#ifdef USE_MAP\n  vMapUv *= gl_Position.w;\n#endif\n  vAffineW = gl_Position.w;',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vAffineW;')
    .replace(
      '#include <map_fragment>',
      '#ifdef USE_MAP\n  vec4 sampledDiffuseColor = texture2D( map, vMapUv / vAffineW );\n  diffuseColor *= sampledDiffuseColor;\n#endif',
    );
}

/**
 * Textures for one mall. Every scene of a level (mall, objects, characters) references the same
 * MERGEDnn atlases by name, loaded from levels[n].texture_files.
 */
export class TextureBank {
  private readonly tpgs = new Map<string, Tpg>();
  private readonly textures = new Map<string, THREE.DataTexture>();
  private readonly materials = new Map<string, THREE.Material>();

  constructor(private readonly dir: string) {}

  async preload(names: Iterable<string>): Promise<void> {
    await Promise.all(
      [...new Set(names)].map(async (name) => {
        const key = name.toUpperCase();
        // An empty TNAM entry is an unused slot (the menu's character scene has one).
        if (!name || this.tpgs.has(key)) return;
        try {
          this.tpgs.set(key, parseTpg(await loadGameFile(`${this.dir}/${name}.tpg`)));
        } catch (err) {
          console.warn(`texture ${name} missing`, err);
        }
      }),
    );
  }

  texture(name: string, colorKey: boolean): THREE.Texture | null {
    const key = `${name.toUpperCase()}|${colorKey ? 'ck' : ''}`;
    let tex = this.textures.get(key);
    if (!tex) {
      const tpg = this.tpgs.get(name.toUpperCase());
      if (!tpg) return null;
      tex = new THREE.DataTexture(tpgToRgba(tpg, colorKey), TPG_SIZE, TPG_SIZE, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.flipY = false;
      tex.needsUpdate = true;
      this.textures.set(key, tex);
    }
    return tex;
  }

  /**
   * Material for a primitive group, following the gxOpenGl render-state function (0x10001bc0):
   * bit 0x04 texture, 0x08/0x10 flat/gouraud colour, 0x20 blending with mode = flags & 3,
   * 0x8000 disables backface culling.
   */
  material(textureName: string | null, flags: number, skinned: boolean): THREE.Material {
    const textured = (flags & PRIM_TEXTURED) !== 0 && textureName !== null;
    const colorKey = (flags & PRIM_COLORKEY) !== 0;
    const translucent = (flags & PRIM_TRANSLUCENT) !== 0;
    const blendMode = flags & 3;
    const key = [textured ? textureName : '-', colorKey, translucent ? blendMode : 'o', flags & PRIM_DOUBLE_SIDED, skinned].join('|');
    let mat = this.materials.get(key);
    if (mat) return mat;

    const m = new THREE.MeshBasicMaterial({ vertexColors: true });
    if (textured) m.map = this.texture(textureName, colorKey);
    if (colorKey) m.alphaTest = 0.5;
    m.side = flags & PRIM_DOUBLE_SIDED ? THREE.DoubleSide : THREE.FrontSide;
    if (translucent) {
      m.transparent = true;
      m.depthWrite = false;
      switch (blendMode) {
        case 0: // SRC_ALPHA, ONE_MINUS_SRC_ALPHA at alpha 0.5
          m.opacity = 0.5;
          break;
        case 1: // SRC_ALPHA, ONE
          m.blending = THREE.AdditiveBlending;
          m.opacity = 0.5;
          break;
        case 2: // ZERO, SRC_COLOR
          m.blending = THREE.MultiplyBlending;
          m.premultipliedAlpha = true;
          break;
        case 3: // SRC_ALPHA, ONE at alpha 0.25
          m.blending = THREE.AdditiveBlending;
          m.opacity = 0.25;
          break;
      }
    }
    mat = m;
    this.materials.set(key, mat);
    return mat;
  }

  private retro = false;

  /**
   * Period-accurate rendering: nearest-neighbour texels, no mipmaps and affine (non perspective
   * corrected) texture mapping, so the two triangles of a quad warp the texture independently,
   * like PS1-era / software-rasterised 3D.
   */
  setRetro(on: boolean): void {
    if (this.retro === on) return;
    this.retro = on;
    this.textures.forEach((t) => {
      t.magFilter = on ? THREE.NearestFilter : THREE.LinearFilter;
      t.minFilter = on ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = !on;
      t.needsUpdate = true;
    });
    this.materials.forEach((m) => {
      if (!(m instanceof THREE.MeshBasicMaterial) || !m.map) return;
      m.onBeforeCompile = on ? applyAffineMapping : () => {};
      m.customProgramCacheKey = () => (on ? 'affine' : 'perspective');
      m.needsUpdate = true;
    });
  }

  get isRetro(): boolean {
    return this.retro;
  }

  dispose(): void {
    this.textures.forEach((t) => t.dispose());
    this.materials.forEach((m) => m.dispose());
  }
}
