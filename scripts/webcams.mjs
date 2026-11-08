// Live cameras near the places you've been, from Windy's Webcams API (free key: https://api.windy.com/webcams).
//
//   WINDY_WEBCAMS_KEY=... in .env, then build:data picks them up (or run this on its own: node scripts/webcams.mjs)
//   --no-webcams on build:data skips it; with no key the map simply has no cameras.
//
// No AI involved in choosing: every camera near a place gets a score from plain rules and the best one or two win.
//   1. out: offline, not updated lately, traffic/indoor/airport, or a title that reads like a road cam
//   2. score: popularity (log of views, so one viral cam can't drown the rest) + a bonus for scenic kinds
//      (mountains, coast, landscape > city squares > rivers and ports) - a little for distance from the place
//   3. keep the top two per place, at least 1 km apart, never the same camera twice
// Picks you don't like: "Hide this camera" on its card (npm run dev) adds it to public/data/webcams-hidden.json and the
// next build takes the runner-up. Windy's answers are cached in .cache/webcams.json for 30 days, so rebuilding is free.
//
// Only the camera's id, name and position are saved. The published page links to Windy's public player, which needs
// no key, so the key never leaves this computer.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://api.windy.com/webcams/api/v3/webcams";
const CACHE = ".cache/webcams.json";
const HIDDEN = "public/data/webcams-hidden.json";
const MAX_AGE_DAYS = 30;
// what each kind of view is worth on top of popularity; anything not listed (meteo, building, sportArea…) adds nothing
const KIND = {
  mountain: 1.6, landscape: 1.5, coast: 1.5, beach: 1.4, lake: 1.3, observatory: 1.2,
  square: 1.1, city: 1.0, village: 0.9, river: 0.9, forest: 0.8, port: 0.7,
};
const SEARCH = ["mountain", "landscape", "coast", "beach", "lake", "city", "square", "river"];
const RADIUS_KM = (kind) => (kind === "mountain" ? 50 : 25); // peaks are often a valley away from town
const BANNED = new Set(["traffic", "indoor", "airport"]);
// road cams that aren't tagged as traffic: "I-5 at Macadam", "US26 Ramp", "NW Couch at 15th", "Hwy 1 Tunnel"
const ROADISH = /\b(I-?\d+|US-?\s?\d+|OR-?\d+|SR-?\d+|CA-?\d+|A\d+|Hwy|Highway|Interstate|Ramp|On-?Ramp|Off-?Ramp|Exit|Tunnel|Toll|Airport|Parking|Junction)\b|\b(\d+(st|nd|rd|th)|[NSEW]{1,2} \w+|(St|Ave|Blvd|Rd|Dr|Pkwy)\.?) (at|@) |\b(at|@) (\d+(st|nd|rd|th)\b|[NSEW]{1,2} )/i;
const FRESH_DAYS = 3;

export async function findWebcams(places, { key = process.env.WINDY_WEBCAMS_KEY, log = console.log } = {}) {
  if (!key) return null;
  const cache = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
  const hidden = new Set(JSON.parse(await readFile(HIDDEN, "utf8").catch(() => "[]")));
  const stale = (e) => !e || Date.now() - Date.parse(e.at) > MAX_AGE_DAYS * 864e5;

  let asked = 0, stopped = null;
  for (const p of places) {
    const k = placeKey(p);
    if (!stale(cache[k]) || stopped) continue;
    try {
      cache[k] = { at: new Date().toISOString(), cams: await lookup(p, key) };
      asked++;
      if (asked % 10 === 0) {
        log(`  webcams: looked around ${asked} places…`);
        await save(cache);
      }
    } catch (e) {
      stopped = e; // a bad key or a used-up quota: keep what we have and carry on with the build
    }
  }
  await save(cache);
  if (stopped) log(`  webcams: stopped asking Windy (${stopped.message}); using what's cached, the rest comes next build`);

  const used = new Set(), out = [];
  for (const p of places) {
    const [lon, lat] = p.center;
    const ranked = (cache[placeKey(p)]?.cams ?? [])
      .filter((c) => !hidden.has(c.id) && !used.has(c.id))
      .map((c) => ({ ...c, score: score(c, lat, lon) }))
      .filter((c) => c.score > -Infinity)
      .sort((a, b) => b.score - a.score);
    const picks = [];
    for (const c of ranked) {
      if (picks.length === 2) break;
      if (picks.some((q) => km([q.lon, q.lat], [c.lon, c.lat]) < 1)) continue;
      picks.push(c);
    }
    for (const c of picks) {
      used.add(c.id);
      out.push({ id: c.id, title: tidy(c.title, p.name), place: p.name, cc: p.cc, pk: placeKey(p), lat: c.lat, lon: c.lon, kinds: c.kinds });
    }
  }
  log(`  webcams: ${out.length} cameras near ${new Set(out.map((c) => c.place)).size} of ${places.length} places`);
  return out;
}

// everything scenic within reach of one place: one search per kind, since Windy ANDs categories together
async function lookup(p, key) {
  const [lon, lat] = p.center;
  const found = new Map();
  for (const kind of SEARCH) {
    const q = new URLSearchParams({ nearby: `${lat},${lon},${RADIUS_KM(kind)}`, categories: kind, limit: "25", include: "categories,location" });
    const res = await fetch(`${API}?${q}`, { headers: { "x-windy-api-key": key } });
    if (res.status === 401 || res.status === 403) throw new Error("Windy didn't accept the key in WINDY_WEBCAMS_KEY");
    if (res.status === 429) throw new Error("Windy's request limit for now");
    if (!res.ok) continue;
    for (const w of (await res.json()).webcams ?? []) {
      found.set(w.webcamId, {
        id: w.webcamId,
        title: w.title,
        lat: w.location?.latitude,
        lon: w.location?.longitude,
        kinds: (w.categories ?? []).map((c) => c.id),
        views: w.viewCount ?? 0,
        active: w.status === "active",
        // still sending pictures when we asked (Windy keeps dead cameras listed for a while)
        fresh: !w.lastUpdatedOn || Date.now() - Date.parse(w.lastUpdatedOn) < FRESH_DAYS * 864e5,
      });
    }
    await new Promise((r) => setTimeout(r, 120)); // be polite
  }
  return [...found.values()];
}

export function score(c, lat, lon) {
  if (!c.active || c.lat == null) return -Infinity;
  if (c.kinds.some((k) => BANNED.has(k)) || ROADISH.test(c.title)) return -Infinity;
  if (c.fresh === false) return -Infinity;
  const kind = Math.max(0, ...c.kinds.map((k) => KIND[k] ?? 0));
  return Math.log10(c.views + 10) + kind - km([lon, lat], [c.lon, c.lat]) / 15;
}

// "Portland › North-west: Sellwood Bridge - Willamette River" -> "Sellwood Bridge - Willamette River"
function tidy(title, place) {
  const tail = title.split(/:\s+/).at(-1).trim();
  const t = tail.length > 3 ? tail : title;
  return t.replace(/\s*›\s*/g, " · ") || place;
}

// where a place is, to two decimals (names repeat: two clusters can both be "Clackamas County")
export const placeKey = (p) => `${p.center[1].toFixed(2)},${p.center[0].toFixed(2)}`;
async function save(cache) {
  await mkdir(".cache", { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache));
}
function km([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// on its own: node scripts/webcams.mjs (reads places.json, writes webcams.json)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile();
  } catch {}
  if (!process.env.WINDY_WEBCAMS_KEY) {
    console.error("No WINDY_WEBCAMS_KEY in .env. Get a free key at https://api.windy.com/webcams and add it there.");
    process.exit(1);
  }
  const places = JSON.parse(await readFile("public/data/places.json", "utf8"));
  const cams = await findWebcams(places);
  await writeFile("public/data/webcams.json", JSON.stringify(cams));
}
