import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tork-proxy' }));

// ── Google Places Autocomplete ────────────────────────────────────────────────
app.get('/autocomplete', async (req, res) => {
  const { input, sessiontoken } = req.query;
  if (!input) return res.status(400).json({ error: 'input required' });
  try {
    const params = new URLSearchParams({
      input, key: GOOGLE_API_KEY, types: 'geocode',
      ...(sessiontoken && { sessiontoken }),
    });
    const r = await fetch('https://maps.googleapis.com/maps/api/place/autocomplete/json?' + params);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: 'Autocomplete failed' });
  }
});

// ── Reverse geocode (coords → suburb name) ────────────────────────────────────
app.get('/reverse-geocode', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });
  if (!GOOGLE_API_KEY) return res.json({ name: '' });
  try {
    const p = new URLSearchParams({ latlng: lat + ',' + lng, key: GOOGLE_API_KEY });
    const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + p);
    const d = await r.json();
    const result = d.results?.[0];
    // Prefer suburb/locality over full formatted address
    const local = result?.address_components?.find(c =>
      c.types.includes('locality') || c.types.includes('sublocality_level_1')
    );
    const name = local?.long_name || result?.formatted_address || '';
    res.json({ name });
  } catch {
    res.status(500).json({ error: 'Reverse geocode failed' });
  }
});

// ── Geocode helper (returns lat/lng + country/state for geographic grounding) ──
async function geocode(location) {
  if (!GOOGLE_API_KEY) return null;
  try {
    const p = new URLSearchParams({ address: location, key: GOOGLE_API_KEY });
    const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + p);
    const d = await r.json();
    const result = d.results?.[0];
    const loc = result?.geometry?.location;
    if (!loc) return null;
    const comps = result?.address_components || [];
    const country = comps.find(c => c.types.includes('country'))?.long_name;
    const state   = comps.find(c => c.types.includes('administrative_area_level_1'))?.long_name;
    return { lat: loc.lat, lng: loc.lng, country, state };
  } catch { return null; }
}

// ── Haversine distance (km) between two lat/lng points ────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Geocode a waypoint and check it's plausibly close to the origin ───────────
async function validateWaypoint(name, originLat, originLng, maxKm) {
  try {
    const result = await geocode(name);
    if (!result) return true; // can't validate → leave it in
    const dist = haversineKm(originLat, originLng, result.lat, result.lng);
    return dist <= maxKm;
  } catch { return true; }
}

// ── Estimate max reasonable radius (km) from drive duration string ─────────────
function maxRadiusKm(duration) {
  const d = (duration || '').toLowerCase();
  if (d.includes('all day') || d.includes('full day')) return 400;
  if (d.includes('half') || d.includes('½')) return 280;
  const hrs = parseFloat(d.match(/[\d.]+/)?.[0] || 0);
  if (!hrs) return 250;
  return Math.max(80, Math.min(400, hrs * 75)); // ~75 km/h average radius
}

// ── Weather helper (Open-Meteo, no key required) ──────────────────────────────
const WX = {
  0: 'Clear skies', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Heavy showers', 82: 'Violent rain',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm'
};

async function getWeather(lat, lng, dayOffset = 0) {
  try {
    const forecastDays = Math.max(7, dayOffset + 2);
    const p = new URLSearchParams({
      latitude: lat, longitude: lng,
      current: 'temperature_2m,weathercode,windspeed_10m,precipitation',
      daily: 'weathercode,temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,windspeed_10m_max',
      forecast_days: forecastDays, timezone: 'auto'
    });
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + p);
    const d = await r.json();

    let summary, temp, wind, weathercode, snow, precip;

    if (dayOffset === 0) {
      // Use live current conditions
      const c = d.current;
      weathercode = c.weathercode;
      temp  = Math.round(c.temperature_2m);
      wind  = Math.round(c.windspeed_10m);
      snow  = d.daily?.snowfall_sum?.[0]  || 0;
      precip = d.daily?.precipitation_sum?.[0] || 0;
      summary = (WX[weathercode] || 'Variable') + ', ' + temp + '°C';
      if (wind  > 35) summary += ', strong winds ' + wind + 'km/h';
      if (precip > 5) summary += ', ' + precip.toFixed(0) + 'mm rain today';
      if (snow   > 0) summary += ', ' + snow.toFixed(1) + 'cm snow today';
    } else {
      // Use daily forecast for the target day
      const i = dayOffset;
      weathercode = d.daily?.weathercode?.[i];
      const tMax = Math.round(d.daily?.temperature_2m_max?.[i] || 0);
      const tMin = Math.round(d.daily?.temperature_2m_min?.[i] || 0);
      wind  = Math.round(d.daily?.windspeed_10m_max?.[i] || 0);
      snow  = d.daily?.snowfall_sum?.[i]  || 0;
      precip = d.daily?.precipitation_sum?.[i] || 0;
      temp  = tMax;
      summary = (WX[weathercode] || 'Variable') + ', ' + tMin + '–' + tMax + '°C';
      if (wind  > 35) summary += ', strong winds ' + wind + 'km/h';
      if (precip > 5) summary += ', ' + precip.toFixed(0) + 'mm rain forecast';
      if (snow   > 0) summary += ', ' + snow.toFixed(1) + 'cm snow forecast';
    }

    return { summary, temp, wind, weathercode, snow, precip };
  } catch { return null; }
}

// ── Suggest routes ────────────────────────────────────────────────────────────
app.post('/suggest', async (req, res) => {
  const { location, duration, vibes, vehicle, when, time_of_day, dayOffset, userLat, userLng, routeType, destination, worthyStops } = req.body;
  if (!location || !duration) return res.status(400).json({ error: 'location and duration required' });

  const dayOffsetNum = Math.max(0, parseInt(dayOffset) || 0);

  // Use GPS coords from client if available (skips geocoding, more accurate)
  const coords = (userLat && userLng)
    ? { lat: parseFloat(userLat), lng: parseFloat(userLng) }
    : await geocode(location);
  const weather = coords ? await getWeather(coords.lat, coords.lng, dayOffsetNum) : null;

  const vibesText = vibes && vibes.length
    ? `Driver is looking for: ${vibes.join(', ')}.`
    : 'No specific vibe preference — surprise them.';

  const weatherLabel = dayOffsetNum === 0 ? 'Current weather at start'
    : dayOffsetNum === 1 ? 'Tomorrow\'s forecast at start'
    : 'Forecast for driving day at start';

  // Geographic grounding — prevents Claude hallucinating overseas waypoints
  const geoConstraint = coords
    ? `GEOGRAPHIC CONSTRAINT (critical): Origin is at coordinates (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})` +
      (coords.country ? `, in ${coords.state ? coords.state + ', ' : ''}${coords.country}` : '') +
      `. Every single waypoint must be a real place within driving distance of this origin, in the same country. ` +
      `Do not suggest places on a different continent or in a different country. ` +
      `A waypoint with coordinates more than ${maxRadiusKm(duration)} km from the origin is invalid.`
    : '';

  const vehicleInstruction = vehicle
    ? `VEHICLE CONSTRAINT (non-negotiable): ${vehicle}`
    : 'Vehicle: standard road car. Sealed roads only. Moderate road character.';

  const routeTypeInstruction = routeType === 'point-to-point'
    ? `Route shape: User wants POINT-TO-POINT routes from their start location TO "${destination || 'their chosen destination'}". ` +
      `Do NOT plan the boring direct route — instead, plan an interesting, winding journey that arrives at the destination by exploring characterful roads along the way. ` +
      `The final waypoint in the waypoints array MUST be (or very close to) "${destination || 'the destination'}". Set "loop": false for ALL routes.`
    : 'Route shape: User wants LOOP routes — depart and return to roughly the same area via a different road. Set "loop": true for ALL routes.';

  const stopsInstruction = worthyStops && worthyStops.length
    ? `Worthy stops: Along each route, identify up to 2 genuinely exceptional stops in these categories if they exist on or very near the route: ${worthyStops.join('; ')}. Apply Michelin-standard curation — only recommend stops that are truly worth a detour. Real places only. If no genuinely worthy stop exists for a route, leave the stops array empty rather than fabricating one.`
    : '';

  const contextLines = [
    vehicle     ? `Vehicle: ${vehicle}.`         : '',
    when        ? `Driving: ${when}.`            : '',
    time_of_day ? `Time of day: ${time_of_day}.` : '',
    weather     ? `${weatherLabel}: ${weather.summary}.` : '',
  ].filter(Boolean).join(' ');

  const systemPrompt = `You are TorK — a route advisor for the driving enthusiast. You know roads the way a car journalist does: the B-roads, the passes, the coastal cliff runs, the river valleys, the forest stretches that GPS ignores.

Given a starting location and a desired drive duration, you suggest 3 driving routes. These are NOT navigation routes — they are curated driving experiences chosen for character, not efficiency.

You favour: mountain passes, coastal roads, river valleys, winding B-roads, elevated moorland, estuaries, forest drives, roads with elevation change and committed corners. You avoid: motorways, ring roads, urban crawls, industrial zones.

${geoConstraint}

${vehicleInstruction}

${routeTypeInstruction}

Factor in the following when choosing and describing routes:
- Weather: warn of ice, snow, fog, high winds — be specific (e.g. "snow likely above 900m today")
- Time of day: note golden hour windows, early-morning empty roads, afternoon tourist traffic on popular routes
- Day type: avoid crowded weekend honeypots; flag known festival/event congestion; note quieter weekday alternatives

${stopsInstruction}

Each route must include a realistic list of waypoints — named towns, villages, roads, passes, or landmarks — in driving order. These will be used to construct a Google Maps directions link, so they must be real, locatable places.

You always return exactly 3 routes as valid JSON. Never include any text outside the JSON block.

Return this exact shape:
{
  "weather_summary": "One line describing current conditions relevant to driving, or null if no weather data",
  "routes": [
    {
      "title": "Evocative route name",
      "recommended": true,
      "duration": "e.g. 2 hr 45 min",
      "distance": "e.g. 145 km",
      "tork_take": "1-2 punchy sentences on what makes this drive worth doing. Specific, sensory, honest.",
      "weather_warning": "Short alert if conditions need caution on this specific route, otherwise null",
      "highlights": [
        { "icon": "emoji", "label": "short label" }
      ],
      "stops": [
        { "icon": "emoji", "name": "Name of stop", "note": "One line on why it's genuinely worth it" }
      ],
      "waypoints": ["Name of place 1", "Name of place 2", "Name of place 3"],
      "loop": true
    }
  ]
}

Exactly one route must have "recommended": true. The others are false.
"loop" must match the user's route shape preference.
"stops" should be an empty array [] if no worthy stops were requested or none exist on this route.

Possible highlight icons (pick 2-5 per route):
Mountain pass | Coastal road | Countryside | River valley | Scenic views | Twisty roads | Forest road | Elevation change | Beach road | Dramatic landscape | Open moorland | Seasonal beauty`;

  const destLine = (routeType === 'point-to-point' && destination)
    ? `Destination: ${destination} (plan 3 different interesting ways to get there — vary the roads, not just the ETA)`
    : '';

  const userPrompt = `Starting location: ${location}
Desired drive duration: ${duration}
${destLine}
${vibesText}
${contextLines}

Suggest 3 driving routes from this starting point. Make them genuinely different from each other — different directions, different characters. Return JSON only.`.replace(/\n{3,}/g, '\n\n').trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message || 'Claude failed' });

    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Invalid response from route advisor' });

    const parsed = JSON.parse(jsonMatch[0]);

    // ── Waypoint sanity check: geocode each waypoint and drop any that are
    //    implausibly far from the origin (catches Ontario-Canada-style hallucinations).
    //    For point-to-point routes, allow waypoints within 1.5× the origin→destination
    //    distance so scenic detours aren't incorrectly stripped.
    if (coords && Array.isArray(parsed.routes)) {
      let maxKm = maxRadiusKm(duration);
      if (routeType === 'point-to-point' && destination) {
        try {
          const destCoords = await geocode(destination);
          if (destCoords) {
            const originToDest = haversineKm(coords.lat, coords.lng, destCoords.lat, destCoords.lng);
            maxKm = Math.max(maxKm, originToDest * 1.5);
          }
        } catch { /* use default */ }
      }
      await Promise.all(parsed.routes.map(async (route) => {
        if (!Array.isArray(route.waypoints)) return;
        const checks = await Promise.all(
          route.waypoints.map(wp => validateWaypoint(wp, coords.lat, coords.lng, maxKm))
        );
        const before = route.waypoints.length;
        route.waypoints = route.waypoints.filter((_, i) => checks[i]);
        if (route.waypoints.length < before) {
          route.tork_take = (route.tork_take || '') +
            ' (Note: one or more waypoints were out of range and have been removed.)';
        }
      }));
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Route suggestion failed' });
  }
});

app.listen(PORT, () => console.log(`TorK proxy running on port ${PORT}`));
