# BAR Replay Viewer

Desktop app that re-simulates Beyond All Reason replays headlessly and plays them back as a 2D map view.
See [bar-replay-viewer-brief.md](bar-replay-viewer-brief.md) for the full plan and [docs/headless.md](docs/headless.md)
for how the headless re-simulation works.

## Stack

Electron 44 + TypeScript + electron-vite + React. The library index uses `node:sqlite`, which is built into Electron's
Node 24, instead of better-sqlite3, so there's no native module to rebuild. Replay metadata comes from `sdfz-demo-parser`.

## Install / launch

- **Installer:** `npm run dist` builds `release\BAR Replay Viewer Setup <version>.exe`. Run it once; it installs per
  user (no admin rights needed) and adds Start-menu and desktop shortcuts named "BAR Replay Viewer".
- **From source:** `npm install` once, then `npm start` (builds and starts the app). `npm run dev` starts it with hot
  reload for development.

## Develop

```
npm run dev        # app with hot reload
npm test           # unit tests (integration tests use the local BAR demos when present)
npm run typecheck
npm run dist       # Windows installer in release/
```

The settings live in `%APPDATA%\bar-replay-viewer\settings.json`. Everything else (library database, sim jobs,
recordings, caches) goes in the work folder, which defaults to a `bar-replay-viewer` folder next to the BAR install.
The work folder must be an ASCII-only path.

The player (`src/renderer/src/player/`) loads a recording over the app's `brv://` protocol, decodes it in a Web
Worker and draws it with PixiJS, using the game's own strategic icons and rank chevrons (extracted per game version
from the rapid package). Keys: Space play/pause, ←/→ ±10 s (Shift ±60 s), `,`/`.` step, +/− speed, H HP bars,
B build power lines, `[`/`]` icon size, T height map, M metal map, F fit, Esc back to the library. Chat names use
player colors; map pings and drawings show on the map and in the chat (click to jump there).

`spike/` holds the milestone-0 Python scripts: demo header reader, rapid package reader, and headless runner.
`scripts/cdp.mjs` takes screenshots of, and runs JS in, the running app over the DevTools protocol (start the app with
`--remote-debugging-port=9223`). Add `--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding
--disable-background-timer-throttling` when driving the player that way: a window covered by others gets no
`requestAnimationFrame`, so playback would not advance.
