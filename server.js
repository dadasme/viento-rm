// ============================================================
// Monitor de Viento - Región Metropolitana de Santiago
// Servidor: consulta estaciones PWS de Weather Underground,
// guarda los datos en caché y los entrega al mapa.
// ============================================================

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuración ---
const API_KEY = process.env.WU_API_KEY; // Se define en Render, NUNCA en el código
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 30); // refresco de observaciones
const DISCOVERY_HOURS = Number(process.env.DISCOVERY_HOURS || 6); // re-descubrir estaciones
const MAX_STATIONS = Number(process.env.MAX_STATIONS || 30); // tope para cuidar la cuota diaria

// Límites aproximados de la Región Metropolitana (caja contenedora)
const RM_BOUNDS = { latMin: -34.35, latMax: -32.85, lonMin: -71.45, lonMax: -69.75 };

// Puntos "semilla" repartidos por la RM para descubrir estaciones cercanas
const SEED_POINTS = [
  [-33.45, -70.65], // Santiago centro
  [-33.40, -70.58], // Providencia / Ñuñoa
  [-33.36, -70.51], // Las Condes / La Reina
  [-33.58, -70.58], // Puente Alto / La Florida
  [-33.51, -70.76], // Maipú
  [-33.37, -70.73], // Quilicura / Renca
  [-33.20, -70.67], // Colina
  [-33.44, -70.54], // Peñalolén
  [-33.61, -70.88], // Talagante / Peñaflor
  [-33.68, -71.21], // Melipilla
  [-33.64, -70.35], // San José de Maipo (precordillera)
  [-33.32, -70.88], // Curacaví / Pudahuel poniente
  [-33.83, -70.74], // Buin / Paine
];

// --- Estado en memoria ---
let stationIds = [];
let cache = { updatedAt: null, refreshMinutes: REFRESH_MINUTES, stations: [] };
let apiCallsToday = 0;
let callCountDate = new Date().toDateString();

// --- Modo tormenta ---
const STORM_INTERVAL_MIN = 2;    // cada cuántos minutos consulta en modo tormenta
const STORM_STATIONS = 12;       // cuántas estaciones (las con más viento)
const STORM_DURATION_MIN = 60;   // se apaga solo después de 1 hora
const DAILY_BUDGET_GUARD = 1100; // no permite activar si ya se gastó mucho
let stormUntil = 0;              // timestamp en ms; 0 = inactivo
let stormTimer = null;

function countCall() {
  const today = new Date().toDateString();
  if (today !== callCountDate) {
    callCountDate = today;
    apiCallsToday = 0;
  }
  apiCallsToday++;
}

async function wuFetch(url) {
  countCall();
  const res = await fetch(url);
  if (res.status === 204) return null; // estación sin datos
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split("apiKey")[0]}`);
  return res.json();
}

// --- Paso 1: descubrir estaciones PWS cercanas a cada punto semilla ---
async function discoverStations() {
  console.log("[descubrimiento] Buscando estaciones PWS en la RM...");
  const found = new Map();

  for (const [lat, lon] of SEED_POINTS) {
    try {
      const url = `https://api.weather.com/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${API_KEY}`;
      const data = await wuFetch(url);
      const loc = data && data.location;
      if (!loc || !loc.stationId) continue;

      for (let i = 0; i < loc.stationId.length; i++) {
        const sLat = loc.latitude[i];
        const sLon = loc.longitude[i];
        const inRM =
          sLat >= RM_BOUNDS.latMin && sLat <= RM_BOUNDS.latMax &&
          sLon >= RM_BOUNDS.lonMin && sLon <= RM_BOUNDS.lonMax;
        if (inRM) found.set(loc.stationId[i], true);
      }
    } catch (err) {
      console.warn(`[descubrimiento] Falló punto ${lat},${lon}: ${err.message}`);
    }
  }

  if (found.size > 0) {
    stationIds = [...found.keys()].slice(0, MAX_STATIONS);
    console.log(`[descubrimiento] ${stationIds.length} estaciones seleccionadas (de ${found.size} encontradas).`);
  } else {
    console.warn("[descubrimiento] No se encontraron estaciones; se mantiene la lista anterior.");
  }
}

// --- Paso 2: leer las condiciones actuales de una lista de estaciones ---
async function fetchStations(ids) {
  const results = [];
  for (const id of ids) {
    try {
      const url = `https://api.weather.com/v2/pws/observations/current?stationId=${id}&format=json&units=m&apiKey=${API_KEY}`;
      const data = await wuFetch(url);
      const obs = data && data.observations && data.observations[0];
      if (!obs) continue;

      results.push({
        id: obs.stationID,
        name: obs.neighborhood || obs.stationID,
        lat: obs.lat,
        lon: obs.lon,
        windDir: obs.winddir,                          // grados desde donde SOPLA el viento
        windSpeed: obs.metric ? obs.metric.windSpeed : null, // km/h
        windGust: obs.metric ? obs.metric.windGust : null,   // km/h
        temp: obs.metric ? obs.metric.temp : null,
        pressure: obs.metric ? obs.metric.pressure : null,       // hPa
        precipRate: obs.metric ? obs.metric.precipRate : null,   // mm/h
        precipTotal: obs.metric ? obs.metric.precipTotal : null, // mm acumulados hoy
        humidity: obs.humidity,
        obsTimeLocal: obs.obsTimeLocal,
        epoch: obs.epoch,
      });
    } catch (err) {
      console.warn(`[consulta] Estación ${id} falló: ${err.message}`);
    }
  }
  return results;
}

function updateCache(newStations) {
  // Mezcla: reemplaza las estaciones actualizadas, conserva el resto
  const byId = new Map(cache.stations.map(s => [s.id, s]));
  newStations.forEach(s => byId.set(s.id, s));
  cache = {
    updatedAt: new Date().toISOString(),
    refreshMinutes: REFRESH_MINUTES,
    apiCallsToday,
    stormUntil: stormUntil > Date.now() ? stormUntil : 0,
    stations: [...byId.values()],
  };
}

async function refreshObservations() {
  if (stationIds.length === 0) {
    console.warn("[refresco] Sin estaciones para consultar.");
    return;
  }
  console.log(`[refresco] Consultando ${stationIds.length} estaciones... (llamadas hoy: ${apiCallsToday})`);
  const results = await fetchStations(stationIds);
  if (results.length > 0) {
    updateCache(results);
    console.log(`[refresco] OK: ${results.length} estaciones con datos.`);
  } else {
    console.warn("[refresco] Ninguna estación entregó datos; se mantiene el caché anterior.");
  }
}

// --- Modo tormenta: consulta rápida de las estaciones con más viento ---
async function stormTick() {
  if (Date.now() > stormUntil) {
    clearInterval(stormTimer);
    stormTimer = null;
    stormUntil = 0;
    console.log("[tormenta] Modo tormenta finalizado.");
    return;
  }
  // Las N estaciones con mayor viento/ráfaga conocida
  const top = [...cache.stations]
    .sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))
    .slice(0, STORM_STATIONS)
    .map(s => s.id);
  if (top.length === 0) return;
  console.log(`[tormenta] Consultando ${top.length} estaciones prioritarias...`);
  const results = await fetchStations(top);
  if (results.length > 0) updateCache(results);
}

const app_storm_routes = (app) => {
  app.get("/api/storm/start", (req, res) => {
    if (apiCallsToday > DAILY_BUDGET_GUARD) {
      return res.json({ ok: false, reason: "Cuota diaria casi agotada; inténtalo mañana." });
    }
    stormUntil = Date.now() + STORM_DURATION_MIN * 60 * 1000;
    if (!stormTimer) {
      stormTimer = setInterval(stormTick, STORM_INTERVAL_MIN * 60 * 1000);
      stormTick(); // primera consulta inmediata
    }
    console.log("[tormenta] Modo tormenta ACTIVADO por 60 minutos.");
    res.json({ ok: true, stormUntil });
  });
};

// --- API para el mapa ---
app.get("/api/wind", (req, res) => res.json(cache));
app.get("/api/health", (req, res) => res.json({ ok: true, stations: stationIds.length, apiCallsToday }));
app_storm_routes(app);

// Frontend estático
app.use(express.static(path.join(__dirname, "public")));

// --- Arranque ---
app.listen(PORT, async () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  if (!API_KEY) {
    console.error("FALTA la variable de entorno WU_API_KEY. Configúrala en Render.");
    return;
  }
  await discoverStations();
  await refreshObservations();
  setInterval(refreshObservations, REFRESH_MINUTES * 60 * 1000);
  setInterval(discoverStations, DISCOVERY_HOURS * 60 * 60 * 1000);
});
