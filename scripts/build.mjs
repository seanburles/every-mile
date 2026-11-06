// Turn cached FIT files into what the map needs:
//   public/data/routes.geojson   light overview lines (every route, simplified)
//   public/data/tracks/<id>.json detailed track per activity, loaded on click
//   public/data/places.json      activities clustered into cities, reverse-geocoded
//
//   npm run build:data          (sync:routes and import run this automatically)
//
// Activities from other apps (see scripts/import.mjs) live in .cache/imports/<source>/ and are merged in here.
//   --no-geocode                skip the OpenStreetMap Nominatim lookups
import { mkdir, readFile, writeFile, readdir, rm, cp } from "node:fs/promises";
import { Decoder, Stream } from "@garmin/fitsdk";
import { isDefaultName, garminStyleName } from "./names.mjs";

const OUT = "public/data";
const FIT_DIR = ".cache/fit";
const GEOCODE_CACHE = ".cache/geocode.json";
const SC = 180 / 2 ** 31; // semicircles -> degrees
const TILE_Z = 14; // explorer squares: ~2.4 km at the equator, ~1.7 km in Portland
const EFFORTS = { 1000: 131, 1609: 223, 5000: 755, 10000: 1571, 21097: 3450, 42195: 7235 }; // best-effort distance -> world record seconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IMPORTS = ".cache/imports";

// Garmin activities come from sync; imported ones are re-merged on every build so re-imports replace them.
// No sync yet (a Strava-only setup) just means no Garmin activities.
await mkdir(OUT, { recursive: true });
const garmin = JSON.parse(await readFile(`${OUT}/activities.json`, "utf8").catch(() => "[]")).filter((a) => !a.source);
// undo what the last build merged in, so removing or re-running an import never leaves stale names behind
for (const g of garmin) {
  if (g.garminName) g.activityName = g.garminName;
  for (const k of ["garminName", "description", "sourceType", "links", "photos", "best"]) delete g[k];
}
const imported = [];
const importDirs = await readdir(IMPORTS).catch(() => []);
for (const dir of importDirs) {
  imported.push(...JSON.parse(await readFile(`${IMPORTS}/${dir}/activities.json`, "utf8").catch(() => "[]")));
  // names / sports / links from the other app's copy of a Garmin activity
  const matches = JSON.parse(await readFile(`${IMPORTS}/${dir}/matches.json`, "utf8").catch(() => "{}"));
  for (const g of garmin) {
    const x = matches[g.activityId];
    if (!x) continue;
    g.links = { ...g.links, [dir]: x.sourceId };
    if (x.name && !isDefaultName(x.name)) (g.garminName = g.activityName), (g.activityName = x.name);
    if (x.description) g.description = x.description;
    if (x.type) g.sourceType = x.type;
  }
}
// photos from every import, keyed by the activity they belong to (Garmin id for matches)
await rm(`${OUT}/photos`, { recursive: true, force: true });
const photoCounts = new Map();
for (const dir of importDirs) {
  const pdir = `${IMPORTS}/${dir}/photos`;
  for (const id of await readdir(pdir).catch(() => [])) {
    const n = (await readdir(`${pdir}/${id}`)).filter((f) => !f.endsWith("-t.jpg")).length;
    if (!n) continue;
    await cp(`${pdir}/${id}`, `${OUT}/photos/${id}`, { recursive: true });
    photoCounts.set(id, n);
  }
}
for (const a of [...garmin, ...imported]) {
  const n = photoCounts.get(String(a.activityId));
  if (n) a.photos = n;
  else delete a.photos;
}
if (photoCounts.size) console.log(`  photos on ${photoCounts.size} activities`);
const activities = [...garmin, ...imported].sort((a, b) => (b.startTimeGMT ?? b.startTimeLocal).localeCompare(a.startTimeGMT ?? a.startTimeLocal));
await writeFile(`${OUT}/activities.json`, JSON.stringify(activities));
if (imported.length) console.log(`  ${garmin.length} Garmin + ${imported.length} imported activities`);
const byId = new Map(activities.map((a) => [String(a.activityId), a]));

// ---- tracks + overview routes ----
await mkdir(`${OUT}/tracks`, { recursive: true });
const features = [];
const flags = {}; // activities whose recorded sport looks wrong
const tiles = new Map(); // explorer squares: "x,y" at zoom 14 -> first date visited
// the sport the app will show: card dropdown > another app's correction > snow auto-detect > recorded
const overrides = JSON.parse(await readFile(`${OUT}/overrides.json`, "utf8").catch(() => "{}"));
const sportOf = (a) => {
  const o = overrides[a.activityId];
  return o === "recorded" ? a.type : o ?? a.sourceType ?? flags[a.activityId]?.suggest ?? a.type;
};

// every source yields the same record shape: { lng, lat, t (ms), d (m), alt (m), hr }
const sources = [
  ...(await readdir(FIT_DIR).catch(() => [])).filter((n) => n.endsWith(".fit"))
    .map((n) => ({ id: n.replace(".fit", ""), load: async () => readRecords(await readFile(`${FIT_DIR}/${n}`)) })),
];
for (const dir of importDirs) {
  const tdir = `${IMPORTS}/${dir}/tracks`;
  for (const n of await readdir(tdir).catch(() => [])) {
    sources.push({
      id: n.replace(".json", ""),
      load: async () => JSON.parse(await readFile(`${tdir}/${n}`, "utf8")).map(([lng, lat, t, d, alt, hr]) => ({ lng, lat, t, d, alt, hr })),
    });
  }
}
for (const [i, src] of sources.entries()) {
  const id = src.id;
  const a = byId.get(id);
  if (!a) continue;
  if (i % 100 === 0) process.stdout.write(`\r  decoding ${i}/${sources.length}`);
  let recs;
  try {
    recs = await src.load();
  } catch {
    continue;
  }
  if (recs.length < 2) continue;
  if (/running|walking|hiking/.test(a.type) && skiSeason(a)) {
    const snow = looksLikeSnow(recs);
    if (snow) flags[a.activityId] = { suggest: "resort_skiing_snowboarding_ws", laps: snow.laps };
  }
  // best efforts (fastest 1 km … marathon inside any run), from the whole track, like Strava computes them
  const secs = a.movingDuration ?? a.duration, speed = secs && a.distance ? a.distance / secs : 0;
  if (/running/.test(sportOf(a)) && speed < (a.distance > 10000 ? 6.0 : 6.5)) {
    const best = bestEfforts(recs);
    if (best) a.best = best;
  }
  // squares count ground you covered under your own power: skip lifts, boats and pools
  if (!flags[a.activityId] && !/skiing|snowboard|sail|swim|boat/.test(a.type)) markTiles(recs, a.startTimeLocal.slice(0, 10));

  // detailed track: <=1000 points, evenly spaced in time
  const step = Math.max(1, Math.ceil(recs.length / 1000));
  const pick = recs.filter((_, j) => j % step === 0 || j === recs.length - 1);
  const t0 = pick[0].t;
  const track = {
    c: pick.map((r) => [round(r.lng, 5), round(r.lat, 5)]),
    t: pick.map((r) => Math.round((r.t - t0) / 1000)),
    d: pick.map((r) => (r.d == null ? null : Math.round(r.d))),
    alt: pick.map((r) => (r.alt == null ? null : round(r.alt, 1))),
    hr: pick.map((r) => r.hr ?? null),
  };
  await writeFile(`${OUT}/tracks/${id}.json`, JSON.stringify(track));

  const coords = rdp(recs.map((r) => [r.lng, r.lat]), 0.00008).map(([x, y]) => [round(x, 5), round(y, 5)]);
  features.push({
    type: "Feature",
    properties: { id: a.activityId, type: a.type },
    geometry: { type: "LineString", coordinates: coords },
  });
}
console.log(`\r  ${features.length} routes decoded          `);
// drop detail tracks for activities that are gone (e.g. an import that was replaced)
for (const n of await readdir(`${OUT}/tracks`)) if (!byId.has(n.replace(".json", ""))) await rm(`${OUT}/tracks/${n}`);
await writeFile(`${OUT}/routes.geojson`, JSON.stringify({ type: "FeatureCollection", features }));
await writeFile(`${OUT}/flags.json`, JSON.stringify(flags));
await writeFile(`${OUT}/explorer.json`, JSON.stringify({ z: TILE_Z, tiles: [...tiles].map(([k, d]) => [...k.split(",").map(Number), d]) }));
console.log(`  ${tiles.size} explorer squares`);
console.log(`  ${Object.keys(flags).length} runs/walks look like snow days`);

// ---- places: greedy 40 km clusters around activity starts ----
const located = activities.filter((a) => a.startLatitude != null);
const clusters = [];
for (const a of located) {
  const p = [a.startLongitude, a.startLatitude];
  let c = clusters.find((c) => km(c.seed, p) < 40);
  if (!c) clusters.push((c = { seed: p, members: [] }));
  c.members.push(a);
}

const geocache = JSON.parse(await readFile(GEOCODE_CACHE, "utf8").catch(() => "{}"));
const geocode = !process.argv.includes("--no-geocode");
const places = [];
for (const c of clusters) {
  const m = c.members;
  const lng = median(m.map((a) => a.startLongitude));
  const lat = median(m.map((a) => a.startLatitude));
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (geocode && !geocache[key]) {
    process.stdout.write(`\r  geocoding ${places.length + 1}/${clusters.length}`);
    geocache[key] = await reverse(lat, lng);
    await sleep(1100); // Nominatim usage policy: max 1 req/s
  }
  // without a lookup, fall back to what the activities say about themselves (Garmin's locationName; the demo
  // data also carries its country, so it works offline)
  const g = geocache[key] ?? {
    country: mode(m.map((a) => a.countryName).filter(Boolean)),
    cc: mode(m.map((a) => a.countryCode).filter(Boolean)),
  };
  const garminName = mode(m.map((a) => a.locationName).filter(Boolean));
  // OSM sometimes answers with an admin area ("Clackamas County", "Suthep Town Municipality");
  // Garmin's own locationName is the friendlier label in those cases.
  const adminish = /county|municipality|district|distrito|prefecture|province|regional/i.test(g.city ?? "");
  const name = (adminish || !g.city ? garminName : g.city) ?? g.city ?? g.country ?? "Somewhere";
  const dates = m.map((a) => a.startTimeLocal).sort();
  places.push({
    name,
    country: g.country ?? "",
    cc: g.cc ?? "",
    center: [round(lng, 4), round(lat, 4)],
    count: m.length,
    distance: Math.round(m.reduce((s, a) => s + (a.distance ?? 0), 0)),
    first: dates[0].slice(0, 10),
    last: dates.at(-1).slice(0, 10),
    ids: m.map((a) => a.activityId),
  });
}
await writeFile(GEOCODE_CACHE, JSON.stringify(geocache));
places.sort((a, b) => b.count - a.count);
await writeFile(`${OUT}/places.json`, JSON.stringify(places));

// imported activities with an app-generated name ("Afternoon Run") get Garmin's style instead: "Portland Running"
const placeById = new Map(places.flatMap((p) => p.ids.map((id) => [id, p])));
let renamed = 0;
for (const a of imported) {
  if (a.appName) a.activityName = a.appName; // undo a previous build's rename
  if (!isDefaultName(a.activityName)) continue;
  a.appName = a.activityName;
  a.activityName = garminStyleName(placeById.get(a.activityId)?.name, a.type);
  renamed++;
}
await writeFile(`${OUT}/activities.json`, JSON.stringify(activities));
if (renamed) console.log(`  ${renamed} imported activities named after their place`);
console.log(`\r  ${places.length} places in ${new Set(places.map((p) => p.cc).filter(Boolean)).size} countries`);

// ---- helpers ----

// Fastest time over each distance inside a track: two pointers over cumulative distance, interpolating the
// start so efforts don't snap to sample points. Anything quicker than the world record is a GPS glitch.
function bestEfforts(recs) {
  const pts = recs.filter((r) => r.d != null && r.t != null);
  if (pts.length < 10) return null;
  // a GPS jump shows up as one impossible step; no window containing one counts (8.5 m/s ≈ 3:10 per mile)
  const spikes = [0];
  for (let k = 1; k < pts.length; k++) {
    const dt = (pts[k].t - pts[k - 1].t) / 1000, dd = pts[k].d - pts[k - 1].d;
    spikes.push(spikes[k - 1] + (dd > 15 && dd / Math.max(dt, 1) > 8.5 ? 1 : 0));
  }
  const out = {};
  for (const [dist, wr] of Object.entries(EFFORTS).map(([d, w]) => [Number(d), w])) {
    if (pts.at(-1).d - pts[0].d < dist) break;
    let best = Infinity;
    for (let i = 0, j = 0; j < pts.length; j++) {
      while (i + 1 < j && pts[j].d - pts[i + 1].d >= dist) i++;
      const covered = pts[j].d - pts[i].d;
      if (covered < dist) continue;
      // start partway between i and i+1 so the window is exactly `dist`
      const a = pts[i], b = pts[i + 1];
      const f = b.d > a.d ? Math.min(1, (covered - dist) / (b.d - a.d)) : 0;
      const secs = (pts[j].t - (a.t + f * (b.t - a.t))) / 1000;
      if (spikes[j] - spikes[i] > 0) continue;
      if (secs > wr && secs < best) best = secs;
    }
    if (best < Infinity) out[dist] = Math.round(best);
  }
  return Object.keys(out).length ? out : null;
}

// Explorer squares use the slippy-map grid at TILE_Z
function tileOf(lng, lat) {
  const n = 2 ** TILE_Z, r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}
function markTiles(recs, date) {
  const mark = (lng, lat) => {
    const k = tileOf(lng, lat).join(",");
    const prev = tiles.get(k);
    if (!prev || date < prev) tiles.set(k, date);
  };
  for (let i = 0; i < recs.length; i++) {
    const p = recs[i], q = recs[i + 1];
    mark(p.lng, p.lat);
    if (!q) break;
    // fill gaps between sparse samples so a fast straight stretch doesn't skip a square; ignore GPS teleports
    const gap = Math.hypot(q.lng - p.lng, q.lat - p.lat);
    if (gap > 0.002 && gap < 0.2) {
      const steps = Math.ceil(gap / 0.002);
      for (let k = 1; k < steps; k++) mark(p.lng + ((q.lng - p.lng) * k) / steps, p.lat + ((q.lat - p.lat) * k) / steps);
    }
  }
}

// No ski resorts in the tropics; outside them, only flag winter-ish months for that hemisphere.
// Keeps gondolas (Medellín's Metrocable) and elevator rides out of the snow pile.
function skiSeason(a) {
  const lat = a.startLatitude;
  if (lat == null || Math.abs(lat) < 23.5) return false;
  const m = Number(a.startTimeLocal.slice(5, 7));
  return lat > 0 ? m >= 11 || m <= 5 : m >= 6 && m <= 10;
}

// A chairlift climbs 1–3 m/s vertically; a runner tops out around 0.5. Pair that with
// fast descents and it's a ski day the watch recorded as a run.
function looksLikeSnow(recs) {
  const pts = recs.filter((r) => r.alt != null);
  if (pts.length < 60) return null;
  let liftSecs = 0, fastDownSecs = 0, laps = 0, onLift = false;
  for (let i = 0, j = 0; i < pts.length; i++) {
    while (j < pts.length - 1 && pts[j].t - pts[i].t < 60_000) j++;
    const dt = (pts[j].t - pts[i].t) / 1000;
    if (dt < 30) break;
    const vz = (pts[j].alt - pts[i].alt) / dt;
    const step = i ? (pts[i].t - pts[i - 1].t) / 1000 : 0;
    const lifting = vz > 1;
    if (lifting) liftSecs += step;
    if (lifting && !onLift) laps++;
    onLift = lifting;
    if (pts[i].d != null && pts[j].d != null && vz < -1 && (pts[j].d - pts[i].d) / dt > 6) fastDownSecs += step;
  }
  return liftSecs > 300 && fastDownSecs > 120 && laps >= 2 ? { laps } : null;
}
function readRecords(bytes) {
  const { messages } = new Decoder(Stream.fromByteArray(bytes)).read();
  return (messages.recordMesgs ?? [])
    .filter((r) => r.positionLat != null && r.positionLong != null)
    .map((r) => ({
      lng: r.positionLong * SC,
      lat: r.positionLat * SC,
      t: new Date(r.timestamp).getTime(),
      d: r.distance,
      alt: r.enhancedAltitude ?? r.altitude,
      hr: r.heartRate,
    }));
}

async function reverse(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "garmin-lab/0.1 (personal activity map)" } });
    const j = await res.json();
    const ad = j.address ?? {};
    return {
      city: ad.city ?? ad.town ?? ad.village ?? ad.municipality ?? ad.county ?? ad.state,
      country: ad.country,
      cc: ad.country_code?.toUpperCase(),
    };
  } catch {
    return null;
  }
}

function km([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// Ramer–Douglas–Peucker, iterative so long rides don't blow the stack
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = s + 1; i < e; i++) {
      const dist = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (dist > max) (max = dist), (idx = i);
    }
    if (max > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function mode(xs) {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}
