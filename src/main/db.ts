// Local library index on node:sqlite (built into Electron's Node; no native module to rebuild).
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE replays (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    file_name       TEXT NOT NULL,
    file_size       INTEGER NOT NULL,
    file_mtime      INTEGER NOT NULL,
    source          TEXT NOT NULL DEFAULT 'scan',      -- 'scan' | 'manual'
    missing         INTEGER NOT NULL DEFAULT 0,        -- file disappeared from disk
    game_id         TEXT NOT NULL DEFAULT '',
    engine_version  TEXT NOT NULL DEFAULT '',
    game_version    TEXT NOT NULL DEFAULT '',
    map_name        TEXT NOT NULL DEFAULT '',
    start_time      INTEGER NOT NULL DEFAULT 0,        -- ms epoch
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    last_frame      INTEGER NOT NULL DEFAULT -1,
    preset          TEXT NOT NULL DEFAULT 'unknown',
    winners_json    TEXT NOT NULL DEFAULT '[]',
    players_json    TEXT NOT NULL DEFAULT '[]',
    spectator_count INTEGER NOT NULL DEFAULT 0,
    settings_json   TEXT NOT NULL DEFAULT '{}',        -- { gameSettings, mapSettings }
    search_text     TEXT NOT NULL DEFAULT '',          -- lowercased map + player names
    parse_error     TEXT,
    parser_version  INTEGER NOT NULL DEFAULT 0,
    favorite        INTEGER NOT NULL DEFAULT 0,
    note            TEXT NOT NULL DEFAULT '',
    added_at        INTEGER NOT NULL
  );
  CREATE INDEX replays_game_id ON replays(game_id);
  CREATE INDEX replays_start_time ON replays(start_time);

  CREATE TABLE sim_jobs (
    id            INTEGER PRIMARY KEY,
    replay_id     INTEGER NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
    status        TEXT NOT NULL,                       -- queued | running | done | failed | cancelled
    priority      INTEGER NOT NULL DEFAULT 0,
    frame         INTEGER NOT NULL DEFAULT 0,
    total_frames  INTEGER NOT NULL DEFAULT 0,
    stream_path   TEXT,
    error         TEXT,
    log_tail      TEXT,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
  );
  CREATE INDEX sim_jobs_replay ON sim_jobs(replay_id);
  CREATE INDEX sim_jobs_status ON sim_jobs(status);
  `,
  // 2: job stages and outputs
  `
  ALTER TABLE sim_jobs ADD COLUMN stage TEXT;           -- deps | loading | simulating | finalizing
  ALTER TABLE sim_jobs ADD COLUMN warning TEXT;
  ALTER TABLE sim_jobs ADD COLUMN raw_path TEXT;        -- recorder output (converted to stream_path in milestone 4)
  ALTER TABLE sim_jobs ADD COLUMN end_reason TEXT;      -- gameover | endofdemo | overrun
  ALTER TABLE sim_jobs ADD COLUMN work_dir TEXT;        -- engine write dir, kept on failure for inspection
  `,
  // 3: first keyframe (> 0 = resumed from a saved game)
  `
  ALTER TABLE replays ADD COLUMN first_frame INTEGER NOT NULL DEFAULT 0;
  `,
  // 4: engine process id, to clean up orphans after an app crash
  `
  ALTER TABLE sim_jobs ADD COLUMN pid INTEGER;
  `
]

export type Db = DatabaseSync

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
