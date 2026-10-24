import type * as THREE from 'three';
import type { Atlas, Hud2D, HudFont } from '../engine/hud2d';
import { textWidth } from '../formats/font';
import { GameMode, MODE_NAMES } from '../game/modes';
import type { Records, RecordTable } from '../game/records';
import { characterUnlocked, mallUnlocked, MALL_COUNT, type GameChoice, type Progress } from '../game/setup';
import { characterStats, characterTotal, customById, customCharacter, faceSprite, type CustomCharacter } from '../game/customCharacters';
import { CODE_ALPHABET, CODE_LENGTH, MAX_PLAYERS, NAME_LENGTH as NET_NAME_LENGTH, type ErrorReason, type LobbyState, type NetRules, type PublicLobby } from '../net/protocol';
import type { CharacterPreview } from './charPreview';
import type { MenuFlag } from './flag';
import type { MenuAssets } from './menuAssets';

/**
 * The original menu (Menu_Frame 0x41a8c0 and the page handlers below), drawn in the original
 * 640x480 coordinates. Every page is a handler fn(kind, key, state) in DAT_0045a6f8: kind 0 draws,
 * kind 1 is a key press (Menu_ReadKeys 0x416a10, 200 ms repeat).
 * Keys: 0 right, 1 left, 2 up, 3 down, 4 space, 6 enter, 7 esc.
 * Sounds (sound\menu): 1 move, 2 value change, 3 select, 4 back, 5 not allowed.
 * The frame runs when at least 25 ms have passed; dt (0x45a6cc) is the elapsed time / 25 ms.
 */
export type MenuKey = 'right' | 'left' | 'up' | 'down' | 'space' | 'enter' | 'esc';
type Page = 'intro' | 'main' | 'mode' | 'character' | 'mall' | 'options' | 'records' | 'name' | 'quit' | 'net' | 'netHost' | 'netJoin' | 'netWait' | 'netList';

export interface MenuHost {
  play(sound: number): void;
  start(choice: GameChoice): void;
  retro(): boolean;
  setRetro(on: boolean): void;
  /** Avsluta + J/Y: the browser cannot close the program. */
  quit(): void;
  /** Network play (see net/protocol.ts). */
  netCreate(name: string, character: number, mall: number, mode: number, isPublic: boolean): void;
  /** Ask the server for the public lobbies (answered through Menu.netLobbies). */
  netList(): void;
  netJoin(code: string, name: string, character: number): void;
  netStart(): void;
  /** Host only: switch the unofficial rules (echoed back in the lobby state). */
  netRules(rules: NetRules): void;
  netLeave(): void;
}

const SND = { move: 1, value: 2, select: 3, back: 4, error: 5 };

const MAIN_ITEMS = ['Spela', 'Nätverk', 'Alternativ', 'Rekord', 'Avsluta'];
/** Mode page (0x41c010) and its stubs 0x41bf60..0x41bfe0. */
const MODE_ITEMS: Array<[string, GameMode]> = [
  ['Varujakten', GameMode.Varujakten],
  ['Matkrig', GameMode.Matkrig],
  ['Frågesporten', GameMode.Fragesporten],
  ['Vagnrace', GameMode.Vagnrace],
];
/** Character names (0x45013c). */
export const CHARACTER_NAMES = [
  'Roland Blåvind',
  'Susanne Spira',
  'Åke Lönn',
  'Agata von Gördel',
  'Hektor Kvot',
  'Hugo Spandex',
  'Bosse Bänkpress',
  'Klara Blixt',
  'Kalle Kallsup',
  'Kajsa Komet',
];
/** Menu name of a character, custom ones included. */
export function characterName(index: number): string {
  return customCharacter(index)?.name ?? CHARACTER_NAMES[index] ?? '';
}
const DIFFICULTY_NAMES = ['Lätt', 'Medium', 'Svårt'];
/** Mall names of the network pages (0x450100). */
const NET_MALL_NAMES = ['ICA Småköp', 'ICA Eken', 'ICA Draken', 'ICA Sjöhästen', 'ICA Raketen'];
/** Network page (0x420190); [I] "Sök nätspel" (the public lobby list) is the port's addition. */
const NET_ITEMS = ['Starta nätspel', 'Anslut', 'Sök nätspel'];
/**
 * [I] The unofficial rule sets the host cycles through in the waiting room (not in the original):
 * punching, cart theft, or both.
 */
const RULE_SETS: Array<[string, NetRules]> = [
  ['Originalregler', { punch: false, grabCarts: false }],
  ['Slag', { punch: true, grabCarts: false }],
  ['Vagnstöld', { punch: false, grabCarts: true }],
  ['Slag och stöld', { punch: true, grabCarts: true }],
];
const ruleSet = (r: NetRules): number => RULE_SETS.findIndex(([, s]) => s.punch === r.punch && s.grabCarts === r.grabCarts);
/** Character card (256 x 256 texels): the text panel inside the frame, and a margin column / row free of text. */
const CARD_INNER = [14, 16, 242, 240];
const CARD_MARGIN = [24, 26];
/** Rows shown on the lobby list page. */
const LIST_ROWS = 7;
/** Network games are Varujakten, Matkrig or Vagnrace (range 2..4 on the host page 0x420820). */
const NET_MODES = [GameMode.Varujakten, GameMode.Matkrig, GameMode.Vagnrace];
/** [I] The original reports nothing; these show on a banner under the join and network pages. */
const NET_ERRORS: Record<ErrorReason | 'offline' | 'closed', string> = {
  nolobby: 'Hittar ingen lobby',
  full: 'Lobbyn är full',
  racing: 'Loppet har redan börjat',
  bad: 'Fel från servern',
  offline: 'Ingen kontakt med servern',
  closed: 'Kontakten bröts',
};
const NET_NAME_KEY = 'mm.netName';

/**
 * Intro_Page (0x41ae50): picture i is shown from INTRO[i][0] to INTRO[i][1] ms, black between,
 * then the main page. Space skips.
 */
const INTRO: Array<[number, number]> = [
  [0, 2500],
  [2590, 3590],
  [3680, 6180],
  [6270, 7270],
  [7360, 9860],
  [9950, 17450],
];

/** Name entry (0x41d320) accepts letters (also å ä ö Å Ä Ö), digits, '.', ' ' and '_', 13 at most. */
const NAME_CHARS = /^[a-zA-Z0-9åäöÅÄÖ. _]$/;
const NAME_LENGTH = 13;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Record times are hundredths of a second, shown as "MM:SS:HH". */
const formatTime = (t: number) => `${pad2(Math.trunc(t / 6000))}:${pad2(Math.trunc(t / 100) % 60)}:${pad2(t % 100)}`;

const isLower = (ch: string) => (ch >= 'a' && ch <= 'z') || ch === 'å' || ch === 'ä' || ch === 'ö';

/** Menu text is split into runs: lowercase letters use the small font, the rest the big one. */
function runs(s: string): Array<{ text: string; lower: boolean }> {
  const out: Array<{ text: string; lower: boolean }> = [];
  for (const ch of s) {
    const lower = isLower(ch);
    const last = out[out.length - 1];
    if (last && last.lower === lower) last.text += ch;
    else out.push({ text: ch, lower });
  }
  return out;
}

export class Menu {
  private page: Page = 'intro';
  private introMs = 0;
  private mainSel = 0;
  private modeSel = 0;
  private mode = GameMode.Varujakten;
  private character = 0;
  private mall = 0;
  private optionSel = 0;
  private recordsMall = 0;
  /** Sign slide: DAT_0045a6ec eases towards DAT_0045a6f0 (0x1ff on the main and mode pages). */
  private signs = 0;
  /** Arrow wobble phase (+0.3 per frame). */
  private wobble = 0;
  /** The new record being named (DAT_0045d468..474) and the typed name (DAT_0045d3bc). */
  private naming: { table: RecordTable; mall: number; place: number } | null = null;
  private typed = '';
  /** Cursor blink counter (DAT_0045d40c, "_" shown while count % 25 < 15). */
  private blink = 0;
  // Network pages: the selected rows (DAT_0045d4a0 / 4ac / 4b8 / 4bc), the shared name field
  // (DAT_0045a3b8), the lobby code typed on the join page and the lobby as the server sees it.
  private netSel = 0;
  private hostSel = 0;
  private joinSel = 0;
  private waitSel = 0;
  private netMall = 0;
  private netMode = 0;
  private netName = '';
  private netCode = '';
  private netMessage = '';
  private lobby: LobbyState | null = null;
  /** Host page: list the lobby for everyone ("Offentlig") or code only ("Privat"). */
  private netPublic = true;
  /** Lobby list page: the public lobbies, the selected row, frames until the next refresh. */
  private lobbies: PublicLobby[] = [];
  private listSel = 0;
  private listRefresh = 0;
  /** Waiting for the server's answer to create/join. */
  private netBusy = false;

  constructor(
    private readonly a: MenuAssets,
    private readonly flag: MenuFlag,
    private readonly preview: CharacterPreview,
    private readonly progress: Progress,
    private readonly records: Records | null,
    private readonly host: MenuHost,
  ) {
    // Local development: skip the intro pictures (logos) and start on the main page.
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) this.page = 'main';
    try {
      this.netName = localStorage.getItem(NET_NAME_KEY) ?? '';
    } catch {
      /* storage unavailable */
    }
  }

  // ---- network ----

  /** The server's lobby state: opens (or refreshes) the waiting room. */
  /** The server's public lobby list. */
  netLobbies(list: PublicLobby[]): void {
    this.lobbies = list;
    this.listSel = Math.min(this.listSel, Math.max(0, list.length - 1));
  }

  netLobby(state: LobbyState): void {
    // The host starts on Starta, below the rules row.
    if (this.page !== 'netWait') this.waitSel = 1;
    this.lobby = state;
    this.netBusy = false;
    this.netMessage = '';
    if (this.page !== 'intro' && this.page !== 'quit') this.page = 'netWait';
  }

  netError(reason: ErrorReason | 'offline' | 'closed'): void {
    this.netBusy = false;
    this.netMessage = NET_ERRORS[reason];
    this.host.play(SND.error);
    if (reason === 'closed' || this.page === 'netWait') {
      this.lobby = null;
      this.page = 'net';
    }
  }

  /** This machine left its lobby (Esc during a network race). */
  netLeft(): void {
    this.lobby = null;
    this.netMessage = '';
  }

  /** Back from a network race: the waiting room. */
  showWait(): void {
    this.page = this.lobby ? 'netWait' : 'net';
  }

  private saveNetName(): void {
    try {
      localStorage.setItem(NET_NAME_KEY, this.netName);
    } catch {
      /* storage unavailable */
    }
  }

  /** Back from a race: the main page (the original resumes at DAT_0045a710 when set). */
  showMain(): void {
    this.page = 'main';
  }

  /**
   * After a new best time the game resumes the menu in 0x41dcb0 (Frågesport) / 0x41de40
   * (Vagnrace): the lower entries move down (here Records.submit already inserted the time), the
   * name is cleared, and the name entry page opens.
   */
  enterName(table: RecordTable, mall: number, place: number): void {
    this.naming = { table, mall, place };
    this.typed = '';
    this.page = 'name';
  }

  /** [I] Quitting cannot close a browser tab, so the game starts over with the intro. */
  restartIntro(): void {
    this.page = 'intro';
    this.introMs = 0;
  }

  get showingIntro(): boolean {
    return this.page === 'intro';
  }

  // ---- text ----

  private font(lower: boolean, selected: boolean): HudFont {
    const f = this.a.fonts;
    return lower ? (selected ? f.smallSel : f.small) : selected ? f.bigSel : f.big;
  }

  private width(s: string): number {
    return runs(s).reduce((w, r) => w + textWidth(this.font(r.lower, false).font, r.text), 0);
  }

  private text(hud: Hud2D, x: number, y: number, s: string, selected: boolean): void {
    for (const r of runs(s)) x = hud.text(this.font(r.lower, selected), x, y, r.text, 'center');
  }

  /** Item lists (main, mode): right-aligned at x = 550, y = 190 + 41 i. */
  private items(hud: Hud2D, items: string[], selected: number): void {
    items.forEach((s, i) => this.text(hud, 550 - this.width(s), 190 + 41 * i, s, i === selected));
  }

  private sprite(hud: Hud2D, atlas: Atlas, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number): void {
    if (x1 <= x0) return;
    hud.sprite(atlas, x0, y0, x1, y1, u0, v0, u1, v1, 'center');
  }

  private tinyCentered(hud: Hud2D, cx: number, y: number, s: string): void {
    const f = this.a.fonts.tiny;
    hud.text(f, cx - Math.trunc(textWidth(f.font, s) / 2), y, s, 'center');
  }

  // ---- frame ----

  /** One 25 ms menu frame. */
  step(dt: number): void {
    if (this.page === 'intro') {
      this.introMs += dt * 25;
      if (this.introMs >= INTRO[INTRO.length - 1][1]) this.page = 'main';
      return;
    }
    if (this.page === 'quit') return;
    this.flag.step(dt);
    this.wobble += dt * 0.3;
    // The network page (0x420190) also sets 0x1ff.
    const target = this.page === 'main' || this.page === 'mode' || this.page === 'net' ? 0x1ff : 0;
    this.signs = Math.trunc((target + this.signs * 2) / 3);
    // The lobby list refreshes every 2 s (80 frames of 25 ms).
    if (this.page === 'netList' && --this.listRefresh <= 0) {
      this.listRefresh = 80;
      this.host.netList();
    }
    if (this.page === 'character') {
      this.signs = 0;
      this.preview.show(this.character, !this.unlocked(this.character));
      this.preview.step(dt);
    }
  }

  /** Draw the WebGL parts (cloth, 3D character) and the 2D overlay. */
  draw(hud: Hud2D, renderer: THREE.WebGLRenderer, view: { x: number; y: number; w: number; h: number }): void {
    renderer.clear();
    if (this.page === 'intro') {
      const shown = INTRO.findIndex(([from, to]) => this.introMs >= from && this.introMs < to);
      if (shown >= 0) this.fullScreen(hud, this.a.intro[shown]);
      return;
    }
    if (this.page === 'quit') {
      this.fullScreen(hud, this.a.quit);
      return;
    }
    this.flag.render(renderer);
    this.drawSigns(hud);
    switch (this.page) {
      case 'main':
        this.items(hud, MAIN_ITEMS, this.mainSel);
        break;
      case 'mode':
        this.items(
          hud,
          MODE_ITEMS.map(([s]) => s),
          this.modeSel,
        );
        break;
      case 'character':
        this.preview.render(renderer, view.x, view.y, view.w, view.h);
        this.drawCharacter(hud);
        break;
      case 'mall':
        this.drawMall(hud);
        break;
      case 'options':
        this.drawOptions(hud);
        break;
      case 'records':
        this.drawRecords(hud);
        break;
      case 'name':
        this.drawNameEntry(hud);
        break;
      case 'net':
        this.items(hud, NET_ITEMS, this.netSel);
        this.netBanner(hud, 400);
        break;
      case 'netHost':
        this.drawNetHost(hud);
        break;
      case 'netJoin':
        this.drawNetJoin(hud);
        break;
      case 'netWait':
        this.drawNetWait(hud);
        break;
      case 'netList':
        this.drawNetList(hud);
        break;
    }
  }

  private fullScreen(hud: Hud2D, img: Atlas): void {
    hud.sprite(img, 0, 0, 640, 480, 0, 0, img.canvas.width, img.canvas.height, 'center');
  }

  /**
   * The Mall Maniacs sign (three quads) slides in from the left with cur = DAT_0045a6ec:
   * sign100 at x 0..cur-256, sign200 at cur-256..cur-72, the post (sign300) at cur-318..cur-239,
   * y 255..478. Each shows the right-hand part of its texture while it slides in.
   */
  private drawSigns(hud: Hud2D): void {
    const cur = this.signs;
    const [s1, s2, s3] = this.a.signs;
    const a = cur - 256;
    if (a >= 0) this.sprite(hud, s1, 0, 0, a, 255, 255 - a, 0, 255, 255);
    const b = cur - 72;
    if (b >= 0) this.sprite(hud, s2, Math.max(a, 0), 0, b, 255, b < 185 ? 184 - b : 0, 0, 184, 255);
    const c = cur - 239;
    this.sprite(hud, s3, Math.max(cur - 318, 0), 255, c, 478, c < 80 ? 79 - c : 0, 0, 79, 223);
  }

  /** Character page (0x41efa0). */
  private drawCharacter(hud: Hud2D): void {
    const i = this.character;
    const unlocked = this.unlocked(i);
    const name = characterName(i);
    const half = Math.trunc(this.width(name) / 2);
    this.text(hud, 320 - half, 10, name, true);
    const w = Math.trunc(Math.sin(this.wobble) * 5);
    this.sprite(hud, this.a.gfx, 260 - half + w, 5, 303 - half + w, 48, 88, 51, 131, 94);
    this.sprite(hud, this.a.gfx, 336 + half - w, 5, 379 + half - w, 48, 132, 51, 175, 94);
    const custom = customCharacter(i);
    this.sprite(hud, custom ? this.customCard(custom) : unlocked ? this.a.cards[i] : this.a.lockedCard, 10, 60, 265, 315, 0, 0, 255, 255);
    ['Snabbhet', 'Styrka', 'Smidighet'].forEach((label, k) => {
      const y = 326 + 50 * k;
      this.text(hud, 285, y, label, true);
      this.sprite(hud, this.a.gfx, 10, y, 265, y + 23, 0, 95, 255, 118);
      if (unlocked) {
        const s = characterStats(i)[k] * 46;
        this.sprite(hud, this.a.gfx, 22, y + 10, 23 + s, y + 15, 0, 119, 1 + s, 124);
      }
    });
  }

  /** ICA logo and the level00 name strip (row = mall). */
  private mallHeader(hud: Hud2D, mall: number, y: number): void {
    this.sprite(hud, this.a.gfx, 152, y + 6, 215, y + 45, 176, 51, 239, 91);
    this.sprite(hud, this.a.levels, 232, y, 487, y + 51, 0, 51 * mall, 255, 51 * (mall + 1));
  }

  /** Mall page (0x41b900): the picture is secN00 while the mall is locked. */
  private drawMall(hud: Hud2D): void {
    const i = this.mall;
    this.mallHeader(hud, i, 50);
    const pic = mallUnlocked(i, this.progress.toplevel) ? this.a.malls[i] : this.a.lockedMalls[i];
    this.sprite(hud, pic, 192, 151, 447, 406, 0, 0, 255, 255);
    const w = Math.trunc(Math.sin(this.wobble) * 5);
    if (i > 0) this.sprite(hud, this.a.gfx, 132 + w, 256, 175 + w, 299, 0, 51, 43, 94);
    if (i < MALL_COUNT - 1) this.sprite(hud, this.a.gfx, 464 - w, 256, 507 - w, 299, 44, 51, 87, 94);
  }

  /** Options page (0x41c6a0): Svårighetsgrad and Grafik with arrows on the selected row. */
  private drawOptions(hud: Hud2D): void {
    this.text(hud, 172, 50, 'Svårighetsgrad', this.optionSel === 0);
    this.text(hud, 172, 155, 'Grafik', this.optionSel === 1);
    [89, 194].forEach((y, row) => {
      const sel = this.optionSel === row;
      const w = sel ? Math.trunc(Math.sin(this.wobble) * 5) : 0;
      const u = sel ? 0 : 88;
      this.sprite(hud, this.a.gfx, 142 + w, y, 185 + w, y + 43, u, 51, u + 43, 94);
      this.sprite(hud, this.a.gfx, 454 - w, y, 497 - w, y + 43, u + 44, 51, u + 87, 94);
    });
    const d = this.progress.difficulty;
    this.sprite(hud, this.a.gfx, 192, 85, 447, 136, 0, 0, 255, 50);
    this.tinyCentered(hud, 320, 103, DIFFICULTY_NAMES[d]);
    this.sprite(hud, this.a.gfx, 412, 105, 438, 131, 101 + 26 * d, 125, 126 + 26 * d, 150);
    this.sprite(hud, this.a.gfx, 192, 190, 447, 241, 0, 0, 255, 50);
    // DAT_0045a390: 1 = Glide (3DFX Voodoo), 2 = software (Mjukvara); here the retro mode.
    this.tinyCentered(hud, 320, 208, this.host.retro() ? 'Mjukvara' : '3DFX Voodoo');
  }

  /** Records page (0x41dfd0): Frågesport (fshi) and Vagnrace (vahi) best times for one mall. */
  private drawRecords(hud: Hud2D): void {
    this.text(hud, 60, 80, 'Frågesport', true);
    this.text(hud, 410, 80, 'Vagnrace', true);
    this.mallHeader(hud, this.recordsMall, 10);
    if (this.progress.toplevel > 0) {
      const w = Math.trunc(Math.sin(this.wobble) * 5);
      this.sprite(hud, this.a.gfx, 92 + w, 15, 135 + w, 58, 88, 51, 131, 94);
      this.sprite(hud, this.a.gfx, 504 - w, 15, 547 - w, 58, 132, 51, 175, 94);
    }
    (['fshi', 'vahi'] as RecordTable[]).forEach((table, col) => {
      const list = this.records?.list(table, this.recordsMall) ?? [];
      const ox = 320 * col;
      for (let r = 0; r < 5; r++) {
        const e = list[r] ?? { name: '', time: 0, face: 0, diff: 0 };
        const y = 130 + 70 * r;
        this.sprite(hud, this.a.gfx, 50 + ox, y, 305 + ox, y + 51, 0, 0, 255, 50);
        this.tinyCentered(hud, 178 + ox, y + 18, `${e.name}   ${formatTime(Math.max(0, Math.trunc(e.time)))}`);
        const f = faceSprite(e.face, this.a.faces);
        this.sprite(hud, f.atlas, 10 + ox, y, 73 + ox, y + 63, f.u, f.v, f.u + 63, f.v + 63);
        const d = Math.max(0, Math.min(2, e.diff));
        this.sprite(hud, this.a.gfx, 280 + ox, y + 20, 306 + ox, y + 46, 101 + 26 * d, 125, 126 + 26 * d, 150);
      }
    });
  }

  /**
   * Name entry page (0x41d320): the table's header at y 20 and its five entries at y 80 + 60 r in
   * gfx00 frames; the new entry shows the typed name and a blinking "_".
   */
  private drawNameEntry(hud: Hud2D): void {
    const n = this.naming;
    if (!n) return;
    const header = n.table === 'fshi' ? 'Frågesport' : 'Vagnrace';
    this.text(hud, 320 - Math.trunc(this.width(header) / 2), 20, header, true);
    const list = this.records?.list(n.table, n.mall) ?? [];
    const tiny = this.a.fonts.tiny;
    this.blink++;
    for (let r = 0; r < 5; r++) {
      const y = 80 + 60 * r;
      this.sprite(hud, this.a.gfx, 192, y, 447, y + 51, 0, 0, 255, 50);
      if (r === n.place) {
        const w = textWidth(tiny.font, this.typed);
        hud.text(tiny, 320 - Math.trunc(w / 2), y + 18, this.typed, 'center');
        if (this.blink % 25 < 15) hud.text(tiny, 320 + Math.trunc(w / 2), y + 18, '_', 'center');
      } else {
        const e = list[r];
        this.tinyCentered(hud, 320, y + 18, e ? `${e.name}   ${formatTime(Math.max(0, Math.trunc(e.time)))}` : '');
      }
    }
  }

  /** A gfx00 frame with centred tinyfont text (the value banners of the option-style pages). */
  private banner(hud: Hud2D, x: number, y: number, s: string): void {
    this.sprite(hud, this.a.gfx, x, y, x + 255, y + 51, 0, 0, 255, 50);
    this.tinyCentered(hud, x + 128, y + 18, s);
  }

  /** [I] The last network error, if any. */
  private netBanner(hud: Hud2D, y: number, x = 192): void {
    if (this.netMessage) this.banner(hud, x, y, this.netMessage);
    else if (this.netBusy) this.banner(hud, x, y, 'Ansluter...');
  }

  /** Left/right arrows of an option row (as on the options page); the selected row wobbles. */
  private rowArrows(hud: Hud2D, y: number, selected: boolean): void {
    const w = selected ? Math.trunc(Math.sin(this.wobble) * 5) : 0;
    const u = selected ? 0 : 88;
    this.sprite(hud, this.a.gfx, 142 + w, y, 185 + w, y + 43, u, 51, u + 43, 94);
    this.sprite(hud, this.a.gfx, 454 - w, y, 497 - w, y + 43, u + 44, 51, u + 87, 94);
  }

  /** A text field: the typed text centred on its banner, with the blinking cursor when active. */
  private field(hud: Hud2D, y: number, value: string, active: boolean): void {
    this.sprite(hud, this.a.gfx, 192, y, 447, y + 51, 0, 0, 255, 50);
    const tiny = this.a.fonts.tiny;
    const w = textWidth(tiny.font, value);
    hud.text(tiny, 320 - Math.trunc(w / 2), y + 18, value, 'center');
    if (active && this.blink % 25 < 15) hud.text(tiny, 320 + Math.trunc(w / 2), y + 18, '_', 'center');
  }

  /**
   * Host page (0x420820): Karaktär / Bana / Spel / Ditt namn at x 172, each value on a banner 35
   * below, arrows on the choice rows, and Starta at (382, 430). [I] The original spaces its four
   * rows 95 apart; with the added "Lobby" row (Offentlig / Privat) they are 80 apart.
   */
  private drawNetHost(hud: Hud2D): void {
    this.blink++;
    ['Karaktär', 'Bana', 'Spel', 'Ditt namn', 'Lobby'].forEach((label, i) => this.text(hud, 172, 20 + 80 * i, label, this.hostSel === i));
    this.text(hud, 382, 432, 'Starta', this.hostSel === 5);
    [0, 1, 2, 4].forEach((row) => this.rowArrows(hud, 59 + 80 * row, this.hostSel === row));
    this.banner(hud, 192, 55, characterName(this.character));
    this.banner(hud, 192, 135, NET_MALL_NAMES[this.netMall]);
    this.banner(hud, 192, 215, MODE_NAMES[NET_MODES[this.netMode]]);
    this.field(hud, 295, this.netName, this.hostSel === 3);
    this.banner(hud, 192, 375, this.netPublic ? 'Offentlig' : 'Privat');
    this.netBanner(hud, 428, 0);
  }

  /**
   * [I] Lobby list ("Sök nätspel"), drawn like the menu's item lists: column headers, then one line
   * per public lobby (host, mall, players); the selected line uses the highlighted font (as the
   * main menu items do). Up/down moves, ENTER joins with the name and character from the other
   * pages.
   */
  private drawNetList(hud: Hud2D): void {
    const title = 'Sök nätspel';
    this.text(hud, 320 - Math.trunc(this.width(title) / 2), 10, title, true);
    const cols = [30, 250, 480];
    ['Värd', 'Butik', 'Spelare'].forEach((h, c) => this.text(hud, cols[c], 70, h, false));
    if (!this.lobbies.length) this.tinyCentered(hud, 320, 130, 'Inga offentliga lobbyer just nu');
    const first = Math.max(0, Math.min(this.listSel - LIST_ROWS + 1, this.lobbies.length - LIST_ROWS));
    this.lobbies.slice(first, first + LIST_ROWS).forEach((l, i) => {
      const y = 120 + 42 * i;
      const sel = first + i === this.listSel;
      // The selected lobby sits on a gfx00 frame stretched across the list.
      if (sel) this.sprite(hud, this.a.gfx, 15, y - 7, 625, y + 37, 0, 0, 255, 50);
      const mall = NET_MALL_NAMES[l.mall]?.replace(/^ICA /, '') ?? '';
      this.text(hud, cols[0], y, l.host || '?', sel);
      this.text(hud, cols[1], y, mall, sel);
      // The menu fonts have no digits or '/': the count uses the tiny font, as the records do.
      this.tinyCentered(hud, 545, y + 8, `${l.players} av ${MAX_PLAYERS}`);
    });
    this.netBanner(hud, 410);
  }



  /**
   * Join page (0x421a30): Karaktär / Ditt namn / Server address and Starta at (382, 335).
   * [I] The address is the lobby code here.
   */
  private drawNetJoin(hud: Hud2D): void {
    this.blink++;
    ['Karaktär', 'Ditt namn', 'Lobbykod'].forEach((label, i) => this.text(hud, 172, 20 + 95 * i, label, this.joinSel === i));
    this.text(hud, 382, 335, 'Starta', this.joinSel === 3);
    this.rowArrows(hud, 59, this.joinSel === 0);
    this.banner(hud, 192, 55, characterName(this.character));
    this.field(hud, 150, this.netName, this.joinSel === 1);
    this.field(hud, 245, this.netCode, this.joinSel === 2);
    this.netBanner(hud, 400);
  }

  /**
   * Waiting rooms: the host's (0x422ec0) and a client's (0x423f20). Players fill two columns of
   * four: a banner at (45 + 320 c, 15 + 80 r) with the name, the char00 face at (320 c, 10 + 80 r).
   * The "waiting" banner is at (365, 255); the mode name at (20, 370) and the mall strip at
   * (20, 410); the host has Starta / Avbryt, a client only Avbryt.
   */
  private drawNetWait(hud: Hud2D): void {
    const lobby = this.lobby;
    if (!lobby) return;
    lobby.players.forEach((p, i) => {
      const c = i % 2, r = Math.trunc(i / 2);
      const x = 320 * c, y = 80 * r;
      this.sprite(hud, this.a.gfx, x + 45, y + 15, x + 300, y + 66, 0, 0, 255, 50);
      this.tinyCentered(hud, x + 173, y + 33, p.name);
      // Custom characters show where installed here, else their base character.
      const f = faceSprite(customById(p.custom?.id)?.index ?? p.character, this.a.faces);
      this.sprite(hud, f.atlas, x, y + 10, x + 63, y + 73, f.u, f.v, f.u + 63, f.v + 63);
    });
    const hosting = lobby.host === lobby.you;
    // [I] Hidden when the eighth player's banner takes its place.
    if (lobby.players.length < 8) {
      this.sprite(hud, this.a.gfx, 365, 255, 620, 306, 0, 0, 255, 50);
      this.tinyCentered(hud, 493, 273, hosting ? 'Väntar på andra spelare...' : 'Väntar på startsignal...');
    }
    // [I] The code the others type on the join page, and the rules (the host picks them here).
    const code = `Kod ${lobby.code}`;
    this.text(hud, 550 - this.width(code), 312, code, false);
    const rules = RULE_SETS[Math.max(0, ruleSet(lobby.rules))][0];
    const items = hosting ? [rules, 'Starta', 'Avbryt'] : ['Avbryt'];
    if (!hosting) this.text(hud, 550 - this.width(rules), 352, rules, false);
    const sel = Math.min(this.waitSel, items.length - 1);
    items.forEach((s, i) => this.text(hud, 550 - this.width(s), 432 - 40 * (items.length - 1 - i), s, i === sel));
    this.text(hud, 20, 370, MODE_NAMES[lobby.mode as GameMode] ?? '', false);
    this.sprite(hud, this.a.levels, 20, 410, 275, 461, 0, 51 * lobby.mall, 255, 51 * (lobby.mall + 1));
  }

  // ---- keys ----

  key(k: MenuKey): void {
    const play = (id: number) => this.host.play(id);
    switch (this.page) {
      case 'intro':
        if (k === 'space' || k === 'enter') this.page = 'main';
        return;
      case 'main':
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.mainSel = (this.mainSel + (k === 'up' ? 4 : 1)) % 5;
        } else if (k === 'enter') {
          play(SND.select);
          this.page = (['mode', 'net', 'options', 'records', 'quit'] as Page[])[this.mainSel];
          this.netMessage = '';
          if (this.page === 'records') this.recordsMall = Math.min(this.recordsMall, Math.min(this.progress.toplevel, MALL_COUNT - 1));
        } else if (k === 'esc') this.page = 'quit';
        return;
      case 'mode':
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.modeSel = (this.modeSel + (k === 'up' ? 3 : 1)) % 4;
        } else if (k === 'enter') {
          play(SND.select);
          this.mode = MODE_ITEMS[this.modeSel][1];
          this.page = 'character';
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'main';
        }
        return;
      case 'character':
        if (k === 'left' || k === 'right') {
          play(SND.value);
          const n = characterTotal();
          this.character = (this.character + (k === 'left' ? n - 1 : 1)) % n;
        } else if (k === 'up' || k === 'down') play(SND.move);
        else if (k === 'enter') {
          play(SND.select);
          // 0x41ef40: a locked character only gets the error sound.
          if (!this.unlocked(this.character)) return play(SND.error);
          this.mall = Math.min(this.mall, MALL_COUNT - 1);
          this.page = 'mall';
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'mode';
        }
        return;
      case 'mall':
        if (k === 'left' || k === 'right') {
          play(SND.value);
          this.mall = Math.max(0, Math.min(MALL_COUNT - 1, this.mall + (k === 'left' ? -1 : 1)));
        } else if (k === 'enter') {
          if (!mallUnlocked(this.mall, this.progress.toplevel)) return play(SND.error);
          play(SND.select);
          this.host.start({ mode: this.mode, mall: this.mall, character: this.character, difficulty: this.progress.difficulty });
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'character';
        }
        return;
      case 'options':
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.optionSel = 1 - this.optionSel;
        } else if (k === 'left' || k === 'right') {
          const up = k === 'right';
          if (this.optionSel === 0) {
            const d = this.progress.difficulty + (up ? 1 : -1);
            if (d < 0 || d > 2) return;
            play(SND.value);
            this.progress.difficulty = d;
            this.progress.save();
          } else {
            const retro = !up;
            if (retro === this.host.retro()) return;
            play(SND.value);
            this.host.setRetro(retro);
          }
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'main';
        }
        return;
      case 'records': {
        const last = Math.min(this.progress.toplevel, MALL_COUNT - 1);
        if ((k === 'left' || k === 'right') && last > 0) {
          this.recordsMall = (this.recordsMall + (k === 'left' ? last : 1)) % (last + 1);
        } else if (k === 'esc' || k === 'enter') {
          play(SND.back);
          this.page = 'main';
        }
        return;
      }
      case 'net':
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.netSel = (this.netSel + (k === 'up' ? NET_ITEMS.length - 1 : 1)) % NET_ITEMS.length;
        } else if (k === 'enter') {
          play(SND.select);
          this.netMessage = '';
          this.netBusy = false;
          // Both pages offer the unlocked characters only, the host page the open malls.
          if (!this.unlocked(this.character)) this.character = 0;
          this.netMall = Math.min(this.netMall, this.progress.toplevel, MALL_COUNT - 1);
          this.page = (['netHost', 'netJoin', 'netList'] as Page[])[this.netSel];
          if (this.page === 'netList') {
            this.lobbies = [];
            this.listSel = 0;
            this.listRefresh = 0;
          }
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'main';
        }
        return;
      case 'netHost': {
        const ranges = [0, Math.min(this.progress.toplevel, MALL_COUNT - 1), NET_MODES.length - 1];
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.hostSel = (this.hostSel + (k === 'up' ? 5 : 1)) % 6;
        } else if ((k === 'left' || k === 'right') && this.hostSel === 4) {
          play(SND.value);
          this.netPublic = !this.netPublic;
        } else if ((k === 'left' || k === 'right') && this.hostSel === 0) {
          if (!this.stepCharacter(k === 'right' ? 1 : -1)) return;
          play(SND.value);
        } else if ((k === 'left' || k === 'right') && this.hostSel < 3) {
          const values = [this.character, this.netMall, this.netMode];
          const v = values[this.hostSel] + (k === 'right' ? 1 : -1);
          if (v < 0 || v > ranges[this.hostSel]) return;
          play(SND.value);
          if (this.hostSel === 0) this.character = v;
          else if (this.hostSel === 1) this.netMall = v;
          else this.netMode = v;
        } else if (k === 'enter' && this.hostSel === 5 && !this.netBusy) {
          play(SND.select);
          this.saveNetName();
          this.netBusy = true;
          this.netMessage = '';
          this.host.netCreate(this.netName, this.character, this.netMall, NET_MODES[this.netMode], this.netPublic);
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'net';
        }
        return;
      }
      case 'netList':
        if ((k === 'up' || k === 'down') && this.lobbies.length) {
          play(SND.move);
          this.listSel = (this.listSel + (k === 'up' ? this.lobbies.length - 1 : 1)) % this.lobbies.length;
        } else if (k === 'enter' && !this.netBusy) {
          const l = this.lobbies[this.listSel];
          if (!l) return play(SND.error);
          play(SND.select);
          this.netBusy = true;
          this.netMessage = '';
          this.host.netJoin(l.code, this.netName, this.character);
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'net';
        }
        return;
      case 'netJoin':
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.joinSel = (this.joinSel + (k === 'up' ? 3 : 1)) % 4;
        } else if ((k === 'left' || k === 'right') && this.joinSel === 0) {
          if (!this.stepCharacter(k === 'right' ? 1 : -1)) return;
          play(SND.value);
        } else if (k === 'enter' && this.joinSel === 3 && !this.netBusy) {
          if (this.netCode.length !== CODE_LENGTH) return play(SND.error);
          play(SND.select);
          this.saveNetName();
          this.netBusy = true;
          this.netMessage = '';
          this.host.netJoin(this.netCode, this.netName, this.character);
        } else if (k === 'esc') {
          play(SND.back);
          this.page = 'net';
        }
        return;
      case 'netWait': {
        const hosting = !!this.lobby && this.lobby.host === this.lobby.you;
        const count = hosting ? 3 : 1;
        if (k === 'up' || k === 'down') {
          play(SND.move);
          this.waitSel = (Math.min(this.waitSel, count - 1) + (k === 'up' ? count - 1 : 1)) % count;
        } else if (hosting && this.waitSel === 0 && (k === 'left' || k === 'right' || k === 'enter') && this.lobby) {
          play(SND.value);
          const n = RULE_SETS.length;
          const i = (Math.max(0, ruleSet(this.lobby.rules)) + (k === 'left' ? n - 1 : 1)) % n;
          this.host.netRules({ ...RULE_SETS[i][1] });
        } else if (k === 'enter') {
          if (hosting && this.waitSel === 1) {
            play(SND.select);
            this.host.netStart();
          } else {
            play(SND.back);
            this.leaveLobby();
          }
        } else if (k === 'esc') {
          play(SND.back);
          this.leaveLobby();
        }
        return;
      }
      case 'name':
      case 'quit':
        return;
    }
  }

  private readonly customCards = new Map<CustomCharacter, Atlas>();

  /**
   * [I] A custom character's card: the base character's card with its text painted over by its
   * background (sampled from the margins left of and above the text) and the JSON description
   * written in its place.
   */
  private customCard(c: CustomCharacter): Atlas {
    let card = this.customCards.get(c);
    if (card) return card;
    const src = this.a.cards[c.base].canvas;
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const s = canvas.width / 256;
    const [x0, y0, x1, y1] = [CARD_INNER[0] * s, CARD_INNER[1] * s, CARD_INNER[2] * s, CARD_INNER[3] * s].map(Math.round);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const at = (x: number, y: number) => (y * canvas.width + x) * 4;
    const lx = Math.round(CARD_MARGIN[0] * s), ty = Math.round(CARD_MARGIN[1] * s);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        // Separable background: the margin column's colour for this row plus the margin row's
        // change along x.
        const mx = x < canvas.width / 2 ? x : canvas.width - 1 - x;
        const row = at(lx, y), colTop = at(mx, ty), corner = at(lx, ty), o = at(x, y);
        for (let k = 0; k < 3; k++) d[o + k] = d[row + k] + d[colTop + k] - d[corner + k];
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'rgb(220, 220, 220)';
    ctx.font = `${13 * s}px "Comic Sans MS", "Comic Neue", cursive`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const words = c.description.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last !== undefined && ctx.measureText(`${last} ${w}`).width <= (x1 - x0) - 40 * s) lines[lines.length - 1] = `${last} ${w}`;
      else lines.push(w);
    }
    lines.forEach((l, n) => ctx.fillText(l, canvas.width / 2, (CARD_MARGIN[1] + 12 + 14 * n) * s));
    card = { canvas };
    this.customCards.set(c, card);
    return card;
  }

  /** Originals as the toplevel allows; custom characters are always open. */
  private unlocked(index: number): boolean {
    return index >= CHARACTER_NAMES.length || characterUnlocked(index, this.progress.toplevel);
  }

  /** Network pages: the previous / next open character (no wrap); false at the ends. */
  private stepCharacter(d: number): boolean {
    for (let v = this.character + d; v >= 0 && v < characterTotal(); v += d) {
      if (!this.unlocked(v)) continue;
      this.character = v;
      return true;
    }
    return false;
  }

  private leaveLobby(): void {
    this.host.netLeave();
    this.lobby = null;
    this.page = 'net';
  }

  /** Typing in a network text field (the name, or the join page's lobby code). */
  private netText(e: KeyboardEvent): boolean {
    const nameField = (this.page === 'netHost' && this.hostSel === 3) || (this.page === 'netJoin' && this.joinSel === 1);
    const codeField = this.page === 'netJoin' && this.joinSel === 2;
    if (!nameField && !codeField) return false;
    if (e.code === 'Backspace') {
      if (nameField) this.netName = this.netName.slice(0, -1);
      else this.netCode = this.netCode.slice(0, -1);
    } else if (e.key.length === 1 && nameField && NAME_CHARS.test(e.key) && this.netName.length < NET_NAME_LENGTH) this.netName += e.key;
    else if (e.key.length === 1 && codeField && CODE_ALPHABET.includes(e.key.toUpperCase()) && this.netCode.length < CODE_LENGTH) this.netCode += e.key.toUpperCase();
    else return false;
    e.preventDefault();
    return true;
  }

  /** [I] The page wants typed text (touch controls show a keyboard button). */
  wantsText(): boolean {
    return this.page === 'name' || (this.page === 'netHost' && this.hostSel === 3) || (this.page === 'netJoin' && (this.joinSel === 1 || this.joinSel === 2));
  }

  /** Quit page (0x4200b0): J/Y quits, any other key goes back to the main page. */
  rawKey(e: KeyboardEvent): boolean {
    if (this.netText(e)) return true;
    if (this.page === 'name') {
      const n = this.naming;
      if (e.code === 'Backspace') this.typed = this.typed.slice(0, -1);
      else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && n && !e.repeat) {
        // Save the entry and show the records page of that mall.
        this.records?.rename(n.table, n.mall, n.place, this.typed);
        this.host.play(SND.select);
        this.recordsMall = n.mall;
        this.naming = null;
        this.page = 'records';
      } else if (e.key.length === 1 && NAME_CHARS.test(e.key) && this.typed.length < NAME_LENGTH) this.typed += e.key;
      e.preventDefault();
      return true;
    }
    if (this.page !== 'quit') return false;
    if (e.code === 'KeyJ' || e.code === 'KeyY') this.host.quit();
    else this.page = 'main';
    return true;
  }
}
