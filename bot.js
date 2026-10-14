
const API_URL = (
  process.env.API_BASE_URL ||
  "https://best-rarity-finder.onrender.com"
).replace(/\/+$/, "");

const INTERVAL = 60_000;

async function checkAPI() {
  try {
    const response = await fetch(`${API_URL}/api/health`, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const health = await response.json();
    console.log(
      `[${new Date().toISOString()}] API OK`,
      health
    );

    // Comprueba también el TOP 10.
    const topResponse = await fetch(`${API_URL}/api/top10`, {
      signal: AbortSignal.timeout(15000)
    });

    if (!topResponse.ok) {
      throw new Error(`TOP 10: HTTP ${topResponse.status}`);
    }

    console.log("TOP 10 accesible correctamente.");
  } catch (error) {
    console.error("Error comprobando la API:", error.message);
  }
}

console.log("BEST RARITY FINDER BOT iniciado.");

async function loop() {
  await checkAPI();
  setTimeout(loop, INTERVAL);
}

loop();
