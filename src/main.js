import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import {
  GROUPS, groupOf, COLOR, PAPER, INK, EMPTY, $, state, theme, setTheme,
  dist, fmtDist, fmtHours, fmtClock, fmtElev, fmtPace, fmtDate, flag, yearOf, prettyType, climbOk, sane,
} from "./shared.js";
import { createExplorer } from "./explorer.js";
import { createReplay } from "./replay.js";
import { renderDays } from "./days.js";
import { renderStory } from "./story.js";
import { renderShare, cardsOpen, closeCards } from "./share.js";
import { renderWhere, whereClick, whereTip } from "./where.js";

// rebuilt from the live COLOR/INK whenever the theme flips
const colorExpr = () => ["match", ["get", "group"], ...Object.entries(COLOR).flat(), INK];
const VIEWS = ["map", "places", "days", "story", "globe"];

// ---- data ----
const json = (url, fallback) => fetch(url).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
const [rawActivities, routes, places, flags, explorerData, me, unranked] = await Promise.all([
  json("data/activities.json", []),
  json("data/routes.geojson", null),
  json("data/places.json", []),
  json("data/flags.json", {}),
  json("data/explorer.json", null),
  json("data/profile.json", null),
  json("data/unranked.json", []),
]);
let overrides = await json("data/overrides.json", {});

// Sport corrections: a manual override wins, then a sport fixed in another app (Strava), then
// auto-detection (flags.json), then what the watch recorded.
// "recorded" as an override means "the watch was right, ignore the auto-detect".
const SPORT_TYPE = { run: "running", ride: "cycling", walk: "walking", snow: "resort_skiing_snowboarding_ws", water: "open_water_swimming", gym: "other" };
function applySport(a) {
  const o = overrides[a.activityId];
  a.type = o === "recorded" ? a.recordedType : o ?? a.sourceType ?? flags[a.activityId]?.suggest ?? a.recordedType;
  a.group = groupOf(a.type);
}
const activities = rawActivities.map((a) => ({ ...a, recordedType: a.type }));
activities.forEach(applySport);
// activities you've left out of records and firsts (a car ride logged as a run, a glitchy altimeter)
const unrankedIds = new Set(unranked);
for (const a of activities) if (unrankedIds.has(a.activityId)) a.unranked = true;
const byId = new Map(activities.map((a) => [a.activityId, a]));
for (const f of routes?.features ?? []) f.properties.group = byId.get(f.properties.id)?.group ?? "gym";
const routeById = new Map((routes?.features ?? []).map((f) => [f.properties.id, f]));
const placeOf = new Map();
for (const p of places) for (const id of p.ids) placeOf.set(id, p);

const years = [...new Set(activities.map(yearOf))].sort();
$("since").textContent = activities.length ? `${activities.length.toLocaleString()} activities · ${years[0]}–${years.at(-1)}` : "No activities yet";

// whose miles these are, if they chose to show it (profile.json is written by setup)
if (me?.showName && me.name) {
  $("who").textContent = me.name;
  $("who").hidden = false;
  document.title = `${me.name} · Every Mile`;
}

// Demo data or nothing yet: point at the setup wizard. The wizard needs the dev server, so a published copy of the
// demo only gets the label. Running locally with real data, a quiet Settings link changes the name later.
const isDemo = activities.some((a) => a.source === "demo");
if (isDemo || !activities.length) {
  $("own").hidden = false;
  $("own").innerHTML = `<span>${isDemo ? "You're looking at a <b>demo athlete</b>." : "No activities here yet."}</span>
    ${import.meta.env.DEV ? `<button data-wizard>${isDemo ? "Use your own data →" : "Add your activities →"}</button>` : ""}`;
} else if (import.meta.env.DEV) {
  $("since").insertAdjacentHTML("beforeend", ` · <button class="linkish" data-wizard>Settings</button>`);
}
renderShare($("share"));
const wizard = () => import("./wizard.js").then(({ openWizard }) => openWizard({ profile: me, demo: isDemo }));

// newest first, like the API returns them
const filtered = () =>
  activities.filter((a) => state.groups.has(a.group) && (state.year === "all" || yearOf(a) === state.year) && (!state.photosOnly || a.photos));
const hasPhotos = activities.some((a) => a.photos);

// ---- map ----
function dataBounds() {
  const pts = activities.filter((a) => a.startLatitude != null);
  if (!pts.length) return [[-150, -50], [150, 70]]; // nothing yet: the whole world
  const lngs = pts.map((a) => a.startLongitude), lats = pts.map((a) => a.startLatitude);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}
// keep in sync with the 820px breakpoint in style.css
const wide = () => window.matchMedia("(min-width: 821px)").matches;
const pad = () => ({ top: 60, bottom: 90, right: 60, left: wide() ? 420 : 20 });

const map = new maplibregl.Map({
  container: "map",
  bounds: dataBounds(),
  fitBoundsOptions: { padding: pad() },
  attributionControl: { compact: true },
});
map.setStyle("https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json", { transformStyle: themedStyle });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

const pointsGeo = (list) => ({
  type: "FeatureCollection",
  features: list
    .filter((a) => a.startLatitude != null)
    .map((a) => ({
      type: "Feature",
      properties: { id: a.activityId, group: a.group, photos: a.photos ?? 0 },
      geometry: { type: "Point", coordinates: [a.startLongitude, a.startLatitude] },
    })),
});

const ROUTE_OPACITY = ["interpolate", ["linear"], ["zoom"], 3, 0, 6, 0.6];
const BASE_LAYERS = ["routes", "routes-hit", "heat", "points"];

// Repaint CARTO Positron (no labels) in the theme's tones so the sport colors are the only saturated thing on screen
const BASE = {
  light: { water: "#d7dcd6", waterLine: "#cfd5cf", green: "#ece5d6", building: "#e6dfcf", border: "#b9ad98", road: "#e3dbca" },
  dark: { water: "#0e1719", waterLine: "#132022", green: "#1b1813", building: "#221e18", border: "#4d4539", road: "#29241d" },
};
function basemapPaint({ id, type }) {
  const c = BASE[theme()] ?? BASE.light;
  if (type === "background") return ["background-color", PAPER];
  if (/water/.test(id) && type === "fill") return ["fill-color", c.water];
  if (/water/.test(id) && type === "line") return ["line-color", c.waterLine];
  if (/landcover|park|landuse/.test(id) && type === "fill") return ["fill-color", c.green];
  if (/building/.test(id) && type === "fill") return ["fill-color", c.building];
  if (/boundary/.test(id) && type === "line") return ["line-color", c.border];
  if (type === "line") return ["line-color", c.road];
  return null;
}
// the basemap is painted in the style itself before the first frame (no flash of white in dark mode)...
function themedStyle(_, style) {
  for (const l of style.layers) {
    const p = basemapPaint(l);
    if (p) l.paint = { ...l.paint, [p[0]]: p[1] };
  }
  return style;
}
// ...and repainted in place when the theme flips
function paintBasemap() {
  for (const l of map.getStyle().layers) {
    if (map.getSource(l.source)?.type === "geojson") continue; // ours: paintOverlays
    const p = basemapPaint(l);
    if (p) map.setPaintProperty(l.id, ...p);
  }
}
// our own layers' theme colors, by layer id (explorer and replay layers included when they exist)
function paintOverlays() {
  const dark = theme() === "dark";
  const set = (id, prop, v) => map.getLayer(id) && map.setPaintProperty(id, prop, v);
  set("routes", "line-color", colorExpr());
  set("points", "circle-color", colorExpr());
  set("points", "circle-stroke-color", ["case", [">", ["get", "photos"], 0], INK, PAPER]);
  // dark: the heat glows white-hot instead of burning down to deep red
  set("heat", "heatmap-color", ["interpolate", ["linear"], ["heatmap-density"],
    0, "rgba(0,0,0,0)", 0.1, dark ? "rgba(255,90,46,0.35)" : "rgba(240,68,30,0.35)", 0.45, COLOR.run, 1, dark ? "#ffd9c2" : "#b52a0e"]);
  for (const id of ["preview", "selected-casing", "tour-link", "square-best", "squares-line"]) set(id, "line-color", INK);
  set("selected", "line-color", colorExpr());
  set("tour-history", "line-color", colorExpr());
  set("ends", "circle-color", ["match", ["get", "kind"], "start", PAPER, INK]);
  set("ends", "circle-stroke-color", INK);
  set("cursor", "circle-color", INK);
  set("cursor", "circle-stroke-color", PAPER);
  set("squares", "fill-color", ["case", ["get", "cluster"], COLOR.run, INK]);
}

let mapReady = false, explorer = null, replay = null;
map.on("load", () => {
  mapReady = true;
  map.addSource("points", { type: "geojson", data: pointsGeo(activities) });
  map.addSource("routes", { type: "geojson", data: routes ?? EMPTY });
  for (const s of ["preview", "selected", "ends", "cursor"]) map.addSource(s, { type: "geojson", data: EMPTY });

  if (explorerData) explorer = createExplorer(map, explorerData);

  // routes: on paper, overlapping translucent lines darken where you go most
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": colorExpr(),
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 14, 2.4],
      "line-opacity": ROUTE_OPACITY,
    },
  });
  // invisible fat line so thin routes are easy to hit
  map.addLayer({ id: "routes-hit", type: "line", source: "routes", minzoom: 6, paint: { "line-width": 12, "line-opacity": 0 } });
  // start points: heat at world zoom, dots as you approach a city
  map.addLayer({
    id: "heat",
    type: "heatmap",
    source: "points",
    maxzoom: 9,
    paint: {
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 8, 18],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 8, 1.4],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 9, 0],
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(246,241,231,0)", 0.1, "rgba(240,68,30,0.35)", 0.45, "#f0441e", 1, "#b52a0e",
      ],
    },
  });
  map.addLayer({
    id: "points",
    type: "circle",
    source: "points",
    minzoom: 3,
    paint: {
      "circle-color": colorExpr(),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.5, 14, 5],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 5, 0.9],
      // activities with photos get a dark ring so they're easy to spot
      "circle-stroke-width": ["case", [">", ["get", "photos"], 0], 2.5, 1],
      "circle-stroke-color": ["case", [">", ["get", "photos"], 0], INK, PAPER],
    },
  });
  // hover preview from the chooser list
  map.addLayer({
    id: "preview",
    type: "line",
    source: "preview",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": INK, "line-width": 3 },
  });
  // the selected activity: dark casing + bright line
  map.addLayer({
    id: "selected-casing",
    type: "line",
    source: "selected",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": INK, "line-width": 8 },
  });
  map.addLayer({
    id: "selected",
    type: "line",
    source: "selected",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": colorExpr(), "line-width": 4 },
  });
  map.addLayer({
    id: "ends",
    type: "circle",
    source: "ends",
    paint: {
      "circle-radius": 6,
      "circle-color": ["match", ["get", "kind"], "start", PAPER, INK],
      "circle-stroke-width": 3,
      "circle-stroke-color": INK,
    },
  });
  map.addLayer({
    id: "cursor",
    type: "circle",
    source: "cursor",
    paint: { "circle-radius": 7, "circle-color": INK, "circle-stroke-width": 3, "circle-stroke-color": PAPER },
  });

  replay = createReplay({
    map,
    // chronological, GPS only, respecting the sport/year filters
    list: () => filtered().filter((a) => a.startLatitude != null).reverse(),
    select,
    routeById,
    placeOf,
    playRoute,
    hideLayers: () => setVisible([...BASE_LAYERS, ...(explorer?.layers ?? [])], false),
    showLayers: () => setLayer(state.layer),
    cardPadding,
  });

  paintOverlays();
  map.on("mousemove", onHover);
  map.on("click", onClick);
  map.on("movestart", () => (tip.hidden = true));
  render();
  // a shared link like #map/5356898695 opens straight onto that activity
  const linked = route().id;
  if (linked != null) select(linked, { history: "none", duration: 0 });
});

function setVisible(ids, on) {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

// Routes vs Squares on the map
function setLayer(layer) {
  state.layer = explorer ? layer : "routes";
  if (!mapReady) return;
  setVisible(BASE_LAYERS, state.layer === "routes");
  setVisible(explorer?.layers ?? [], state.layer === "squares");
  renderMapBar();
}

function renderMapBar() {
  const sq = state.layer === "squares";
  const s = sq && explorer ? explorer.update(state.year) : null;
  $("mapbar").innerHTML = `
    <button class="replay" data-replay title="Step through every activity in order">▶ Replay</button>
    ${hasPhotos ? `<button data-photos-only class="${state.photosOnly ? "on" : ""}" title="Only activities with photos">📷 Photos</button>` : ""}
    ${explorer ? `<div class="seg" role="group" aria-label="Map layer">
      <button data-layer="routes" class="${sq ? "" : "on"}">Routes</button><button data-layer="squares" class="${sq ? "on" : ""}">Squares</button>
    </div>` : ""}
    ${s ? `<p class="sqstats"><b>${s.count.toLocaleString()}</b> squares${state.year !== "all" ? ` by end of ${state.year}` : ""} ·
      <b>${s.cluster.length.toLocaleString()}</b> in your cluster ·
      biggest square <button data-best><b>${s.best.size}×${s.best.size}</b></button></p>` : ""}`;
}

// ---- picking: a click in a busy city can land on dozens of routes ----
function hitIds(point) {
  if (state.layer !== "routes" || replay?.active) return [];
  const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
  const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ["routes-hit", "points"] }).map((f) => f.properties.id))];
  return ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.startTimeLocal.localeCompare(a.startTimeLocal));
}

const tip = $("tip");
function onHover(e) {
  const hits = hitIds(e.point);
  map.getCanvas().style.cursor = hits.length ? "pointer" : "";
  if (!hits.length || !$("chooser").hidden) return (tip.hidden = true);
  const a = hits[0];
  tip.hidden = false;
  tip.innerHTML =
    hits.length === 1
      ? `<b>${a.activityName}</b><small>${a.startTimeLocal.slice(0, 10)} · ${fmtDist(a.distance ?? 0, 1)} · ${fmtClock(a.duration ?? 0)}${a.photos ? ` · 📷 ${a.photos}` : ""}</small>`
      : `<b>${hits.length} activities here</b><small>click to choose</small>`;
  tip.style.left = `${e.originalEvent.clientX + 14}px`;
  tip.style.top = `${e.originalEvent.clientY + 14}px`;
}

function onClick(e) {
  const hits = hitIds(e.point);
  closeChooser();
  if (!hits.length) return;
  if (hits.length === 1) return select(hits[0].activityId);
  openChooser(hits, e.originalEvent);
}

function openChooser(hits, ev) {
  const el = $("chooser");
  tip.hidden = true;
  el.innerHTML = `<header>${hits.length} activities here</header><ul>${hits
    .slice(0, 60)
    .map((a) => `<li data-pick="${a.activityId}" style="--c:var(--${a.group})"><i></i><span>${a.activityName}<small>${a.startTimeLocal.slice(0, 10)} · ${fmtDist(a.distance ?? 0, 1)}${a.photos ? ` · 📷 ${a.photos}` : ""}</small></span></li>`)
    .join("")}</ul>${hits.length > 60 ? `<footer>+${hits.length - 60} more · zoom in to narrow down</footer>` : ""}`;
  el.hidden = false;
  el.classList.toggle("sheet", !wide());
  if (!wide()) return (el.style.left = el.style.top = ""); // bottom sheet on phones, see CSS
  // open toward whichever side of the cursor has room, then clamp inside the window
  const { offsetWidth: w, offsetHeight: h } = el;
  const M = 12, vw = window.innerWidth, vh = window.innerHeight;
  let x = ev.clientX + M, y = ev.clientY + M;
  if (x + w > vw - M) x = ev.clientX - w - M;
  if (y + h > vh - M) y = ev.clientY - h - M;
  el.style.left = `${Math.max(M, Math.min(x, vw - w - M))}px`;
  el.style.top = `${Math.max(M, Math.min(y, vh - h - M))}px`;
}
function closeChooser() {
  $("chooser").hidden = true;
  map.getSource("preview")?.setData(EMPTY);
}
$("chooser").addEventListener("mouseover", (e) => {
  const li = e.target.closest("[data-pick]");
  const f = li && routeById.get(Number(li.dataset.pick));
  map.getSource("preview").setData(f ? { type: "FeatureCollection", features: [f] } : EMPTY);
});

// ---- selection: load the detailed track and show the card ----
// history: "push" adds a back-button step (clicks), "replace" just updates the address (arrows, replay),
// "none" leaves it alone (we're responding to the address changing)
let track = null;
async function select(id, { duration = 900, history: mode = replay?.active ? "replace" : "push" } = {}) {
  const a = byId.get(id);
  if (!a) return;
  if (state.view !== "map") setView("map", { push: false });
  state.selected = id;
  setRoute(`map/${id}`, mode);
  track = null;
  closePhoto();
  stopRoute();
  closeChooser();
  map.setPaintProperty("routes", "line-opacity", 0.15);
  showCard(a, null);

  const t = await fetch(`data/tracks/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (state.selected !== id) return; // user moved on while loading
  track = t;
  const coords = t?.c ?? routeById.get(id)?.geometry.coordinates;
  showCard(a, t ?? false);
  if (coords?.length > 1) {
    map.getSource("selected").setData({
      type: "Feature",
      properties: { group: a.group },
      geometry: { type: "LineString", coordinates: coords },
    });
    map.getSource("ends").setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { kind: "end" }, geometry: { type: "Point", coordinates: coords.at(-1) } },
        { type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: coords[0] } },
      ],
    });
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: cardPadding(), maxZoom: 15, duration });
  } else {
    map.getSource("selected").setData(EMPTY);
    map.getSource("ends").setData(EMPTY);
    if (a.startLatitude != null) map.flyTo({ center: [a.startLongitude, a.startLatitude], zoom: 13, duration });
  }
  await new Promise((r) => setTimeout(r, duration));
}

// frame things in whatever space the panel, card and replay controls leave free
function cardPadding() {
  const r = $("card").getBoundingClientRect();
  const vw = window.innerWidth;
  const padding = wide()
    ? { top: 40, bottom: replay?.active ? 130 : 40, left: $("panel").getBoundingClientRect().right + 24, right: $("card").hidden ? 40 : vw - r.left + 24 }
    : (() => {
        // on phones the map ends where the stats sheet begins; the card floats over both
        const m = $("map").getBoundingClientRect();
        return { top: Math.max(20, 70 - m.top), left: 20, right: 20, bottom: Math.min(Math.max(0, $("card").hidden ? 0 : m.bottom - r.top) + 16, m.height - 160) };
      })();
  // if the window is too small for both, let the route sit under the card rather than zoom to nothing
  if (padding.left + padding.right > vw - 120) padding.right = 24;
  return padding;
}

function deselect({ history: mode = "replace" } = {}) {
  if (state.selected != null && state.view === "map") setRoute("map", mode);
  state.selected = null;
  track = null;
  stopRoute();
  $("card").hidden = true;
  if (!mapReady) return;
  for (const s of ["selected", "ends", "cursor"]) map.getSource(s).setData(EMPTY);
  map.setPaintProperty("routes", "line-opacity", ROUTE_OPACITY);
}

function step(dir) {
  if (replay?.active) return replay.step(dir);
  // walk through the filtered activities in time order (list is newest-first)
  const list = filtered().filter((a) => a.startLatitude != null);
  const i = list.findIndex((a) => a.activityId === state.selected);
  const next = list[i - dir];
  if (next) select(next.activityId, { history: "replace" });
}

// t: track object, null while loading, false when there's no track file
function showCard(a, t) {
  const card = $("card");
  const place = placeOf.get(a.activityId);
  const stat = (v, l) => (v ? `<div><b>${v}</b><small>${l}</small></div>` : "");
  card.style.setProperty("--c", `var(--${a.group})`);
  card.innerHTML = `
    <header>
      <span class="tag">${prettyType(a.type)}</span>
      <nav>
        <button data-step="-1" title="Older (←)">‹</button><button data-step="1" title="Newer (→)">›</button><button data-close title="Close (Esc)">×</button>
      </nav>
    </header>
    <div class="body">
    <h3>${a.activityName}</h3>
    <p class="when">${fmtDate(a.startTimeLocal)}${place ? ` · ${flag(place.cc)} ${place.name}` : ""}${a.source ? ` · from ${a.source[0].toUpperCase()}${a.source.slice(1)}` : ""}</p>
    ${sportRow(a)}
    ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}
    ${a.photos ? `<div class="photos">${Array.from({ length: Math.min(a.photos, 4) }, (_, i) => `<button data-photo="${i}" style="background-image:url(data/photos/${a.activityId}/${i}-t.jpg)" aria-label="Photo ${i + 1}">${i === 3 && a.photos > 4 ? `<span>+${a.photos - 4}</span>` : ""}</button>`).join("")}</div>` : ""}
    <div class="stats">
      ${stat(a.distance && fmtDist(a.distance, 2), "distance")}
      ${stat(fmtClock(a.movingDuration ?? a.duration ?? 0), "moving time")}
      ${stat(a.distance && fmtPace(a), a.group === "run" || a.group === "walk" ? "avg pace" : "avg speed")}
      ${stat(a.elevationGain && fmtElev(a.elevationGain), "elevation gain")}
      ${stat(a.averageHR && `${Math.round(a.averageHR)} bpm`, `avg HR${a.maxHR ? ` · max ${Math.round(a.maxHR)}` : ""}`)}
      ${stat(a.calories && Math.round(a.calories).toLocaleString(), "calories")}
    </div>
    <div id="profile" class="profile">${
      t === null ? `<p class="loading">loading track…</p>`
      : t === false && a.startLatitude != null ? `<p class="loading">GPS route not downloaded yet · run <code>npm run sync:routes</code></p>`
      : ""}</div>
    <div class="actions"><button data-share class="share" title="Copy a link straight to this activity">Share</button>${sourceLink(a)}</div>
    </div>`;
  card.hidden = false;
  if (t) drawProfile(t);
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// full-size photo viewer for the selected activity
let lightbox = null;
function openPhoto(i) {
  const a = byId.get(state.selected);
  if (!a?.photos) return;
  lightbox = (i + a.photos) % a.photos;
  const el = $("lightbox");
  el.hidden = false;
  el.innerHTML = `<img src="data/photos/${a.activityId}/${lightbox}.jpg" alt="${esc(a.activityName)}, photo ${lightbox + 1}">
    <div class="lb-bar"><span>${esc(a.activityName)} · ${lightbox + 1} / ${a.photos}</span>
    ${a.photos > 1 ? `<button data-lb="-1" aria-label="Previous photo">‹</button><button data-lb="1" aria-label="Next photo">›</button>` : ""}
    <button data-lb-close aria-label="Close">×</button></div>`;
}
function closePhoto() {
  lightbox = null;
  $("lightbox").hidden = true;
}

function sourceLink(a) {
  const links = [];
  if (!a.source) links.push([`https://connect.garmin.com/modern/activity/${a.activityId}`, "Garmin Connect"]);
  const strava = a.source === "strava" ? a.sourceId : a.links?.strava;
  if (strava) links.push([`https://www.strava.com/activities/${strava}`, "Strava"]);
  return links.map(([href, label]) => `<a class="gc" href="${href}" target="_blank" rel="noopener">Open in ${label} ↗</a>`).join(" ");
}

function sportRow(a) {
  const changed = a.type !== a.recordedType;
  const why = !changed ? "" : overrides[a.activityId] ? "corrected" : a.sourceType ? "set in Strava" : `auto-detected · ${flags[a.activityId]?.laps ?? "several"} lift laps`;
  // the dropdown writes through the Vite dev endpoint, so the published build only shows the note
  const out = a.unranked ? `<small class="unranked">Left out of records</small>` : "";
  if (!import.meta.env.DEV) return changed || out ? `<div class="sport">${changed ? `<small>Recorded as ${prettyType(a.recordedType)} · ${why}</small>` : ""}${out}</div>` : "";
  return `<div class="sport">
    <label>Sport <select data-sport="${a.activityId}">${Object.entries(GROUPS)
      .map(([g, { label }]) => `<option value="${g}" ${a.group === g ? "selected" : ""}>${label}</option>`)
      .join("")}</select></label>
    ${changed ? `<small>Recorded as ${prettyType(a.recordedType)} · ${why}</small>` : ""}
    <label class="rank"><input type="checkbox" data-unrank="${a.activityId}" ${a.unranked ? "checked" : ""} /> Leave out of records</label>
  </div>`;
}

async function setSport(id, g) {
  const a = byId.get(id);
  // no override when the pick matches the default (auto-detected sport, else what the watch recorded);
  // "recorded" pins the watch's sport over a wrong auto-detect
  const auto = groupOf(a.sourceType ?? flags[id]?.suggest ?? a.recordedType);
  const type = g === auto ? null : g === groupOf(a.recordedType) ? "recorded" : SPORT_TYPE[g];
  overrides = await fetch("/api/override", { method: "POST", body: JSON.stringify({ id, type }) }).then((r) => r.json());
  applySport(a);
  const f = routeById.get(id);
  if (f) f.properties.group = a.group;
  if (track) map.getSource("selected").setData({ type: "Feature", properties: { group: a.group }, geometry: { type: "LineString", coordinates: track.c } });
  render();
}

async function setUnranked(id, on) {
  await fetch("/api/unranked", { method: "POST", body: JSON.stringify({ id, on }) });
  byId.get(id).unranked = on || undefined;
  render();
}

// elevation (filled) + heart rate (line) over distance; hover or ▶ moves a marker along the route
let profile = null, routeAnim = null;
function drawProfile(t) {
  const host = $("profile");
  const W = 340, H = 96;
  const xs = t.d.some((v) => v != null) ? t.d : t.t;
  const xMax = Math.max(...xs.filter((v) => v != null)) || 1;
  const X = (i) => ((xs[i] ?? 0) / xMax) * W;
  const scale = (vals) => {
    const v = vals.filter((x) => x != null);
    const lo = Math.min(...v), hi = Math.max(...v);
    return (i) => H - 6 - ((vals[i] - lo) / (hi - lo || 1)) * (H - 18);
  };
  const path = (vals, Y) => vals.map((v, i) => (v == null ? null : `${X(i).toFixed(1)},${Y(i).toFixed(1)}`)).filter(Boolean);
  const hasAlt = t.alt.filter((v) => v != null).length > 1;
  const hasHr = t.hr.filter((v) => v != null).length > 1;
  let svg = "";
  if (hasAlt) svg += `<path class="alt" d="M0,${H} L${path(t.alt, scale(t.alt)).join(" L")} L${W},${H} Z"/>`;
  if (hasHr) svg += `<path class="hr" d="M${path(t.hr, scale(t.hr)).join(" L")}"/>`;
  if (!svg) return (host.innerHTML = "", (profile = null));
  host.innerHTML = `
    <div class="legend">${hasAlt ? "<span class='l-alt'>elevation</span>" : ""}${hasHr ? "<span class='l-hr'>heart rate</span>" : ""}
      <button data-play class="play" title="Play the route">▶ play route</button></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}<line id="scrub" y1="0" y2="${H}" x1="-10" x2="-10"/></svg>
    <div class="readout" id="readout"></div>`;
  const svgEl = host.querySelector("svg");
  const scrub = host.querySelector("#scrub");
  const readout = host.querySelector("#readout");
  const setIdx = (i) => {
    if (i < 0) {
      map.getSource("cursor").setData(EMPTY);
      scrub.setAttribute("x1", -10);
      scrub.setAttribute("x2", -10);
      return (readout.textContent = "");
    }
    scrub.setAttribute("x1", X(i));
    scrub.setAttribute("x2", X(i));
    map.getSource("cursor").setData({ type: "Point", coordinates: t.c[i] });
    readout.textContent = [
      t.d[i] != null ? fmtDist(t.d[i], 2) : null,
      fmtClock(t.t[i]),
      t.alt[i] != null ? fmtElev(t.alt[i]) : null,
      t.hr[i] != null ? `${t.hr[i]} bpm` : null,
    ].filter(Boolean).join(" · ");
  };
  profile = { setIdx, n: xs.length };
  svgEl.addEventListener("pointermove", (e) => {
    stopRoute();
    const r = svgEl.getBoundingClientRect();
    const target = ((e.clientX - r.left) / r.width) * xMax;
    let i = 0;
    while (i < xs.length - 1 && (xs[i] ?? 0) < target) i++;
    setIdx(i);
  });
  svgEl.addEventListener("pointerleave", () => routeAnim || setIdx(-1));
}

// run the marker along the route over `ms`, in step with the profile scrubber
function playRoute(ms = 6000) {
  stopRoute();
  if (!profile) return;
  const { setIdx, n } = profile;
  const t0 = performance.now();
  const tick = (now) => {
    const f = Math.min(1, (now - t0) / ms);
    setIdx(Math.round(f * (n - 1)));
    routeAnim = f < 1 ? requestAnimationFrame(tick) : null;
  };
  routeAnim = requestAnimationFrame(tick);
}
function stopRoute() {
  if (routeAnim) cancelAnimationFrame(routeAnim);
  routeAnim = null;
}

// ---- places poster: every route, one tile per place ----
let posterPlaces = [];
const tileObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      tileObserver.unobserve(e.target);
      drawTile(e.target);
    }
  },
  { rootMargin: "300px" },
);

function placesFor(list) {
  const ids = new Set(list.map((a) => a.activityId));
  return places
    .map((p) => {
      const mine = p.ids.filter((id) => ids.has(id));
      const dates = mine.map((id) => byId.get(id).startTimeLocal).sort();
      return {
        ...p,
        mine,
        count: mine.length,
        distance: mine.reduce((s, id) => s + (byId.get(id).distance ?? 0), 0),
        first: dates[0] ?? p.first,
        last: dates.at(-1) ?? p.last,
      };
    })
    .filter((p) => p.count)
    .sort((a, b) => b.count - a.count);
}

function renderPoster() {
  const ps = placesFor(filtered());
  const countries = new Set(ps.map((p) => p.cc).filter(Boolean));
  const span = (p) => (p.first.slice(0, 4) === p.last.slice(0, 4) ? p.first.slice(0, 4) : `${p.first.slice(0, 4)}–${p.last.slice(2, 4)}`);
  $("places").innerHTML = `
    <header class="pagehead"><div><h2>Places I've<br />been</h2>
      <p class="lede"><b>${ps.length}</b> places in <b>${countries.size}</b> countries · <b>${fmtDist(ps.reduce((s, p) => s + p.distance, 0))}</b></p></div></header>
    <div id="where"></div>
    <h3>Every place</h3>
    <div class="grid">${ps
      .map((p, i) => `<figure data-place="${i}"><canvas width="480" height="480"></canvas><figcaption><b>${p.name}</b><small>${flag(p.cc)} ${p.country}</small><small>${p.count} · ${fmtDist(p.distance)} · ${span(p)}</small></figcaption></figure>`)
      .join("")}</div>`;
  posterPlaces = ps;
  for (const fig of $("places").querySelectorAll("figure")) tileObserver.observe(fig);
  renderWhere($("where"), { all: activities, list: filtered(), placeOf, years });
}

// fit the map to a set of activities (a country, or one stay from the timeline)
function showOnMap({ cc, stay, ids: given }) {
  const ids = given ?? (stay != null ? $("where")._stays[stay].ids : activities.filter((a) => placeOf.get(a.activityId)?.cc === cc).map((a) => a.activityId));
  const pts = ids.flatMap((id) => routeById.get(id)?.geometry.coordinates ?? []);
  for (const id of ids) {
    const a = byId.get(id);
    if (a.startLatitude != null) pts.push([a.startLongitude, a.startLatitude]);
  }
  if (!pts.length) return;
  setView("map");
  const b = pts.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: pad(), maxZoom: 13, duration: 0 });
}

function tileBounds(p) {
  // frame on the middle 96% of points so one epic ride doesn't shrink the whole city
  const k = Math.cos((p.center[1] * Math.PI) / 180);
  const xs = [], ys = [];
  for (const id of p.mine) {
    const f = routeById.get(id);
    const a = byId.get(id);
    const cs = f ? f.geometry.coordinates : a.startLatitude != null ? [[a.startLongitude, a.startLatitude]] : [];
    for (const [x, y] of cs) xs.push(x * k), ys.push(y);
  }
  const q = (arr, f) => arr.sort((a, b) => a - b)[Math.floor((arr.length - 1) * f)];
  const [x0, x1, y0, y1] = [q(xs, 0.02), q(xs, 0.98), q(ys, 0.02), q(ys, 0.98)];
  const span = Math.max(x1 - x0, y1 - y0, 0.01) * 1.12;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { k, span, cx, cy, lngLat: [[(cx - span / 2) / k, cy - span / 2], [(cx + span / 2) / k, cy + span / 2]] };
}

function drawTile(fig) {
  const p = posterPlaces[Number(fig.dataset.place)];
  if (!p) return;
  const canvas = fig.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const { k, span, cx, cy } = tileBounds(p);
  const S = canvas.width;
  const px = (x) => ((x * k - (cx - span / 2)) / span) * S;
  const py = (y) => S - ((y - (cy - span / 2)) / span) * S;

  ctx.clearRect(0, 0, S, S);
  // translucent strokes on paper: well-worn loops build up into solid color
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.globalAlpha = Math.max(0.12, Math.min(0.85, 4 / Math.sqrt(p.count)));
  for (const id of p.mine) {
    const a = byId.get(id);
    const f = routeById.get(id);
    ctx.strokeStyle = ctx.fillStyle = COLOR[a.group];
    if (!f) {
      if (a.startLatitude == null) continue;
      ctx.beginPath();
      ctx.arc(px(a.startLongitude), py(a.startLatitude), 3, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = 2;
    ctx.beginPath();
    f.geometry.coordinates.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
    ctx.stroke();
  }
}

// ---- light / dark ----
const SUN = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3"/></g></svg>`;
const MOON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 10.4A6 6 0 0 1 5.6 2.4a6 6 0 1 0 8 8Z" fill="currentColor"/></svg>`;
function themeButton() {
  const b = document.querySelector("[data-theme-toggle]");
  const dark = theme() === "dark";
  b.innerHTML = dark ? SUN : MOON;
  b.title = dark ? "Light mode" : "Dark mode";
  b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
themeButton();
document.querySelector("[data-theme-toggle]").addEventListener("click", () => setTheme(theme() === "dark" ? "light" : "dark"));
// follow the system setting until someone picks
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let picked = null;
  try { picked = localStorage.getItem("theme"); } catch {}
  if (!picked) {
    setTheme(e.matches ? "dark" : "light");
    try { localStorage.removeItem("theme"); } catch {}
  }
});
window.addEventListener("themechange", () => {
  themeButton();
  if (mapReady) {
    paintBasemap();
    paintOverlays();
  }
  globe?.setTheme();
  renderPage();
});

// ---- pages: each tab is its own URL (#map, #places, #days, #story, #globe) ----
function renderPage() {
  const list = filtered();
  if (state.view === "places") renderPoster();
  if (state.view === "days") renderDays($("days"), { list, years, placeOf });
  if (state.view === "story") renderStory($("story"), { list, placeOf });
  if (state.view === "globe") openGlobe();
}

// the particle globe pulls in three.js, so it only loads the first time someone opens it
let globe = null, globeLoading = null;
async function openGlobe() {
  globeLoading ??= import("./globe.js").then(({ createGlobe }) => (globe = createGlobe($("globe"), { placeOf })));
  await globeLoading;
  if (state.view !== "globe") return;
  globe.setList(filtered().filter((a) => a.startLatitude != null).reverse());
  globe.show();
}

// the address is #<view> or #map/<activity id>
function route() {
  const [view, id] = location.hash.slice(1).split("/");
  return { view: view || "map", id: id && byId.has(Number(id)) ? Number(id) : null };
}
function setRoute(hash, mode) {
  if (mode === "none" || location.hash.slice(1) === hash) return;
  history[mode === "push" ? "pushState" : "replaceState"](null, "", `#${hash}`);
}

async function shareActivity() {
  const a = byId.get(state.selected);
  if (!a) return;
  const url = `${location.origin}${location.pathname}#map/${a.activityId}`;
  const btn = document.querySelector("#card [data-share]");
  // phones get the native share sheet; desktops get the link on the clipboard
  if (navigator.share && !wide()) return navigator.share({ title: a.activityName, url }).catch(() => {});
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "Link copied ✓";
    btn.classList.add("done");
  } catch {
    prompt("Link to this activity", url);
  }
}

function setView(v, { push = true } = {}) {
  if (!VIEWS.includes(v)) v = "map";
  if (v !== "map") {
    replay?.stop();
    deselect({ history: "none" });
  }
  if (v !== "globe") globe?.hide();
  state.view = v;
  document.body.dataset.view = v;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (push && location.hash.slice(1) !== v) history.pushState(null, "", `#${v}`);
  renderPage();
  const page = $(v);
  if (page && v !== "map") page.scrollTop = 0;
  if (v === "map") map.resize();
}
// back / forward: follow the address, including between activities
window.addEventListener("popstate", () => {
  const { view, id } = route();
  setView(view, { push: false });
  if (view !== "map" || !mapReady) return;
  if (id != null && id !== state.selected) select(id, { history: "none" });
  else if (id == null && state.selected != null) deselect({ history: "none" });
});

// ---- panel ----
function render() {
  const list = filtered();
  $("chips").innerHTML = Object.entries(GROUPS)
    .filter(([g]) => activities.some((a) => a.group === g))
    .map(([g, { label }]) => `<button data-group="${g}" class="${state.groups.has(g) ? "on" : ""}" style="--c:var(--${g})"><i></i>${label}</button>`)
    .join("")
    // filters set elsewhere (the map's Photos switch) must stay visible here, or the totals look wrong
    + (state.photosOnly ? `<button data-photos-only class="active-filter" title="Show all activities again">📷 With photos only <b>×</b></button>` : "");
  if (mapReady) map.getSource("points").setData(pointsGeo(list));
  if (mapReady && routes) {
    const ids = new Set(list.map((a) => a.activityId));
    map.getSource("routes").setData({ ...routes, features: routes.features.filter((f) => ids.has(f.properties.id)) });
  }
  if (mapReady) renderMapBar();
  renderPage();

  // totals skip broken recordings and count moving time, not time the app sat open
  const sum = (k) => list.reduce((s, a) => s + (!sane(a) || (k === "elevationGain" && !climbOk(a)) ? 0 : (k === "duration" ? a.movingDuration ?? a.duration : a[k]) ?? 0), 0);
  const ps = placesFor(list);
  const countries = new Set(ps.map((p) => p.cc).filter(Boolean));
  const earth = 40075016;
  const climbed = (state.unit === "mi" ? sum("elevationGain") * 3.281 : sum("elevationGain")).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const laps = sum("distance") / earth;
  $("hero").innerHTML = `
    <span class="big">${Math.round(dist(sum("distance"))).toLocaleString()}<small>${state.unit === "mi" ? "miles" : "km"}</small></span>
    <p>${laps >= 0.1 ? `<b>${laps.toFixed(2)}×</b> around the earth over` : "Across"} <b>${list.length.toLocaleString()}</b> ${list.length === 1 ? "activity" : "activities"}
    and <b>${fmtHours(sum("duration"))}</b>, climbing <b>${climbed} ${state.unit === "mi" ? "ft" : "m"}</b>${sum("elevationGain") > 8849 ? ` (${Math.round(sum("elevationGain") / 8849)} Everests)` : ""}
    through <b>${ps.length}</b> places in <b>${countries.size}</b> ${countries.size === 1 ? "country" : "countries"}.</p>`;

  // year columns, stacked by sport; they ignore the year filter so you can see what you picked against the rest
  const bySport = activities.filter((a) => state.groups.has(a.group) && (!state.photosOnly || a.photos));
  const yearRows = years.map((y) => {
    const ya = bySport.filter((a) => yearOf(a) === y);
    const segs = Object.keys(GROUPS).map((g) => [g, ya.filter((a) => a.group === g).reduce((s, a) => s + (a.distance ?? 0), 0)]);
    return { y, total: segs.reduce((s, [, d]) => s + d, 0), segs };
  });
  const maxYear = Math.max(1, ...yearRows.map((r) => r.total));
  $("byYear").classList.toggle("picked", state.year !== "all");
  $("byYear").innerHTML = yearRows
    .map(({ y, total, segs }) => `<button data-year="${y}" class="${state.year === y ? "on" : ""}" title="${y} · ${fmtDist(total)}"><div class="stack">${segs
      .filter(([, d]) => d)
      .map(([g, d]) => `<span style="--c:var(--${g});height:${(d / maxYear) * 96}px"></span>`)
      .join("")}</div><span class="yr">'${y.slice(2)}</span></button>`)
    .join("");
  const yr = yearRows.find((r) => r.y === state.year);
  $("yearHint").textContent = yr ? `${yr.y} · ${fmtDist(yr.total)} · tap again for all` : "tap a year";

  if (state.selected) showCard(byId.get(state.selected), track ?? false);
}

// ---- events ----
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, li, figure, rect[data-day], path[data-cc], path[data-st], path[data-county], [data-stay], .trow");
  if (!el) return;
  if (el.closest("#where") && whereClick(el, renderPoster, showOnMap)) return;
  if ("wizard" in el.dataset) return wizard();
  if (el.closest("#wizard, #share, #cards")) return; // these handle their own clicks
  if (el.dataset.view) return setView(el.dataset.view);
  if ("replay" in el.dataset) return replay?.start(state.selected);
  if ("sheet" in el.dataset) {
    const min = document.body.classList.toggle("sheet-min");
    el.setAttribute("aria-expanded", String(!min));
    el.setAttribute("aria-label", min ? "Show the stats" : "Fold the stats away");
    $("panel").scrollTop = 0;
    return;
  }
  if (el.dataset.layer) return setLayer(el.dataset.layer);
  if ("photosOnly" in el.dataset) {
    state.photosOnly = !state.photosOnly;
    return render();
  }
  if ("best" in el.dataset) return explorer?.bestBounds() && map.fitBounds(explorer.bestBounds(), { padding: pad() });
  if ("play" in el.dataset) return playRoute(6000);
  if (el.dataset.photo) return openPhoto(Number(el.dataset.photo));
  if (el.dataset.lb) return openPhoto(lightbox + Number(el.dataset.lb));
  if ("lbClose" in el.dataset) return closePhoto();
  if (el.dataset.place) {
    const p = posterPlaces[Number(el.dataset.place)];
    setView("map");
    return p && map.fitBounds(tileBounds(p).lngLat, { padding: pad(), duration: 0 });
  }
  if (el.dataset.day) {
    // the day's longest activity
    const acts = filtered().filter((a) => a.startTimeLocal.startsWith(el.dataset.day)).sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    return acts[0] && select(acts[0].activityId);
  }
  if (el.dataset.pick) return select(Number(el.dataset.pick));
  if (el.dataset.step) return step(Number(el.dataset.step));
  if ("close" in el.dataset) return replay?.active ? replay.stop() : deselect();
  if ("share" in el.dataset) return shareActivity();
  if (el.dataset.unit) {
    state.unit = el.dataset.unit;
    document.querySelectorAll(".units button").forEach((b) => b.classList.toggle("on", b === el));
  } else if (el.dataset.group) {
    const g = el.dataset.group;
    // first click isolates a sport; clicking it again restores everything
    if (state.groups.size > 1) state.groups = new Set([g]);
    else if (state.groups.has(g)) state.groups = new Set(Object.keys(GROUPS));
    else state.groups.add(g);
  } else if (el.dataset.year) {
    state.year = state.year === el.dataset.year ? "all" : el.dataset.year;
  } else if (el.dataset.id) {
    return select(Number(el.dataset.id));
  } else return;
  render();
});

// tooltips for day squares (Days) and countries / stays (Places)
document.addEventListener("pointerover", (e) => {
  const w = e.target.closest?.("#where [data-stay], #where path[data-cc], #where path[data-st], #where path[data-county]");
  if (w) {
    tip.innerHTML = whereTip(w, $("where")) ?? "";
    tip.hidden = !tip.innerHTML;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 270)}px`;
    tip.style.top = `${e.clientY + 14}px`;
    return;
  }
  const r = e.target.closest?.("rect[data-day]");
  if (!r) return;
  const acts = filtered().filter((a) => a.startTimeLocal.startsWith(r.dataset.day));
  tip.hidden = false;
  tip.innerHTML = `<b>${fmtDate(r.dataset.day, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</b>${acts
    .map((a) => `<small>${a.activityName} · ${fmtDist(a.distance ?? 0, 1)}</small>`).join("")}`;
  const b = r.getBoundingClientRect();
  tip.style.left = `${Math.min(b.right + 8, window.innerWidth - 270)}px`;
  tip.style.top = `${b.bottom + 8}px`;
});
document.addEventListener("pointerout", (e) => e.target.closest?.("rect[data-day], #where [data-stay], #where path[data-cc], #where path[data-st], #where path[data-county]") && (tip.hidden = true));

$("lightbox").addEventListener("click", (e) => e.target.id === "lightbox" && closePhoto());

document.addEventListener("change", (e) => {
  if (e.target.dataset.sport) setSport(Number(e.target.dataset.sport), e.target.value);
  if (e.target.dataset.unrank) setUnranked(Number(e.target.dataset.unrank), e.target.checked);
});

document.addEventListener("keydown", (e) => {
  if (!$("wizard").hidden) return;
  if (cardsOpen()) return e.key === "Escape" && closeCards();
  if (e.target.closest("input, select, textarea")) return;
  if (lightbox != null) {
    if (e.key === "Escape") return closePhoto();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") return openPhoto(lightbox + (e.key === "ArrowLeft" ? -1 : 1));
  }
  if (e.key === "Escape") {
    if (!$("chooser").hidden) return closeChooser();
    if (replay?.active) return replay.stop();
    if (state.view !== "map") return setView("map");
    return deselect();
  }
  if (e.key === " " && replay?.active) {
    e.preventDefault();
    return replay.toggle();
  }
  if (!state.selected) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

setView(route().view, { push: false });
render();
