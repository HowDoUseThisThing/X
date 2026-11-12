import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateMap, MAP_THEMES, MAP_CLEARANCE, WORLD, isInsideWorld } from "../src/game/world.js";
import { TerrainRenderer } from "../src/render/terrain.js";
import { SurvivorGame } from "../src/game/game.js";

// Independent distance calculation checks the *segments*, not just road vertices.
function distanceToSegment(item, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((item.x - a[0]) * vx + (item.y - a[1]) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(item.x - a[0] - t * vx, item.y - a[1] - t * vy);
}

it("reproduces every road, landmark, decoration and altar from the normalized seed", () => {
  for (const seed of [0, 1, 42, 1234567, 0xffffffff]) {
    const map = generateMap(seed);
    generateMap(seed + 17); // No shared generator state.
    assert.deepEqual(generateMap(seed), map);
  }
  assert.deepEqual(generateMap(-1), generateMap(0xffffffff));
  assert.deepEqual(generateMap(2 ** 32 + 42), generateMap(42));
  assert.deepEqual(WORLD, { width: 3200, height: 2200 });
});

it("changes actual geometry across seeds, including runs with the same theme order", () => {
  const seen = new Map();
  let sameThemes = false;
  const allThemes = new Set();
  for (let seed = 0; seed < 140; seed += 1) {
    const map = generateMap(seed), key = map.themes.join();
    assert.equal(new Set(map.themes).size, 4);
    map.themes.forEach(theme => { assert.ok(MAP_THEMES[theme]); allThemes.add(theme); });
    if (seen.has(key)) {
      const other = seen.get(key);
      for (const field of ["roads", "landmarks", "decorations", "altars"]) {
        // Comparing positions avoids a false positive caused solely by seed/id fields.
        const geometry = m => m[field].map(item => item.points || [item.x, item.y, item.radius]);
        assert.notDeepEqual(geometry(map), geometry(other), field);
      }
      sameThemes = true;
    }
    seen.set(key, map);
  }
  assert.ok(sameThemes, "must exercise internal variation with identical theme selection");
  assert.equal(allThemes.size, 5);
});

it("tiles the world and preserves safe footprints, separated altars and connected trails over many seeds", () => {
  for (const seed of [0, 0xffffffff, ...Array.from({ length: 100 }, (_, i) => i * 7919)]) {
    const map = generateMap(seed);
    assert.equal(map.regions.length, 4);
    assert.equal(map.altars.length, 3);
    assert.ok(Math.abs(map.regions.reduce((sum, r) => sum + r.width * r.height, 0) - WORLD.width * WORLD.height) < 1e-6);
    for (const region of map.regions) {
      assert.ok(isInsideWorld(region.x, region.y));
      assert.ok(isInsideWorld(region.x + region.width, region.y + region.height));
      const landmarks = map.landmarks.filter(item => item.regionId === region.id);
      assert.ok(landmarks.length >= 7, `${seed}: sparse region ${region.id}`);
      assert.ok(map.decorations.filter(item => item.regionId === region.id).length >= 65);
      const signature = { ruins: "ruin", wetlands: "puddle", graveyard: "grave", crystal: "crystal", ashland: "ash" }[region.theme];
      assert.ok(landmarks.some(item => item.kind === signature));
    }
    for (let i = 0; i < map.regions.length; i += 1) for (const b of map.regions.slice(i + 1)) {
      const a = map.regions[i];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
    for (const altar of map.altars) {
      assert.ok(isInsideWorld(altar.x, altar.y, MAP_CLEARANCE.altar));
      assert.ok(Math.hypot(altar.x, altar.y) >= 600);
      assert.ok(map.roads.some(road => {
        const last = road.points.at(-1);
        return last[0] === altar.x && last[1] === altar.y;
      }));
      for (const other of map.altars) if (other !== altar) assert.ok(Math.hypot(altar.x - other.x, altar.y - other.y) >= 650);
    }
    for (const road of map.roads) {
      assert.deepEqual(road.points[0], [0, 0]);
      assert.ok(road.width >= 56 && road.width <= 84);
      for (const [x, y] of road.points) assert.ok(isInsideWorld(x, y, road.width / 2));
    }
    const items = [...map.landmarks, ...map.decorations];
    assert.equal(new Set(items.map(item => item.id)).size, items.length);
    for (const item of items) {
      assert.ok(isInsideWorld(item.x, item.y, item.radius));
      const region = map.regions.find(r => r.id === item.regionId);
      assert.equal(item.theme, region.theme);
      assert.ok(item.x - item.radius >= region.x && item.x + item.radius <= region.x + region.width);
      assert.ok(item.y - item.radius >= region.y && item.y + item.radius <= region.y + region.height);
      assert.ok(Math.hypot(item.x, item.y) >= MAP_CLEARANCE.spawn + item.radius);
      for (const altar of map.altars) assert.ok(Math.hypot(item.x - altar.x, item.y - altar.y) >= MAP_CLEARANCE.altar + item.radius);
      for (const road of map.roads) for (let i = 1; i < road.points.length; i += 1) {
        assert.ok(distanceToSegment(item, road.points[i - 1], road.points[i]) >= item.radius + road.width / 2 + MAP_CLEARANCE.road);
      }
    }
    for (let i = 0; i < items.length; i += 1) for (const other of items.slice(i + 1)) {
      assert.ok(Math.hypot(items[i].x - other.x, items[i].y - other.y) >= items[i].radius + other.radius + 8);
    }
  }
});

// Record the actual drawing commands and property values; no browser or external assets needed.
function canvasRecorder() {
  const hash = createHash("sha256");
  const counts = new Map();
  const gradient = { addColorStop: (...args) => record("addColorStop", args) };
  function record(name, args) {
    counts.set(name, (counts.get(name) || 0) + 1);
    hash.update(JSON.stringify([name, args]));
  }
  const ctx = new Proxy({}, {
    get: (_, name) => (...args) => {
      record(name, args);
      if (name === "createRadialGradient") return gradient;
    },
    set: (_, name, value) => { record(name, [value]); return true; },
  });
  const canvases = [];
  return { counts, digest: () => hash.digest("hex"), document: { createElement: tag => {
    assert.equal(tag, "canvas");
    const canvas = { getContext: () => ctx }; canvases.push(canvas); return canvas;
  } }, canvases };
}

it("bakes deterministic theme drawing once per active seed, with no camera RNG or battle RNG consumption", () => {
  const previousDocument = globalThis.document, previousRandom = Math.random;
  try {
    Math.random = () => { throw new Error("terrain used global randomness"); };
    const game = new SurvivorGame(456), control = new SurvivorGame(456);
    const snapshot = JSON.stringify(game.map);
    const first = canvasRecorder(); globalThis.document = first.document;
    const terrain = new TerrainRenderer(WORLD, game.map);
    const cached = new TerrainRenderer(WORLD, generateMap(456));
    assert.equal(cached.canvas, terrain.canvas);
    assert.equal(first.canvases.length, 1);
    const commands = [...first.counts];
    let draws = 0;
    const screen = { drawImage: (...args) => { assert.equal(args[0], terrain.canvas); draws += 1; } };
    for (let i = 0; i < 40; i += 1) terrain.draw(screen, -1600 + i * 60, -1000 + i * 35, 800, 600);
    terrain.draw(screen, 5000, 5000, 800, 600);
    assert.equal(draws, 40);
    assert.deepEqual([...first.counts], commands, "camera movement must only blit the bake");
    assert.equal(JSON.stringify(game.map), snapshot);
    for (let i = 0; i < 100; i += 1) assert.equal(game.random(), control.random());
    const digest = first.digest();
    const second = canvasRecorder(); globalThis.document = second.document;
    new TerrainRenderer(WORLD, generateMap(457)); // Evict bounded cache.
    assert.notEqual(second.digest(), digest);
    const replay = canvasRecorder(); globalThis.document = replay.document;
    new TerrainRenderer(WORLD, generateMap(456));
    assert.equal(replay.digest(), digest, "all baked paths/styles must replay exactly");
  } finally {
    globalThis.document = previousDocument;
    Math.random = previousRandom;
  }
});
