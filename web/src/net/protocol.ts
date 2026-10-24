/**
 * Network play protocol (JSON over one WebSocket at NET_PATH).
 *
 * The original used its own UDP protocol between a host and up to 7 clients (ANALYSIS §network).
 * Here a small server keeps every lobby in memory: anyone can create one ("Starta nätspel") and
 * the others join with its code ("Anslut"). The race runs in lockstep: the server is the 25 Hz
 * clock, collects each player's latest controls and broadcasts one frame per tick with everyone's
 * input; every client simulates the same frames from the same seed.
 *
 * Shared by the browser and the Node server, so it only uses erasable TypeScript.
 */
export const NET_PATH = '/net';
export const MAX_PLAYERS = 8;
/** Codes avoid look-alike letters (0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
/** Names as the original's name field (letters incl. å ä ö, digits, '.', ' ', '_'), 19 at most. */
export const NAME_LENGTH = 19;

export interface LobbyPlayer {
  id: number;
  name: string;
  character: number;
}

export interface LobbyState {
  code: string;
  /** Id of this connection's player. */
  you: number;
  host: number;
  mall: number;
  mode: number;
  /** In slot order: the host first, then in joining order. */
  players: LobbyPlayer[];
  racing: boolean;
  /** Listed for everyone ("Sök nätspel"), or joinable by code only. */
  public: boolean;
}

/** A public lobby as the lobby list shows it. */
export interface PublicLobby {
  code: string;
  host: string;
  mall: number;
  mode: number;
  players: number;
}

/**
 * One player's controls in a frame: [turn, throttle, flags]. flags bit 0 = action (Space),
 * bit 1 = answer given, bit 2 = the answer (J/Y). Turn and throttle are -1, 0 or 1.
 */
export type NetInput = [number, number, number];

export type ClientMessage =
  | { t: 'create'; name: string; character: number; mall: number; mode: number; public: boolean }
  /** The joinable public lobbies (not racing, not full). */
  | { t: 'list' }
  | { t: 'join'; code: string; name: string; character: number }
  | { t: 'leave' }
  /** Host only: load the race. */
  | { t: 'start' }
  /** The level is loaded; the frame clock starts when every racer is ready. */
  | { t: 'ready' }
  | { t: 'input'; i: NetInput }
  /** Host only: back to the waiting room after the race. */
  | { t: 'end' }
  /** State checksum after tick n (every SUM_TICKS); the server compares the clients'. */
  | { t: 'sum'; n: number; h: number };

export type ErrorReason = 'nolobby' | 'full' | 'racing' | 'bad';

export type ServerMessage =
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'lobbies'; lobbies: PublicLobby[] }
  | { t: 'error'; reason: ErrorReason }
  /** Load this race; slots follow `players`. */
  | { t: 'start'; seed: number; mall: number; mode: number; players: LobbyPlayer[] }
  /** Frame n: one input per slot (a player who left stands still). */
  | { t: 'frame'; n: number; i: NetInput[] }
  /** The race was ended by the host; the lobby message follows. */
  | { t: 'end' }
  /** Two clients reported different checksums for tick n: their simulations have split. */
  | { t: 'desync'; n: number };

/** Ticks between state checksums (one second). */
export const SUM_TICKS = 25;

export const IDLE_INPUT: NetInput = [0, 0, 0];
