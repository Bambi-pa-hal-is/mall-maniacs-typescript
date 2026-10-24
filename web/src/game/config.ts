import { loadGameFile } from '../engine/assets';
import { parseDff, type DffBlock } from '../formats/dff';
import { decodeText, xor55 } from '../formats/xor';

export interface LevelConfig {
  index: number;
  name: string;
  scenePath: string;
  sceneFile: string;
  music: number;
  /** { x y z rx ry rz } per player slot, engine units / int16 angles */
  starts: number[][];
  /** Console commands run at level start ("nload ica.ai", "eload ica.eo") */
  startup: string[];
}

export interface CharacterConfig {
  objectName: string;
  charData: number[];
}

export interface CartConfig {
  objectName: string;
  weight: number;
  friction: number;
  objectPos: number[];
  handlePos: number[];
}

export interface MasterConfig {
  acc: number;
  friction: number;
  rotateAcc: number;
  accWC: number;
  rotateAccWC: number;
  objUpdateTime: number;
}

export interface CameraConfig {
  pos: number[];
  aim: number[];
  rotSpeed: number;
  rotMax: number;
}

export interface GameConfig {
  raw: DffBlock;
  levels: LevelConfig[];
  characters: CharacterConfig[];
  carts: CartConfig[];
  items: Array<{ name: string; mesh: string }>;
  master: MasterConfig;
  camera: CameraConfig;
  objSceneFile: string;
  charSceneFile: string;
}

export async function loadGameConfig(): Promise<GameConfig> {
  const text = decodeText(xor55(new Uint8Array(await loadGameFile('maniac.cfg'))));
  const raw = parseDff(text);
  // Mall names only exist as comments ("// Mall 0 - ICA").
  const mallNames = [...text.matchAll(/\/\/\s*Mall\s+(\d+)\s*-\s*(.+)/g)].map((m) => m[2].trim());

  const levels = raw.array('levels').map((b, index) => ({
    index,
    name: mallNames[index] ?? `Mall ${index}`,
    scenePath: b.str('scene_path'),
    sceneFile: b.str('scene_file'),
    music: b.num('music', 0),
    starts: b.array('start_positions').map((s) => s.numbers()),
    startup: b.optBlock('startup')?.strings() ?? [],
  }));

  const objects = raw.block('objects');
  const characters = objects.array('characters').map((c) => ({
    objectName: c.str('object_name'),
    charData: c.optBlock('char_data')?.numbers() ?? [],
  }));
  const carts = objects.array('carts').map((c) => ({
    objectName: c.str('object_name'),
    weight: c.num('weight', 20),
    friction: c.num('friction', 0.99),
    objectPos: c.optBlock('object_pos')?.numbers() ?? [0, 0, 750, 0, 0, 0],
    handlePos: c.optBlock('handle_pos')?.numbers() ?? [],
  }));
  const cam = objects.block('camera');
  const master = raw.block('master');

  return {
    raw,
    levels,
    characters,
    carts,
    items: raw.array('items').map((i) => ({ name: i.str('name', ''), mesh: i.str('mesh', '') })),
    master: {
      acc: master.num('acc'),
      friction: master.num('friction'),
      rotateAcc: master.num('rotate_acc'),
      accWC: master.num('acc_WC'),
      rotateAccWC: master.num('rotate_acc_WC'),
      objUpdateTime: master.num('obj_update_time', 40),
    },
    camera: {
      pos: cam.block('pos').numbers(),
      aim: cam.block('aim').numbers(),
      rotSpeed: cam.num('rot_speed', 20),
      rotMax: cam.num('rot_max', 4),
    },
    objSceneFile: objects.str('obj_scene_file'),
    charSceneFile: objects.str('char_scene_file'),
  };
}
