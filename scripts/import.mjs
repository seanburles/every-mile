// Import activities from a Strava archive (or any folder of GPX / TCX / FIT files) and merge them
// with the Garmin history. Garmin wins: anything that starts within 5 minutes of a Garmin activity
// with a similar distance is treated as a duplicate and skipped.
//
//   npm run import -- ~/Downloads/export_12345678.zip     Strava archive, zipped
//   npm run import -- ~/Downloads/export_12345678         ...or unzipped
//   npm run import -- ~/Documents/old-runs --source=phone any folder of GPX/TCX/FIT files
//   add --dry to report what would be imported without writing anything
//   add --all-names to also copy Strava's default names ("Morning Run") onto matching Garmin activities
//
// Duplicates aren't thrown away: their Strava name (if you typed one), description, sport and photos
// are carried over to the matching Garmin activity, since Garmin's own names are just "Portland Running".
// Photos are resized for the web and stripped of metadata (phones embed GPS in them).
//
// Output: .cache/imports/<source>/activities.json + tracks/<id>.json, then build.mjs runs.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { gunzipSync } from "fflate";
import { Decoder, Stream } from "@garmin/fitsdk";
import sharp from "sharp";
import { isDefaultName } from "./names.mjs";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry");
const allNames = args.includes("--all-names");
if (!input) throw new Error("Usage: npm run import -- <strava export .zip or folder> [--source=name] [--dry]");
const SC = 180 / 2 ** 31;

// ---- locate the files ----
let root = resolve(input.replace(/^~/, process.env.HOME));
const isZip = root.endsWith(".zip");
const source = args.find((a) => a.startsWith("--source="))?.split("=")[1] ?? (isZip || existsSync(join(root, "activities.csv")) ? "strava" : "files");
if (isZip) {
  // extract only the activity list and GPS files into their own scratch folder (archives also hold photos)
  const dest = `.cache/import-raw/${source}`;
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // media/ holds the photos; -x skips videos, which the app doesn't show
  execFileSync("unzip", ["-q", "-o", root, "activities.csv", "activities/*", "media/*", "-x", "*.mp4", "*.mov", "-d", dest]);
  root = dest;
}
if (!statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);

// ---- what Strava says about each activity ----
const meta = new Map(); // file basename -> row
const csvPath = join(root, "activities.csv");
if (existsSync(csvPath)) {
  const [header, ...rows] = parseCsv(await readFile(csvPath, "utf8"));
  // Strava repeats some column names (two "Distance", two "Elapsed Time"); the later ones are in SI units
  const col = (name, last = false) => (last ? header.lastIndexOf(name) : header.indexOf(name));
  const C = {
    id: col("Activity ID"), date: col("Activity Date"), name: col("Activity Name"), type: col("Activity Type"),
    file: col("Filename"), elapsed: col("Elapsed Time", true), moving: col("Moving Time"), dist: col("Distance", true),
    gain: col("Elevation Gain"), avgHr: col("Average Heart Rate"), maxHr: col("Max Heart Rate", true), cal: col("Calories"),
    desc: col("Activity Description"), media: col("Media"),
  };
  for (const r of rows) {
    const num = (i) => (i >= 0 && r[i] !== "" && !isNaN(+r[i]) ? +r[i] : null);
    meta.set(r[C.file] ? basename(r[C.file]) : `__nofile_${r[C.id]}`, {
      sourceId: r[C.id], name: r[C.name], stravaType: r[C.type], date: r[C.date], file: r[C.file],
      elapsed: num(C.elapsed), moving: num(C.moving), distance: num(C.dist), gain: num(C.gain),
      avgHr: num(C.avgHr), maxHr: num(C.maxHr), calories: num(C.cal),
      description: C.desc >= 0 ? r[C.desc]?.trim() || null : null,
      media: C.media >= 0 && r[C.media] ? r[C.media].split("|").map((x) => x.trim()).filter((x) => /\.(jpe?g|png|webp|heic)$/i.test(x)) : [],
    });
  }
  console.log(`  ${rows.length} activities in activities.csv`);
}

// ---- decode every GPS file ----
const files = await walk(root);
// compare against Garmin's own names, not ones a previous import already swapped in
// (none yet if you only use imports)
const garmin = JSON.parse(await readFile("public/data/activities.json", "utf8").catch(() => "[]")).filter((a) => !a.source)
  .map((g) => (g.garminName ? { ...g, activityName: g.garminName } : g));
const imported = [], tracks = new Map(), matches = {}, photoJobs = [];
let dupes = 0, noGps = 0, failed = 0;
for (const f of files) {
  const m = meta.get(basename(f)) ?? {};
  let parsed;
  try {
    parsed = decode(f, await readFile(f));
  } catch {
    failed++;
    continue;
  }
  const recs = parsed.recs.filter((r) => r.lat != null && r.lng != null && Math.abs(r.lat) <= 90);
  if (recs.length < 2) {
    noGps++;
    continue;
  }
  const a = toActivity(recs, parsed.sport, m, f);
  const g = duplicateOf(a);
  if (g) {
    dupes++;
    match(g, a, m);
    continue;
  }
  imported.push(a);
  tracks.set(a.activityId, recs);
  if (m.media?.length) photoJobs.push([a.activityId, m.media]);
}
// rows Strava has no file for (manual entries) can't go on a map, but they still count toward totals
for (const [k, m] of meta) {
  if (!k.startsWith("__nofile_")) continue;
  const t = stravaDate(m.date);
  if (!t) continue;
  const a = { ...baseActivity(m, sportOf(m.stravaType)), startTimeGMT: iso(t), startTimeLocal: iso(t) };
  const g = duplicateOf(a);
  if (g) match(g, a, m);
  else {
    imported.push(a);
    if (m.media?.length) photoJobs.push([a.activityId, m.media]);
  }
}

imported.sort((a, b) => b.startTimeGMT.localeCompare(a.startTimeGMT));
const before = imported.filter((a) => a.startTimeGMT < (garmin.at(-1)?.startTimeGMT ?? "9999"));
console.log(`  ${imported.length} new activities (${before.length} before your first Garmin one), ${dupes} duplicates of Garmin skipped`);
console.log(`  ${photoJobs.reduce((s, [, m]) => s + m.length, 0)} photos on ${photoJobs.length} activities`);
const named = Object.values(matches).filter((x) => x.name).length;
const resported = Object.values(matches).filter((x) => x.type).length;
const described = Object.values(matches).filter((x) => x.description).length;
console.log(`  ${named} Garmin activities get their Strava name, ${described} a description, ${resported} Strava's sport`);
if (noGps || failed) console.log(`  ${noGps} files without GPS, ${failed} files couldn't be read`);
if (imported.length) console.log(`  oldest: ${imported.at(-1).startTimeLocal.slice(0, 10)} ${imported.at(-1).activityName}`);
if (dry) process.exit(0);

const out = `.cache/imports/${source}`;
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/tracks`, { recursive: true });
await writeFile(`${out}/activities.json`, JSON.stringify(imported));
await writeFile(`${out}/matches.json`, JSON.stringify(matches));
for (const [id, recs] of tracks)
  await writeFile(`${out}/tracks/${id}.json`, JSON.stringify(recs.map((r) => [r.lng, r.lat, r.t, r.d ?? null, r.alt ?? null, r.hr ?? null])));
// photos: <id>/<n>.jpg (max 1400 px) + <n>-t.jpg (360 px square); sharp drops EXIF/GPS unless asked to keep it
let photoCount = 0;
for (const [id, media] of photoJobs) {
  const dir = `${out}/photos/${id}`;
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const rel of media) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    try {
      const img = sharp(file).rotate(); // honour the camera's orientation before the metadata is dropped
      await img.clone().resize(1400, 1400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(`${dir}/${n}.jpg`);
      await img.clone().resize(360, 360, { fit: "cover" }).jpeg({ quality: 72, mozjpeg: true }).toFile(`${dir}/${n}-t.jpg`);
      n++;
      photoCount++;
    } catch {
      // unreadable or unsupported (some HEICs): skip it
    }
  }
  process.stdout.write(`\r  resizing photos ${photoCount}`);
}
if (photoCount) console.log();
console.log(`Saved to ${out}; rebuilding map data…`);
await import("./build.mjs");

// ---------------------------------------------------------------------------

// The Garmin activity this one duplicates, if any. Copies of the same workout don't always start at the
// same moment (a phone and a watch both recording, an app trimming the start), so either:
//   starts within 5 min and distance within 20%, or
//   the two overlap in time / start within 30 min, and the distance agrees within 5%
function ts(s) {
  return Date.parse(s.replace(" ", "T") + "Z");
}
function duplicateOf(a) {
  const t = ts(a.startTimeGMT), end = t + (a.duration ?? 0) * 1000;
  let best = null, bestDt = Infinity;
  for (const g of garmin) {
    if (!g.startTimeGMT) continue;
    const gt = ts(g.startTimeGMT), gEnd = gt + (g.duration ?? 0) * 1000;
    const dt = Math.abs(gt - t);
    if (dt >= bestDt || dt > 6 * 3600e3) continue;
    const ratio = a.distance && g.distance ? Math.abs(a.distance - g.distance) / Math.max(a.distance, g.distance) : a.distance || g.distance ? 1 : 0;
    const overlap = Math.min(end, gEnd) - Math.max(t, gt) > 0;
    const same = (dt <= 5 * 60e3 && (ratio < 0.2 || !a.distance || !g.distance)) || ((overlap || dt <= 30 * 60e3) && ratio < 0.05);
    if (same) (best = g), (bestDt = dt);
  }
  return best;
}

// what a duplicate teaches us about its Garmin twin: a typed name, a corrected sport, its Strava id
function match(g, a, m) {
  const name = m.name?.trim();
  const x = { sourceId: m.sourceId ?? null };
  if (name && name !== g.activityName && (allNames || !isDefaultName(name))) x.name = name;
  if (m.description) x.description = m.description;
  if (m.media?.length) photoJobs.push([g.activityId, m.media]);
  // only when the sports really differ (Strava "Run" vs Garmin "trail_running" isn't a correction)
  const group = (t) => (/running/.test(t) ? "run" : /cycling|biking|e_bike/.test(t) ? "ride" : /walking|hiking/.test(t) ? "walk"
    : /skiing|snowboard/.test(t) ? "snow" : /swim|sail|paddl|row|surf/.test(t) ? "water" : "gym");
  // and never "downgrade" to a sport the app doesn't recognise
  if (m.stravaType && a.type !== "other" && group(a.type) !== group(g.type)) x.type = a.type;
  matches[g.activityId] = x;
}

// Strava sport names, file sport tags and plain guesses -> the Garmin type keys the app understands
function sportOf(name = "") {
  const s = name.toLowerCase().replace(/\s+/g, "");
  if (/trailrun/.test(s)) return "trail_running";
  if (/virtualrun|treadmill/.test(s)) return "treadmill_running";
  if (/run/.test(s)) return "running";
  if (/virtualride|indoor/.test(s)) return "indoor_cycling";
  if (/ebike/.test(s)) return "e_bike_fitness";
  if (/mountainbike|mtb/.test(s)) return "mountain_biking";
  if (/gravel/.test(s)) return "gravel_cycling";
  if (/ride|bik|cycl/.test(s)) return "cycling";
  if (/hike|snowshoe/.test(s)) return "hiking";
  if (/walk/.test(s)) return "walking";
  if (/nordic|crosscountry/.test(s)) return "cross_country_skiing_ws";
  if (/backcountry/.test(s)) return "backcountry_skiing_snowboarding_ws";
  if (/alpine|ski|snowboard/.test(s)) return "resort_skiing_snowboarding_ws";
  if (/swim/.test(s)) return "open_water_swimming";
  if (/kayak|canoe|paddl|row|surf|sail/.test(s)) return "paddling";
  if (/weight|workout|yoga|crossfit|hiit|elliptical|stair/.test(s)) return "strength_training";
  return "other";
}

function baseActivity(m, type) {
  // negative ids can never collide with Garmin's positive ones
  const id = m.sourceId ? -Number(m.sourceId) : -hash(m.file ?? m.name ?? String(Math.random()));
  const a = {
    activityId: id, source, sourceId: m.sourceId ?? null,
    activityName: m.name || `${source[0].toUpperCase()}${source.slice(1)} ${type.replaceAll("_", " ")}`,
    type, distance: m.distance, duration: m.elapsed, movingDuration: m.moving ?? m.elapsed,
    elevationGain: m.gain, averageHR: m.avgHr, maxHR: m.maxHr, calories: m.calories, description: m.description,
  };
  for (const k of Object.keys(a)) if (a[k] == null) delete a[k];
  return a;
}

function toActivity(recs, fileSport, m, file) {
  const t0 = recs[0].t, t1 = recs.at(-1).t;
  // fill distance along the track if the file didn't carry it
  let d = 0;
  for (let i = 0; i < recs.length; i++) {
    if (i) d += meters(recs[i - 1], recs[i]);
    if (recs[i].d == null) recs[i].d = d;
  }
  let gain = 0;
  for (let i = 1, last = recs[0].alt; i < recs.length; i++) {
    // ignore jitter under 3 m so GPS altitude noise doesn't inflate the climb
    if (recs[i].alt == null) continue;
    if (last == null) last = recs[i].alt;
    if (recs[i].alt - last > 3) (gain += recs[i].alt - last), (last = recs[i].alt);
    else if (last - recs[i].alt > 3) last = recs[i].alt;
  }
  const hrs = recs.map((r) => r.hr).filter(Boolean);
  const a = baseActivity({ file, ...m }, sportOf(m.stravaType ?? fileSport ?? basename(file)));
  a.distance ??= Math.round(recs.at(-1).d);
  a.duration ??= Math.round((t1 - t0) / 1000);
  a.movingDuration ??= a.duration;
  if (a.elevationGain == null && gain) a.elevationGain = Math.round(gain);
  if (hrs.length && a.averageHR == null) (a.averageHR = Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length)), (a.maxHR = Math.max(...hrs));
  a.startTimeGMT = iso(t0);
  // the files are in UTC; estimate local time from longitude (15° per hour) since there's no timezone in them
  a.startTimeLocal = iso(t0 + Math.round(recs[0].lng / 15) * 3600e3);
  a.startLatitude = recs[0].lat;
  a.startLongitude = recs[0].lng;
  return a;
}

function decode(file, buf) {
  let name = file.toLowerCase();
  if (name.endsWith(".gz")) (buf = gunzipSync(new Uint8Array(buf))), (name = name.slice(0, -3));
  if (name.endsWith(".fit")) return decodeFit(buf);
  const xml = Buffer.from(buf).toString("utf8").trim();
  if (name.endsWith(".gpx")) return decodeGpx(xml);
  if (name.endsWith(".tcx")) return decodeTcx(xml);
  throw new Error("unknown format");
}

function decodeFit(buf) {
  const { messages } = new Decoder(Stream.fromByteArray(buf)).read();
  return {
    sport: messages.sessionMesgs?.[0]?.sport ?? messages.sportMesgs?.[0]?.sport,
    recs: (messages.recordMesgs ?? []).filter((r) => r.positionLat != null).map((r) => ({
      lng: r.positionLong * SC, lat: r.positionLat * SC, t: new Date(r.timestamp).getTime(),
      d: r.distance, alt: r.enhancedAltitude ?? r.altitude, hr: r.heartRate,
    })),
  };
}

function tag(s, t) {
  return s.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`))?.[1];
}
function decodeGpx(xml) {
  const recs = [];
  for (const m of xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
    const lat = +m[1].match(/lat="([^"]+)"/)?.[1], lng = +m[1].match(/lon="([^"]+)"/)?.[1];
    const time = tag(m[2], "time");
    if (!time || isNaN(lat) || isNaN(lng)) continue;
    recs.push({ lat, lng, t: Date.parse(time), alt: num(tag(m[2], "ele")), hr: num(tag(m[2], "hr")) });
  }
  return { sport: tag(xml, "type"), recs };
}

function decodeTcx(xml) {
  const recs = [];
  for (const m of xml.matchAll(/<Trackpoint>([\s\S]*?)<\/Trackpoint>/g)) {
    const lat = num(tag(m[1], "LatitudeDegrees")), lng = num(tag(m[1], "LongitudeDegrees")), time = tag(m[1], "Time");
    if (lat == null || lng == null || !time) continue;
    const hr = m[1].match(/<HeartRateBpm>\s*<Value>([^<]+)<\/Value>/)?.[1];
    recs.push({ lat, lng, t: Date.parse(time), d: num(tag(m[1], "DistanceMeters")), alt: num(tag(m[1], "AltitudeMeters")), hr: num(hr) });
  }
  return { sport: xml.match(/<Activity Sport="([^"]+)"/)?.[1], recs };
}

// Strava writes "Apr 27, 2016, 4:50:31 PM" in UTC
function stravaDate(s) {
  const t = Date.parse(`${s} UTC`.replace(/, (\d{1,2}:\d{2})/, " $1"));
  return isNaN(t) ? null : t;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(gpx|tcx|fit)(\.gz)?$/i.test(e.name)) out.push(p);
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.length > 1);
}

function meters(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
function num(s) {
  const n = s == null ? NaN : parseFloat(s);
  return isNaN(n) ? null : n;
}
function iso(t) {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}
function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) + 1;
}
