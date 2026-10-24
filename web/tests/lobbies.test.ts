// Lobby server logic (server/lobbies.ts) with fake connections and a hand-driven frame clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyServer, type Connection } from '../server/lobbies.ts';
import type { LobbyState, ServerMessage } from '../src/net/protocol.ts';

class Fake implements Connection {
  readonly got: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.got.push(msg);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.got.filter((m) => m.t === t).pop() as Extract<ServerMessage, { t: T }> | undefined;
  }
  lobby(): LobbyState {
    return this.last('lobby')!.lobby;
  }
}

function setup() {
  const clocks: string[] = [];
  const server = new LobbyServer({ startClock: (code) => clocks.push(code) });
  return { server, clocks };
}

test('create and join by code', () => {
  const { server } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'Anna', character: 2, mall: 1, mode: 3 });
  const code = host.lobby().code;
  assert.match(code, /^[A-Z]{4}$/);
  server.message(guest, { t: 'join', code: code.toLowerCase(), name: 'Bo<script>', character: 5 });
  const seen = guest.lobby();
  assert.equal(seen.code, code);
  assert.equal(seen.host, host.lobby().you);
  assert.deepEqual(
    seen.players.map((p) => [p.name, p.character]),
    [
      ['Anna', 2],
      ['Boscript', 5],
    ],
  );
  assert.equal(host.lobby().players.length, 2);
});

test('unknown code and full lobby are refused', () => {
  const { server } = setup();
  const lost = new Fake();
  server.message(lost, { t: 'join', code: 'ZZZZ', name: 'x', character: 0 });
  assert.equal(lost.last('error')?.reason, 'nolobby');
  const host = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, mall: 0, mode: 2 });
  const code = host.lobby().code;
  for (let i = 0; i < 7; i++) server.message(new Fake(), { t: 'join', code, name: 'g', character: 0 });
  const late = new Fake();
  server.message(late, { t: 'join', code, name: 'late', character: 0 });
  assert.equal(late.last('error')?.reason, 'full');
});

test('host leaving promotes the next player; last one out removes the lobby', () => {
  const { server } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, mall: 0, mode: 2 });
  server.message(guest, { t: 'join', code: host.lobby().code, name: 'g', character: 1 });
  server.close(host);
  assert.equal(guest.lobby().host, guest.lobby().you);
  assert.equal(server.lobbyCount, 1);
  server.message(guest, { t: 'leave' });
  assert.equal(server.lobbyCount, 0);
});

test('race: start, ready, frames carry latched presses, end', () => {
  const { server, clocks } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, mall: 2, mode: 4 });
  const code = host.lobby().code;
  server.message(guest, { t: 'join', code, name: 'g', character: 1 });
  server.message(guest, { t: 'start' }); // only the host may start
  assert.equal(guest.last('start'), undefined);
  server.message(host, { t: 'start' });
  const start = guest.last('start')!;
  assert.equal(start.seed, host.last('start')!.seed);
  assert.equal(start.mall, 2);
  assert.deepEqual(
    start.players.map((p) => p.name),
    ['h', 'g'],
  );
  server.message(new Fake(), { t: 'join', code, name: 'late', character: 0 });
  server.message(host, { t: 'ready' });
  assert.deepEqual(clocks, []);
  server.message(guest, { t: 'ready' });
  assert.deepEqual(clocks, [code]);

  server.message(host, { t: 'input', i: [1, 1, 1] }); // a tap...
  server.message(host, { t: 'input', i: [1, 5, 0] }); // ...released before the frame; throttle clamped
  assert.equal(server.frame(code), true);
  assert.deepEqual(guest.last('frame'), { t: 'frame', n: 0, i: [[1, 1, 1], [0, 0, 0]] });
  server.frame(code);
  assert.deepEqual(host.last('frame')!.i, [[1, 1, 0], [0, 0, 0]]);

  server.message(host, { t: 'end' });
  assert.ok(guest.last('end'));
  assert.equal(guest.lobby().racing, false);
  assert.equal(server.frame(code), false);
});

test('race: different checksums for the same tick report a desync once', () => {
  const { server } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, mall: 0, mode: 2 });
  server.message(guest, { t: 'join', code: host.lobby().code, name: 'g', character: 1 });
  server.message(host, { t: 'start' });
  server.message(host, { t: 'sum', n: 25, h: 1.5 });
  server.message(guest, { t: 'sum', n: 25, h: 1.5 });
  assert.equal(guest.last('desync'), undefined);
  server.message(host, { t: 'sum', n: 50, h: 2 });
  server.message(guest, { t: 'sum', n: 50, h: 2.0000001 });
  assert.deepEqual(host.last('desync'), { t: 'desync', n: 50 });
  server.message(guest, { t: 'sum', n: 75, h: 9 });
  server.message(host, { t: 'sum', n: 75, h: 8 });
  assert.equal(host.got.filter((m) => m.t === 'desync').length, 1);
});

test('public lobbies are listed until they fill up or start racing; private ones never', () => {
  const { server } = setup();
  const pub = new Fake();
  const priv = new Fake();
  server.message(pub, { t: 'create', name: 'Anna', character: 0, mall: 2, mode: 3, public: true });
  server.message(priv, { t: 'create', name: 'Bo', character: 1, mall: 0, mode: 2, public: false });
  const asker = new Fake();
  server.message(asker, { t: 'list' });
  assert.deepEqual(asker.last('lobbies')!.lobbies, [{ code: pub.lobby().code, host: 'Anna', mall: 2, mode: 3, players: 1 }]);
  assert.equal(pub.lobby().public, true);
  assert.equal(priv.lobby().public, false);
  // Joining from the list works like joining by code.
  server.message(asker, { t: 'join', code: pub.lobby().code, name: 'Cid', character: 2 });
  assert.equal(asker.lobby().players.length, 2);
  server.message(new Fake(), { t: 'list' });
  server.message(pub, { t: 'start' });
  const late = new Fake();
  server.message(late, { t: 'list' });
  assert.deepEqual(late.last('lobbies')!.lobbies, []);
});

test('house rules are host-only, shared in the lobby and sent with the start', () => {
  const { server } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, mall: 0, mode: 2 });
  const code = host.lobby().code;
  server.message(guest, { t: 'join', code, name: 'g', character: 1 });
  assert.deepEqual(guest.lobby().rules, { punch: false, grabCarts: false });
  server.message(guest, { t: 'rules', rules: { punch: true, grabCarts: true } });
  assert.deepEqual(host.lobby().rules, { punch: false, grabCarts: false });
  server.message(host, { t: 'rules', rules: { punch: true, grabCarts: false } });
  assert.deepEqual(guest.lobby().rules, { punch: true, grabCarts: false });
  server.message(host, { t: 'start' });
  assert.deepEqual(guest.last('start')?.rules, { punch: true, grabCarts: false });
});

test('custom character picks are cleaned and sent with the lobby and the start', () => {
  const { server } = setup();
  const host = new Fake();
  const guest = new Fake();
  server.message(host, { t: 'create', name: 'h', character: 0, custom: { id: 'patrik', stats: [9, 0, 3] }, mall: 0, mode: 2, public: false });
  const code = host.lobby().code;
  server.message(guest, { t: 'join', code, name: 'g', character: 1, custom: { id: '../evil', stats: [3, 3, 3] } });
  const [a, b] = guest.lobby().players;
  assert.deepEqual(a.custom, { id: 'patrik', stats: [5, 1, 3] });
  assert.equal(b.custom, undefined);
  server.message(host, { t: 'start' });
  assert.deepEqual(guest.last('start')?.players[0].custom, { id: 'patrik', stats: [5, 1, 3] });
});
