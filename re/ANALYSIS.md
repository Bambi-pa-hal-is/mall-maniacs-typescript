# Mall Maniacs (1999): Reverse-Engineering Notes

The target is `original/maniac.exe`. The original files were never modified: all analysis ran on copies inside a Ghidra project in the scratchpad, and the outputs live in `re/`.

| File | SHA-256 |
|---|---|
| maniac.exe (352,256 B) | `853258de4eb87d8c81e6b1a25c29c331d239e9e6383f9aa2fa984d9601d575ac` |
| Drivers/gxOpenGl.dll | `95ac923d26a85ace28ec4d4387dfd8e207704d3a4771670013694dcd5e0e835d` |
| Drivers/GxGlide.dll | `e8918bec1de745b972adc410c49af55dfaed4ba27f06d3a9ac99306eba6ec166` |
| Drivers/gxSoft.dll | `2cd8a27b2b4ce9d317e54acd15c462da5f60766d4f9a416ef37cde38b4cc2453` |

Tooling:
- **First pass:** Ghidra 12.2 `analyzeHeadless`, run directly on JDK 25 with `re/tools/DumpAll.java`.
- **Second pass** (mesh, animation, render path): REA using its Ghidra 12.1.4 provider (`GHIDRA_INSTALL_DIR=C:\ghidra`, `JAVA_HOME`=Temurin 25). Addresses are identical between the two passes.

`DumpAll.java` writes the following to `re/ghidra/`:
- `*.info.txt`: sections, entry point, and imports
- `*.strings.txt`: strings plus the functions that reference them
- `*.functions.txt`: every function with its size and callees
- `*.decomp.c`: full decompilation

Throughout this document, **[O]** marks something observed directly in code or bytes, **[I]** marks an inference, and **[?]** marks an open question.

---

## 1. Binary identity

- **[O] Format:** PE32 GUI executable for Intel i386, image base `0x00400000`, three sections (`.text 0x401000–0x44afff`, `.rdata`, `.data`). The CRT entry point is `entry @ 0x0043f18e`.
- **[O] Language and toolchain:** C++ built with MSVC 5/6 (statically linked MSVC CRT). The binary contains old iostream RTTI (`.?AVifstream@@`, `.?AVfilebuf@@`), SEH frames, and `__ftol`. The game code mixes C-style subsystems with a few C++ classes (`UdpClient`, `GameServer`, `GameClient`).
- **[O] Version string:** `"Mall Maniacs %s"` with `"v0.40"`. maniac.cfg calls itself the "DFF version".
- **[O] Engine lineage:** the binary reads the registry key `Software\UDS\No Fear MTB\Drivers`. The engine is UDS's in-house engine from *No Fear Downhill Mountain Biking*. Subsystem names in log strings are "Spitfire" (3D/scene), "Scenery", "PhysWorld", "Event", "Gx" (driver layer), and "DFF" (config format).
- **[O] Packing:** none. Code is readable directly and the strings are plain.

### Imported libraries ([O], from `re/ghidra/maniac.exe.info.txt`)
| DLL | Used for |
|---|---|
| KERNEL32 | CRT, threads/mutexes/events (networking), file I/O, `LoadLibraryA`/`GetProcAddress` for the render driver, `QueryPerformanceCounter` |
| USER32 / GDI32 | Window, message pump, cursor, `MessageBoxA` |
| DINPUT | `DirectInputCreateA` (version 0x300): keyboard and mouse devices |
| DSOUND | `DirectSoundCreate`: sound effects |
| WINMM | `timeGetTime` (game clock), `mciSendCommandA` (`"cdaudio"` CD-audio music) |
| ADVAPI32 | Registry lookup for the driver path and version |
| WSOCK32 | UDP sockets for LAN multiplayer |

**Rendering is not imported directly.** It goes through a plug-in driver DLL loaded at runtime. That DLL exports `gxDLLInit`, `gxDLLInfo`, `gxDLLExit`, and `gxDLLUpdate`. Three drivers ship with the game:
- `DRIVERS\GXGLIDE.DLL` (3dfx Voodoo)
- `DRIVERS\GXSOFT.DLL` (software rasterizer)
- `gxOpenGl.dll`

**[O]** `gxOpenGl.dll` imports only immediate-mode GL: `glOrtho`, `glVertex3f`, `glTexCoord2f`, `glColor4f`, and `glTexImage2D`, and never sets a perspective projection. **[I]** The engine therefore transforms, lights, and projects everything itself on the CPU. The driver only rasterizes screen-space triangles. This matters for the port: there is no GPU-side scene graph to recover, only the engine's own data.

---

## 2. Startup and initialization chain ([O] unless marked)

```
entry 0x43f18e                     MSVC CRT start-up
└─ WinMain  FUN_004160a0
   ├─ FUN_004165f0  CreateGameWindow
   │     RegisterClassExA/CreateWindowExA("Mall Maniacs"), SetEnv FX_GLIDE_NO_SPLASH,
   │     DirectInput: keyboard + mouse devices acquired
   ├─ FUN_00409d90  AppInit
   │     ├─ construct globals, FUN_0040a150 ×8 players (stride 0x374)
   │     ├─ FUN_00408b60  console/command interpreter setup
   │     ├─ read maniac.cfg, XOR 0x55, write temp "sommar.sol",
   │     │  FUN_00435890 parse DFF, delete temp
   │     ├─ FUN_00410350  read `master` block (obj_update_time, map*, ai_mode, log*)
   │     ├─ driver select: cfg "driver" → GXGLIDE → GXSOFT   (FUN_00432ea0 LoadDriver)
   │     └─ FUN_004332f0  SetVideoMode(640, 480, 16bpp)
   └─ main loop (PeekMessage)
        if !inGame: FUN_0041a8c0 MenuFrame   (menu init FUN_00419c20, exit FUN_0041a670)
        else:       FUN_0040ad80 GameFrame
   on quit: FUN_0040aa10 GameExit / FUN_0041a670 MenuExit, FUN_0040a490 "Meltdown..."
```

### Level start: `FUN_0040a4d0` (mm_init)
The order below is how a level comes up:
1. Memory init, set video mode, `FUN_004197a0` (default memory pools).
2. `FUN_0042ed40(100000,40000,40000,2000,2)` PhysWorld init and `FUN_00431cb0` Spitfire init.
3. `FUN_004104b0`: load the level scene (`levels[n].scene_file`, plus physics scene `ph<scene>.sen`, plus textures `merged%02d.tpg`).
4. Show `%s\hud\load.tga`, then `FUN_004108a0` loads items, characters scene, objects scene, the level startup script (`nload *.ai`, `eload *.eo`), music, and detail levels.
5. Link visual areas `AR%02d` to `IN%02d` (portal/visibility areas, `FUN_0042b410`).
6. Fonts (`font.txt`, `hudfont.txt`, `tinyfont.txt` with their TPGs) and HUD textures (`FUN_00412700`).
7. Place shop items (`FUN_00430660`).
8. `FUN_00410e90` loads the player config (characters, carts, acc/friction), `FUN_00411550` creates objects and animations, and `FUN_00411b70` sets up the camera and start positions.
9. Hide `__HIDE_ME__` meshes, load `quest.txt` (`FUN_0040ffa0`), init sound (`FUN_00437a30`, `FUN_00437170 "sound\"`), init CD music (`FUN_00416cc0`), and init the clock.

### Frame and tick model ([O] `FUN_0040ad80`)
- The game uses a **fixed-timestep simulation**. The step is `obj_update_time = 40 ms` (25 Hz), from maniac.cfg. The loop runs at most 26 catch-up ticks per frame, after which it resynchronizes.
- Every tick calls `FUN_0040b3d0` GameTick. It does the following:
  - input (`FUN_00416820`)
  - player and AI updates
  - network (`FUN_0040beb0`, `FUN_00414fa0`)
  - pickups (`"action get item"`)
  - events (`FUN_0040c800`)
  - object update (`FUN_00434b00`)
  - the nav editor (`FUN_00426ee0`)
- Every second tick calls `FUN_0040cf40`, a 3 KB routine for the guide arrow and minimap. It finds the nearest wanted item and points the `VARUPIL` arrow at it. (An earlier version of this document wrongly called it physics.)
- `FUN_0040beb0` (also every tick) runs the **race start**:
  - a 7000 ms countdown (`DAT_004588f0`), `DAT_00458124 = ((7000 − tick·40) + 500) / 1000`. The number itself is never drawn. The end of Hud_Draw shows the start banner (gfx2200 (0,0)-(255,50) at (192,50)-(447,101), tiny text at y 68): empty while counting; when it reaches 5 (time saved in `DAT_004589a0`), "Klara!" for 750 ms, empty, then "Färdiga!" from 2250 to 2750 ms, each with red lights gfx2200 (101,151)-(142,170) at (207,64)-(249,84) and (391,64)-(433,84) and sound 33. After the start the value goes −20…0 with "Gå!!" and green lights (143,151)-(184,170), the right one mirrored, and sound 34 (`DAT_004589a4` = lit state). [O]
  - every player's velocity is zeroed while the countdown runs
  - in the last 250 ms, start gates `GRIND2, GRIND4 … GRIND16` (handles looked up in `Gates_Init 0x40bdf0`) are rotated with `FUN_004307d0(gate, 0, ry, 0, mode 5)`, where mode 5 is a relative rotation
  - `ry = 40 × ±56.60377` int16 angle units per tick (floats at `0x44b488`/`0x44b48c`), with the sign alternating by gate index. Over the final 7 ticks the double doors swing about 87°.
  - the odd-numbered gates form the closed back row
  - **[I]** The physics blockers (`GATE*` in ICA, `GRIND*` elsewhere) next to the opened gates become passable.
- **Movement:** player and AI both write the control values `+0x2e0` (turn, −1..1) and `+0x2e4` (throttle) in the player struct. AI steering is `FUN_00401ae0`. The cart-ride integrator `FUN_004280b0` applies `angVel = rotAcc·turn + rotFric·angVel; heading += angVel`.
- **Movement constants** (`LoadPlayerConfig 0x410e90`): `acc = master.acc·(speedStat·0.06+0.7)`, `rotAcc = master.rotate_acc·(agilityStat·0.1+0.5)`, `maxSpeed = acc/(1−friction)`, with `_WC` variants for carrying a cart.
- `FUN_00437c50` runs once per tick for sound.
- Rendering happens once per frame: `FUN_0040ae30` draws the 3D scene and HUD (`FUN_00412810` is the 7 KB HUD/score/quiz screen), then `FUN_0042bf40` presents.
- The clock is `FUN_0040dfe0`: a `timeGetTime` accumulator that pauses while the window is inactive.

### Built-in console commands ([O], table at `0x44b30c–0x44b43c`)
`action`, `collision`, `eload/esave/ename/evalue/eheight` (event objects), `nload/nsave/nclean` (nav buoys), `mfind`, `movie play/record/load/save/clear`, `reset master|player|object`, `run <level>`, `request`, `status`, `log`, and `help`. Level startup scripts call these commands, and they also serve as a debug and editor interface.

---

## 3. Game content and design facts

- **Malls** ([O] maniac.cfg `levels[]`):

  | # | Name | Folder | Scene file | Music track |
  |---|---|---|---|---|
  | 0 | ICA | `scene_ica` | `mall1_ica.sen` | 2 |
  | 1 | Woodshop | `scene_wood` | `woodmall.sen` | 3 |
  | 2 | Orient | `scene_orient` | `orientmall.sen` | 4 |
  | 3 | Aqua | `scene_aqua` | — | 5 |
  | 4 | Future | `scene_future` | — | 6 |

  Each level has 8 start positions `{x y z rx ry rz}`. Music is a CD-audio track number.
- **Game modes** ([O] strings):
  - *Varujakten* ("goods hunt"): collect your shopping list.
  - *Matkrig* ("food fight"): throw items.
  - *Vagnrace* ("cart race").

  The high-score tables are `fshi*` and `vahi*`.
- **Players:** up to 8. Controllers include `MM_CONT_KEY1` and `MM_CONT_AI`. Each player has a character and a shopping cart (`REDCART` or `GREENCART`) with `handle_pos` grab points.
- **Characters** ([O]): ten playable characters plus NPCs, for example Hugo Spandex, Hektor Kvot, Susanne Spira, Klara Blixt, Kalle Kallsup, and Kajsa Komet. NPCs include the cashier `KASSOERSKA`, `BURGER`, and `MCDMAN`.
- **Physics constants** ([O] `master`):
  - `acc = 64`, `friction = 0.70`, `rotate_acc = 0.032`
  - `_WC` variants: `acc_WC = 40.5`, `rotate_acc_WC = 0.026`. **[I]** "WC" means "with cart".
  - Cart: `weight 20`, `friction 0.99`.
- **Camera** ([O]): `pos {0 -1990 -2200}`, `aim {0 -1900 0}`, `rot_speed 20`, `rot_max 4`. It is a chase camera behind and above the player.
- **AI** ([O] `FUN_00401160`): a state machine with these states:

  `GOTOITEM → RELEASECART → GRABOBJECT → PUTOBJECTINCART → GRABCART → SETTARGETITEM → (GOTORANDITEM | GOAL → END)`

  The AI navigates a **nav-buoy graph** loaded from `*.ai`.
- **Quiz** ([O]): `quest.txt` holds yes/no questions as `difficulty text J|N`. **[I]** They are asked at the checkout; the HUD shows "Klara!" and the J/N prompt.
- **Multiplayer** ([O]): a custom UDP protocol (`GS_ID`, `GS_PING`, `GS_USER_MSG`, `GS_VERIFY`, ...) with threaded client and server classes. For the browser port this is optional; WebRTC or WebSocket could replace it later.

---

## 4. Asset formats (the key to the port)

| Asset | Format | Status |
|---|---|---|
| `maniac.cfg`, `config.mm`, `quest.txt` | Text **XOR 0x55** ([O] `FUN_00409d90`). Decoded copies are in `re/decoded/`; use `re/tools/xor55.py`. maniac.cfg/config.mm are DFF text (`key = value`, `{}` blocks, `name[]` arrays, `"strings"`, `//` comments). | Solved |
| `*.ai` | Plain DFF text: nav buoys `NNNN { ID X Y Z NLINKS LINKS { LINK=.. } }` | Solved |
| `*.eo` | Plain DFF text: event objects `_NNN { x y h h2 values { v×5 } }`. **[I]** Each is a 2D trigger area plus height; the 4-char name prefix is the event type. | Mostly solved |
| `*.TPG` | **[O]** 256×256 bytes of 8-bit indices, then 256 × RGBX palette (R, G, B, unused). 66,560 bytes total. Loader: `FUN_00416060` passes `(pixels, pixels+0x10000)` to the driver. Verified by converting to PNG. Level TPGs are **texture atlases** (`MERGEDnn`). | Solved |
| `*.tga` | Standard TGA (loading screens, intro logos, HUD). | Standard |
| `sound/*.wav` | RIFF PCM 16-bit mono 22,050 Hz | Standard |
| Music | Red Book CD audio via MCI. Tracks 2–6 are the malls (`levels[].music`), 7 the menu, 8 the intro. Not in `original/`; the user supplied them as MP3 in `../music/NN title.mp3`. | Done |
| `*.SEN` | **[O]** Chunked: `"REV2" u32 size`, then `{tag[4] u32 size data}`. Tags: `MESH`, `NAME` (one each per mesh), `COLS` (u32 colors/flags), `MAPI` (16-byte UV/texture records; `[0]` is a texture index into `TNAM`), `SUBO`, `TNAM` (NUL-separated texture names), `OBJI` (32-byte object instances), `ONAM` (object names). The loader (`FUN_00432320`) also knows `TANI` (texture animation), `KEEP`, and `TEMP`. | Container solved; mesh internals partial |
| `MESH` chunk | Fully decoded; see §4.1. Decoder: `re/tools/sen2obj.py`. | **Solved** |
| `ph*.sen` | Same SEN container, holding a collision/"physics" version of each mall. It decodes with the same tool. | Solved (format) |
| `*.anm` | Fully decoded; see §4.2. Parser: `re/tools/anm.py`. | **Solved** |
| Font `.txt` | Plain text glyph metrics (`width`, `heigth`, `pos<c>`, `spacewidth`, `globalspace`, `squeeze`). | Solved |

### 4.1 SEN scene and MESH layout
Sources: REA/Ghidra 12.1.4 decompilation of `Sen_Load 0x432320`, `Sen_FixupMesh 0x4320f0`, `Spitfire_DrawObject 0x42f8c0`, `Spitfire_DrawPrimGroup 0x42e940`, `Mesh_GetVertexFrame 0x4300d0`, and `Node_UpdateWorld 0x42f6e0`. The layout was validated by decoding **all 22 `.SEN` files** with 0 out-of-range indices, then rendering the ICA mall and posed characters with correct textures.

All integers are little-endian. "Offsets" are relative to the base named in each row; the loader turns them into pointers in `Sen_FixupMesh`.

**Scene-wide chunks**
- **`MAPI`**: 16-byte texture-map records: `i32 textureIndex` (into `TNAM`, replaced by a driver handle at load), `u16, u16` (unknown), then `u8 u,v × 4` corner UVs in texel units of the 256×256 atlas.
- **`COLS`**: 4-byte records: `R, G, B, flag`.
- **`SUBO`**: holds the primitive groups for every mesh.
- **`TANI`**: texture animation; not decoded yet.
- **`OBJI`**: 32-byte instances:

  | Offset | Type | Field |
  |---|---|---|
  | +0x00 | i32 | name: **byte offset** into `ONAM` (not a list index) |
  | +0x04 | i32 | type (1 = mesh object; 3 also occurs, only in `ENDSCENE.SEN`) |
  | +0x08 | i32 | parent |
  | +0x0C | f32 ×3 | x, y, z |
  | +0x18 | i16 ×3 | rx, ry, rz |
  | +0x1E | i16 | mesh index |

**MESH header** (self-relative)

| Offset | Field |
|---|---|
| +0x04 | LOD count |
| +0x08 | node count N |
| +0x0C | offset → N × `{i16 x,y,z,pad}` node offset from parent |
| +0x10 | offset → N × `{u8 parent, pad[3]}` (0 = object root; entry *i* describes node *i+1*) |
| +0x14 | offset → LOD table |
| +0x20 | MAPI offset (relative to the scene's `MAPI` chunk when shared) |
| +0x28 | COLS offset (relative to the `COLS` chunk when shared) |

**LOD record** (base = LOD table)

| Offset | Field |
|---|---|
| +0x00 | switch distance |
| +0x04 | vertices per frame |
| +0x08 | offset → vertices `{i16 x, i16 y, i16 z, u8, u8}`. There are frames × count vertices; `Mesh_GetVertexFrame` blends frame A and B for morph animation. |
| +0x14 | primitive group count |
| +0x18 | offset → pointer list; entries are offsets **into SUBO** |
| +0x1C | vertex-group count |
| +0x20 | offset → 12-byte vertex groups `{i32 vertexCount, i32 ?, i32 nodeIndex}`. Vertices are assigned to nodes sequentially by group. |
| +0x24 / +0x2C | second, per-node primitive list. It is unused (0) in every shipped file. |

**Primitive group** (in SUBO)

| Offset | Field |
|---|---|
| +0 | u8 primitive count |
| +1 | u8 vertices per primitive (1 point, 2 line, 3 tri, 4 quad) |
| +2 | u16 flags: bit2 = has UV (MAPI) index, bit3 = has color (COLS) index, bit5 = alternate draw path `FUN_0042ecf0` ([I] transparent/sorted) |
| +6 | u8 stride in u16 units |

Primitives start at +8. Each primitive is `u8 index[4]`, then `u16 colorIdx` if bit3 is set, then `u16 mapiIdx` if bit2 is set.

**Coordinates**
- **[O]** World units are integers. The engine is **Y-down**: camera and character heights are negative.
- To convert to Three.js, negate both Y and Z, which is a 180° rotation about X. Negating only Y mirrors the scene, which was observed as reversed signs.
- **[O]** Angles are i16 with **65536 per turn**: the constant at `0x44b788` is 2π/65536.

**Node transform**
- **[O]** `Node_BuildLocalMatrix 0x42f030`: local rotation = **Ry(ry)·Rx(rx)·Rz(rz)**, times a uniform float scale.
- World matrix = parentWorld · local.
- World position = parentWorld · localOffset + parentPos.
- In Three.js space after the axis flip, use `Euler(rx, -ry, -rz, 'YXZ')` with each angle scaled by 2π/65536.

**Characters**
- **[O]** Characters are rigid-segment models with **15 nodes plus the root**: a pelvis/torso chain, head, 2×3 arm nodes, 2×3 leg nodes, and a hold point (node 9).
- Every `CHARACTERS.SEN` has 16 vertex groups. The bind pose spans Y −849 (head) to +849 (feet), and instances sit at Y −850, so the feet are on the floor.

### 4.2 ANM animation format
Sources: `Anm_LoadFile 0x433a50` and `Anm_Parse 0x433a90`. All 19 shipped `.anm` files parse to exactly end-of-file. ROLAND posed with `s_run.anm` frames 0 and 4 renders a natural running stride.

Layout:
- `"ANM"` + version byte (1 or 2)
- `u16 nObjects`, then for each: `u8 len, name`
- `u16 nNodes`, then for each: `u8 len, name, u16 nodeIndex`. Shipped files have 16 nodes named after the base character.
- `u16 nFrames`, then for each frame: `u16 nCmds`, followed by that many commands.

| Cmd | Payload | Meaning |
|---|---|---|
| 5 | `u16 node, i16 rx, ry, rz` | Node rotation, in the units and order of §4.1 |
| 6 | `u16 node, i32 x, y, z` | Node position. Shipped files set only node 0: y is the root height above the floor (849 standing, 739–849 bobbing in the run cycle) and z is a forward lean (79–180). |
| 1, 2 | 3 × 4-byte | **[?]** Not used by any shipped file |
| 3 | `u16 obj` + 3 × 4-byte | **[I]** Object position. Not used by any shipped file. |
| 4 | `u16 obj, i16 ×3` | **[I]** Object rotation. Not used by any shipped file. |

**[I]** Each frame is one game tick (40 ms), and commands persist until overwritten. The playback/interpolation code still needs confirming; follow the callers of `Anm_Parse`'s result in `CreateObjects 0x411550` (stored at player struct `+0x9e..0xa8` × 4).

### 4.3 Tools in `re/tools/` (read-only on `original/`)
- **`sen2obj.py <scene.sen> <texdir> <outdir>`**: SEN → OBJ + MTL + PNG atlases. It applies instance placement and the node bind pose.
- **`batch_sen.py <original> <outroot>`**: converts every SEN and prints stats. Its output is already in `re/export/`.
- **`anm.py <file.anm>...`**: parser and summary.
- **`pose.py <characters.sen> <texdir> <MESH> <file.anm> <frame> <outdir>`**: poses a character with one animation frame (reference implementation of the node math).
- **`objpreview.py`**: tiny numpy rasterizer for checking exports without a 3D app.
- **`xor55.py`**: decodes the XOR-0x55 config and quiz files.
- **`DumpAll.java`**: headless Ghidra dump.
- **`ApplyNames.java`**: applies the function map below inside a Ghidra GUI project. REA's Windows Ghidra session is read-only, so the names can't be stored there.

---

## 5. Recommended browser reconstruction

### Stack
- **TypeScript + Vite** for the build.
- **Three.js** for graphics. It maps directly onto what the engine does: indexed-palette atlases become `DataTexture` with `NearestFilter` for the authentic look, meshes become `BufferGeometry`, and rigid segment hierarchies become `Object3D` trees.
- **Web Audio** for WAVs, plus `<audio>` or OGG for the CD tracks.
- **KeyboardEvent / Gamepad API** in place of DirectInput.
- Babylon.js would also work. Three.js stays closer to the engine's low-level model.

### Architecture, mirroring the original
```
src/
  formats/  dff.ts (cfg parser), xor55.ts, tpg.ts, sen.ts, anm.ts, ai.ts, eo.ts, font.ts
  engine/   loop.ts (fixed 40 ms tick, max 26 catch-up, render per rAF)
            scene.ts (SEN → THREE.Group, AR/IN visibility areas optional)
            physics.ts (acc/friction/rotate_acc; collision vs ph*.sen)
            anim.ts (ANM → per-node keyframes)
  game/     player.ts, cart.ts, ai.ts (state machine from §3), items.ts,
            events.ts (.eo triggers), quiz.ts, hud.ts, camera.ts, modes/{varujakten,matkrig,vagnrace}.ts
  menu/     menu.ts (TPG/TGA sprites, menyfont), hiscore (localStorage instead of config.mm)
  console/  commands.ts (port the debug console: nload, eload, run, reset ...)
```

### Best starting points, in order
1. **Asset pipeline, with no RE needed:** the DFF parser, XOR decode, TPG→`DataTexture`, the WAV loader, and SEN chunk walking. These can be written and tested now. Build an offline converter (Node script) that turns `original/` into web-friendly assets (PNG/KTX2, JSON, glTF). The browser then loads clean files, and the original data stays untouched.
2. **Mall viewer:** both MESH and ANM are decoded (§4.1–4.2). Port `sen2obj.py` and `pose.py` to TypeScript (`formats/sen.ts`, `formats/anm.ts`), or have the offline converter emit glTF. In Three.js:
   - one `BufferGeometry` per mesh, triangulating quads as (0,1,2)+(0,2,3)
   - UVs = MAPI bytes / 256
   - `NearestFilter` textures
   - an `Object3D` per node, using `Euler(rx, -ry, -rz, 'YXZ')`

   The first milestone is `MALL1_ICA.SEN` with a free camera.
3. **Animated characters:** drive the node `Object3D`s from ANM frames at 25 Hz. **[I]** The `_2` mesh prefix is detail level 2; see "Setting up detail levels" and `FUN_0042ad00`. Still open: confirm the playback rate and interpolation in the game code.
4. **Gameplay feel:** decompile `FUN_0040cf40` (movement and physics), `FUN_00410e90` (how acc/friction/rotate_acc are applied), and `FUN_00411b70` (camera). Port these in the fixed 25 Hz tick and interpolate rendering.
5. **Rules:**
   - AI state machine: `FUN_00401160`, `FUN_00401e40`, `FUN_00401eb0`, `FUN_00401fb0`
   - pickups and items: `FUN_0040ec40`, `FUN_0040b510`
   - events: `FUN_0040c800`
   - per-mall scripted NPCs: `FUN_00416db0`, `FUN_004175e0`, `FUN_00417dc0`, `FUN_004186c0`, `FUN_00418f30` (one per mall)
   - HUD and quiz: `FUN_00412810`
   - menu: `FUN_00419c20`, `FUN_0041a8c0`
6. Networking last, or never.

### Useful function map (rename in Ghidra as you confirm)
| Address | Proposed name | Confidence |
|---|---|---|
| 0x004160a0 | WinMain | O |
| 0x004165f0 | CreateGameWindow / InitDirectInput | O |
| 0x00409d90 | AppInit (cfg decrypt, driver select, video mode) | O |
| 0x00435890 | Dff_LoadFile | O (called with cfg path) |
| 0x00436560 / 0x00436a20 / 0x00436990 | Dff_FindBlock / Dff_GetFloat / Dff_GetString | I |
| 0x00410350 | LoadMasterConfig | O |
| 0x00432ea0 / 0x00433280 | Gx_LoadDriver / Gx_UnloadDriver | O |
| 0x004332f0 | Gx_SetVideoMode | I |
| 0x0040a4d0 / 0x0040aa10 | Game_Init (mm_init) / Game_Exit | O |
| 0x004104b0 / 0x004108a0 | LoadMallScene / LoadLevelContent | O |
| 0x00432320 | Sen_Load (REV2 chunk reader) | O |
| 0x004320f0 / 0x00432260 | Sen_FixupMesh / Sen_ResolveTextures | O |
| 0x00416060 | Tpg_LoadTexture | O |
| 0x00410e90 / 0x00411550 / 0x00411b70 | LoadPlayerConfig / CreateObjects / SetupCameraAndStarts | O |
| 0x0040ad80 / 0x0040b3d0 / 0x0040cf40 | GameFrame / GameTick / GuideArrow_Update | O |
| 0x0040bdf0 / 0x0040beb0 | Gates_Init / RaceStart_Tick | O |
| 0x00401ae0 / 0x004280b0 | Ai_Steer / CartRide_Integrate | O/I |
| 0x0042ad00 / 0x0042b1d0 | DetailLevels_Setup / DetailLevels_Update | O |
| 0x004307d0 | Object_SetRotation (mode 1 add, 2 set, 5 relative matrix) | O |
| 0x0040dfe0 | Clock_GetMs | O |
| 0x00401160 | Ai_UpdateStateMachine | O |
| 0x00408b60 / 0x004089e0 | Console_Exec / Console_Dispatch | O |
| 0x00407e10 / 0x00406cb0 | NavBuoys_Load / EventObjects_Load | O |
| 0x0040ffa0 | Quiz_Load | O |
| 0x00412810 | Hud_Draw | I |
| 0x00419c20 / 0x0041a8c0 / 0x0041a670 | Menu_Init / Menu_Frame / Menu_Exit | O |
| 0x00426b00.. / 0x00439730.. | Net_* / UdpServer/Client | O |

---

### 4.5 Nav buoys, event objects, shopping and AI

**`.ai` nav buoys** (`NavBuoys_Load 0x407e10`)
- Each buoy is `NNNN { ID X Y Z NLINKS LINKS { LINK = id … } }` in engine coordinates.
- `NavBuoy_Nearest 0x4259d0(x, z, yMin, yMax)` returns the nearest buoy in XZ among those with yMin < Y < yMax. Callers pass `y−400 … y+1000`; mall 4 uses ±10000. It falls back to the first buoy.
- `NavBuoy_NextHop 0x425bd0(from, to)` fills per-buoy costs to the destination (`0x425af0`), then returns the linked buoy with the lowest cost.

**`.eo` event objects** (`EventObjects_Load 0x406cb0`)
- The file is 2D: `x` = engine **Z**, `y` = engine **X**, `h`/`h2` = floor height (engine Y).
- `name[N]` (or `name [N]`) is followed by N blocks.
- Event names:

  | Name | Meaning |
  |---|---|
  | `_001` … `_025`, `_031` | item spots, type = number |
  | `_2xx` | food-fight spots (mode 4) |
  | `goal` | checkout, with `line [4] { x1 y1 x2 y2 }` boundaries relative to the object |
  | `AR`/`IN` | visibility areas |
  | `c_ac` | fixed camera (§4.11 Camera) |
  | `mvnc` | Aqua: water current (§4.11 Aqua water slide); Orient/Future: launch pad |
  | `hurl`, `tele` | push toward the anchor / teleport (§4.11 Launch pads and teleports) |
  | `PUNK`, `ARE1/2/4`, `EXI1-4` | guide-arrow routing (§4.11 Guide arrow routing) |
  | `gong` | Orient: sound 35 once when the human comes within 2500 on both axes (`0x418000`) |
  | `c_di`, `c_nc` | camera height scaling / no wall pull (none in the shipped .eo files) |

  - **Fields [O]** (`0x414700`, loader `0x406cb0`): type = first 4 name chars at `+8`; `x`/`y`/`h`/`h2` at `+0x38`/`+0x3c`/`+0x40`/`+0x44`; `values { v×5 }` at `+0x10`…`+0x20`; lines at `+4`. `0x414a90(type, n)` finds the n-th of a type, `0x414a40` the next one, `0x414bb0(z, x)` is the inside-area test.

- `Game_Init` places item *i*'s mesh (`items[i-1].mesh` from `OBJECTS.SEN`) 1000 units above spot `_00i`.

**Shopping** (`LoadPlayerConfig 0x410e90`)
- The player struct holds 10 list slots at `+0x184` (`rand() % 24 + 1`, distinct), found flags at `+0x1ac`, the in-hand item at `+0x17c` and "holding cart" at `+0x174`.
- **Checkout** (RaceStart_Tick `0x40beb0`, modes 1–3) [O]:
  - The list is complete (+0x17c count 10, Matkrig 5): set flag 0x20 ("Mot kassorna!!").
  - If the player is also holding the cart (+0x174) and their own body (+0x2a4 object, x/z at +0x20/+0x24) is inside the `goal` outline (`0x414bb0`), the race ends (`DAT_00458130` = 1, winner `DAT_00458134`).
  - KUNDKORT (`objects.sen`) is attached to character node 8 at (0, 150, 0) with rx 32000 (`0x430200` args: parent, node, x, y, z, rx, ry, rz, mesh), and sound 8 plays for whoever finished.
- **Vagnrace** (mode 4, `0x40c54b`) [O]:
  - The three list slots +0x184.. hold the next checkpoint numbers.
  - Holding the cart: the body within 1500 of the next checkpoint on both x and z (a square, double `0x44b480`) advances all three slots, clears their found flags (+0x1ac..) and plays sound 22 for the local player. With no checkpoint left, the body inside `goal` finishes the race. There is no KUNDKORT; sound 8.
  - Not holding the cart: checkpoints only count while flag 4 is set (sliding in Aqua's water), using the walker body (+0x224, the character alone).
- **Quiz answer** (Frågesporten, `0x40b510` state 4) [O]: J/Y stores +0x1e0 = 2, N stores 1 (`0x40db80`). It is compared with the question's answer (+0x14). Right: the item is taken normally. Wrong: if more than one item is left, the type is blocked (+0x1d8). No sound either way.
- **Ai_GoToGoal** (`0x402060`): navigates to the goal anchor (+0x38/+0x3c) at height 0 (8000 in Aqua, 2000 in Future). [I] The port aims at the outline's bounding-box centre, because Aqua's anchor (36800, −37100) lies outside its own outline.
- **PhysWorld bodies** (`0x4055f0` per tick: `0x405680`, then the body solver `0x405e10`, then `0x405680` again) [O]:
  - A body has a position (+0x20/+0x24 = engine z, x), the previous position (+0x28), a heading (+0x30), velocity as speed (+0x3c) and direction (+0x38), a spin (+0x40) and its owner (+0x44).
  - `0x404f10(speed, angle)` moves it by the polar vector. `0x404f70(heading)` turns its parts: offset = polar(dist, angle + heading).
  - Parts (`0x4053a0`, 0x4c bytes): flag, mass +0x10, radius +0x14, offset +0x2c (previous +0x34), height +0x40, next +0x48.
  - Per player (`0x410e90`): walker +0x224 (radius 230, mass 25·Styrka + 90, height 300); free cart +0x264 (circles at z ±150 r 270/300, corners (300, ±190) and (−300, ±240) r 20, mass 75); pushing +0x2a4 (the walker part plus the cart parts 750 ahead, corners r 5, cart parts mass 25·Styrka + 75). +0x2a4 is active while holding the cart, otherwise the other two (+0x1c flag).
  - **Contacts** (`0x404ac0`): for parts a (body A) and b (another body B) within 500 in height and overlapping:
    - pen = ra + rb − d, n = direction b→a, m = 0.5·ma/mb
    - new position = A's part's previous position + polar(pen/2, n) − its offset
    - new velocity = polar(pen/m·0.125, n) + A.vel·(m·0.5) + B.vel·(0.333/m)
    - Also stored: B's tangent and B.speed·0.25 for the spin.
  - **Response** (`0x405e10`): a body with one contact takes it; with several, the one with the highest speed. The spin = dot(lever, B tangent)·B.speed·0.25·1.5e−6. A positional sound (part sound id, 65000) plays and `0x409b10` rolls the Styrka cart knock, once per tick per body in contact.
  - [I] The port applies the position and velocity but not the spin.
- **Movement integrators** [O]:
  - Input: DirectInput is polled every tick (`0x416820` → `0x40db80`). The arrows set turn +0x2e0 = ±1 and throttle +0x2e4 = ±1, both on the same tick. The movers clear them after use.
  - Parameters (`0x410e90`):
    - walking: acc +0x1e8, friction +0x1ec = master friction, rotAcc +0x1f8, turn damping +0x1fc = master friction
    - pushing: acc +0x268, friction +0x26c = (master + cart friction)/2, rotAcc +0x278, turn damping +0x27c = the same average
    - top speeds: acc/(1 − f) at +0x1f0/+0x270; top turn rates at +0x200/+0x280
  - Walker (`0x426fd0`) and pusher (`0x4280b0`), per tick:
    - speed ×= f; turn rate = rotAcc·turn + damping·turn rate; heading = body heading + turn rate
    - velocity = polar(acc·throttle, heading) + polar(speed, direction)
    - pusher only, while turn ≠ 0: + polar(acc·throttle·0.5, heading − throttle·turn·π), which points backward at full turn and brakes.
    - The body then moves with `0x404f10`.
  - Post-physics sync (`0x428a70`): speed = body speed clamped to ±top speed; direction = body direction if the body had a contact (+0x18); turn rate += body spin (+0x40), clamped to ±top turn rate.
  - Cart tilt (end of `0x4280b0`): the four corner parts (back left/right, front left/right) keep heights that fall with gravity 18 onto the floor below them. A corner arriving faster than 18 bounces ×−0.75, and none may hang more than 300 below the highest.
    - rx = (atan2(1200, front − back) − π/2)·K, rz = atan2(right − left, 860)·K (K = radians→int16), stored at +0x28c/+0x290
    - applied to the cart object with `0x4307d0` in `0x428a70`; the handle helpers ride along with the cart.
- **Guide arrows** (`0x40cf40`) [O]: two independent arrows.
  - VARUPIL (`DAT_00458110`, pivot `DAT_00458118` at camera (−800, 590, 1200)) points at the current target whenever there is one.
  - VAGNPIL (`DAT_00458114`, pivot `DAT_0045811c` at camera (800, 590, 1200)) points at the cart whenever the player is not pushing it (+0x174 = 0).
  - Both are hidden when the race is over. With engine Y down, the arrows sit lower left and lower right.
  - Orientation: each pivot gets the camera's rotation change when the camera is aimed at the target at its own height (`0x431030`), which cancels the camera pitch, so the arrows lie flat. The arrow's yaw is the yaw to the target.
  - Wobble: rz/rx = sin(phase + offset) · (turn rate + speed) · scale, in int16 units. Each arrow has its own phase (`0x45895c` cart, `0x458960` item; +0.3 per update).
    - Cart arrow: walking 0.97·14 / 1.37·13; pushing 0.123·11 / 0.21·16.
    - Item arrow: walking 0.23·14 / 0.43·10; pushing 0.14·12 / 0.3·17.
- **mvnc releases the cart** (`0x4280b0`, every 5 ticks): if the pushing body or the cart is inside an `mvnc` area within its height range, `0x40e040` lets go of the cart. In Aqua's currents and pipe the cart is therefore lost, and it floats away on the current.
- **Floor regions and walls** [O] (port: `web/src/engine/floorEdges.ts`):
  - Building (`0x428cf0` / `0x428d50`): every FLOOR polygon with normal y ≥ 0.6 is added to a planar region (same normal, coplanar within 0.2) of 0x48 bytes. It has a plane (+0..+0x14: average height, slopes, reference point), wall edges +0x3c, link edges +0x38, and next/prev +0x40/+0x44. Edges (`0x429ba0`, 0x3c bytes) store both 3D end points as ints, the 2D (z, x) points and a unit normal (edge angle − π/2).
  - Passes (`0x42a650`):
    - `0x429d60` deletes reversed coinciding edge pairs inside a region (±2).
    - `0x42a1c0` computes the plane.
    - `0x429e90` links reversed coinciding edges of different regions (`0x429c90`): first heights ±2, then heights ±2500. This is how Aqua's walkway joins the canal 1000 below.
    - Regions are sorted by height.
    - `0x42a360` merges collinear neighbouring edges.
  - Lookup `0x42a750(z, x, y, 500, r)`: the first region whose plane is within 500 of y and which contains the point (`0x42aac0`: inside, or within r of one of its link edges).
  - Walls `0x4035e0` (per body part, from the previous to the current position): for each wall edge of the region(s) under the part, facing the movement (move·n ≥ 0) and within r, the edge is moved inwards by r and cut with the movement (`0x406130`). The new position is the cut plus 0.2 × the remaining movement mirrored about the inward normal (`0x44b2d4`), which is also the new velocity. The result is recorded as a contact (`0x4054e0`), the same way the body solver's are.
  - Link edges block the same way when the neighbour floor plus the part's step height (+0x18: 300 walker, 240 cart parts) is still above the current floor and the part.
  - End points (last pass): each edge's start point is a point obstacle. At the first touch along the movement (foot point on the movement line plus √(r² − d²) back towards the previous position), the part restarts with 0.5 (`0x44b274`) of the remaining movement mirrored about the direction to the point.
  - [I] Not ported: the collinear-edge merging. The earliest hit is used, not the fastest contact.
- **Grabbing the cart** [O] ("action grab cart" → action state 3, `0x40b510` case 2, every tick while CanGrabCart holds):
  - `0x40e1d0`: turn (turn = ±1) until the cart is within 0.1 rad of straight ahead (`0x44b548`/`0x44b550`).
  - Then walk (throttle 1) until within 1000 (`0x44b540`).
  - Then swing the cart: its turn rate +0x244 grows by the walker's rotAcc until the remaining angle to the walker's approach direction is smaller than that rate.
  - `0x40e5b0` then attaches: +0x174 = 1; the pushing body is placed at the walker's position and heading (`0x404e00`) and takes the walker's speed, direction and turn rate. The cart comes to the character.
- **Item arrow target** (`0x40cf40`, modes 1–2) [O]: no target while an item is in hand (+0x17c). The target is sticky: the nearest still-needed item's list slot is stored at +0x1d4 and kept until that item is found (then the first spot of its type is used). A wrong quiz answer sets it to −1.
- **Race-end animation** (`0x40c800`, while `DAT_00458130` is set) [O]: the winner (`DAT_00458134`) plays its own `anim\s_winner.anm` (player +0x2d0; started once with `0x4347c0`, then advanced every tick); every other player plays the stand animation (+0x2c4).
- **Character animation** (`0x40c800`, every tick) [O]:
  - `0x434540(anim, loop)` applies the current frame and steps one frame (wrapping with flag 1).
  - In normal states, the run animation steps once per tick while the throttle (+0x2e4) is non-zero, regardless of speed; with no throttle it is reset (`0x434270`) and the stand plays.
  - `DAT_00458954` toggles every call, so the stand animation steps every second tick. After the race the winner's `s_winner` steps every second tick too and blends halfway (`0x4347c0`) on the others. That branch runs no hand IK, so the winner's hands leave the handle.
  - While turning (+0x2e0 ≠ 0), node 1 gets yaw 2L and node 2 yaw L (`0x430a90`, keeping the frame's x/z), with L = 5600 (`0x44b4a8`) × turn rate / top turn rate.
  - While pushing, the arms solve two-bone IK to the handle helpers (nodes 3/4 and 6/7, `0x4336b0`).
  - Loops at full volume: footsteps (sound 10) while the throttle is held. Cart rolling (sound 11) while the cart's speed exceeds 45 or its turn rate 0.012; the pushed cart uses +0x274/+0x284, the free cart +0x234/+0x244.
- **Item_Take** (`0x40ea20`): sets +0x17c and parents the item mesh (+0x40) to node 8 of the character (+0x30, the right wrist) at (0, 300, 0). [O]
- **Pickup** (`0x40ed10`): empty hands and no cart; distance² ≤ 1e6 and |height difference| < 500 to a spot whose type is an unfound entry on the player's own list (mode 1).
- **CanGrabCart** (`0x40e180`): character-to-cart distance ≤ 3000 (double at `0x44b538`) with empty hands.

**AI** (`0x401160` state machine)
- `Ai_TickAll 0x4010e0` gives slots `(tick%4)·2` and `(tick%4)·2+1` a full update. Everyone else replays their cached turn/throttle (`0x4015a0`).
- Mode numbers: 0 SETTARGETITEM, 1 GOTOITEM, 2 GOTORANDITEM, 3 GRABOBJECT, 4 PUTOBJECTINCART, 5 RELEASECART, 6 GRABCART, 7 GOAL, 9 END.
- **Target choice** (`0x4015c0`): the nearest spot of any unfound list item. The cart is driven to the *buoy* nearest that spot, measuring from the cart's position. The AI then releases the cart and walks to the spot itself.
- **Navigation** (`0x401800`):
  - re-plans when the destination buoy changes or the re-plan flag `+0x51` is set
  - aims at the waypoint, blended (800 − d) towards the next hop when closer than 800
  - advances to the next waypoint at 700 units
  - at the final buoy, steers to the exact target and reports 2, or 1 once within 1100
- **Steering** (`0x401ae0`):
  - `turn = clamp(Δangle·4/π, ±1)`
  - `throttle = S·f`, with `f = 0.1 + 0.9·cos²Δ` when |Δ| ≤ π/2, otherwise 0
  - eased off linearly inside 2000 units
  - `−S` when the target is more than 2 rad behind while moving fast
  - stuck: less than 1500 units of progress (from the reference point +0x58) adds 40 ms per AI update; past 875 ms it sets the re-plan flag +0x51 and clears +0x50. Nothing else: no reversing.
  - reversing (−S) only within 1100 of the target, when more than 2 rad off and moving faster than half of max speed × S
- **Positions** (`0x401160`) [O]: ai+0x14 is the active body (the character, `0x4099d0`). ai+0x20 is the cart: the held cart object's world position, or the free cart body (`0x409a10`). ai+8 is the buoy nearest the character; a re-plan starts there (`0x401800`).
- **Going to the cart** (`0x401e40`): drop any carried item; `action grab cart` when CanGrabCart (3000) allows (and +0x2e8 ≠ 3), which also sets +0x51; otherwise navigate from the character to the cart. Put-in-cart (`0x401fb0`) walks until within 1100 and drops.
- **Vagnrace** (mode 4 branch) [O]: mode 0 takes the next checkpoint (+0x184, `0x40f1b0`), or goes to 7 (goal) when none is left. Mode 1, holding the cart, steers the cart straight at the checkpoint (`0x401ae0`) until within 1100 (back to mode 0). After the stuck detector or a cart grab sets +0x51, the +0x52 flag switches to buoy navigation (`0x401800`) until it returns 1 or 2.
- [I] Port guard: when a re-plan's start buoy lies within 750 of the character while pushing (behind the cart, unreachable), the AI starts from its next hop instead. The original would spin on the spot there.
- **S** = 0.72 / 0.84 / 0.96 by difficulty (table at `0x44b230`).
- The angle convention is `atan2(dX, dZ)`, matching the engine heading.

### 4.6 Quiz, sound and guide arrows

**Quiz**
- `quest.txt` lines are `<1-3> <question>? J|N` (`Quiz_Load 0x40ffa0`): the level is stored as 0–2 and the answer as 2 (J) or 1 (N).
- `Quiz_Pick 0x410290` is only ever called with level 0, so only level-1 questions are asked (145 of 430).
- **In Varujakten (mode 1, `0x40b510`):** a player who reaches a needed item and faces it (`0x40ef60`) gets a question and stands still until it is answered. Keys Y/J/N set the answer field `+0x1e0` (`mm_key 0x40db80`).
- **Right answer:** the item is taken and the block (`+0x1d8`) is cleared.
- **Wrong answer:** that item type is blocked, as long as more than one item is missing.
- **[?] AI answers:** nothing writes the AI's answer, so how computer players get past the question is unknown. The port answers after 1.5 s, with an accuracy of 0.6/0.75/0.9 by difficulty.

**Sound**
- `Sound_LoadBank 0x437170` loads `NN_*.wav` as id NN into bank 1 (`sound\` in game, `sound\menu\` in the menu).
- `Sound_Play 0x437cf0(src, bank, id, vol, freq, flags)`: flag `0x200` loops and `0x400` plays non-positionally.
- Positional sounds go through `0x42bcd0`.
- **Per-player loops:** footsteps (10) and cart roll (11), via `0x40c800`.
- **Mall ambience:** started by each mall's script, at fixed engine coordinates:
  - Woodshop: birds 31/32
  - Aqua: rapids 27, bubbling 25
  - Future: computer 6, wind 5
- **Event sounds:** goal 8; Orient gong 35 (`0x418000`); throw/hit 21/22 and bounce 20 (food fight); a jingle per mall, `15 + mall` (item type 31).
- **HUD sounds** [O] (Hud_Draw):
  - Doorbell 28 rings once when Matkrig announces a new item (`DAT_0045899c`, while under 5 items), and once when the local player's list completes ("Mot kassorna!!", flag 0x20, `DAT_0045899d`).
  - Both banners come with a loudspeaker icon: gfx2200 (0,125)–(100,214) at (112,20)–(213,110).
  - Red/green 33/34 are the start lights. An item going into the cart plays 22.
- **Music** [O]:
  - `0x416cc0(hwnd, track)` plays one CD track over MCI (TMSF, from track to track+1, notify).
  - The window procedure (`0x4161b0`, MM_MCINOTIFY = 0x3b9 with MCI_NOTIFY_SUCCESSFUL) restarts the current track `DAT_004580c0`, so tracks loop.
  - Intro_Page starts track 8 without setting `DAT_004580c0`, so it plays once. The menu sets 7. mm_init plays the mall's `music` track (2–6).

**Guide arrows**
- `0x40cf40` places VARUPIL (`DAT_00458114`) and the cart arrow (`DAT_00458110`) relative to the camera object (`DAT_004588f8`), with a sine wobble.
- The meshes are flat, open arrows pointing along local +Z.

### 4.7 Item markers, pickup picture, cart handles

**Item markers** (`LoadLevelContent 0x4108a0`, `GuideArrow_Update 0x40cf40`)
- Each of the 30 item slots (stride 44 bytes from `0x4583e4`) holds `{mesh, instance A, group B, event object}`.
- The mesh is the item's mesh, or `CHECKFLAG` in Vagnrace.
- Group B sits at the spot: 1000 units up for items, on the floor for flags.
- Group B is shown only while the local player wants that slot:
  - an unfound list item that isn't blocked or in hand
  - the announced item in Matkrig
  - one of the next 3 checkpoints in Vagnrace
- While shown, A gets a relative rotation of `(100, 1550, 200)` int16 units per update (every second tick) and bobs on a sine.
- Unwanted items are not drawn at all.

**Pickup picture** (`0x40b510` case 6)
- The local player sees `%s\hud\allah<type>.tga`: a 640×480 picture of a hand holding the item. `DAT_0045834c` suppresses the 3D render meanwhile.
- The player then pauses for 24 ticks; a computer player pauses `(4 − difficulty) × 24` ticks.
- `shoplist.tga` is the paper shopping-list background.

**Cart handles**
- `objects/carts[n]/handle_pos` (two points) is stored on per-cart helper objects (`0x411b70`, `FUN_00431590` on player `+0x30/+0x34`).
- **[I]** The port reaches them with two-bone arm IK (nodes 3–5 and 6–8).

### 4.8 Throwing

**Drop or throw** (`0x40b510` case 3)
- `Item_ThrowCheck 0x40f4d0`: within 1300 units of the own cart (squared distance ≤ 1.69e6), with the item on the list (any item in Matkrig), the item goes straight in via `Cart_AddItem 0x40f1f0` (sound 22).
- `Cart_AddItem` does not animate the item [O]:
  - It re-parents the item's own mesh (the hand mesh +0x40, or the flying projectile) to the cart object (+0x14) at (rand%250 − 125, −500, rand%500 − 250), turned (rand%32000, rand%3200, rand%32000).
  - In modes 1–2 the mesh is deleted instead once three list items are already found. Matkrig keeps them all.
  - Either way the throw animation (+0x2bc) plays (state 4).
- Otherwise it is thrown (sound 21) through `Projectile_New 0x40f720`:
  - `s = min(200, distanceToOwnCart / 30)`
  - horizontal speed `s + 25` along the heading
  - vertical speed `−(s + 50)`
  - starting 1000 units above the feet

**Flight** (`Projectile_Tick 0x40f950`, run every tick from `0x426ee0`)
- Gravity: +18.
- Floor hit: if vertical speed is below 18 the item stops vertically and horizontal speed halves; otherwise it bounces at ×−0.4 (sound 20).
- Horizontal speed ×0.999 every tick.
- Once on the floor with |horizontal speed| ≤ 15, it becomes a floor pickup (an event object with the item mesh).
- Every tick, any cart standing free (owner +0x174 = 0; a pushed cart never catches) within 1000 units and inside the height window −1200…+500 tries `Cart_AddItem`. Modes 1–2 accept only unfound list items; Matkrig accepts any item.
- The item is a PhysWorld body (`0x402a20` + `0x4053a0`: one part, radius 150, mass 2, step 500), so the floor-edge walls cut its position. Its own speed/direction (+0x14/+0x18) drive `0x404f10` every tick and are never synced back, so it presses against a wall and slides along it. Walls count only within 500 of its height, so high throws clear shelves. [O]

**Matkrig**
- Taking the announced item from a shelf clears `DAT_00458128`, but the players' lists keep the item, so thrown copies on the floor stay contestable.

### 4.9 HUD, fonts, race end, records

**Hud_Draw (0x412810)** works in 640×480 screen space:
- `FUN_00414470(tex, x0, y0, x1, y1, u0, v0, u1, v1)` draws a textured rectangle.
- `FUN_00409860(font, flags, dx, y, s)` draws text centred on 320+dx; `FUN_00409420` draws left-aligned text.
- **Atlases** (`0x412700`): `list00`, `char00`, `gfx2200`, `froge00`.
- **Shopping list:** `list00` texels (0, 255−h)…(200, 255), drawn at (0, 0)…(200, h+22). h eases towards `220 − 22·found`, and remaining items sit on 22 px rows.
- **Portrait:** `char00` cell (i%4, i/4)×64 at (480, 10)…(544, 74).
- **Metal bar:** (215, 10)…(471, 35). It has a fill and the McDonald's M for `+0x16c`, which item 31 (McDonald's) sets to 100.
- **Timer:** small frame at (535, 2)…(639, 53), modes 1 and 4.
- **Position:** `hudfont` digits "n/total" at x 560 (modes 2–4).
- **Matkrig:** the "Varor n/5" panel and the announced item's banner.
- **Question:** `froge00` frame at (192, 112)…(448, 368) and the "J eller N?" plate.
- **Banners:** `gfx2200` (0, 0)…(255, 50), at y 30/50 (top) or 400 (bottom).
- **Minimap:** `mapX`/`mapY`/`mapZoom` are only read by `LoadMasterConfig`, so the shipped game has no minimap.

**Fonts** (`Font_Load 0x4090c0`)
- Cell index of a character: `posa`/`posA`/`pos0` + offset, overridden by `positions{}`.
- Cells per row: `256/width + squeeze`, so u = n·width mod stride and v = ⌊n·width/stride⌋·heigth.
- Widths come from `widths{}`. A space advances `spacewidth + globalspace`.
- Characters without a cell fall back to cell 0.

**Race end**
- The first player to check out ends the race for everyone (`DAT_00458130`, winner `DAT_00458134`); velocities are zeroed.
- Modes 1 and 4 show the winner's time and blink "NYTT REKORD!!" for a top-five time in `fshi`/`vahi`, then quit on ENTER.
- Modes 2 and 3 blink "Vinnare"/the winner's name. A win continues ("Tryck ENTER för att fortsätta!") and bumps `toplevel` (mall unlock); a loss tries again.

**config.mm** (XOR-0x55)
- `fshi|vahi<mall><name|time|face|diff><n>`: top five per mall, times in hundredths of a second.
- `toplevel`: the highest unlocked mall.
- `driver`: the render driver DLL.

### 4.10 Mall scripts and the burger
**Per-mall init/tick pairs:**

| Mall | Init | Tick |
|---|---|---|
| ICA | `0x416db0` | `0x416fd0` |
| Woodshop | `0x4175e0` | `0x4178c0` |
| Orient | `0x417dc0` | `0x418000` |
| Aqua | `0x4186c0` | `0x418a30` |
| Future | `0x418f30` | `0x4192a0` |

- **Cashier:** every mall places `KASSOERSKA` with `cash_sit.anm` and switches her to `s_winner.anm` once the race is over.
- **McDonald's man:** `MCDMAN` waits 10 s while no burger is out, then plays `s_flpick1` and `s_flpick2`.
  - Next, `s_throw1` plays with `BURGER` attached to hand node 8, then `s_throw2`.
  - The burger lands on the counter and slides five steps of (40−n)·4 units, then becomes a dropped pickup of item 31.
- **Animation:** NPC animations advance every other tick.
- **Positions:** listed per mall in `web/src/game/mallScript.ts`.
- **Who can take the burger:** only the human player. Taking it sets `+0x16c` (energy) to 100.
- **Energy:** drains by 1 every 5 ticks. While it is above 0, the controls are scaled ×1.3, the HUD shows the bar fill (`char00` (0, 216)…(127, 221)) and the M icon (`char00` (128, 128)…(191, 191)), and the mall's jingle plays (sound `15 + mall`).
- **Spots:** `_031` event spots are skipped at load; the burger only appears through the script.
- **Signs** [O]:
  - Aqua's tick spins `SKYLT%d` (i = 0…6; only `SKYLT1`–`SKYLT6` exist) about y by (5i + 40)·10 angle units per tick (`0x4307d0` mode 5 = relative). Ported.
  - ICA (`0x416fd0`) and Orient (`0x418000`) animate nodes 0–3 of `SIGN_FELIXPO` with relative node rotations (`0x430a90` mode 1): node 0 rx += 3 sin t₂, rz += 4 sin t₁; node 1 ry += 392 sin t₃; node 2 the negated node-0 values; node 3 ry += 231 sin t₄ (t += 0.009/0.011/0.01/0.008 per tick). No scene contains a `SIGN_FELIXPO` (only the single-node `SIGN_FELIX`), so this never runs in the original and is not ported.
- **Other:** the Orient gong and Aqua's positional water sounds are ported.

### 4.11 Menu, race setup, Aqua water slide, texture animation, culling areas
**Menu** (decompiled with `re/tools/DecompAt.java` into `re/ghidra/menu/pages.c`, `stubs.c`, `stubs2.c`; menu textures as PNG in `re/export/menu/`). The current page is a handler `fn(kind, key, state)` in `DAT_0045a6f8` (kind 0 = draw, 1 = key).
- **Keys** (`0x416a10`, DirectInput, 200 ms repeat): 0 right, 1 left, 2 up, 3 down, 4 space, 6 enter (no repeat), 7 esc.
- **Sounds:** `sound\menu\` bank: 1 move, 2 value change, 3 select, 4 back, 5 error.
- **Intro** (`0x41ae50`): `intro_addgames` until 2500 ms, black, `och` 2590–3590, black, `uds` 3680–6180, black, `samarbete` 6270–7270, black, `mcd` 7360–9860, black, `presenterar` 9950–17450, then the main page. Space skips.
- **Background** (`0x41a8c0`, 40 fps):
  - the frame runs when ≥ 25 ms have passed; dt (`0x45a6cc`) = elapsed ms × 0.04
  - **Cloth:** a waving `fling00` cloth on a 16×16 grid [O, from the disassembly]. The texture spans the whole grid. Per frame t += 0.003·dt. With A = 0.1 + 0.04 sin t, B = 16 sin 1.3t, C = 16 cos 1.2t, and for grid column r and row c, s = sin((c − C)(r − B)·A):
    - vertex = (44r + 10s − 10, ⌊500c/15⌋ + 10s − 10)
    - grey shade = 208 + ⌊31s⌋
  - **Signs:** three quads, `sign100` (the Mall Maniacs oval), `sign200` and `sign300` (the post). They slide in while the target `DAT_0045a6f0` = 0x1ff (main and mode pages) and out when it is 0, eased cur = (target + 2·cur)/3 per frame. The character page also zeroes cur.
    - `sign100`: x 0…cur−256, u 255−(cur−256)…255
    - `sign200`: x max(cur−256, 0)…cur−72, u (184−(cur−72) if < 185, else 0)…184
    - `sign300`: x max(cur−318, 0)…cur−239, y 255…478, u (79−(cur−239) if < 80, else 0)…79, v 0…223
  - **Arrow wobble:** each page keeps a phase that grows by 0.3·dt; arrows move ±5·sin.
- **Text:** runs of lowercase (a–z, å, ä, ö) use `menysmallfont`+`msfont00`, everything else `menyfont`+`mfont00`. The selected item uses `msfnt200`/`mfnt200`.
  - Main and mode items are right-aligned at x = 550, y = 190 + 41·i.
- **Main** `0x41b0b0`: Spela → mode `0x41c010`; Nätverk → `0x420190` (network pages below); Alternativ → `0x41c6a0`; Rekord → `0x41dfd0`; Avsluta → `0x4200b0` (shows `quit.tga`; J/Y quits).
- **Mode** `0x41c010`: Varujakten / Matkrig / Frågesporten / Vagnrace. Stubs set the mode (2/3/1/4) and the player count `DAT_00458108` (Frågesporten = 1 = solo, others 0 = from the table) → character page.
- **Character** `0x41efa0`: left/right cycles 0..9.
  - Characters ≥ toplevel+5 are locked: QUESTION model and `tom00` card, error sound.
  - **Layout:** name centred at y=10; arrows gfx00 (88,51)-(131,94)/(132,51)-(175,94); the portrait card `<name>00.tpg` at (10,60)-(265,315).
  - **Stat bars:** "Snabbhet"/"Styrka"/"Smidighet" labels at (285, 326/376/426). Frame gfx00 (0,95)-(255,118) at (10,y)-(265,y+23); fill gfx00 (0,119)-(1+46s,124) at (22,y+10)-(23+46s,y+15). Stats table at `0x4501b4` (3 ints per character).
  - **Arrows:** left x = 260 − half + 5 sin, right x = 336 + half − 5 sin (half = half the name width), y 5–48.
  - **3D preview:** `menu\characters.sen` + `s_run.anm`.
    - The camera is at (0,−1600,−2000), looking at (−2100,0,1000).
    - The runner is at (R sin a − 500, 0, R cos a + 800), starting at a = 1.5339824, R = 2000. Per frame a −= 0.0628, the yaw turns −653 units, and R −= 20 while R > 700. The anim advances one frame per frame.
    - On a change, the previous model drops 500/frame until y ≥ 20000.
  - Enter → mall page.
- **Mall** `0x41b900`: ICA logo gfx00 (176,51)-(239,91) at (152,56)-(215,95); `level00` strip row i at (232,50)-(487,101); picture `smal/wood/orie/aqua/rock00` (or `sec<i+1>00` when locked, i > toplevel) at (192,151)-(447,406); arrows at y 256–299: left gfx00 (0,51)-(43,94) at x 132 + 5 sin (not at mall 0), right (44,51)-(87,94) at x 464 − 5 sin (not at mall 4). Enter on a locked mall plays sound 5, otherwise it runs Race_SetupPlayers and `run <i>`. Esc → character page.
- **Options** `0x41c6a0`: "Svårighetsgrad" and "Grafik", labels at (172, 50/155).
  - frames gfx00 (0,0)-(255,50) at (192,85) and (192,190)
  - values in the tiny font, centred at y 103/208: Lätt/Medium/Svårt (with a smiley gfx00 (101+26d,125)-(126+26d,150) at (412,105)) and 3DFX Voodoo / Mjukvara
  - arrows at x 142 + w and 454 − w (w = 5 sin on the selected row only), using the orange (0/44,51) arrows when selected and (88/132,51) otherwise
- **Network pages** ([O] layout and ranges; the browser transport replaces the UDP protocol):
  - `0x420190` Nätverk: "Starta nätspel" (`0x450ab4`) → `0x420820`, "Anslut" → `0x421a30`; items right-aligned at x 550, y 190 + 41 i; Esc → main.
  - `0x420820` host: labels Karaktär / Bana / Spel / Ditt namn at (172, 20 + 95 i), Starta at (382, 430). Values on gfx00 frames at (192, 55/150/245/340), tiny text centred at y 73/168/263/358: character name (0x45013c, range 0…toplevel+4), mall name (table `0x450100`: "ICA Småköp", "ICA Eken", "ICA Draken", "ICA Sjöhästen", "ICA Raketen"; range 0…min(toplevel, 4)), mode name (table `0x4500ec`, range 2…4: no Frågesporten), the name field `DAT_0045a3b8` (letters incl. åäöÅÄÖ, digits, '.', ' ', '_', 19 at most) with a blinking "_". Arrows on rows y 59/154/249. Sets `DAT_00458108` = 8.
  - `0x421a30` join: Karaktär / Ditt namn / "Server address" (`0x450b1c`), Starta at (382, 335). [I] The port asks for the lobby code there.
  - `0x422ec0` host waiting room: every 4 frames it broadcasts a lobby packet (type 9: mode, mall, count, then name[21] + character per player). Players in two columns of four: gfx00 frame at (45 + 320c, 15 + 80r)-(300 + 320c, 66 + 80r), name in tiny centred at (173 + 320c, 33 + 80r), char00 face at (320c, 10 + 80r). Banner (365,255)-(620,306) "Väntar på andra spelare..." (`0x450b34`) centred at (493, 273). Starta / Avbryt (`0x450b50`) right-aligned at x 550, y 380/430. The mode name is drawn at (20, 370) (`0x423e30`), the level00 strip row mall at (20,410)-(275,461).
  - `0x423f20` client waiting room: same grid, "Väntar på startsignal..." (`0x450b58`), only Avbryt. It copies the player count from the host's packet into `DAT_00458108`.
  - `0x422840` race start: copies each lobby player's character, id and name into the player slots (count `DAT_00458108`, so only the connected humans race, no AI) and runs `run <mall>`.
  - In the race (`0x40beb0`): a network client sends "ready" (0x100) on its first tick and sets its state +0x30c = 1. Hud_Draw then shows "Väntar..." (`0x44fe4c`) on the top banner and the countdown is held. When the host has every ready, it broadcasts the start, which sets +0x30c = 2 (`0x413357` area) and lets the countdown run. [O]
  - [I] Browser port: WebSocket lobbies with 4-letter codes, server-clocked lockstep (web/README "Network play").
- **Records** `0x41dfd0`: headers "Frågesport" (60,80) and "Vagnrace" (410,80). The mall strip is at (232,10) with the logo at (152,16), and arrows at x 92 + 5 sin and 504 − 5 sin, y 15–58. Left/right cycles 0…min(toplevel, 4).
  - Per column c (fshi, vahi) and row r, y = 130 + 70r:
    - frame at (50+320c, y)
    - a `char00` face (64×64 cell `face`) at (10+320c, y)
    - "name   MM:SS:HH" in the tiny font, centred at 178+320c, y+18
    - a difficulty smiley at (280+320c, y+20)
- **Name entry** `0x41d320`:
  - **Entry:** after a new best time (Frågesporten/Vagnrace), the menu resumes in `0x41dcb0` (fshi) / `0x41de40` (vahi). These take the pending time/place/face/mall from `0x45a700..70c`, move the lower entries down with get/set commands, clear the name, and open this page.
  - **Layout:** the header ("Frågesport"/"Vagnrace") is centred at y 20. Five gfx00 frames are at (192, 80 + 60r). The new row shows the typed name in the tiny font plus a "_" cursor while blink % 25 < 15.
  - **Typing:** a–z, å ä ö, A–Z, Å Ä Ö, 0–9, '.', ' ', '_', up to 13 characters. Backspace deletes.
  - **Enter:** `set <table><mall>name/time/face/diff<place>`, sound 3, then the records page.
- **Character stats** [O] (`0x410e90`): the player gets Snabbhet/Styrka/Smidighet at `+0x160/+0x164/+0x168`, and its display name from `0x45013c`.
  - acc × (Snabbhet·0.06 + 0.7), rotate_acc × (Smidighet·0.1 + 0.5), for both the walking and the `_WC` values.
  - Styrka: in the collision response (`0x405e10`), each player in a contact with another player calls `0x409b10`. While pushing a cart, they let go of it when rand()%100 < (attacker Styrka·5 + 60 − own Styrka·10)·0.2, rolled every tick of contact.
- **Data:** names `0x45013c`, models `0x450164`, cards `0x45018c`, difficulty names `0x450230`.

**Race setup** (`0x41b6e0`)
- **Player count:** table `0x44b610`[difficulty + mall·3] = {2,3,4 | 2,3,4 | 3,3,4 | 3,4,4 | 4,4,4}.
- **Characters:** the human is in slot 0; the others are distinct random characters < toplevel+6.
- **Unlock:** a human win in Varujakten/Matkrig in mall == toplevel sets toplevel = mall+1 (Hud_Draw).
- **Mall names** (`level00`): Småköp, Eken, Draken, Sjöhästen, Raketen.

**Floors** (`0x4104b0`)
- Only physics objects whose name contains `FLOOR` (and does not start with `_`) become floor regions (`0x428cf0`, planar regions with edges; `0x42a750` finds the region under a point).
- The rest of the ph scene is loaded into `DAT_004580b0` and never read again. Non-FLOOR physics objects have no collision of their own. Only the edges of the floor regions act as walls (`0x4035e0`, a 587-line solver run by `0x405680` before and after the body solver) [O].
  - Consequences:
    - The start/checkout gates block only where they stand over a floor gap (Wood GRIND1/3/5 and GRINDKASSA1–3, Orient GATE10/14/16, Aqua GATE2/4/6/14/16/21, Future GATE2/10/14/16). Elsewhere, e.g. all of ICA's, they are passable.
    - The doors are passable (there is no door code; no DOOR string in the exe).
  - The port now collides players and carts with the floor-region edges themselves (see Floor regions and walls); the meshes remain only for thrown items and the camera.
- Per-mall extra textures: `aqua%02d.tpg` (mall 3), `fut%02d.tpg` (4), `orient%02d.tpg` (2), registered as AQUAnn/FUTnn/ORIENTnn next to MERGEDnn. They are the main textures of AQUAMALL/FUTUREMALL/ORIENTMALL.SEN (thousands of prims each); the port loads them by the scene's texture names.

**Camera** [O] (`Camera_Update 0x4020d0`, struct at `0x4588f8`: cam, player, pos dummy, aim dummy, `rot_max`, `rot_speed`)
- The camera is attached to the human's object (`0x4023b0`). The pos and aim dummies are rigid in the player's frame.
- **Easing:** per update, each axis of the camera position moves 1/`rot_max` (4) of the way to the pos dummy, or snaps when within `rot_speed` (20). It then looks at the aim dummy. It updates every 4th tick, or every tick while the turn control (`+0x2e0`, set by the `l…` command; `f…` sets `+0x2e4`) is non-zero (`0x40b3d0`). So the camera trails further behind when going straight and closes in while turning. The port uses the equivalent per-tick rate instead of 4-tick steps.
- **Fixed cameras `c_ac`** (checked first, first match wins): if the pos dummy's height is ≤ v0 and (v2 = 0 or ≥ v2), and the player is inside the area, then both the wanted and the current position become (y, v1, x) at once. v3 = 1 skips the wall pull. Aqua has 5 along the slide (canal, the long tunnel, the lower run, the exit); Future has 1.
- **`c_di`** (none in the shipped .eo): when the camera→player line crosses its lines, the height is scaled by v1/v0.
- `0x4023e0` pulls it in where the player→camera line crosses a floor edge (wall), which is what makes it close in Aqua's tunnels. It ignores crossings inside a `c_nc` area.

**Aqua water slide** [O] (walker `0x426fd0`, free cart `0x427730`, riding `0x4280b0`; all only for mall 3)
- The currents are the 10 `mvnc` objects in `aqua.eo`. They chain canal (y 100–1000) → tunnels (y 4500–7000) → lower run → exit at X≈10000, Z≈−39000. Each anchor (x, y) sits at the far end of its area, centred.
- **Walker:** each tick it clears flag 4 (`+0x158`) and hides SPLASH. If h2 ≤ y ≤ h and the player is inside the area:
  - velocity = 300 toward the anchor; turn speed (`+0x204`) = 0.23 rad/tick (the player spins); input has no effect
  - flag 4 is set; SPLASH is shown (not with gxSoft) and turned 0x1a0a per tick
  - sound 26 (Plask) plays on the first tick, then with 5% chance per tick
- **Pose:** with flag 4 set, `0x40c800` skips the run/stand logic and advances `s_oops.anm`. That is the "on the back, hands and feet up" look.
- **SPLASH** (`objects.sen`, 900×937 translucent quad, `MERGED14`): `0x411550` hangs one 1200 above every walker and every cart, with a second copy turned 16000 under it.
- **Cart:** while riding (`+0x174`), every 5 ticks, if the walker or the cart is in a current, it is let go (`0x40e040`). A free cart in a current is pushed at 350 with turn 0.2 and shows its own splash.
- **Free cart** (`0x427730`): speed and turn decay by the cart's `friction` (0.99; `0x410e90` stores it at `+0x22c` and `+0x23c`). The speed is zeroed while the cart is within 1100 (XZ, `0x404fe0`) of its own player.

**Guide arrow routing** [O] (`GuideArrow_Update 0x40cf40`; area tests are 2D, using the walker or cart-mode body position from `0x4099d0`)
- **When it applies:** if the player and the target are in different areas, the arrow points at a waypoint instead. This always applies to the cart arrow (VAGNPIL). For the item arrow (VARUPIL) it applies in mode ids 1, 2 and 4; Matkrig (3) points straight at the announced item.
- **Future (mall 4):** the areas are `ARE1`, `ARE2`, and everything else counts as `ARE4`. From ARE1 the arrow goes to `EXI1`, from ARE4 to `EXI4`, and from ARE2 to `EXI2` when the target is in ARE1, otherwise to `EXI3`. The EXI objects are points (no lines).
- **Other malls: `PUNK` areas** (Woodshop 2, Aqua 2). Each has its waypoint at the anchor and a "reached" box of v0 (engine Z) × v1 (engine X) around it.
  - Inside a PUNK area and not yet at its waypoint: go to that waypoint.
  - Otherwise, if the target is in a PUNK area whose waypoint isn't reached yet: go to that waypoint first.

**Launch pads and teleports** [O] (Orient = mall 2, Future = mall 4; same functions)
- **Shared rule:** each trigger needs the body's height in [h2, h] and the body inside the area. The first match per type applies, and the checks run in the order mvnc, hurl, tele.
- **Walker, `mvnc` (launch pad):**
  - speed 0, turn 0.23, vertical speed (`+0x208`) −200
  - flag 8 is set; sound 7 (Blast) plays when stepping on (flag 8 was clear)
- **Walker, `hurl`:** speed 400 toward the anchor, turn 0.23.
- **`tele` (`0x450de4`):** `0x404e00` puts the body at the anchor (y, x) with height v0 and re-finds its floor region within 1000. The facing turns by v1 (int16 angle). The velocity is kept.
  - `0x4020c0` sets `+0x51` in the player's AI state at `+0x314`, so a computer player re-plans its route. The camera is not snapped.
- **Pushed cart (`0x4280b0`):** only `tele` applies (the cart comes along). A pad releases the cart first, through the every-5-ticks check.
- **Free cart (`0x427730`):**
  - pad: speed 0, turn 0.23, lifted 250 with vertical speed −250, Blast on flag 0x10
  - `hurl`: 450 and turn 0.2
  - `tele` applies too
- **Vertical motion:** `y += vy`. While the floor is below the body, `vy += 18` (`0x44b58c`). On or under the floor, `vy` is zeroed and `y` snaps to it. A launch from the floor keeps its negative `vy`.
- **Orient:** 4 `tele` areas on the ground floor send you to the gallery (v0 = −5000; you land at about −3500).
- **Future:** the pad at the origin lifts you up a tube. At −5000…−10000 a `tele` sends you to (38050, 0, 50). That spot is another pad, which launches you into the `hurl` (−990…−2000), which throws you toward X = 42600. The other `tele`s link floors and turn you (v1 = 32000 / ±17000).

**TANI** texture animation (`0x434a90` register, `0x434b00` tick once per game tick)
- Records `{i8 du2, i8 dv2, i8 du, i8 dv, u8 period, u8 cycles, u8 tick, u8 step, u16 count, u16 mapi[count]}`.
- Every `period` ticks the MAPI UV bytes move by (du,dv); every `cycles` steps (du2,dv2) is added too.
- Aqua: dv=8, dv2=−128 every 16 steps over 53 MAPIs (the water).

**AR/IN event objects** (`0x40a4d0`, "sfdArea" `0x42b410`, tick `0x42b8f0`)
- Visibility culling: `ARnn` is a polygon (`line[]`, h/h2 height range) selecting mall objects.
- `INnn` is the region the camera must be inside for them to be drawn. Not a camera switch. Not ported (everything is drawn).

### 4.4 Render flags and detail levels
- **Primitive flags** (decoded from the gxOpenGl driver's set-state function `0x10001bc0`):

  | Bit | Meaning |
  |---|---|
  | `0x04` | textured |
  | `0x08` | coloured; flat by itself, Gouraud together with `0x10` |
  | `0x20` | translucent, with blend mode = `flags & 3`: 0 = alpha 0.5, 1 = additive at 0.5, 2 = multiply (ZERO, SRC_COLOR), 3 = additive at 0.25. Depth writes are off. |
  | `0x8000` | culling disabled (double-sided) |

  **[I]** `0x4000` is unused by the GL driver. The Glide driver imports `grChromakeyMode` and `grFogMode`, so `0x4000` is treated as colour-key (black = transparent).
- **Winding:** faces are clockwise seen from their visible side.
- **Detail levels** (`DetailLevels_Setup 0x42ad00`):
  - `_N<name>` is detail level N of `<name>`, and level 0 is the name without a prefix
  - the game shows level i while the squared distance is below (i+1)·10000²
  - missing levels are filled from the level below
  - `_N` objects without a base object are never switched
  - each character exists as `NAME`, `_1NAME` and `_2NAME`

## 6. Open questions
- ~~MESH layout~~, ~~ANM encoding~~, and ~~angle units~~ are resolved (§4.1–4.2).
- **[?]** The two per-vertex bytes (`u8, u8` after xyz) are copied into the projected vertex at `+0xC/+0xE` and `+0xD`. **[I]** They are a lighting/shade value or a normal index. This needs confirming in `FUN_00433640` (the gx triangle submit).
- **[?]** COLS `flag` byte, MAPI `u16, u16` fields, the `0x1000`/`0x4000` primitive flags (Glide path), `TANI` texture animation, and the meaning of OBJI type 3 (only in `ENDSCENE.SEN`).
- **[?]** Walking-mode integrator (cart riding is `0x4280b0`), the per-character speed and agility stats (player struct `+0x160`/`+0x168`), (The doors do not open: there is no door code; they are passable.)
- Resolved: PhysWorld uses only the FLOOR regions; `GATE*` objects matter only through the floor gaps under some of them.
- **[?]** Animation playback speed and interpolation, and how object (`OBJI`) rotations combine with node 0 (all shipped malls use rotation 0).
- **[?]** Collision model. `ph*.sen` is presumably polygon collision, and the `PhysWorld` init parameters `(100000, 40000, 40000, 2000, 2)` look like world bounds and grid sizes.
- **[?]** CD-audio tracks are not in `original/`.
- The GxGlide and gxSoft drivers were not analyzed; only gxOpenGl was.
