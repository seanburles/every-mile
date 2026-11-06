// Pull activities (and optionally GPS routes) from the Garmin Personal API
// into public/data so the map can load them as static JSON.
//
//   npm run sync            activity summaries only (fast)
//   npm run sync:routes     + download FIT files, then run build.mjs
//   --routes --max=50       cap how many new FIT files to download this run
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { unzipSync } from "fflate";

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const OUT = "public/data";
const FIT_DIR = ".cache/fit";
const PAGE = 50; // search endpoint 500s above ~60
const args = process.argv.slice(2);
const wantRoutes = args.includes("--routes");
const maxDownloads = Number(args.find((a) => a.startsWith("--max="))?.split("=")[1] ?? Infinity);

const apiKey = process.env.GARMIN_PERSONAL_API_KEY?.trim();
if (!apiKey) throw new Error("Set GARMIN_PERSONAL_API_KEY in .env");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- auth: key -> 24h JWT, cached in .cache/token.json ----
async function getToken() {
  const cache = ".cache/token.json";
  try {
    const t = JSON.parse(await readFile(cache, "utf8"));
    if (t.exp - Date.now() / 1000 > 3600) return t.token;
  } catch {}
  const res = await fetch(BASE + TOKEN_PATH, {
    method: "POST",
    headers: { Accept: "*/*", Authorization: `ApiKey ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} (key wrong or expired?)`);
  const token = (await res.text()).trim();
  const { exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  await mkdir(".cache", { recursive: true });
  await writeFile(cache, JSON.stringify({ token, exp }), { mode: 0o600 });
  return token;
}

const token = await getToken();

async function get(path, params = {}, accept = "application/json") {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: accept, Authorization: `Bearer ${token}` } });
    if (res.ok) return accept.includes("json") ? res.json() : new Uint8Array(await res.arrayBuffer());
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`GET ${path} -> HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ---- activities ----
const KEEP = [
  "activityId", "activityName", "startTimeLocal", "startTimeGMT", "distance", "duration",
  "movingDuration", "elevationGain", "averageSpeed", "maxSpeed", "averageHR", "maxHR",
  "calories", "steps", "startLatitude", "startLongitude", "endLatitude", "endLongitude",
  "locationName", "aerobicTrainingEffect", "activityTrainingLoad", "vO2MaxValue",
  "fastestSplit_1000", "fastestSplit_1609", "fastestSplit_5000", "fastestSplit_10000",
];

function compact(a) {
  const out = {};
  for (const k of KEEP) if (a[k] != null) out[k] = a[k];
  out.type = a.activityType?.typeKey ?? "other";
  out.parentType = a.activityType?.parentTypeId;
  return out;
}

// Incremental: newest-first paging stops once we reach an activity we already have.
// Pass --full to re-pull everything.
let existing = [];
if (!args.includes("--full")) {
  try {
    existing = JSON.parse(await readFile(`${OUT}/activities.json`, "utf8"));
  } catch {}
}
const known = new Set(existing.map((a) => a.activityId));

console.log(existing.length ? `Fetching new activities (have ${existing.length})…` : "Fetching all activities…");
const fresh = [];
for (let start = 0; ; start += PAGE) {
  const page = await get("/activitylist-service/activities/search/activities", { start, limit: PAGE });
  const unseen = page.filter((a) => !known.has(a.activityId));
  fresh.push(...unseen.map(compact));
  process.stdout.write(`\r  ${fresh.length} new`);
  if (page.length < PAGE || unseen.length < page.length) break;
  await sleep(250);
}
console.log();
const activities = [...fresh, ...existing];

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/activities.json`, JSON.stringify(activities));
console.log(`Wrote ${OUT}/activities.json`);

// ---- routes: original FIT -> downsampled LineString ----
if (wantRoutes) {
  await mkdir(FIT_DIR, { recursive: true });
  // imports (Strava, phone files) have negative ids and their own tracks; Garmin has nothing to download for them
  const withGps = activities.filter((a) => a.startLatitude != null && a.activityId > 0);
  let downloaded = 0, attempted = 0, failed = 0;
  for (const [i, a] of withGps.entries()) {
    const file = `${FIT_DIR}/${a.activityId}.fit`;
    if (existsSync(file) || existsSync(`${file}.none`)) continue;
    if (attempted++ >= maxDownloads) break;
    process.stdout.write(`\r  downloading FIT ${i + 1}/${withGps.length}`);
    try {
      const zip = await get(`/download-service/files/activity/${a.activityId}`, {}, "*/*");
      const entries = unzipSync(zip);
      const fit = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith(".fit"));
      if (fit) await writeFile(file, fit[1]);
      downloaded++;
    } catch (e) {
      console.warn(`\n  skip ${a.activityId}: ${e.message.slice(0, 120)}`);
      if (/HTTP 40[34]/.test(e.message)) await writeFile(`${file}.none`, ""); // don't retry forever
      if (++failed >= 10 && downloaded === 0) throw new Error("10 downloads failed in a row; stopping");
    }
    await sleep(400);
  }
  console.log(`\n  ${downloaded} new FIT files`);

  await import("./build.mjs"); // FIT -> routes, tracks, places
}
