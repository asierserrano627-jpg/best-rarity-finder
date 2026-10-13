
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const PLACE_ID = "107778070777162";

const CACHE_TTL = 30 * 1000;
const DEFAULT_COOLDOWN = 60 * 1000;

let cachedServers = null;
let cacheTime = 0;
let cooldownUntil = 0;
let pendingRequest = null;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

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

app.get("/api/servers", async (req, res) => {
  const now = Date.now();

  // Devuelve la caché reciente sin consultar Roblox.
  if (cachedServers && now - cacheTime < CACHE_TTL) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cachedServers);
  }

  // Si Roblox ha limitado las peticiones, usa datos anteriores.
  if (now < cooldownUntil) {
    if (cachedServers) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cachedServers);
    }

    res.setHeader(
      "Retry-After",
      String(Math.ceil((cooldownUntil - now) / 1000))
    );

    return res.status(429).json({
      error: "Roblox está limitando las peticiones.",
      retryAfterSeconds: Math.ceil(
        (cooldownUntil - now) / 1000
      )
    });
  }

  // Evita varias peticiones simultáneas a Roblox.
  if (!pendingRequest) {
    pendingRequest = (async () => {
      const params = new URLSearchParams({
        sortOrder: "Asc",
        limit: "100",
        excludeFullGames: "true"
      });

      if (req.query.cursor) {
        params.set("cursor", String(req.query.cursor));
      }

      const url =
        `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?${params}`;

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Best-Rarity-Finder/1.0"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (response.status === 429) {
        const retryAfter = Number(
          response.headers.get("Retry-After")
        );

        const cooldown = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(DEFAULT_COOLDOWN, retryAfter * 1000)
          : DEFAULT_COOLDOWN;

        cooldownUntil = Date.now() + cooldown;

        return {
          limited: true,
          status: 429
        };
      }

      if (!response.ok) {
        return {
          error: true,
          status: response.status
        };
      }

      const data = await response.json();

      cachedServers = data;
      cacheTime = Date.now();
      cooldownUntil = 0;

      return {
        data
      };
    })().finally(() => {
      pendingRequest = null;
    });
  }

  try {
    const result = await pendingRequest;

    if (result.limited) {
      if (cachedServers) {
        res.setHeader("X-Cache", "STALE");
        return res.json(cachedServers);
      }

      res.setHeader(
        "Retry-After",
        String(Math.ceil((cooldownUntil - Date.now()) / 1000))
      );

      return res.status(429).json({
        error: "Roblox está limitando las peticiones.",
        retryAfterSeconds: Math.ceil(
          (cooldownUntil - Date.now()) / 1000
        )
      });
    }

    if (result.error) {
      if (cachedServers) {
        res.setHeader("X-Cache", "STALE");
        return res.json(cachedServers);
      }

      return res.status(502).json({
        error: "Roblox no pudo devolver la lista de servidores.",
        status: result.status
      });
    }

    res.setHeader("X-Cache", "MISS");
    return res.json(result.data);
  } catch (error) {
    if (cachedServers) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cachedServers);
    }

    return res.status(502).json({
      error: "Error al consultar los servidores de Roblox."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Best Rarity Finder API activa en el puerto ${PORT}`);
});
