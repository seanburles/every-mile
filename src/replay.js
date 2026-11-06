// Replay: auto-advance through activities in date order. Each stop opens the activity, flies the
// camera from the previous one (zooming out for long trips), draws a connector between them and
// leaves the route behind, so the map fills in as you go.
import maplibregl from "maplibre-gl";
import { $, COLOR, INK, EMPTY, km, fmtDist, flag } from "./shared.js";

const SPEEDS = { 1: { dwell: 3600, fly: 1 }, 3: { dwell: 1300, fly: 0.6 }, 10: { dwell: 380, fly: 0.25 } };

// great-circle points so long jumps arc the way a flight would
function arc(a, b, steps = 64) {
  const r = Math.PI / 180;
  const [l1, p1, l2, p2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-6) return [a, b];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r]);
  }
  // keep longitudes continuous across the antimeridian
  for (let i = 1; i < pts.length; i++) while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
  for (let i = 1; i < pts.length; i++) while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  return pts;
}

export function createReplay({ map, list, select, routeById, placeOf, playRoute, hideLayers, showLayers, cardPadding }) {
  map.addSource("tour-history", { type: "geojson", data: EMPTY });
  map.addSource("tour-link", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "tour-history", type: "line", source: "tour-history", layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 14, 2.4], "line-opacity": 0.45 } }, "selected-casing");
  map.addLayer({ id: "tour-link", type: "line", source: "tour-link", layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": INK, "line-width": 2, "line-dasharray": [1, 2] } }, "selected-casing");

  const hud = $("tour");
  let items = [], i = -1, playing = false, speed = 1, timer = null, history = [], active = false, total = 0;

  function render() {
    const a = items[i];
    hud.hidden = !active;
    if (!a) return;
    const place = placeOf.get(a.activityId);
    const prev = items[i - 1];
    const jump = prev && a.startLatitude != null && prev.startLatitude != null
      ? km([prev.startLongitude, prev.startLatitude], [a.startLongitude, a.startLatitude]) : 0;
    const prevPlace = prev && placeOf.get(prev.activityId);
    hud.innerHTML = `
      <div class="when"><b>${new Date(a.startTimeLocal.replace(" ", "T")).toLocaleString(undefined, { month: "short", year: "numeric" })}</b>
        <span>${place ? `${flag(place.cc)} ${place.name}` : ""}</span></div>
      <div class="jump">${jump > 50 ? `↗ ${fmtDist(jump * 1000)} from ${prevPlace?.name ?? "the last one"}` : `${i + 1} of ${items.length} · ${fmtDist(total)}`}</div>
      <div class="ctrl">
        <button data-tour="prev" title="Previous">⏮</button>
        <button data-tour="toggle" class="play" title="${playing ? "Pause" : "Play"} (space)">${playing ? "❚❚" : "▶"}</button>
        <button data-tour="next" title="Next">⏭</button>
        <span class="speeds">${Object.keys(SPEEDS).map((s) => `<button data-tour-speed="${s}" class="${+s === speed ? "on" : ""}">${s}×</button>`).join("")}</span>
        <button data-tour="stop" title="End replay (Esc)">✕</button>
      </div>`;
  }

  async function goTo(k, { fromPlay = false } = {}) {
    if (k < 0 || k >= items.length) return stop(k >= items.length);
    clearTimeout(timer);
    const prev = items[i];
    i = k;
    const a = items[i];
    // rebuild history up to (not including) the current stop so prev/next stay consistent
    history = items.slice(0, i).map((x) => routeById.get(x.activityId)).filter(Boolean)
      .map((f) => ({ ...f, properties: { ...f.properties, color: COLOR[f.properties.group] } }));
    map.getSource("tour-history").setData({ type: "FeatureCollection", features: history });
    total = items.slice(0, i + 1).reduce((s, x) => s + (x.distance ?? 0), 0);

    const link = prev && prev !== a && prev.startLatitude != null && a.startLatitude != null
      ? arc([prev.startLongitude, prev.startLatitude], [a.startLongitude, a.startLatitude]) : null;
    map.getSource("tour-link").setData(link ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: link } } : EMPTY);
    render();

    const { fly } = SPEEDS[speed];
    const jump = link ? km(link[0], link.at(-1)) : 0;
    // long trips zoom out first: show where you were and where you're going in one frame
    if (jump > 50 && fly > 0.3) {
      const b = link.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(link[0], link[0]));
      map.fitBounds(b, { padding: cardPadding(), duration: 1400 * fly, maxZoom: 6 });
      await new Promise((r) => setTimeout(r, 1500 * fly));
      if (items[i] !== a) return;
    }
    const duration = (jump > 50 ? 1600 : 800) * fly;
    await select(a.activityId, { duration });
    if (items[i] !== a || !active) return;
    const { dwell } = SPEEDS[speed];
    if (playing) {
      if (speed === 1) playRoute(dwell - 400);
      timer = setTimeout(() => goTo(i + 1, { fromPlay: true }), dwell + (fromPlay ? 0 : 0));
    }
  }

  function start(fromId) {
    items = list();
    if (!items.length) return;
    active = true;
    playing = true;
    const k = Math.max(0, items.findIndex((a) => a.activityId === fromId));
    hideLayers();
    for (const l of ["tour-history", "tour-link"]) map.setLayoutProperty(l, "visibility", "visible");
    document.body.classList.add("touring");
    i = -1;
    goTo(k);
  }

  function stop(finished = false) {
    clearTimeout(timer);
    if (finished && active) {
      // leave the last frame up, paused, so the finished map can be admired
      playing = false;
      return render();
    }
    active = playing = false;
    hud.hidden = true;
    for (const l of ["tour-history", "tour-link"]) map.setLayoutProperty(l, "visibility", "none");
    map.getSource("tour-history").setData(EMPTY);
    map.getSource("tour-link").setData(EMPTY);
    document.body.classList.remove("touring");
    showLayers();
  }

  function toggle() {
    playing = !playing;
    clearTimeout(timer);
    render();
    if (playing) goTo(i + 1, { fromPlay: true });
  }

  hud.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tourSpeed) {
      speed = Number(b.dataset.tourSpeed);
      return render();
    }
    const act = b.dataset.tour;
    if (act === "toggle") toggle();
    if (act === "prev") { playing = false; goTo(i - 1); }
    if (act === "next") { playing = false; goTo(i + 1); }
    if (act === "stop") stop();
  });

  return {
    start,
    stop,
    toggle,
    get active() { return active; },
    step(dir) { playing = false; goTo(i + dir); },
  };
}
