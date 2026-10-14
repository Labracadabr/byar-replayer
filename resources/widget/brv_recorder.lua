-- BAR Replay Viewer recorder. Installed by the app into an isolated write dir; never into the user's BAR config.
-- Writes a line-based raw recording (format: docs/raw-format.md) while spring-headless replays a demo.
-- The runner replaces the CONFIG line below before installing the widget.

local CONFIG = { sampleInterval = 15, projectileInterval = 5, output = "brv_raw.txt", unitDefsOutput = "", progressEvery = 300 } -- @@CONFIG@@

function widget:GetInfo()
  return {
    name = "BRV Recorder",
    desc = "Records unit positions and events for BAR Replay Viewer",
    author = "bar-replay-viewer",
    layer = -100000,
    enabled = true,
    handler = true, -- needed to unload the UI widgets
  }
end

local RAW_VERSION = 1

local spGetAllUnits = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID = Spring.GetUnitDefID
local spGetUnitTeam = Spring.GetUnitTeam
local spGetUnitHeading = Spring.GetUnitHeading
local spGetUnitHealth = Spring.GetUnitHealth
local spGetProjectilesInRectangle = Spring.GetProjectilesInRectangle
local spGetProjectilePosition = Spring.GetProjectilePosition
local spGetProjectileVelocity = Spring.GetProjectileVelocity
local spGetProjectileDefID = Spring.GetProjectileDefID
local spGetProjectileTeamID = Spring.GetProjectileTeamID
local spGetGameFrame = Spring.GetGameFrame
local floor = math.floor
local format = string.format

local out
local finished = false
local buf, nbuf = {}, 0

local function log(s) Spring.Echo("[BRV] " .. s) end

local function w(line)
  nbuf = nbuf + 1
  buf[nbuf] = line
  if nbuf >= 512 then
    out:write(table.concat(buf, "\n", 1, nbuf), "\n")
    nbuf = 0
  end
end

local function flush()
  if out and nbuf > 0 then
    out:write(table.concat(buf, "\n", 1, nbuf), "\n")
    nbuf = 0
  end
  if out then out:flush() end
end

-- names may contain spaces: keep them last on the line; strip newlines/tabs
local function clean(s)
  return (tostring(s or ""):gsub("[\r\n\t]", " "))
end

local function writeHeader()
  w(format("BRVRAW %d", RAW_VERSION))
  w(format("H interval=%d projInterval=%d mapX=%d mapZ=%d gaia=%d engine=%s game=%s map=%s",
    CONFIG.sampleInterval, CONFIG.projectileInterval, Game.mapSizeX, Game.mapSizeZ, Spring.GetGaiaTeamID(),
    (clean(Engine and Engine.version or "?"):gsub(" ", "_")), (clean(Game.gameName .. " " .. Game.gameVersion):gsub(" ", "_")),
    (clean(Game.mapName):gsub(" ", "_"))))
  for _, teamID in ipairs(Spring.GetTeamList()) do
    local _, leader, isDead, isAI, side, allyTeam = Spring.GetTeamInfo(teamID, false)
    local r, g, b = Spring.GetTeamColor(teamID)
    local name = ""
    if teamID == Spring.GetGaiaTeamID() then
      name = "Gaia"
    elseif isAI then
      local _, aiName, _, shortName = Spring.GetAIInfo(teamID)
      name = aiName or shortName or "AI"
    elseif leader and leader >= 0 then
      name = Spring.GetPlayerInfo(leader, false) or ""
    end
    -- T teamID allyTeam r g b isAI side name
    w(format("T %d %d %d %d %d %d %s %s", teamID, allyTeam or -1, floor((r or 0.5) * 255), floor((g or 0.5) * 255),
      floor((b or 0.5) * 255), isAI and 1 or 0, (clean(side ~= "" and side or "-"):gsub(" ", "_")), clean(name)))
  end
end

local function dumpUnitDefs()
  if CONFIG.unitDefsOutput == "" then return end
  local f = io.open(CONFIG.unitDefsOutput, "w")
  if not f then log("cannot write unitdefs") return end
  f:write("BRVDEFS 1\n")
  -- U id name xsize zsize isBuilding isAir isShip isCommander metal energy health speed iconType humanName
  for id, ud in pairs(UnitDefs) do
    local cp = ud.customParams or {}
    local isBuilding = (ud.isBuilding or ud.isFactory or (ud.speed or 0) == 0) and 1 or 0
    local isAir = (ud.canFly or ud.isAirUnit) and 1 or 0
    local isShip = (ud.moveDef and ud.moveDef.name and ud.moveDef.name:find("boat")) and 1
      or ((ud.minWaterDepth or 0) > 0 and isBuilding == 0 and 1 or 0)
    local isCom = (cp.iscommander or cp.commander) and 1 or 0
    f:write(format("U %d %s %d %d %d %d %d %d %d %d %d %.1f %s %s\n", id, clean(ud.name), ud.xsize or 2, ud.zsize or 2,
      isBuilding, isAir, isShip, isCom, floor(ud.metalCost or 0), floor(ud.energyCost or 0), floor(ud.health or 0),
      ud.speed or 0, (clean(ud.iconType or "default"):gsub(" ", "_")), clean(ud.translatedHumanName or ud.humanName or ud.name)))
  end
  -- W id name type range humanName
  for id, wd in pairs(WeaponDefs) do
    f:write(format("W %d %s %s %d %s\n", id, clean(wd.name), clean(wd.type or "?"), floor(wd.range or 0),
      clean(wd.description or wd.name)))
  end
  f:close()
  log("unitdefs written")
end

local function finish(reason)
  if finished then return end
  finished = true
  log("finish reason=" .. reason .. " frame=" .. spGetGameFrame())
  if out then
    w(format("DONE %s %d", reason, spGetGameFrame()))
    flush()
    out:close()
    out = nil
  end
  Spring.SendCommands("quitforce")
end

function widget:Initialize()
  if not Spring.IsReplay() then
    log("not a replay, recorder disabled")
    widgetHandler:RemoveWidget(self)
    return
  end
  out = io.open(CONFIG.output, "w")
  if not out then
    log("ERROR cannot open output " .. CONFIG.output)
    Spring.SendCommands("quitforce")
    return
  end
  Spring.SendCommands("setmaxspeed 1000", "setminspeed 1000", "setspeed 1000", "specfullview 1")
  -- unload every other LuaUI widget: pure UI, ~15% CPU headless, cannot affect the simulation
  local victims, me = {}, widget:GetInfo().name
  for _, wgt in ipairs(widgetHandler.widgets) do
    if wgt.whInfo.name ~= me then victims[#victims + 1] = wgt end
  end
  for _, wgt in ipairs(victims) do widgetHandler:RemoveWidget(wgt) end
  writeHeader()
  dumpUnitDefs()
  flush()
  log("recorder ready, removed widgets=" .. #victims)
end

local function sampleUnits(n)
  local units = spGetAllUnits()
  w(format("F %d %d", n, #units))
  for i = 1, #units do
    local id = units[i]
    local x, y, z = spGetUnitPosition(id)
    if x then
      local hp, maxhp, _, _, build = spGetUnitHealth(id)
      -- id defID team x z y heading hp maxhp build%
      w(format("%d %d %d %d %d %d %d %d %d %d", id, spGetUnitDefID(id) or -1, spGetUnitTeam(id) or -1, floor(x), floor(z),
        floor(y), spGetUnitHeading(id) or 0, floor(hp or 0), floor(maxhp or 0), floor((build or 1) * 100)))
    end
  end
end

local function sampleProjectiles(n)
  local projs = spGetProjectilesInRectangle(0, 0, Game.mapSizeX, Game.mapSizeZ)
  if not projs or #projs == 0 then return end
  w(format("P %d %d", n, #projs))
  for i = 1, #projs do
    local pid = projs[i]
    local x, y, z = spGetProjectilePosition(pid)
    if x then
      local vx, vy, vz = spGetProjectileVelocity(pid)
      -- id weaponDefID team x z y vx vz
      w(format("%d %d %d %d %d %d %.1f %.1f", pid, spGetProjectileDefID(pid) or -1, spGetProjectileTeamID(pid) or -1,
        floor(x), floor(z), floor(y), vx or 0, vz or 0))
    end
  end
end

function widget:GameFrame(n)
  if not out then return end
  if n % CONFIG.sampleInterval == 0 then sampleUnits(n) end
  if CONFIG.projectileInterval > 0 and n % CONFIG.projectileInterval == 0 then sampleProjectiles(n) end
  if n % CONFIG.progressEvery == 0 then
    log("progress " .. n)
    flush()
  end
end

-- E <frame> <type> ...  events; unit ids are reused by the engine, so creation events matter for the converter
function widget:UnitCreated(unitID, unitDefID, unitTeam, builderID)
  if out then w(format("E %d C %d %d %d %d", spGetGameFrame(), unitID, unitDefID, unitTeam, builderID or -1)) end
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
  if out then w(format("E %d F %d %d %d", spGetGameFrame(), unitID, unitDefID, unitTeam)) end
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam)
  if not out then return end
  local x, _, z = spGetUnitPosition(unitID)
  w(format("E %d D %d %d %d %d %d %d %d %d", spGetGameFrame(), unitID, unitDefID, unitTeam, attackerID or -1,
    attackerDefID or -1, attackerTeam or -1, floor(x or -1), floor(z or -1)))
end

function widget:UnitGiven(unitID, unitDefID, newTeam, oldTeam)
  if out then w(format("E %d G %d %d %d %d", spGetGameFrame(), unitID, unitDefID, newTeam, oldTeam)) end
end

function widget:GameOver(winningAllyTeams)
  if out then w(format("E %d O %s", spGetGameFrame(), table.concat(winningAllyTeams or {}, ","))) end
  finish("gameover")
end

function widget:AddConsoleLine(msg)
  -- aborted demos never call GameOver; the engine prints this and then simulates an empty game forever
  if msg:find("End of demo reached", 1, true) then finish("endofdemo") end
end

function widget:Shutdown()
  if out then
    w(format("ABORT shutdown %d", spGetGameFrame())) -- not DONE: shutdown without game over / end of demo
    flush()
    out:close()
    out = nil
  end
end
