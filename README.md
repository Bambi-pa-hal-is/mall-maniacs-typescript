# Mall Maniacs: TypeScript reconstruction

A browser reconstruction of **Mall Maniacs** (1999), the Swedish shopping-cart racing game, in TypeScript with Three.js. The game's file formats, physics, AI, menus and HUD have been reverse engineered from the original `maniac.exe` and re-implemented so the game runs in a modern browser, including online multiplayer.

The game data itself is **not** included. You need your own copy of the original game.

## Features

- All five malls (Småköp, Eken, Draken, Sjöhästen, Raketen) loaded straight from the original data files
- The four game modes: Varujakten, Matkrig, Frågesporten and Vagnrace
- The original menu, HUD, fonts, sounds and CD music (when supplied)
- Physics ported from the original: floor-region walls, body collisions, cart pushing and tilting, the Aqua water slide, launch pads and teleports
- Computer opponents following the original AI (buoy navigation, item picking, checkpoints)
- Character and mall unlocking, records with name entry
- Online multiplayer: host a public or private lobby, join by code or from the lobby list. Races run in lockstep through a small WebSocket server.
- An optional "retro" render mode (640×480, nearest texels, affine texture warping)

## Getting started

Requirements: Node.js 24 or newer.

1. Copy the installed game into `original/` (the folder with `maniac.exe`, `maniac.cfg`, `scene_*`, `sound`, `menu`, `anim`, …). File names are matched case-insensitively.
2. Optional: put the CD audio tracks in `music/` as `NN title.mp3`, where `NN` is the CD track number (02–06 the malls, 07 the menu, 08 the intro), e.g. `07 Menu Music.mp3`.
3. Run:

```sh
cd web
npm install
npm run dev        # http://localhost:5173 (network play included)
```

Other commands (in `web/`):

```sh
npm test           # format tests against original/ and lobby server tests
npm run typecheck
npm run build      # dist/ with the game files copied in
npm run server     # serve dist/ plus network play on http://localhost:8080 (PORT=...)
```

## Custom characters (optional)

Extra characters can be added in `web/customcharachters/` (gitignored). List them in `web/customcharachters/characters.json`:

```json
{
  "characters": [
    {
      "id": "patrik",
      "name": "Patrik",
      "folder": "patrik",
      "model": "character.glb",
      "base": 0,
      "stats": [3, 3, 3],
      "description": "Text for the character page."
    }
  ]
}
```

- `folder` holds the model: a binary glTF (`.glb`), unrigged, Y-up, facing +Z, with its texture embedded.
- The model is rigged when the game loads, onto the skeleton of the original character `base` (0–9, default 0). So it plays all the original animations and holds the cart. The arms are fitted to the model's own hands and shoulders; the rest of the body takes its bone weights from the base character.
- `stats` (Snabbhet, Styrka, Smidighet, 1–5) default to the base character's. `height` (engine units) defaults to the base character's height.
- The portrait is rendered from the model's head, or taken from a square picture named by `face`.
- Custom characters come after the originals in the menu and are always unlocked. Computer players don't pick them.
- In network games, players who don't have a custom character see its base character instead, but everyone uses its stats, so the races stay in sync.

## Controls

| Key | Action |
|---|---|
| Arrows / WASD | walk and turn |
| Space | context action: grab/release the cart, take an item, drop/throw it (punch with the house rule) |
| E / Ctrl | punch (network house rule) |
| Enter | continue after a race |
| J / Y, N | answer a quiz question |
| M | mute |
| F | frame cap (off / 60 / 144) |
| R | retro rendering |
| Esc | back to the menu |

### Phones and tablets

Touch screens get on-screen controls: a joystick appears wherever you put your thumb on the left half of the screen (in a race, push it the way you want to go: sideways turns while walking forward, down walks backward), and buttons on the right give the action (Space), punch (with the punch house rule), Ja/Nej in a quiz, OK in the menu and after a race, and a Meny/back button. The menu's text fields get a keyboard button. On small screens the shopping list is drawn smaller.

The first touch asks for fullscreen in landscape (Android browsers). iPhones don't allow that from a web page, so in portrait the game asks you to turn the phone. Adding the page to the home screen opens it fullscreen in landscape (`public/manifest.webmanifest`). Add `?touch` to the URL to try the touch controls on a desktop.

## Network play

Main menu → **Nätverk**:

- **Starta nätspel**: choose character, mall, game, your name and whether the lobby is public or private, then start. The waiting room shows the lobby code.
- **Anslut**: join with a lobby code.
- In the waiting room the host can switch on unofficial house rules (not in the original game): **Slag** (E/Ctrl punches, and so does Space when there is nothing else to do; a player who is hit is knocked back, stunned for longer the stronger the puncher is, and lets go of their cart), **Vagnstöld** (Space grabs the nearest free cart, even someone else's, to drag it away and hide it), or both.
- **Sök nätspel**: pick a public lobby from the list.

The server keeps lobbies in memory only. Each race runs in lockstep at 25 Hz, and clients compare state checksums to detect desyncs. See [`web/README.md`](web/README.md) for details.

## Repository layout

| Path | Contents |
|---|---|
| `web/` | the game: Vite + Three.js client (`src/`), lobby server (`server/`), tests |
| `re/ANALYSIS.md` | reverse-engineering notes: file formats, function addresses, decoded behaviour |
| `re/tools/` | Ghidra scripts and Python helpers used for the analysis |
| `NEXT.md` | development log and open items |

Code comments mark behaviour taken from the decompiled original as **[O]** and approximations as **[I]**.

## Disclaimer

This is an unofficial fan project, not affiliated with or endorsed by the original developers or publishers. No game assets are included. All trademarks belong to their respective owners.
