import * as THREE from 'three';
import manifest from 'virtual:game-manifest';
import { loadGameFile } from './assets';

/**
 * Sound banks: every "NN_name.wav" in a directory is sound id NN (Sound_LoadBank 0x437170 loads
 * "sound\" in game and "sound\menu\" in the menu as bank 1). Sound_Play 0x437cf0 plays 2D sounds;
 * 0x42bcd0 plays positional ones at an object or engine-space point.
 * Positions given here are engine coordinates; they are converted through the engine root.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly buffers = new Map<number, AudioBuffer>();
  private muted = false;
  /** CD-audio music (0x416cc0 plays one track over MCI). */
  private readonly musicEl = new Audio();
  private musicTrack: number | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // Browsers start audio suspended until a user gesture.
    const resume = () => void this.ctx.resume();
    window.addEventListener('keydown', resume);
    window.addEventListener('pointerdown', resume);
    // Through the master gain, so mute (M) silences the music too.
    this.musicEl.preload = 'auto';
    this.ctx.createMediaElementSource(this.musicEl).connect(this.master);
    // Autoplay is blocked until a user gesture; retry the current track then.
    const kick = () => {
      if (this.musicTrack !== null && this.musicEl.paused && !this.musicEl.ended) void this.musicEl.play().catch(() => {});
    };
    window.addEventListener('keydown', kick);
    window.addEventListener('pointerdown', kick);
  }

  /**
   * Play CD track `track` (null = stop). The window procedure (0x4161b0, MM_MCINOTIFY) restarts the
   * current track when it ends, so tracks loop; the intro's track 8 is started without becoming
   * the current track (0x41ae50) and plays once. Asking for the playing track again does nothing.
   */
  music(track: number | null, loop = true): void {
    if (track === this.musicTrack) return;
    this.musicTrack = track;
    const file = track === null ? undefined : manifest.music?.[track];
    if (!file) {
      this.musicEl.pause();
      this.musicEl.removeAttribute('src');
      return;
    }
    this.musicEl.src = manifest.musicUrl + encodeURIComponent(file);
    this.musicEl.loop = loop;
    void this.musicEl.play().catch(() => {});
  }

  /** Load bank 1 from a directory such as "sound" or "sound/menu". */
  async loadBank(dir: string): Promise<void> {
    this.buffers.clear();
    const prefix = dir.replace(/\\/g, '/').replace(/\/?$/, '/').toLowerCase();
    const files = Object.keys(manifest.files).filter((f) => f.startsWith(prefix) && /^\d+_.*\.wav$/.test(f.slice(prefix.length)));
    await Promise.all(
      files.map(async (f) => {
        const id = parseInt(f.slice(prefix.length), 10);
        try {
          // decodeAudioData detaches its input; decode a copy so the cached file stays usable.
          this.buffers.set(id, await this.ctx.decodeAudioData((await loadGameFile(f)).slice(0)));
        } catch (err) {
          console.warn(`sound ${f} failed`, err);
        }
      }),
    );
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(on: boolean): void {
    this.muted = on;
    this.master.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  /** Non-positional one-shot (Sound_Play with flag 0x400). */
  play(id: number, volume = 1): void {
    const buffer = this.buffers.get(id);
    if (!buffer || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
  }

  /** A positional sound; loops until stopped when `loop` is set. */
  emitter(id: number, loop: boolean, refDistance = 1500, maxDistance = 40000): SoundEmitter | null {
    const buffer = this.buffers.get(id);
    if (!buffer) return null;
    return new SoundEmitter(this.ctx, this.master, buffer, loop, refDistance, maxDistance);
  }

  /** Place the listener at the camera. */
  updateListener(camera: THREE.Camera): void {
    const l = this.ctx.listener;
    const p = new THREE.Vector3(), f = new THREE.Vector3(), u = new THREE.Vector3();
    camera.getWorldPosition(p);
    camera.getWorldDirection(f);
    u.copy(camera.up).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t);
      l.forwardY.setValueAtTime(f.y, t);
      l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t);
      l.upY.setValueAtTime(u.y, t);
      l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }
}

export class SoundEmitter {
  private readonly src: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: PannerNode;
  private stopped = false;
  private placed = false;

  constructor(private readonly ctx: AudioContext, out: AudioNode, buffer: AudioBuffer, loop: boolean, refDistance: number, maxDistance: number) {
    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    this.src.loop = loop;
    this.gain = ctx.createGain();
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = refDistance;
    this.panner.maxDistance = maxDistance;
    this.panner.rolloffFactor = 1;
    this.src.connect(this.gain).connect(this.panner).connect(out);
    this.src.start();
  }

  /** Engine-space position, converted to world space through the engine root. */
  setPosition(root: THREE.Object3D, x: number, y: number, z: number): void {
    const w = root.localToWorld(new THREE.Vector3(x, y, z));
    const t = this.ctx.currentTime;
    if (!this.placed) {
      // First placement jumps; later ones glide to avoid zipper noise.
      this.placed = true;
      this.panner.positionX.setValueAtTime(w.x, t);
      this.panner.positionY.setValueAtTime(w.y, t);
      this.panner.positionZ.setValueAtTime(w.z, t);
      return;
    }
    this.panner.positionX.setTargetAtTime(w.x, t, 0.03);
    this.panner.positionY.setTargetAtTime(w.y, t, 0.03);
    this.panner.positionZ.setTargetAtTime(w.z, t, 0.03);
  }

  setVolume(v: number): void {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setRate(r: number): void {
    this.src.playbackRate.setTargetAtTime(r, this.ctx.currentTime, 0.05);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.src.stop();
    } catch {
      /* already stopped */
    }
    this.panner.disconnect();
  }
}
