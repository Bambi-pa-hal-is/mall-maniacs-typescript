import { loadGameFile } from '../engine/assets';
import { atlasFromTpg, type Atlas, type Hud2D, type HudFont } from '../engine/hud2d';
import { parseFont } from '../formats/font';
import type { Level } from './level';
import { GameMode } from './modes';
import type { Player } from './player';

/**
 * The in-game HUD, ported from Hud_Draw (0x412810). All coordinates are the original 640x480
 * ones. Atlases (Hud_LoadGraphics 0x412700): list00 (shopping-list paper), char00 (portraits,
 * metal bar), gfx2200 (frames), froge00 (question frame). Fonts (Game_Init 0x40a4d0): the list
 * font (font.txt + font00), hud digits (hudfont.txt + hfont00) and the tiny font
 * (menu/tinyfont.txt + tfont00).
 */
export interface HudAssets {
  list: Atlas;
  chars: Atlas;
  gfx: Atlas;
  question: Atlas;
  listFont: HudFont;
  digits: HudFont;
  tiny: HudFont;
}

export async function loadHudAssets(scenePath: string): Promise<HudAssets> {
  const tpg = async (name: string) => atlasFromTpg(await loadGameFile(`${scenePath}/hud/${name}.tpg`));
  const font = async (desc: string, tex: string): Promise<HudFont> => ({
    font: parseFont(new Uint8Array(await loadGameFile(desc))),
    atlas: await tpg(tex),
  });
  const [list, chars, gfx, question, listFont, digits, tiny] = await Promise.all([
    tpg('list00'),
    tpg('char00'),
    tpg('gfx2200'),
    tpg('froge00'),
    // The descriptors are read from fixed paths; only the textures are per mall.
    font('scene_ica/hud/font.txt', 'font00'),
    font('scene_ica/hud/hudfont.txt', 'hfont00'),
    font('menu/tinyfont.txt', 'tfont00'),
  ]);
  return { list, chars, gfx, question, listFont, digits, tiny };
}

/** gfx2200 regions */
const BANNER = [0, 0, 255, 50] as const; // long metal frame
const SMALL_FRAME = [153, 172, 255, 222] as const; // small rounded frame
/** Start lights beside the banner: red (Klara!/Färdiga!) and green (Gå!!). */
const LIGHT_RED = [101, 151, 142, 170] as const;
const LIGHT_GREEN = [143, 151, 184, 170] as const;
/** Hud_Draw's doorbell (sound 28). */
const DOORBELL = 28;
/** Sounds of the start lights (DAT_004589a4 changes): Red1, Green1. */
export const START_SOUNDS = { red: 33, green: 34 } as const;

export interface RaceResult {
  winner: Player;
  /** Winner's time in ms (shown in the timed modes). */
  timeMs: number;
  /** Place in the mall's top five when the local player set a new best time. */
  record: number | null;
}

export class GameHud {
  /** Current height of the shopping-list paper (DAT_00458994), eased towards its target. */
  private paper = 0;
  /** Start lights: ms since the countdown showed 5 (DAT_004589a0) and the lit state (DAT_004589a4). */
  private lightsMs = -1;
  private lights = 0;

  constructor(
    private readonly hud: Hud2D,
    private readonly a: HudAssets,
    private readonly level: Level,
    private readonly characterIndex: (p: Player) => number,
  ) {}

  private banner(y: number, text: string): void {
    const [u0, v0, u1, v1] = BANNER;
    this.hud.sprite(this.a.gfx, 192, y, 447, y + 51, u0, v0, u1, v1);
    this.hud.textCentered(this.a.tiny, 0, y + 18, text);
  }

  private portrait(p: Player, x: number, y: number, anchor: 'left' | 'center' | 'right'): void {
    const i = this.characterIndex(p);
    const u = (i % 4) * 64, v = Math.floor(i / 4) * 64;
    this.hud.sprite(this.a.chars, x, y, x + 64, y + 64, u, v, u + 63, v + 63, anchor);
  }

  /** "n / total" in hud digits, stepping down like the original (y, y+10, y+20). */
  private fraction(x: number, y: number, n: number, total: number, anchor: 'left' | 'right'): void {
    const h = this.hud;
    let cx = h.text(this.a.digits, x, y, String(n), anchor);
    cx = h.text(this.a.digits, cx, y + 10, '/', anchor);
    h.text(this.a.digits, cx, y + 20, String(total), anchor);
  }

  private time(ms: number): string {
    const t = Math.max(0, Math.floor(ms / 10));
    const cs = t % 100, s = Math.floor(t / 100) % 60, m = Math.floor(t / 6000);
    return [m, s, cs].map((v) => String(v).padStart(2, '0')).join(':');
  }

  /**
   * Start banner (end of Hud_Draw): an empty banner at y 50 while the countdown runs; when it
   * reaches 5, "Klara!" for 750 ms, then "Färdiga!" from 2250 to 2750 ms, each with red lights at
   * (207,64) and (391,64); after the start "Gå!!" with green lights (the right one mirrored) while
   * the countdown climbs from -20 to 0. Returns a sound to play when the lights change.
   */
  private drawStart(countdown: number, frameMs: number): number | null {
    if (countdown === 0) return null;
    let text = '';
    let light: readonly [number, number, number, number] | null = null;
    let state = this.lights;
    if (countdown < 0) {
      text = 'Gå!!';
      light = LIGHT_GREEN;
      state = 3;
    } else if (countdown === 5 && this.lightsMs < 0) {
      this.lightsMs = 0;
      state = 0;
    } else if (this.lightsMs >= 0) {
      this.lightsMs += frameMs;
      if (this.lightsMs < 750) {
        text = 'Klara!';
        light = LIGHT_RED;
        state = 1;
      } else if (this.lightsMs >= 2250 && this.lightsMs < 2750) {
        text = 'Färdiga!';
        light = LIGHT_RED;
        state = 2;
      }
    }
    this.banner(50, text);
    if (light) {
      const [u0, v0, u1, v1] = light;
      this.hud.sprite(this.a.gfx, 207, 64, 249, 84, u0, v0, u1, v1);
      if (state === 3) this.hud.sprite(this.a.gfx, 391, 64, 433, 84, u1, v0, u0, v1);
      else this.hud.sprite(this.a.gfx, 391, 64, 433, 84, u0, v0, u1, v1);
    }
    if (state === this.lights) return null;
    this.lights = state;
    if (state === 0) return null;
    return state === 3 ? START_SOUNDS.green : START_SOUNDS.red;
  }

  /** [I] A network message on a banner at the bottom (e.g. the clients went out of sync). */
  notice: string | null = null;
  /**
   * Network race before everyone has loaded: Hud_Draw shows "Väntar..." on the top banner while
   * the local player's state (+0x30c) is 1 (ready sent, start not yet received). [O]
   */
  waiting = false;

  /** HUD sounds of this frame (start lights 33/34, doorbell 28). */
  private readonly sounds: number[] = [];
  /** Doorbell edge detection: the announced item (DAT_0045899c) and "Mot kassorna" (DAT_0045899d). */
  private announcedSeen = 0;
  private kassaShown = false;

  /** Draw the HUD; returns the sounds to play this frame. */
  draw(elapsedMs: number, frameTicks: number, result: RaceResult | null, countdown = 0, frameMs = 0): number[] {
    this.sounds.length = 0;
    const sound = result || this.waiting ? null : this.drawStart(countdown, frameMs);
    if (sound !== null) this.sounds.push(sound);
    if (this.waiting && !result) this.banner(50, 'Väntar...');
    this.drawMain(elapsedMs, frameTicks, result);
    if (this.notice && !result) this.banner(400, this.notice);
    return this.sounds;
  }

  /** The icon drawn with the top banner (gfx2200 (0,125)-(100,214) at (112,20)-(213,110)). */
  private bannerIcon(): void {
    this.hud.sprite(this.a.gfx, 112, 20, 213, 110, 0, 125, 100, 214);
  }

  private drawMain(elapsedMs: number, frameTicks: number, result: RaceResult | null): void {
    const { hud: h, a, level } = this;
    const me = level.player;
    const mode = level.rules.mode;

    if (result) {
      this.drawResult(result);
      return;
    }

    // Shopping list paper (modes 1-2): slides up as items are found.
    if (mode === GameMode.Fragesporten || mode === GameMode.Varujakten) {
      const target = Math.max(0, 220 - 22 * me.found.filter(Boolean).length);
      this.paper += (target - this.paper) * (1 - Math.pow(0.5, frameTicks));
      if (Math.abs(target - this.paper) < 0.5) this.paper = target;
      if (this.paper > 0.5) {
        h.sprite(a.list, 0, 0, 200, this.paper + 22, 0, 255 - this.paper, 200, 255, 'left');
        let row = 0;
        me.list.forEach((t, i) => {
          if (me.found[i]) return;
          h.text(a.listFont, 5, row - target + 5 + this.paper, level.shop.itemName(t), 'left');
          row += 22;
        });
      }
    }

    // Matkrig: "Varor n/5" and the announced item.
    if (mode === GameMode.Matkrig) {
      const [u0, v0, u1, v1] = SMALL_FRAME;
      h.sprite(a.gfx, 2, 10, 106, 61, u0, v0, u1, v1, 'left');
      h.textCentered(a.tiny, -266, 28, 'Varor', 'left');
      this.fraction(10, 40, me.collected, me.required, 'left');
      const announced = level.rules.announced;
      if (announced && me.collected < me.required) {
        this.banner(50, level.shop.itemName(announced));
        this.bannerIcon();
        // Hud_Draw [O]: the doorbell (28) rings once when a new item is announced.
        if (announced !== this.announcedSeen) this.sounds.push(DOORBELL);
      }
      this.announcedSeen = announced;
    }

    // List complete: "Mot kassorna!!" (player flag 0x20, set in modes 1-3) with the doorbell once.
    if (me.allFound && me.finishedRank === null && mode !== GameMode.Vagnrace) {
      this.banner(50, 'Mot kassorna!!');
      this.bannerIcon();
      if (!this.kassaShown) this.sounds.push(DOORBELL);
      this.kassaShown = true;
    } else this.kassaShown = false;

    // Timer (Frågesporten, Vagnrace).
    if (mode === GameMode.Fragesporten || mode === GameMode.Vagnrace) {
      const [u0, v0, u1, v1] = SMALL_FRAME;
      h.sprite(a.gfx, 535, 2, 639, 53, u0, v0, u1, v1, 'right');
      h.textCentered(a.tiny, 267, 20, this.time(elapsedMs), 'right');
    }

    // Portrait and metal bar.
    this.portrait(me, 480, 10, 'right');
    h.sprite(a.chars, 215, 10, 471, 35, 0, 192, 255, 216);
    // Burger energy (+0x16c): gradient fill and the McDonald's M while it lasts.
    if (me.energy > 0) {
      h.sprite(a.chars, 227, 19, 227 + (233 * me.energy) / 100, 26, 0, 216, Math.max(1, (127 * me.energy) / 100), 221);
      h.sprite(a.chars, 311, 0, 375, 64, 128, 128, 191, 191);
    }

    // Position "n / players" (modes 2-4).
    if (mode !== GameMode.Fragesporten) this.fraction(560, 40, this.rank(me), level.players.length, 'right');

    // Question frame (Frågesporten).
    if (me.quiz) {
      h.sprite(a.question, 192, 112, 448, 368, 0, 0, 255, 255);
      h.wrapped(a.tiny, 207, 167, 226, me.quiz.text);
      const [u0, v0, u1, v1] = SMALL_FRAME;
      h.sprite(a.gfx, 268, 340, 372, 391, u0, v0, u1, v1);
      h.textCentered(a.tiny, 0, 358, 'J eller N?');
    }
  }

  /** Current position by progress (Hud_Draw ranks by items found / count / checkpoint). */
  private rank(me: Player): number {
    return 1 + this.level.players.filter((p) => p !== me && p.collected > me.collected).length;
  }

  private drawResult(r: RaceResult): void {
    const mode = this.level.rules.mode;
    const me = this.level.player;
    // DAT_004580d4 % 4000 < 2000: the game clock keeps running after the race (race time stops).
    const blink = performance.now() % 4000 < 2000;
    if (mode === GameMode.Fragesporten || mode === GameMode.Vagnrace) {
      this.banner(400, r.winner === me ? 'Tryck ENTER för att avsluta.' : 'Tryck ENTER för att fortsätta.');
      this.banner(30, r.record !== null && blink ? 'NYTT REKORD!!' : this.time(r.timeMs));
    } else {
      this.banner(30, blink ? 'Vinnare' : r.winner.displayName);
      if (r.winner === me) this.banner(400, 'Tryck ENTER för att fortsätta!');
      else this.banner(400, blink ? 'Nytt försök tryck ENTER.' : 'Tryck ESC för att avsluta.');
    }
    this.portrait(r.winner, 172, 30, 'center');
  }
}
