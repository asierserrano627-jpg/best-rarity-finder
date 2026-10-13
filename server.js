
-- Steal an Egg - Best Rarity Finder
-- Escanea el servidor actual y envía el mejor resultado a la API.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TeleportService = game:GetService("TeleportService")
local HttpService = game:GetService("HttpService")
local LocalPlayer = Players.LocalPlayer

local API_URL = "https://best-rarity-finder.onrender.com"
local REPORT_URL = API_URL .. "/api/reports"

local function safeRequire(module)
    if not module then return nil end
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
local raritiesDirectory = type(RarityData) == "table"
    and (RarityData.Rarities or RarityData) or {}

local fallbackOrder = {
    common = 1, uncommon = 2, rare = 3, epic = 4,
    legendary = 5, mythic = 6, mythical = 6, exotic = 7,
    divine = 8, secret = 9, celestial = 10, transcendent = 11
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
            local rarityId = type(areaRarity) == "table"
                and (areaRarity._id or areaRarity.DisplayName or areaRarity.Name)
                or type(areaRarity) == "string" and areaRarity
            local info = rarityId and raritiesDirectory[rarityId]
            if type(info) == "table" then
                score = tonumber(info.RarityNumber)
            end
        end

        score = score or fallbackOrder[string.lower(tostring(name))] or 0
        return tostring(name), score
    end

    local area = areasDirectory[egg.AreaId]
    local areaRarity = area and area.Rarity
    local rarityId = type(areaRarity) == "table"
        and (areaRarity._id or areaRarity.DisplayName or areaRarity.Name)
        or type(areaRarity) == "string" and areaRarity
    local info = rarityId and raritiesDirectory[rarityId]
    local name = type(info) == "table"
        and (info.DisplayName or info._id) or rarityId or "Unknown"
    local score = (type(info) == "table" and tonumber(info.RarityNumber))
        or fallbackOrder[string.lower(tostring(name))] or 0

    return tostring(name), score
end

local function getLiveMoneyPerSecond(egg)
    if type(AssetEarnings) ~= "table" or type(egg) ~= "table" then
        return nil
    end

    local scale = tonumber(egg.AssetScale or egg.Scale) or 1
    local input = {
        Category = egg.AssetCategory or egg.Category,
        Scale = scale,
        AssetScale = scale,
        BaseMutation = egg.BaseMutation,
        Mutations = type(egg.Mutations) == "table" and egg.Mutations or {}
    }

    for _, functionName in ipairs({
        "LiveRatePerSecond",
        "RatePerSecond",
        "CatalogRatePerSecond"
    }) do
        local fn = AssetEarnings[functionName]
        if type(fn) == "function" then
            local ok, result = pcall(fn, input)
            if ok and type(result) == "number" and result > 0 then
                return result
            end
        end
    end

    return nil
end

local function getWeightKg(egg)
    if type(EggRecords) ~= "table"
        or type(egg) ~= "table"
        or type(EggRecords.WeightKgForScale) ~= "function" then
        return nil
    end

    local category = egg.AssetCategory or egg.Category
    local scale = tonumber(egg.AssetScale or egg.Scale) or 1
    local ok, result = pcall(EggRecords.WeightKgForScale, category, scale)

    if ok and type(result) == "number" and result > 0 then
        return result
    end

    return nil
end

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
        local keys = {
            "moneypersecond", "cashpersecond", "incomepersecond",
            "coinspersecond", "earningspersecond", "valuepersecond"
        }
        income = findNumericValue(egg, keys, 0)
        if income == nil and asset then
            income = findNumericValue(asset, keys, 0)
        end
    end

    local valueKeys = {
        "sellvalue", "cashvalue", "coinvalue",
        "moneyvalue", "price", "value"
    }
    local worth = findNumericValue(egg, valueKeys, 0)
    if worth == nil and asset then
        worth = findNumericValue(asset, valueKeys, 0)
    end

    return income, worth
end

local function formatMoney(n)
    if type(n) ~= "number" then return "No disponible" end
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
    ["King Snake"] = "rbxassetid://77518688092604"
}

local IMAGE_KEYS = {
    "Image", "Icon", "Thumbnail", "ImageId",
    "IconId", "Texture", "Asset", "DisplayImage"
}

local function normalizeImage(value)
    if type(value) == "number" and value > 0 then
        return "rbxassetid://" .. tostring(math.floor(value))
    elseif type(value) == "string" and value ~= "" then
        if value:find("rbxassetid", 1, true)
            or value:find("rbxthumb", 1, true) then
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

local function getPetImage(egg)
    local category = egg and (egg.AssetCategory or egg.Category or egg.Name)
    local asset = category and assetsDirectory[category]
    local displayName = type(asset) == "table"
        and (asset.DisplayName or asset.Name) or nil

    local byName = petByName(displayName)
        or petByName(category)
        or petByName(egg and egg.Name)

    if byName then return byName end
    if type(asset) ~= "table" then return nil end

    local pet = asset.Pet
    local image = normalizeImage(pet) or imageFromTable(pet)
    if image then return image end

    if type(pet) == "table" then
        for _, nested in pairs(pet) do
            image = imageFromTable(nested)
            if image then return image end
        end
    end

    image = normalizeImage(asset.Icon)
    if image then return image end

    if type(asset.Egg) == "table" then
        return normalizeImage(asset.Egg.Icon)
    end

    return nil
end

local function getBestEgg()
    if not EggState or type(EggState.ReadFieldEggs) ~= "function" then
        return nil, "No se encontró Client.EggState.ReadFieldEggs"
    end

    local ok, snapshot = pcall(EggState.ReadFieldEggs)
    if not ok or type(snapshot) ~= "table"
        or type(snapshot.Records) ~= "table" then
        return nil, "No se pudo leer el listado de huevos"
    end

    local best

    for _, egg in ipairs(snapshot.Records) do
        if egg.State == "Slot" and egg.BoundsCFrame then
            local rarityName, rarityScore = getRarityInfo(egg)
            local mutations = type(egg.Mutations) == "table" and egg.Mutations or {}
            local income, worth = getMoneyInfo(egg)

            local candidate = {
                record = egg,
                name = getEggDisplayName(egg),
                petImage = getPetImage(egg),
                rarity = rarityName,
                rarityScore = rarityScore,
                mutations = #mutations > 0 and table.concat(mutations, ", ") or "Normal",
                mutationScore = mutationScore(egg),
                moneyPerSecond = income,
                moneyValue = worth,
                weightKg = getWeightKg(egg),
                uid = tostring(egg.Uid or "?"),
                area = tostring(egg.AreaId or "?")
            }

            local betterIncome = candidate.moneyPerSecond ~= nil
                and (not best or best.moneyPerSecond == nil
                or candidate.moneyPerSecond > best.moneyPerSecond)

            local sameIncome = best
                and candidate.moneyPerSecond ~= nil
                and best.moneyPerSecond ~= nil
                and candidate.moneyPerSecond == best.moneyPerSecond

            local noIncomeData = best
                and candidate.moneyPerSecond == nil
                and best.moneyPerSecond == nil

            if not best
                or betterIncome
                or ((sameIncome or noIncomeData)
                and (candidate.rarityScore > best.rarityScore
                or (candidate.rarityScore == best.rarityScore
                and candidate.mutationScore > best.mutationScore))) then
                best = candidate
            end
        end
    end

    return best, best and nil or "No hay huevos en estado Slot en este servidor"
end

-- Enviar el mejor resultado a la API.
-- No contiene claves privadas.
local lastReportAt = 0
local REPORT_INTERVAL = 60

local function sendBestReport(best)
    if not best then return end

    if type(best.moneyPerSecond) ~= "number"
        or best.moneyPerSecond < 0 then
        warn("Reporte omitido: no hay un valor de dinero por segundo válido.")
        return
    end

    local now = os.clock()
    if now - lastReportAt < REPORT_INTERVAL then
        return
    end

    local payload = {
        jobId = game.JobId,
        pets = {
            {
                name = tostring(best.name or "Unknown"),
                moneyPerSecond = best.moneyPerSecond,
                rarity = tostring(best.rarity or "Unknown"),
                mutations = tostring(best.mutations or "Normal")
            }
        }
    }

    local encodedOk, body = pcall(function()
        return HttpService:JSONEncode(payload)
    end)

    if not encodedOk then
        warn("No se pudo preparar el reporte.")
        return
    end

    local requestFn

    if type(syn) == "table" and type(syn.request) == "function" then
        requestFn = syn.request
    elseif type(http) == "table" and type(http.request) == "function" then
        requestFn = http.request
    elseif type(request) == "function" then
        requestFn = request
    end

    if not requestFn then
        warn("Este entorno no ofrece una función HTTP compatible.")
        return
    end

    local sent, response = pcall(function()
        return requestFn({
            Url = REPORT_URL,
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json"
            },
            Body = body
        })
    end)

    if sent and type(response) == "table"
        and (response.StatusCode == 200 or response.StatusCode == 201) then
        lastReportAt = now
        print("Best Rarity Finder: reporte enviado.")
    else
        warn("No se pudo enviar el reporte a la API.")
        if sent and type(response) == "table" then
            warn("Respuesta HTTP:", tostring(response.StatusCode))
        elseif not sent then
            warn(tostring(response))
        end
    end
end

-- Interfaz
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
frame.Size = UDim2.fromOffset(330, 300)
frame.Position = UDim2.new(0.5, -165, 0.5, -135)
frame.BackgroundColor3 = Color3.fromRGB(23, 25, 38)
frame.BorderSizePixel = 0
frame.Active = true
frame.Draggable = true
frame.Parent = gui

Instance.new("UICorner", frame).CornerRadius = UDim.new(0, 14)

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

makeLabel(
    "Title",
    "🥚 BEST MONEY FINDER",
    UDim2.fromOffset(12, 8),
    UDim2.new(1, -24, 0, 30),
    17
)

local status = makeLabel(
    "Status",
    "Pulsa SCAN para buscar",
    UDim2.fromOffset(14, 43),
    UDim2.new(1, -28, 0, 25),
    12
)
status.TextColor3 = Color3.fromRGB(160, 195, 255)

local petImage = Instance.new("ImageLabel")
petImage.Name = "PetImage"
petImage.Position = UDim2.fromOffset(14, 75)
petImage.Size = UDim2.fromOffset(76, 76)
petImage.BackgroundColor3 = Color3.fromRGB(37, 41, 59)
petImage.BorderSizePixel = 0
petImage.ScaleType = Enum.ScaleType.Fit
petImage.Image = ""
petImage.Visible = false
petImage.Parent = frame
Instance.new("UICorner", petImage).CornerRadius = UDim.new(0, 10)

local eggInfo = makeLabel(
    "EggInfo",
    "PET: --\nDinero por segundo: --\nRareza: --\nMutaciones: --\nZona: --",
    UDim2.fromOffset(100, 72),
    UDim2.new(1, -114, 0, 112),
    12
)
eggInfo.TextXAlignment = Enum.TextXAlignment.Left
eggInfo.TextYAlignment = Enum.TextYAlignment.Top

local jobLabel = makeLabel(
    "JobIdLabel",
    "JobId actual:",
    UDim2.fromOffset(14, 178),
    UDim2.new(1, -28, 0, 18),
    11
)
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

local scanButton = makeButton(
    "ScanButton", "SCAN",
    UDim2.fromOffset(14, 238),
    UDim2.new(0.5, -20, 0, 34),
    Color3.fromRGB(45, 110, 220)
)

local joinButton = makeButton(
    "JoinButton", "JOIN JOBID",
    UDim2.new(0.5, 6, 0, 238),
    UDim2.new(0.5, -20, 0, 34),
    Color3.fromRGB(38, 151, 99)
)

local closeButton = makeButton(
    "CloseButton", "×",
    UDim2.new(1, -34, 0, 7),
    UDim2.fromOffset(25, 25),
    Color3.fromRGB(155, 55, 68)
)
closeButton.TextSize = 18

local bestFound = nil

local function scan()
    status.Text = "Escaneando este servidor..."

    local best, err = getBestEgg()
    bestFound = best

    if not best then
        eggInfo.Text = err or "No se encontró ningún huevo"
        status.Text = "Sin resultados"
        return
    end

    local idText = best.petImage
        and (best.petImage:match("%d+") or best.petImage)
        or "no encontrado"

    eggInfo.Text = "PET: " .. best.name
        .. "\nDinero por segundo: " .. formatMoney(best.moneyPerSecond)
        .. "\nRareza: " .. best.rarity
        .. "\nMutaciones: " .. best.mutations
        .. "\nZona: " .. best.area
        .. "\nImage ID: " .. idText

    petImage.Image = best.petImage or ""
    petImage.Visible = best.petImage ~= nil

    eggInfo.Position = best.petImage
        and UDim2.fromOffset(100, 72)
        or UDim2.fromOffset(14, 72)

    eggInfo.Size = best.petImage
        and UDim2.new(1, -114, 0, 112)
        or UDim2.new(1, -28, 0, 112)

    status.Text = "Mejor PET encontrado en este servidor"

    -- NUEVO: enviar el resultado a la API.
    task.spawn(sendBestReport, best)
end

scanButton.MouseButton1Click:Connect(scan)

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
        TeleportService:TeleportToPlaceInstance(
            game.PlaceId,
            targetJobId,
            LocalPlayer
        )
    end)

    if not ok then
        status.Text = "No se pudo iniciar el teleport: " .. tostring(err)
    end
end)

closeButton.MouseButton1Click:Connect(function()
    gui:Destroy()
end)

task.spawn(function()
    while gui.Parent do
        scan()
        task.wait(8)
    end
end)
