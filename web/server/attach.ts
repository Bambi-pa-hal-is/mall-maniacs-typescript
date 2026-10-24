import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { NET_PATH, type ClientMessage, type ServerMessage } from '../src/net/protocol.ts';
import { LobbyServer, type Connection } from './lobbies.ts';

/** Messages above this size are dropped (the largest real one is a few hundred bytes). */
const MAX_MESSAGE = 4096;

/** Serve the lobby WebSocket at NET_PATH on an existing HTTP server (Vite's or the standalone one). */
export function attachLobbyServer(http: Server, lobbies = new LobbyServer()): LobbyServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== NET_PATH) return; // e.g. Vite's HMR socket
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      lobbies.message(conn, msg);
    });
    ws.on('close', () => lobbies.close(conn));
    ws.on('error', () => ws.close());
  });
  return lobbies;
}
