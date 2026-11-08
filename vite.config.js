import { readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { extname } from "node:path";

const OVERRIDES = "public/data/overrides.json";
const UNRANKED = "public/data/unranked.json";
const PROFILE = "public/data/profile.json";
const DEMO = ".cache/imports/demo";
const DEMO_BACKUP = ".cache/demo-backup";

const readJson = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
};
const sendJson = (res, data) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
};

// public/data is rewritten by builds while the dev server runs, and Vite only serves public files it saw at startup:
// serve that folder straight from disk instead, so new files (share cards, a fresh import) show up on reload
const TYPES = { ".json": "application/json", ".geojson": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const liveData = {
  name: "live-data",
  configureServer(server) {
    server.middlewares.use("/data", async (req, res, next) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      if (req.method !== "GET" || rel.includes("..")) return next();
      const file = `public/data${rel}`;
      const body = await readFile(file).catch(() => null);
      if (!body) return next();
      res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.end(body);
    });
  },
};

// Tiny dev-only endpoint so sport corrections made in the UI land in a file,
// survive re-syncs, and can be read by scripts. The Garmin API itself is read-only.
const overrides = {
  name: "overrides",
  configureServer(server) {
    server.middlewares.use("/api/override", async (req, res) => {
      if (req.method !== "POST") return (res.statusCode = 405), res.end();
      const { id, type } = await readJson(req);
      const all = JSON.parse(await readFile(OVERRIDES, "utf8").catch(() => "{}"));
      if (type) all[id] = type;
      else delete all[id];
      await writeFile(OVERRIDES, JSON.stringify(all, null, 2));
      sendJson(res, all);
    });
    // activities left out of records and firsts (the card's "Leave out of records")
    server.middlewares.use("/api/unranked", async (req, res) => {
      if (req.method !== "POST") return (res.statusCode = 405), res.end();
      const { id, on } = await readJson(req);
      const ids = new Set(JSON.parse(await readFile(UNRANKED, "utf8").catch(() => "[]")));
      if (on) ids.add(id);
      else ids.delete(id);
      await writeFile(UNRANKED, JSON.stringify([...ids], null, 2));
      sendJson(res, [...ids]);
    });
  },
};

// The in-app setup wizard (src/wizard.js) talks to these. Dev server only: they write .env, save uploads and run
// the same scripts as `npm run setup`, streaming their output back so the page can show progress.
//   POST /api/profile         { name, showName }   -> public/data/profile.json
//   POST /api/setup/garmin    { key }               -> .env, then sync.mjs --routes
//   POST /api/setup/strava    <zip bytes>           -> .cache/uploads/strava.zip, then import.mjs
// The demo athlete is moved aside before a real import and put back if the import fails.
let busy = false;
const setup = {
  name: "setup",
  configureServer(server) {
    server.middlewares.use("/api/profile", async (req, res) => {
      if (req.method !== "POST") return (res.statusCode = 405), res.end();
      const { name = "", showName = false } = await readJson(req);
      await mkdir("public/data", { recursive: true });
      const profile = { name: String(name).trim().slice(0, 80), showName: Boolean(showName) };
      await writeFile(PROFILE, JSON.stringify(profile, null, 2));
      sendJson(res, profile);
    });

    server.middlewares.use("/api/setup", async (req, res) => {
      if (req.method !== "POST") return (res.statusCode = 405), res.end();
      if (busy) return (res.statusCode = 409), res.end("Another import is already running.");
      busy = true;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
      const say = (s) => res.write(`${s}\n`);
      try {
        let args;
        if (req.url.startsWith("/garmin")) {
          const { key } = await readJson(req);
          if (!key?.trim()) throw new Error("No key given.");
          await setEnv("GARMIN_PERSONAL_API_KEY", key.trim());
          say("Key saved to .env");
          args = ["--env-file=.env", "scripts/sync.mjs", "--routes"];
        } else if (req.url.startsWith("/strava")) {
          await mkdir(".cache/uploads", { recursive: true });
          const file = ".cache/uploads/strava.zip";
          say("Receiving your archive…");
          await pipeline(req, createWriteStream(file));
          say("Archive saved");
          args = ["scripts/import.mjs", file];
        } else throw new Error("Unknown setup step.");

        const hadDemo = existsSync(DEMO);
        if (hadDemo) {
          await rm(DEMO_BACKUP, { recursive: true, force: true });
          await rename(DEMO, DEMO_BACKUP);
          say("Demo athlete set aside");
        }
        const code = await run(args, (chunk) => res.write(chunk));
        if (hadDemo && code !== 0) {
          await rename(DEMO_BACKUP, DEMO);
          say("Demo athlete put back");
        } else if (hadDemo) {
          await rm(DEMO_BACKUP, { recursive: true, force: true });
          // the demo's own name card goes with it
          const p = JSON.parse(await readFile(PROFILE, "utf8").catch(() => "{}"));
          if (p.demo) await rm(PROFILE, { force: true });
        }
        res.end(`\n__EXIT ${code}\n`);
      } catch (e) {
        res.end(`${e.message}\n__EXIT 1\n`);
      } finally {
        busy = false;
      }
    });
  },
};

async function setEnv(key, value) {
  const lines = (await readFile(".env", "utf8").catch(() => "")).split("\n").filter((l) => l && !l.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  await writeFile(".env", `${lines.join("\n")}\n`, { mode: 0o600 });
}

function run(args, onData) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export default {
  // relative asset paths: the built dist/ folder works from any address, even a subfolder (example.com/miles/)
  base: "./",
  build: { target: "es2022" },
  plugins: [liveData, overrides, setup],
  // .env holds the Garmin key for the scripts, not settings for the page: keep Vite from reading it, and from
  // restarting when setup writes it
  envDir: "src/env",
  server: {
    // setup and imports rewrite these while the page is open; the wizard reloads the page itself when done
    watch: { ignored: ["**/public/data/**", "**/.cache/**", "**/.env"] },
  },
};
