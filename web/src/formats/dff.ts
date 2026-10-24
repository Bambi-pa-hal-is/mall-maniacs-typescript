/**
 * DFF text format used by maniac.cfg, *.ai (nav buoys), *.eo (event objects) and font files.
 *
 *   key = value            scalar (number or "string"); keys may repeat (LINK = 3, v = 0, ...)
 *   name { ... }           named block; a block may also hold bare values: { 1500 0 9500 0 -32364 0 }
 *   name[] { ... } { ... } array of blocks; also "name[N]" / "name [N]" (*.eo, line [4])
 *   // comment             ';' is treated as whitespace (font files end lines with it)
 */
export type DffScalar = number | string;

export class DffBlock {
  readonly values = new Map<string, DffScalar[]>();
  /** Named sub-blocks in file order (names may repeat, e.g. nav buoy ids). */
  readonly children: Array<[string, DffBlock]> = [];
  readonly arrays = new Map<string, DffBlock[]>();
  readonly list: DffScalar[] = [];

  has(key: string): boolean {
    return this.values.has(key) || this.arrays.has(key) || this.children.some(([k]) => k === key);
  }

  scalar(key: string): DffScalar | undefined {
    return this.values.get(key)?.[0];
  }

  num(key: string, fallback?: number): number {
    const v = this.scalar(key);
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (fallback !== undefined) return fallback;
    throw new Error(`DFF: number '${key}' not found`);
  }

  str(key: string, fallback?: string): string {
    const v = this.scalar(key);
    if (v !== undefined) return String(v);
    if (fallback !== undefined) return fallback;
    throw new Error(`DFF: string '${key}' not found`);
  }

  all(key: string): DffScalar[] {
    return this.values.get(key) ?? [];
  }

  block(key: string): DffBlock {
    const b = this.children.find(([k]) => k === key)?.[1];
    if (!b) throw new Error(`DFF: block '${key}' not found`);
    return b;
  }

  optBlock(key: string): DffBlock | undefined {
    return this.children.find(([k]) => k === key)?.[1];
  }

  array(key: string): DffBlock[] {
    return this.arrays.get(key) ?? [];
  }

  /** Bare values as numbers, e.g. start_positions / object_pos vectors. */
  numbers(): number[] {
    return this.list.map((v) => (typeof v === 'number' ? v : Number(v)));
  }

  strings(): string[] {
    return this.list.map(String);
  }
}

type Token =
  | { kind: 'word'; text: string; num?: number }
  | { kind: 'string'; text: string }
  | { kind: '{' | '}' | '=' | 'eof' };

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (/\s/.test(c) || c === ';') {
      i++;
    } else if (c === '{' || c === '}' || c === '=') {
      out.push({ kind: c });
      i++;
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end < 0 ? n : end;
      out.push({ kind: 'string', text: src.slice(i + 1, stop) });
      i = stop + 1;
    } else {
      let j = i;
      while (j < n && !/[\s{}=;"]/.test(src[j])) j++;
      const text = src.slice(i, j);
      out.push(NUMBER.test(text) ? { kind: 'word', text, num: Number(text) } : { kind: 'word', text });
      i = j;
    }
  }
  out.push({ kind: 'eof' });
  return out;
}

export function parseDff(src: string): DffBlock {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];

  const scalarOf = (t: Token): DffScalar | undefined => {
    if (t.kind === 'string') return t.text;
    if (t.kind === 'word') return t.num ?? t.text;
    return undefined;
  };

  function parseBlock(nested: boolean): DffBlock {
    const block = new DffBlock();
    for (;;) {
      const t = next();
      if (t.kind === 'eof') return block;
      if (t.kind === '}') {
        if (nested) return block;
        continue; // tolerate stray closing braces at top level
      }
      if (t.kind === '=' || t.kind === '{') {
        if (t.kind === '{') block.children.push(['', parseBlock(true)]);
        continue;
      }
      if (t.kind === 'string') {
        block.list.push(t.text);
        continue;
      }
      if (t.kind !== 'word') continue;
      const after = peek();
      // Arrays: "name[]", "name[N]" or "name [N]" followed by blocks.
      const suffix = /\[\d*\]$/.exec(t.text);
      const separate = !suffix && after.kind === 'word' && /^\[\d*\]$/.test(after.text);
      if (suffix || separate) {
        if (separate) next();
        const name = suffix ? t.text.slice(0, suffix.index) : t.text;
        const items: DffBlock[] = block.arrays.get(name) ?? [];
        while (peek().kind === '{') {
          next();
          const item = parseBlock(true);
          items.push(item);
          block.children.push([name, item]);
        }
        block.arrays.set(name, items);
      } else if (after.kind === '=') {
        next();
        const v = scalarOf(next());
        if (v !== undefined) {
          const arr = block.values.get(t.text) ?? [];
          arr.push(v);
          block.values.set(t.text, arr);
        }
      } else if (after.kind === '{') {
        next();
        block.children.push([t.text, parseBlock(true)]);
      } else {
        block.list.push(t.num ?? t.text);
      }
    }
  }

  return parseBlock(false);
}
