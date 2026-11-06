// Explorer squares: every zoom-14 map tile a route has touched, the "cluster" (tiles whose four
// neighbours are all visited) and the biggest solid square. Same idea as Statshunters/VeloViewer.
import { COLOR, INK, EMPTY } from "./shared.js";

const lng = (x, n) => (x / n) * 360 - 180;
const lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

export function stats(tiles) {
  const set = new Set(tiles.map(([x, y]) => `${x},${y}`));
  const has = (x, y) => set.has(`${x},${y}`);
  const cluster = tiles.filter(([x, y]) => has(x + 1, y) && has(x - 1, y) && has(x, y + 1) && has(x, y - 1));
  // largest all-visited k×k block: classic DP, scanning top-left to bottom-right
  const dp = new Map();
  let best = { size: 0, x: 0, y: 0 };
  for (const [x, y] of [...tiles].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const v = 1 + Math.min(dp.get(`${x - 1},${y}`) ?? 0, dp.get(`${x},${y - 1}`) ?? 0, dp.get(`${x - 1},${y - 1}`) ?? 0);
    dp.set(`${x},${y}`, v);
    if (v > best.size) best = { size: v, x, y };
  }
  return { count: tiles.length, cluster, best };
}

export function createExplorer(map, data) {
  const n = 2 ** data.z;
  const poly = (x0, y0, x1, y1, props = {}) => ({
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [[[lng(x0, n), lat(y0, n)], [lng(x1, n), lat(y0, n)], [lng(x1, n), lat(y1, n)], [lng(x0, n), lat(y1, n)], [lng(x0, n), lat(y0, n)]]] },
  });

  map.addSource("squares", { type: "geojson", data: EMPTY });
  map.addSource("square-best", { type: "geojson", data: EMPTY });
  const vis = { layout: { visibility: "none" } };
  map.addLayer({ id: "squares", type: "fill", source: "squares", ...vis,
    paint: { "fill-color": ["case", ["get", "cluster"], COLOR.run, INK], "fill-opacity": ["case", ["get", "cluster"], 0.42, 0.14] } });
  map.addLayer({ id: "squares-line", type: "line", source: "squares", minzoom: 8, ...vis,
    paint: { "line-color": INK, "line-opacity": 0.25, "line-width": 0.5 } });
  map.addLayer({ id: "square-best", type: "line", source: "square-best", ...vis,
    paint: { "line-color": INK, "line-width": 3 } });

  let current = null;
  return {
    layers: ["squares", "squares-line", "square-best"],
    // year: "all" or "2019" -> squares first reached by the end of that year
    update(year) {
      const tiles = year === "all" ? data.tiles : data.tiles.filter((t) => t[2] <= `${year}-12-31`);
      current = stats(tiles);
      const inCluster = new Set(current.cluster.map(([x, y]) => `${x},${y}`));
      map.getSource("squares").setData({
        type: "FeatureCollection",
        features: tiles.map(([x, y]) => poly(x, y, x + 1, y + 1, { cluster: inCluster.has(`${x},${y}`) })),
      });
      const { x, y, size } = current.best;
      map.getSource("square-best").setData(size ? poly(x - size + 1, y - size + 1, x + 1, y + 1) : EMPTY);
      return current;
    },
    bestBounds() {
      if (!current?.best.size) return null;
      const { x, y, size } = current.best;
      return [[lng(x - size + 1, n), lat(y + 1, n)], [lng(x + 1, n), lat(y - size + 1, n)]];
    },
  };
}
