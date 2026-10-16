# State stream format (BRVS v2)

One file per simulated game, `<work>/recordings/replay-<id>/game.brvs`, produced by
[src/main/stream/convert.ts](../src/main/stream/convert.ts) from the recorder's raw output ([raw-format.md](raw-format.md)).
The encoder and decoder live in [src/shared/stream/format.ts](../src/shared/stream/format.ts). The decoder is pure TS,
so the player can run it in a Web Worker (with `fzstd` for decompression).

Design goals: instant seeking (self-contained keyframe chunks), static buildings cost nothing between keyframes,
single-digit MB for long team games, trivial to decode into typed arrays.

## File layout

```
offset 0   "BRVS"                     4 bytes magic
       4   u32 LE  format version      (1)
       8   u32 LE  header length H
      12   header: UTF-8 JSON, H bytes (uncompressed, so it can be read without decompressing anything else)
  12 + H   data: blobs, each zstd-compressed (level 9), addressed by the header
```

Header JSON (`StreamHeader`):

| field | meaning |
|---|---|
| `formatVersion` | 2 (v1 files still decode: no work fields, i8 projectile velocities) |
| `gameId`, `engine`, `game`, `mapName` | identification |
| `mapSizeX`, `mapSizeZ` | map size in elmos (map units × 512) |
| `sampleInterval` | sim frames between unit samples (default 15 = 2 Hz; 30 frames = 1 s) |
| `projectileInterval` | frames between projectile samples (default 5) |
| `keyframeInterval` | frames per chunk (default 600 = 20 s) |
| `firstFrame`, `lastFrame`, `endReason` | covered range; `gameover` / `endofdemo` / `overrun` |
| `meta` | `{offset, length}` of the meta blob, relative to the data start |
| `chunks` | `[{frameStart, frameEnd, offset, length}]` sorted by frame; chunk *i* covers frames `[i·K, (i+1)·K)` |

## Meta blob (zstd → JSON, `StreamMeta`)

- `teams`: `{teamId, allyTeam, name, color "#rrggbb", isAI, isGaia, side}`, using the in-game colors.
- `winners`: winning ally teams (empty if the game didn't end with a game over).
- `unitDefs`: only the defs that appear in the game, `id → {name, humanName, xsize, zsize (8-elmo squares), kind, metal, energy, health, iconType}`.
  `kind` is one of `building | ground | air | ship | commander`, for icon shapes.
- `weaponDefs`: the weapons that appear in projectile samples, `id → {name, type, color?, size?}` (`Cannon`,
  `LaserCannon`, `BeamLaser`, `MissileLauncher`, …; color/size from v2 recordings). The player draws each type
  differently: dots (cannons), streaks (laser bolts), full-length beams, jagged lightning, missiles/torpedoes with
  trails, bombs, flames, D-gun.
- `events`: `[frame, type, uid, def, team, other, x, z]`. Types: 1 created (other = builder uid), 2 finished,
  3 destroyed (other = attacker uid or −1, x/z = position), 4 given (other = previous team), 5 game over.
- `chat`: `{frame, playerId, name, type: ally|spec|global, message}`, taken from the demo file. The player prefers
  reading chat and map pings/drawings from the demo itself (`readDemoTimeline`: exact frames counted from
  KEYFRAME/NEWFRAME packets), so older recordings get them too.
- `stats`: per team, every 30 frames from frame 0: `units` (alive units, including unfinished ones) and `army`
  (metal value of finished mobile units).

## Chunk blob (zstd → binary)

All integers are unsigned LEB128 varints unless noted. `svarint` is zigzag. `u16`/`u8`/`i8` are fixed little-endian.

```
varint frameStart
varint frameEnd - frameStart
varint nSamples
sample 0 (keyframe):
    varint frame - frameStart
    varint n
    n × unit:     varint uid - previousUid   (sorted by uid, first delta from 0)
                  varint def, varint team, u16 x, u16 z, u8 heading, u8 hp, u8 build,
                  u8 work, [u16 workX, u16 workZ if work ≠ 0]          (v2)
sample i > 0 (delta against sample i−1):
    varint frame - previousSampleFrame
    varint nRemoved;  nRemoved × varint uidDelta
    varint nAdded;    nAdded × (varint uidDelta + unit fields as above)
    varint nChanged;  nChanged × (varint uidDelta, u8 mask, fields present per mask:
        1 pos: svarint dx, svarint dz | 2 heading: u8 | 4 hp: u8 | 8 build: u8 | 16 team: varint | 32 def: varint |
        64 work: u8 work [u16 workX, u16 workZ])                        (64: v2)
varint nProjectileSamples
    per sample: varint frame - previous (first from frameStart), varint n,
                n × (varint weaponDefId + 1, varint team + 1, u16 x, u16 z, svarint vx·4, svarint vz·4)
                (v1: i8 vx, i8 vz in whole elmos per frame)
```

Units:
- `uid` is a stable per-game unit identity. The engine reuses unit IDs after death; the converter assigns a new
  uid on every creation event (and when the same engine ID shows up with a different unit def). A destroyed unit
  that is still listed while it dies keeps its uid.
- `x`, `z`: integer elmos, clamped to 0..65535. `heading`: 0..255 (engine heading / 256). `hp`: health ÷ max
  health × 255. `build`: build progress 0..100 (100 = finished).
- Units that don't change between samples (idle buildings) produce no bytes until the next keyframe.
- Projectiles have no identity; `vx`/`vz` (elmos per frame, rounded) let the player extrapolate positions between
  the 5-frame samples.

Decoding a chunk (`decodeChunk`) yields every sample as struct-of-arrays (`Uint32Array uid`, `Uint16Array x`, …)
sorted by uid, so interpolating between consecutive samples is a merge walk.

## Measured sizes (default settings)

| Game | Raw text | Stream | Convert |
|---|---|---|---|
| 2 min, 1 human vs 5 AIs | 1.6 MB | 28 KB | 0.1 s |
| 7.5 min 8v8 (aborted) | 17.8 MB | 0.4 MB | 0.6 s |
| 17 min 8v8 (2,903 units) | 71 MB | 2.4 MB | 2.0 s |
| 40 min, 6 teams (2,695 units) | 173 MB | 5.1 MB | 5.9 s |

For the 40-minute game: units 3.2 MB (keyframes 0.6 MB of that), projectiles 1.9 MB, meta 0.1 MB. If sizes
ever need to shrink further, the next steps are a columnar layout for projectiles, or tracking projectile identity
to delta-code them.
