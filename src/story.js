// Story: records, how fast you've gotten (best 5K / 10K pace each year) and a timeline of firsts.
import { COLOR, fmtDist, fmtClock, fmtElev, fmtDay, flag, yearOf, plausible, climbOk, effort, dist, state } from "./shared.js";

const KM = 1000;
const runs = (list) => list.filter((a) => a.group === "run" && plausible(a));

function records(list) {
  const best = (arr, key, dir = -1) => arr.filter((a) => a[key]).sort((a, b) => dir * (a[key] - b[key]))[0];
  // lifts do the climbing on snow days, so they don't count for climbing or endurance records
  const ok = list.filter((a) => plausible(a) && a.group !== "snow");
  // GPS-derived efforts, minus runs whose sensors were clearly misbehaving
  const r = runs(list).filter(climbOk);
  const years = {};
  for (const a of list) years[yearOf(a)] = (years[yearOf(a)] ?? 0) + (a.distance ?? 0);
  const bigYear = Object.entries(years).sort((a, b) => b[1] - a[1])[0];
  return [
    ["run", "Longest run", best(r, "distance"), (a) => fmtDist(a.distance, 1)],
    ["ride", "Longest ride", best(ok.filter((a) => a.group === "ride"), "distance"), (a) => fmtDist(a.distance, 1)],
    ...[[1609, "Fastest mile"], [5000, "Fastest 5K"], [10000, "Fastest 10K"], [21097, "Fastest half"]].map(([m, label]) => {
      const a = r.filter((x) => effort(x, m)).sort((x, y) => effort(x, m) - effort(y, m))[0];
      return ["run", label, a, (x) => fmtClock(effort(x, m))];
    }),
    ["walk", "Most climbing", best(ok.filter(climbOk), "elevationGain"), (a) => fmtElev(a.elevationGain)],
    ["ride", "Longest day out", best(ok, "movingDuration"), (a) => fmtClock(a.movingDuration)],
  ].filter(([, , a]) => a).concat(bigYear ? [["gym", "Biggest year", { year: bigYear[0] }, () => fmtDist(bigYear[1])]] : []);
}

function firsts(list, placeOf) {
  const asc = [...list].sort((a, b) => a.startTimeLocal.localeCompare(b.startTimeLocal));
  const out = [];
  const once = (label, pred, extra = () => "") => {
    const a = asc.find(pred);
    if (a) out.push({ a, label, extra: extra(a) });
  };
  if (asc[0]) out.push({ a: asc[0], label: "First activity on record", extra: "" });
  const seen = new Set();
  for (const a of asc) {
    const p = placeOf.get(a.activityId);
    if (!p?.cc || seen.has(p.cc)) continue;
    seen.add(p.cc);
    if (seen.size > 1) out.push({ a, label: `First time in ${flag(p.cc)} ${p.country}`, extra: p.name.split(/ [·(]| - /)[0] });
  }
  const r = (a) => a.group === "run" && plausible(a);
  once("First 10K run", (a) => r(a) && a.distance >= 10 * KM);
  once("First half marathon distance", (a) => r(a) && a.distance >= 21.0975 * KM);
  once("First marathon distance", (a) => r(a) && a.distance >= 42.195 * KM);
  once("First ultra (50K+)", (a) => r(a) && a.distance >= 50 * KM);
  once("First 100 km ride", (a) => a.group === "ride" && plausible(a) && a.distance >= 100 * KM);
  once("First 100 mile ride", (a) => a.group === "ride" && plausible(a) && a.distance >= 160.934 * KM);
  once("First day on snow", (a) => a.group === "snow");
  for (const [secs, label] of [[1500, "25"], [1320, "22"], [1200, "20"], [1140, "19"]])
    once(`First sub-${label} 5K`, (a) => r(a) && climbOk(a) && effort(a, 5000) < secs, (a) => fmtClock(effort(a, 5000)));
  once("First sub-40 10K", (a) => r(a) && climbOk(a) && effort(a, 10000) < 2400, (a) => fmtClock(effort(a, 10000)));
  once(`First ${state.unit === "mi" ? "5,000 ft" : "1,500 m"} climbing day`, (a) => plausible(a) && climbOk(a) && a.group !== "snow" && a.elevationGain >= (state.unit === "mi" ? 1524 : 1500));
  return out.sort((x, y) => x.a.startTimeLocal.localeCompare(y.a.startTimeLocal));
}

// best 5K and 10K pace per year, as seconds per mile/km
function progression(list) {
  const r = runs(list).filter(climbOk);
  const ys = [...new Set(r.filter((a) => effort(a, 5000) || effort(a, 10000)).map(yearOf))].sort();
  const per = (meters) => ys.map((y) => {
    const v = r.filter((a) => yearOf(a) === y && effort(a, meters)).map((a) => effort(a, meters));
    return v.length ? Math.min(...v) / dist(meters) : null;
  });
  return { ys, s5: per(5000), s10: per(10000) };
}

function chart({ ys, s5, s10 }) {
  const vals = [...s5, ...s10].filter((v) => v != null);
  if (ys.length < 2 || !vals.length) return "";
  const W = 720, H = 240, L = 54, R = 70, T = 16, B = 28;
  // round-number ticks: every 30 s, or every minute when the range is wide
  const stepS = Math.max(...vals) - Math.min(...vals) > 150 ? 60 : 30;
  const lo = Math.floor(Math.min(...vals) / stepS) * stepS, hi = Math.ceil(Math.max(...vals) / stepS) * stepS;
  const X = (i) => L + (i / (ys.length - 1)) * (W - L - R);
  const Y = (v) => T + ((v - lo) / (hi - lo || 1)) * (H - T - B); // faster pace sits higher
  const line = (s) => s.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`)).filter(Boolean);
  const ticks = [];
  for (let v = lo; v <= hi; v += stepS) ticks.push(v);
  const last = (s) => { for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return i; return -1; };
  const series = [["5K", s5, COLOR.run], ["10K", s10, "var(--ink)"]];
  return `
    <figure class="prog">
      <figcaption><b>Best race-distance pace, by year</b><span>faster ↑ · fastest 5K and 10K inside any run, from GPS</span>
        <span class="legend-row">${series.map(([n, , c]) => `<span style="--c:${c}"><i></i>${n}</span>`).join("")}</span></figcaption>
      <svg viewBox="0 0 ${W} ${H}" data-chart>
        ${ticks.map((v) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtClock(v)}</text>`).join("")}
        ${ys.map((y, i) => `<text class="ax" x="${X(i)}" y="${H - 8}" text-anchor="middle">'${y.slice(2)}</text>`).join("")}
        ${series.map(([n, s, c]) => {
          const pts = line(s), k = last(s);
          return `<polyline points="${pts.join(" ")}" fill="none" stroke="${c}" stroke-width="2"/>
            ${s.map((v, i) => (v == null ? "" : `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${c}" stroke="var(--paper)" stroke-width="2"/>`)).join("")}
            ${k >= 0 ? `<text class="lbl" x="${X(k) + 10}" y="${Y(s[k]) + 4}">${n} ${fmtClock(s[k])}</text>` : ""}`;
        }).join("")}
        <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" opacity="0"/>
        ${ys.map((y, i) => `<rect class="hit" x="${X(i) - (W - L - R) / (ys.length - 1) / 2}" y="0" width="${(W - L - R) / (ys.length - 1)}" height="${H}"
          data-x="${X(i)}" data-tip="${y} · 5K ${s5[i] ? fmtClock(s5[i]) : "–"} · 10K ${s10[i] ? fmtClock(s10[i]) : "–"} /${state.unit}"/>`).join("")}
      </svg>
    </figure>`;
}

export function renderStory(host, { list, placeOf }) {
  const asc = [...list].sort((a, b) => a.startTimeLocal.localeCompare(b.startTimeLocal));
  const countries = new Set(list.map((a) => placeOf.get(a.activityId)?.cc).filter(Boolean));
  const fs = firsts(list, placeOf);
  let lastYear = "";
  host.innerHTML = `
    <header class="pagehead">
      <div>
        <h2>Story</h2>
        <p class="lede">${asc[0] ? `Since <b>${fmtDay(asc[0].startTimeLocal)}</b>: <b>${list.length.toLocaleString()}</b> activities in <b>${countries.size}</b> ${countries.size === 1 ? "country" : "countries"}.` : "Nothing matches these filters."}</p>
      </div>
    </header>
    <section>
      <h3>Records</h3>
      <div class="recs">${records(list).map(([g, label, a, val]) => `
        <button class="rec" style="--c:var(--${g})" ${a.activityId ? `data-id="${a.activityId}"` : `data-year="${a.year}"`}>
          <small>${label}</small><b>${val(a)}</b><span>${a.activityName ? `${a.activityName} · ${fmtDay(a.startTimeLocal)}` : a.year}</span>
        </button>`).join("")}</div>
    </section>
    <section>
      <h3>Getting faster?</h3>
      ${chart(progression(list)) || `<p class="empty">Needs runs with GPS splits in at least two years.</p>`}
    </section>
    <section>
      <h3>Firsts</h3>
      <ol class="firsts">${fs.map(({ a, label, extra }) => {
        const y = yearOf(a);
        const head = y !== lastYear ? `<li class="fy">${(lastYear = y)}</li>` : "";
        return `${head}<li class="first" data-id="${a.activityId}" style="--c:var(--${a.group})">
          <span class="d">${fmtDay(a.startTimeLocal).replace(/, \d{4}$/, "")}</span>
          <b>${label}</b><small>${extra ? `${extra} · ` : ""}${a.activityName}</small></li>`;
      }).join("")}</ol>
    </section>`;

  // crosshair + tooltip on the progression chart
  const svg = host.querySelector("[data-chart]");
  if (!svg) return;
  const tip = document.getElementById("tip");
  const xhair = svg.querySelector(".xhair");
  svg.addEventListener("pointermove", (e) => {
    const r = e.target.closest(".hit");
    if (!r) return;
    xhair.setAttribute("x1", r.dataset.x);
    xhair.setAttribute("x2", r.dataset.x);
    xhair.setAttribute("opacity", 1);
    tip.hidden = false;
    tip.innerHTML = `<b>${r.dataset.tip}</b>`;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    xhair.setAttribute("opacity", 0);
  });
}
