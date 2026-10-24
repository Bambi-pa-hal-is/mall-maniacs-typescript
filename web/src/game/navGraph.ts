import type { DffBlock } from '../formats/dff';

/**
 * Navigation buoys from a mall's *.ai file (NavBuoys_Load 0x407e10). Coordinates are engine X/Y/Z.
 */
export interface NavNode {
  id: number;
  x: number;
  y: number;
  z: number;
  links: NavNode[];
}

export class NavGraph {
  readonly nodes: NavNode[] = [];
  private readonly byId = new Map<number, NavNode>();
  /** cost-to-destination tables, keyed by destination id */
  private readonly costCache = new Map<number, Map<NavNode, number>>();

  constructor(file: DffBlock) {
    const linkIds = new Map<NavNode, number[]>();
    for (const [, b] of file.children) {
      if (!b.has('ID')) continue;
      const node: NavNode = { id: b.num('ID'), x: b.num('X'), y: b.num('Y'), z: b.num('Z'), links: [] };
      this.nodes.push(node);
      this.byId.set(node.id, node);
      linkIds.set(node, (b.optBlock('LINKS')?.all('LINK') ?? []).map(Number));
    }
    linkIds.forEach((ids, node) => {
      for (const id of ids) {
        const other = this.byId.get(id);
        if (other && other !== node) node.links.push(other);
      }
    });
  }

  /**
   * Nearest buoy in the XZ plane among buoys whose height lies strictly inside (yMin, yMax)
   * (NavBuoy_Nearest 0x4259d0). Falls back to the first buoy like the original.
   * Callers pass y-400 .. y+1000 (engine Y is down).
   */
  nearest(x: number, z: number, yMin: number, yMax: number): NavNode | null {
    let best: NavNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (!(yMin < n.y && n.y < yMax)) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best ?? this.nodes[0] ?? null;
  }

  /** Path cost from every buoy to `dest` along links (Dijkstra on the reversed graph). */
  private costs(dest: NavNode): Map<NavNode, number> {
    let table = this.costCache.get(dest.id);
    if (table) return table;
    const reverse = new Map<NavNode, NavNode[]>();
    for (const n of this.nodes) for (const m of n.links) {
      const list = reverse.get(m);
      if (list) list.push(n);
      else reverse.set(m, [n]);
    }
    table = new Map([[dest, 0]]);
    const open: NavNode[] = [dest];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (table.get(open[i])! < table.get(open[bi])!) bi = i;
      const n = open.splice(bi, 1)[0];
      const base = table.get(n)!;
      for (const p of reverse.get(n) ?? []) {
        const c = base + Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z);
        if (c < (table.get(p) ?? Infinity)) {
          if (!table.has(p)) open.push(p);
          table.set(p, c);
        }
      }
    }
    this.costCache.set(dest.id, table);
    return table;
  }

  /** Path cost from a buoy to `dest` (Infinity when unreachable). */
  pathCost(from: NavNode, dest: NavNode): number {
    return this.costs(dest).get(from) ?? Infinity;
  }

  /**
   * Next buoy from `from` towards `dest` (NavBuoy_NextHop 0x425bd0): the linked buoy with the
   * lowest cost to the destination, or null when unreachable.
   */
  nextHop(from: NavNode, dest: NavNode): NavNode | null {
    if (from === dest) return dest;
    const table = this.costs(dest);
    let best: NavNode | null = null;
    let bestC = Infinity;
    for (const m of from.links) {
      const c = table.get(m);
      if (c !== undefined && c < bestC) {
        bestC = c;
        best = m;
      }
    }
    return best;
  }
}
