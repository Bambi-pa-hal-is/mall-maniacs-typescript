import { simRandom } from './random';
import type { EventObject } from './events';
import type { Player } from './player';
import type { Shop } from './shopping';

/**
 * Game modes (DAT_00458120). Names come from the menu table at 0x4500ec
 * ("Ingenting", "Frågesporten", "Varujakten", "Matkrig", "Vagnrace"); the rules are per-mode
 * branches in RaceStart_Tick (jump table 0x40c7d4), Player_Tick 0x40b510 and LoadPlayerConfig.
 */
export enum GameMode {
  /** 10 items, every pickup asks a yes/no question. */
  Fragesporten = 1,
  /** 10 items, no questions. */
  Varujakten = 2,
  /** Race to 5 announced items. */
  Matkrig = 3,
  /** Pass the numbered checkpoints, then the checkout. */
  Vagnrace = 4,
}

export const MODE_NAMES: Record<GameMode, string> = {
  [GameMode.Fragesporten]: 'Frågesporten',
  [GameMode.Varujakten]: 'Varujakten',
  [GameMode.Matkrig]: 'Matkrig',
  [GameMode.Vagnrace]: 'Vagnrace',
};

/** Matkrig: items needed (+0x180 == 5). */
export const MATKRIG_TARGET = 5;
/** Matkrig announcement timer (DAT_00458950): next item after 10000 ms; the first comes after 1 s. */
const ANNOUNCE_MS = 10000;
const ANNOUNCE_FIRST_MS = 9000;
/** Vagnrace: a checkpoint counts when within 1500 units (double at 0x44b480). */
const CHECKPOINT_RANGE = 1500;

export class ModeRules {
  /** Matkrig: the announced item type (DAT_00458128), 0 = none. */
  announced = 0;
  private announceMs = ANNOUNCE_FIRST_MS;
  /** Vagnrace checkpoints in order. */
  readonly checkpoints: EventObject[];

  constructor(
    readonly mode: GameMode,
    private readonly shop: Shop,
    events: EventObject[],
    private readonly tickMs: number,
  ) {
    this.checkpoints = events.filter((e) => e.type >= 201 && e.type < 300).sort((a, b) => a.type - b.type);
  }

  get usesQuiz(): boolean {
    return this.mode === GameMode.Fragesporten;
  }

  /** Initial list and goal count for a player. */
  setup(p: Player, drawQuestion: Parameters<Player['setShopping']>[2]): void {
    switch (this.mode) {
      case GameMode.Fragesporten:
      case GameMode.Varujakten:
        p.setShopping(this.shop, this.shop.createList(), this.usesQuiz ? drawQuestion : null);
        break;
      case GameMode.Matkrig:
        p.setShopping(this.shop, [], null, MATKRIG_TARGET);
        p.anyItemScores = true;
        // Only the announced item can be taken from a shelf; thrown items on the floor always can.
        p.shelfFilter = (type) => type === this.announced;
        break;
      case GameMode.Vagnrace:
        p.setShopping(this.shop, this.checkpoints.map((c) => c.type), null, this.checkpoints.length);
        break;
    }
  }

  /** Next checkpoint for a Vagnrace player. */
  nextCheckpoint(p: Player): EventObject | null {
    const i = p.found.indexOf(false);
    return i >= 0 ? this.checkpoints[i] ?? null : null;
  }

  /** Per game tick; returns players that passed a checkpoint this tick. */
  tick(players: Player[], frozen: boolean): Player[] {
    const passed: Player[] = [];
    if (frozen) return passed;
    if (this.mode === GameMode.Matkrig) this.tickMatkrig(players);
    if (this.mode === GameMode.Vagnrace) {
      for (const p of players) {
        const c = this.nextCheckpoint(p);
        if (!c) continue;
        // RaceStart_Tick mode 4 (0x40c54b) [O]: with the cart in hand the pushing body (+0x2a4)
        // counts; without it only while sliding in Aqua's water (flag 4), with the walker body
        // (+0x224). Both sit at the character. Within 1500 on both axes (a square).
        const at = p.holdingCart || p.sliding ? p.pos : null;
        if (at && Math.abs(c.x - at.x) <= CHECKPOINT_RANGE && Math.abs(c.z - at.z) <= CHECKPOINT_RANGE) {
          p.found[p.found.indexOf(false)] = true;
          p.collected++;
          passed.push(p);
        }
      }
    }
    return passed;
  }

  /**
   * Matkrig (RaceStart_Tick mode 3, Item_Take 0x40ea20): when no item is wanted, a random one
   * (rand() % 24 + 1) is announced after 10 s and put on everyone's list. The first player to take
   * it from the shelf claims it (DAT_00458128 = 0): the shelves stop giving it, but the lists keep it,
   * so a thrown or dropped copy lying on the floor can still be grabbed by anyone.
   */
  private tickMatkrig(players: Player[]): void {
    for (const p of players) {
      if (p.events.includes('item-picked') && this.announced !== 0 && p.inHand === this.announced) {
        this.announced = 0;
        this.announceMs = 0;
      }
    }
    if (this.announced !== 0) return;
    this.announceMs += this.tickMs;
    if (this.announceMs < ANNOUNCE_MS) return;
    const types = [...new Set(this.shop.spots.map((s) => s.type))].filter((t) => t >= 1 && t <= 24);
    if (!types.length) return;
    this.announced = types[Math.floor(simRandom() * types.length)];
    this.announceMs = 0;
    for (const p of players) if (!p.allFound && p.inHand === 0) p.setList([this.announced]);
  }
}
