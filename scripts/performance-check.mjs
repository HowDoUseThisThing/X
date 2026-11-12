import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { SurvivorGame, ENTITY_LIMITS } from "../src/game/game.js";

const temporary = await mkdtemp(join(tmpdir(), "moonlit-benchmark-"));
const viewport = { width: 1440, height: 900 };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function fixture(Game, expanded = false) {
  const game = new Game(42); game.start(); game.particleLimit = 0;
  if (expanded) {
    for (const id of ["orbitBlade", "tideNova", "chainSpark"]) game.applyChoice({ type: "weapon", target: id });
    for (const weapon of game.activeWeapons) { weapon.level = 5; weapon.evolved = true; }
    game.recalculateStats();
  }
  Object.assign(game.player, { health: 1e9, maxHealth: 1e9, invulnerable: 1e9, projectileCount: 4, pierce: 2, fireInterval: 0.2 });
  game.spawnClock = -1e9;
  game.enemies = Array.from({ length: 600 }, (_, i) => ({ id: `fixture-${i}`, type: "shade", behavior: "chase", x: (i % 30 - 14.5) * 46, y: (Math.floor(i / 30) - 9.5) * 42, radius: 12, hp: 1e12, maxHp: 1e12, damage: 0, xp: 1, speed: 0, color: "#fff", hitFlash: 0, contactClock: 0 }));
  return game;
}
function sample(Game, expanded, view = viewport) {
  const game = fixture(Game, expanded);
  for (let frame = 0; frame < 240; frame++) game.update(1 / 60, {}, view);
  const started = performance.now();
  for (let frame = 0; frame < 1200; frame++) game.update(1 / 60, {}, view);
  return (performance.now() - started) / 1200;
}
try {
  for (const path of ["src/game", "src/core"]) await mkdir(join(temporary, path), { recursive: true });
  await writeFile(join(temporary, "package.json"), '{"type":"module"}');
  for (const path of ["src/game/game.js", "src/game/world.js", "src/game/spatial-grid.js", "src/core/math.js"]) {
    await writeFile(join(temporary, path), execFileSync("git", ["show", `9dbeb1b:${path}`], { encoding: "utf8" }));
  }
  const { SurvivorGame: BaselineGame } = await import(pathToFileURL(join(temporary, "src/game/game.js")).href);
  sample(BaselineGame, false); sample(SurvivorGame, true);
  const baseline = [], expanded = [];
  for (let run = 0; run < 7; run++) {
    if (run % 2) { expanded.push(sample(SurvivorGame, true)); baseline.push(sample(BaselineGame, false)); }
    else { baseline.push(sample(BaselineGame, false)); expanded.push(sample(SurvivorGame, true)); }
  }
  const baselineMs = median(baseline), expandedMs = median(expanded);
  const ratio = expandedMs / baselineMs;
  const mobile600EnemyUpdateMs = median(Array.from({ length: 5 }, () => sample(SurvivorGame, true, { width: 844, height: 390 })));
  const peaks = Object.fromEntries(Object.keys(ENTITY_LIMITS).map(key => [key, 0]));
  const scenarios = [];
  for (const weapons of [["moonArrow", "orbitBlade", "tideNova", "chainSpark"], ["moonArrow", "graveField", "echoBoomerang", "chainSpark"]]) {
    const game = new SurvivorGame(83); game.start(); game.particleLimit = 120;
    game.build.weapons = weapons.map(id => ({ id, level: 5, evolved: true }));
    game.build.passives = { might: 5, tempo: 5, magnet: 5, area: 5 }; game.recalculateStats();
    game.player.maxHealth = game.player.health = 1e9; game.player.invulnerable = 1e9;
    const heapSamples = [];
    const started = performance.now();
    for (let frame = 0; frame < 43200; frame++) {
      const angle = frame / 60 * 0.3;
      game.update(1 / 60, { moveX: Math.cos(angle), moveY: Math.sin(angle), dash: frame % 180 === 0 }, { width: 844, height: 390 });
      while (game.state === "levelup") game.chooseUpgrade(game.upgradeChoices[0].id);
      if (game.state === "chest") game.chooseChestUpgrade(game.chestChoices[0].id);
      for (const [key, limit] of Object.entries(ENTITY_LIMITS)) { peaks[key] = Math.max(peaks[key], game[key].length); assert.ok(game[key].length <= limit, `${key} exceeded ${limit}`); }
      assert.equal(game.state, "playing");
      if (typeof globalThis.gc === "function" && (frame + 1) % 7200 === 0) {
        globalThis.gc();
        heapSamples.push({ seconds: Math.round(game.elapsed), retainedBytes: process.memoryUsage().heapUsed });
      }
    }
    const retainedHeapGrowthBytes = heapSamples.length ? heapSamples.at(-1).retainedBytes - heapSamples[0].retainedBytes : null;
    scenarios.push({ weapons, seconds: game.elapsed, kills: game.kills, bosses: game.bossKills, averageUpdateMs: (performance.now() - started) / 43200, heapSamples, retainedHeapGrowthBytes });
  }
  const report = { date: new Date().toISOString(), baselineCommit: "9dbeb1b", fixture: "600 stationary durable enemies; baseline four-arrow volley versus four evolved weapons; 1440x900; seven alternating runs; median of per-run mean update time; particles disabled for both", baselineMs, expandedMs, logicRatio: ratio, frameComparison: "See frame-performance-validation.json for update + rendering comparison. This report measures logic only.", mobile600EnemyUpdateMs, mobileLogicBelow8Ms: mobile600EnemyUpdateMs < 8 && scenarios.every(item => item.averageUpdateMs < 8), peaks, limits: ENTITY_LIMITS, scenarios, limitations: "Node controlled simulation; no rendering/GPU time or physical phone FPS. Soak uses invulnerability and automatic choices to reach all timed events. Bounded collections prove retained entity budgets, not a heap profiler leak analysis." };
  await mkdir("output", { recursive: true }); await writeFile("output/performance-validation.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.mobileLogicBelow8Ms, "Mobile fixture update exceeded 8ms");
  for (const scenario of scenarios) if (scenario.retainedHeapGrowthBytes !== null) assert.ok(scenario.retainedHeapGrowthBytes < 2 * 1024 * 1024, "Retained heap grew by more than 2 MiB during a 12-minute fixture");
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith("moonlit-benchmark-"));
  await rm(temporary, { recursive: true, force: true });
}
