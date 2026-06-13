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
const BASE_MINUTES = Number(process.env.BASE_MINUTES || 30);   // mitad de la red, alternando
const FAST_MINUTES = Number(process.env.FAST_MINUTES || 5);    // estaciones ventosas, con viento
const WIND_TRIGGER = Number(process.env.WIND_TRIGGER || 35);   // km/h de ráfaga que activa el modo rápido
const FAST_STATIONS = Number(process.env.FAST_STATIONS || 15); // cuántas estaciones sigue en modo rápido
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";               // canal de notificaciones push (ntfy.sh)
const DISCOVERY_HOURS = Number(process.env.DISCOVERY_HOURS || 12); // re-descubrir estaciones
const MAX_STATIONS = Number(process.env.MAX_STATIONS || 40); // tope para cuidar la cuota diaria

// Límites de la zona monitoreada: regiones de Valparaíso, Metropolitana y O'Higgins
const RM_BOUNDS = { latMin: -34.95, latMax: -32.0, lonMin: -72.1, lonMax: -69.75 };

// Puntos "semilla" repartidos por las 3 regiones para descubrir estaciones cercanas
const SEED_POINTS = [
  // Región Metropolitana
  [-33.45, -70.65], // Santiago centro
  [-33.40, -70.55], // Providencia / Las Condes
  [-33.58, -70.58], // Puente Alto / La Florida
  [-33.51, -70.76], // Maipú
  [-33.20, -70.67], // Colina
  [-33.61, -70.88], // Talagante
  [-33.68, -71.21], // Melipilla
  [-33.64, -70.35], // San José de Maipo (precordillera)
  [-33.83, -70.74], // Buin / Paine
  // Región de Valparaíso
  [-33.04, -71.60], // Valparaíso / Viña del Mar
  [-32.88, -71.25], // Quillota / La Calera
  [-33.59, -71.61], // San Antonio
  [-32.83, -70.60], // Los Andes / San Felipe
  [-33.40, -71.42], // Casablanca
  // Región de O'Higgins
  [-34.17, -70.74], // Rancagua
  [-34.58, -70.99], // San Fernando
  [-34.64, -71.36], // Santa Cruz
  [-34.39, -72.00], // Pichilemu (costa)
];

// --- Estado en memoria ---
let stationIds = [];
let cache = { updatedAt: null, refreshMinutes: BASE_MINUTES, autoFast: false, stations: [] };
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
    refreshMinutes: autoFastActive() ? FAST_MINUTES : BASE_MINUTES,
    autoFast: autoFastActive(),
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

// --- Notificaciones push (ntfy.sh) ---
async function notify(title, message) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Title": title, "Priority": "high", "Tags": "warning,dash" },
      body: message,
    });
    console.log(`[notificacion] Enviada: ${message}`);
  } catch (err) {
    console.warn(`[notificacion] Falló: ${err.message}`);
  }
}

// --- Planificador adaptativo ---
// Día calmado: mitad de la red cada BASE_MINUTES (alternando mitades,
// así el mapa recibe datos frescos cada 30 min gastando la mitad).
// Con ráfagas >= WIND_TRIGGER: las FAST_STATIONS más ventosas cada FAST_MINUTES.
// Freno: si la cuota diaria va muy gastada, vuelve al modo lento.
const FAST_BUDGET_GUARD = 1300;
let lastFullRefresh = 0;
let lastFastRefresh = 0;
let halfToggle = false;
let wasFast = false;
let lastNotify = 0;

function autoFastActive() {
  const windy = cache.stations.some(s => (s.windGust ?? s.windSpeed ?? 0) >= WIND_TRIGGER);
  return windy && apiCallsToday < FAST_BUDGET_GUARD;
}

async function scheduler() {
  const now = Date.now();
  try {
    // Notificar al ENTRAR en modo rápido (máximo 1 aviso por hora)
    const active = autoFastActive();
    if (active && !wasFast && now - lastNotify > 60 * 60 * 1000) {
      const top = [...cache.stations]
        .sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))[0];
      if (top) {
        notify("Viento fuerte detectado",
          `Rafagas de ${Math.round(top.windGust ?? top.windSpeed)} km/h en ${top.name}. Seguimiento rapido activado (cada ${FAST_MINUTES} min).`);
        lastNotify = now;
      }
    }
    wasFast = active;

    if (now - lastFullRefresh >= BASE_MINUTES * 60 * 1000) {
      lastFullRefresh = now;
      // Mitades alternadas: misma cobertura, mitad del gasto
      const half = stationIds.filter((_, i) => i % 2 === (halfToggle ? 1 : 0));
      halfToggle = !halfToggle;
      console.log(`[refresco] Consultando ${half.length} estaciones (mitad ${halfToggle ? "A" : "B"}, llamadas hoy: ${apiCallsToday})`);
      const results = await fetchStations(half);
      if (results.length > 0) updateCache(results);
      return;
    }
    if (active && now - lastFastRefresh >= FAST_MINUTES * 60 * 1000) {
      lastFastRefresh = now;
      const top = [...cache.stations]
        .sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))
        .slice(0, FAST_STATIONS)
        .map(s => s.id);
      if (top.length > 0) {
        console.log(`[adaptativo] Viento detectado: consultando ${top.length} estaciones ventosas (llamadas hoy: ${apiCallsToday})`);
        const results = await fetchStations(top);
        if (results.length > 0) updateCache(results);
      }
    }
  } catch (err) {
    console.warn(`[adaptativo] Error: ${err.message}`);
  }
}


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

// ============================================================
// Campo de viento (Open-Meteo): grilla densa sobre las 3 regiones
// Sin API key y sin riesgo para la cuota de Wunderground.
// El modelo se actualiza cada ~15 min, así que refrescar cada
// 15 min entrega siempre el dato más nuevo disponible.
// ============================================================
const GRID_SPACING = 0.2; // grados (~22 km entre puntos)
const GRID_REFRESH_MINUTES = Number(process.env.GRID_REFRESH_MINUTES || 15);
let gridCache = { updatedAt: null, points: [] };

function buildGridCoords() {
  const lats = [], lons = [];
  for (let lat = RM_BOUNDS.latMin; lat <= RM_BOUNDS.latMax; lat += GRID_SPACING) {
    for (let lon = RM_BOUNDS.lonMin; lon <= RM_BOUNDS.lonMax; lon += GRID_SPACING) {
      lats.push(lat.toFixed(2));
      lons.push(lon.toFixed(2));
    }
  }
  return { lats, lons };
}

async function refreshGrid() {
  try {
    const { lats, lons } = buildGridCoords();
    const points = [];
    const CHUNK = 50; // puntos por petición (URLs más cortas y robustas)

    for (let i = 0; i < lats.length; i += CHUNK) {
      const latStr = lats.slice(i, i + CHUNK).join(",");
      const lonStr = lons.slice(i, i + CHUNK).join(",");
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latStr}&longitude=${lonStr}` +
        `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=America%2FSantiago`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      for (const p of arr) {
        if (!p.current) continue;
        points.push({
          lat: p.latitude,
          lon: p.longitude,
          windSpeed: p.current.wind_speed_10m,
          windDir: p.current.wind_direction_10m,
          windGust: p.current.wind_gusts_10m,
        });
      }
    }

    if (points.length > 0) {
      gridCache = { updatedAt: new Date().toISOString(), points };
      console.log(`[grilla] OK: ${points.length} puntos del modelo actualizados.`);
    }
  } catch (err) {
    console.warn(`[grilla] Falló la actualización: ${err.message}`);
  }
}


// --- API para el mapa ---
app.get("/api/wind", (req, res) => res.json(cache));
app.get("/api/grid", (req, res) => res.json(gridCache));
app.get("/api/health", (req, res) => res.json({ ok: true, stations: stationIds.length, gridPoints: gridCache.points.length, apiCallsToday }));
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
  lastFullRefresh = Date.now();
  await refreshObservations();
  await refreshGrid();
  setInterval(scheduler, 60 * 1000); // el planificador decide cada minuto qué consultar
  setInterval(discoverStations, DISCOVERY_HOURS * 60 * 60 * 1000);
  setInterval(refreshGrid, GRID_REFRESH_MINUTES * 60 * 1000);
});
