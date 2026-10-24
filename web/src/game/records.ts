import { loadGameFile } from '../engine/assets';
import { parseDff } from '../formats/dff';
import { decodeText, xor55 } from '../formats/xor';

/**
 * Best times per mall for the timed modes, from config.mm (XOR-0x55, saved by the "save" console
 * command): fshi<mall>{name,time,face,diff}<n> for Frågesporten and vahi<mall>... for Vagnrace,
 * five entries each. Times are hundredths of a second (Hud_Draw shows time / 6000 as minutes).
 * The browser keeps its own copy in localStorage; the shipped table is the starting point.
 */
export type RecordTable = 'fshi' | 'vahi';

export interface RecordEntry {
  name: string;
  /** hundredths of a second */
  time: number;
  face: number;
  diff: number;
}

const STORAGE_KEY = 'mm.records';
const ENTRIES = 5;

export class Records {
  private constructor(private readonly tables: Record<string, RecordEntry[]>) {}

  static async load(): Promise<Records> {
    const tables: Record<string, RecordEntry[]> = {};
    try {
      const cfg = parseDff(decodeText(xor55(new Uint8Array(await loadGameFile('config.mm')))));
      for (const t of ['fshi', 'vahi'] as const) {
        for (let mall = 0; mall < 5; mall++) {
          const list: RecordEntry[] = [];
          for (let i = 0; i < ENTRIES; i++) {
            const key = (f: string) => `${t}${mall}${f}${i}`;
            if (!cfg.has(key('time'))) continue;
            list.push({ name: cfg.str(key('name'), ''), time: cfg.num(key('time'), 0), face: cfg.num(key('face'), 0), diff: cfg.num(key('diff'), 0) });
          }
          tables[`${t}${mall}`] = list;
        }
      }
    } catch (err) {
      console.warn('config.mm unavailable', err);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, RecordEntry[]> | null;
      if (saved) Object.assign(tables, saved);
    } catch {
      /* storage unavailable */
    }
    return new Records(tables);
  }

  list(table: RecordTable, mall: number): RecordEntry[] {
    return [...(this.tables[`${table}${mall}`] ?? [])].sort((a, b) => a.time - b.time);
  }

  /** Name entry (0x41d320, Enter): set the name of the entry at a place. */
  rename(table: RecordTable, mall: number, place: number, name: string): void {
    const list = this.list(table, mall);
    if (!list[place]) return;
    list[place] = { ...list[place], name };
    this.tables[`${table}${mall}`] = list;
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tables));
    } catch {
      /* storage unavailable */
    }
  }

  /** Insert a time; returns its place (0-based) when it made the top five, otherwise null. */
  submit(table: RecordTable, mall: number, entry: RecordEntry): number | null {
    const list = this.list(table, mall);
    const place = list.findIndex((e) => entry.time < e.time || e.time < 1);
    const at = place < 0 ? (list.length < ENTRIES ? list.length : -1) : place;
    if (at < 0) return null;
    list.splice(at, 0, entry);
    this.tables[`${table}${mall}`] = list.slice(0, ENTRIES);
    this.save();
    return at;
  }
}
