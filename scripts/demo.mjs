// Demo data: a made-up athlete, so you can see everything working before adding your own activities.
//
//   npm run demo           generate it (if it isn't there yet) and start the app
//   npm run demo:remove    take it out again (setup does this for you when you add real data)
//
// Home is Boulder, Colorado (runs, rides, mountain biking, Flatirons hikes, weekend ski days), plus trips to
// famous places: marathons, classic climbs, surf breaks, ski resorts, big hikes. Routes are generated shapes
// at the real locations, not traced roads. Seeded, so every run makes the same athlete.
//
// It's written as an import (.cache/imports/demo), so it flows through build.mjs like a Strava archive would
// and can be removed cleanly. Offline: place names come from the data, not a geocoder.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DIR = ".cache/imports/demo";
const PROFILE = "public/data/profile.json";
const profile = async () => JSON.parse(await readFile(PROFILE, "utf8").catch(() => "null"));

if (process.argv.includes("--remove")) {
  if (!existsSync(DIR)) console.log("No demo data to remove.");
  else {
    await rm(DIR, { recursive: true, force: true });
    if ((await profile())?.demo) await rm(PROFILE, { force: true });
    console.log("Demo data removed. Rebuilding…");
    build([]);
  }
  process.exit(0);
}
if (existsSync(`${DIR}/activities.json`) && !process.argv.includes("--force")) {
  console.log("Demo data is already in place (npm run demo:remove takes it out).");
  process.exit(0);
}

// ---- seeded randomness ----
let seed = 20200101;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + rand() * (b - a);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

// ---- places: [lng, lat], base altitude (m), UTC offset (h) ----
const P = {
  boulder: { name: "Boulder", cc: "US", country: "United States", at: [-105.2705, 40.015], alt: 1655, tz: -7 },
  chautauqua: { name: "Boulder", cc: "US", country: "United States", at: [-105.2819, 39.9995], alt: 1750, tz: -7 },
  breck: { name: "Breckenridge", cc: "US", country: "United States", at: [-106.0675, 39.4805], alt: 2930, tz: -7 },
  vail: { name: "Vail", cc: "US", country: "United States", at: [-106.3742, 39.6403], alt: 2480, tz: -7 },
  whistler: { name: "Whistler", cc: "CA", country: "Canada", at: [-122.9574, 50.1163], alt: 675, tz: -8 },
  moab: { name: "Moab", cc: "US", country: "United States", at: [-109.5199, 38.5815], alt: 1250, tz: -7 },
  canyon: { name: "Grand Canyon", cc: "US", country: "United States", at: [-112.0573, 36.0544], alt: 2130, tz: -7 },
  jackson: { name: "Jackson Hole", cc: "US", country: "United States", at: [-110.8279, 43.5875], alt: 1925, tz: -7 },
  northshore: { name: "North Shore", cc: "US", country: "United States", at: [-158.0539, 21.665], alt: 5, tz: -10 },
  maui: { name: "Maui", cc: "US", country: "United States", at: [-156.3815, 20.9156], alt: 10, tz: -10 },
  yosemite: { name: "Yosemite", cc: "US", country: "United States", at: [-119.5583, 37.7325], alt: 1220, tz: -8 },
  tahoe: { name: "Lake Tahoe", cc: "US", country: "United States", at: [-120.0324, 39.0968], alt: 1900, tz: -8 },
  nyc: { name: "New York", cc: "US", country: "United States", at: [-73.9712, 40.7831], alt: 30, tz: -5 },
  niseko: { name: "Niseko", cc: "JP", country: "Japan", at: [140.6874, 42.8048], alt: 300, tz: 9 },
  tokyo: { name: "Tokyo", cc: "JP", country: "Japan", at: [139.6917, 35.6896], alt: 40, tz: 9 },
  boston: { name: "Boston", cc: "US", country: "United States", at: [-71.0786, 42.3496], alt: 10, tz: -5 },
  alps: { name: "Bourg-d'Oisans", cc: "FR", country: "France", at: [6.03, 45.0556], alt: 720, tz: 2 },
  ventoux: { name: "Bédoin", cc: "FR", country: "France", at: [5.1796, 44.124], alt: 300, tz: 2 },
  pyrenees: { name: "Luz-Saint-Sauveur", cc: "FR", country: "France", at: [-0.0026, 42.8726], alt: 710, tz: 2 },
  hossegor: { name: "Hossegor", cc: "FR", country: "France", at: [-1.4442, 43.6649], alt: 5, tz: 2 },
  ericeira: { name: "Ericeira", cc: "PT", country: "Portugal", at: [-9.4155, 38.9631], alt: 20, tz: 1 },
  lisbon: { name: "Lisbon", cc: "PT", country: "Portugal", at: [-9.1393, 38.7223], alt: 40, tz: 1 },
  zermatt: { name: "Zermatt", cc: "CH", country: "Switzerland", at: [7.7491, 46.0207], alt: 1610, tz: 1 },
  sedona: { name: "Sedona", cc: "US", country: "United States", at: [-111.761, 34.8697], alt: 1320, tz: -7 },
  zion: { name: "Zion", cc: "US", country: "United States", at: [-112.9473, 37.259], alt: 1300, tz: -7 },
  chamonix: { name: "Chamonix", cc: "FR", country: "France", at: [6.8694, 45.9237], alt: 1035, tz: 2 },
  stelvio: { name: "Prato allo Stelvio", cc: "IT", country: "Italy", at: [10.5911, 46.6188], alt: 915, tz: 2 },
  chicago: { name: "Chicago", cc: "US", country: "United States", at: [-87.6189, 41.8758], alt: 180, tz: -5 },
  paine: { name: "Torres del Paine", cc: "CL", country: "Chile", at: [-73.0, -51.05], alt: 100, tz: -3 },
  bali: { name: "Uluwatu", cc: "ID", country: "Indonesia", at: [115.0884, -8.8149], alt: 5, tz: 8 },
  ubud: { name: "Ubud", cc: "ID", country: "Indonesia", at: [115.2625, -8.5069], alt: 200, tz: 8 },
  mallorca: { name: "Pollença", cc: "ES", country: "Spain", at: [3.0167, 39.8775], alt: 40, tz: 2 },
  berlin: { name: "Berlin", cc: "DE", country: "Germany", at: [13.3777, 52.5163], alt: 35, tz: 2 },
  rotorua: { name: "Rotorua", cc: "NZ", country: "New Zealand", at: [176.2497, -38.1611], alt: 290, tz: 13 },
  queenstown: { name: "Queenstown", cc: "NZ", country: "New Zealand", at: [168.6626, -45.0312], alt: 330, tz: 13 },
  valdisere: { name: "Val d'Isère", cc: "FR", country: "France", at: [6.9806, 45.4486], alt: 1850, tz: 1 },
  london: { name: "London", cc: "GB", country: "United Kingdom", at: [0.0055, 51.4769], alt: 40, tz: 1 },
  cusco: { name: "Cusco", cc: "PE", country: "Peru", at: [-71.9675, -13.5319], alt: 3400, tz: -5 },
  inca: { name: "Inca Trail", cc: "PE", country: "Peru", at: [-72.4974, -13.2263], alt: 2700, tz: -5 },
  jbay: { name: "Jeffreys Bay", cc: "ZA", country: "South Africa", at: [24.931, -34.0507], alt: 5, tz: 2 },
  capetown: { name: "Cape Town", cc: "ZA", country: "South Africa", at: [18.4241, -33.9249], alt: 20, tz: 2 },
  portillo: { name: "Portillo", cc: "CL", country: "Chile", at: [-70.1296, -32.8357], alt: 2880, tz: -4 },
  bled: { name: "Bled", cc: "SI", country: "Slovenia", at: [14.0938, 46.3636], alt: 475, tz: 2 },
  finale: { name: "Finale Ligure", cc: "IT", country: "Italy", at: [8.3433, 44.169], alt: 10, tz: 2 },
  kili: { name: "Kilimanjaro", cc: "TZ", country: "Tanzania", at: [37.3556, -3.0674], alt: 1800, tz: 3 },
  sydney: { name: "Sydney", cc: "AU", country: "Australia", at: [151.2767, -33.8915], alt: 20, tz: 11 },
  bigsur: { name: "Monterey", cc: "US", country: "United States", at: [-121.8947, 36.6002], alt: 10, tz: -7 },
  santacruz: { name: "Santa Cruz", cc: "US", country: "United States", at: [-122.0263, 36.9514], alt: 10, tz: -7 },
  iceland: { name: "Landmannalaugar", cc: "IS", country: "Iceland", at: [-19.0602, 63.9897], alt: 600, tz: 0 },
  cortina: { name: "Cortina d'Ampezzo", cc: "IT", country: "Italy", at: [12.1357, 46.5405], alt: 1220, tz: 2 },
};

// ---- trips: where, when, what you mostly do there, and the headline days ----
// event: [day of trip, name, type, km, { to: [lng, lat], climb: [from m, to m], hour }]
const TRIPS = [
  ["2020-02-08", 7, "whistler", ["ski"], [[2, "Whistler Peak to Creek", "ski", 32]]],
  ["2020-07-18", 7, "moab", ["mtb", "hike"], [[1, "Slickrock Trail", "mtb", 17], [4, "Delicate Arch", "hike", 5]]],
  ["2020-10-03", 6, "canyon", ["hike", "run"], [[2, "Grand Canyon Rim to Rim", "trail", 38, { to: [-112.0516, 36.1987], climb: [2130, 2440] }]]],
  ["2021-01-22", 7, "jackson", ["ski"], [[3, "Corbet's Couloir day", "ski", 28]]],
  ["2021-06-10", 10, "northshore", ["surf", "run"], [[2, "Pipeline dawn patrol", "surf", 3]]],
  ["2021-06-14", 2, "maui", ["ride"], [[0, "Haleakalā: sea to summit", "ride", 58, { to: [-156.2533, 20.7097], climb: [10, 3055], hour: 6 }]]],
  ["2021-09-04", 6, "yosemite", ["hike", "run"], [[2, "Half Dome", "hike", 26, { climb: [1220, 2690] }]]],
  ["2021-09-10", 3, "tahoe", ["swim", "ride"], [[1, "Emerald Bay swim", "swim", 2.5]]],
  ["2021-11-05", 4, "nyc", ["run"], [[2, "New York City Marathon", "run", 42.2, { to: [-73.9731, 40.7713], from: [-74.0601, 40.6024], hour: 9 }]]],
  ["2022-02-18", 8, "niseko", ["ski"], [[3, "Niseko powder day", "ski", 30]]],
  ["2022-02-26", 3, "tokyo", ["run"], [[1, "Imperial Palace loop", "run", 10]]],
  ["2022-04-16", 4, "boston", ["run"], [[2, "Boston Marathon", "run", 42.2, { from: [-71.5226, 42.2287], to: [-71.0786, 42.3496], climb: [150, 10], hour: 10 }]]],
  ["2022-07-02", 5, "alps", ["ride"], [[2, "Alpe d'Huez", "ride", 13.8, { to: [6.07, 45.0924], climb: [720, 1850] }]]],
  ["2022-07-07", 3, "ventoux", ["ride"], [[1, "Mont Ventoux from Bédoin", "ride", 21.5, { to: [5.2789, 44.1741], climb: [300, 1910] }]]],
  ["2022-07-10", 3, "pyrenees", ["ride"], [[1, "Col du Tourmalet", "ride", 19, { to: [0.1453, 42.9089], climb: [710, 2115] }]]],
  ["2022-07-13", 4, "hossegor", ["surf"], [[1, "La Gravière", "surf", 3]]],
  ["2022-09-23", 6, "ericeira", ["surf"], [[2, "Ribeira d'Ilhas", "surf", 3]]],
  ["2022-09-29", 4, "lisbon", ["run"], [[1, "Belém to Cais do Sodré", "run", 12]]],
  ["2023-01-14", 8, "zermatt", ["ski"], [[2, "Matterhorn Glacier Paradise", "ski", 35]]],
  ["2023-03-03", 5, "tokyo", ["run"], [[2, "Tokyo Marathon", "run", 42.2, { to: [139.7671, 35.6812], hour: 9 }]]],
  ["2023-05-20", 5, "sedona", ["mtb", "hike"], [[1, "Hiline Trail", "mtb", 19]]],
  ["2023-05-25", 3, "zion", ["hike"], [[1, "Angels Landing", "hike", 8.7, { climb: [1300, 1765] }]]],
  ["2023-08-05", 10, "chamonix", ["trail", "hike"], [[3, "Tour du Mont Blanc stage", "trail", 30, { climb: [1035, 2525] }]]],
  ["2023-08-15", 3, "stelvio", ["ride"], [[1, "Passo dello Stelvio", "ride", 24.3, { to: [10.4529, 46.5287], climb: [915, 2757] }]]],
  ["2023-10-06", 4, "chicago", ["run"], [[2, "Chicago Marathon", "run", 42.2, { hour: 8 }]]],
  ["2023-12-01", 9, "paine", ["hike"], [[2, "Torres del Paine W Trek", "hike", 22, { climb: [100, 900] }]]],
  ["2024-02-03", 7, "chamonix", ["ski"], [[2, "Vallée Blanche", "ski", 22]]],
  ["2024-04-13", 9, "bali", ["surf"], [[3, "Uluwatu", "surf", 3]]],
  ["2024-04-22", 4, "ubud", ["ride", "run"], [[1, "Ubud rice terraces ride", "ride", 45]]],
  ["2024-06-15", 7, "mallorca", ["ride"], [[2, "Sa Calobra", "ride", 9.5, { to: [2.8065, 39.8504], climb: [0, 682] }], [4, "Cap de Formentor", "ride", 40]]],
  ["2024-07-20", 7, "whistler", ["mtb"], [[2, "A-Line", "mtb", 18]]],
  ["2024-09-27", 3, "berlin", ["run"], [[2, "Berlin Marathon", "run", 42.2, { hour: 9 }]]],
  ["2024-11-09", 6, "rotorua", ["mtb"], [[2, "Whakarewarewa Forest", "mtb", 25]]],
  ["2024-11-15", 5, "queenstown", ["hike", "run"], [[2, "Ben Lomond", "hike", 11, { climb: [330, 1748] }]]],
  ["2025-01-25", 7, "valdisere", ["ski"], [[3, "Face de Bellevarde", "ski", 30]]],
  ["2025-04-25", 4, "london", ["run"], [[2, "London Marathon", "run", 42.2, { to: [-0.1276, 51.5034], hour: 10 }]]],
  ["2025-06-01", 4, "cusco", ["run", "hike"], []],
  ["2025-06-05", 4, "inca", ["hike"], [[0, "Inca Trail: Dead Woman's Pass", "hike", 12, { climb: [3000, 4215] }], [3, "Inca Trail: Sun Gate to Machu Picchu", "hike", 6, { to: [-72.545, -13.1631] }]]],
  ["2025-07-03", 5, "jbay", ["surf"], [[1, "Supertubes", "surf", 3]]],
  ["2025-07-08", 4, "capetown", ["hike", "ride"], [[1, "Table Mountain via Platteklip", "hike", 6, { climb: [360, 1085] }], [2, "Chapman's Peak Drive", "ride", 50]]],
  ["2025-08-14", 7, "portillo", ["ski"], [[2, "Portillo: Super C", "ski", 20]]],
  ["2025-09-04", 4, "bled", ["swim", "run"], [[1, "Lake Bled crossing", "swim", 2.1]]],
  ["2025-10-11", 7, "finale", ["mtb"], [[2, "Finale enduro day", "mtb", 30]]],
  ["2025-12-27", 6, "kili", ["hike"], [[4, "Kilimanjaro: Uhuru Peak", "hike", 14, { climb: [3950, 5895], hour: 0 }]]],
  ["2026-02-07", 7, "niseko", ["ski"], [[2, "Niseko deep day", "ski", 28]]],
  ["2026-03-08", 8, "sydney", ["surf", "run"], [[1, "Bondi to Coogee", "run", 6, { to: [151.2593, -33.9204] }], [3, "Bondi", "surf", 3]]],
  ["2026-05-09", 4, "bigsur", ["ride"], [[1, "Pacific Coast Highway: Big Sur", "ride", 75, { to: [-121.8081, 36.2704] }]]],
  ["2026-05-13", 3, "santacruz", ["surf"], [[1, "Steamer Lane", "surf", 3]]],
  ["2026-06-20", 6, "iceland", ["hike"], [[1, "Laugavegur Trail", "hike", 55, { to: [-19.4934, 63.6806] }]]],
  ["2026-08-01", 8, "cortina", ["ride", "hike"], [[2, "Sella Ronda", "ride", 55, { climb: [1550, 2240] }], [5, "Tre Cime di Lavaredo", "hike", 10, { climb: [2320, 2450] }]]],
  ["2026-09-12", 6, "moab", ["mtb", "ride"], [[2, "Whole Enchilada", "mtb", 42, { climb: [3400, 1250] }]]],
];
const END = "2026-10-31";

// ---- sports: Garmin-style type, speed m/s, typical km, heart rate, hilliness, label ----
const SPORT = {
  run: { type: "running", speed: [2.8, 3.4], km: [6, 16], hr: 152, hills: 30, word: "Run" },
  trail: { type: "trail_running", speed: [2.0, 2.6], km: [10, 25], hr: 150, hills: 250, word: "Trail Run" },
  ride: { type: "road_biking", speed: [6.5, 8.5], km: [35, 90], hr: 135, hills: 120, word: "Ride" },
  mtb: { type: "mountain_biking", speed: [3.5, 4.8], km: [12, 35], hr: 145, hills: 220, word: "MTB" },
  hike: { type: "hiking", speed: [1.1, 1.4], km: [6, 16], hr: 118, hills: 350, word: "Hike" },
  ski: { type: "resort_skiing_snowboarding_ws", speed: [0, 0], km: [18, 35], hr: 125, hills: 0, word: "Ski Day" },
  surf: { type: "surfing", speed: [0.5, 0.7], km: [2, 4], hr: 128, hills: 0, word: "Surf" },
  swim: { type: "open_water_swimming", speed: [0.7, 0.9], km: [1.5, 3], hr: 140, hills: 0, word: "Swim" },
};
const HOME_NAMES = {
  run: ["Boulder Creek Path", "Mesa Trail", "Wonderland Lake loop", "Easy miles", "Tempo Tuesday", "Long run", "Track intervals", "Recovery jog"],
  trail: ["Green Mountain", "Bear Peak", "Mount Sanitas", "Royal Arch"],
  ride: ["Lefthand Canyon", "Flagstaff climb", "Old Stage loop", "Coffee ride", "Carter Lake loop", "Peak to Peak Highway"],
  mtb: ["Betasso Preserve", "Walker Ranch", "Hall Ranch", "Marshall Mesa"],
  hike: ["Flatirons loop", "Chautauqua", "South Boulder Peak"],
  ski: ["Breck laps", "Powder morning", "Bluebird day", "Back Bowls"],
};

// ---- route shapes, in metres east/north of the start ----
const RAD = Math.PI / 180;
const M = 111320;
const toLL = ([lng, lat], x, y) => [lng + x / (M * Math.cos(lat * RAD)), lat + y / M];
const toXY = ([lng, lat], [lng2, lat2]) => [(lng2 - lng) * M * Math.cos(lat * RAD), (lat2 - lat) * M];
const len = (pts) => pts.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const scaleTo = (pts, d) => {
  const k = d / (len(pts) || 1);
  return pts.map(([x, y]) => [x * k, y * k]);
};
const steps = (d) => Math.max(80, Math.min(900, Math.round(d / 40)));

// a lumpy loop back to the start
function loop(d) {
  const k1 = 2 + Math.floor(rand() * 3), k2 = 5 + Math.floor(rand() * 5);
  const p1 = rand() * 6.28, p2 = rand() * 6.28, a0 = rand() * 6.28, squash = between(0.5, 1);
  const n = steps(d);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * 2 * Math.PI;
    const r = 1 + 0.3 * Math.sin(k1 * th + p1) + 0.1 * Math.sin(k2 * th + p2) + 0.02 * Math.sin(37 * th);
    const x = r * Math.cos(th), y = r * Math.sin(th) * squash;
    pts.push([x * Math.cos(a0) - y * Math.sin(a0), x * Math.sin(a0) + y * Math.cos(a0)]);
  }
  const [x0, y0] = pts[0];
  return scaleTo(pts.map(([x, y]) => [x - x0, y - y0]), d);
}
// start to finish, winding more (switchbacks) the longer the route is than the straight line
function line(to, d) {
  const L = Math.hypot(...to) || 1;
  const ux = to[0] / L, uy = to[1] / L;
  const n = steps(d), waves = 4 + Math.round(d / 1500);
  const ph = rand() * 6.28;
  const path = (amp) => Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n;
    const off = amp * Math.sin(Math.PI * s) ** 0.5 * (Math.sin(waves * Math.PI * s + ph) + 0.3 * Math.sin(2.7 * waves * Math.PI * s));
    return [ux * L * s - uy * off, uy * L * s + ux * off];
  });
  let lo = 0, hi = d;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (len(path(mid)) < d) lo = mid;
    else hi = mid;
  }
  return path(lo);
}
// out along a wandering line and back the same way
function outBack(d) {
  const n = steps(d / 2);
  let a = rand() * 6.28, x = 0, y = 0;
  const out = [[0, 0]];
  for (let i = 0; i < n; i++) {
    a += (rand() - 0.5) * 0.5;
    x += Math.cos(a);
    y += Math.sin(a);
    out.push([x, y]);
  }
  const half = scaleTo(out, d / 2);
  return [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [x + 6, y + 6])];
}
// ski: ride the lift straight up, wind down, repeat
function laps(d) {
  const pts = [[0, 0]];
  const top = between(1400, 2400), bearing = rand() * 6.28;
  const up = [Math.cos(bearing) * top, Math.sin(bearing) * top];
  const lifts = [];
  let total = 0;
  while (total < d) {
    const off = [between(-300, 300), between(-300, 300)];
    for (let i = 1; i <= 12; i++) pts.push([(up[0] * i) / 12 + off[0] * (i / 12), (up[1] * i) / 12 + off[1] * (i / 12)]), lifts.push(true);
    const n = 40, ph = rand() * 6.28;
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      const w = 220 * Math.sin(s * Math.PI * between(4, 7) + ph);
      pts.push([up[0] * (1 - s) + off[0] * (1 - s) - Math.sin(bearing) * w, up[1] * (1 - s) + off[1] * (1 - s) + Math.cos(bearing) * w]);
      lifts.push(false);
    }
    total += top * 2.6;
  }
  return { pts, lifts: [false, ...lifts], top };
}
// surf: paddle about inside a small patch of water
function patch(d) {
  const pts = [[0, 0]];
  let x = 0, y = 0;
  const n = 300;
  for (let i = 0; i < n; i++) {
    x = Math.max(-250, Math.min(250, x + between(-18, 18)));
    y = Math.max(-120, Math.min(220, y + between(-14, 16)));
    pts.push([x, y]);
  }
  return scaleTo(pts, d);
}

// ---- one activity ----
let nextId = 1;
const activities = [];
const tracks = new Map();
function iso(t) {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}
function make(place, date, sportKey, { name, km, to, from, climb, hour } = {}) {
  const sp = SPORT[sportKey];
  const d = (km ?? between(...sp.km)) * 1000;
  const start = from ?? toLL(place.at, between(-1500, 1500), between(-1500, 1500));
  let xy, lifts = null, top = 0;
  if (sportKey === "ski") ({ pts: xy, lifts, top } = laps(d));
  else if (sportKey === "surf") xy = patch(d);
  else if (to) xy = line(toXY(start, to), d);
  else if (sportKey === "swim" || rand() < 0.75) xy = loop(d);
  else xy = outBack(d);

  const base = climb ? climb[0] : place.alt;
  const lumps = [rand() * 6.28, rand() * 6.28];
  const v = between(...sp.speed);
  const h = hour ?? (sportKey === "surf" ? between(6, 8) : sportKey === "ski" ? 9 : rand() < 0.6 ? between(6, 9) : between(16, 18.5));
  const [y, mo, da] = date.split("-").map(Number);
  let t = Date.UTC(y, mo - 1, da, 0, 0) + (h - place.tz) * 3600e3;
  const t0 = t;
  let dist = 0, gain = 0, lastAlt = null, hrSum = 0, hrMax = 0;
  const recs = [];
  for (let i = 0; i < xy.length; i++) {
    const seg = i ? Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) : 0;
    const s = i / (xy.length - 1);
    let alt;
    if (sportKey === "ski") {
      // altitude follows the lift up and the runs down
      const r = Math.hypot(...xy[i]) / top;
      alt = base + Math.min(1, r) * 900;
    } else if (climb && to) alt = climb[0] + (climb[1] - climb[0]) * s + 6 * Math.sin(s * 40);
    else if (climb) alt = climb[0] + (climb[1] - climb[0]) * Math.sin(Math.PI * s); // up and back down
    else alt = base + sp.hills * (0.5 + 0.5 * Math.sin(s * 6.28 * 2 + lumps[0]) * Math.sin(s * 3.1 + lumps[1]));
    // slower uphill, faster down
    const grade = i && seg ? (alt - recs[i - 1][4]) / seg : 0;
    let speed = lifts ? (lifts[i] ? 4.5 : 9) : v * Math.max(0.35, 1 - grade * 6);
    if (sportKey === "surf") speed = v;
    dist += seg;
    t += (seg / speed) * 1000;
    if (lastAlt != null && alt - lastAlt > 3) (gain += alt - lastAlt), (lastAlt = alt);
    else if (lastAlt == null || lastAlt - alt > 3) lastAlt = alt;
    const hr = Math.round(sp.hr + 12 * Math.max(-1, Math.min(1, grade * 15)) + 6 * Math.sin(i / 23) + between(-3, 3));
    hrSum += hr;
    hrMax = Math.max(hrMax, hr);
    const [lng, lat] = toLL(start, ...xy[i]);
    recs.push([Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, Math.round(t), Math.round(dist), Math.round(alt), hr]);
  }
  // surf sessions are mostly sitting in the line-up: stretch the clock
  if (sportKey === "surf") {
    const stretch = between(5400, 9000) * 1000 / (t - t0);
    for (const r of recs) r[2] = Math.round(t0 + (r[2] - t0) * stretch);
  }
  const duration = Math.round((recs.at(-1)[2] - t0) / 1000);
  const id = -(910000000 + nextId++);
  const a = {
    activityId: id,
    source: "demo",
    activityName: name ?? `${place.name} ${sp.word}`,
    type: sp.type,
    distance: Math.round(dist),
    duration,
    movingDuration: duration,
    elevationGain: Math.round(gain),
    averageHR: Math.round(hrSum / recs.length),
    maxHR: hrMax,
    calories: Math.round(duration / 60 * (sportKey === "run" || sportKey === "trail" ? 13 : sportKey === "swim" ? 11 : 9)),
    startTimeGMT: iso(t0),
    startTimeLocal: iso(t0 + place.tz * 3600e3),
    startLatitude: recs[0][1],
    startLongitude: recs[0][0],
    locationName: place.name,
    countryName: place.country,
    countryCode: place.cc,
  };
  activities.push(a);
  tracks.set(id, recs);
}

// ---- the calendar ----
const day = (s) => new Date(`${s}T12:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const away = new Map(); // date -> trip
for (const trip of TRIPS) {
  const [startDate, days] = trip;
  for (let i = 0; i < days; i++) away.set(fmt(new Date(day(startDate).getTime() + i * 864e5)), trip);
}
const homeWeighted = (month) => {
  const winter = month <= 2 || month === 11;
  const summer = month >= 5 && month <= 8;
  return [["run", 40], ["trail", summer ? 12 : 6], ["ride", summer ? 24 : 10], ["mtb", summer ? 12 : 4], ["hike", 8], ["ski", winter ? 0 : 0]];
};
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [k, w] of pairs) if ((r -= w) <= 0) return k;
  return pairs[0][0];
};

for (let d = day("2020-01-04"); fmt(d) <= END; d = new Date(d.getTime() + 864e5)) {
  const date = fmt(d);
  const trip = away.get(date);
  if (trip) {
    const [startDate, , key, mix, events] = trip;
    const i = Math.round((day(date) - day(startDate)) / 864e5);
    const ev = events.find(([n]) => n === i);
    const place = P[key];
    if (ev) {
      const [, name, sport, km, opts = {}] = ev;
      make(place, date, sport, { name, km, ...opts });
    } else if (rand() < 0.75) make(place, date, pick(mix));
    continue;
  }
  const month = d.getUTCMonth(), weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const winter = month <= 2 || month === 11;
  // winter weekends in the mountains
  if (winter && weekend && rand() < 0.55) {
    make(rand() < 0.65 ? P.breck : P.vail, date, "ski", { name: pick(HOME_NAMES.ski) });
    continue;
  }
  if (rand() > (weekend ? 0.75 : 0.5)) continue;
  const sport = weighted(homeWeighted(month));
  const km = sport === "run" && weekend && rand() < 0.4 ? between(18, 30) : undefined;
  make(sport === "hike" || sport === "trail" ? P.chautauqua : P.boulder, date, sport, { name: pick(HOME_NAMES[sport]), km });
}

// ---- write it like an import, then build ----
activities.sort((a, b) => b.startTimeGMT.localeCompare(a.startTimeGMT));
await rm(DIR, { recursive: true, force: true });
await mkdir(`${DIR}/tracks`, { recursive: true });
await writeFile(`${DIR}/activities.json`, JSON.stringify(activities));
await writeFile(`${DIR}/matches.json`, "{}");
// the demo athlete's name card, unless you've already set your own
const current = await profile();
if (!current || current.demo) {
  await mkdir("public/data", { recursive: true });
  await writeFile(PROFILE, JSON.stringify({ name: "Alex Rivera", showName: true, demo: true }, null, 2));
}
for (const [id, recs] of tracks) await writeFile(`${DIR}/tracks/${id}.json`, JSON.stringify(recs));
const countries = new Set(activities.map((a) => a.countryCode));
console.log(`Demo athlete: ${activities.length} activities in ${countries.size} countries, ${END.slice(0, 4) - 2020 + 1} years. Building…`);
build(["--no-geocode"]);

function build(flags) {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flags], { stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
