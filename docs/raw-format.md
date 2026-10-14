# Raw recording format (BRVRAW v1)

Written by the recorder widget ([resources/widget/brv_recorder.lua](../resources/widget/brv_recorder.lua)) during a
headless re-simulation, and stored as `<work>/recordings/replay-<id>/raw.txt`. It is an intermediate format: plain
text, one record per line, space-separated, optimized for being cheap to write from Lua. The milestone-4 converter
turns it into the compact state stream (`docs/format.md`). Frames are sim frames (30 per second).

```
BRVRAW 1
H interval=15 projInterval=5 mapX=12288 mapZ=12288 gaia=16 engine=... game=Beyond_All_Reason_test-... map=...
T <teamID> <allyTeam> <r> <g> <b> <isAI> <side> <name...>        one per team, colors 0..255
F <frame> <count>                                                  unit sample, followed by <count> unit lines:
<unitID> <unitDefID> <team> <x> <z> <y> <heading> <hp> <maxHp> <build%>
P <frame> <count>                                                  projectile sample, followed by <count> lines:
<projID> <weaponDefID> <team> <x> <z> <y> <vx> <vz>
E <frame> C <unitID> <unitDefID> <team> <builderID>               unit created (construction started)
E <frame> F <unitID> <unitDefID> <team>                            unit finished
E <frame> D <unitID> <unitDefID> <team> <attackerID> <attackerDefID> <attackerTeam> <x> <z>   destroyed
E <frame> G <unitID> <unitDefID> <newTeam> <oldTeam>               given / taken
E <frame> O <winningAllyTeams,comma,separated>                    game over
DONE <reason> <frame>                                              last line on success: gameover | endofdemo
ABORT shutdown <frame>                                             last line if the widget was shut down early
```

- Positions are elmos (integers), `y` is height. `heading` is the engine's -32768..32767 heading. `build%` is
  0..100 (100 = finished).
- Unit samples list **all** units every `interval` frames (default 15 = 2 Hz). Static buildings are deduplicated
  by the converter, not here.
- Projectiles are sampled every `projInterval` frames (default 5) and only written when there are any.
- IDs: unit IDs are reused by the engine after death, so the converter must key units by (id, creation event).
  `-1` means unknown (for example an attacker that wasn't visible or that no longer exists).
- Names (team names, unit human names) are always the last field and may contain spaces; other string fields
  have spaces replaced with `_`.
- Chat isn't recorded here; the converter takes it from the demo file itself (`sdfz-demo-parser` chat log).

## Unit definitions (BRVDEFS v1)

The game's unit and weapon tables, dumped once per game version to `<work>/cache/unitdefs/<gameVersion>.txt`:

```
BRVDEFS 1
U <id> <name> <xsize> <zsize> <isBuilding> <isAir> <isShip> <isCommander> <metal> <energy> <health> <speed> <iconType> <humanName...>
W <id> <name> <type> <range> <description...>
```

`xsize`/`zsize` are footprints in 8-elmo squares. The flags are 0/1.
