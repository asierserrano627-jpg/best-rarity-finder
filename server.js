
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const PLACE_ID = "107778070777162";
const SERVER_CACHE_TTL = 30_000;
const SERVER_COOLDOWN = 60_000;
const REPORT_TTL = 90_000;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 10;

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "100kb" }));

// Estado temporal en memoria
let cachedServers = [];
let cacheTime = 0;
let cooldownUntil = 0;
let pendingRequest = null;

const reports = new Map();
const requestCounts = new Map();

// Página principal
app.get("/", (req, res) => {
    res.json({
        ok: true,
        name: "Best Rarity Finder API",
        game: "Steal An Egg",
        placeId: PLACE_ID,
        endpoints: [
            "/api/health",
            "/api/servers",
            "/api/reports",
            "/api/top10"
        ]
    });
});

// Comprobar que la API funciona
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        name: "Best Rarity Finder API",
        game: "Steal An Egg",
        placeId: PLACE_ID
    });
});

// Obtener servidores públicos de Roblox
app.get("/api/servers", async (req, res) => {
    const now = Date.now();

    if (now - cacheTime < SERVER_CACHE_TTL) {
        res.setHeader("X-Cache", "HIT");
        return res.json({
            ok: true,
            servers: cachedServers,
            count: cachedServers.length
        });
    }

    if (now < cooldownUntil && cachedServers.length > 0) {
        res.setHeader("X-Cache", "STALE");
        return res.json({
            ok: true,
            servers: cachedServers,
            count: cachedServers.length
        });
    }

    if (pendingRequest) {
        try {
            const servers = await pendingRequest;
            return res.json({
                ok: true,
                servers,
                count: servers.length
            });
        } catch {
            return res.status(502).json({
                ok: false,
                error: "No se pudieron obtener los servidores de Roblox."
            });
        }
    }

    pendingRequest = (async () => {
        const url =
            `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100`;

        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            15_000
        );

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "BestRarityFinder/1.0"
                }
            });

            if (!response.ok) {
                throw new Error(
                    `Roblox respondió con HTTP ${response.status}`
                );
            }

            const data = await response.json();

            const servers = (data.data || []).map(server => ({
                id: server.id,
                playing: server.playing,
                maxPlayers: server.maxPlayers,
                ping: server.ping,
                fps: server.fps
            }));

            cachedServers = servers;
            cacheTime = Date.now();
            cooldownUntil = Date.now() + SERVER_COOLDOWN;

            return servers;
        } finally {
            clearTimeout(timeout);
        }
    })();

    try {
        const servers = await pendingRequest;

        res.setHeader("X-Cache", "MISS");

        return res.json({
            ok: true,
            servers,
            count: servers.length
        });
    } catch (error) {
        console.error("Error obteniendo servidores:", error.message);

        if (cachedServers.length > 0) {
            return res.json({
                ok: true,
                servers: cachedServers,
                count: cachedServers.length,
                stale: true
            });
        }

        return res.status(502).json({
            ok: false,
            error: "Roblox no está disponible temporalmente."
        });
    } finally {
        pendingRequest = null;
    }
});

// Limitar la frecuencia de envío por IP
function allowReport(req, res) {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (
        typeof forwarded === "string"
            ? forwarded.split(",")[0].trim()
            : req.socket.remoteAddress || "unknown"
    );

    const now = Date.now();
    let entry = requestCounts.get(ip);

    if (!entry || now - entry.start >= RATE_WINDOW) {
        entry = { start: now, count: 0 };
    }

    entry.count++;
    requestCounts.set(ip, entry);

    if (entry.count > RATE_LIMIT) {
        res.setHeader("Retry-After", "60");

        res.status(429).json({
            ok: false,
            error: "Demasiados informes. Inténtalo más tarde."
        });

        return false;
    }

    return true;
}

// Recibir informes enviados por el script Lua
app.post("/api/reports", (req, res) => {
    if (!allowReport(req, res)) return;

    const body = req.body || {};
    const jobId = body.jobId;
    const pets = body.pets;

    if (
        typeof jobId !== "string" ||
        jobId.length < 1 ||
        jobId.length > 128 ||
        !Array.isArray(pets) ||
        pets.length < 1 ||
        pets.length > 20
    ) {
        return res.status(400).json({
            ok: false,
            error: "Informe no válido."
        });
    }

    const cleanPets = [];

    for (const pet of pets) {
        if (!pet || typeof pet !== "object") continue;

        const name = String(pet.name || "").slice(0, 100);
        const rarity = String(pet.rarity || "Unknown").slice(0, 60);
        const mutations = String(
            pet.mutations || "Normal"
        ).slice(0, 200);

        const moneyPerSecond = Number(pet.moneyPerSecond);

        if (
            !name ||
            !Number.isFinite(moneyPerSecond) ||
            moneyPerSecond < 0 ||
            moneyPerSecond > 1e15
        ) {
            continue;
        }

        cleanPets.push({
            name,
            rarity,
            mutations,
            moneyPerSecond
        });
    }

    if (cleanPets.length === 0) {
        return res.status(400).json({
            ok: false,
            error: "No hay mascotas válidas en el informe."
        });
    }

    const now = Date.now();

    reports.set(jobId, {
        jobId,
        pets: cleanPets,
        updatedAt: now
    });

    return res.json({
        ok: true,
        message: "Informe recibido.",
        petsReceived: cleanPets.length
    });
});

// TOP 10 de mascotas reportadas recientemente
app.get("/api/top10", (req, res) => {
    const now = Date.now();

    for (const [jobId, report] of reports.entries()) {
        if (now - report.updatedAt > REPORT_TTL) {
            reports.delete(jobId);
        }
    }

    const results = [];

    for (const report of reports.values()) {
        for (const pet of report.pets) {
            results.push({
                ...pet,
                jobId: report.jobId,
                updatedAt: report.updatedAt
            });
        }
    }

    results.sort(
        (a, b) => b.moneyPerSecond - a.moneyPerSecond
    );

    res.setHeader("Cache-Control", "no-store");

    return res.json({
        ok: true,
        count: Math.min(results.length, 10),
        results: results.slice(0, 10)
    });
});

// Limpiar registros antiguos para evitar crecimiento de memoria
setInterval(() => {
    const now = Date.now();

    for (const [jobId, report] of reports.entries()) {
        if (now - report.updatedAt > REPORT_TTL) {
            reports.delete(jobId);
        }
    }

    for (const [ip, entry] of requestCounts.entries()) {
        if (now - entry.start > RATE_WINDOW * 2) {
            requestCounts.delete(ip);
        }
    }
}, 30_000).unref();

app.listen(PORT, () => {
    console.log(`Best Rarity Finder API activa en el puerto ${PORT}`);
});
