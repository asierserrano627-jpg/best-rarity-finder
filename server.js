
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const PLACE_ID = "107778070777162";

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Best Rarity Finder API",
    game: "Steal An Egg",
    placeId: PLACE_ID
  });
});

app.get("/api/servers", async (req, res) => {
  try {
    const params = new URLSearchParams({
      sortOrder: "Asc",
      limit: "100",
      excludeFullGames: "true"
    });

    if (req.query.cursor) {
      params.set("cursor", req.query.cursor);
    }

    const url =
      `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?${params}`;

    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Roblox no pudo devolver la lista de servidores",
        status: response.status
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: "Error al consultar los servidores de Roblox"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API iniciada en el puerto ${PORT}`);
});
