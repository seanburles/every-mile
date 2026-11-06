// "Where": a shaded world map (time / activities / distance per country) and a timeline of stays.
// Garmin only knows where you exercised, so presence is estimated: a stay runs from the first to the
// last activity in a country, and the gap before the next country is split down the middle.
import { geoEqualEarth, geoPath, geoGraticule10 } from "d3-geo";
import { feature } from "topojson-client";
import countries from "i18n-iso-countries";
import world from "world-atlas/countries-50m.json";
import { fmtDist, fmtDay, flag, dist, state, RAMP } from "./shared.js";
import { renderHome, homeClick, homeTip } from "./homeland.js";

const DAY = 864e5;
const day = (s) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const shapes = feature(world, world.objects.countries).features;

const METRICS = {
  days: { label: "Time", bins: [7, 30, 90, 365], names: ["< 1 week", "1–4 weeks", "1–3 months", "3–12 months", "1 year +"] },
  count: { label: "Activities", bins: [5, 20, 100, 500], names: ["1–4", "5–19", "20–99", "100–499", "500 +"] },
  distance: { label: "Distance", bins: [50e3, 250e3, 1000e3, 5000e3], names: null },
};
let metric = "days";
let picked = null;

// consecutive activities in the same country form one stay
export function stays(all, placeOf) {
  const asc = all.filter((a) => placeOf.get(a.activityId)?.cc).sort((a, b) => a.startTimeLocal.localeCompare(b.startTimeLocal));
  const out = [];
  for (const a of asc) {
    const p = placeOf.get(a.activityId);
    const last = out.at(-1);
    if (last && last.cc === p.cc) {
      last.end = a.startTimeLocal;
      last.ids.push(a.activityId);
      last.places.add(p.name);
    } else out.push({ cc: p.cc, country: p.country, start: a.startTimeLocal, end: a.startTimeLocal, ids: [a.activityId], places: new Set([p.name]) });
  }
  const today = Date.now();
  out.forEach((s, i) => {
    const prev = out[i - 1], next = out[i + 1];
    s.from = prev ? (day(prev.end) + day(s.start)) / 2 : day(s.start);
    s.to = next ? (day(s.end) + day(next.start)) / 2 : today;
    s.to = Math.max(s.to, s.from + DAY); // a one-day visit still shows up
  });
  return out;
}

function totals(st, list, placeOf, range) {
  const by = new Map();
  const get = (cc, country) => by.get(cc) ?? by.set(cc, { cc, country, days: 0, count: 0, distance: 0, stays: [] }).get(cc);
  for (const s of st) {
    const from = Math.max(s.from, range[0]), to = Math.min(s.to, range[1]);
    if (to <= from) continue;
    const t = get(s.cc, s.country);
    t.days += (to - from) / DAY;
    t.stays.push(s);
  }
  for (const a of list) {
    const p = placeOf.get(a.activityId);
    if (!p?.cc) continue;
    const t = get(p.cc, p.country);
    t.count++;
    t.distance += a.distance ?? 0;
  }
  return [...by.values()].filter((t) => t.days >= 0.5 || t.count);
}

const fmtDays = (d) => (d >= 365 ? `${(d / 365).toFixed(1)} yr` : d >= 60 ? `${Math.round(d / 30.4)} mo` : `${Math.round(d)} ${Math.round(d) === 1 ? "day" : "days"}`);
const value = (t) => (metric === "days" ? t.days : metric === "count" ? t.count : t.distance);
const fmtValue = (t) => (metric === "days" ? `~${fmtDays(t.days)}` : metric === "count" ? `${t.count} activities` : fmtDist(t.distance));
const binOf = (v) => {
  const b = METRICS[metric].bins.findIndex((x) => v < x);
  return b === -1 ? RAMP.length - 1 : b;
};
const binNames = () =>
  METRICS[metric].names ?? ["< ", "", "", "", ""].map((_, i, arr) => {
    const b = METRICS.distance.bins.map((m) => Math.round(dist(m)).toLocaleString());
    return i === 0 ? `< ${b[0]}` : i === arr.length - 1 ? `${b.at(-1)} ${state.unit} +` : `${b[i - 1]}–${b[i]}`;
  });

export function renderWhere(host, { all, list, placeOf, years }) {
  const st = stays(all, placeOf);
  const range = state.year === "all"
    ? [st[0] ? st[0].from : Date.now(), Date.now()]
    : [Date.parse(`${state.year}-01-01T00:00:00Z`), Math.min(Date.parse(`${+state.year + 1}-01-01T00:00:00Z`), Date.now())];
  const tot = totals(st, list, placeOf, range).sort((a, b) => b.days - a.days);
  const byCC = new Map(tot.map((t) => [t.cc, t]));
  const span = (range[1] - range[0]) / DAY;

  // ---- map ----
  const W = 960, H = 470;
  const proj = geoEqualEarth().fitExtent([[4, 4], [W - 4, H - 4]], { type: "Sphere" });
  const path = geoPath(proj);
  const countryPaths = shapes.map((f) => {
    const cc = countries.numericToAlpha2(f.id);
    const t = cc && byCC.get(cc);
    const v = t ? value(t) : 0;
    const fill = v ? RAMP[binOf(v)] : "var(--paper-2)";
    return `<path d="${path(f)}" fill="${fill}" class="${v ? "on" : ""}${cc && cc === picked ? " picked" : ""}"${v ? ` data-cc="${cc}"` : ""}/>`;
  }).join("");

  // ---- timeline ----
  const pct = (t) => (((t - range[0]) / (range[1] - range[0])) * 100).toFixed(3);
  const yearTicks = [];
  for (let y = new Date(range[0]).getUTCFullYear() + 1; Date.parse(`${y}-01-01`) < range[1]; y++) yearTicks.push(y);
  if (state.year !== "all") yearTicks.length = 0;
  const rows = tot.filter((t) => t.stays.length).map((t) => `
    <div class="trow${t.cc === picked ? " picked" : ""}" data-cc="${t.cc}">
      <span class="tname"><span class="fl">${flag(t.cc)}</span>${t.country}</span>
      <span class="track">${t.stays.map((s) => {
        const from = Math.max(s.from, range[0]), to = Math.min(s.to, range[1]);
        return `<i class="stay" data-stay="${st.indexOf(s)}" style="left:${pct(from)}%;width:max(4px, ${(pct(to) - pct(from)).toFixed(3)}%)"></i>`;
      }).join("")}</span>
      <span class="tval">${fmtDays(t.days)}</span>
    </div>`).join("");

  const top = tot[0];
  const det = picked && byCC.get(picked);
  host.innerHTML = `
    <section class="where">
      <h3>The world, by ${METRICS[metric].label.toLowerCase()}</h3>
      <div class="where-top">
        <p class="note">${top ? `About <b>${Math.round((top.days / span) * 100)}%</b> of ${state.year === "all" ? "these years" : state.year} in ${flag(top.cc)} <b>${top.country}</b>, the rest across <b>${tot.length - 1}</b> other ${tot.length - 1 === 1 ? "country" : "countries"}.` : ""}
          <span>Time is estimated from where your activities were.</span></p>
        <div class="seg" role="group" aria-label="Shade countries by">${Object.entries(METRICS)
          .map(([k, m]) => `<button data-metric="${k}" class="${k === metric ? "on" : ""}">${m.label}</button>`).join("")}</div>
      </div>
      <div class="worldwrap">
        <svg viewBox="0 0 ${W} ${H}" class="world">
          <path d="${path({ type: "Sphere" })}" class="sphere"/>
          <path d="${path(geoGraticule10())}" class="graticule"/>
          ${countryPaths}
        </svg>
        ${det ? `<aside class="cdetail">
          <button data-cc-close title="Close">×</button>
          <b>${flag(det.cc)} ${det.country}</b>
          <p>~${fmtDays(det.days)} over ${det.stays.length} ${det.stays.length === 1 ? "stay" : "stays"} · ${det.count} activities · ${fmtDist(det.distance)}</p>
          <ul>${[...new Set(det.stays.flatMap((s) => [...s.places]))].slice(0, 8).map((n) => `<li>${n}</li>`).join("")}</ul>
          <button class="go" data-cc-map="${det.cc}">Show on map →</button>
        </aside>` : ""}
      </div>
      <div class="ramp-legend">${binNames().map((n, i) => `<span><i style="background:${RAMP[i]}"></i>${n}</span>`).join("")}
        <span><i style="background:var(--paper-2)"></i>not visited</span></div>
    </section>
    <section class="where home" id="homeland"></section>
    <section class="where">
      <h3>When you were where</h3>
      <div class="timeline">
        ${rows}
        <div class="trow axis"><span></span><span class="track">${yearTicks.map((y) => `<em style="left:${pct(Date.parse(`${y}-01-01T00:00:00Z`))}%">${y}</em>`).join("")}</span><span></span></div>
      </div>
    </section>`;

  host._stays = st;
  host._tot = byCC;

  // the country with the most activities in this selection, broken down further
  const home = [...tot].sort((a, b) => b.count - a.count)[0];
  renderHome(host.querySelector("#homeland"), {
    list, placeOf, cc: home?.count ? home.cc : null, country: home?.country,
    shape: home && shapes.find((f) => countries.numericToAlpha2(f.id) === home.cc),
  });
}

// interactions are delegated from main.js; these return true when they handled the event
export function whereClick(el, rerender, showOnMap) {
  if (el.closest("#homeland")) return homeClick(el, showOnMap);
  if (el.dataset.metric) return (metric = el.dataset.metric), rerender(), true;
  if ("ccClose" in el.dataset) return (picked = null), rerender(), true;
  if (el.dataset.ccMap) return showOnMap({ cc: el.dataset.ccMap }), true;
  if (el.dataset.stay) return showOnMap({ stay: Number(el.dataset.stay) }), true;
  if (el.dataset.cc) return (picked = picked === el.dataset.cc ? null : el.dataset.cc), rerender(), true;
  return false;
}

export function whereTip(el, host) {
  if (el.dataset.st || el.dataset.county) return homeTip(el);
  const st = host._stays;
  if (el.dataset.stay && st) {
    const s = st[Number(el.dataset.stay)];
    return `<b>${flag(s.cc)} ${s.country}</b><small>${fmtDay(new Date(s.from).toISOString())} – ${fmtDay(new Date(Math.min(s.to, Date.now())).toISOString())} · ~${fmtDays((s.to - s.from) / DAY)}</small><small>${[...s.places].slice(0, 4).join(", ")} · ${s.ids.length} ${s.ids.length === 1 ? "activity" : "activities"}</small>`;
  }
  if (el.dataset.cc && host._tot?.get(el.dataset.cc)) {
    const t = host._tot.get(el.dataset.cc);
    return `<b>${flag(t.cc)} ${t.country}</b><small>~${fmtDays(t.days)} · ${t.count} activities · ${fmtDist(t.distance)}</small>`;
  }
  return null;
}
