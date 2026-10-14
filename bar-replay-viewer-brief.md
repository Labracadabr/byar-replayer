# Project brief: BAR offline replay simulator & viewer (desktop app)

## Goal
Build a Windows desktop app for **Beyond All Reason (BAR)** that:
1. Reads `.sdfz` replay files.
2. Re-simulates each replay **headlessly** with the Recoil engine (`spring-headless`).
3. Records the simulated game state into a compact "state stream" file.
4. Plays that file back in a lightweight 2D viewer: map background plus schematic units and projectiles, with rewind, a progress bar, and speed control. No 3D, no engine needed at playback time.
5. Lets me browse my replays, mark favorites, and attach notes.

The inspiration is https://replay.fogofwar.dev (example: https://replay.fogofwar.dev/replays/9e34b96a9dd82877727ead35da98667a). It does this server-side for "lava mod" games, and its re-sim queue can take up to an hour. I want the same thing locally, for any normal BAR replay, on my own CPU.

## Why re-simulation is required (core constraint)
An `.sdfz` file is a gzipped Spring/Recoil demo. It contains:
- the start script (players, teams, map, mod options, engine and game version)
- the stream of network packets: player commands, chat, sync checks
- end-of-game stats

It contains **no unit positions**. BAR is a deterministic lockstep simulation, so state exists only when the engine replays the inputs. Parsing the file alone can't give positions, and reimplementing BAR's simulation is out of scope. So:

> sdfz → spring-headless (exact matching engine + game version + map) + recorder Lua widget → state stream file → 2D player

`spring-headless` is the engine without graphics or sound but with the full simulation. It runs as fast as the CPU allows. That costs CPU once per replay; after that, playback is cheap.

## My environment
- Windows. BAR install root: `D:\Dmitrii\Beyond-All-Reason\` (data dir: `D:\Dmitrii\Beyond-All-Reason\data\`).
  - Replays: `data\demos\*.sdfz`
  - Maps: `data\maps\*.sd7` / `*.sdz`
  - Engines: `data\engine\<version>\`
  - Game packages: `data\packages\`, `data\rapid\`
- Don't hardcode paths. Auto-detect these defaults, and if anything is missing, prompt me to pick the folder. Save the choice in settings.

## Recommended stack
- **Electron + TypeScript + Vite**, with **React or Svelte** for the UI.
  - Main reason: the existing replay tooling for this ecosystem is TypeScript.
    - `sdfz-demo-parser` (npm) parses `.sdfz` headers, script, players, chat and stats.
    - The same author (jazcash) has a Spring map file parser on npm.
    - BAR's own lobby, `bar-lobby`, is Electron.
  - One language end to end.
- **better-sqlite3** for the local library index: replays, sim status, favorites, notes.
- **PixiJS** (WebGL 2D) for the player. It must handle 1–2k unit sprites smoothly.
- Child processes (`child_process.spawn`) for `spring-headless` and `pr-downloader`.
- **zstd** (or brotli) plus msgpack or protobuf for the state stream files.
- Alternative if you see a strong reason: Tauri v2 (Rust backend + same web frontend). Justify the choice briefly before scaffolding.

## Metadata source
- Parse the header and script locally with `sdfz-demo-parser`. This gives map, players, teams, duration, engine version and game version.
- Optional enrichment from BAR's public API: `GET https://api.bar-rts.com/replays/<gameId>` returns JSON with:
  - `fileName`, `engineVersion` (e.g. `2026.07.04`), `gameVersion` (e.g. `Beyond All Reason test-31479-433a460`)
  - `durationMs`, `Map.fileName`, `Map.width`/`height` (in 512-elmo units)
  - `AllyTeams[].Players[]` with names, colors, skill, faction, start positions
  - `gameSettings`, `preset`, `awards`
- Example game: `478ec26ab99c5725c01df0c72fda07c0`. The web replay page is `https://www.beyondallreason.info/replays?gameId=<id>`.
- Use the API only as optional enrichment; the app must work offline from the file alone.

## Dependency resolution (must match the replay exactly, or the sim desyncs)
1. **Engine:** look for `data\engine\<engineVersion>\`.
   - Check whether it contains `spring-headless.exe`. It may not; the launcher may ship only `spring.exe`.
   - If missing, download the matching Recoil engine build from the BAR/Recoil GitHub releases (the portable builds should include headless; verify). Cache it in the app's data dir.
2. **Game version:** check the local rapid/packages store.
   - If missing, fetch it with the `pr-downloader` bundled in the BAR install, using the exact game version string.
   - Old test versions may or may not still be downloadable. Surface a clear error if not.
3. **Map:** look in the configured maps folder (default `D:\Dmitrii\Beyond-All-Reason\data\maps`), matching by map name and file name.
   - If not found, prompt me for a folder.
   - If still not found, download from BAR's public Google Drive maps folder: https://drive.google.com/drive/folders/16eBcMpkgMTV9mlKxYmNda64X_dmCFdkk
     - Use the Drive API v3 `files.list` with `q="'<folderId>' in parents"` (paginated) and an API key, or another robust method.
     - Match the file name, download it into the maps folder, and show progress.
   - Also check whether `pr-downloader` can fetch maps directly, and use it as an alternative or fallback if so.

## Headless simulation (the riskiest part — prove this first)
- Run `spring-headless` with an **isolated write dir** (`--write-dir <appdata>\simwork\<jobId>`), so my real BAR config, widgets and logs are never touched.
- Point it at the data dirs that contain the engine, game and maps (`SPRING_DATADIR` or similar).
- Install a custom **recorder LuaUI widget** in that write dir.
  - Check that user widgets are allowed when watching replays. If they're restricted, find another injection method and document it.
- Remove the speed cap (e.g. `setmaxspeed`) so the replay runs as fast as possible.
- The recorder widget should:
  - every N sim frames (default 15, i.e. 2 Hz; the sim runs at 30 frames/s) sample every unit: id, unitDefID, team, x, z (plus y if cheap), heading, health/maxHealth, build progress, and whether it's being built
  - sample projectiles via `Spring.GetProjectilesInRectangle` over the whole map, more often or filtered by type, kept cheap
  - log events: UnitCreated, UnitFinished, UnitDestroyed (with attacker if available), UnitGiven/Taken, chat/console lines, game over
  - once per game version, dump `UnitDefs` to JSON: name, humanName, footprint, isBuilding, isAir, icon type, cost. Cache it per game version.
  - on game over or end of demo, flush and quit (`quitforce`)
- Output channel: write to a file in the write dir, or emit tagged lines to `infolog.txt` / stdout and parse them. Test which works with this engine's Lua sandbox.
- Report progress (current frame / total frames from the header) live to the UI. Support cancel.
- Detect desync or crash, and show the infolog tail on failure.
- Job queue: concurrency limit (default cores − 1, configurable), persisted in SQLite so jobs survive app restarts.

## State stream format (design it, document it in `docs/format.md`)
- Header: format version, game id, map name and size in elmos (map width units × 512), sample interval, team colors and names, a unitDefs reference.
- Keyframes every ~10–30 s containing the full unit table, so seeking is instant.
- Deltas between keyframes containing only changed or moved units. Static buildings shouldn't bloat the file.
- Positions quantized (e.g. uint16 over map size). Event list. Chat.
- Compressed. Target: a 40-minute large team game should come out in single-digit MB.
- Write the converter as a separate module (raw widget output → stream file) with tests.

## Map imagery
- Extract the minimap from the map archive (`.sd7` = 7z, `.sdz` = zip). Inside is the `.smf`, whose header points to a DXT1 1024×1024 minimap.
- Decode it to PNG and cache it per map.
- Optionally also extract the heightmap or metal map as toggleable overlays.

## UI requirements
**Library view**
- List or grid of replays from the demos folder (auto-scan plus file watcher) and any manually added `.sdfz`.
- Columns: date, map (with minimap thumbnail), players/teams, preset (duel/team/FFA), duration, winner, sim status (not simulated / queued / simulating x% / ready / failed), favorite star, note indicator.
- Search by player or map. Filters: favorites, sim status, date range, preset.
- Detail panel: full player list with teams and colors, settings, **editable note** (autosaved), favorite toggle, and Simulate / Re-simulate / Open player / Show in folder / Delete simulated data buttons.
- Drag-and-drop an `.sdfz` onto the window to import it.

**Player view**
- Map background, team-colored unit icons (shape by category: building, ground, air, naval, commander), projectiles as small dots or lines, optional HP bars, death flashes.
- Smooth interpolation between samples.
- Timeline scrubber, play/pause, step, speeds 1×–64×, keyboard shortcuts (space, ←/→).
- Zoom and pan. Hover a unit for a tooltip (name, HP, team).
- Side panels: players (with army value or unit count if cheap), chat log synced to the timeline.
- Decode the stream in a Web Worker.

**Settings**
- BAR data folder, maps folder(s), engine cache location, concurrency, sample rate, Google API key for the Drive fallback.

## Milestones (do them in order, confirm each works before moving on)
0. **Spike:** with one real replay from my demos folder, manually get `spring-headless` running it in an isolated write dir with a minimal widget that prints unit positions. Document the exact command line, env vars and gotchas in `docs/headless.md`.
1. Scaffold the app, SQLite schema, settings with path detection and prompts, and a library scan using `sdfz-demo-parser`.
2. Dependency resolver: engine, game, and map (local → prompt → Google Drive / pr-downloader).
3. Full recorder widget, sim job queue with progress, cancel and error reporting.
4. State stream format, converter, tests.
5. Player view (Canvas or Pixi): map, units, scrubber, speed.
6. Polish: favorites, notes, search and filters, projectiles, chat, tooltips, map overlays.

## Notes
- Keep the BAR install read-only from the app's perspective, except for downloading missing maps into the maps folder.
- Make it clear when something can't run (missing engine build, unavailable old game version) instead of failing silently.
- Ask me before big architectural decisions. Otherwise use sensible defaults and tell me what you chose.
