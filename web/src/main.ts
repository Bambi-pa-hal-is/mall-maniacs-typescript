import * as THREE from 'three';
import { AudioEngine } from './engine/audio';
import { FixedLoop } from './engine/loop';
import { ChaseCamera } from './game/camera';
import { loadGameConfig, type GameConfig } from './game/config';
import { separatePlayers } from './game/crowd';
import { Keyboard, type Controls } from './game/input';
import { loadLevel, type Level } from './game/level';
import { GameMode, MODE_NAMES } from './game/modes';
import { loadGameFile } from './engine/assets';
import { parseTga } from './formats/tga';
import { Hud2D } from './engine/hud2d';
import { GameHud, loadHudAssets, type RaceResult } from './game/hud';
import { Records } from './game/records';
import { LevelSound } from './game/sound';
import { MALL_COUNT, pickCharacters, playerCount, Progress, type GameChoice } from './game/setup';
import { CharacterPreview } from './menu/charPreview';
import { MenuFlag } from './menu/flag';
import { Menu, type MenuKey } from './menu/menu';
import { loadMenuAssets } from './menu/menuAssets';
import { seedRandom } from './game/random';
import { NetClient, unpackControls, type StartMessage } from './net/client';
import { SUM_TICKS } from './net/protocol';

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const status = document.getElementById('status')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setClearColor(0x000000);
renderer.autoClear = false; // the guide arrow overlay is drawn after a depth clear
app.appendChild(renderer.domElement);
const hud2d = new Hud2D(app);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 20, 150000);
const keyboard = new Keyboard();
const audio = new AudioEngine();
let levelSound: LevelSound | null = null;

/** Original render height (Gx_SetVideoMode 640x480) used by the retro mode. */
const RETRO_HEIGHT = 480;
const RETRO_KEY = 'mm.retro';
let retro = false;
try {
  retro = localStorage.getItem(RETRO_KEY) === '1';
} catch {
  /* storage unavailable */
}

function resize(): void {
  renderer.setPixelRatio(retro ? RETRO_HEIGHT / window.innerHeight : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

function setRetro(on: boolean): void {
  retro = on;
  try {
    localStorage.setItem(RETRO_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  app.classList.toggle('retro', on);
  level?.bank.setRetro(on);
  level?.players.forEach((p) => (p.showSplash = !on));
  resize();
}
app.classList.toggle('retro', retro);
window.addEventListener('resize', resize);

/** Optional frame cap (F key). The 25 Hz simulation is independent of it; this only saves work. */
const FPS_CAPS = [0, 60, 144] as const;
const FPS_KEY = 'mm.fpsCap';
let fpsCap = 0;
try {
  fpsCap = Number(localStorage.getItem(FPS_KEY) ?? 0) || 0;
} catch {
  /* storage unavailable */
}

function cycleFpsCap(): void {
  const i = FPS_CAPS.indexOf(fpsCap as (typeof FPS_CAPS)[number]);
  fpsCap = FPS_CAPS[(i + 1) % FPS_CAPS.length];
  if (loop) loop.maxFps = fpsCap;
  try {
    localStorage.setItem(FPS_KEY, String(fpsCap));
  } catch {
    /* storage unavailable */
  }
}
resize();

let config: GameConfig;
let level: Level | null = null;
let loop: FixedLoop | null = null;
/** ENTER after the race: play again with the same settings. */
let restartRace: (() => void) | null = null;
let records: Records | null = null;
let progress: Progress;
let menu: Menu | null = null;
let menuFrame = 0;
let starting = false;

/**
 * Network play: the lobby connection, and the race it started (null in a local game). In a
 * network race the clock is the server's frames; every human slot plays the frame's input.
 */
const net = new NetClient({
  lobby: (state) => {
    if (!level && !starting) menu?.netLobby(state);
  },
  lobbies: (list) => menu?.netLobbies(list),
  error: (reason) => menu?.netError(reason),
  start: (msg) => void startNetRace(msg),
  end: () => {
    if (netRace) backToMenu();
  },
  closed: () => {
    if (netRace) backToMenu();
    menu?.netError('closed');
  },
  desync: (n) => {
    console.warn(`Network race out of sync at tick ${n}`);
    if (netRace) netRace.desync = true;
  },
});
let netRace: { local: number; humans: number; names: string[]; desync: boolean } | null = null;

function startNetRace(msg: StartMessage): void {
  const lobby = net.lobby;
  const local = lobby ? msg.players.findIndex((p) => p.id === lobby.you) : -1;
  if (local < 0) return;
  netRace = { local, humans: msg.players.length, names: msg.players.map((p) => p.name), desync: false };
  void start(
    { mode: msg.mode, mall: msg.mall, character: msg.players[local].character, difficulty: progress.difficulty },
    { seed: msg.seed, characters: msg.players.map((p) => p.character) },
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Small info line (the game HUD itself is drawn by GameHud on a canvas). */
function renderInfo(lv: Level, fps: number): string {
  return (
    `${escapeHtml(lv.config.name)} · ${MODE_NAMES[lv.rules.mode]} · ${fps.toFixed(0)} fps${fpsCap ? ` (max ${fpsCap})` : ''}${retro ? ' · retro' : ''}<br>` +
    `Pilar/WASD: gå · Mellanslag: handling · J/N: svara · R: retro · M: ljud · F: fps · Esc: meny`
  );
}

const pickupEl = document.getElementById('pickup') as HTMLImageElement;
const pickupImages = new Map<string, Promise<string | null>>();

/** allahN.tga: the full-screen "hand holding the item" picture (0x40b510, local player only). */
function pickupImage(scenePath: string, type: number): Promise<string | null> {
  const key = `${scenePath}/hud/allah${type}.tga`;
  let p = pickupImages.get(key);
  if (!p) {
    p = loadGameFile(key)
      .then((buf) => {
        const img = parseTga(buf);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')!.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
        return c.toDataURL();
      })
      .catch(() => null);
    pickupImages.set(key, p);
  }
  return p;
}

let pickupShown = 0;
function renderPickup(lv: Level): void {
  const me = lv.player;
  const type = me.pauseLeft > 0 && me.inHand !== 0 ? me.inHand : 0;
  if (type === pickupShown) return;
  pickupShown = type;
  if (!type) {
    pickupEl.classList.add('hidden');
    return;
  }
  void pickupImage(lv.config.scenePath, type).then((url) => {
    if (pickupShown !== type || !url) return;
    pickupEl.src = url;
    pickupEl.classList.remove('hidden');
  });
}

function setStatus(text: string | null): void {
  status.textContent = text ?? '';
  status.classList.toggle('hidden', !text);
}

async function start(chosen: GameChoice, netStart?: { seed: number; characters: number[] }): Promise<void> {
  if (starting) return;
  starting = true;
  stopMenu();
  if (!netStart) netRace = null;
  const online = netRace;
  try {
    stop();
    renderer.clear();
    await audio.loadBank('sound');
    // Every lockstep client must draw the same random numbers, from loading on.
    seedRandom(netStart ? netStart.seed : Math.random() * 0x100000000);
    // Race_SetupPlayers (0x41b6e0): the player count comes from the mall/difficulty table
    // (Frågesporten is solo); the others are distinct random characters below toplevel + 6.
    // A network race (0x422840) has the lobby's players only, in its order.
    const count = playerCount(chosen.mode, chosen.mall, chosen.difficulty);
    const characters = netStart ? netStart.characters : pickCharacters(chosen.character, count, progress.toplevel);
    const seats = online ? { humans: online.humans, local: online.local, names: online.names } : undefined;
    level = await loadLevel(config, chosen.mall, characters, chosen.difficulty, chosen.mode, setStatus, seats);
    // mm_init (0x40a4d0) starts the mall's CD track (levels[].music: 2-6).
    audio.music(level.config.music);
    scene.add(level.root);
    level.bank.setRetro(retro);
    level.players.forEach((p) => (p.showSplash = !retro));
    if (import.meta.env.DEV) (window as unknown as { mm: unknown }).mm = { level, config, camera };
    levelSound = new LevelSound(audio, level.root, level.player, level.players, level.config.index, level.events);
    const charIndex = (p: { name: string }) => Math.max(0, config.characters.findIndex((c) => c.objectName === p.name));
    const gameHud = new GameHud(hud2d, await loadHudAssets(level.config.scenePath), level, charIndex);
    if (import.meta.env.DEV) Object.assign((window as unknown as { mm: object }).mm, { hud: gameHud });
    const sound = levelSound;
    const chase = new ChaseCamera(camera, level.root, config.camera, level.collision, level.events);
    chase.snap(level.player);
    const current = level;
    const tickMs = config.master.objUpdateTime;
    const idle = { turn: 0, throttle: 0, action: false };
    let fps = 0;
    let shownFps = 0;
    let fpsAge = 0;
    let lastHud = '';
    let soundAge = 0;
    let tickCount = 0;
    /** Race time since the gates opened (DAT_0045636c * obj_update_time). */
    let elapsedMs = 0;
    /** The race ends when the first player checks out (DAT_00458130 / DAT_00458134). */
    let result: RaceResult | null = null;
    loop = new FixedLoop(
      tickMs,
      () => {
        // A network race only advances when the server's next frame is here.
        let humans: Controls[];
        if (online) {
          const frame = net.takeFrame();
          if (!frame) return false;
          humans = frame.slice(0, online.humans).map(unpackControls);
        } else humans = [keyboard.controls()];
        current.start.update();
        // Everyone stands still until the start gates open (velocities are zeroed in 0x40beb0).
        const frozen = current.start.frozen || result !== null;
        if (!current.start.frozen && !result) elapsedMs += tickMs;
        current.players.forEach((p, slot) => {
          if (slot < humans.length) p.tick(frozen ? idle : humans[slot], current.collision);
        });
        // Ai_TickAll (0x4010e0): slots group*2 .. group*2+1 think this tick, the rest replay.
        const group = tickCount++ % 4;
        current.ais.forEach((ai) => {
          const think = ai.player.slot >= group * 2 && ai.player.slot < group * 2 + 2;
          ai.player.tick(frozen ? idle : ai.controls(think), current.collision);
        });
        current.projectiles.tick(current.players);
        current.script.tick(result !== null);
        current.textureAnim.tick();
        const passed = current.rules.tick(current.players, frozen);
        if (passed.includes(current.player)) audio.play(22); // checkpoint (0x40c52a plays 22 for the local player)
        const { impacts, bumps } = separatePlayers(current.players, current.collision);
        // Every body in contact rolls whether its player loses the cart (0x405e10 -> 0x409b10).
        for (const [p, other] of bumps) p.bumpedBy(other);
        const finished = result ? [] : current.checkFinish();
        if (!result && finished.length) {
          const winner = finished[0];
          const mode = current.rules.mode;
          const timed = mode === GameMode.Fragesporten || mode === GameMode.Vagnrace;
          let record: number | null = null;
          if (timed && winner === current.player && records) {
            record = records.submit(mode === GameMode.Vagnrace ? 'vahi' : 'fshi', current.config.index, {
              // Typed on the menu's name entry page; [I] a network race uses the lobby name.
              name: online ? current.player.displayName : '',
              time: Math.round(elapsedMs / 10),
              face: charIndex(winner),
              diff: chosen.difficulty,
            });
          }
          result = { winner, timeMs: elapsedMs, record };
          for (const p of current.players) p.raceEnd = p === winner ? 'winner' : 'other';
          // Hud_Draw: a win in Varujakten/Matkrig in the highest open mall opens the next one.
          if (winner === current.player) progress.won(mode, current.config.index);
        }
        sound.tick(impacts, finished, current.projectiles.bounces);
        // Lockstep check: a state checksum every second; the server compares the clients'.
        if (online && tickCount % SUM_TICKS === 0) {
          const h = current.players.reduce(
            (h, p, i) => h + (i + 1) * (p.pos.x * 1.3 + p.pos.y * 0.7 + p.pos.z + p.heading * 101 + p.inHand * 7 + p.collected * 13),
            0,
          );
          net.send({ t: 'sum', n: tickCount, h });
          if (import.meta.env.DEV) ((window as unknown as { mmNet?: Array<[number, number]> }).mmNet ??= []).push([tickCount, h]);
        }
      },
      (alpha, frameMs) => {
        // This machine's controls go to the server as they change; the frames bring them back.
        if (online) net.sendInput(keyboard.controls());
        const frameTicks = frameMs / tickMs;
        for (const p of current.players) p.render(alpha, frameTicks);
        current.script.render(frameTicks);
        current.textureAnim.apply();
        chase.update(current.player, alpha, frameTicks);
        current.markers.update(current.player, frameTicks);
        current.guide.update(camera, frameTicks);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.clearDepth();
        renderer.render(current.guide.overlay, camera);
        // Audio panners glide anyway; ~60 updates per second are plenty even on high-refresh displays.
        soundAge += frameMs;
        if (soundAge >= 16) {
          soundAge = 0;
          audio.updateListener(camera);
          sound.update();
        }
        fps = fps * 0.95 + (frameMs > 0 ? 1000 / frameMs : 0) * 0.05;
        fpsAge += frameMs;
        if (fpsAge >= 250) {
          fpsAge = 0;
          shownFps = fps;
        }
        hud2d.begin(retro);
        gameHud.notice = online?.desync ? 'Ur synk! Starta om loppet.' : null;
        gameHud.waiting = online !== null && tickCount === 0;
        for (const id of gameHud.draw(elapsedMs, frameTicks, result, current.start.countdown, frameMs)) audio.play(id);
        // Only touch the DOM when the info text changed (at 480 Hz this would otherwise be 480 rebuilds/s).
        const hudHtml = renderInfo(current, shownFps);
        if (hudHtml !== lastHud) {
          lastHud = hudHtml;
          hud.innerHTML = hudHtml;
        }
        renderPickup(current);
      },
    );
    hud.classList.remove('hidden');
    setStatus(
      `${level.stats.mallObjects} objekt · ${level.stats.collisionTriangles} kollisionstrianglar · ` +
        `${level.stats.navBuoys} navbojar · ${level.stats.itemSpots} varuplatser · ${level.ais.length} datorspelare`,
    );
    setTimeout(() => setStatus(null), 4000);
    // ENTER after the race (Hud_Draw prompts): timed modes quit to the menu, to the name entry
    // page after a new record; in Varujakten and Matkrig a win continues in the next mall and a
    // loss tries again.
    restartRace = () => {
      if (!result) return;
      // Network race: the host takes everyone back to the waiting room; [I] another player's ENTER
      // returns just that player there (the host's end then refreshes the lobby).
      if (online) {
        if (net.isHost) net.send({ t: 'end' });
        else backToMenu();
        return;
      }
      const mode = current.rules.mode;
      if (mode === GameMode.Fragesporten || mode === GameMode.Vagnrace) {
        const record = result.record;
        backToMenu();
        if (record !== null) menu?.enterName(mode === GameMode.Vagnrace ? 'vahi' : 'fshi', current.config.index, record);
        return;
      }
      const next = result.winner === current.player ? (current.config.index + 1) % MALL_COUNT : current.config.index;
      void start({ ...chosen, mall: next });
    };
    loop.maxFps = fpsCap;
    if (online) {
      loop.backlog = () => net.backlog;
      net.send({ t: 'ready' });
    }
    loop.start();
  } catch (err) {
    console.error(err);
    setStatus(`Fel: ${(err as Error).message}`);
    backToMenu();
  } finally {
    starting = false;
  }
}

function stop(): void {
  loop?.stop();
  loop = null;
  levelSound?.dispose();
  levelSound = null;
  restartRace = null;
  hud2d.clear();
  if (level) {
    scene.remove(level.root);
    level.dispose();
    level = null;
  }
}

function backToMenu(): void {
  stop();
  hud.classList.add('hidden');
  pickupEl.classList.add('hidden');
  pickupShown = 0;
  void audio.loadBank('sound/menu');
  if (netRace) {
    net.stopRace();
    menu?.showWait();
  } else menu?.showMain();
  netRace = null;
  startMenu();
}

// ---- the original menu ----

/**
 * Viewport for the menu's 3D view (CSS pixels, from the bottom-left). A window wider than 4:3
 * uses its full size: with the same vertical field of view the centre 4:3 part looks the same and
 * the runner is not cut off. A narrower window uses the letterboxed 4:3 area.
 */
function menuView(): { x: number; y: number; w: number; h: number } {
  const W = window.innerWidth, H = window.innerHeight;
  if (W >= (H * 4) / 3) return { x: 0, y: 0, w: W, h: H };
  const h = (W * 3) / 4;
  return { x: 0, y: (H - h) / 2, w: W, h };
}

/** Menu_Frame (0x41a8c0) runs a frame once at least 25 ms have passed. */
function startMenu(): void {
  if (!menu || menuFrame) return;
  let last = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    menuFrame = requestAnimationFrame(frame);
    // Intro_Page plays CD track 8 once; the menu pages play track 7 (0x41ae50, 0x41b0b0).
    audio.music(menu!.showingIntro ? 8 : 7, !menu!.showingIntro);
    acc += Math.min(now - last, 250);
    last = now;
    while (acc >= 25) {
      acc -= 25;
      menu!.step(1);
    }
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    hud2d.begin(retro);
    menu!.draw(hud2d, renderer, menuView());
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  };
  menuFrame = requestAnimationFrame(frame);
}

function stopMenu(): void {
  if (menuFrame) cancelAnimationFrame(menuFrame);
  menuFrame = 0;
  hud2d.clear();
}

const MENU_KEYS: Record<string, MenuKey> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'esc',
};
/** Menu_ReadKeys (0x416a10): held keys repeat every 200 ms; Enter does not repeat. */
const lastMenuKey = new Map<string, number>();

function menuKey(e: KeyboardEvent): void {
  if (!menu || level || starting) return;
  if (menu.rawKey(e)) return;
  const k = MENU_KEYS[e.code];
  if (!k) return;
  e.preventDefault();
  const now = performance.now();
  if (e.repeat && (k === 'enter' || now - (lastMenuKey.get(e.code) ?? 0) < 200)) return;
  lastMenuKey.set(e.code, now);
  menu.key(k);
}

window.addEventListener('keydown', (e) => {
  if (!level) {
    menuKey(e);
    if (e.code === 'KeyM' && !e.repeat) audio.setMuted(!audio.isMuted);
    return;
  }
  if (e.code === 'Escape' && level) {
    // Leaving a network race leaves its lobby too.
    if (netRace) {
      net.leave();
      menu?.netLeft();
    }
    backToMenu();
    return;
  }
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && level && restartRace) restartRace();
  if (e.code === 'KeyR' && !e.repeat) setRetro(!retro);
  if (e.code === 'KeyM' && !e.repeat) audio.setMuted(!audio.isMuted);
  if (e.code === 'KeyF' && !e.repeat) cycleFpsCap();
});

async function init(): Promise<void> {
  try {
    setStatus('Laddar…');
    config = await loadGameConfig();
    [records, progress] = await Promise.all([Records.load(), Progress.load()]);
    const [assets, preview] = await Promise.all([loadMenuAssets(), CharacterPreview.load(), audio.loadBank('sound/menu')]);
    menu = new Menu(assets, new MenuFlag(assets.fling), preview, progress, records, {
      play: (id) => audio.play(id),
      start: (c) => void start(c),
      retro: () => retro,
      setRetro,
      quit: () => menu?.restartIntro(),
      netCreate: (name, character, mall, mode, isPublic) => net.send({ t: 'create', name, character, mall, mode, public: isPublic }),
      netList: () => net.send({ t: 'list' }),
      netJoin: (code, name, character) => net.send({ t: 'join', code, name, character }),
      netStart: () => net.send({ t: 'start' }),
      netLeave: () => net.leave(),
    });
    if (import.meta.env.DEV) (window as unknown as { mmMenu: unknown }).mmMenu = { menu, preview, net, audio };
    setStatus(null);
    startMenu();
  } catch (err) {
    console.error(err);
    setStatus(`Fel: ${(err as Error).message}`);
  }
}

void init();
