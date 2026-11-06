// First-run setup: get your activities in from Garmin, a Strava export, or both, then `npm run dev`.
//
//   npm run setup
//
// Garmin: asks for your Personal API key, saves it to .env (never committed), and pulls everything.
// Strava: asks for your downloaded archive (.zip or unzipped folder) and imports it.
// Safe to run again: Garmin sync only fetches what's new, and re-importing an archive replaces the old import.
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Node 20.12 or newer is needed (you have ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
// read answers line by line, so typed and piped answers both work
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(q, fallback = "") {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  return (done ? "" : value).trim() || fallback;
}

async function readEnv() {
  return readFile(".env", "utf8").catch(() => "");
}
async function setEnv(key, value) {
  const lines = (await readEnv()).split("\n").filter((l) => l && !l.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  await writeFile(".env", `${lines.join("\n")}\n`, { mode: 0o600 });
}
function run(args) {
  console.log(dim(`\n$ node ${args.join(" ")}\n`));
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nThat step failed (exit ${r.status}). Fix what it says above and run ${b("npm run setup")} again.`);
    process.exit(r.status ?? 1);
  }
}
// a path dragged into the terminal arrives quoted or with escaped spaces
const cleanPath = (p) => resolve(p.trim().replace(/^['"]|['"]$/g, "").replace(/\\ /g, " ").replace(/^~(?=\/)/, process.env.HOME));

console.log(`
${b("Every Mile setup")}
Where are your activities?

  ${b("1")}  Garmin Connect ${dim("(Personal API key: full history, GPS routes, kept up to date)")}
  ${b("2")}  A Strava export ${dim("(the archive Strava emails you: no account linking needed)")}
  ${b("3")}  Both ${dim("(Garmin first; Strava fills in older activities and adds names, photos)")}
`);
const choice = await ask("Pick 1, 2 or 3 [1]: ", "1");
const garmin = choice === "1" || choice === "3";
const strava = choice === "2" || choice === "3";
if (!garmin && !strava) {
  console.error("Please answer 1, 2 or 3.");
  process.exit(1);
}

if (garmin) {
  const has = /^GARMIN_PERSONAL_API_KEY=\S+/m.test(await readEnv());
  if (!has || (await ask("\nA Garmin key is already saved in .env. Replace it? [y/N]: ", "n")).toLowerCase().startsWith("y")) {
    console.log(`
${b("Garmin Personal API key")}
  1. Open ${b("https://connect.garmin.com/app/settings/personalApiToken")} (signed in to Garmin Connect)
  2. Create a key (it can last 30 days to 1 year) and copy it
  ${dim("It's saved to .env in this folder, which is never committed or published.")}
`);
    const key = await ask("Paste your key: ");
    if (!key) {
      console.error("No key entered.");
      process.exit(1);
    }
    await setEnv("GARMIN_PERSONAL_API_KEY", key);
    console.log("Saved to .env");
  }
}

// name on the page (optional): saved in public/data/profile.json, which ships with a published copy
const profilePath = "public/data/profile.json";
const old = JSON.parse(await readFile(profilePath, "utf8").catch(() => "null"));
console.log(`\n${b("Your name")} ${dim("(optional: shown under the title and in the browser tab)")}`);
const name = await ask(`Name${old?.name && !old.demo ? ` [${old.name}]` : ""}: `, old?.demo ? "" : old?.name ?? "");
const showName = name ? !(await ask("Show it on the page? [Y/n]: ", "y")).toLowerCase().startsWith("n") : false;
await mkdir("public/data", { recursive: true });
await writeFile(profilePath, JSON.stringify({ name, showName }, null, 2));

let archive = null;
if (strava) {
  console.log(`
${b("Strava export")}
  Strava → Settings → My Account → ${b("Download or Delete Your Account")} → Request your archive.
  Strava emails a link to a .zip (can take a few hours). Download it, then drag it into this window.
`);
  archive = cleanPath(await ask("Path to the .zip or unzipped folder: "));
  if (!existsSync(archive) || !(archive.endsWith(".zip") || statSync(archive).isDirectory())) {
    console.error(`Couldn't find a .zip or folder at ${archive}`);
    process.exit(1);
  }
}
rl.close();

// swap out the demo athlete (kept aside until the real data is in)
const DEMO = ".cache/imports/demo", DEMO_BACKUP = ".cache/demo-backup";
const hadDemo = existsSync(DEMO);
if (hadDemo) {
  await rm(DEMO_BACKUP, { recursive: true, force: true });
  await rename(DEMO, DEMO_BACKUP);
  process.on("exit", (code) => {
    if (code && existsSync(DEMO_BACKUP)) renameSync(DEMO_BACKUP, DEMO); // failed: put the demo back
  });
}

if (garmin) {
  console.log(`\n${b("Pulling from Garmin.")} The first run downloads a GPS file per activity, so a long history takes a while.`);
  console.log(dim("It's safe to stop (Ctrl+C) and run setup again: it picks up where it left off."));
  run(["--env-file=.env", "scripts/sync.mjs", "--routes"]);
}
if (archive) {
  console.log(`\n${b("Importing your Strava archive.")}`);
  run(["scripts/import.mjs", archive]);
}

if (hadDemo) await rm(DEMO_BACKUP, { recursive: true, force: true });

console.log(`
${b("Done.")} Start the map with:

  ${b("npm run dev")}      then open http://localhost:5173

Later: ${b("npm run sync:routes")} pulls new Garmin activities, ${b("npm run import -- <archive>")} re-imports Strava.
`);
