import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tork-proxy' }));

app.get('/autocomplete', async (req, res) => {
  const { input, sessiontoken } = req.query;
    if (!input) return res.status(400).json({ error: 'input required' });
      try {
          const p = new URLSearchParams({ input, key: GOOGLE_API_KEY, types: 'geocode', ...(sessiontoken && { sessiontoken }) });
              const r = await fetch('https://maps.googleapis.com/maps/api/place/autocomplete/json?' + p);
                  res.json(await r.json());
                    } catch (e) { res.status(500).json({ error: 'Autocomplete failed' }); }
                    });

                    app.post('/suggest', async (req, res) => {
                      const { location, duration, vibes } = req.body;
                        if (!location || !duration) return res.status(400).json({ error: 'location and duration required' });
                          const vibesText = vibes && vibes.length ? 'Driver wants: ' + vibes.join(', ') + '.' : 'No vibe preference.';
                            const system = 'You are TorK, a route advisor for driving enthusiasts. Suggest 3 curated driving routes (loops or out-and-back) from the given location for the given duration, chosen for character not efficiency. Favour mountain passes, coastal roads, river valleys, winding B-roads, moorland, forest. Avoid motorways. Return ONLY JSON: {"routes":[{"title":"str","recommended":true,"duration":"str","distance":"str","tork_take":"str","highlights":[{"icon":"emoji","label":"str"}],"waypoints":["place"],"loop":true}]}. One route has recommended:true.';
                              const user = 'Start: ' + location + '. Duration: ' + duration + '. ' + vibesText + ' 3 different routes. JSON only.';
                                try {
                                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                                          method: 'POST',
                                                headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                                                      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system, messages: [{ role: 'user', content: user }] })
                                                          });
                                                              const data = await r.json();
                                                                  if (data.error) return res.status(500).json({ error: data.error.message });
                                                                      const match = (data.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
                                                                          if (!match) return res.status(500).json({ error: 'Invalid response' });
                                                                              res.json(JSON.parse(match[0]));
                                                                                } catch (e) { res.status(500).json({ error: 'Route suggestion failed' }); }
                                                                                });

                                                                                app.listen(PORT, () => console.log('TorK proxy running on port ' + PORT));
                                                                                
