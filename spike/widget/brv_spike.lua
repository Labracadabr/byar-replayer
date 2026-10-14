-- BAR Replay Viewer: milestone-0 spike widget.
-- Samples all units every SAMPLE frames into brv_spike_out.txt, tests IO, speed control,
-- unloading BAR's own UI widgets, and a completion marker.
function widget:GetInfo()
  return { name = "BRV Spike", desc = "headless recorder spike", author = "brv",
           layer = -100000, enabled = true, handler = true }
end

local SAMPLE = 15
local out
local spGetUnitPosition, spGetUnitDefID, spGetUnitTeam = Spring.GetUnitPosition, Spring.GetUnitDefID, Spring.GetUnitTeam
local spGetUnitHealth, spGetUnitHeading = Spring.GetUnitHealth, Spring.GetUnitHeading

local function log(s) Spring.Echo("[BRV] " .. s) end

function widget:Initialize()
  log("init isReplay=" .. tostring(Spring.IsReplay()))
  out = io.open("brv_spike_out.txt", "w")
  Spring.SendCommands("setmaxspeed 1000", "setminspeed 1000", "setspeed 1000")
  -- unload every other LuaUI widget: they are pure UI and cost ~15% CPU headless
  local removed, me = 0, widget:GetInfo().name
  local victims = {}
  for _, w in ipairs(widgetHandler.widgets) do
    if w.whInfo.name ~= me then victims[#victims + 1] = w end
  end
  for _, w in ipairs(victims) do widgetHandler:RemoveWidget(w); removed = removed + 1 end
  log("removed widgets=" .. removed)
end

function widget:GameFrame(n)
  if n % SAMPLE ~= 0 or not out then return end
  local units = Spring.GetAllUnits()
  local projs = Spring.GetProjectilesInRectangle(0, 0, Game.mapSizeX, Game.mapSizeZ)
  out:write("F ", n, " ", #units, " ", projs and #projs or -1, "\n")
  for i = 1, #units do
    local id = units[i]
    local x, _, z = spGetUnitPosition(id)
    local hp, maxhp, _, _, build = spGetUnitHealth(id)
    out:write(id, " ", spGetUnitDefID(id), " ", spGetUnitTeam(id), " ", math.floor(x), " ", math.floor(z), " ",
      spGetUnitHeading(id), " ", math.floor(hp or 0), " ", math.floor(maxhp or 0), " ", string.format("%.2f", build or 1), "\n")
  end
  if n % 1800 == 0 then
    log("F " .. n .. " units=" .. #units .. " projectiles=" .. (projs and #projs or -1) .. " clock=" .. os.clock())
  end
end

local function finish(reason)
  log("finish reason=" .. reason .. " frame=" .. Spring.GetGameFrame())
  if out then out:write("DONE ", reason, " ", Spring.GetGameFrame(), "\n"); out:close(); out = nil end
  Spring.SendCommands("quitforce")
end

function widget:GameOver(winners)
  log("GameOver winners=" .. table.concat(winners or {}, ","))
  finish("gameover")
end

-- Demos without a proper game end (aborted / crashed games) never call GameOver: the engine
-- prints "End of demo reached" and then keeps simulating an empty game forever.
function widget:AddConsoleLine(msg)
  if msg:find("End of demo reached", 1, true) then finish("endofdemo") end
end

function widget:Shutdown()
  log("shutdown frame=" .. Spring.GetGameFrame())
  if out then out:write("SHUTDOWN ", Spring.GetGameFrame(), "\n"); out:close(); out = nil end
end
