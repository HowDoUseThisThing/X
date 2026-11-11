import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distance, mulberry32 } from "../src/core/math.js";
import { SurvivorGame } from "../src/game/game.js";
import { SpatialGrid } from "../src/game/spatial-grid.js";

// Original narrow phase and decoration logic, kept independent of the grid
// and budget so changes to hit ordering or RNG consumption remain observable.
class NaiveGame extends SurvivorGame {
  updateProjectiles(dt) {
    this.collisionChecksLastUpdate = 0;
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const shot = this.projectiles[i];
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.life -= dt;
      shot.trail.push({ x: shot.x, y: shot.y });
      if (shot.trail.length > 4) shot.trail.shift();
      let consumed = false;
      for (const enemy of [...this.enemies]) {
        if (shot.hitIds.has(enemy.id)) continue;
        this.collisionChecksLastUpdate += 1;
        if (distance(shot.x, shot.y, enemy.x, enemy.y) <= shot.radius + enemy.radius) {
          shot.hitIds.add(enemy.id);
          enemy.hp -= shot.damage;
          enemy.hitFlash = 0.12;
          this.shake = Math.max(this.shake, 0.12);
          this.burst(shot.x, shot.y, enemy.color, 4);
          if (enemy.hp <= 0) this.killEnemy(enemy);
          if (shot.pierce > 0) shot.pierce -= 1;
          else { consumed = true; break; }
        }
      }
      if (consumed || shot.life <= 0 || Math.abs(shot.x - this.player.x) > 1000 || Math.abs(shot.y - this.player.y) > 1000) this.projectiles.splice(i, 1);
    }
  }

  burst(x, y, color, amount) {
    for (let i = 0; i < amount; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = 24 + this.random() * 145;
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.28 + this.random() * 0.42, maxLife: 0.7, radius: 1.2 + this.random() * 2.3, color });
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.95;
      particle.vy *= 0.95;
      particle.life -= dt;
      if (particle.life <= 0) this.particles.splice(i, 1);
    }
  }
}

const enemy = (id, x = 0, y = 0, overrides = {}) => ({
  id, x, y, type: "shade", hp: 100, maxHp: 100, speed: 0, radius: 12,
  damage: 0, color: "#fff", xp: 1, contactClock: 0, hitFlash: 0, ...overrides,
});
const shot = (x = 0, y = 0, overrides = {}) => ({
  x, y, vx: 0, vy: 0, radius: 5, damage: 25, life: 2, pierce: 0,
  hitIds: new Set(), trail: [], ...overrides,
});
const pair = (enemies, shots, seed = 42) => {
  const games = [new SurvivorGame(seed), new NaiveGame(seed)];
  for (const game of games) {
    game.start();
    game.particleLimit = Infinity;
    game.enemies = structuredClone(enemies);
    game.projectiles = structuredClone(shots);
  }
  return games;
};
function snapshot(game, particles = true) {
  const { enemyGrid, collisionChecksLastUpdate, random, particleLimit, ...state } = game;
  if (!particles) delete state.particles;
  return state;
}
function equivalent(games, particles = true) {
  assert.deepEqual(snapshot(games[0], particles), snapshot(games[1], particles));
}

describe("projectile spatial broad phase", () => {
  it("keeps enemy array order for overlapping non-piercing hits across a cell boundary", () => {
    const games = pair([enemy("east-first", 64.5), enemy("west-second", 63.5)], [shot(64)]);
    for (const game of games) game.updateProjectiles(0);
    equivalent(games);
    assert.deepEqual(games[0].enemies.map(e => e.hp), [75, 100]);
    assert.equal(games[0].projectiles.length, 0);
  });

  it("preserves piercing, pre-hit IDs, death drops and remaining enemy order", () => {
    const games = pair([
      enemy("already", -64), enemy("first-kill", -63, 0, { hp: 10, xp: 3 }),
      enemy("second-kill", -65, 0, { hp: 10 }), enemy("untouched", -64),
    ], [shot(-64, 0, { pierce: 1, hitIds: new Set(["already"]) })]);
    for (const game of games) game.updateProjectiles(0.01);
    equivalent(games);
    assert.deepEqual(games[0].enemies.map(e => [e.id, e.hp]), [["already", 100], ["untouched", 100]]);
    assert.equal(games[0].kills, 2);
    assert.deepEqual(games[0].gems.map(g => g.value), [3, 1]);
  });

  it("skips enemies killed by earlier shots in the same frame and keeps reverse shot order", () => {
    const games = pair([
      enemy("one", 0, 0, { hp: 10 }), enemy("two", 0, 0, { hp: 20 }),
      enemy("three", 0, 0, { hp: 30 }),
    ], Array.from({ length: 3 }, () => shot(0, 0, { damage: 15 })));
    const originalShots = games[0].projectiles.slice();
    const removedEnemy = games[0].enemies[0];
    for (const game of games) game.updateProjectiles(0);
    equivalent(games);
    assert.deepEqual(originalShots.map(s => [...s.hitIds]), [["two"], ["two"], ["one"]]);
    assert.deepEqual(games[0].enemies.map(e => [e.id, e.hp]), [["three", 30]]);
    assert.equal(games[0].kills, 2);
    games[0].killEnemy(removedEnemy);
    assert.equal(games[0].gems.length, 2);
  });

  it("handles exact tangency, diagonal misses, negative cells and very large radii", () => {
    const games = pair([
      enemy("negative-tangent", -80, -64, { radius: 11 }),
      enemy("diagonal-miss", -48, -48, { radius: 11 }),
      enemy("large-enemy", 10000000, -64, { radius: 10000064 }),
      enemy("far-large-shot", -10000, 10000),
    ], [shot(-64, -64, { pierce: 10 }), shot(500, 500, { radius: 20000, pierce: 10 })]);
    for (const game of games) game.updateProjectiles(0);
    equivalent(games);
    assert.deepEqual([...games[0].projectiles[0].hitIds], ["negative-tangent", "large-enemy"]);
  });

  it("retains endpoint collision behavior when a fast shot passes through an enemy", () => {
    const games = pair([enemy("passed", 0)], [shot(-100, 0, { vx: 4000 })]);
    for (const game of games) game.updateProjectiles(0.05);
    equivalent(games);
    assert.equal(games[0].enemies[0].hp, 100);
    assert.equal(games[0].projectiles[0].hitIds.size, 0);
  });

  it("matches the naive simulation across seeded layouts, movement, spawning and repeated updates", () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const random = mulberry32(seed);
      const enemies = Array.from({ length: 160 }, (_, i) => enemy(`enemy-${i}`,
        (random() - 0.5) * 800, (random() - 0.5) * 800, {
          hp: 5 + random() * 70, radius: random() * (i % 11 === 0 ? 250 : 24),
          speed: random() * 80, xp: 1 + Math.floor(random() * 3),
        }));
      const shots = Array.from({ length: 80 }, (_, i) => shot(
        (random() - 0.5) * 800, (random() - 0.5) * 800, {
          vx: (random() - 0.5) * 900, vy: (random() - 0.5) * 900,
          radius: 1 + random() * 85, damage: 5 + random() * 35,
          pierce: Math.floor(random() * 5), life: 0.1 + random(),
          hitIds: new Set(i % 4 === 0 ? [`enemy-${i}`] : []),
        }));
      const games = pair(enemies, shots, seed);
      for (const game of games) {
        game.spawnClock = 1.2;
        game.player.health = 100000;
        game.player.xpNext = 1000000;
      }
      for (let frame = 0; frame < 16; frame += 1) {
        for (const game of games) game.update(0.05, { moveX: 1, moveY: -1, dash: frame === 0 });
        equivalent(games);
      }
      assert.equal(games[0].state, "playing");
      assert.equal(games[0].random(), games[1].random());
    }
  });

  it("rebuilds after external removals, movement, new spawns, empty frames and reset", () => {
    const games = pair([enemy("old", 500)], [shot()]);
    for (const game of games) {
      game.updateProjectiles(0);
      game.enemies[0].x = 0;
      game.updateProjectiles(0);
      game.enemies.splice(0, 1);
      game.spawnEnemy();
      game.enemies[0].x = 0;
      game.enemies[0].y = 0;
      game.projectiles.push(shot());
      game.updateProjectiles(0);
      game.projectiles.length = 0;
      game.updateProjectiles(0);
      assert.equal(game.collisionChecksLastUpdate, 0);
    }
    equivalent(games);
    for (const game of games) {
      game.reset();
      assert.equal(game.collisionChecksLastUpdate, 0);
      assert.equal(game.particleLimit, Infinity);
      game.enemies.push(enemy("fresh"));
      game.projectiles.push(shot());
      game.updateProjectiles(0);
    }
    equivalent(games);
    assert.equal(games[0].enemies[0].hp, 75);
  });

  it("checks nearby candidates instead of every distant enemy for every shot", () => {
    const enemies = Array.from({ length: 6000 }, (_, i) => enemy(`far-${i}`,
      500 + (i % 100) * 8, 500 + Math.floor(i / 100) * 8));
    enemies.splice(200, 0, enemy("near", 0, 0, { hp: 1000000 }));
    const games = pair(enemies, Array.from({ length: 100 }, () => shot(0, 0, { pierce: 10 })));
    games[0].particleLimit = 0;
    for (const game of games) game.updateProjectiles(0);
    equivalent(games, false);
    assert.equal(games[0].collisionChecksLastUpdate, 100);
    assert.equal(games[1].collisionChecksLastUpdate, 600100);
    assert.equal(games[0].random(), games[1].random());
  });

  it("recycles bucket and query storage across moving layouts, large queries and clears", () => {
    const grid = new SpatialGrid();
    grid.rebuild([enemy("first", 65), enemy("second", -1), enemy("third", 100)]);
    const buckets = grid.bucketPool.slice();
    const rows = grid.rowPool.slice();
    const results = grid.query(0, 0, 1e12);
    assert.deepEqual(results.map(i => grid.items[i].id), ["first", "second", "third"]);
    grid.remove(grid.items[1]);
    assert.deepEqual(grid.query(0, 0, 1e12), [0, 2]);
    for (let frame = 0; frame < 100; frame += 1) {
      grid.rebuild([enemy("first", 65 + frame * 1024), enemy("second", -1 + frame * 1024), enemy("third", 100 + frame * 1024)]);
      assert.equal(grid.query(frame * 1024, 0, 1e12), results);
      assert.equal(grid.bucketPool.length, buckets.length);
      buckets.forEach((bucket, i) => assert.equal(grid.bucketPool[i], bucket));
      assert.equal(grid.rowPool.length, rows.length);
      rows.forEach((row, i) => assert.equal(grid.rowPool[i], row));
      assert.deepEqual(results, [0, 1, 2]);
    }
    grid.clear();
    assert.deepEqual(grid.query(0, 0, 1e12), []);
  });
});

describe("decoration particle budget", () => {
  it("defaults to 360 particles and preserves a renderer override across restarts", () => {
    const game = new SurvivorGame();
    assert.equal(game.particleLimit, 360);
    game.burst(0, 0, "#fff", 1000);
    assert.equal(game.particles.length, 360);
    game.particleLimit = 7;
    game.start();
    game.burst(0, 0, "#fff", 1000);
    assert.equal(game.particles.length, 7);
    game.state = "gameover";
    game.start();
    assert.equal(game.particleLimit, 7);
    assert.equal(game.particles.length, 0);
  });

  it("consumes the original burst RNG draws even when full or disabled, keeping XP and later spawns identical", () => {
    for (const initialLimit of [0, 7, 360]) {
      const games = pair([], [], 1234);
      games[0].particleLimit = initialLimit;
      for (const game of games) game.burst(4, 8, "#abc", 1000);
      assert.deepEqual(games[0].particles, games[1].particles.slice(0, initialLimit));
      for (const limit of [initialLimit, 0, 13, 2, 360]) {
        games[0].particleLimit = limit;
        for (const game of games) {
          game.burst(1, 2, "#fff", 77);
          for (let i = 0; i < 5; i += 1) game.spawnEnemy();
          game.killEnemy(game.enemies[0]);
          game.fireVolley(game.enemies[0]);
          game.updateParticles(0.05);
        }
        assert.ok(games[0].particles.length <= limit);
        equivalent(games, false);
      }
      for (let i = 0; i < 10; i += 1) assert.equal(games[0].random(), games[1].random());
    }
  });

  it("compacts survivors in place, retaining their order and original motion", () => {
    const games = pair([], []);
    for (const game of games) {
      game.burst(4, 8, "#fff", 20);
      game.particles.forEach((p, i) => { p.life = i % 3 === 0 ? 0.01 : 0.5; });
    }
    const storage = games[0].particles;
    const survivors = storage.filter(p => p.life > 0.05);
    for (const game of games) game.updateParticles(0.05);
    equivalent(games);
    assert.equal(games[0].particles, storage);
    survivors.forEach((p, i) => assert.equal(storage[i], p));
    games[0].particleLimit = 3;
    for (const game of games) game.updateParticles(0.05);
    assert.deepEqual(games[0].particles, games[1].particles.slice(0, 3));
    games[0].particleLimit = 0;
    games[0].updateParticles(0);
    assert.equal(storage.length, 0);
  });
});
