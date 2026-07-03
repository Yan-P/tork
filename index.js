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

// ── Geocode helper ─────────────────────────────────────────────────────────────
async function geocode(location) {
  if (!GOOGLE_API_KEY) return null;
  try {
    const p = new URLSearchParams({ address: location, key: GOOGLE_API_KEY });
    const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + p);
    const d = await r.json();
    const loc = d.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
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
  const { location, duration, vibes, vehicle, when, time_of_day, dayOffset, userLat, userLng } = req.body;
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

  const contextLines = [
    vehicle     ? `Vehicle: ${vehicle}.`         : '',
    when        ? `Driving: ${when}.`            : '',
    time_of_day ? `Time of day: ${time_of_day}.` : '',
    weather     ? `${weatherLabel}: ${weather.summary}.` : '',
  ].filter(Boolean).join(' ');

  const systemPrompt = `You are TorK — a route advisor for the driving enthusiast. You know roads the way a car journalist does: the B-roads, the passes, the coastal cliff runs, the river valleys, the forest stretches that GPS ignores.

Given a starting location and a desired drive duration, you suggest 3 driving routes. These are NOT point-to-point navigation routes — they are curated driving experiences: loops, figures-of-eight, or out-and-back runs chosen for character, not efficiency.

You favour: mountain passes, coastal roads, river valleys, winding B-roads, elevated moorland, estuaries, forest drives, roads with elevation change and committed corners. You avoid: motorways, ring roads, urban crawls, industrial zones.

Factor in the following when choosing and describing routes:
- Vehicle type: sports cars stay on sealed roads and away from snow/mud/gravel; 4WD can venture onto unsealed tracks
- Weather: warn of ice, snow, fog, high winds — be specific (e.g. "snow likely above 900m today")
- Time of day: note golden hour windows, early-morning empty roads, afternoon tourist traffic on popular routes
- Day type: avoid crowded weekend honeypots; flag known festival/event congestion; note quieter weekday alternatives

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
      "waypoints": ["Name of place 1", "Name of place 2", "Name of place 3"],
      "loop": true
    }
  ]
}

Exactly one route must have "recommended": true. The others are false.
"loop" is true if the route returns near the origin, false for an out-and-back.

Possible highlight icons (pick 2-5 per route):
Mountain pass | Coastal road | Countryside | River valley | Scenic views | Twisty roads | Forest road | Elevation change | Beach road | Dramatic landscape | Open moorland | Seasonal beauty`;

  const userPrompt = `Starting location: ${location}
Desired drive duration: ${duration}
${vibesText}
${contextLines}

Suggest 3 driving routes from this starting point. Make them genuinely different from each other — different directions, different characters. Return JSON only.`;

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

    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    res.status(500).json({ error: 'Route suggestion failed' });
  }
});

app.listen(PORT, () => console.log(`TorK proxy running on port ${PORT}`));
