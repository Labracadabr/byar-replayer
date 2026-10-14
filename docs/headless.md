# Headless re-simulation of BAR replays (Milestone 0 findings)

Verified 2026-10-13 on Windows 11, BAR install `D:\Dmitrii\Beyond-All-Reason`, engines
`recoil_2025.04.08`, `recoil_2025.06.12`, `recoil_2025.06.19`.
Reproduce with `python spike/run_spike.py <demo.sdfz> <ascii-workdir>`.

## Result

| Demo | Engine | Teams | Frames | Ended by | Wall time |
|---|---|---|---|---|---|
| Project SD-129 (8v8, 17 min) | 2025.04.08 | 16 | 30455 | `GameOver` | 160 s |
| Supreme Isthmus (aborted, 7.5 min) | 2025.06.19 | – | 13464 | end of demo | 72 s |
| Death Valley (aborted, 2 min) | 2025.06.12 | – | 3992 | end of demo | 30 s |

Wall time includes ~20–35 s engine startup and load. Sim speed is ~1000 frames/s early on and drops to
~150–200 frames/s (≈5–6× realtime) once there are ~1200 units. That's one core per job, so parallel jobs scale.
No desync messages were seen. Sampling **all** units every 15 frames produced 63 MB of raw text (14 MB zlib) for the 8v8
game, so the binary delta format (milestone 4) is required to reach single-digit MB.

## Command line

```
cd <workdir>
set USERPROFILE=C:\Users\Public   (also HOME, APPDATA, LOCALAPPDATA; HOMEPATH=\Users\Public)
set SPRING_DATADIR=D:\Dmitrii\Beyond-All-Reason\data
<data>\engine\recoil_<engineVersion>\spring-headless.exe ^
    --write-dir <workdir> --config <workdir>\springsettings.cfg ^
    --only-local --nocolor <workdir>\demo.sdfz
```

- `engineVersion` comes from the demo header (`2025.04.08`); the install folder is `recoil_<version>`.
  Every engine the launcher installed already ships `spring-headless.exe`, so no download is needed for these.
- `SPRING_DATADIR` makes the engine scan the BAR data dir (maps, `packages/*.sdp` + `pool/`) read-only.
  Rapid game packages are resolved by the `gametype` name in the demo script; no extra flags are needed.
- `--write-dir` puts everything the engine writes (infolog, cache, `LuaUI/Config`, `_script.txt`) into the
  work dir. The real BAR config is never touched. `--config` makes it use an (empty) private `springsettings.cfg`.
- `--only-local` means no listening sockets, so several jobs can run in parallel.
- The working directory (cwd) matters: Lua `io.open("x")` with a relative path resolves against the process cwd, so set cwd = write dir.

## Gotchas

1. **Non-ASCII paths crash the engine immediately.** If `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`HOME`
   contain non-ASCII characters (here `C:\Users\Пользователь`), the engine dies at startup with
   `filesystem error: Cannot convert character sequence: Illegal byte sequence` (exit 3). This happens even when every path
   passed on the command line is ASCII. Fix: override those env vars with an ASCII path for the child process.
   The write dir and demo path must be ASCII too. So the app's simwork dir can't default to `%APPDATA%` here.
   Use an ASCII location (e.g. `C:\ProgramData\bar-replay-viewer\simwork`, or a folder on the BAR drive) and
   copy the `.sdfz` into the job dir.
2. **User widgets are allowed in replays but disabled by default.** BAR's `luaui/barwidgets.lua` forces
   `allowuserwidgets = true` when `Spring.IsReplay()`, but a widget the handler hasn't seen before is only
   auto-enabled if it ships inside the game archive. Fix: pre-seed `<writedir>/LuaUI/Config/BYAR.lua`:
   ```lua
   return { allowUserWidgets = true, order = { ["BRV Spike"] = 1 }, data = {} }
   ```
   The widget file goes in `<writedir>/LuaUI/Widgets/`; it is loaded via `VFS.RAW` from the write dir.
3. **Speed cap:** `Spring.SendCommands("setmaxspeed 1000", "setminspeed 1000", "setspeed 1000")` from the widget's
   `Initialize` works. After that the sim is purely CPU-bound.
4. **Unload BAR's own widgets.** With `GetInfo().handler = true` the widget receives `widgetHandler` and can
   `widgetHandler:RemoveWidget(w)` for the 24 UI widgets that load in replays. They cost ~15% CPU headless
   (and spam `Error in DrawScreen(): ... RenderToTexture` because there's no GL). LuaUI is unsynced, so this
   can't affect the simulation.
5. **Aborted demos never fire `GameOver`.** The header has `gameTime = 0`. The engine prints
   `End of demo reached` and then **keeps simulating an empty game forever** (we observed it reach frame 500k).
   Fix: the widget watches `widget:AddConsoleLine` for that string and quits. The runner should still have a
   stall/timeout watchdog.
6. **Total frames for progress:** the header's `gameTime` is 0 for aborted games, and the stream chunk
   timestamps include pre-game and pause time. Use the frame number of the last `NETMSG_KEYFRAME`
   packet (id 1, int32 frame) in the demo stream instead (`spike/demo_header.py: last_frame`). A demo with no
   keyframe never started (lobby only): reject it before simulating.
7. **Exit code isn't a reliable success signal.** One `quitforce` run ended with an access violation during
   teardown (after the game had finished and the widget had flushed). Success = output file ends with the
   `DONE` marker written by the widget, regardless of exit code. Failure = no marker, then show the infolog tail.
8. **Startup costs ~20–35 s per job** (archive scan, reading the rapid pool, defs, path init). The archive cache
   (`<writedir>/cache/ArchiveCache20.lua`) is per write dir, so reusing one shared cache dir would
   save a few seconds per job.
9. `Spring.GetProjectilesInRectangle(0, 0, Game.mapSizeX, Game.mapSizeZ)` works from a spectating LuaUI
   widget and is cheap. Counts were in the tens, rising to ~100 in big fights.

## Output channel

A direct file write from the widget (`io.open` in LuaUI) works and is the most efficient choice. Progress is reported through
`Spring.Echo("[BRV] ...")` lines, which arrive on stdout prefixed with `[f=<frame>]`. The runner parses those
for live progress. stdout is block-buffered, so updates arrive in bursts; that's fine for a progress bar.

## Dependency resolution (milestone 2)

The engine, game and map must exactly match the replay. `src/main/deps/` resolves them in this order:

| Dependency | Local lookup | Download source | Written to |
|---|---|---|---|
| Engine `2025.04.08` | `<bar>/engine/recoil_<v>/spring-headless.exe`, then `<engineCache>/recoil_<v>/` | `github.com/beyond-all-reason/RecoilEngine/releases/download/<v>/recoil_<v>_amd64-windows.7z` (same URL the BAR launcher uses), extracted with bundled 7za | engine cache (work dir) |
| Game `Beyond All Reason test-…` | name → `.sdp` md5 via `rapid/*/*/versions.gz` (BAR's, plus ours), then `packages/<md5>.sdp` in BAR or our data dir | rapid CDN: `repos-cdn.beyondallreason.dev/<repo>/packages/<md5>.sdp` and `/pool/xx/<rest>.gz` | `<work>/data` (own pool) |
| Map `Death Valley v1.0.1` | map folders by BAR naming (`death_valley_v1.0.1.sd7`, case-insensitive) or by the exact file name from the API | `files-cdn.beyondallreason.dev/find?category=map&springname=<name>` → mirror URL + md5; fallback: Google Drive API v3 on BAR's maps folder (needs API key) | first map folder |

- **The BAR install stays untouched** apart from maps. Game downloads go into our own data dir. Pool files BAR
  already has are **hardlinked** (same volume, so no extra space). A version near an installed one needed 14 new
  files (128 KB); 17,125 were hardlinked. Different volume: falls back to copying.
- The engine finds a game in any `SPRING_DATADIR` entry, but its pool must sit next to its `packages/`. Verified by
  running a demo with `SPRING_DATADIR` set to *only* a hardlinked data dir.
- Pool files are gzip; their name is the md5 of the *decompressed* content. Each download is verified. The `.sdp`
  is written last, so its presence means the package is complete. Downloaded games are also recorded in
  `<data>/brv-installed-games.json`, so they stay findable without a matching `versions.gz`.
- Old test versions (even `test-20001`) are still on the rapid CDN. Pre-Recoil engines (non `YYYY.MM.DD` versions)
  are reported as not downloadable.

## Gotcha: archive checksum cache (important for job startup)

On first load the engine checksums the whole game archive (`[CAS::GASCB]`, ~3 GB of pool reads) and caches the
result in `<write-dir>/cache/ArchiveCache20.lua`. With a fresh write dir per job and a cold disk cache, this took
**78.7 s**; with the cache present it took **29 ms** (whole short-demo run: 125 s → 33 s). The sim runner must keep
one shared archive cache and copy it into each job's write dir (and back after the job).
