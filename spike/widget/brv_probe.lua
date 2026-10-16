-- Probe: which builder/worker APIs exist and what they return during a replay.
function widget:GetInfo()
  return { name = "BRV Spike", desc = "api probe", author = "brv", layer = -100000, enabled = true, handler = true }
end
local function log(s) Spring.Echo("[BRV] " .. s) end
local seen = {}
function widget:Initialize()
  Spring.SendCommands("setmaxspeed 1000", "setminspeed 1000", "setspeed 1000", "specfullview 1")
  local victims, me = {}, widget:GetInfo().name
  for _, w in ipairs(widgetHandler.widgets) do if w.whInfo.name ~= me then victims[#victims + 1] = w end end
  for _, w in ipairs(victims) do widgetHandler:RemoveWidget(w) end
  log("api GetUnitWorkerTask=" .. tostring(Spring.GetUnitWorkerTask ~= nil) .. " GetUnitIsBuilding=" .. tostring(Spring.GetUnitIsBuilding ~= nil)
    .. " GetProjectileType=" .. tostring(Spring.GetProjectileType ~= nil) .. " maxUnits=" .. tostring(Game.maxUnits))
  local wd = WeaponDefs[1]
  log("weapon vis keys: colorR=" .. tostring(wd.visuals and wd.visuals.colorR) .. " size=" .. tostring(wd.size) .. " name=" .. wd.name)
end
function widget:GameFrame(n)
  if n % 60 ~= 0 then return end
  local counts = {}
  for _, id in ipairs(Spring.GetAllUnits()) do
    local ud = UnitDefs[Spring.GetUnitDefID(id)]
    if ud and ud.isBuilder then
      local cmd, target = Spring.GetUnitWorkerTask(id)
      local building = Spring.GetUnitIsBuilding(id)
      if cmd then
        local key = tostring(cmd)
        counts[key] = (counts[key] or 0) + 1
        if not seen[key] then
          seen[key] = true
          local tx, tz = -1, -1
          if target then
            if Spring.ValidUnitID(target) then local x, _, z = Spring.GetUnitPosition(target); tx, tz = x, z
            elseif Spring.ValidFeatureID(target) then local x, _, z = Spring.GetFeaturePosition(target); tx, tz = x, z; key = key .. "(feature)"
            elseif Spring.ValidFeatureID(target - Game.maxUnits) then local x, _, z = Spring.GetFeaturePosition(target - Game.maxUnits); tx, tz = x, z; key = key .. "(feature-offset)" end
          end
          log(string.format("task cmd=%s target=%s building=%s pos=%.0f,%.0f unit=%s", key, tostring(target), tostring(building), tx, tz, ud.name))
        end
      end
    end
  end
  local parts = {}
  for k, v in pairs(counts) do parts[#parts + 1] = k .. ":" .. v end
  if #parts > 0 and n % 600 == 0 then log("frame " .. n .. " tasks " .. table.concat(parts, " ")) end
  if n == 1800 then
    local projs = Spring.GetProjectilesInRectangle(0, 0, Game.mapSizeX, Game.mapSizeZ)
    log("projectiles " .. #projs)
  end
end
function widget:AddConsoleLine(msg) if msg:find("End of demo reached", 1, true) then Spring.SendCommands("quitforce") end end
