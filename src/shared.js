// Shared constants, state and formatting for every page.

export const GROUPS = {
  run: { label: "Run", test: (t) => /running/.test(t) },
  ride: { label: "Ride", test: (t) => /cycling|biking|e_bike/.test(t) },
  walk: { label: "Walk/Hike", test: (t) => /walking|hiking/.test(t) },
  snow: { label: "Snow", test: (t) => /skiing|snowboard/.test(t) },
  water: { label: "Water", test: (t) => /swim|sail|paddl|row|surf/.test(t) },
  gym: { label: "Gym", test: () => true },
};
export const groupOf = (type) => Object.keys(GROUPS).find((g) => GROUPS[g].test(type));
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const COLOR = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, css(`--${g}`)]));
export const PAPER = css("--paper"), INK = css("--ink");
export const EMPTY = { type: "FeatureCollection", features: [] };
export const $ = (id) => document.getElementById(id);
// sequential, one hue (paper -> vermilion -> deep red) for shaded maps; bins are fixed and meaningful, not
// quantiles, because one home country (or home state) would swallow any linear scale
export const RAMP = ["#f2d5c4", "#eba584", "#e5704a", "#c9421b", "#842710"];

export const state = { unit: "mi", groups: new Set(Object.keys(GROUPS)), year: "all", selected: null, view: "map", layer: "routes" };

export const dist = (m) => (state.unit === "mi" ? m / 1609.344 : m / 1000);
export const fmtDist = (m, d = 0) => `${dist(m).toLocaleString(undefined, { maximumFractionDigits: d })} ${state.unit}`;
export const fmtHours = (s) => `${Math.round(s / 3600).toLocaleString()} h`;
export const fmtClock = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + `:${String(sec).padStart(2, "0")}`;
};
export const fmtElev = (m) => `${Math.round(state.unit === "mi" ? m * 3.281 : m).toLocaleString()} ${state.unit === "mi" ? "ft" : "m"}`;
// runs and walks read as pace, everything else as speed
export const fmtPace = (a) => {
  const secs = a.movingDuration ?? a.duration;
  if (!a.distance || !secs) return "–";
  if (a.group === "run" || a.group === "walk") return `${fmtClock(secs / dist(a.distance))} /${state.unit}`;
  return `${(dist(a.distance) / (secs / 3600)).toFixed(1)} ${state.unit === "mi" ? "mph" : "km/h"}`;
};
export const fmtDate = (s, opts = { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) =>
  new Date(s.replace(" ", "T")).toLocaleString(undefined, opts);
export const fmtDay = (s) => fmtDate(s, { month: "short", day: "numeric", year: "numeric" });
export const flag = (cc) => (cc ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
export const yearOf = (a) => a.startTimeLocal.slice(0, 4);
export const prettyType = (t) => t.replace(/_(ws|v2)$/, "").replaceAll("_", " ");

// a recording left running for days (phone died, app never stopped) isn't a real activity
export const sane = (a) => (a.movingDuration ?? a.duration ?? 0) <= 30 * 3600;

// GPS left running on a bus makes a 3:00/mi "run"; skip anything faster than humanly possible
export const plausible = (a) => {
  if (a.unranked || !sane(a)) return false;
  const secs = a.movingDuration ?? a.duration;
  if (!a.distance || !secs) return true;
  // on foot: faster than world-record marathon pace (~5.9 m/s) over 10 km+ means wheels were involved
  const foot = a.distance > 10000 ? 6.0 : 6.5;
  return a.distance / secs < (a.group === "run" || a.group === "walk" ? foot : a.group === "ride" ? 17 : 40);
};

// barometer glitches can log 20,000+ ft on a 3-mile run; steep trail running tops out near 200 m per km
export const climbOk = (a) => !a.elevationGain || !a.distance || a.elevationGain / a.distance < 0.2;

// fastest time over a distance inside this activity: computed from the GPS track, else Garmin's own split
export const effort = (a, meters) => a.best?.[meters] ?? (meters === 5000 ? a.fastestSplit_5000 : meters === 10000 ? a.fastestSplit_10000 : undefined);

export function km([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
