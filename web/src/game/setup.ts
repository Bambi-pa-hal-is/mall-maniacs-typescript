import { loadGameFile } from '../engine/assets';
import { parseDff } from '../formats/dff';
import { decodeText, xor55 } from '../formats/xor';
import { GameMode } from './modes';

/**
 * Race setup chosen in the menu, as the original builds it before "run <mall>":
 * - Mode select stubs (0x41bf60..0x41bfe0) set the mode (DAT_00458120) and the player count
 *   (DAT_00458108): 1 for Frågesporten (a solo time trial), otherwise 0 = "from the table".
 * - Race_SetupPlayers (0x41b6e0) fills the count from the table at 0x44b610 indexed by
 *   difficulty + mall * 3, puts the human in slot 0 and gives every other slot a distinct random
 *   character below toplevel + 6.
 */
const PLAYERS_PER_MALL = [
  [2, 3, 4], // Småköp (ICA)
  [2, 3, 4], // Eken (Woodshop)
  [3, 3, 4], // Draken (Orient)
  [3, 4, 4], // Sjöhästen (Aqua)
  [4, 4, 4], // Raketen (Future)
] as const;

export const CHARACTER_COUNT = 10;
/**
 * Snabbhet, Styrka, Smidighet per character (table 0x4501b4). LoadPlayerConfig (0x410e90) copies
 * them to the player (+0x160/+0x164/+0x168): Snabbhet scales the acceleration, Smidighet the turn
 * rate, and Styrka decides who loses the cart in a collision (0x409b10).
 */
export const CHARACTER_STATS: ReadonlyArray<readonly [number, number, number]> = [
  [3, 3, 3],
  [4, 2, 3],
  [3, 2, 4],
  [2, 3, 4],
  [5, 1, 3],
  [4, 3, 2],
  [2, 5, 3],
  [3, 4, 3],
  [4, 4, 2],
  [3, 3, 5],
];
export const MALL_COUNT = 5;

export function playerCount(mode: GameMode, mall: number, difficulty: number): number {
  if (mode === GameMode.Fragesporten) return 1;
  const row = PLAYERS_PER_MALL[Math.max(0, Math.min(MALL_COUNT - 1, mall))];
  return row[Math.max(0, Math.min(2, difficulty))];
}

/** Characters for every slot: the human's first, then distinct random ones (0x41b6e0). */
export function pickCharacters(human: number, count: number, toplevel: number, rand: () => number = Math.random): number[] {
  const out = [human];
  const pool = Math.min(CHARACTER_COUNT, toplevel + 6);
  while (out.length < count && out.length < pool) {
    const c = Math.floor(rand() * pool);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Characters 0..toplevel+4 can be picked; the rest show the QUESTION model (0x41efa0). */
export function characterUnlocked(index: number, toplevel: number): boolean {
  return index < toplevel + 5;
}

/** Malls 0..toplevel can be entered (Level select 0x41b900 plays sound 5 for the rest). */
export function mallUnlocked(index: number, toplevel: number): boolean {
  return index <= toplevel;
}

export interface GameChoice {
  mode: GameMode;
  mall: number;
  character: number;
  difficulty: number;
}

const STORAGE_KEY = 'mm.progress';

/**
 * Persistent menu state. toplevel (config.mm, "get/set toplevel") is the highest unlocked mall;
 * Hud_Draw raises it to mall + 1 when the human wins Varujakten or Matkrig in that mall.
 * The browser keeps its copy in localStorage; "?toplevel=N" in the URL overrides it.
 */
export class Progress {
  private constructor(
    public toplevel: number,
    public difficulty: number,
  ) {}

  static async load(): Promise<Progress> {
    let toplevel = 0;
    let difficulty = 1;
    try {
      const cfg = parseDff(decodeText(xor55(new Uint8Array(await loadGameFile('config.mm')))));
      toplevel = cfg.num('toplevel', 0);
    } catch {
      /* config.mm unavailable */
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { toplevel?: number; difficulty?: number } | null;
      if (saved?.toplevel !== undefined) toplevel = saved.toplevel;
      if (saved?.difficulty !== undefined) difficulty = saved.difficulty;
    } catch {
      /* storage unavailable */
    }
    const param = new URLSearchParams(location.search).get('toplevel');
    if (param !== null && Number.isFinite(Number(param))) toplevel = Number(param);
    return new Progress(Math.max(0, Math.min(MALL_COUNT, toplevel)), Math.max(0, Math.min(2, difficulty)));
  }

  /** A win in Varujakten/Matkrig in the highest unlocked mall unlocks the next one. */
  won(mode: GameMode, mall: number): boolean {
    if (mode !== GameMode.Varujakten && mode !== GameMode.Matkrig) return false;
    if (mall !== this.toplevel) return false;
    this.toplevel = mall + 1;
    this.save();
    return true;
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ toplevel: this.toplevel, difficulty: this.difficulty }));
    } catch {
      /* storage unavailable */
    }
  }
}
