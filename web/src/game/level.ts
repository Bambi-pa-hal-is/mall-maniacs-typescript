import { simRandom } from './random';
import * as THREE from 'three';
import { loadGameFile } from '../engine/assets';
import { AnimClip, AnimPlayer } from '../engine/animation';
import { CollisionWorld } from '../engine/collision';
import { ANGLE_TO_RAD, createEngineRoot } from '../engine/coords';
import { TextureBank } from '../engine/materials';
import { buildMesh } from '../engine/meshFactory';
import { buildScene } from '../engine/sceneBuilder';
import { TextureAnimator } from '../engine/textureAnim';
import { parseAnm } from '../formats/anm';
import { parseDff } from '../formats/dff';
import { detailLevel, parseSen, type SenScene } from '../formats/sen';
import { parseQuiz } from '../formats/quiz';
import { decodeText, xor55 } from '../formats/xor';
import { AI_QUIZ_ACCURACY, AI_SPEED, AiController } from './ai';
import type { GameConfig, LevelConfig } from './config';
import { insideArea, parseEventObjects, type EventObject } from './events';
import { GuideArrows } from './guide';
import { NavGraph } from './navGraph';
import { movementParams, Player, type CartRig, type MoveTriggers } from './player';
import { Shop } from './shopping';
import { GameMode, ModeRules } from './modes';
import { ItemMarkers } from './markers';
import { Projectiles } from './projectiles';
import { MallScript } from './mallScript';
import { StartSequence } from './startSequence';
import { CHARACTER_STATS } from './setup';

export interface Level {
  config: LevelConfig;
  root: THREE.Group;
  collision: CollisionWorld;
  /** The player on this machine. */
  player: Player;
  /** The computer players (driven by `ais`). */
  npcs: Player[];
  /** Everyone, in slot order (the humans first). */
  players: Player[];
  ais: AiController[];
  nav: NavGraph | null;
  /** The mall's .eo event objects (c_ac fixed cameras are used by ChaseCamera). */
  events: EventObject[];
  shop: Shop;
  rules: ModeRules;
  markers: ItemMarkers;
  projectiles: Projectiles;
  script: MallScript;
  guide: GuideArrows;
  start: StartSequence;
  bank: TextureBank;
  /** TANI texture animation of the mall scene (Aqua's water); tick once per game tick. */
  textureAnim: TextureAnimator;
  stats: { mallObjects: number; collisionTriangles: number; navBuoys: number; itemSpots: number };
  /** Check who has checked out; returns players that finished this tick. */
  checkFinish(): Player[];
  dispose(): void;
}

/** Character animations CreateObjects (0x411550) loads for every player. */
const ANIMS = { stand: 'anim/s_stand.anm', run: 'anim/s_run.anm', throw: 'anim/s_throw1.anm' } as const;
/** Aqua (mall 3) turns its mvnc event objects into water-slide currents (0x426fd0). */
const AQUA = 3;
/** Orient (2) and Future (4) use mvnc launch pads, hurl pushes and tele teleports. */
const LAUNCH_MALLS = [2, 4];

async function loadSen(path: string): Promise<SenScene> {
  return parseSen(await loadGameFile(path));
}

async function loadDff(path: string) {
  return parseDff(decodeText(new Uint8Array(await loadGameFile(path))));
}

function findMesh(scene: SenScene, name: string): number {
  // Prefer the full-detail object; fall back to the best detail level present.
  const candidates = scene.objects
    .filter((o) => detailLevel(o.name).base === name)
    .sort((a, b) => detailLevel(a.name).level - detailLevel(b.name).level);
  if (candidates.length === 0) throw new Error(`Mesh '${name}' not found`);
  return candidates[0].mesh;
}

/** Largest y (engine is Y-down, so the lowest point) of a mesh's LOD 0 vertices. */
function lowestPoint(scene: SenScene, meshIndex: number): number {
  const p = scene.meshes[meshIndex].lods[0].positions;
  let max = -Infinity;
  for (let i = 1; i < p.length; i += 3) max = Math.max(max, p[i]);
  return Number.isFinite(max) ? max : 0;
}

/** The level's startup script names its nav ("nload x.ai") and event ("eload x.eo") files. */
function startupFile(level: LevelConfig, command: 'nload' | 'eload'): string | null {
  const line = level.startup.find((s) => s.trim().startsWith(command + ' '));
  return line ? line.trim().slice(command.length + 1).trim() : null;
}

export async function loadLevel(
  cfg: GameConfig,
  levelIndex: number,
  /** Character per player slot, the human's first (Race_SetupPlayers 0x41b6e0). */
  characters: number[],
  difficulty: number,
  mode: GameMode,
  onProgress: (msg: string) => void,
  /**
   * Network races: slots 0..humans-1 are people (no AI), `local` is the one on this machine.
   * Every client builds the same slots so the lockstep simulations match.
   */
  seats: { humans: number; local: number; names?: string[] } = { humans: 1, local: 0 },
): Promise<Level> {
  const level = cfg.levels[levelIndex];
  const dir = level.scenePath;
  onProgress(`Laddar ${level.name}…`);
  const navFile = startupFile(level, 'nload');
  const eventFile = startupFile(level, 'eload');
  const [mall, phys, chars, objects, standBuf, runBuf, navDff, eventDff, questBuf, throwBuf] = await Promise.all([
    loadSen(`${dir}/${level.sceneFile}`),
    loadSen(`${dir}/ph${level.sceneFile}`),
    loadSen(`${dir}/${cfg.charSceneFile}`),
    loadSen(`${dir}/${cfg.objSceneFile}`),
    loadGameFile(ANIMS.stand),
    loadGameFile(ANIMS.run),
    navFile ? loadDff(navFile) : Promise.resolve(null),
    eventFile ? loadDff(eventFile) : Promise.resolve(null),
    loadGameFile('quest.txt'),
    loadGameFile(ANIMS.throw),
  ]);
  // Quiz_Pick (0x410290) is always called with level 0: only "1 ..." questions are asked.
  const questions = parseQuiz(decodeText(xor55(new Uint8Array(questBuf)))).filter((q) => q.level === 0);
  const drawQuestion = () => (questions.length ? questions[Math.floor(simRandom() * questions.length)] : null);

  onProgress('Laddar texturer…');
  const bank = new TextureBank(dir);
  await bank.preload([...mall.textureNames, ...chars.textureNames, ...objects.textureNames]);

  onProgress('Bygger scen…');
  const root = createEngineRoot();
  const built = buildScene(mall, bank);
  root.add(built.group);
  const textureAnim = new TextureAnimator(mall);
  textureAnim.track(built.group);
  const collision = new CollisionWorld(phys);
  const nav = navDff ? new NavGraph(navDff) : null;
  const events = eventDff ? parseEventObjects(eventDff) : [];
  const shop = new Shop(events, cfg, objects, bank);
  const flagIndex = objects.objects.find((o) => o.name === 'CHECKFLAG')?.mesh;
  const cardIndex = objects.objects.find((o) => o.name === 'KUNDKORT')?.mesh;
  let flagTemplate: THREE.Mesh | null = null;
  const flagMesh = () => {
    if (flagIndex === undefined) return null;
    flagTemplate ??= buildMesh(objects, flagIndex, bank).object;
    return new THREE.Mesh(flagTemplate.geometry, flagTemplate.material);
  };
  const rules = new ModeRules(mode, shop, events, cfg.master.objUpdateTime);
  // LoadLevelContent (0x4108a0): CHECKFLAG for every slot in Vagnrace, otherwise the item's mesh.
  const markers =
    mode === GameMode.Vagnrace
      ? new ItemMarkers(root, rules.checkpoints, rules, () => flagMesh())
      : new ItemMarkers(root, shop.spots, rules, (spot) => shop.createItem(spot.type));
  const standAnm = parseAnm(standBuf);
  const runAnm = parseAnm(runBuf);
  const throwAnm = parseAnm(throwBuf);
  const scriptAnm = async (f: string) => parseAnm(await loadGameFile(f));
  const [flpick1, flpick2, throw2, cashSit, winner, oopsAnm] = await Promise.all(
    ['anim/s_flpick1.anm', 'anim/s_flpick2.anm', 'anim/s_throw2.anm', 'anim/cash_sit.anm', 'anim/s_winner.anm', 'anim/s_oops.anm'].map(scriptAnm),
  );
  const ofType = (name: string) => events.filter((e) => e.name === name && e.edges.length > 0);
  const active = levelIndex === AQUA || LAUNCH_MALLS.includes(levelIndex);
  const triggers: MoveTriggers = active
    ? { water: levelIndex === AQUA, mvnc: ofType('mvnc'), hurl: ofType('hurl'), tele: ofType('tele') }
    : { water: false, mvnc: [], hurl: [], tele: [] };
  // SPLASH (objects.sen) hangs 1200 units above every walker, with a second copy turned 16000
  // (about 88 degrees) under it; hidden until the player slides (CreateObjects 0x411550).
  const splashIndex = objects.objects.find((o) => o.name === 'SPLASH')?.mesh;
  let splashTemplate: THREE.Mesh | null = null;
  const makeSplash = (): THREE.Object3D | null => {
    if (splashIndex === undefined) return null;
    splashTemplate ??= buildMesh(objects, splashIndex, bank).object as THREE.Mesh;
    const group = new THREE.Group();
    group.position.y = -1200;
    const a = new THREE.Mesh(splashTemplate.geometry, splashTemplate.material);
    const b = new THREE.Mesh(splashTemplate.geometry, splashTemplate.material);
    b.rotation.y = 16000 * ANGLE_TO_RAD;
    group.add(a, b);
    group.visible = false;
    return group;
  };

  const makePlayer = (slot: number, charIndex: number, cartIndex: number | null): Player => {
    const name = cfg.characters[charIndex % cfg.characters.length].objectName;
    const model = buildMesh(chars, findMesh(chars, name), bank);
    const bones = model.bones ?? [];
    const clips = {
      stand: new AnimClip('stand', standAnm, bones.length),
      run: new AnimClip('run', runAnm, bones.length),
      throw: new AnimClip('throw', throwAnm, bones.length),
      oops: new AnimClip('oops', oopsAnm, bones.length),
      winner: new AnimClip('winner', winner, bones.length),
    };
    let cart: CartRig | null = null;
    if (cartIndex !== null && cfg.carts[cartIndex]) {
      const cc = cfg.carts[cartIndex];
      const cartMesh = findMesh(chars, cc.objectName);
      const cartModel = buildMesh(chars, cartMesh, bank).object;
      const holder = new THREE.Group();
      holder.rotation.order = 'YXZ';
      holder.add(cartModel);
      root.add(holder);
      cart = { object: holder, config: cc, yOffset: -lowestPoint(chars, cartMesh) };
    }
    const [speed, strength, agility] = CHARACTER_STATS[charIndex % CHARACTER_STATS.length];
    const player = new Player(name, slot, model.object, bones, new AnimPlayer(bones), clips, movementParams(cfg.master, speed, agility), cart);
    player.strength = strength;
    rules.setup(player, drawQuestion);
    player.triggers = triggers;
    if (triggers.water) {
      player.splash = makeSplash();
      if (player.splash) player.object.add(player.splash);
      player.cartSplash = cart ? makeSplash() : null;
      if (player.cartSplash) cart!.object.add(player.cartSplash);
    }
    root.add(player.object);
    return player;
  };

  const starts = level.starts;
  const spawnAt = (p: Player, slot: number) => {
    const [x, y, z, , ry] = starts[slot % starts.length];
    p.spawn(x, y, z, ry * ANGLE_TO_RAD, collision);
  };

  // Your cart has the green handle (GREENCART = carts[1]); everyone else pushes a red one. Both
  // carts have the same weight and friction, so the colour does not change the simulation.
  const humans = Math.max(1, Math.min(seats.humans, characters.length));
  const local = Math.max(0, Math.min(humans - 1, seats.local));
  const players: Player[] = [];
  const npcs: Player[] = [];
  for (let slot = 0; slot < Math.min(starts.length, 8, characters.length); slot++) {
    const p = makePlayer(slot, characters[slot] % cfg.characters.length, slot === local ? 1 : 0);
    spawnAt(p, slot);
    p.displayName = seats.names?.[slot] ?? p.name;
    players.push(p);
    if (slot < humans) p.isHuman = true;
    else npcs.push(p);
  }
  const player = players[local];
  const d = Math.max(0, Math.min(AI_SPEED.length - 1, difficulty));
  const ais = nav ? npcs.map((p) => new AiController(p, nav, shop, AI_SPEED[d], cfg.master.objUpdateTime, rules, AI_QUIZ_ACCURACY[d])) : [];
  // AI pickup pause: (4 - difficulty) * 24 ticks (difficulty 0..2 is the menu's Lätt..Svår).
  for (const n of npcs) n.pickupPauseTicks = (4 - d) * 24;
  const projectiles = new Projectiles(root, shop, collision);
  for (const p of players) p.onThrow = (thrower, type, from) => projectiles.throw(thrower, type, from);
  let finished = 0;

  return {
    config: level,
    root,
    collision,
    player,
    npcs,
    players,
    ais,
    nav,
    events,
    shop,
    rules,
    markers,
    projectiles,
    script: new MallScript(
      levelIndex,
      root,
      shop,
      cfg.master.objUpdateTime,
      chars,
      (name) => {
        // NPCs live in characters.sen, the BURGER in objects.sen.
        for (const sc of [chars, objects]) {
          try {
            return buildMesh(sc, findMesh(sc, name), bank);
          } catch {
            /* not in this scene */
          }
        }
        return null;
      },
      { stand: standAnm, flpick1, flpick2, throw1: throwAnm, throw2, cashSit, winner },
      built.byName,
    ),
    guide: new GuideArrows(objects, bank, player, shop, rules, {
      future: levelIndex === 4,
      punk: ofType('PUNK'),
      areas: new Map(events.filter((e) => /^(ARE|EXI)\d$/.test(e.name)).map((e) => [e.name, e])),
    }),
    start: new StartSequence(cfg.master.objUpdateTime, built.byName),
    bank,
    textureAnim,
    stats: {
      mallObjects: built.byName.size,
      collisionTriangles: collision.triangleCount,
      navBuoys: nav?.nodes.length ?? 0,
      itemSpots: shop.spots.length,
    },
    checkFinish() {
      // RaceStart_Tick (0x40beb0) [O]: with the list (or Matkrig target, or every Vagnrace
      // checkpoint) done and the cart in hand, the player's own body (+0x2a4) inside the "goal"
      // outline (0x414bb0) checks out. Modes 1-3 then put the KUNDKORT in the hand; sound 8.
      const out: Player[] = [];
      const goal = shop.goal;
      if (!goal) return out;
      for (const p of players) {
        if (p.finishedRank !== null || !p.allFound || !p.holdingCart) continue;
        if (!insideArea(goal, p.pos.x, p.pos.z)) continue;
        p.finishedRank = ++finished;
        out.push(p);
        if (mode !== GameMode.Vagnrace && cardIndex !== undefined) p.holdCard(buildMesh(objects, cardIndex, bank).object);
      }
      return out;
    },
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      bank.dispose();
    },
  };
}
