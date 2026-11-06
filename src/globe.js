// Globe: the planet and every activity as particles. On first open the globe swirls together while the whole
// history splashes down in a few seconds; "Play journey" lifts everything off and replays it in sped-up real
// time (gaps between activities are real gaps, long empty stretches fast-forward) with the camera following along.
// Loaded lazily from main.js so three.js stays out of the map's bundle.
import * as THREE from "three";
import { geoEquirectangular, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import land from "world-atlas/land-50m.json";
import { css, fmtDist, fmtClock, fmtDay, flag, prettyType } from "./shared.js";

const DAY = 864e5;
const INTRO_SECONDS = 6.5;
const FALL_SEC = 0.55; // wall-clock seconds a particle takes to drop
const SPLASH = 2.2; // ring lifetime, in fall lengths
const CLEAR_SEC = 1.2;
const IMPACTS = 16; // ripple slots on the globe surface
const SPEEDS = [[7, "1 wk/s"], [30, "1 mo/s"], [91, "3 mo/s"]];
const JOURNEY_FALL = 0.8; // a touch slower than the intro, to match the calmer pace
const FOV = 30;

const rgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const RAD = Math.PI / 180;
const dirOf = (lng, lat) => {
  const c = Math.cos(lat * RAD);
  return [c * Math.sin(lng * RAD), Math.sin(lat * RAD), c * Math.cos(lng * RAD)];
};
const lngLatOf = ([x, y, z]) => [Math.atan2(x, z) / RAD, Math.asin(Math.max(-1, Math.min(1, y))) / RAD];
// first index whose value is > v
const upper = (arr, v) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
};
const ease = (t) => 1 - (1 - t) ** 3;
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// land / sea lookup from an equirectangular raster of the coastline
function landMask(W = 2048, H = 1024) {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const proj = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]);
  ctx.beginPath();
  geoPath(proj, ctx)(feature(land, land.objects.land));
  ctx.fill();
  const px = ctx.getImageData(0, 0, W, H).data;
  return (lng, lat) => {
    const x = Math.min(W - 1, Math.floor(((lng + 180) / 360) * W));
    const y = Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
    return px[(y * W + x) * 4 + 3] > 127;
  };
}

// evenly spread points on the unit sphere, nudged a little so the spiral doesn't show up as moiré stripes
function fibonacci(n, keep) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  const jitter = Math.sqrt(4 / n) * 0.45;
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    let p = [Math.cos(g * i) * r + (Math.random() - 0.5) * jitter, y + (Math.random() - 0.5) * jitter, Math.sin(g * i) * r + (Math.random() - 0.5) * jitter];
    const m = Math.hypot(...p);
    p = p.map((v) => v / m);
    if (keep(...lngLatOf(p))) out.push(p);
  }
  return out;
}

const GLOBE_VERT = /* glsl */ `
  uniform float uAssemble, uClock, uPR, uScale, uRef;
  uniform vec3 uCam, uLandCol, uSeaCol;
  uniform vec4 uImp[${IMPACTS}];
  uniform vec3 uImpCol[${IMPACTS}];
  attribute vec3 aScatter;
  attribute float aSeed, aLand;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    // assemble: each dot flies in from a loose cloud, swirling around the axis as it settles
    float t = clamp((uAssemble - aSeed * 0.45) / 0.55, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - t, 3.0);
    vec3 p = mix(aScatter, position, e);
    float a = (1.0 - e) * (1.2 + aSeed * 2.0);
    p = vec3(cos(a) * p.x + sin(a) * p.z, p.y, -sin(a) * p.x + cos(a) * p.z);

    bool isLand = aLand > 0.5;
    vec3 col = isLand ? uLandCol : uSeaCol;
    float size = isLand ? 1.7 : 1.3;
    float base = isLand ? 0.82 : 0.3;

    // ripples from recent splashdowns: a ring of surface dots lifts and takes the sport's color
    float lift = 0.0;
    for (int i = 0; i < ${IMPACTS}; i++) {
      float age = uClock - uImp[i].w;
      if (age < 0.0 || age > 1.4) continue;
      float d = acos(clamp(dot(position, uImp[i].xyz), -1.0, 1.0));
      float ring = exp(-pow((d - 0.012 - age * 0.085) / 0.011, 2.0)) * (1.0 - age / 1.4);
      lift += ring;
      col = mix(col, uImpCol[i], clamp(ring, 0.0, 0.85));
    }
    lift = min(lift, 1.0);
    p *= 1.0 + lift * 0.012;
    size *= 1.0 + lift * 0.6;
    base = max(base, lift);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * uPR * uScale * sqrt(uRef / -mv.z);
    float facing = dot(normalize(p), normalize(uCam - p));
    vAlpha = base * mix(0.07, 1.0, smoothstep(-0.05, 0.25, facing)) * t;
    vColor = col;
  }`;

const DOT_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    if (dot(q, q) > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }`;

const ACT_VERT = /* glsl */ `
  uniform float uNow, uFall, uClear, uPR, uScale, uRef, uHover;
  uniform vec3 uCam;
  attribute vec3 aColor;
  attribute float aDay, aSeed, aIdx;
  varying vec3 vColor;
  varying float vAlpha, vRing, vCore, vHover;
  void main() {
    // k: 0 = starts falling, 1 = touches down on its date, then the splash ring plays out
    float k = (uNow - aDay) / uFall + 1.0;
    vRing = -1.0;
    vHover = 0.0;
    vColor = aColor;
    if (k < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }
    vec3 n = normalize(position);
    float f = min(k, 1.0);
    vec3 p = position * (1.0 + pow(1.0 - f, 2.0) * (0.55 + aSeed * 0.5));
    float alpha = smoothstep(0.0, 0.35, k);
    float px = 3.6;
    if (k >= 1.0 && k < 1.0 + ${SPLASH.toFixed(2)}) {
      vRing = (k - 1.0) / ${SPLASH.toFixed(2)};
      px = 34.0;
    }
    if (abs(aIdx - uHover) < 0.5) {
      vHover = 1.0;
      if (vRing < 0.0) px = 10.0;
    }
    vCore = 0.5 * (vHover > 0.5 ? 5.0 : 3.6) / px;

    // lift-off before a replay: everything drifts up and away
    float c = uClear * uClear;
    vec3 side = normalize(cross(n, vec3(aSeed - 0.5, 0.7, 0.3 - aSeed)));
    p += (n * (0.6 + aSeed) + side * (aSeed - 0.5)) * c * 1.4;
    alpha *= 1.0 - uClear;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = px * uPR * uScale * sqrt(uRef / -mv.z);
    float facing = dot(n, normalize(uCam - p));
    vAlpha = alpha * mix(0.1, 1.0, smoothstep(-0.05, 0.2, facing));
  }`;

const ACT_FRAG = /* glsl */ `
  uniform vec3 uInk;
  varying vec3 vColor;
  varying float vAlpha, vRing, vCore, vHover;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = d < vCore ? 1.0 : 0.0;
    vec3 col = vColor;
    if (vRing >= 0.0) {
      float r = 0.06 + (1.0 - pow(1.0 - vRing, 3.0)) * 0.4;
      a = max(a, smoothstep(0.03, 0.0, abs(d - r)) * (1.0 - vRing) * 0.9);
    }
    if (vHover > 0.5 && d >= vCore && d < vCore + 0.1) {
      col = uInk;
      a = 1.0;
    }
    if (a <= 0.0) discard;
    gl_FragColor = vec4(col, a * vAlpha);
  }`;

export function createGlobe(host, { placeOf }) {
  const INK = rgb(css("--ink")), INK3 = rgb(css("--ink-3"));
  const tip = document.getElementById("tip");

  host.innerHTML = `
    <div class="g-stage"></div>
    <header class="g-head">
      <p class="g-kicker">Every activity, in order</p>
      <b class="g-date"></b>
      <p class="g-count"></p>
    </header>
    <p class="g-hint">Drag to spin · scroll to zoom · tap a dot</p>
    <article class="g-card" hidden></article>
    <div class="g-bar">
      <button class="g-play" data-g-act="toggle"></button>
      <input class="g-scrub" type="range" min="0" max="1000" value="1000" aria-label="Timeline" />
      <div class="g-speeds" role="group" aria-label="Speed">${SPEEDS.map(([, label], i) => `<button data-g-speed="${i}">${label}</button>`).join("")}</div>
    </div>`;
  const q = (s) => host.querySelector(s);
  const elKicker = q(".g-kicker");
  const stage = q(".g-stage"), elDate = q(".g-date"), elCount = q(".g-count"), elPlay = q(".g-play");
  const elScrub = q(".g-scrub"), elCard = q(".g-card");

  // ---- three ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);

  // globe dots: dense on land, sparse and faint at sea so the planet still reads as round
  const isLand = landMask();
  const landPts = fibonacci(210000, isLand);
  const seaPts = fibonacci(30000, (lng, lat) => !isLand(lng, lat));
  const all = [...landPts, ...seaPts];
  const gGeo = new THREE.BufferGeometry();
  const home = new Float32Array(all.length * 3), scatter = new Float32Array(all.length * 3);
  const seed = new Float32Array(all.length), landAttr = new Float32Array(all.length);
  all.forEach((p, i) => {
    home.set(p, i * 3);
    const s = Math.random(), r = 1.4 + Math.random() * 1.3;
    scatter.set([p[0] * r + (Math.random() - 0.5) * 0.8, p[1] * r + (Math.random() - 0.5) * 0.8, p[2] * r + (Math.random() - 0.5) * 0.8], i * 3);
    seed[i] = s;
    landAttr[i] = i < landPts.length ? 1 : 0;
  });
  gGeo.setAttribute("position", new THREE.BufferAttribute(home, 3));
  gGeo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
  gGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  gGeo.setAttribute("aLand", new THREE.BufferAttribute(landAttr, 1));
  const impacts = Array.from({ length: IMPACTS }, () => new THREE.Vector4(0, 0, 1, -100));
  const impactCols = Array.from({ length: IMPACTS }, () => new THREE.Vector3());
  const common = { uPR: { value: 1 }, uScale: { value: 1 }, uRef: { value: 3 }, uCam: { value: new THREE.Vector3() } };
  const gMat = new THREE.ShaderMaterial({
    uniforms: {
      ...common,
      uAssemble: { value: 0 }, uClock: { value: 0 },
      uLandCol: { value: new THREE.Vector3(...INK) }, uSeaCol: { value: new THREE.Vector3(...INK3) },
      uImp: { value: impacts }, uImpCol: { value: impactCols },
    },
    vertexShader: GLOBE_VERT, fragmentShader: DOT_FRAG, transparent: true, depthTest: false, depthWrite: false,
  });
  scene.add(new THREE.Points(gGeo, gMat));

  const aMat = new THREE.ShaderMaterial({
    uniforms: {
      ...common,
      uNow: { value: 0 }, uFall: { value: 1 }, uClear: { value: 0 }, uHover: { value: -1 },
      uInk: { value: new THREE.Vector3(...INK) },
    },
    vertexShader: ACT_VERT, fragmentShader: ACT_FRAG, transparent: true, depthTest: false, depthWrite: false,
  });
  const aPoints = new THREE.Points(new THREE.BufferGeometry(), aMat);
  aPoints.frustumCulled = false;
  scene.add(aPoints);

  // ---- activity data ----
  let realDays = new Float64Array(0), dayAttr = null, shift = 0;
  let acts = [], days = new Float64Array(0), cum = new Float64Array(1), dirs = new Float32Array(0), t0 = 0, span = 1, key = "";
  function setList(list) {
    const k = `${list.length}:${list.reduce((s, a) => s + (a.activityId % 1e6), 0)}`;
    if (k !== key) build(list, k);
    hud(true);
  }
  function build(list, k) {
    const first = !key;
    key = k;
    acts = list;
    const n = list.length;
    t0 = n ? Date.parse(list[0].startTimeLocal.replace(" ", "T") + "Z") : 0;
    days = new Float64Array(n);
    cum = new Float64Array(n + 1);
    dirs = new Float32Array(n * 3);
    const color = new Float32Array(n * 3), s = new Float32Array(n), idx = new Float32Array(n), pos = new Float32Array(n * 3);
    list.forEach((a, i) => {
      days[i] = (Date.parse(a.startTimeLocal.replace(" ", "T") + "Z") - t0) / DAY;
      cum[i + 1] = cum[i] + (a.distance ?? 0);
      const d = dirOf(a.startLongitude, a.startLatitude);
      dirs.set(d, i * 3);
      pos.set(d.map((v) => v * 1.004), i * 3);
      color.set(rgb(css(`--${a.group}`)), i * 3);
      s[i] = Math.random();
      idx[i] = i;
    });
    span = Math.max(1, n ? days[n - 1] : 1);
    realDays = Float64Array.from(days);
    shift = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    geo.setAttribute("aDay", new THREE.BufferAttribute(Float32Array.from(days), 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(s, 1));
    geo.setAttribute("aIdx", new THREE.BufferAttribute(idx, 1));
    aPoints.geometry.dispose();
    aPoints.geometry = geo;
    dayAttr = geo.attributes.aDay;
    closeCard();
    if (first && !reduced()) return intro();
    // filters changed: show the full picture for the new selection
    mode = "idle";
    fallDays = FALL_SEC * (span / INTRO_SECONDS);
    now = span + fallDays * SPLASH;
    gMat.uniforms.uAssemble.value = 1;
  }

  // ---- playback ----
  // mode: intro (fast splashdown on first open) · clearing (lift-off) · journey (sped-up real time) · idle
  let mode = "idle", paused = false, now = 0, fallDays = 1, speedIx = 1, clearT = 0, assembleT = 0, introDelay = 0;
  let landed = 0, lastImpact = -1;

  function intro() {
    mode = "intro";
    assembleT = 0;
    introDelay = 0.7;
    fallDays = FALL_SEC * (span / INTRO_SECONDS);
    now = -fallDays;
    landed = 0;
    // start the camera over the busiest part of the history
    const mid = acts[Math.floor(acts.length / 2)];
    if (mid) [cam.lon, cam.lat] = [mid.startLongitude + 40, Math.max(-50, Math.min(50, mid.startLatitude * 0.6))];
  }
  function startJourney() {
    closeCard();
    paused = false;
    mode = "clearing";
    clearT = 0;
    holdUntil = 0;
  }
  function toggle() {
    if (mode === "journey" && !atEnd()) paused = !paused;
    else if (mode === "clearing") return;
    else startJourney();
    hud(true);
  }
  const atEnd = () => now >= (days.length ? days[days.length - 1] : span) + fallDays * SPLASH;

  // A travel hold pushes every activity from `from` onward later by d days. `shift` is the total, so the
  // story's date is now - shift. Scrubbing or replaying puts everything back on its real date.
  function delayFrom(from, d) {
    if (d <= 0) return;
    for (let i = from; i < days.length; i++) dayAttr.array[i] = days[i] += d;
    dayAttr.needsUpdate = true;
    shift += d;
  }
  function restoreDays() {
    if (!shift) return;
    days.set(realDays);
    dayAttr.array.set(realDays);
    dayAttr.needsUpdate = true;
    shift = 0;
  }
  const baseSpeed = () => SPEEDS[speedIx][0];

  // ---- camera: orbit around the globe ----
  const cam = { lon: -100, lat: 25, zoom: 1, dist: 4.2, vLon: 0, vLat: 0 };
  let baseDist = 4.2, holdUntil = 0, clock = 0;
  // pick the distance that gives a globe of the wanted on-screen radius: leave room for the date and the
  // controls on desktop, nearly fill the width on phones
  function frame(w, h) {
    const want = Math.min(h * 0.37, w * 0.45);
    baseDist = 1 / Math.sin(Math.atan((want / (h / 2)) * Math.tan((FOV / 2) * RAD)));
  }
  function resize() {
    const { clientWidth: w, clientHeight: h } = stage;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frame(w, h);
    // dot sizes are authored in px for a globe ~400px in radius
    const radiusPx = ((h / 2) * Math.tan(Math.asin(1 / baseDist))) / Math.tan((FOV / 2) * RAD);
    common.uScale.value = Math.max(0.5, radiusPx / 400);
    common.uRef.value = baseDist - 1;
    // sit the globe a little low so the date has the top of the page
    camera.setViewOffset(w, h, 0, -h * 0.04, w, h);
    common.uPR.value = renderer.getPixelRatio();
  }
  new ResizeObserver(resize).observe(stage);

  // ---- loop ----
  let running = false, last = 0, raf = 0;
  function tick(t) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    clock += dt;
    gMat.uniforms.uClock.value = clock;

    // globe assembly
    if (assembleT < 1) assembleT = reduced() ? 1 : Math.min(1, assembleT + dt / 1.8);
    gMat.uniforms.uAssemble.value = assembleT;

    // timeline
    if (mode !== "journey" || paused) (travel = null), (traveling = false);
    if (mode === "intro") {
      if ((introDelay -= dt) <= 0) now += (span / INTRO_SECONDS) * dt;
      if (atEnd()) mode = "idle";
    } else if (mode === "clearing") {
      clearT = Math.min(1, clearT + dt / CLEAR_SEC);
      if (clearT >= 1) {
        mode = "journey";
        clearT = 0;
        fallDays = JOURNEY_FALL * baseSpeed();
        restoreDays();
        now = -fallDays * 1.2;
        landed = 0;
        follow = null;
        spread = 1;
        cam.zoom = 1;
      }
    } else if (mode === "journey" && !paused) {
      let speed = baseSpeed();
      // long empty stretches (travel gaps, injuries) fast-forward once the last splash has played out
      const next = upper(days, now);
      const gapAhead = next < days.length ? days[next] - now : 0;
      const sinceLast = next > 0 ? now - days[next - 1] : Infinity;
      if (gapAhead > Math.max(20, fallDays * 1.5) && sinceLast > fallDays * SPLASH) speed *= 6;
      const step = speed * dt;
      // the camera looks at the cluster around the activity that's falling now, or the next one once it's
      // about to start, so it moves on only when the story does
      const nf = upper(days, now + fallDays); // first activity that hasn't started falling
      const imminent = nf < days.length && now + step >= days[nf] - fallDays;
      let aimAt = imminent ? nf : Math.max(0, nf - 1);
      // Travel hold: when the next activity is somewhere the camera isn't looking, everything from it onward
      // waits while the camera flies there. The clock keeps running, so whatever is already in the air lands
      // first, and the camera only sets off once it has. "Isn't looking" is measured on screen, so it means
      // the same at any zoom: start when the activity is out toward the edge or behind the globe, release
      // once the camera has settled on its viewing spot for the new area.
      travel = null;
      if (imminent && spring && clock > holdUntil && !drag) {
        const dest = cluster(nf);
        const away = traveling
          ? Math.acos(Math.min(1, camDir.dot(tgt.set(...viewFrom(dest.dir))))) > seenArc() * 0.2
          : screenR(dirs[nf * 3], dirs[nf * 3 + 1], dirs[nf * 3 + 2]) > 0.7;
        if (!traveling) travelStart = clock;
        // give up waiting after a few seconds, whatever the camera is doing
        if (away && clock - travelStart < 6) {
          travel = nf;
          if (nf > 0 && now < days[nf - 1] + fallDays * 0.5) aimAt = nf - 1; // let the current rain land
          delayFrom(nf, now + step - (days[nf] - fallDays) + 1e-3);
        }
      }
      aim(aimAt);
      traveling = travel != null;
      now += step;
      if (atEnd()) {
        paused = false;
        mode = "idle";
        holdUntil = clock + 1.5;
        hud(true);
      }
    }
    aMat.uniforms.uNow.value = now;
    aMat.uniforms.uFall.value = fallDays;
    aMat.uniforms.uClear.value = mode === "clearing" ? ease(clearT) : 0;

    // splashdowns since last frame: ripple the surface and give the camera something to follow
    const nowLanded = mode === "clearing" ? landed : upper(days, now);
    if (nowLanded > landed && mode !== "clearing") {
      const i = nowLanded - 1;
      const gap = mode === "intro" ? 0.07 : 0.02;
      if (clock - lastImpact > gap) {
        lastImpact = clock;
        const slot = impacts.findIndex((v) => clock - v.w > 1.4);
        const j = slot < 0 ? impacts.reduce((m, v, k) => (v.w < impacts[m].w ? k : m), 0) : slot;
        impacts[j].set(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], clock);
        impactCols[j].fromArray(aPoints.geometry.attributes.aColor.array, i * 3);
      }
    }
    landed = nowLanded;

    moveCamera(dt);
    hud();
    renderer.render(scene, camera);
  }

  // Where the journey camera wants to be: the weighted centre of the last dozen landings plus anything about to
  // land. A one-off trip nudges it; a real move pulls it over within a few activities. How tightly those
  // landings cluster sets the zoom: one city -> close in, spread across a region -> pull back.
  let follow = null, spread = 1;
  let travel = null, traveling = false, travelStart = 0;
  // distance from the middle of the view, in half-screens (0 = centre, 1 = edge); Infinity behind the globe
  const vA = new THREE.Vector3(), vO = new THREE.Vector3();
  function screenR(x, y, z) {
    const C = camera.position;
    if (x * C.x + y * C.y + z * C.z < 1) return Infinity;
    vA.set(x, y, z).project(camera);
    vO.set(0, 0, 0).project(camera);
    const { clientWidth: w, clientHeight: h } = stage;
    return Math.hypot(((vA.x - vO.x) * w) / 2, ((vA.y - vO.y) * h) / 2) / (Math.min(w, h) / 2);
  }
  // how much of the surface the view spans from its centre, in radians; shrinks as you zoom in
  const seenArc = () => Math.min(Math.acos(1 / cam.dist), (cam.dist - 1) * Math.tan((FOV / 2) * RAD));
  // Looking straight down on a spot hides the fall (it comes straight at you), so the journey camera sits a
  // little south of the action and sees it at an angle: particles visibly drop onto the surface.
  function viewFrom(v) {
    const [lng, lat] = lngLatOf(v);
    return dirOf(lng, Math.max(-80, lat - Math.min(28, (seenArc() / RAD) * 0.4)));
  }
  function aim(anchor) {
    if (anchor >= acts.length) return;
    const c = cluster(anchor);
    follow = c.dir;
    spread = c.spread;
  }
  // centre of the activities around this one: neighbours in time that are also near in space, so
  // activities somewhere else don't drag the camera off
  function cluster(anchor) {
    // what counts as "the same area" follows the zoom: about a quarter of the surface arc in view
    const NEAR = Math.cos(seenArc() * 0.25);
    const ax = dirs[anchor * 3], ay = dirs[anchor * 3 + 1], az = dirs[anchor * 3 + 2];
    let x = 0, y = 0, z = 0, w = 0;
    for (let i = Math.max(0, anchor - 8); i < Math.min(acts.length, anchor + 9); i++) {
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      if (dx * ax + dy * ay + dz * az < NEAR) continue;
      x += dx;
      y += dy;
      z += dz;
      w++;
    }
    const len = Math.hypot(x, y, z);
    const spread = 1 - len / w; // 0 when every landing is the same spot
    // keep the view out of the polar regions (and measure arrival against the same capped point)
    let [fx, fy, fz] = [x / len, y / len, z / len];
    if (Math.abs(fy) > MAX_LAT) {
      const k = Math.sqrt((1 - MAX_LAT ** 2) / Math.max(1e-6, fx * fx + fz * fz));
      [fx, fy, fz] = [fx * k, Math.sign(fy) * MAX_LAT, fz * k];
    }
    return { dir: [fx, fy, fz], spread };
  }

  // The camera rides a critically damped spring toward its target, with a speed cap, so it eases out,
  // glides and eases in rather than snapping between activities.
  const camDir = new THREE.Vector3(), camVel = new THREE.Vector3(), tgt = new THREE.Vector3(), acc = new THREE.Vector3();
  const MAX_LAT = Math.sin(55 * RAD);
  let spring = false, zoomMul = 1, focus = null;
  function moveCamera(dt) {
    const free = clock > holdUntil && !drag;
    const target = focus ? dirOf(...focus) : mode === "journey" && !paused && follow ? viewFrom(follow) : null;
    if (target && free) {
      if (!spring) {
        camDir.set(...dirOf(cam.lon, cam.lat));
        camVel.set(0, 0, 0);
        spring = true;
      }
      tgt.set(...target);
      const w = focus ? 2.4 : traveling ? 1.5 : 1.1; // lower = lazier
      acc.subVectors(tgt, camDir).multiplyScalar(w * w).addScaledVector(camVel, -2 * w);
      camVel.addScaledVector(acc, dt);
      const max = focus || traveling ? 1.1 : 0.7; // radians per second
      if (camVel.length() > max) camVel.setLength(max);
      camDir.addScaledVector(camVel, dt).normalize();
      [cam.lon, cam.lat] = lngLatOf(camDir.toArray());
    } else if (!drag) {
      spring = false;
      // inertia, then a slow eastward spin when nothing else is going on
      cam.lon += cam.vLon * dt;
      cam.lat += cam.vLat * dt;
      cam.vLon *= Math.exp(-dt * 3);
      cam.vLat *= Math.exp(-dt * 3);
      if (free && !focus && !(mode === "journey" && paused) && !reduced()) cam.lon -= 4 * dt;
    } else spring = false;
    cam.lat = Math.max(-80, Math.min(80, cam.lat));
    // pull back a little for a long flight, settle in once there
    const close = focus ? 0.82 : traveling ? 0.95 : mode === "journey" ? 0.8 + Math.min(1, spread / 0.04) * 0.1 : 1;
    zoomMul += (close - zoomMul) * (1 - Math.exp(-dt * (traveling ? 1.2 : 0.6)));
    const want = baseDist * cam.zoom * zoomMul;
    cam.dist += (want - cam.dist) * (1 - Math.exp(-dt * 2.5));
    const [x, y, z] = dirOf(cam.lon, cam.lat);
    camera.position.set(x * cam.dist, y * cam.dist, z * cam.dist);
    camera.lookAt(0, 0, 0);
    common.uCam.value.copy(camera.position);
  }

  // ---- HUD ----
  let lastHud = "";
  function hud(force) {
    const n = mode === "idle" ? acts.length : landed;
    const story = now - shift;
    const d = new Date(t0 + Math.max(0, Math.min(span, story)) * DAY);
    const date = acts.length ? d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }) : "–";
    const sig = `${date}|${n}|${mode}|${paused}|${speedIx}|${travel}`;
    if (!force && sig === lastHud) return;
    lastHud = sig;
    elDate.textContent = date;
    const dest = travel != null && placeOf.get(acts[travel].activityId);
    elKicker.textContent = dest ? `Heading to ${dest.name} →` : "Every activity, in order";
    elCount.innerHTML = `<b>${n.toLocaleString()}</b> ${n === 1 ? "activity" : "activities"} · <b>${fmtDist(cum[n] ?? 0)}</b>`;
    const playing = mode === "journey" && !paused;
    elPlay.textContent = playing ? "❚❚ Pause" : mode === "journey" && !atEnd() ? "▶ Resume" : mode === "clearing" ? "Lifting off" : "▶ Play journey";
    elPlay.classList.toggle("on", playing);
    if (document.activeElement !== elScrub) elScrub.value = Math.round((Math.max(0, Math.min(span, story)) / span) * 1000);
    host.querySelectorAll("[data-g-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.gSpeed) === speedIx));
  }

  elScrub.addEventListener("input", () => {
    closeCard();
    if (mode !== "journey") {
      mode = "journey";
      fallDays = JOURNEY_FALL * baseSpeed();
    }
    paused = true;
    restoreDays();
    now = (elScrub.value / 1000) * span;
    landed = upper(days, now);
    hud(true);
  });

  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-g-act], [data-g-speed]");
    if (!b) return;
    if (b.dataset.gAct === "toggle") toggle();
    if (b.dataset.gAct === "close") closeCard();
    if (b.dataset.gSpeed) {
      speedIx = Number(b.dataset.gSpeed);
      if (mode === "journey") fallDays = JOURNEY_FALL * baseSpeed();
      hud(true);
    }
  });

  // ---- picking ----
  const v3 = new THREE.Vector3();
  function pick(cx, cy, radius) {
    const r = renderer.domElement.getBoundingClientRect();
    const C = camera.position;
    let best = -1, bestD = radius * radius, near = 0;
    for (let i = 0; i < landed; i++) {
      const x = dirs[i * 3], y = dirs[i * 3 + 1], z = dirs[i * 3 + 2];
      // behind the horizon
      if (x * C.x + y * C.y + z * C.z < 1.02) continue;
      v3.set(x, y, z).project(camera);
      const dx = ((v3.x + 1) / 2) * r.width + r.left - cx, dy = ((1 - v3.y) / 2) * r.height + r.top - cy;
      const dd = dx * dx + dy * dy;
      if (dd < 64) near++;
      if (dd < bestD) (bestD = dd), (best = i);
    }
    return best < 0 ? null : { i: best, near };
  }
  const canPick = () => mode === "idle" || (mode === "journey" && paused);

  function showCard(i) {
    const a = acts[i];
    const place = placeOf.get(a.activityId);
    focus = [a.startLongitude, a.startLatitude];
    aMat.uniforms.uHover.value = i;
    elCard.style.setProperty("--c", `var(--${a.group})`);
    elCard.innerHTML = `
      <header><span class="tag">${prettyType(a.type)}</span><button data-g-act="close" aria-label="Close">×</button></header>
      <h3>${a.activityName}</h3>
      <p class="when">${fmtDay(a.startTimeLocal)}${place ? ` · ${flag(place.cc)} ${place.name}` : ""}</p>
      <p class="stats"><b>${fmtDist(a.distance ?? 0, 1)}</b> · <b>${fmtClock(a.movingDuration ?? a.duration ?? 0)}</b></p>
      <button class="open" data-id="${a.activityId}">Open on map →</button>`;
    elCard.hidden = false;
    tip.hidden = true;
  }
  function closeCard() {
    elCard.hidden = true;
    focus = null;
    aMat.uniforms.uHover.value = -1;
  }

  // ---- input: drag to spin (with inertia), wheel / pinch to zoom, hover and tap dots ----
  const el = renderer.domElement;
  const pointers = new Map();
  let drag = null, pinch = null;
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: cam.zoom };
      drag = null;
    } else drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
    tip.hidden = true;
  });
  el.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.zoom = Math.max(0.4, Math.min(1.6, pinch.zoom * (pinch.d / Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])))));
      return;
    }
    if (drag) {
      // degrees per pixel scale with how much of the globe is on screen
      const k = (0.22 * (cam.dist - 1)) / (baseDist - 1);
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const ms = Math.max(1, performance.now() - drag.t);
      cam.lon -= dx * k;
      cam.lat += dy * k;
      cam.vLon = (-dx * k * 1000) / ms;
      cam.vLat = (dy * k * 1000) / ms;
      Object.assign(drag, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
        focus = null;
        holdUntil = clock + (mode === "journey" ? 4 : 2.5);
      }
      return;
    }
    if (e.pointerType !== "mouse" || !canPick()) return;
    const hit = pick(e.clientX, e.clientY, 12);
    el.style.cursor = hit ? "pointer" : "";
    if (elCard.hidden) aMat.uniforms.uHover.value = hit ? hit.i : -1;
    if (!hit) return (tip.hidden = true);
    const a = acts[hit.i];
    tip.hidden = false;
    tip.innerHTML = `<b>${a.activityName}</b><small>${a.startTimeLocal.slice(0, 10)} · ${fmtDist(a.distance ?? 0, 1)}${hit.near > 1 ? ` · ${hit.near} activities here` : ""}</small>`;
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 270)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
    if (performance.now() - drag.t > 80) cam.vLon = cam.vLat = 0; // held still before letting go
    drag = null;
    if (moved > 5 || !canPick()) return;
    const hit = pick(e.clientX, e.clientY, e.pointerType === "mouse" ? 12 : 22);
    if (hit) showCard(hit.i);
    else closeCard();
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", () => (tip.hidden = true));
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.zoom = Math.max(0.4, Math.min(1.6, cam.zoom * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });

  return {
    setList,
    show() {
      if (running) return;
      running = true;
      last = 0;
      resize();
      raf = requestAnimationFrame(tick);
    },
    hide() {
      running = false;
      cancelAnimationFrame(raf);
      tip.hidden = true;
    },
  };
}
