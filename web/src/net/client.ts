import type { Controls } from '../game/input';
import { NET_PATH, type ClientMessage, type ErrorReason, type LobbyState, type NetInput, type PublicLobby, type ServerMessage } from './protocol';

export type StartMessage = Extract<ServerMessage, { t: 'start' }>;

export interface NetEvents {
  lobby(state: LobbyState): void;
  /** The public lobby list. */
  lobbies(list: PublicLobby[]): void;
  error(reason: ErrorReason | 'offline'): void;
  start(msg: StartMessage): void;
  /** The host ended the race. */
  end(): void;
  /** The connection was lost. */
  closed(): void;
  /** The clients' simulations have split (tick n). */
  desync(n: number): void;
}

/**
 * Frames kept in hand before the simulation uses them. Each frame is one 40 ms tick, so this
 * absorbs about 80 ms of network jitter; anything beyond it runs at once to catch up.
 */
export const JITTER_FRAMES = 2;

export function packControls(c: Controls): NetInput {
  return [c.turn, c.throttle, (c.action ? 1 : 0) | (c.answer !== undefined ? 2 : 0) | (c.answer ? 4 : 0) | (c.punch ? 8 : 0)];
}

export function unpackControls([turn, throttle, flags]: NetInput): Controls {
  return { turn, throttle, action: (flags & 1) !== 0, answer: flags & 2 ? (flags & 4) !== 0 : undefined, punch: (flags & 8) !== 0 };
}

/** One WebSocket to the lobby server (same host as the page). */
export class NetClient {
  private ws: WebSocket | null = null;
  private readonly frames: NetInput[][] = [];
  private nextFrame = 0;
  private lastSent = '';
  private buffering = true;
  /** Frames are only kept while this machine is in the race. */
  private racing = false;
  lobby: LobbyState | null = null;

  constructor(private readonly on: NetEvents) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isHost(): boolean {
    return !!this.lobby && this.lobby.host === this.lobby.you;
  }

  /** Open the socket if needed and send. */
  send(msg: ClientMessage): void {
    const ws = this.open();
    const data = JSON.stringify(msg);
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
    else ws.addEventListener('open', () => ws.send(data), { once: true });
  }

  leave(): void {
    if (this.connected) this.send({ t: 'leave' });
    this.lobby = null;
    this.resetFrames();
  }

  /** This machine left the race (back in the waiting room): ignore its frames from now on. */
  stopRace(): void {
    this.racing = false;
    this.resetFrames();
  }

  /** Forget queued frames (a new race starts at frame 0). */
  resetFrames(): void {
    this.frames.length = 0;
    this.nextFrame = 0;
    this.lastSent = '';
    this.buffering = true;
  }

  /** Send this machine's controls when they change (presses always go out). */
  sendInput(c: Controls): void {
    const i = packControls(c);
    const key = i.join(',');
    if (key === this.lastSent && !i[2]) return;
    this.lastSent = i[2] ? '' : key;
    this.send({ t: 'input', i });
  }

  /** The next frame's inputs, or null while waiting (or refilling the jitter buffer). */
  takeFrame(): NetInput[] | null {
    if (this.buffering) {
      if (this.frames.length < JITTER_FRAMES) return null;
      this.buffering = false;
    }
    const f = this.frames.shift();
    if (!f) {
      this.buffering = true;
      return null;
    }
    return f;
  }

  /** Frames beyond the jitter buffer, which the loop runs at once. */
  get backlog(): number {
    return Math.max(0, this.frames.length - JITTER_FRAMES);
  }

  private open(): WebSocket {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return this.ws;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${NET_PATH}`);
    this.ws = ws;
    let opened = false;
    ws.addEventListener('open', () => (opened = true));
    ws.addEventListener('message', (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const had = this.lobby !== null;
      this.lobby = null;
      if (!opened) this.on.error('offline');
      else if (had) this.on.closed();
    });
    return ws;
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case 'lobby':
        this.lobby = msg.lobby;
        this.on.lobby(msg.lobby);
        break;
      case 'lobbies':
        this.on.lobbies(msg.lobbies);
        break;
      case 'error':
        this.on.error(msg.reason);
        break;
      case 'start':
        this.resetFrames();
        this.racing = true;
        this.on.start(msg);
        break;
      case 'frame':
        // Frames arrive in order on one socket; n only guards against a stale race.
        if (!this.racing || msg.n !== this.nextFrame) return;
        this.nextFrame++;
        this.frames.push(msg.i);
        break;
      case 'end':
        this.racing = false;
        this.on.end();
        break;
      case 'desync':
        this.on.desync(msg.n);
        break;
    }
  }
}
