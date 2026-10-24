import {
  CODE_ALPHABET,
  CODE_LENGTH,
  IDLE_INPUT,
  MAX_PLAYERS,
  NAME_LENGTH,
  type ClientMessage,
  type CustomPick,
  type LobbyPlayer,
  type LobbyState,
  type NetInput,
  type NetRules,
  type PublicLobby,
  type ServerMessage,
} from '../src/net/protocol.ts';

/**
 * Lobbies live only in memory: a Map of code -> lobby. A lobby disappears when its last player
 * leaves; when the host leaves, the next player becomes host.
 */
export interface Connection {
  send(msg: ServerMessage): void;
}

interface Member extends LobbyPlayer {
  conn: Connection;
}

interface Lobby {
  code: string;
  host: number;
  mall: number;
  mode: number;
  members: Member[];
  race: Race | null;
  public: boolean;
  rules: NetRules;
}

interface Race {
  /** Slot order at the start; players who leave keep their slot (and stand still). */
  slots: LobbyPlayer[];
  ready: Set<number>;
  running: boolean;
  frame: number;
  latest: Map<number, NetInput>;
  /** Action and answer presses since the last frame, so a short tap between frames is not lost. */
  pressed: Map<number, number>;
  /** First checksum reported per tick; a different one from another client is a desync. */
  sums: Map<number, number>;
  desynced: boolean;
}

/** Ticks per second of the frame clock (obj_update_time = 40 ms). */
export const FRAME_MS = 40;
/** The clock starts anyway if someone is still loading after this long. */
export const READY_TIMEOUT_MS = 60000;

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
const unit = (v: unknown) => clamp(v, -1, 1);
/** A custom character pick: a short id and three stats of 1-5, or nothing. */
const cleanCustom = (c: unknown): CustomPick | undefined => {
  const o = c as Partial<CustomPick> | null;
  if (!o || typeof o.id !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(o.id) || !Array.isArray(o.stats)) return undefined;
  return { id: o.id, stats: [clamp(o.stats[0], 1, 5), clamp(o.stats[1], 1, 5), clamp(o.stats[2], 1, 5)] };
};
const cleanName = (s: unknown) =>
  String(s ?? '')
    .replace(/[^a-zA-Z0-9åäöÅÄÖ. _]/g, '')
    .slice(0, NAME_LENGTH) || 'Spelare';

export class LobbyServer {
  private readonly lobbies = new Map<string, Lobby>();
  private readonly where = new Map<Connection, { lobby: Lobby; member: Member }>();
  private nextId = 1;
  private readonly random: () => number;
  /** Starts the frame clock; tests drive frames by hand with `frame()`. */
  private readonly startClock: (lobby: string) => void;

  constructor(opts: { random?: () => number; startClock?: (lobby: string) => void } = {}) {
    this.random = opts.random ?? Math.random;
    this.startClock = opts.startClock ?? ((code) => this.runClock(code));
  }

  get lobbyCount(): number {
    return this.lobbies.size;
  }

  message(conn: Connection, msg: ClientMessage): void {
    const at = this.where.get(conn);
    switch (msg?.t) {
      case 'create': {
        if (at) this.leave(conn);
        const lobby: Lobby = { code: this.newCode(), host: 0, mall: clamp(msg.mall, 0, 4), mode: clamp(msg.mode, 2, 4), members: [], race: null, public: msg.public === true, rules: { punch: false, grabCarts: false } };
        this.lobbies.set(lobby.code, lobby);
        const member = this.add(lobby, conn, msg.name, msg.character, msg.custom);
        lobby.host = member.id;
        this.broadcastLobby(lobby);
        return;
      }
      case 'join': {
        if (at) this.leave(conn);
        const lobby = this.lobbies.get(String(msg.code ?? '').toUpperCase().trim());
        if (!lobby) return conn.send({ t: 'error', reason: 'nolobby' });
        if (lobby.race) return conn.send({ t: 'error', reason: 'racing' });
        if (lobby.members.length >= MAX_PLAYERS) return conn.send({ t: 'error', reason: 'full' });
        this.add(lobby, conn, msg.name, msg.character, msg.custom);
        this.broadcastLobby(lobby);
        return;
      }
      case 'leave':
        this.leave(conn);
        return;
      case 'rules': {
        if (!at || at.lobby.host !== at.member.id || at.lobby.race) return;
        at.lobby.rules = { punch: msg.rules?.punch === true, grabCarts: msg.rules?.grabCarts === true };
        this.broadcastLobby(at.lobby);
        return;
      }
      case 'list':
        conn.send({ t: 'lobbies', lobbies: this.publicLobbies() });
        return;
      case 'start': {
        if (!at || at.lobby.host !== at.member.id || at.lobby.race) return;
        const lobby = at.lobby;
        const slots = lobby.members.map(({ id, name, character, custom }) => ({ id, name, character, ...(custom ? { custom } : {}) }));
        lobby.race = { slots, ready: new Set(), running: false, frame: 0, latest: new Map(), pressed: new Map(), sums: new Map(), desynced: false };
        const seed = Math.floor(this.random() * 0x100000000) >>> 0;
        for (const m of lobby.members) m.conn.send({ t: 'start', seed, mall: lobby.mall, mode: lobby.mode, players: slots, rules: lobby.rules });
        const race = lobby.race;
        setTimeout(() => {
          if (lobby.race === race && !race.running) this.go(lobby);
        }, READY_TIMEOUT_MS).unref?.();
        return;
      }
      case 'ready': {
        const race = at?.lobby.race;
        if (!at || !race || race.running) return;
        race.ready.add(at.member.id);
        if (at.lobby.members.every((m) => race.ready.has(m.id))) this.go(at.lobby);
        return;
      }
      case 'input': {
        const race = at?.lobby.race;
        if (!at || !race) return;
        const i = Array.isArray(msg.i) ? msg.i : [];
        const flags = clamp(i[2], 0, 15);
        race.latest.set(at.member.id, [unit(i[0]), unit(i[1]), 0]);
        if (flags) race.pressed.set(at.member.id, (race.pressed.get(at.member.id) ?? 0) | flags);
        return;
      }
      case 'sum': {
        const race = at?.lobby.race;
        const n = Math.trunc(Number(msg.n));
        if (!at || !race || race.desynced || !Number.isFinite(n) || typeof msg.h !== 'number') return;
        const first = race.sums.get(n);
        if (first === undefined) {
          race.sums.set(n, msg.h);
          // Keep about a minute of checksums; slower clients report late.
          for (const old of race.sums.keys()) if (old < n - 1500) race.sums.delete(old);
        } else if (first !== msg.h) {
          race.desynced = true;
          for (const m of at.lobby.members) m.conn.send({ t: 'desync', n });
        }
        return;
      }
      case 'end': {
        if (!at || at.lobby.host !== at.member.id || !at.lobby.race) return;
        at.lobby.race = null;
        for (const m of at.lobby.members) m.conn.send({ t: 'end' });
        this.broadcastLobby(at.lobby);
        return;
      }
      default:
        conn.send({ t: 'error', reason: 'bad' });
    }
  }

  /** The socket closed. */
  close(conn: Connection): void {
    this.leave(conn);
  }

  /**
   * One tick of a running race: everyone's latest controls plus the presses since the last frame.
   * Returns false when the race is over (the clock stops).
   */
  frame(code: string): boolean {
    const lobby = this.lobbies.get(code);
    const race = lobby?.race;
    if (!lobby || !race || !race.running) return false;
    const inputs = race.slots.map((s): NetInput => {
      const [turn, throttle] = race.latest.get(s.id) ?? IDLE_INPUT;
      return [turn, throttle, race.pressed.get(s.id) ?? 0];
    });
    race.pressed.clear();
    const msg: ServerMessage = { t: 'frame', n: race.frame++, i: inputs };
    for (const m of lobby.members) m.conn.send(msg);
    return true;
  }

  private go(lobby: Lobby): void {
    if (!lobby.race || lobby.race.running) return;
    lobby.race.running = true;
    this.startClock(lobby.code);
  }

  /** setTimeout-based 25 Hz clock that corrects its own drift. */
  private runClock(code: string): void {
    const t0 = performance.now();
    let n = 0;
    const step = () => {
      if (!this.frame(code)) return;
      n++;
      setTimeout(step, Math.max(0, t0 + n * FRAME_MS - performance.now()));
    };
    step();
  }

  private add(lobby: Lobby, conn: Connection, name: unknown, character: unknown, custom: unknown): Member {
    const member: Member = { id: this.nextId++, name: cleanName(name), character: clamp(character, 0, 9), conn };
    const pick = cleanCustom(custom);
    if (pick) member.custom = pick;
    lobby.members.push(member);
    this.where.set(conn, { lobby, member });
    return member;
  }

  private leave(conn: Connection): void {
    const at = this.where.get(conn);
    if (!at) return;
    this.where.delete(conn);
    const { lobby, member } = at;
    lobby.members = lobby.members.filter((m) => m !== member);
    if (!lobby.members.length) {
      this.lobbies.delete(lobby.code);
      return;
    }
    if (lobby.host === member.id) lobby.host = lobby.members[0].id;
    const race = lobby.race;
    if (race && !race.running && lobby.members.every((m) => race.ready.has(m.id))) this.go(lobby);
    this.broadcastLobby(lobby);
  }

  /** Public lobbies that can be joined now, oldest first. */
  publicLobbies(): PublicLobby[] {
    const out: PublicLobby[] = [];
    for (const l of this.lobbies.values()) {
      if (!l.public || l.race || l.members.length >= MAX_PLAYERS) continue;
      const host = l.members.find((m) => m.id === l.host);
      out.push({ code: l.code, host: host?.name ?? '', mall: l.mall, mode: l.mode, players: l.members.length });
    }
    return out;
  }

  private broadcastLobby(lobby: Lobby): void {
    const players = lobby.members.map(({ id, name, character, custom }) => ({ id, name, character, ...(custom ? { custom } : {}) }));
    for (const m of lobby.members) {
      const state: LobbyState = { code: lobby.code, you: m.id, host: lobby.host, mall: lobby.mall, mode: lobby.mode, players, racing: lobby.race !== null, public: lobby.public, rules: lobby.rules };
      m.conn.send({ t: 'lobby', lobby: state });
    }
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      if (!this.lobbies.has(code)) return code;
    }
  }
}
