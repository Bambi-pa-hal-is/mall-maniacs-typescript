# Mall Maniacs: browser reconstruction

TypeScript + Vite + Three.js. It reads the **original game data** from `../original` at runtime and never modifies it. Every file format is parsed in the browser.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # parses every SEN/ANM/TPG/cfg file in ../original and checks the decoded structure
npm run typecheck
npm run build      # dist/ includes the needed game files under dist/game/
npm run server     # after a build: serves dist/ and network play on http://localhost:8080 (PORT=...)
```

## Controls
| Key | Action |
|---|---|
| Arrows / WASD | walk and turn |
| Space | context action: release cart, pick up a listed item, drop/throw it, grab the cart |
| Enter | after the race: continue / try again / back to menu, as the prompt says |
| J / Y, N | answer the quiz question (Ja / Nej) |
| M | mute / unmute |
| F | frame cap: off / 60 / 144 fps (remembered). The 25 Hz simulation is the same at any frame rate. |
| R | toggle retro rendering: 640×480, nearest texels and affine ("PS1/PS2") texture warping. The choice is remembered. |
| Esc | back to the menu |

## Layout
| Path | Purpose |
|---|---|
| `src/formats/` | `dff.ts` (cfg/ai/eo), `xor.ts` (XOR-0x55), `tpg.ts`, `sen.ts`, `anm.ts`. Pure parsers, also used by the Node tests. |
| `src/engine/` | asset loader (case-insensitive game paths), materials (gx render flags, retro mode), mesh/scene builders (skinned rigid-node characters), animation, collision (from `ph*.sen`), fixed 25 Hz loop |
| `src/game/` | config model, keyboard controls (turn/throttle), player movement and shopping actions, chase camera, race start (countdown and gates), nav buoys (`navGraph.ts`), event objects (`events.ts`), shelves/lists/checkout (`shopping.ts`), AI opponents (`ai.ts`), player collisions (`crowd.ts`), level assembly |
| `src/net/` | network play: `protocol.ts` (messages shared with the server), `client.ts` (WebSocket, frame queue) |
| `server/` | lobby server: `lobbies.ts` (in-memory lobbies, 25 Hz frame clock), `attach.ts` (WebSocket at `/net` on any HTTP server), `main.ts` (standalone server for `dist/`) |
| `vite.config.ts` | serves `../original` at `/game/` read-only and `../music` (CD tracks as `NN title.mp3`) at `/music/`, and emits both into the build; runs the lobby server inside `npm run dev` / `preview` |

## Fidelity
Behaviour marked **[O]** in comments was taken from the decompiled `maniac.exe`; **[I]** marks an approximation. See `../re/ANALYSIS.md` for addresses and evidence.

The simulation runs on per-tick control values (`turn`, `throttle`, `action`), the same fields the original fills from input or AI.

## Network play
Main menu → **Nätverk** (the original's pages, drawn with its menu graphics):
- **Starta nätspel**: pick character, mall, game (Varujakten, Matkrig or Vagnrace) and your name, then Starta. The waiting room shows the joined players and the lobby code (`Kod ABCD`). The host chooses Starta to begin.
- **Anslut**: pick character and name, type the host's 4-letter code, then Starta.
- **Sök nätspel**: a table of the public lobbies (Värd, Butik, Spelare), refreshed every 2 s. Up/down moves the highlight bar; ENTER joins with the name and character from the other pages.

The host page's **Lobby** row makes the lobby **Offentlig** (public: listed under Sök nätspel) or **Privat** (joinable by code only). Lobbies that are racing or full are not listed.

The server keeps every lobby in memory only (no database); a lobby disappears with its last player, and if the host leaves the next player becomes host. Up to 8 players. As in the original, a network race has only the people in the lobby (no computer players).

The race runs in **lockstep**. The server is the 25 Hz clock: every 40 ms it sends one frame with each player's latest controls, and a Space/J/N press between frames is latched so it isn't lost. Every client simulates the same frames from the same seed (`src/game/random.ts`; game logic must use `simRandom`, never `Math.random`). Clients keep 2 frames (~80 ms) in hand against jitter and catch up at once when they fall behind. After the race the host's Enter takes everyone back to the waiting room. Esc leaves the lobby, and the slot of a player who left stands still. The HUD shows the lobby names, and a new best time is saved under the lobby name (no name-entry page). Every 25 ticks each client sends a state checksum; if two differ for the same tick, the server reports it and the HUD shows "Ur synk! Starta om loppet." Lockstep can't recover, so restart the race. The dev build also keeps the checksums in `window.mmNet`.

On localhost the intro pictures are skipped and the game starts on the main menu.

## Game
The game starts with the original intro and menu (`src/menu/`). This includes the waving cloth, the sliding sign, and the character page with its running 3D model. Then come the mall page, options (difficulty, and "Grafik": Mjukvara = retro mode) and the records. Menu keys are the arrows, Enter, Esc and Space (to skip the intro).

All four modes are playable. The number of opponents follows the original's table per mall and difficulty (Frågesporten is solo), with random opponent characters:

| Mode | Goal |
|---|---|
| Frågesporten | 10 random items; every pickup asks a yes/no question from quest.txt (wrong answer blocks that item until the next right one) |
| Varujakten | 10 random items, no questions |
| Matkrig | first to 5: an item is announced every 10 s; the first to take it from the shelf claims it, but thrown copies lying on the floor can be stolen, and any item landing in your cart scores |
| Vagnrace | pass the numbered flags in order, then the checkout |

Push your cart (green handle) to the shelf, leave it, take the item, drop it in the cart and check out at the tills. The 3D compass arrow (VARUPIL/VAGNPIL) points at the next item, flag, your parked cart or the checkout. Sound uses the original WAVs (footsteps and cart rolling per player, cart bumps, per-mall ambience, event sounds); the CD-audio music is not part of the game files. The AI is a port of the original state machine, waypoint follower and steering; difficulty sets its speed (0.72/0.84/0.96).

Items you still need (and the next three Vagnrace flags) spin and bob in place; other spots stay hidden, as in the original. Taking an item shows the original full-screen picture of the hand holding it, and dropping it at your cart throws it in with the throw animation. Characters pushing a cart hold its handles (arm IK towards the configured handle positions).

Space with an item in hand puts it in your cart within 1300 units; further away you throw it along your heading (speed scales with the distance to your cart). Thrown items fly, bounce and either land in a cart whose owner can use them or come to rest on the floor, where anyone may pick them up.

The HUD is the original one, drawn from the game's own atlases and bitmap fonts at its 640×480 positions:
- the handwritten shopping list on paper that slides up as you find items
- your portrait and the metal bar
- the position counter ("3/8")
- the race timer
- the question frame
- the "Mot kassorna!!" and Matkrig banners

The race ends when the first player checks out. ENTER then follows the on-screen prompt: quit, continue in the next mall, or try again. Best times in Frågesporten and Vagnrace are kept per mall, starting from the shipped config.mm table, and a new one blinks "NYTT REKORD!!".

Every mall has its scripted staff: the cashier at the checkout (cheering once the race is over) and the McDonald's man, who every 10 s while no burger is out picks one up, throws it onto his counter and lets it slide to a stop. Only you can take the burger (item 31). Eating it fills the metal bar, shows the McDonald's M and makes you 1.3× faster until the bar drains (1 point every 5 ticks, 20 s in all).

In Aqua, falling into the canal takes you down the water slide through the tunnels to the lower floor. As in the original:
- the `mvnc` currents carry you toward each stretch's end while you spin
- you play the `s_oops` flail with spinning SPLASH spray around you (hidden in retro mode, like the software driver) and the Plask sound
- fixed `c_ac` cameras watch from the canal, the long tunnel and the lower run, then the chase camera eases back
- a cart you let go of floats down the slide too, spinning in its own spray

The guide arrows follow the original's routing hints: in Woodshop and Aqua (PUNK areas) and Future (ARE/EXI areas), they first lead you to the way out of your area. Orient's gong sounds when you walk up to it.

Orient's and Future's teleports (`tele`) take you, cart and all, between floors. Future's launch pads (`mvnc`) and `hurl` throw you spinning through the air (with the Blast sound).

The chase camera is the original's: it eases toward a point behind you by a quarter per update, trailing further when you run straight and closing in while you turn. It stays on your side of the walls, as the original's camera clipping does. The water scrolls using the scenes' TANI texture animation.

Winning Varujakten or Matkrig in the highest open mall opens the next mall and more characters. Progress is kept in the browser; `?toplevel=N` overrides it. A new best time in Frågesporten or Vagnrace opens the original's name-entry page. The characters' Snabbhet and Smidighet set their speed and turning, and Styrka decides who loses their cart when players collide. The CD music plays from `../music` (intro, menu, one track per mall). The original has no minimap; `mapX`/`mapY`/`mapZoom` are read from the config but never used.
