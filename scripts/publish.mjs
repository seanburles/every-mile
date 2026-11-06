// Build a shareable copy and push it to surge.
//
//   npm run publish                 build + privacy zones + deploy to SURGE_DOMAIN (set in .env)
//   npm run publish -- --domain=my-miles.surge.sh   or name the address here
//   npm run publish -- --no-privacy exact tracks (skip privacy zones)
//   npm run publish -- --dry        build + privacy, don't upload
//   npm run publish -- --no-photos  leave imported photos off the shared copy
//
// Privacy zones work like Strava's: the spots you start from most often get a radius
// around them, and every route's first/last stretch inside that radius is trimmed.
// Only the deployed copy in dist/ is changed; public/data stays exact for local use.
import { execSync } from "node:child_process";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import sharp from "sharp";

try {
  process.loadEnvFile(); // .env is optional here: Strava-only setups may not have one
} catch {}
const DOMAIN = args().find((a) => a.startsWith("--domain="))?.split("=")[1] ?? process.env.SURGE_DOMAIN;
const DIST = "dist";
const DATA = `${DIST}/data`;
const ZONE_RADIUS_M = 500;
const ZONE_MIN_STARTS = 40; // a spot needs this many starts to count as "somewhere you live/work/train"
const MAX_ZONES = 8;
function args() {
  return process.argv.slice(2);
}
if (!DOMAIN && !args().includes("--dry")) {
  console.error("Where to? Add SURGE_DOMAIN=your-name.surge.sh to .env, or pass --domain=your-name.surge.sh (or --dry to only build).");
  process.exit(1);
}

execSync("npx vite build", { stdio: "inherit" });

if (!args().includes("--no-privacy")) await applyPrivacyZones();
if (args().includes("--no-photos")) await dropPhotos();
else await shrinkPhotos();
if (!args().includes("--dry")) execSync(`npx surge ${DIST} ${DOMAIN}`, { stdio: "inherit" });

async function applyPrivacyZones() {
  const activities = JSON.parse(await readFile(`${DATA}/activities.json`, "utf8"));

  // cluster starts within 150 m, keep the busiest spots
  const clusters = [];
  for (const a of activities) {
    if (a.startLatitude == null) continue;
    const p = [a.startLongitude, a.startLatitude];
    const c = clusters.find((c) => meters(c.p, p) < 150);
    if (c) c.n++;
    else clusters.push({ p, n: 1 });
  }
  const zones = clusters
    .filter((c) => c.n >= ZONE_MIN_STARTS)
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_ZONES)
    .map((c) => c.p);
  const inZone = (pt) => zones.some((z) => meters(z, pt) < ZONE_RADIUS_M);
  console.log(`privacy: ${zones.length} zones (${ZONE_RADIUS_M} m)`);

  // trim leading/trailing points that sit inside a zone; returns [from, to) indices to keep
  const keepRange = (coords) => {
    let i = 0, j = coords.length;
    while (i < j && inZone(coords[i])) i++;
    while (j > i && inZone(coords[j - 1])) j--;
    return [i, j];
  };

  const routes = JSON.parse(await readFile(`${DATA}/routes.geojson`, "utf8"));
  routes.features = routes.features.filter((f) => {
    const [i, j] = keepRange(f.geometry.coordinates);
    f.geometry.coordinates = f.geometry.coordinates.slice(i, j);
    return f.geometry.coordinates.length > 1;
  });
  await writeFile(`${DATA}/routes.geojson`, JSON.stringify(routes));

  const firstPoint = new Map();
  let trimmed = 0;
  for (const name of await readdir(`${DATA}/tracks`)) {
    const file = `${DATA}/tracks/${name}`;
    const t = JSON.parse(await readFile(file, "utf8"));
    const [i, j] = keepRange(t.c);
    if (i === 0 && j === t.c.length) {
      firstPoint.set(Number(name.replace(".json", "")), t.c[0]);
      continue;
    }
    trimmed++;
    for (const k of ["c", "t", "d", "alt", "hr"]) t[k] = t[k].slice(i, j);
    if (t.c.length) firstPoint.set(Number(name.replace(".json", "")), t.c[0]);
    await writeFile(file, JSON.stringify(t));
  }

  // start dots move to where the visible route begins; end coordinates aren't used by the app, so drop them
  for (const a of activities) {
    delete a.endLatitude;
    delete a.endLongitude;
    if (a.startLatitude == null || !inZone([a.startLongitude, a.startLatitude])) continue;
    const p = firstPoint.get(a.activityId);
    if (p && !inZone(p)) [a.startLongitude, a.startLatitude] = p;
    else a.startLatitude = a.startLongitude = null;
  }
  await writeFile(`${DATA}/activities.json`, JSON.stringify(activities));
  console.log(`privacy: trimmed ${trimmed} tracks`);
}

// surge's free plan refuses big sites; web-sized copies (1000 px / 240 px thumbs) are ~3× smaller
async function shrinkPhotos() {
  const dir = `${DATA}/photos`;
  let before = 0, after = 0;
  for (const id of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(`${dir}/${id}`)) {
      const file = `${dir}/${id}/${f}`;
      const thumb = f.endsWith("-t.jpg");
      const input = await readFile(file);
      const out = await sharp(input).resize(thumb ? 240 : 1000, thumb ? 240 : 1000, { fit: thumb ? "cover" : "inside", withoutEnlargement: true })
        .jpeg({ quality: thumb ? 60 : 62, mozjpeg: true }).toBuffer();
      before += input.length;
      after += out.length;
      await writeFile(file, out);
    }
  }
  if (before) console.log(`photos: ${(before / 1e6).toFixed(0)} MB -> ${(after / 1e6).toFixed(0)} MB`);
}

async function dropPhotos() {
  await rm(`${DATA}/photos`, { recursive: true, force: true });
  const activities = JSON.parse(await readFile(`${DATA}/activities.json`, "utf8"));
  for (const a of activities) delete a.photos;
  await writeFile(`${DATA}/activities.json`, JSON.stringify(activities));
  console.log("photos: left out");
}

function meters([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}
