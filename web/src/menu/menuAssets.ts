import { loadGameFile } from '../engine/assets';
import { atlasFromTpg, type Atlas, type HudFont } from '../engine/hud2d';
import { parseFont } from '../formats/font';
import { parseTga } from '../formats/tga';

/**
 * Menu graphics, loaded like Menu_Init (0x419c20):
 * - fonts: menysmallfont+msfont00 (lowercase runs), menyfont+mfont00 (everything else); the
 *   selected item uses the same descriptors with msfnt200/mfnt200; tinyfont+tiny00 for values
 * - atlases: fling00 (waving background), gfx00 (frames, arrows, ICA logo, smileys, stat bars),
 *   char00 (record faces), level00 (mall name strip), sign100/200/300 (the Mall Maniacs sign)
 * - per mall: smal/wood/orie/aqua/rock00 pictures, sec100..sec500 for locked malls
 * - per character: the portrait cards (table 0x45018c), tom00 for locked characters
 * - full-screen TGAs: the intro pictures and quit.tga
 */
export interface MenuFonts {
  small: HudFont;
  big: HudFont;
  smallSel: HudFont;
  bigSel: HudFont;
  tiny: HudFont;
}

export interface MenuAssets {
  fonts: MenuFonts;
  fling: Atlas;
  gfx: Atlas;
  faces: Atlas;
  levels: Atlas;
  signs: [Atlas, Atlas, Atlas];
  malls: Atlas[];
  lockedMalls: Atlas[];
  cards: Atlas[];
  lockedCard: Atlas;
  intro: Atlas[];
  quit: Atlas;
}

/** Portrait cards per character (0x45018c). */
export const CARD_FILES = ['roland00', 'susanne00', 'oke00', 'agata00', 'hektor00', 'hugo00', 'bosse00', 'klara00', 'kalle00', 'kajsa00'];
const MALL_FILES = ['smal00', 'wood00', 'orie00', 'aqua00', 'rock00'];
/** Intro_Page (0x41ae50) shows these in order. */
const INTRO_FILES = ['intro_addgames', 'intro_och', 'intro_uds', 'intro_samarbete', 'intro_mcd', 'intro_presenterar'];

const tpg = async (name: string) => atlasFromTpg(await loadGameFile(`menu/${name}.tpg`));

async function tga(name: string): Promise<Atlas> {
  const img = parseTga(await loadGameFile(`menu/${name}.tga`));
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  return { canvas };
}

export async function loadMenuAssets(): Promise<MenuAssets> {
  const desc = async (name: string) => parseFont(new Uint8Array(await loadGameFile(`menu/${name}.txt`)));
  const [smallDesc, bigDesc, tinyDesc] = await Promise.all([desc('menysmallfont'), desc('menyfont'), desc('tinyfont')]);
  const [ms, mf, ms2, mf2, tiny] = await Promise.all(['msfont00', 'mfont00', 'msfnt200', 'mfnt200', 'tiny00'].map(tpg));
  const [fling, gfx, faces, levels, s1, s2, s3, lockedCard, quit] = await Promise.all([
    tpg('fling00'),
    tpg('gfx00'),
    tpg('char00'),
    tpg('level00'),
    tpg('sign100'),
    tpg('sign200'),
    tpg('sign300'),
    tpg('tom00'),
    tga('quit'),
  ]);
  const [malls, lockedMalls, cards, intro] = await Promise.all([
    Promise.all(MALL_FILES.map(tpg)),
    Promise.all([1, 2, 3, 4, 5].map((i) => tpg(`sec${i}00`))),
    Promise.all(CARD_FILES.map(tpg)),
    Promise.all(INTRO_FILES.map(tga)),
  ]);
  return {
    fonts: {
      small: { font: smallDesc, atlas: ms },
      big: { font: bigDesc, atlas: mf },
      smallSel: { font: smallDesc, atlas: ms2 },
      bigSel: { font: bigDesc, atlas: mf2 },
      tiny: { font: tinyDesc, atlas: tiny },
    },
    fling,
    gfx,
    faces,
    levels,
    signs: [s1, s2, s3],
    malls,
    lockedMalls,
    cards,
    lockedCard,
    intro,
    quit,
  };
}
