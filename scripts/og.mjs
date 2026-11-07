// Share images: the picture that shows up when someone pastes your link (X, Facebook, iMessage, Slack, Reddit),
// and cards for Instagram, all drawn from your own data (as SVG, rendered to PNG; no browser involved).
//
//   public/data/og.png               1200 × 630   link previews
//   public/data/cards/post.png       1080 × 1350  Instagram feed post (4:5)
//   public/data/cards/<page>.png     1080 × 1920  Instagram stories (9:16): overview, globe, places, days, records
//   public/data/cards/cards.json     the list the app's Instagram picker shows
//
// build.mjs calls this at the end of every build; `node scripts/og.mjs` redraws them on their own.
// Places are already 40 km clusters, so the map shows cities, never a front door.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { geoNaturalEarth1, geoOrthographic, geoPath, geoContains, geoGraticule10, geoDistance } from "d3-geo";
import { feature } from "topojson-client";

const DATA = "public/data";
const FONTS = ["regular", "bold", "wide-black"].map((n) => fileURLToPath(new URL(`./og-fonts/archivo-${n}.ttf`, import.meta.url)));
const C = { paper: "#f6f1e7", paper2: "#ece5d6", ink: "#221d17", ink2: "#6b6256", ink3: "#a39886", run: "#f0441e" };

// the same totals the app's panel leads with
export async function shareStats(dir = DATA) {
  const acts = JSON.parse(await readFile(`${dir}/activities.json`, "utf8").catch(() => "[]"));
  const places = JSON.parse(await readFile(`${dir}/places.json`, "utf8").catch(() => "[]"));
  const profile = JSON.parse(await readFile(`${dir}/profile.json`, "utf8").catch(() => "null"));
  const sane = (a) => (a.movingDuration ?? a.duration ?? 0) <= 30 * 3600;
  const meters = acts.reduce((s, a) => s + (sane(a) ? a.distance ?? 0 : 0), 0);
  const years = acts.map((a) => a.startTimeLocal.slice(0, 4)).sort();
  const countries = new Set(places.map((p) => p.cc).filter(Boolean)).size;
  const name = profile?.showName && profile.name ? profile.name : "";
  const miles = Math.round(meters / 1609.344);
  const span = years.length ? (years[0] === years.at(-1) ? years[0] : `${years[0]}–${years.at(-1)}`) : "";
  // sport mix by activity count, with the same corrections the app applies (card picks, Strava, snow detection)
  const overrides = JSON.parse(await readFile(`${dir}/overrides.json`, "utf8").catch(() => "{}"));
  const flags = JSON.parse(await readFile(`${dir}/flags.json`, "utf8").catch(() => "{}"));
  const mix = {};
  for (const a of acts) {
    const o = overrides[a.activityId];
    const t = o === "recorded" ? a.type : o ?? a.sourceType ?? flags[a.activityId]?.suggest ?? a.type;
    const g = Object.keys(GROUPS).find((k) => GROUPS[k].test(t));
    a.group = g;
    mix[g] = (mix[g] ?? 0) + 1;
  }
  const unranked = new Set(JSON.parse(await readFile(`${dir}/unranked.json`, "utf8").catch(() => "[]")));
  return {
    name, miles, places, span, countries, count: acts.length, mix, acts, unranked,
    title: name ? `${name} · Every Mile` : "Every Mile",
    description: acts.length
      ? `${miles.toLocaleString("en-US")} miles over ${acts.length.toLocaleString("en-US")} activities in ${countries} ${countries === 1 ? "country" : "countries"}${span ? `, ${span}` : ""}. Every route on one map.`
      : "Every activity you've ever recorded, on one map.",
  };
}

// the app's sport groups and colors (src/shared.js, src/style.css)
const GROUPS = {
  run: { label: "Run", color: "#f0441e", test: (t) => /running/.test(t) },
  ride: { label: "Ride", color: "#2b4fd8", test: (t) => /cycling|biking|e_bike/.test(t) },
  walk: { label: "Walk/Hike", color: "#2a9a55", test: (t) => /walking|hiking/.test(t) },
  snow: { label: "Snow", color: "#c2389a", test: (t) => /skiing|snowboard/.test(t) },
  water: { label: "Water", color: "#0b6e7d", test: (t) => /swim|sail|paddl|row|surf/.test(t) },
  gym: { label: "Gym", color: "#8a7f70", test: () => true },
};

// a stacked bar of the sport mix, labelled underneath with the biggest few
function mixBar(mix, x, y, w, k = 1) {
  if (k !== 1) return `<g transform="translate(${x} ${y}) scale(${k})">${mixBar(mix, 0, 0, w / k)}</g>`;
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const rows = Object.keys(GROUPS).filter((g) => mix[g]).map((g) => ({ g, n: mix[g], ...GROUPS[g] }));
  let xx = x;
  const bar = rows.map((r) => {
    const ww = (r.n / total) * w;
    const out = `<rect x="${xx.toFixed(1)}" y="${y}" width="${ww.toFixed(1)}" height="18" fill="${r.color}"/>`;
    xx += ww;
    return out;
  }).join("");
  let lx = x;
  const labels = [...rows].sort((a, b) => b.n - a.n).slice(0, 4).map((r) => {
    const pct = Math.round((r.n / total) * 100);
    if (pct < 1) return "";
    const txt = `${r.label} ${pct}%`;
    const out = `<rect x="${lx}" y="${y + 34}" width="12" height="12" fill="${r.color}"/><text x="${lx + 18}" y="${y + 45}" font-family="Archivo" font-weight="700" font-size="17" fill="${C.ink}">${txt}</text>`;
    lx += 18 + txt.length * 9.6 + 22;
    return out;
  }).join("");
  return `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="22" fill="${C.ink}"/>${bar}${labels}`;
}

// the card fonts have no emoji (☁️ ☀️ 🏃 in activity names), so those go rather than print as boxes
const esc = (s) => String(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, "").replace(/\s{2,}/g, " ").trim().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// land as separate polygons with their bounding boxes, so "is this dot on land?" only tests the few nearby
let land = null;
async function loadLand() {
  if (!land) {
    const topo = JSON.parse(await readFile(new URL("../node_modules/world-atlas/land-110m.json", import.meta.url), "utf8"));
    const polys = feature(topo, topo.objects.land).features.flatMap((f) =>
      f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.map((c) => ({ type: "Polygon", coordinates: c })) : [f.geometry]);
    land = polys.map((g) => {
      const ring = g.coordinates[0];
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      // rings that cross the date line (Russia's far east, Antarctica) get a whole-world box
      const wraps = Math.max(...xs) - Math.min(...xs) > 180;
      return { g, x0: wraps ? -180 : Math.min(...xs), x1: wraps ? 180 : Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
  }
  return land;
}
const onLand = (polys, [x, y]) => polys.some((p) => x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && geoContains(p.g, [x, y]));

// dotted land + a red dot per place, framed on where you've been (the whole world for a traveller, one region otherwise)
async function mapLayer(places, x, y, w, h) {
  const pts = places.filter((p) => p.center);
  const proj = geoNaturalEarth1();
  const frame = pts.length ? { type: "MultiPoint", coordinates: pts.map((p) => p.center) } : { type: "Sphere" };
  proj.fitExtent([[x + 70, y + 60], [x + w - 70, y + h - 60]], frame);
  // never closer than about a 2,000 km wide view, so a single city still reads as a place on a map
  const minScale = (w / 6) * (180 / Math.PI) / 35;
  if (proj.scale() > minScale) {
    const [cx, cy] = proj.invert([x + w / 2, y + h / 2]);
    proj.scale(minScale).translate([0, 0]);
    const [px, py] = proj([cx, cy]);
    proj.translate([x + w / 2 - px, y + h / 2 - py]);
  }
  const shape = await loadLand();
  const dots = [];
  const step = 7;
  for (let py = y + step / 2; py < y + h; py += step) {
    for (let px = x + step / 2; px < x + w; px += step) {
      const ll = proj.invert([px, py]);
      // invert() happily answers for points off the edge of the globe; a round trip weeds those out
      const back = ll && proj(ll);
      if (!back || Math.hypot(back[0] - px, back[1] - py) > 0.5) continue;
      if (ll[1] > -58 && onLand(shape, ll)) dots.push(`M${px.toFixed(1)} ${py.toFixed(1)}h0`);
    }
  }
  const max = Math.max(1, ...pts.map((p) => p.count));
  const circles = pts
    .sort((a, b) => b.count - a.count)
    .map((p) => {
      const [px, py] = proj(p.center);
      if (px < x || px > x + w || py < y || py > y + h) return "";
      const r = 4 + Math.sqrt(p.count / max) * 18;
      return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}" fill="${C.run}" fill-opacity="0.18"/>
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${Math.max(3, r * 0.35).toFixed(1)}" fill="${C.run}"/>`;
    })
    .join("");
  const grat = geoPath(proj)(geoGraticule10());
  return `<clipPath id="m"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>
    <g clip-path="url(#m)">
      <path d="${grat}" fill="none" stroke="${C.ink}" stroke-opacity="0.06" stroke-width="1"/>
      <path d="${dots.join("")}" stroke="${C.ink3}" stroke-width="2.8" stroke-linecap="round"/>
      ${circles}
    </g>`;
}

// the panel: wordmark, name, the big number, one line of context
function panel(s, x, y, w, { big }) {
  const num = s.miles.toLocaleString("en-US");
  // Archivo at 125% width and 900 weight runs about 0.8 em per digit
  const size = Math.min(big, Math.floor((w - 8) / (num.length * 0.8)));
  const line = [`${s.count.toLocaleString("en-US")} activities`, `${s.countries} ${s.countries === 1 ? "country" : "countries"}`, s.span].filter(Boolean).join("  ·  ");
  let yy = y;
  const out = [];
  out.push(`<text x="${x}" y="${(yy += 46)}" font-family="Archivo Expanded Black, Archivo Expanded" font-weight="900" font-stretch="expanded" font-size="52" letter-spacing="-1.5" fill="${C.ink}">EVERY</text>`);
  out.push(`<text x="${x}" y="${(yy += 46)}" font-family="Archivo Expanded Black, Archivo Expanded" font-weight="900" font-stretch="expanded" font-size="52" letter-spacing="-1.5" fill="${C.ink}">MILE</text>`);
  if (s.name) out.push(`<text x="${x}" y="${(yy += 40)}" font-family="Archivo" font-weight="700" font-size="24" letter-spacing="1" fill="${C.ink}">${esc(s.name.toUpperCase())}</text>`);
  yy += s.name ? 40 : 56;
  out.push(`<text x="${x - 4}" y="${(yy += size * 0.82)}" font-family="Archivo Expanded Black, Archivo Expanded" font-weight="900" font-stretch="expanded" font-size="${size}" letter-spacing="${-size * 0.03}" fill="${C.ink}">${num}</text>`);
  out.push(`<text x="${x}" y="${(yy += 40)}" font-family="Archivo" font-weight="700" font-size="24" letter-spacing="3" fill="${C.run}">MILES</text>`);
  out.push(`<text x="${x}" y="${(yy += 44)}" font-family="Archivo" font-weight="400" font-size="24" fill="${C.ink2}">${esc(line)}</text>`);
  return out.join("\n");
}

function render(svg, width) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Archivo" },
  }).render().asPng();
}

export async function makeShareImages(dir = DATA, { domain = siteDomain() } = {}) {
  const s = await shareStats(dir);
  await mkdir(`${dir}/cards`, { recursive: true });

  // 1200 × 630: the app's layout in miniature, panel left, map right
  const W = 1200, H = 630, P = 520;
  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.paper}"/>
    ${await mapLayer(s.places, P, 0, W - P, H)}
    <rect x="0" y="0" width="${P}" height="${H}" fill="${C.paper}"/>
    <rect x="${P - 3}" y="0" width="3" height="${H}" fill="${C.ink}"/>
    ${panel(s, 56, 40, P - 100, { big: 132 })}
    ${mixBar(s.mix, 56, H - 112, P - 112)}
  </svg>`;
  await writeFile(`${dir}/og.png`, render(og, W));

  // 1080 × 1350 (4:5, Instagram's tallest feed post): map on top, panel below
  const IW = 1080, IH = 1350, M = 760;
  const post = `<svg xmlns="http://www.w3.org/2000/svg" width="${IW}" height="${IH}" viewBox="0 0 ${IW} ${IH}">
    <rect width="${IW}" height="${IH}" fill="${C.paper}"/>
    ${await mapLayer(s.places, 0, 0, IW, M)}
    <rect x="0" y="${M}" width="${IW}" height="3" fill="${C.ink}"/>
    ${panel(s, 72, M + 24, IW - 144, { big: 190 })}
    ${mixBar(s.mix, 72, IH - 108, IW - 144)}
  </svg>`;
  await writeFile(`${dir}/cards/post.png`, render(post, IW));

  // 1080 × 1920 stories, one per page
  const list = [{ id: "post", title: "Feed post", size: "4:5" }];
  for (const [id, title, draw] of STORIES) {
    const body = await draw(s);
    if (!body) continue;
    await writeFile(`${dir}/cards/${id}.png`, render(story(s, title, body, domain), SW));
    list.push({ id, title, size: "9:16" });
  }
  await writeFile(`${dir}/cards/cards.json`, JSON.stringify({ v: Date.now().toString(36), cards: list }));
  return s;
}

function siteDomain() {
  try {
    process.loadEnvFile(); // SURGE_DOMAIN, if you publish
  } catch {}
  return process.env.SURGE_DOMAIN ?? "";
}

// ---- stories: 1080 × 1920, a shared frame (wordmark, title, footer) around one picture per page ----
const SW = 1080, SH = 1920, SX = 72;
const T = (x, y, size, text, { w = 400, f = "Archivo", c = C.ink, a = "start", ls = 0, wide = false } = {}) =>
  `<text x="${x}" y="${y}" font-family="${wide ? "Archivo Expanded Black, Archivo Expanded" : f}" font-weight="${wide ? 900 : w}"${wide ? ' font-stretch="expanded"' : ""} font-size="${size}" fill="${c}" text-anchor="${a}" letter-spacing="${ls}">${esc(text)}</text>`;

function story(s, title, body, domain) {
  const by = s.name ? s.name.toUpperCase() : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}">
    <rect width="${SW}" height="${SH}" fill="${C.paper}"/>
    ${T(SX, 150, 40, "EVERY MILE", { wide: true, ls: -1 })}
    ${by ? T(SW - SX, 148, 26, by, { w: 700, a: "end", ls: 1.5 }) : ""}
    <rect x="${SX}" y="178" width="${SW - SX * 2}" height="3" fill="${C.ink}"/>
    ${T(SX - 4, 330, Math.min(110, Math.floor((SW - SX * 2) / (title.length * 0.84))), title.toUpperCase(), { wide: true, ls: -3 })}
    ${body}
    <rect x="${SX}" y="${SH - 190}" width="${SW - SX * 2}" height="3" fill="${C.ink}"/>
    ${T(SX, SH - 128, 30, `${s.miles.toLocaleString("en-US")} miles · ${s.count.toLocaleString("en-US")} activities · ${s.span}`, { w: 700 })}
    ${domain ? T(SX, SH - 84, 28, domain, { c: C.run, w: 700 }) : ""}
  </svg>`;
}

const fmtMi = (m, d = 1) => `${(m / 1609.344).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })} mi`;
const fmtFt = (m) => `${Math.round(m * 3.28084).toLocaleString("en-US")} ft`;
const fmtClock = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const day = (a) => a.startTimeLocal.slice(0, 10);
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// the same sanity rules as the app's records (src/shared.js)
const sane = (a) => (a.movingDuration ?? a.duration ?? 0) <= 30 * 3600;
const plausible = (a, s) => {
  if (s.unranked.has(a.activityId) || !sane(a)) return false;
  const secs = a.movingDuration ?? a.duration;
  if (!a.distance || !secs) return true;
  const foot = a.distance > 10000 ? 6.0 : 6.5;
  return a.distance / secs < (a.group === "run" || a.group === "walk" ? foot : a.group === "ride" ? 17 : 40);
};
const climbOk = (a) => !a.elevationGain || !a.distance || a.elevationGain / a.distance < 0.2;

const STORIES = [
  ["overview", "Every route", async (s) => {
    const top = 400, h = 900;
    return `${await mapLayer(s.places, 0, top, SW, h)}
      ${T(SX - 6, top + h + 150, 170, s.miles.toLocaleString("en-US"), { wide: true, ls: -6 })}
      ${T(SX, top + h + 210, 34, "MILES", { w: 700, c: C.run, ls: 4 })}
      ${T(SX, top + h + 270, 32, `${s.countries} countries · ${s.places.length} places`, { c: C.ink2 })}
      ${mixBar(s.mix, SX, top + h + 310, SW - SX * 2, 1.5)}`;
  }],

  ["globe", "The globe", async (s) => {
    // turn the globe to the side of the earth with the most of your places on it
    const pts = s.places.filter((p) => p.center);
    if (!pts.length) return "";
    const near = (c) => pts.reduce((n, p) => n + (geoDistance(c, p.center) < 1.2 ? p.count : 0), 0);
    const center = pts.map((p) => p.center).sort((a, b) => near(b) - near(a))[0];
    const R = 430, cx = SW / 2, cy = 900;
    const proj = geoOrthographic().rotate([-center[0], -center[1] + 12]).translate([cx, cy]).scale(R);
    const shape = await loadLand();
    const dots = [];
    for (let y = cy - R; y < cy + R; y += 8) {
      for (let x = cx - R; x < cx + R; x += 8) {
        if (Math.hypot(x - cx, y - cy) > R - 2) continue;
        const ll = proj.invert([x, y]);
        if (ll && onLand(shape, ll)) dots.push(`M${x} ${y}h0`);
      }
    }
    const front = (c) => geoDistance(c, proj.invert([cx, cy])) < Math.PI / 2 - 0.05;
    const max = Math.max(...pts.map((p) => p.count));
    const marks = pts.filter((p) => front(p.center)).sort((a, b) => b.count - a.count).map((p) => {
      const [x, y] = proj(p.center);
      const r = 5 + Math.sqrt(p.count / max) * 22;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${C.run}" fill-opacity="0.2"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(4, r * 0.35).toFixed(1)}" fill="${C.run}"/>`;
    }).join("");
    const grat = geoPath(proj)(geoGraticule10());
    return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.paper2}" fill-opacity="0.5" stroke="${C.ink}" stroke-width="3"/>
      <path d="${grat}" fill="none" stroke="${C.ink}" stroke-opacity="0.07" stroke-width="1.2"/>
      <path d="${dots.join("")}" stroke="${C.ink3}" stroke-width="3.6" stroke-linecap="round"/>
      ${marks}
      ${T(SX, 1520, 46, `${s.countries} ${s.countries === 1 ? "country" : "countries"}, ${s.places.length} places`, { wide: true, ls: -1 })}
      ${T(SX, 1580, 32, `Biggest dot: ${pts.sort((a, b) => b.count - a.count)[0].name.split(/ [·(]| - /)[0]}, ${pts[0].count.toLocaleString("en-US")} activities`, { c: C.ink2 })}`;
  }],

  ["places", "Places I've been", async (s) => {
    const by = new Map();
    for (const p of s.places) {
      if (!p.cc) continue;
      const t = by.get(p.cc) ?? { name: p.country, n: 0, places: 0 };
      t.n += p.count;
      t.places++;
      by.set(p.cc, t);
    }
    const rows = [...by.values()].sort((a, b) => b.n - a.n);
    if (!rows.length) return "";
    const shown = rows.slice(0, 12), max = shown[0].n;
    const y0 = 470, rh = 82, w = SW - SX * 2;
    return shown.map((r, i) => {
      const y = y0 + i * rh;
      return `${T(SX, y, 24, String(i + 1).padStart(2, "0"), { w: 700, c: C.ink3 })}
        ${T(SX + 56, y, 36, r.name, { w: 700 })}
        ${T(SW - SX, y, 28, `${r.n.toLocaleString("en-US")}`, { a: "end", c: C.ink2 })}
        <rect x="${SX + 56}" y="${y + 16}" width="${Math.max(4, (w - 56) * Math.sqrt(r.n / max)).toFixed(1)}" height="8" fill="${C.run}"/>
        <rect x="${SX}" y="${y + 40}" width="${w}" height="1" fill="${C.ink}" fill-opacity="0.15"/>`;
    }).join("") + (rows.length > shown.length ? T(SX + 56, y0 + shown.length * rh, 28, `+ ${rows.length - shown.length} more ${rows.length - shown.length === 1 ? "country" : "countries"}`, { c: C.ink2 }) : "")
      + T(SX, 400, 32, `${rows.length} ${rows.length === 1 ? "country" : "countries"} · activities in each`, { c: C.ink2 });
  }],

  ["days", "Days", async (s) => {
    // one GitHub-style grid per year (latest five), each day colored by its longest activity's sport
    const days = new Map();
    for (const a of s.acts) {
      const d = day(a), t = a.movingDuration ?? a.duration ?? 0;
      if (!days.has(d) || t > days.get(d).t) days.set(d, { t, g: a.group });
    }
    if (!days.size) return "";
    const years = [...new Set([...days.keys()].map((d) => d.slice(0, 4)))].sort().slice(-5).reverse();
    const step = (SW - SX * 2) / 54, gap = 2.4, cell = step - gap;
    let y = 470;
    const out = [];
    for (const yr of years) {
      const jan1 = new Date(`${yr}-01-01T00:00:00Z`), off = jan1.getUTCDay();
      const n = Object.keys(Object.fromEntries([...days.keys()].filter((d) => d.startsWith(yr)).map((d) => [d, 1]))).length;
      out.push(T(SX, y, 40, yr, { wide: true, ls: -1 }), T(SW - SX, y, 26, `${n} active days`, { a: "end", c: C.ink2 }));
      y += 22;
      for (let i = 0; i < 366; i++) {
        const dt = new Date(jan1.getTime() + i * 864e5);
        if (dt.getUTCFullYear() !== Number(yr)) break;
        const k = dt.toISOString().slice(0, 10), v = days.get(k);
        const col = Math.floor((i + off) / 7), row = (i + off) % 7;
        out.push(`<rect x="${(SX + col * step).toFixed(1)}" y="${(y + row * step).toFixed(1)}" width="${cell}" height="${cell}" fill="${v ? GROUPS[v.g].color : C.paper2}"/>`);
      }
      y += 7 * step + 74;
    }
    // longest streak, over everything
    const sorted = [...days.keys()].sort();
    let best = 1, run = 1;
    for (let i = 1; i < sorted.length; i++) {
      run = (Date.parse(sorted[i]) - Date.parse(sorted[i - 1]) === 864e5) ? run + 1 : 1;
      best = Math.max(best, run);
    }
    out.push(T(SX, 400, 32, `${days.size.toLocaleString("en-US")} active days · longest streak ${best} days`, { c: C.ink2 }));
    return out.join("");
  }],

  ["records", "Records", async (s) => {
    const ok = s.acts.filter((a) => plausible(a, s));
    const best = (list, f) => list.filter((a) => f(a) > 0).sort((a, b) => f(b) - f(a))[0];
    const runs = ok.filter((a) => a.group === "run" && climbOk(a));
    const five = (a) => a.best?.[5000] ?? a.fastestSplit_5000;
    const fast = runs.filter(five).sort((a, b) => five(a) - five(b))[0];
    const years = {};
    for (const a of s.acts) years[a.startTimeLocal.slice(0, 4)] = (years[a.startTimeLocal.slice(0, 4)] ?? 0) + (sane(a) ? a.distance ?? 0 : 0);
    const bigYear = Object.entries(years).sort((a, b) => b[1] - a[1])[0];
    const high = best(s.acts.filter((a) => !s.unranked.has(a.activityId) && a.maxEl < 8850 && climbOk(a) && (plausible(a, s) || a.group === "snow")), (a) => a.maxEl);
    const recs = [
      ["Longest run", best(runs, (a) => a.distance), (a) => fmtMi(a.distance), "run"],
      ["Longest ride", best(ok.filter((a) => a.group === "ride"), (a) => a.distance), (a) => fmtMi(a.distance), "ride"],
      ["Fastest 5K", fast, (a) => fmtClock(five(a)), "run"],
      ["Highest point", high, (a) => fmtFt(a.maxEl), "walk"],
      ["Most climbing", best(ok.filter((a) => climbOk(a) && a.group !== "snow"), (a) => a.elevationGain), (a) => fmtFt(a.elevationGain), "walk"],
      ["Longest day out", best(ok.filter((a) => a.group !== "snow"), (a) => a.movingDuration), (a) => fmtClock(a.movingDuration), "ride"],
    ].filter(([, a]) => a);
    if (bigYear) recs.push(["Biggest year", { y: bigYear[0] }, () => fmtMi(bigYear[1], 0), "gym"]);
    const colW = (SW - SX * 2 - 24) / 2, rowH = 250;
    return recs.map(([label, a, val, g], i) => {
      const x = SX + (i % 2) * (colW + 24), y = 410 + Math.floor(i / 2) * (rowH + 24);
      const sub = a.y ?? `${(a.activityName ?? "").slice(0, 26)}${(a.activityName ?? "").length > 26 ? "…" : ""}`;
      const when = a.y ? "" : fmtDay(day(a));
      return `<rect x="${x}" y="${y}" width="${colW}" height="${rowH}" fill="none" stroke="${C.ink}" stroke-width="3"/>
        <rect x="${x}" y="${y}" width="${colW}" height="10" fill="${GROUPS[g].color}"/>
        ${T(x + 28, y + 66, 24, label.toUpperCase(), { w: 700, ls: 1.5 })}
        ${T(x + 24, y + 150, 64, val(a), { wide: true, ls: -2 })}
        ${T(x + 28, y + 196, 24, sub, { c: C.ink2 })}
        ${when ? T(x + 28, y + 228, 22, when, { c: C.ink3 }) : ""}`;
    }).join("");
  }],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await makeShareImages();
  console.log(`share images: ${DATA}/og.png and ${DATA}/cards/ (${s.title})`);
}
