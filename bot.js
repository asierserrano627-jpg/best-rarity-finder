const API_URL = (
  process.env.API_BASE_URL ||
  "https://best-rarity-finder.onrender.com"
).replace(/\/+$/, "");

const INTERVAL = 60_000;

async function checkAPI() {
  console.log("\n[" + new Date().toISOString() + "] Comprobando API...");

  try {
    const healthResponse = await fetch(
      `${API_URL}/api/health`,
      { signal: AbortSignal.timeout(20000) }
    );

    if (!healthResponse.ok) {
      throw new Error(`Health HTTP ${healthResponse.status}`);
    }

    console.log("API:", await healthResponse.json());

    const topResponse = await fetch(
      `${API_URL}/api/top10`,
      { signal: AbortSignal.timeout(20000) }
    );

    if (!topResponse.ok) {
      throw new Error(`TOP 10 HTTP ${topResponse.status}`);
    }

    const data = await topResponse.json();

    console.log("Mascotas registradas:", data.count ?? 0);

    for (const pet of data.results ?? []) {
      console.log(
        `${pet.name} | ${pet.rarity} | ${pet.moneyPerSecond}/s`
      );
    }

    console.log("Comprobación completada.");
  } catch (error) {
    console.error("Error:", error.message);
  }
}

console.log("BEST RARITY FINDER BOT iniciado.");
checkAPI();
setInterval(checkAPI, INTERVAL);
