# BAR Replay Viewer

Desktop app that re-simulates Beyond All Reason replays headlessly and plays them back as a 2D map view.
See [bar-replay-viewer-brief.md](bar-replay-viewer-brief.md) for the full plan and [docs/headless.md](docs/headless.md)
for how the headless re-simulation works.

## Stack

Electron 44 + TypeScript + electron-vite + React. The library index uses `node:sqlite`, which is built into Electron's
Node 24, instead of better-sqlite3, so there's no native module to rebuild. Replay metadata comes from `sdfz-demo-parser`.

## Develop

```
npm install
npm run dev        # app with hot reload
npm test           # unit tests (integration tests use the local BAR demos when present)
npm run typecheck
npm run build && npx electron .
```

The settings live in `%APPDATA%\bar-replay-viewer\settings.json`. Everything else (library database, sim jobs,
recordings, caches) goes in the work folder, which defaults to a `bar-replay-viewer` folder next to the BAR install.
The work folder must be an ASCII-only path.

`spike/` holds the milestone-0 Python scripts: demo header reader, rapid package reader, and headless runner.
`scripts/cdp.mjs` takes screenshots of, and runs JS in, the running app over the DevTools protocol (start the app with
`--remote-debugging-port=9223`).
