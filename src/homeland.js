// "Up close": the country with the most activities, broken down further (Places page, under the world map).
// United States: states shaded by activities / distance / active days, then the counties of one state with every
// start as a dot. Activities are placed by testing their start point against the boundaries, so it doesn't rely on
// Garmin's location names. Other countries have no subdivision shapes bundled, so they get the country outline
// with every start as a dot and their places ranked.
import { geoAlbersUsa, geoMercator, geoPath, geoContains, geoBounds, geoCentroid, geoDistance } from "d3-geo";
import { feature } from "topojson-client";
import { fmtDist, flag, RAMP } from "./shared.js";

const METRICS = {
  count: { label: "Activities", bins: [5, 20, 100, 500], fmt: (n) => `${n.toLocaleString()} ${n === 1 ? "activity" : "activities"}` },
  distance: { label: "Distance", bins: [50e3, 250e3, 1000e3, 5000e3], fmt: (m) => fmtDist(m) },
  days: { label: "Active days", bins: [3, 10, 30, 100], fmt: (d) => `${d.toLocaleString()} active ${d === 1 ? "day" : "days"}` },
};
let metric = "count";
let pickedState = null;
let last = null; // the last render's inputs and totals, for re-renders, clicks and tooltips

// ---- US boundaries: loaded on first use (they're ~800 KB) ----
let us = null, usLoading = null;
function loadUS() {
  return (usLoading ??= import("us-atlas/counties-10m.json").then(({ default: topo }) => {
    const prep = (f) => ({ f, id: f.id, name: f.properties.name, box: geoBounds(f), c: geoCentroid(f) });
    const states = feature(topo, topo.objects.states).features.map(prep);
    const counties = feature(topo, topo.objects.counties).features.map(prep);
    const byState = new Map();
    for (const c of counties) {
      const s = c.id.slice(0, 2);
      if (!byState.has(s)) byState.set(s, []);
      byState.get(s).push(c);
    }
    us = {
      nation: feature(topo, topo.objects.nation),
      states, byState,
      stateById: new Map(states.map((s) => [s.id, s])),
      countyById: new Map(counties.map((c) => [c.id, c])),
      at: new Map(), // activityId -> { st, county } | null
    };
  }));
}

// bounding boxes from geoBounds can wrap the antimeridian (Alaska's Aleutians)
function inBox([[x0, y0], [x1, y1]], [x, y], m = 0.02) {
  if (y < y0 - m || y > y1 + m) return false;
  return x0 <= x1 ? x >= x0 - m && x <= x1 + m : x >= x0 - m || x <= x1 + m;
}
// the shape containing p; a start just offshore (beach, pier, ferry) goes to the nearest shape whose box holds it
function within(list, p) {
  const near = list.filter((s) => inBox(s.box, p));
  return near.find((s) => geoContains(s.f, p)) ?? near.sort((a, b) => geoDistance(a.c, p) - geoDistance(b.c, p))[0] ?? null;
}
function locate(a) {
  if (us.at.has(a.activityId)) return us.at.get(a.activityId);
  const p = [a.startLongitude, a.startLatitude];
  const st = within(us.states, p);
  const county = st && within(us.byState.get(st.id) ?? [], p);
  const r = st ? { st: st.id, county: county?.id } : null;
  us.at.set(a.activityId, r);
  return r;
}

// activityId -> { state, county } for US activities (the Story page's "first time in <state>")
export async function usStates(list, placeOf) {
  await loadUS();
  const out = new Map();
  for (const a of list) {
    if (a.startLatitude == null || placeOf.get(a.activityId)?.cc !== "US") continue;
    const r = locate(a);
    if (r) out.set(a.activityId, { state: us.stateById.get(r.st)?.name, county: us.countyById.get(r.county)?.name });
  }
  return out;
}

const value = (t) => (metric === "count" ? t.count : metric === "distance" ? t.distance : t.days.size);
const fmtValue = (t) => METRICS[metric].fmt(value(t));
const fill = (t) => {
  if (!t) return "var(--paper-2)";
  const b = METRICS[metric].bins.findIndex((x) => value(t) < x);
  return RAMP[b === -1 ? RAMP.length - 1 : b];
};
function tally(acts, key) {
  const by = new Map();
  for (const a of acts) {
    const k = key(a);
    if (k == null) continue;
    if (!by.has(k)) by.set(k, { id: k, count: 0, distance: 0, days: new Set(), ids: [] });
    const t = by.get(k);
    t.count++;
    t.distance += a.distance ?? 0;
    t.days.add(a.startTimeLocal.slice(0, 10));
    t.ids.push(a.activityId);
  }
  return by;
}
const ranked = (by) => [...by.values()].sort((a, b) => value(b) - value(a));
const legend = () => {
  const b = METRICS[metric].bins.map((x) => (metric === "distance" ? fmtDist(x).replace(/ \w+$/, "") : x.toLocaleString()));
  const unit = metric === "distance" ? fmtDist(0).split(" ")[1] : "";
  const names = [`< ${b[0]}`, `${b[0]}–${b[1]}`, `${b[1]}–${b[2]}`, `${b[2]}–${b[3]}`, `${b[3]}${unit ? ` ${unit}` : ""} +`];
  return `<div class="ramp-legend">${names.map((n, i) => `<span><i style="background:${RAMP[i]}"></i>${n}</span>`).join("")}<span><i style="background:var(--paper-2)"></i>none</span></div>`;
};
const bars = (rows, attr, name) => {
  const max = Math.max(1, ...rows.map(value));
  return `<ol class="ranks">${rows.map((t) => `<li ${attr}="${t.id}"><span class="rname">${name(t)}</span><span class="rval">${fmtValue(t)}</span><i style="width:${((value(t) / max) * 100).toFixed(1)}%"></i></li>`).join("")}</ol>`;
};
const metricSeg = () => `<div class="seg" role="group" aria-label="Shade by">${Object.entries(METRICS)
  .map(([k, m]) => `<button data-hmetric="${k}" class="${k === metric ? "on" : ""}">${m.label}</button>`).join("")}</div>`;

// host: the section element; list: filtered activities; shapes: world-atlas country features (for the fallback)
export function renderHome(host, { list, placeOf, cc, country, shape }) {
  last = { host, list, placeOf, cc, country, shape };
  if (!cc) return (host.innerHTML = "");
  if (cc !== "US") return renderCountry();
  if (us) return renderUS();
  host.innerHTML = `<h3>${flag(cc)} ${country}, state by state</h3><p class="note loading">Loading state and county lines…</p>`;
  loadUS().then(() => last?.host === host && host.isConnected && renderUS());
}

function renderUS() {
  const { host, list, placeOf } = last;
  const mine = list.filter((a) => a.startLatitude != null && placeOf.get(a.activityId)?.cc === "US");
  const S = tally(mine, (a) => locate(a)?.st);
  const C = tally(mine, (a) => locate(a)?.county);
  const states = ranked(S);
  const st = S.has(pickedState) ? pickedState : states[0]?.id;
  const stName = us.stateById.get(st)?.name;
  const top = states[0];
  last.S = S;
  last.C = C;

  // states
  const W = 960, H = 560;
  const path = geoPath(geoAlbersUsa().fitExtent([[6, 6], [W - 6, H - 6]], us.nation));
  // territories (Puerto Rico, Guam…) fall outside the Albers USA layout and project to nothing
  const statePaths = us.states.map((s) => {
    const t = S.get(s.id), d = path(s.f);
    if (!d) return "";
    return `<path d="${d}" fill="${fill(t)}" class="${t ? "on" : ""}${s.id === st ? " picked" : ""}"${t ? ` data-st="${s.id}"` : ""}/>`;
  }).join("");

  // counties of the picked state, plus every start in it as a dot
  const cs = us.byState.get(st) ?? [];
  const CW = 640, CH = 460;
  const cproj = geoAlbersUsa().fitExtent([[6, 6], [CW - 6, CH - 6]], { type: "FeatureCollection", features: cs.map((c) => c.f) });
  const cpath = geoPath(cproj);
  const countyPaths = cs.map((c) => {
    const t = C.get(c.id), d = cpath(c.f);
    if (!d) return "";
    return `<path d="${d}" fill="${fill(t)}" class="${t ? "on" : ""}"${t ? ` data-county="${c.id}"` : ""}/>`;
  }).join("");
  const byId = new Map(mine.map((a) => [a.activityId, a]));
  const dots = (S.get(st)?.ids ?? []).map((id) => {
    const a = byId.get(id);
    const xy = a && cproj([a.startLongitude, a.startLatitude]);
    return xy ? `<circle cx="${xy[0].toFixed(1)}" cy="${xy[1].toFixed(1)}" r="1.8"/>` : "";
  }).join("");
  const counties = ranked(C).filter((t) => t.id.startsWith(st));

  host.innerHTML = `
    <h3>${flag("US")} United States, state by state</h3>
    <div class="where-top">
      <p class="note">${top ? `Activities in <b>${S.size}</b> ${S.size === 1 ? "state" : "states"} and <b>${C.size}</b> ${C.size === 1 ? "county" : "counties"}, most in <b>${us.stateById.get(top.id).name}</b> (${fmtValue(top)}).` : "No US activities in this selection."}
        <span>Pick a state, on the map or the list, to see its counties.</span></p>
      ${metricSeg()}
    </div>
    <div class="home-grid">
      <svg viewBox="0 0 ${W} ${H}" class="world states" role="img" aria-label="US states shaded by ${METRICS[metric].label.toLowerCase()}">${statePaths}</svg>
      ${bars(states.slice(0, 10), "data-st", (t) => us.stateById.get(t.id).name)}
    </div>
    ${legend()}
    ${st ? `<div class="drill">
      <header><h4>${stName}, county by county</h4><button class="go" data-hshow="st:${st}">Show ${stName} on map →</button></header>
      <div class="home-grid">
        <svg viewBox="0 0 ${CW} ${CH}" class="world counties" role="img" aria-label="${stName} counties">${countyPaths}<g class="dots">${dots}</g></svg>
        ${bars(counties.slice(0, 12), "data-county", (t) => us.countyById.get(t.id).name)}
      </div>
    </div>` : ""}`;
}

// any other country: its outline, every start as a dot, and its places ranked
function renderCountry() {
  const { host, list, placeOf, cc, country, shape } = last;
  const mine = list.filter((a) => a.startLatitude != null && placeOf.get(a.activityId)?.cc === cc);
  const P = tally(mine, (a) => placeOf.get(a.activityId)?.name);
  last.P = P;
  const W = 640, H = 460;
  const proj = geoMercator().fitExtent([[6, 6], [W - 6, H - 6]], shape ?? { type: "MultiPoint", coordinates: mine.map((a) => [a.startLongitude, a.startLatitude]) });
  const dots = mine.map((a) => {
    const [x, y] = proj([a.startLongitude, a.startLatitude]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2"/>`;
  }).join("");
  host.innerHTML = `
    <h3>${flag(cc)} ${country}, up close</h3>
    <div class="where-top"><p class="note"><b>${mine.length.toLocaleString()}</b> activities across <b>${P.size}</b> ${P.size === 1 ? "place" : "places"}.</p>${metricSeg()}</div>
    <div class="home-grid">
      <svg viewBox="0 0 ${W} ${H}" class="world counties" role="img" aria-label="${country} with every activity start">
        ${shape ? `<path d="${geoPath(proj)(shape)}" fill="var(--paper-2)"/>` : ""}<g class="dots">${dots}</g></svg>
      ${bars(ranked(P).slice(0, 12), "data-hplace", (t) => t.id)}
    </div>`;
}

// clicks delegated from where.js; true when handled
export function homeClick(el, showOnMap) {
  if (!last) return false;
  const rerender = () => renderHome(last.host, last);
  if (el.dataset.hmetric) return (metric = el.dataset.hmetric), rerender(), true;
  if (el.dataset.st) return (pickedState = el.dataset.st), rerender(), true;
  if (el.dataset.county) return showOnMap({ ids: last.C.get(el.dataset.county)?.ids ?? [] }), true;
  if (el.dataset.hplace) return showOnMap({ ids: last.P.get(el.dataset.hplace)?.ids ?? [] }), true;
  if (el.dataset.hshow) return showOnMap({ ids: last.S.get(el.dataset.hshow.slice(3))?.ids ?? [] }), true;
  return false;
}

export function homeTip(el) {
  const t = el.dataset.st ? last?.S?.get(el.dataset.st) : el.dataset.county ? last?.C?.get(el.dataset.county) : null;
  if (!t) return null;
  const name = el.dataset.st ? us.stateById.get(t.id).name : `${us.countyById.get(t.id).name}, ${us.stateById.get(t.id.slice(0, 2))?.name}`;
  return `<b>${name}</b><small>${METRICS.count.fmt(t.count)} · ${fmtDist(t.distance)} · ${METRICS.days.fmt(t.days.size)}</small>${el.dataset.st ? "<small>click for its counties</small>" : "<small>click to show on the map</small>"}`;
}
