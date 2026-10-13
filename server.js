
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const PLACE_ID = "107778070777162";

const CACHE_TTL = 30_000;
const REPORT_TTL = 90_000;
const DEFAULT_COOLDOWN = 60_000;
const REPORT_RATE_LIMIT = 10;
const REPORT_RATE_WINDOW = 60_000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Report-Key"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

let cachedServers = null;
let cacheTime = 0;
let cooldownUntil = 0;
let pendingRequest = null;

const reports = new Map();
const reportRequests = new Map();

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Best Rarity Finder API",
    game: "Steal An Egg",
    placeId: PLACE_ID
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Best Rarity Finder API",
    game: "Steal An Egg",
    placeId: PLACE_ID
  });
});

// Servidores públicos de Roblox.
app.get("/api/servers", async (req, res) => {
  const cursor = String(req.query.cursor || "");
  const now = Date.now();

  if (!cursor && cachedServers && now - cacheTime < CACHE_TTL) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cachedServers);
  }

  if (now < cooldownUntil) {
    if (!cursor && cachedServers) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cachedServers);
    }

    res.setHeader(
      "Retry-After",
      String(Math.ceil((cooldownUntil - now) / 1000))
    );

    return res.status(429).json({
      error: "Roblox está limitando las peticiones.",
      retryAfterSeconds: Math.ceil((cooldownUntil - now) / 1000)
    });
  }

  if (!pendingRequest) {
    pendingRequest = (async () => {
      const params = new URLSearchParams({
        sortOrder: "Asc",
        limit: "100",
        excludeFullGames: "true"
      });

      if (cursor) params.set("cursor", cursor);

      const response = await fetch(
        `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?${params}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15000)
        }
      );

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After"));

        cooldownUntil = Date.now() + Math.max(
          DEFAULT_COOLDOWN,
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : DEFAULT_COOLDOWN
        );

        return { limited: true };
      }

      if (!response.ok) {
        return { error: true, status: response.status };
      }

      const data = await response.json();

      if (!cursor) {
        cachedServers = data;
        cacheTime = Date.now();
      }

      cooldownUntil = 0;
      return { data };
    })().finally(() => {
      pendingRequest = null;
    });
  }

  try {
    const result = await pendingRequest;

    if (result.limited) {
      return res.status(429).json({
        error: "Roblox está limitando las peticiones.",
        retryAfterSeconds: Math.ceil(
          Math.max(0, cooldownUntil - Date.now()) / 1000
        )
      });
    }

    if (result.error) {
      return res.status(502).json({
        error: "Roblox no pudo devolver los servidores.",
        status: result.status
      });
    }

    res.setHeader("X-Cache", "MISS");
    return res.json(result.data);
  } catch {
    return res.status(502).json({
      error: "Error al consultar los servidores de Roblox."
    });
  }
});

// Recibir reportes autenticados.
app.post("/api/reports", (req, res) => {
  const secret = process.env.REPORT_API_KEY;

  if (!secret) {
    return res.status(503).json({
      error: "Falta configurar REPORT_API_KEY en Render."
    });
  }

  if (req.get("X-Report-Key") !== secret) {
    return res.status(401).json({ error: "Clave no válida." });
  }

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let rate = reportRequests.get(ip);

  if (!rate || now - rate.startedAt >= REPORT_RATE_WINDOW) {
    rate = { startedAt: now, count: 0 };
    reportRequests.set(ip, rate);
  }

  rate.count++;

  if (rate.count > REPORT_RATE_LIMIT) {
    return res.status(429).json({
      error: "Demasiados reportes. Espera un minuto."
    });
  }

  const body = req.body;

  if (
    !body ||
    typeof body.jobId !== "string" ||
    body.jobId.length < 1 ||
    body.jobId.length > 100 ||
    !Array.isArray(body.pets) ||
    body.pets.length > 100
  ) {
    return res.status(400).json({
      error: "Se necesita un jobId y una lista pets válida."
    });
  }

  const pets = [];

  for (const pet of body.pets) {
    if (
      !pet ||
      typeof pet.name !== "string" ||
      pet.name.trim().length < 1 ||
      pet.name.length > 100 ||
      typeof pet.moneyPerSecond !== "number" ||
      !Number.isFinite(pet.moneyPerSecond) ||
      pet.moneyPerSecond < 0 ||
      pet.moneyPerSecond > 1e15
    ) {
      return res.status(400).json({
        error: "Hay datos de mascota no válidos."
      });
    }

    pets.push({
      name: pet.name.trim(),
      moneyPerSecond: pet.moneyPerSecond,
      rarity: typeof pet.rarity === "string"
        ? pet.rarity.slice(0, 50)
        : "Unknown",
      mutations: typeof pet.mutations === "string"
        ? pet.mutations.slice(0, 200)
        : "Normal"
    });
  }

  reports.set(body.jobId, {
    jobId: body.jobId,
    placeId: PLACE_ID,
    updatedAt: now,
    pets
  });

  res.setHeader("Cache-Control", "no-store");

  return res.json({
    ok: true,
    received: pets.length,
    jobId: body.jobId
  });
});

// TOP 10 de reportes recientes.
app.get("/api/top10", (req, res) => {
  const now = Date.now();
  const results = [];

  for (const [jobId, report] of reports) {
    if (now - report.updatedAt > REPORT_TTL) {
      reports.delete(jobId);
      continue;
    }

    for (const pet of report.pets) {
      results.push({
        ...pet,
        jobId,
        placeId: PLACE_ID,
        updatedAt: report.updatedAt
      });
    }
  }

  results.sort((a, b) => b.moneyPerSecond - a.moneyPerSecond);

  res.setHeader("Cache-Control", "no-store");

  return res.json({
    ok: true,
    updatedAt: now,
    serversReporting: reports.size,
    count: Math.min(10, results.length),
    results: results.slice(0, 10)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Best Rarity Finder API activa en el puerto ${PORT}`);
});
