import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { attachLobbyServer } from './server/attach.ts';

// The original game data is served read-only from ../original. Paths inside the game's
// config use mixed case and backslashes (e.g. "Scene_ica\merged%02d.tpg"), so the plugin
// exposes a manifest mapping lower-cased relative paths to the real file names.
const GAME_DIR = path.resolve(__dirname, '../original');
const GAME_URL = '/game/';
const GAME_EXTS = new Set(['.sen', '.tpg', '.tga', '.anm', '.wav', '.ai', '.eo', '.cfg', '.mm', '.txt']);
// The CD-audio tracks are not part of the game data: ../music holds them as "NN title.mp3",
// NN being the CD track (2-6 the malls, 7 the menu, 8 the intro).
const MUSIC_DIR = path.resolve(__dirname, '../music');
const MUSIC_URL = '/music/';

function scanMusic(): Record<number, string> {
  const out: Record<number, string> = {};
  if (!fs.existsSync(MUSIC_DIR)) return out;
  for (const name of fs.readdirSync(MUSIC_DIR)) {
    const m = /^(\d+)\b.*\.(mp3|ogg|wav)$/i.exec(name);
    if (m) out[Number(m[1])] = name;
  }
  return out;
}

function scan(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full, base, out);
    else if (GAME_EXTS.has(path.extname(entry.name).toLowerCase())) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out[rel.toLowerCase()] = rel;
    }
  }
  return out;
}

function gameAssets(): Plugin {
  const virtualId = 'virtual:game-manifest';
  const resolvedId = '\0' + virtualId;
  let manifest: Record<string, string> = {};
  let music: Record<number, string> = {};
  return {
    name: 'mall-maniacs-game-assets',
    buildStart() {
      manifest = scan(GAME_DIR);
      music = scanMusic();
    },
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      return `export default ${JSON.stringify({ baseUrl: GAME_URL, files: manifest, musicUrl: MUSIC_URL, music })};`;
    },
    configureServer(server) {
      server.middlewares.use(GAME_URL, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const real = manifest[rel.toLowerCase()];
        if (!real) return next();
        const file = path.join(GAME_DIR, real);
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
      server.middlewares.use(MUSIC_URL, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!Object.values(music).includes(name)) return next();
        const file = path.join(MUSIC_DIR, name);
        const size = fs.statSync(file).size;
        // <audio> seeks and loops with range requests.
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Number(range[2]) : size - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          fs.createReadStream(file, { start, end }).pipe(res);
        } else {
          res.setHeader('Content-Length', size);
          fs.createReadStream(file).pipe(res);
        }
      });
    },
    generateBundle() {
      for (const rel of Object.values(manifest)) {
        this.emitFile({ type: 'asset', fileName: `game/${rel}`, source: fs.readFileSync(path.join(GAME_DIR, rel)) });
      }
      for (const name of Object.values(music)) {
        this.emitFile({ type: 'asset', fileName: `music/${name}`, source: fs.readFileSync(path.join(MUSIC_DIR, name)) });
      }
    },
  };
}

/** Network play: the lobby WebSocket runs inside the dev and preview servers too. */
function lobbyServer(): Plugin {
  return {
    name: 'mall-maniacs-lobbies',
    configureServer(server) {
      if (server.httpServer) attachLobbyServer(server.httpServer as import('node:http').Server);
    },
    configurePreviewServer(server) {
      attachLobbyServer(server.httpServer as import('node:http').Server);
    },
  };
}

export default defineConfig({
  plugins: [gameAssets(), lobbyServer()],
  server: { port: 5173 },
});
