# Mall Maniacs reconstruction: handoff / next steps

Read this first in a new session, then `re/ANALYSIS.md` (findings and function map) and
`web/README.md` (how to run, controls, what's implemented).

## Setup reminders
- `original/` is read-only. Never modify it.
- Web app: `cd web && npm run dev` (Vite on :5173). Checks: `npx tsc --noEmit`, `npm test` (9 tests).
- The dev build exposes `window.mm = { level, config, camera }` for browser debugging.
- Ghidra 12.1.4 is at `C:\ghidra`. The REA MCP provider works but can't decompile un-analysed labels. For those use
  `re/tools/DecompAt.java` headless (creates functions at given addresses and decompiles them):
  ```
  analyzeHeadless.bat <projdir> mm -import original\maniac.exe -overwrite -scriptPath re\tools -postScript DecompAt.java <out.c> 0xADDR ...
  ```
  To reuse an existing project, pass `-process maniac.exe -noanalysis` instead of `-import`.
  The last project was in the old session's scratchpad (gproj); recreate it.
- Full headless dump: `re/ghidra/maniac.exe.decomp.c`. Menu pages: `re/ghidra/menu/*.c`.

## Done in the last session
- McDonald's burger and per-mall NPCs (`web/src/game/mallScript.ts`): cashier and McDonald's man throwing the burger (item 31). Energy bar and 1.3× boost.
- The multiplayer design note is on `Controls` in `web/src/game/input.ts`. It is the lowest priority. Design: anyone can create a lobby; the WebSocket server holds lobbies in memory; players join by lobby code; the UI matches the game's menus.
- **Aqua water slide** [I]:
  - `CollisionObject.water` (*KANAL*/*TUNNEL*) and `CollisionWorld.lastFloor` (downhill vector).
  - Player water physics: friction 0.95, 25% control, slope push, minimum speed 150 in tunnels, turning at bends and floor edges.
  - The cart is released in the water.
  - Verified: canal → tunnels → exit at (8470, 9000, −38956).
- **Camera wall clipping**: `CollisionWorld.raycast` plus `ChaseCamera(…, world)` (port of the idea of `0x4023e0`).
- **TANI texture animation** (scrolling water): `formats/sen.ts` `parseTextureAnims`, `engine/textureAnim.ts`, ticked in `main.ts`, built in `level.ts`.
- `web/src/game/setup.ts` (new, not yet wired in):
  - `playerCount` (table at `0x44b610`)
  - `pickCharacters`
  - `characterUnlocked` / `mallUnlocked`
  - `Progress` (toplevel + difficulty in localStorage, `?toplevel=N`)

## Done in session 2026-10-24
- Character unlocking was already complete (characters ≥ toplevel+5 locked; a win in mall == toplevel raises it).
- **Network play** (web/README "Network play", ANALYSIS §4.11 "Network pages"):
  - Menu: the original's Nätverk / Starta nätspel / Anslut / waiting-room pages (`src/menu/menu.ts`).
  - Server: `web/server/` (in-memory lobbies, 4-letter codes, 25 Hz frame clock). It runs inside `npm run dev`, and `npm run server` serves a build. Tests: `tests/lobbies.test.ts`.
  - Lockstep: `src/game/random.ts` `simRandom` replaces Math.random in game logic, `loadLevel(..., seats)` gives several human slots, and `FixedLoop.backlog` with a stalling tick plays network frames.
  - Verified with two Chrome tabs: create/join, start, identical position checksums (ticks 300–700), and Esc leaving the lobby. Single player still works.
  - Then also done: the host ends the race → both clients return to the waiting room and a second race syncs (browser-tested via the end message). Server-side desync detection (`sum`/`desync` messages, HUD banner), tested by nudging one client. Lobby names in the HUD; records saved under the lobby name.
  - Still untested: Chrome vs Firefox determinism (no Firefox on this machine). The desync banner would show it.
- Start banner (Klara!/Färdiga!/Gå!! with lights, sounds 33/34) is on the canvas HUD; the HTML countdown is gone. The held item is on hand node 8 at (0,300,0) [O]. On localhost the intro is skipped.

- Checkout and Vagnrace decoded [O]:
  - The goal test is the player's body inside the `goal` outline (not the bounding box, not the cart), with the cart in hand.
  - The winner gets the KUNDKORT card in the hand (modes 1–3), and sound 8 plays for any finisher.
  - Vagnrace checkpoints use a 1500 square with the cart in hand, or the floating cart while sliding in Aqua's water.
  - The quiz answer plays no sound; the invented 33/34 were removed.
  - Verified: AIs given a complete list still finish (about 15 s in ICA) with the card in hand.

- **Music:** the user's MP3s are in `music/` (repo root, beside `original/`) as `NN title.mp3`, NN being the CD track. Vite serves them at `/music/` and the build copies them. `AudioEngine.music(track)` loops them through the master gain (M mutes): intro 8 once, menu 7, malls `levels[].music`.
- Fixed: the second load of a sound bank failed ("detached ArrayBuffer") because `decodeAudioData` consumed the cached file.
- Items into the cart [O]: no flight arc. The item's own mesh moves onto the cart at a random spot and rotation (`Cart_AddItem`); only 3 stay visible in modes 1–2.

- **Player collisions** are now the original's PhysWorld solver (`crowd.ts`, ANALYSIS "PhysWorld bodies"):
  - Bodies are made of circles, with Styrka-based masses.
  - On contact: revert to the previous position, push out by half the penetration, and mix the velocities.
  - The Styrka cart knock is rolled every tick of contact.
  - [I] The spin is not applied. Ask the user how bumping feels compared with the original.
- Item markers bob 100 units, phase +0.3 per update every second tick [O].
- **AI driving decoded** (ANALYSIS §4.5 AI):
  - A re-plan starts from the buoy nearest the character.
  - The stuck detector only re-plans; the invented reverse-backoff is gone.
  - The cart is grabbed at CanGrabCart's 3000.
  - Vagnrace steers straight at checkpoints and uses the buoys only after getting stuck.
  - One [I] guard against a start buoy behind the cart.
- **Fixed the stuck-AI cause:** a move onto a spot without a reachable floor was refused outright, which zeroed the velocity and froze the player. It now slides along the edge (keeping the x or z part of the move), as the original's floor-edge walls do.
- Tested: 70 s of Varujakten with no AI stuck; a forced on-buoy re-plan escapes; Vagnrace AIs reach 17–22 of 22 checkpoints in under a minute.

- **Gates and doors** [O]: the original gives non-FLOOR physics objects no collision. Only floor-region edges stop bodies.
  - Gates are now solid only where they stand over a floor gap (`CollisionWorld.openGatesOnFloor`); the start sequence no longer toggles blockers.
  - Doors stay passable, now with evidence: there is no door code at all.
- Done: the floor-edge wall solver is ported (see below).

- **Movement** (user report: turning felt slowed, cart didn't tilt, hands didn't follow):
  - Pushing now uses the decoded frictions, (master 0.70 + cart 0.99)/2 = 0.845 for speed and turning: about twice the top speed, faster and longer-coasting turns.
  - The original's turning brake while pushing is kept (decoded, verified in the disassembly).
  - Reverse is full acceleration, as in the original.
  - Collisions feed back the body speed/direction (clamped) plus the spin kick, as `0x428a70` does.
  - The cart tilts from a four-wheel suspension, and the hands follow the tilted cart's handles.
  - Measured: pushing reaches 229 straight and about 90–115 while turning; walking reaches 188 straight and 183 while turning.
  - Ask the user to compare again.

- **Aqua report** (clipped through the pipe into the water; cart kept being lost and vanished; no cart arrow):
  - Two independent guide arrows now, as in the original: the item arrow lower left, the cart arrow lower right whenever you're not pushing.
  - Walking off a ledge more than one step (450) down is now a floor edge (the original's floor-edge walls); sliding, falling and launches are exempt.
  - Exception: drops into an Aqua water current (`mvnc` area within its height range) are allowed, since the canal joins the walkway. Without it, the slide could not be entered (user report). Verified: canal → tunnels → exit at (9012, 9000, −38974).
  - (Superseded by the ported floor-edge walls below.)
  - The gate rule now samples at the gate's own base, so a floor far below doesn't count.
  - Losing the cart in the currents/pipe is original behaviour (mvnc releases it every 5 ticks; it floats away); the cart arrow finds it.
  - AIs in Aqua still progress.

- **Floor-edge walls ported** (`floorEdges.ts`, ANALYSIS "Floor regions and walls"):
  - Players and carts now hit the edges of the floor regions with the original's swept cut and 0.2 bounce, every part of the body included.
  - Links between floors allow drops of up to 2500 and step-ups of up to 300 (walker) or 240 (cart).
  - Removed: the mesh walls for players and carts, the ledge rule and the Aqua exception.
  - Tested: you stop at a shelf (x 4762); a cart slides along a wall at 45°; ICA AIs collected 3–5 items in 40 s; the Aqua slide runs end to end.
  - The edge end-point (corner) pass is ported too. Tested: driving at a shelf corner deflects you and you slide along the side.

- **User report** (Aqua cart stuck in the ramp; grab teleported into the slide; Future arrow buggy):
  - The pushed cart now rides at the average of its wheel heights, not the character's, so on a ramp it sits on the slope.
  - A released cart settles onto the floor.
  - Grab is the original walk-to-handle (turn, walk up to 1000, swing the cart, attach at the character); there is no snap.
  - The item arrow target is the original's sticky one: no flipping between items in different areas; hidden while an item is carried.
  - Future routing (ARE1/ARE2/ARE4 → EXI1–4) was already decoded correctly. Ask the user whether the arrow now leads to the right stairs/tubes.

- **Thrown items** [O]: they use the floor-edge walls (radius 150, step 500, position only: they slide along walls instead of the invented reflection), and only free-standing carts catch them. Tested: a high throw clears a shelf and lands as a pickup.
  - Not ported: thrown items colliding with players' bodies (mass 2 against about 165, so they would barely move anyone).

- **User confirmed (2026-10-24):** Aqua (walls, ramp, slide, cart grab) and the guide arrows feel right now.

- **User report** (Vagnrace/Varujakten):
  - The winner now plays `s_winner.anm` at the goal and the others stand (decoded).
  - Network: a non-host player's ENTER after the race now returns that player to the waiting room ([I]); the host's ENTER still ends it for everyone. The client ignores frames while it isn't racing.
  - Not browser-tested with two tabs.

- **Animation and loops** [O]:
  - The run animation is one frame per tick while the throttle is held (no longer speed-scaled); otherwise the stand plays.
  - Turn lean on nodes 1/2 (2L/L, L = 5600 · turn rate / top turn rate).
  - Footsteps while the throttle is held; cart rolling while the cart moves faster than 45 or turns faster than 0.012; both at full volume.
  - Ask the user whether the turn lean looks as strong as in the recordings.

- **HUD sounds** [O]:
  - The doorbell (28) now rings for Matkrig announcements and when the list completes, with the loudspeaker icon by the banner.
  - "Mot kassorna!!" also shows in Matkrig at 5 items.
  - An item into the cart plays 22, not the doorbell.

- **Arrow orientation** [O]: the arrows lie flat (camera pitch cancelled) and wobble with speed and turn rate (decoded offsets and scales); the invented fixed tilt is gone.
- **Winner animation** (user: "lets go of the cart and moves the arms up and down"):
  - `s_winner` and the stand animation now step every second tick, as in the original; the port had them at double speed.
  - The original's race-over branch has no hand IK, so the winner does release the handle. Ask the user whether the recordings show otherwise.

- **Remaining [I] markers** (2026-10-24): none affect gameplay any more.
  - Shopping lists: verified that every mall stocks all 24 types, so lists match the original's `rand() % 24 + 1`.
  - Left: rendering details (texture/colour-key conventions, quiz text wrap, glyph fallback), the hand IK solver (port's own two-bone solve versus `0x4336b0`), and browser/network choices.
  - Next steps depend on the user's play-testing reports.

- **Public/private lobbies:**
  - The host page has a "Lobby" row (Offentlig/Privat); the rows are now 80 apart.
  - The new "Sök nätspel" page lists joinable public lobbies (server `list` → `lobbies`), refreshed every 2 s; ENTER joins.
  - Tested: unit test, plus a public lobby in one tab joined from the list in another.

## Continue with (in this order)
1. **Done:** Aqua's slide, the `s_oops` pose, SPLASH, floating carts, `c_ac` fixed cameras and the original chase camera (ANALYSIS §4.11). Ask the user to compare with the original.
   - Orient/Future `mvnc` launch pads, `hurl` and `tele` are done too (ANALYSIS §4.11). Fall gravity is now the decoded 18 per tick.
   - `PUNK`/`ARE*`/`EXI*` arrow routing and the Orient gong are done; every .eo object type is now decoded (only `c_di`/`c_nc` remain unported, and no mall uses them).
2. **Original menu: done** (`src/menu/`): intro, main, mode, character (3D runner), mall, options, records, quit; player counts, random opponents, `toplevel` unlocking and difficulty are wired in.
   - Name entry after a new record and the character stats (speed, turning, Styrka cart knocks) are done too.
   - 3D textures now sample texel centres (`texelUV` in `meshFactory.ts`), which removed the atlas lines along polygon edges (the user saw them on the QUESTION model). Faint lines can remain at small mip levels.
   - Still to do:
     - music: done (`music/`)
3. Per-mall extras are done: Aqua's spinning SKYLT signs, water sounds, and the Orient gong. The ICA/Orient SIGN_FELIXPO animation is dead code in the original (no such object).
4. Optional:
   - Floors only from `*FLOOR*` objects: already the case (`CollisionWorld.floorAt` only uses FLOOR regions).
   - AR/IN visibility culling: deliberately not ported. It only saved rendering on 1999 hardware and would add pop-in.
5. Network play: play it through with real players on two machines. The "Väntar..." banner (waiting for everyone to load) is done too.

## Notes
- The user plays the original and reports differences. Trust those reports and look for the original code behind them.
- Keep `re/ANALYSIS.md` and `web/README.md` updated. Mark guesses [I] and decompiled facts [O].
