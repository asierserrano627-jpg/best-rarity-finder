-- Steal an Egg - Best Rarity Finder
-- Detector + modo AUTO: escanea el servidor actual, envia el informe a Render,
-- pide el siguiente servidor al backend y salta a el. Solo inspecciona los servidores
-- que realmente visita; no afirma haber escaneado todos.

local API = "https://best-rarity-finder.onrender.com"
-- Ruta "raw" de ESTE archivo en tu GitHub. Se usa para relanzar el script tras cada salto.
-- Ajusta rama/nombre si no coinciden. El repo debe ser publico.
local SCRIPT_URL = "https://raw.githubusercontent.com/asierserrano627-jpg/best-rarity-finder/main/finder.lua"

local MIN_DWELL = 3          -- segundos de espera antes de saltar tras reportar
local EGG_WAIT = 12          -- segundos maximos esperando a que carguen los huevos
local TELEPORT_TIMEOUT = 25  -- segundos antes de dar un salto por fallido
local MAX_FAILS = 5          -- fallos seguidos antes de una pausa larga
local KEEPALIVE = 300        -- reenviar informe sin cambios cada X segundos
local AUTO_DEFAULT = true    -- true: el modo AUTO arranca solo al ejecutar el script

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TeleportService = game:GetService("TeleportService")
local HttpService = game:GetService("HttpService")
local LocalPlayer = Players.LocalPlayer

local env = (getgenv and getgenv()) or _G
local runId = tostring(os.clock()) .. tostring(math.random(1, 1000000))
env.BRF_RUN = runId -- una instancia nueva invalida a las anteriores

local httpRequest = request or http_request or (syn and syn.request) or (fluxus and fluxus.request)
local queueOnTeleport = queue_on_teleport or (syn and syn.queue_on_teleport) or (fluxus and fluxus.queue_on_teleport)

local function safeRequire(module)
    local ok, result = pcall(require, module)
    return ok and result or nil
end

local RS = ReplicatedStorage
local EggState = safeRequire(RS:FindFirstChild("Client") and RS.Client:FindFirstChild("EggState"))
local AssetsData = safeRequire(RS:FindFirstChild("Data") and RS.Data:FindFirstChild("Assets"))
local AreasData = safeRequire(RS:FindFirstChild("Data") and RS.Data:FindFirstChild("Areas"))
local RarityData = safeRequire(RS:FindFirstChild("Data") and RS.Data:FindFirstChild("Rarity"))
local Shared = RS:FindFirstChild("Shared")
local SharedUtil = Shared and Shared:FindFirstChild("Util")
local AssetEarnings = safeRequire(SharedUtil and SharedUtil:FindFirstChild("AssetEarnings"))
local EggRecords = safeRequire(SharedUtil and SharedUtil:FindFirstChild("EggRecords"))

local function directoryOf(data)
    if type(data) ~= "table" then return {} end
    return data.Directory or data
end

local assetsDirectory = directoryOf(AssetsData)
local areasDirectory = directoryOf(AreasData)
local raritiesDirectory = type(RarityData) == "table" and (RarityData.Rarities or RarityData) or {}

-- La puntuacion usa RarityNumber si el juego la expone; si no, un orden orientativo.
local fallbackOrder = {
    common = 1, uncommon = 2, rare = 3, epic = 4, legendary = 5,
    mythic = 6, mythical = 6, exotic = 7, divine = 8, secret = 9,
    celestial = 10, transcendent = 11
}

local function getRarityInfo(egg)
    if type(egg) ~= "table" then return "Unknown", 0 end
    local rarity = egg.Rarity
    if not rarity then
        local category = egg.AssetCategory or egg.Category or egg.Name
        local asset = category and assetsDirectory[category]
        rarity = asset and asset.Rarity
    end

    if rarity then
        local name
        local score
        if type(rarity) == "table" then
            name = rarity.DisplayName or rarity._id or rarity.Name or "Unknown"
            score = tonumber(rarity.RarityNumber)
        else
            name = tostring(rarity)
        end
        if not score then
            local area = areasDirectory[egg.AreaId]
            local areaRarity = area and area.Rarity
            local rarityId = type(areaRarity) == "table" and (areaRarity._id or areaRarity.DisplayName or areaRarity.Name)
                or type(areaRarity) == "string" and areaRarity
            local info = rarityId and raritiesDirectory[rarityId]
            if type(info) == "table" then score = tonumber(info.RarityNumber) end
        end
        score = score or fallbackOrder[string.lower(tostring(name))] or 0
        return tostring(name), score
    end

    local area = areasDirectory[egg.AreaId]
    local areaRarity = area and area.Rarity
    local rarityId = type(areaRarity) == "table" and (areaRarity._id or areaRarity.DisplayName or areaRarity.Name)
        or type(areaRarity) == "string" and areaRarity
    local info = rarityId and raritiesDirectory[rarityId]
    local name = type(info) == "table" and (info.DisplayName or info._id) or rarityId or "Unknown"
    local score = (type(info) == "table" and tonumber(info.RarityNumber)) or fallbackOrder[string.lower(tostring(name))] or 0
    return tostring(name), score
end

-- Replica la estructura exacta usada por SenaHub Egg ESP: no pasa el registro bruto,
-- sino una tabla con Category, Scale, AssetScale, BaseMutation y Mutations.
local function getLiveMoneyPerSecond(egg)
    if type(AssetEarnings) ~= "table" or type(egg) ~= "table" then return nil end
    local scale = tonumber(egg.AssetScale or egg.Scale) or 1
    local input = {
        Category = egg.AssetCategory or egg.Category,
        Scale = scale,
        AssetScale = scale,
        BaseMutation = egg.BaseMutation,
        Mutations = type(egg.Mutations) == "table" and egg.Mutations or {}
    }
    for _, functionName in ipairs({"LiveRatePerSecond", "RatePerSecond", "CatalogRatePerSecond"}) do
        local fn = AssetEarnings[functionName]
        if type(fn) == "function" then
            local ok, result = pcall(fn, input)
            if ok and type(result) == "number" and result > 0 then return result end
        end
    end
    return nil
end

local function getWeightKg(egg)
    if type(EggRecords) ~= "table" or type(egg) ~= "table" or type(EggRecords.WeightKgForScale) ~= "function" then return nil end
    local category = egg.AssetCategory or egg.Category
    local scale = tonumber(egg.AssetScale or egg.Scale) or 1
    local ok, result = pcall(EggRecords.WeightKgForScale, category, scale)
    if ok and type(result) == "number" and result > 0 then return result end
    return nil
end

-- Respaldo: busca campos numéricos explícitos en el registro o los datos del asset.
local function findNumericValue(root, wantedNames, depth)
    if type(root) ~= "table" or depth > 4 then return nil end
    for key, value in pairs(root) do
        if type(key) == "string" and type(value) == "number" then
            local lower = string.lower(key)
            for _, wanted in ipairs(wantedNames) do
                if lower == wanted then return value end
            end
        end
    end
    for _, value in pairs(root) do
        if type(value) == "table" then
            local found = findNumericValue(value, wantedNames, depth + 1)
            if found ~= nil then return found end
        end
    end
    return nil
end

local function getMoneyInfo(egg)
    local category = egg and (egg.AssetCategory or egg.Category or egg.Name)
    local asset = category and assetsDirectory[category]
    local income = getLiveMoneyPerSecond(egg)
    if income == nil then
        local incomeKeys = {"moneypersecond", "cashpersecond", "incomepersecond", "coinspersecond", "earningspersecond", "valuepersecond"}
        income = findNumericValue(egg, incomeKeys, 0)
        if income == nil and asset then income = findNumericValue(asset, incomeKeys, 0) end
    end
    local valueKeys = {"sellvalue", "cashvalue", "coinvalue", "moneyvalue", "price", "value"}
    local worth = findNumericValue(egg, valueKeys, 0)
    if worth == nil and asset then worth = findNumericValue(asset, valueKeys, 0) end
    return income, worth
end

local function formatMoney(n)
    if type(n) ~= "number" then return "No disponible en los datos del juego" end
    local abs = math.abs(n)
    if abs >= 1e12 then return string.format("%.2fT", n / 1e12) end
    if abs >= 1e9 then return string.format("%.2fB", n / 1e9) end
    if abs >= 1e6 then return string.format("%.2fM", n / 1e6) end
    if abs >= 1e3 then return string.format("%.2fK", n / 1e3) end
    return tostring(math.floor(n))
end

local mutationScores = {
    Rainbow = 35, Gold = 20, Golden = 20, Silver = 10,
    Parasite = 800, Monstrous = 800
}

local function mutationScore(egg)
    local score = 0
    local mutations = type(egg.Mutations) == "table" and egg.Mutations or {}
    for _, mutation in ipairs(mutations) do
        score = score + (mutationScores[tostring(mutation)] or 0)
    end
    if egg.HasParasite == true then score = score + 800 end
    return score
end

local function getEggDisplayName(egg)
    local category = egg and (egg.AssetCategory or egg.Category or egg.Name)
    local asset = category and assetsDirectory[category]
    if type(asset) == "table" then
        return tostring(asset.DisplayName or asset.Name or asset.Title or category or "Egg")
    end
    return tostring(category or "Egg")
end

-- Tabla fija de nombre de pet -> imagen (la misma que usa SenaHub como respaldo)
local PET_IMAGES_BY_NAME = {
    Mosasaurus = "rbxassetid://124293259998827",
    ["Oni Tiger"] = "rbxassetid://109908891899435",
    ["Eternal Lunar Dragon"] = "rbxassetid://93762296316916",
    ["Lunar Dragon"] = "rbxassetid://93762296316916",
    ["King Kong"] = "rbxassetid://135650224014044",
    ["Gorilla King"] = "rbxassetid://135650224014044",
    ["Ice Dragon"] = "rbxassetid://101397684798718",
    Phoenix = "rbxassetid://118067990008425",
    ["Ascended Vermilion Phoenix"] = "rbxassetid://118067990008425",
    Dragon = "rbxassetid://78935088838538",
    ["Lava Dragon"] = "rbxassetid://78935088838538",
    ["Dragon (Lava)"] = "rbxassetid://78935088838538",
    Pegasus = "rbxassetid://112830316982322",
    ["El Maja"] = "rbxassetid://77518688092604",
    Kitsune = "rbxassetid://107842067813602",
    Unicorn = "rbxassetid://70463817382627",
    Godzilla = "rbxassetid://102979882140882",
    ArchAngel = "rbxassetid://113289118499426",
    ["Cosmic Dragon"] = "rbxassetid://107923370723949",
    TRex = "rbxassetid://124293259998827",
    Gargoyle = "rbxassetid://137949993315884",
    ["King Snake"] = "rbxassetid://77518688092604",
}

local IMAGE_KEYS = {"Image", "Icon", "Thumbnail", "ImageId", "IconId", "Texture", "Asset", "DisplayImage"}

local function normalizeImage(value)
    if type(value) == "number" and value > 0 then
        return "rbxassetid://" .. tostring(math.floor(value))
    elseif type(value) == "string" and value ~= "" then
        if value:find("rbxassetid", 1, true) or value:find("rbxthumb", 1, true) then
            return value
        elseif value:match("^%d+$") then
            return "rbxassetid://" .. value
        end
    end
    return nil
end

local function imageFromTable(t)
    if type(t) ~= "table" then return nil end
    for _, key in ipairs(IMAGE_KEYS) do
        local image = normalizeImage(t[key])
        if image then return image end
    end
    return nil
end

local function petByName(name)
    return name and PET_IMAGES_BY_NAME[tostring(name)] or nil
end

-- Imagen del PET. Orden: campo Pet, Icon de la categoría, Egg.Icon y, como ultimo
-- respaldo, la tabla fija por nombre.
local function getPetImage(egg)
    local category = egg and (egg.AssetCategory or egg.Category or egg.Name)
    local asset = category and assetsDirectory[category]
    local displayName = type(asset) == "table" and (asset.DisplayName or asset.Name) or nil

    -- Tabla manual por nombre: solo como ULTIMO respaldo
    local byName = petByName(displayName) or petByName(category) or petByName(egg and egg.Name)

    if type(asset) ~= "table" then return byName end

    -- 1) Campo Pet del catálogo (mismo orden que la función de comprobación)
    local pet = asset.Pet
    local image = normalizeImage(pet) or imageFromTable(pet)
    if image then return image end
    if type(pet) == "table" then
        for _, nested in pairs(pet) do
            image = imageFromTable(nested)
            if image then return image end
        end
    end

    -- 2) Icon de la categoría
    image = normalizeImage(asset.Icon)
    if image then return image end

    -- 3) Egg.Icon
    if type(asset.Egg) == "table" then
        image = normalizeImage(asset.Egg.Icon)
        if image then return image end
    end

    -- 4) Tabla manual por nombre
    return byName
end

local function getBestEgg()
    if not EggState or type(EggState.ReadFieldEggs) ~= "function" then
        return nil, "No se encontro Client.EggState.ReadFieldEggs"
    end

    local ok, snapshot = pcall(EggState.ReadFieldEggs)
    if not ok or type(snapshot) ~= "table" or type(snapshot.Records) ~= "table" then
        return nil, "No se pudo leer el listado de huevos"
    end

    local best
    for _, egg in ipairs(snapshot.Records) do
        if egg.State == "Slot" and egg.BoundsCFrame then
            local rarityName, rarityScore = getRarityInfo(egg)
            local muts = type(egg.Mutations) == "table" and egg.Mutations or {}
            local candidate = {
                record = egg,
                name = getEggDisplayName(egg),
                petImage = getPetImage(egg),
                rarity = rarityName,
                rarityScore = rarityScore,
                mutations = #muts > 0 and table.concat(muts, ", ") or "Normal",
                mutationScore = mutationScore(egg),
                moneyPerSecond = select(1, getMoneyInfo(egg)),
                moneyValue = select(2, getMoneyInfo(egg)),
                weightKg = getWeightKg(egg),
                uid = tostring(egg.Uid or "?"),
                area = tostring(egg.AreaId or "?")
            }

            -- Prioriza el ingreso por segundo cuando el juego proporciona ese dato.
            -- Si no existe, compara rareza y luego mutaciones.
            local betterIncome = candidate.moneyPerSecond ~= nil and
                (not best or best.moneyPerSecond == nil or candidate.moneyPerSecond > best.moneyPerSecond)
            local sameIncome = best and candidate.moneyPerSecond ~= nil and best.moneyPerSecond ~= nil
                and candidate.moneyPerSecond == best.moneyPerSecond
            local noIncomeData = best and candidate.moneyPerSecond == nil and best.moneyPerSecond == nil
            if not best
                or betterIncome
                or ((sameIncome or noIncomeData) and (candidate.rarityScore > best.rarityScore
                    or (candidate.rarityScore == best.rarityScore and candidate.mutationScore > best.mutationScore))) then
                best = candidate
            end
        end
    end
    return best, best and nil or "No hay huevos en estado Slot en este servidor"
end

-- NUEVO: los N mejores animales del servidor (para el informe a Render)
local function getTopEggs(limit)
    if not EggState or type(EggState.ReadFieldEggs) ~= "function" then
        return nil, "No se encontro Client.EggState.ReadFieldEggs"
    end

    local ok, snapshot = pcall(EggState.ReadFieldEggs)
    if not ok or type(snapshot) ~= "table" or type(snapshot.Records) ~= "table" then
        return nil, "No se pudo leer el listado de huevos"
    end

    local list = {}
    for _, egg in ipairs(snapshot.Records) do
        if egg.State == "Slot" and egg.BoundsCFrame then
            local rarityName, rarityScore = getRarityInfo(egg)
            local muts = type(egg.Mutations) == "table" and egg.Mutations or {}
            local income = getMoneyInfo(egg)
            list[#list + 1] = {
                name = getEggDisplayName(egg),
                rarity = rarityName,
                rarityScore = rarityScore,
                mutations = #muts > 0 and table.concat(muts, ", ") or "Normal",
                mutationScore = mutationScore(egg),
                moneyPerSecond = income,
                petImage = getPetImage(egg)
            }
        end
    end

    table.sort(list, function(a, b)
        local ai, bi = a.moneyPerSecond or -1, b.moneyPerSecond or -1
        if ai ~= bi then return ai > bi end
        if a.rarityScore ~= b.rarityScore then return a.rarityScore > b.rarityScore end
        return a.mutationScore > b.mutationScore
    end)

    local top = {}
    for i = 1, math.min(limit or 5, #list) do top[i] = list[i] end
    return top
end

-- UI
local playerGui = LocalPlayer:WaitForChild("PlayerGui")
local old = playerGui:FindFirstChild("BestRarityEggFinder")
if old then old:Destroy() end

local gui = Instance.new("ScreenGui")
gui.Name = "BestRarityEggFinder"
gui.ResetOnSpawn = false
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = playerGui

local frame = Instance.new("Frame")
frame.Name = "Main"
frame.Size = UDim2.fromOffset(330, 348)
frame.Position = UDim2.new(0.5, -165, 0.5, -150)
frame.BackgroundColor3 = Color3.fromRGB(23, 25, 38)
frame.BorderSizePixel = 0
frame.Active = true
frame.Draggable = true
frame.Parent = gui

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 14)
corner.Parent = frame

local stroke = Instance.new("UIStroke")
stroke.Color = Color3.fromRGB(91, 105, 160)
stroke.Thickness = 1.5
stroke.Parent = frame

local function makeLabel(name, text, position, size, textSize)
    local label = Instance.new("TextLabel")
    label.Name = name
    label.Position = position
    label.Size = size
    label.BackgroundTransparency = 1
    label.Font = Enum.Font.GothamSemibold
    label.Text = text
    label.TextColor3 = Color3.fromRGB(240, 243, 255)
    label.TextSize = textSize or 14
    label.TextWrapped = true
    label.Parent = frame
    return label
end

makeLabel("Title", "🥚 BEST MONEY FINDER", UDim2.fromOffset(12, 8), UDim2.new(1, -24, 0, 30), 17)
local status = makeLabel("Status", "Iniciando...", UDim2.fromOffset(14, 43), UDim2.new(1, -28, 0, 25), 12)
status.TextColor3 = Color3.fromRGB(160, 195, 255)

local petImage = Instance.new("ImageLabel")
petImage.Name = "PetImage"
petImage.Position = UDim2.fromOffset(14, 75)
petImage.Size = UDim2.fromOffset(76, 76)
petImage.BackgroundColor3 = Color3.fromRGB(37, 41, 59)
petImage.BackgroundTransparency = 0
petImage.BorderSizePixel = 0
petImage.ScaleType = Enum.ScaleType.Fit
petImage.Image = ""
petImage.Visible = false
petImage.Parent = frame
Instance.new("UICorner", petImage).CornerRadius = UDim.new(0, 10)

local eggInfo = makeLabel("EggInfo", "PET: --\nDinero por segundo: --\nRareza: --\nMutaciones: --\nZona: --", UDim2.fromOffset(100, 72), UDim2.new(1, -114, 0, 112), 12)
eggInfo.TextXAlignment = Enum.TextXAlignment.Left
eggInfo.TextYAlignment = Enum.TextYAlignment.Top

local jobLabel = makeLabel("JobIdLabel", "JobId actual:", UDim2.fromOffset(14, 178), UDim2.new(1, -28, 0, 18), 11)
jobLabel.TextXAlignment = Enum.TextXAlignment.Left

local jobBox = Instance.new("TextBox")
jobBox.Name = "JobIdInput"
jobBox.Position = UDim2.fromOffset(14, 198)
jobBox.Size = UDim2.new(1, -28, 0, 31)
jobBox.BackgroundColor3 = Color3.fromRGB(37, 41, 59)
jobBox.BorderSizePixel = 0
jobBox.ClearTextOnFocus = false
jobBox.Font = Enum.Font.Code
jobBox.TextSize = 10
jobBox.TextColor3 = Color3.fromRGB(225, 230, 255)
jobBox.Text = game.JobId
jobBox.PlaceholderText = "Pega aquí un JobId de otro servidor"
jobBox.Parent = frame
Instance.new("UICorner", jobBox).CornerRadius = UDim.new(0, 7)

local function makeButton(name, text, position, size, color)
    local button = Instance.new("TextButton")
    button.Name = name
    button.Text = text
    button.Position = position
    button.Size = size
    button.BackgroundColor3 = color
    button.BorderSizePixel = 0
    button.Font = Enum.Font.GothamBold
    button.TextSize = 12
    button.TextColor3 = Color3.new(1, 1, 1)
    button.Parent = frame
    Instance.new("UICorner", button).CornerRadius = UDim.new(0, 8)
    return button
end

local scanButton = makeButton("ScanButton", "SCAN", UDim2.fromOffset(14, 238), UDim2.new(0.5, -20, 0, 34), Color3.fromRGB(45, 110, 220))
local joinButton = makeButton("JoinButton", "JOIN JOBID", UDim2.new(0.5, 6, 0, 238), UDim2.new(0.5, -20, 0, 34), Color3.fromRGB(38, 151, 99))
local closeButton = makeButton("CloseButton", "×", UDim2.new(1, -34, 0, 7), UDim2.fromOffset(25, 25), Color3.fromRGB(155, 55, 68))
closeButton.TextSize = 18

-- NUEVO: boton AUTO y linea de estado de la API
local AUTO_ON_COLOR = Color3.fromRGB(38, 151, 99)
local AUTO_OFF_COLOR = Color3.fromRGB(70, 74, 98)
local autoButton = makeButton("AutoButton", "AUTO: OFF", UDim2.fromOffset(14, 280), UDim2.new(1, -28, 0, 32), AUTO_OFF_COLOR)
local apiLabel = makeLabel("ApiLabel", "API: --", UDim2.fromOffset(14, 316), UDim2.new(1, -28, 0, 22), 11)
apiLabel.TextColor3 = Color3.fromRGB(160, 170, 205)
apiLabel.TextXAlignment = Enum.TextXAlignment.Left

local function active()
    return env.BRF_RUN == runId and gui.Parent ~= nil
end

local function setStatus(text)
    if gui.Parent then status.Text = text end
end

local function setApi(text)
    if gui.Parent then apiLabel.Text = "API: " .. tostring(text) end
end

-- NUEVO: comunicacion con el backend (usa el request() del ejecutor)
local function apiCall(method, path, body)
    if not httpRequest then return nil, "tu ejecutor no tiene request()" end
    local payload = {
        Url = API .. path,
        Method = method,
        Headers = { ["Content-Type"] = "application/json" },
    }
    if body then payload.Body = HttpService:JSONEncode(body) end

    local ok, res = pcall(httpRequest, payload)
    if not ok or type(res) ~= "table" then return nil, tostring(res) end

    local code = res.StatusCode or res.status_code
    local decoded
    if type(res.Body) == "string" and res.Body ~= "" then
        local okJson, value = pcall(function() return HttpService:JSONDecode(res.Body) end)
        if okJson then decoded = value end
    end

    if code and code >= 200 and code < 300 then return decoded or {} end
    return nil, "HTTP " .. tostring(code), decoded
end

-- NUEVO: enviar informe (solo si cambia, o cada KEEPALIVE segundos)
local lastSig, lastSentAt, reporting = nil, 0, false

local function reportCurrent(force)
    while reporting do task.wait(0.2) end
    reporting = true

    local ok, success, message = pcall(function()
        local eggs, err = getTopEggs(5)
        if not eggs then return false, err end

        local pets, parts = {}, {}
        for _, egg in ipairs(eggs) do
            if egg.moneyPerSecond then
                pets[#pets + 1] = {
                    name = egg.name,
                    rarity = egg.rarity,
                    mutations = egg.mutations,
                    moneyPerSecond = egg.moneyPerSecond,
                    imageId = egg.petImage and (egg.petImage:match("%d+") or "") or ""
                }
                parts[#parts + 1] = egg.name .. "|" .. egg.mutations .. "|" .. tostring(egg.moneyPerSecond)
            end
        end

        local sig = game.JobId .. "#" .. table.concat(parts, ";")
        if not force and sig == lastSig and os.clock() - lastSentAt < KEEPALIVE then
            return true, "sin cambios"
        end

        -- pets = {} marca "servidor escaneado sin animales"
        local data, herr, body = apiCall("POST", "/api/reports", { jobId = game.JobId, pets = pets })
        if not data then
            local detail = type(body) == "table" and body.error or herr
            return false, tostring(detail)
        end

        lastSig, lastSentAt = sig, os.clock()
        if data.unchanged then return true, "refrescado" end
        return true, "enviado (" .. #pets .. ")"
    end)

    reporting = false

    if not ok then
        setApi("error interno")
        return false
    end
    setApi((success and "informe " or "error: ") .. tostring(message))
    return success
end

local bestFound = nil
local function scan(skipReport)
    setStatus("Escaneando este servidor...")
    local best, err = getBestEgg()
    bestFound = best
    if not best then
        eggInfo.Text = err or "No se encontró ningún huevo"
        setStatus("Sin resultados")
    else
        local idText = best.petImage and (best.petImage:match("%d+") or best.petImage) or "no encontrado"
        eggInfo.Text = "PET: " .. best.name
            .. "\nDinero por segundo: " .. formatMoney(best.moneyPerSecond)
            .. "\nRareza: " .. best.rarity
            .. "\nMutaciones: " .. best.mutations
            .. "\nZona: " .. best.area
            .. "\nImage ID: " .. idText
        petImage.Image = best.petImage or ""
        petImage.Visible = best.petImage ~= nil
        eggInfo.Position = best.petImage and UDim2.fromOffset(100, 72) or UDim2.fromOffset(14, 72)
        eggInfo.Size = best.petImage and UDim2.new(1, -114, 0, 112) or UDim2.new(1, -28, 0, 112)
        setStatus("Mejor PET encontrado en este servidor")
    end

    if not skipReport then
        task.spawn(reportCurrent, false)
    end
end

scanButton.MouseButton1Click:Connect(function() scan() end)

joinButton.MouseButton1Click:Connect(function()
    local targetJobId = tostring(jobBox.Text or ""):gsub("%s+", "")
    if targetJobId == "" then
        status.Text = "Pega un JobId primero"
        return
    end
    if targetJobId == game.JobId then
        status.Text = "Ya estás en ese servidor"
        return
    end
    status.Text = "Intentando entrar al servidor..."
    local ok, err = pcall(function()
        TeleportService:TeleportToPlaceInstance(game.PlaceId, targetJobId, LocalPlayer)
    end)
    if not ok then
        status.Text = "No se pudo iniciar el teleport: " .. tostring(err)
    end
end)

closeButton.MouseButton1Click:Connect(function()
    env.BRF_RUN = nil
    gui:Destroy()
end)

-- ===== NUEVO: modo AUTO =====
local autoEnabled = (env.BRF_AUTO_START == true or AUTO_DEFAULT) and httpRequest ~= nil and queueOnTeleport ~= nil
env.BRF_AUTO_START = nil

local function refreshAutoButton()
    autoButton.Text = autoEnabled and "AUTO: ON" or "AUTO: OFF"
    autoButton.BackgroundColor3 = autoEnabled and AUTO_ON_COLOR or AUTO_OFF_COLOR
end
refreshAutoButton()

autoButton.MouseButton1Click:Connect(function()
    if not autoEnabled and not (httpRequest and queueOnTeleport) then
        setStatus("AUTO necesita request() y queue_on_teleport en tu ejecutor")
        return
    end
    autoEnabled = not autoEnabled
    refreshAutoButton()
    setStatus(autoEnabled and "AUTO activado" or "AUTO desactivado")
end)

-- Gestion de fallos de teletransporte
local pendingTarget, teleportFailed, teleportError = nil, false, nil
TeleportService.TeleportInitFailed:Connect(function(_, result, message)
    if pendingTarget then
        teleportFailed = true
        teleportError = tostring(result) .. (message and (": " .. tostring(message)) or "")
    end
end)

-- Relanza este script tras el salto (se encola UNA vez por instancia para evitar duplicados)
local queued = false
local function queueSelf()
    if queued or not queueOnTeleport then return end
    queued = true
    local code = 'local e = (getgenv and getgenv()) or _G\n'
        .. 'e.BRF_AUTO_START = true\n'
        .. 'loadstring(game:HttpGet("' .. SCRIPT_URL .. '"))()'
    pcall(queueOnTeleport, code)
end

local fails = 0

local function backoff()
    local seconds = math.min(5 * (2 ^ fails), 60)
    for i = math.floor(seconds), 1, -1 do
        if not active() then return end
        setApi("reintento en " .. i .. " s")
        task.wait(1)
    end
end

local function hop()
    setStatus("Pidiendo siguiente servidor...")
    local data, err = apiCall("GET", "/api/next-server?current=" .. game.JobId)
    if not data then
        setStatus("Sin conexión con la API: " .. tostring(err))
        fails = fails + 1
        backoff()
        return
    end

    if data.coverage then
        setApi("escaneados " .. tostring(data.coverage.serversScanned) .. "/" .. tostring(data.coverage.serversKnown))
    end

    if not data.jobId then
        setStatus("No hay servidores libres ahora. Esperando...")
        task.wait(tonumber(data.retryAfter) or 30)
        return
    end

    local target = data.jobId
    if target == game.JobId then return end

    queueSelf()
    pendingTarget, teleportFailed, teleportError = target, false, nil
    setStatus("Saltando a " .. string.sub(target, 1, 8) .. "...")

    local ok, perr = pcall(function()
        TeleportService:TeleportToPlaceInstance(game.PlaceId, target, LocalPlayer)
    end)

    if ok then
        local t = os.clock()
        while active() and not teleportFailed and os.clock() - t < TELEPORT_TIMEOUT do
            task.wait(0.5)
        end
    else
        teleportError = tostring(perr)
    end

    -- Si seguimos aquí, el salto falló o se agotó el tiempo
    if not active() then return end
    pendingTarget = nil
    fails = fails + 1
    setStatus("Salto fallido (" .. tostring(teleportError or "tiempo agotado") .. ")")
    apiCall("POST", "/api/failed", { jobId = target })

    if fails >= MAX_FAILS then
        setStatus("Demasiados fallos seguidos. Pausa de 60 s")
        task.wait(60)
        fails = 0
    else
        backoff()
    end
end

local function waitForEggs(timeout)
    local t = os.clock()
    while active() and os.clock() - t < timeout do
        local eggs = getTopEggs(1)
        if eggs and #eggs > 0 then return true end
        task.wait(1)
    end
    return false
end

task.spawn(function()
    if not game:IsLoaded() then game.Loaded:Wait() end

    while active() do
        if autoEnabled then
            task.wait(3)
            waitForEggs(EGG_WAIT)
            if not active() then break end
            scan(true)
            reportCurrent(true)
            task.wait(MIN_DWELL)
            if autoEnabled and active() then hop() end
        else
            scan()
            task.wait(8)
        end
    end
end)
