// Days: one row of day-squares per year, colored by the day's main sport, darker for longer days.
import { GROUPS, fmtDist, fmtDay, flag, yearOf } from "./shared.js";

const DAY = 864e5;
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);

function byDay(list) {
  const days = new Map();
  for (const a of list) {
    const k = a.startTimeLocal.slice(0, 10);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(a);
  }
  return days;
}

function streaks(days, today) {
  const keys = [...days.keys()].sort();
  let best = { n: 0 }, run = 0, startK = null, prev = null;
  for (const k of keys) {
    run = prev && utc(k) - utc(prev) === DAY ? run + 1 : 1;
    if (run === 1) startK = k;
    if (run > best.n) best = { n: run, from: startK, to: k };
    prev = k;
  }
  // current streak counts back from today, or from yesterday if today hasn't happened yet
  let cur = 0;
  let d = utc(today);
  if (!days.has(today)) d = new Date(d - DAY);
  for (; days.has(iso(d)); d = new Date(d - DAY)) cur++;
  return { best, cur };
}

function weekly(list) {
  // busiest Monday-starting week by distance
  const weeks = new Map();
  for (const a of list) {
    const d = utc(a.startTimeLocal.slice(0, 10));
    const monday = iso(new Date(d - ((d.getUTCDay() + 6) % 7) * DAY));
    weeks.set(monday, (weeks.get(monday) ?? 0) + (a.distance ?? 0));
  }
  return [...weeks].sort((a, b) => b[1] - a[1])[0];
}

export function renderDays(host, { list, years, placeOf }) {
  const days = byDay(list);
  const today = iso(new Date());
  const { best, cur } = streaks(days, today);
  const top = weekly(list);
  const span = list.length ? Math.round((utc(today) - utc(list.at(-1).startTimeLocal.slice(0, 10))) / DAY) + 1 : 0;
  const dow = [0, 0, 0, 0, 0, 0, 0];
  for (const k of days.keys()) dow[utc(k).getUTCDay()]++;
  const favDay = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][dow.indexOf(Math.max(...dow))];

  // the same calendar date in earlier years
  const md = today.slice(5);
  const onThisDay = [...days].filter(([k]) => k.slice(5) === md && k !== today).sort((a, b) => b[0].localeCompare(a[0]));

  const shownYears = [...new Set(list.map(yearOf))].sort().reverse();
  host.innerHTML = `
    <header class="pagehead">
      <div>
        <h2>Days</h2>
        <p class="lede"><b>${days.size.toLocaleString()}</b> active days out of ${span.toLocaleString()}.
        Longest streak: <b>${best.n} days</b>${best.n > 1 ? ` (${fmtDay(best.from)} – ${fmtDay(best.to)})` : ""}.
        ${cur ? `Current streak: <b>${cur} ${cur === 1 ? "day" : "days"}</b>.` : ""}
        ${top ? `Biggest week: <b>${fmtDist(top[1])}</b> from ${fmtDay(top[0])}.` : ""}
        Favorite day: <b>${favDay}</b>.</p>
      </div>
    </header>
    ${onThisDay.length ? `
      <section class="otd">
        <h3>On this day</h3>
        <div class="otd-row">${onThisDay.map(([k, acts]) => {
          const a = acts.sort((x, y) => (y.duration ?? 0) - (x.duration ?? 0))[0];
          const p = placeOf.get(a.activityId);
          const withPhoto = acts.find((x) => x.photos);
          return `<button class="otd-card${withPhoto ? " has-photo" : ""}" data-id="${a.activityId}" style="--c:var(--${a.group})${withPhoto ? `;--img:url(/data/photos/${withPhoto.activityId}/0-t.jpg)` : ""}">
            <span class="y">${k.slice(0, 4)}</span><b>${a.activityName}</b>
            <small>${fmtDist(a.distance ?? 0, 1)}${p ? ` · ${flag(p.cc)} ${p.name}` : ""}${acts.length > 1 ? ` · +${acts.length - 1} more` : ""}</small></button>`;
        }).join("")}</div>
      </section>` : ""}
    <div class="legend-row">${Object.entries(GROUPS).filter(([g]) => list.some((a) => a.group === g))
      .map(([g, { label }]) => `<span style="--c:var(--${g})"><i></i>${label}</span>`).join("")}
      <span class="scale">shorter <i style="opacity:.35"></i><i style="opacity:.6"></i><i style="opacity:.8"></i><i></i> longer</span></div>
    ${shownYears.map((y) => yearGrid(y, days, list)).join("")}`;
}

function yearGrid(y, days, list) {
  const C = 13, G = 3; // cell, gap
  const jan1 = utc(`${y}-01-01`);
  const offset = (jan1.getUTCDay() + 6) % 7; // Monday-first rows
  const total = list.filter((a) => yearOf(a) === y);
  let cells = "";
  for (let d = jan1; d.getUTCFullYear() === +y; d = new Date(+d + DAY)) {
    const k = iso(d);
    const n = Math.floor((d - jan1) / DAY) + offset;
    const col = Math.floor(n / 7), row = n % 7;
    const acts = days.get(k);
    let fill = "var(--paper-3)", op = 1;
    if (acts) {
      // the day's color is whichever sport took the most time
      const by = {};
      for (const a of acts) by[a.group] = (by[a.group] ?? 0) + (a.duration ?? 0);
      const g = Object.entries(by).sort((a, b) => b[1] - a[1])[0][0];
      const mins = Object.values(by).reduce((s, v) => s + v, 0) / 60;
      fill = `var(--${g})`;
      op = mins < 30 ? 0.35 : mins < 60 ? 0.6 : mins < 120 ? 0.8 : 1;
    }
    cells += `<rect x="${col * (C + G) + 22}" y="${row * (C + G)}" width="${C}" height="${C}" fill="${fill}" fill-opacity="${op}"${acts ? ` data-day="${k}"` : ""}/>`;
  }
  const W = 54 * (C + G) + 22, H = 7 * (C + G);
  const labels = ["M", "", "W", "", "F", "", ""].map((l, r) => (l ? `<text x="0" y="${r * (C + G) + 10}">${l}</text>` : "")).join("");
  return `<section class="year">
    <div class="yhead"><b>${y}</b><span>${total.length} activities · ${fmtDist(total.reduce((s, a) => s + (a.distance ?? 0), 0))}</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="cal">${labels}${cells}</svg>
  </section>`;
}
