import { clamp } from "../core/math.js";
import { mulberry32 } from "../core/math.js";

export const WORLD = Object.freeze({ width: 3200, height: 2200 });

export const MAP_THEMES = Object.freeze({
  ruins: Object.freeze({ id: "ruins", name: "荒野遗迹", ground: "#191b21", wash: ["rgba(74,67,65,.23)", "rgba(64,53,76,.25)"], accent: "#8c7c9f" }),
  wetlands: Object.freeze({ id: "wetlands", name: "潮湿沼泽", ground: "#14211f", wash: ["rgba(47,91,77,.28)", "rgba(36,67,64,.25)"], accent: "#72c8a2" }),
  graveyard: Object.freeze({ id: "graveyard", name: "月蚀墓园", ground: "#1d1924", wash: ["rgba(82,59,102,.29)", "rgba(53,43,75,.24)"], accent: "#c49be8" }),
  crystal: Object.freeze({ id: "crystal", name: "晶岩峡谷", ground: "#18202a", wash: ["rgba(48,91,119,.28)", "rgba(51,61,93,.25)"], accent: "#85d6e7" }),
  ashland: Object.freeze({ id: "ashland", name: "灰烬荒原", ground: "#241d1b", wash: ["rgba(114,66,47,.25)", "rgba(83,57,48,.24)"], accent: "#e5a06d" }),
});

const MAP_THEME_IDS = Object.keys(MAP_THEMES);

function shuffled(values, random) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Radii include the entire painted silhouette, not just the object's base.
export const MAP_CLEARANCE = Object.freeze({ spawn: 210, altar: 140, road: 18 });
const LANDSCAPES = {
  ruins: ["ruin", "pillar", "rockGroup"],
  wetlands: ["puddle", "reeds", "tree"],
  graveyard: ["grave", "grave", "tree"],
  crystal: ["crystal", "crystal", "rockGroup"],
  ashland: ["ash", "ash", "tree"],
};
const DETAILS = { ruins: "rubble", wetlands: "reeds", graveyard: "grave", crystal: "shard", ashland: "cinder" };

function segmentDistance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

export function generateMap(seed = 1) {
  const normalizedSeed = seed >>> 0;
  const random = mulberry32(normalizedSeed ^ 0x6e624eb7);
  const range = (min, max) => min + random() * (max - min);
  const themes = shuffled(MAP_THEME_IDS, random).slice(0, 4);
  const halfW = WORLD.width / 2, halfH = WORLD.height / 2;
  // Shared split coordinates tile the whole world without gaps or out-of-bounds regions.
  const splitX = range(-240, 240), splitY = range(-170, 170);
  const xs = [-halfW, splitX, halfW], ys = [-halfH, splitY, halfH];
  const regions = [];
  for (let row = 0; row < 2; row += 1) for (let column = 0; column < 2; column += 1) {
    const theme = themes[row * 2 + column];
    regions.push({
      id: `${theme}-${row}-${column}`, theme,
      x: xs[column], y: ys[row], width: xs[column + 1] - xs[column], height: ys[row + 1] - ys[row],
      seed: Math.floor(random() * 0x100000000) >>> 0,
    });
  }
  const altars = [];
  for (const region of shuffled(regions, random).slice(0, 3)) {
    // Separate quadrants and generous rejection sampling keep every altar reachable.
    let point;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const x = range(region.x + 180, region.x + region.width - 180);
      const y = range(region.y + 180, region.y + region.height - 180);
      if (Math.hypot(x, y) < 600 || altars.some(a => Math.hypot(x - a.x, y - a.y) < 650)) continue;
      point = { x, y }; break;
    }
    if (!point) throw new Error("Unable to place separated map altars");
    const index = altars.length;
    altars.push({ id: `altar-${index}`, name: ["潮痕祭坛", "断月祭坛", "沉钟祭坛"][index], ...point, radius: 44 });
  }
  const roads = [];
  const connect = (x, y) => {
    const length = Math.hypot(x, y), nx = -y / length, ny = x / length;
    const bend = range(-160, 160);
    roads.push({
      id: `road-${roads.length}`, width: range(56, 84),
      points: [[0, 0], [x * .32 + nx * bend, y * .32 + ny * bend],
        [x * .7 - nx * bend * .5, y * .7 - ny * bend * .5], [x, y]],
    });
  };
  for (const altar of altars) connect(altar.x, altar.y);
  // Trails also lead out into the region without an altar, with seeded edge destinations.
  for (const region of regions) {
    const x = region.x < -1000 ? -halfW + 100 : halfW - 100;
    connect(x, range(region.y + 150, region.y + region.height - 150));
  }
  const landmarks = [], decorations = [];
  const occupied = [];
  const clear = (x, y, radius) => {
    if (Math.hypot(x, y) < MAP_CLEARANCE.spawn + radius) return false;
    if (altars.some(a => Math.hypot(x - a.x, y - a.y) < MAP_CLEARANCE.altar + radius)) return false;
    if (roads.some(road => road.points.slice(1).some((b, i) =>
      segmentDistance(x, y, road.points[i], b) < road.width / 2 + MAP_CLEARANCE.road + radius))) return false;
    return !occupied.some(item => Math.hypot(x - item.x, y - item.y) < item.radius + radius + 8);
  };
  for (const region of regions) {
    const local = mulberry32(region.seed);
    const localRange = (min, max) => min + local() * (max - min);
    const place = (collection, count, large) => {
      for (let attempt = 0, placed = 0; attempt < count * 90 && placed < count; attempt += 1) {
        const kind = large ? LANDSCAPES[region.theme][placed % 3] :
          (placed % 9 === 0 ? "rock" : DETAILS[region.theme]);
        const radius = large ? localRange(72, 115) : localRange(12, 25);
        const x = localRange(region.x + radius + 4, region.x + region.width - radius - 4);
        const y = localRange(region.y + radius + 4, region.y + region.height - radius - 4);
        if (!clear(x, y, radius)) continue;
        const item = { id: `${region.id}-${large ? "landmark" : "detail"}-${placed}`,
          regionId: region.id, theme: region.theme, kind, x, y, radius,
          rotation: localRange(-Math.PI, Math.PI), seed: Math.floor(local() * 0x100000000) >>> 0 };
        collection.push(item); occupied.push(item); placed += 1;
      }
    };
    place(landmarks, Math.floor(localRange(7, 12)), true);
    place(decorations, Math.floor(localRange(65, 96)), false);
  }
  return Object.freeze({ seed: normalizedSeed, themes, regions, altars, roads, landmarks, decorations });
}

export function clampToWorld(x, y, padding = 0, world = WORLD) {
  const halfWidth = world.width / 2;
  const halfHeight = world.height / 2;
  const px = clamp(padding, 0, halfWidth);
  const py = clamp(padding, 0, halfHeight);
  return {
    x: clamp(x, -halfWidth + px, halfWidth - px),
    y: clamp(y, -halfHeight + py, halfHeight - py),
  };
}

export function isInsideWorld(x, y, padding = 0, world = WORLD) {
  const point = clampToWorld(x, y, padding, world);
  return point.x === x && point.y === y;
}

export function getCameraCenter(x, y, viewportWidth, viewportHeight, world = WORLD) {
  const width = Math.max(1, Number(viewportWidth) || 0);
  const height = Math.max(1, Number(viewportHeight) || 0);
  const limitX = Math.max(0, world.width / 2 - width / 2);
  const limitY = Math.max(0, world.height / 2 - height / 2);
  return {
    x: clamp(x, -limitX, limitX),
    y: clamp(y, -limitY, limitY),
  };
}
