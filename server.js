const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const PLACE_ID = "107778070777162";
const SERVER_CACHE_TTL = 30_000;
const SERVER_COOLDOWN = 60_000;
const REPORT_TTL = 15 * 60_000; // antes 90 s: ahora el TOP 10 abarca varios servidores
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 10; // informes por IP / minuto (igual que antes)
const NEXT_LIMIT = 30; // peticiones de next-server por IP / minuto
const FAILED_LIMIT = 30; // avisos de fallo por IP / minuto

// --- Ajustes nuevos ---
const MAX_PAGES = Number(process.env.MAX_PAGES) || 3; // páginas de 100 servidores
const MIN_FREE_SLOTS = 2; // no ofrecer servidores casi llenos
const ASSIGN_TTL = 2 * 60_000; // un servidor asignado no se ofrece a otro cliente
const VISIT_COOLDOWN = REPORT_TTL; // no repetir un servidor ya escaneado
const FAILED_COOLDOWN = 5 * 60_000; // no repetir un servidor que falló
const JOB_MIN_INTERVAL = 10_000; // mínimo entre informes del mismo servidor
const MAX_REPORTS = 2000;
const STRICT_JOBID = process.env.STRICT_JOBID !== "false"; // rechazar JobIds desconocidos
const IP_SALT = process.env.IP_SALT || "brf-salt";

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
let failUntil = 0;
let pendingRequest = null;

const reports = new Map(); // jobId -> informe
const requestCounts = new Map(); // "bucket:ip" -> contador
const assigned = new Map(); // jobId -> momento de asignación
const visited = new Map(); // jobId -> { at, ok }

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
            "/api/next-server",
            "/api/failed",
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

// ---------- Servidores públicos de Roblox ----------

async function fetchServersFromRoblox() {
    const all = [];
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        let url =
            `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "BestRarityFinder/1.0"
                }
            });

            if (!response.ok) {
                throw new Error(`Roblox respondió con HTTP ${response.status}`);
            }

            const data = await response.json();

            for (const server of data.data || []) {
                all.push({
                    id: server.id,
                    playing: server.playing,
                    maxPlayers: server.maxPlayers,
                    ping: server.ping,
                    fps: server.fps
                });
            }

            cursor = data.nextPageCursor || null;
        } catch (error) {
            // Si ya tenemos algo de páginas anteriores, nos quedamos con eso
            if (all.length > 0) break;
            throw error;
        } finally {
            clearTimeout(timeout);
        }

        if (!cursor) break;
        await new Promise(r => setTimeout(r, 400)); // respetar el límite de Roblox
    }

    cachedServers = all;
    cacheTime = Date.now();
    cooldownUntil = Date.now() + SERVER_COOLDOWN;
    return all;
}

// Devuelve servidores con caché, cooldown y petición compartida
async function getServers() {
    const now = Date.now();

    if (now - cacheTime < SERVER_CACHE_TTL) {
        return { servers: cachedServers, cache: "HIT" };
    }

    if (now < cooldownUntil && cachedServers.length > 0) {
        return { servers: cachedServers, cache: "STALE" };
    }

    if (now < failUntil && cachedServers.length === 0) {
        throw new Error("Roblox en pausa tras un error reciente.");
    }

    if (pendingRequest) {
        return { servers: await pendingRequest, cache: "SHARED" };
    }

    pendingRequest = fetchServersFromRoblox();

    try {
        const servers = await pendingRequest;
        return { servers, cache: "MISS" };
    } catch (error) {
        failUntil = Date.now() + 15_000;
        throw error;
    } finally {
        pendingRequest = null;
    }
}

// Obtener servidores públicos de Roblox (mismo formato de respuesta que antes)
app.get("/api/servers", async (req, res) => {
    try {
        const { servers, cache } = await getServers();
        res.setHeader("X-Cache", cache);

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
    }
});

// ---------- Utilidades ----------

function getIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    return typeof forwarded === "string"
        ? forwarded.split(",")[0].trim()
        : req.socket.remoteAddress || "unknown";
}

function ipHash(req) {
    return crypto
        .createHash("sha256")
        .update(getIp(req) + IP_SALT)
        .digest("hex")
        .slice(0, 12);
}

// Limitar la frecuencia por IP y por tipo de petición
function rateLimit(req, res, bucket, limit) {
    const key = `${bucket}:${getIp(req)}`;
    const now = Date.now();
    let entry = requestCounts.get(key);

    if (!entry || now - entry.start >= RATE_WINDOW) {
        entry = { start: now, count: 0 };
    }

    entry.count++;
    requestCounts.set(key, entry);

    if (entry.count > limit) {
        res.setHeader("Retry-After", "60");

        res.status(429).json({
            ok: false,
            error: "Demasiadas peticiones. Inténtalo más tarde."
        });

        return false;
    }

    return true;
}

function isCoolingDown(id, now) {
    const a = assigned.get(id);
    if (a && now - a < ASSIGN_TTL) return true;

    const v = visited.get(id);
    if (v) {
        const limit = v.ok ? VISIT_COOLDOWN : FAILED_COOLDOWN;
        if (now - v.at < limit) return true;
    }

    return false;
}

function coverage() {
    const now = Date.now();
    let scanned = 0;

    for (const v of visited.values()) {
        if (v.ok && now - v.at < REPORT_TTL) scanned++;
    }

    return {
        serversKnown: cachedServers.length,
        serversScanned: scanned,
        windowSeconds: REPORT_TTL / 1000
    };
}

// ---------- Reparto de servidores a los clientes ----------

// El cliente Lua pide aquí el siguiente servidor al que ir
app.get("/api/next-server", async (req, res) => {
    if (!rateLimit(req, res, "next", NEXT_LIMIT)) return;

    const current = String(req.query.current || "").slice(0, 128);

    let servers;
    try {
        ({ servers } = await getServers());
    } catch {
        return res.status(502).json({
            ok: false,
            error: "Roblox no está disponible temporalmente."
        });
    }

    const now = Date.now();

    const candidates = servers.filter(s =>
        s.id &&
        s.id !== current &&
        (Number(s.maxPlayers) || 0) - (Number(s.playing) || 0) >= MIN_FREE_SLOTS &&
        !isCoolingDown(s.id, now)
    );

    res.setHeader("Cache-Control", "no-store");

    if (candidates.length === 0) {
        return res.json({
            ok: true,
            jobId: null,
            retryAfter: 30,
            coverage: coverage()
        });
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    assigned.set(pick.id, now);

    return res.json({
        ok: true,
        jobId: pick.id,
        placeId: PLACE_ID,
        playing: pick.playing,
        maxPlayers: pick.maxPlayers,
        coverage: coverage()
    });
});

// El cliente avisa de que no pudo entrar en un servidor asignado
app.post("/api/failed", (req, res) => {
    if (!rateLimit(req, res, "failed", FAILED_LIMIT)) return;

    const jobId = (req.body || {}).jobId;

    if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > 128) {
        return res.status(400).json({ ok: false, error: "JobId no válido." });
    }

    // Solo se pueden marcar servidores que el backend asignó antes
    if (!assigned.has(jobId)) {
        return res.json({ ok: true, ignored: true });
    }

    assigned.delete(jobId);
    visited.set(jobId, { at: Date.now(), ok: false });

    return res.json({ ok: true });
});

// ---------- Informes ----------

// Recibir informes enviados por el script Lua
app.post("/api/reports", async (req, res) => {
    if (!rateLimit(req, res, "report", RATE_LIMIT)) return;

    const body = req.body || {};
    const jobId = body.jobId;
    const pets = body.pets;

    // pets puede ser [] para indicar "servidor escaneado, sin animales"
    if (
        typeof jobId !== "string" ||
        jobId.length < 1 ||
        jobId.length > 128 ||
        !Array.isArray(pets) ||
        pets.length > 20
    ) {
        return res.status(400).json({
            ok: false,
            error: "Informe no válido."
        });
    }

    // El JobId debe ser un servidor real (de la lista de Roblox o asignado por nosotros)
    let known = assigned.has(jobId) || visited.has(jobId);

    if (!known) {
        try {
            const { servers } = await getServers();
            known = servers.some(s => s.id === jobId);
        } catch {
            known = cachedServers.some(s => s.id === jobId);
        }
    }

    if (!known && STRICT_JOBID) {
        return res.status(400).json({
            ok: false,
            error: "Servidor desconocido."
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

    const now = Date.now();

    // Servidor escaneado sin animales: se marca como visitado y no se guarda informe
    if (pets.length === 0) {
        assigned.delete(jobId);
        visited.set(jobId, { at: now, ok: true });
        reports.delete(jobId);
        return res.json({ ok: true, message: "Servidor registrado sin animales.", petsReceived: 0 });
    }

    if (cleanPets.length === 0) {
        return res.status(400).json({
            ok: false,
            error: "No hay mascotas válidas en el informe."
        });
    }

    const hash = crypto
        .createHash("sha1")
        .update(JSON.stringify(cleanPets))
        .digest("hex");

    const reporter = ipHash(req);
    const existing = reports.get(jobId);

    assigned.delete(jobId);
    visited.set(jobId, { at: now, ok: true });

    // Mismo contenido: solo se refresca y se anota el informante (sirve para verificar)
    if (existing && existing.hash === hash) {
        existing.reporters.add(reporter);
        existing.updatedAt = now;
        return res.json({
            ok: true,
            message: "Informe sin cambios.",
            unchanged: true,
            petsReceived: cleanPets.length
        });
    }

    // Contenido distinto en menos de 10 s: se ignora para evitar spam
    if (existing && now - existing.updatedAt < JOB_MIN_INTERVAL) {
        return res.json({ ok: true, throttled: true });
    }

    if (!existing && reports.size >= MAX_REPORTS) {
        const oldest = reports.keys().next().value;
        reports.delete(oldest);
    }

    reports.set(jobId, {
        jobId,
        pets: cleanPets,
        hash,
        reporters: new Set([reporter]),
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
                updatedAt: report.updatedAt,
                verified: report.reporters.size >= 2
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
        results: results.slice(0, 10),
        coverage: coverage(),
        ttlSeconds: REPORT_TTL / 1000
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

    for (const [key, entry] of requestCounts.entries()) {
        if (now - entry.start > RATE_WINDOW * 2) {
            requestCounts.delete(key);
        }
    }

    for (const [jobId, at] of assigned.entries()) {
        if (now - at > ASSIGN_TTL) assigned.delete(jobId);
    }

    for (const [jobId, v] of visited.entries()) {
        if (now - v.at > VISIT_COOLDOWN) visited.delete(jobId);
    }
}, 30_000).unref();

app.listen(PORT, () => {
    console.log(`Best Rarity Finder API activa en el puerto ${PORT}`);
});
