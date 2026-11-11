import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurvivorGame, WORLD_SIZE } from "../src/game/game.js";
import { getCameraCenter, isInsideWorld } from "../src/game/world.js";

const step = (game, seconds = 0.05, input = {}) => game.update(seconds, input, { width: 800, height: 600 });

describe("SurvivorGame", () => {
  it("starts cleanly and clamps delta to keep simulation bounded", () => {
    const game = new SurvivorGame(42);
    assert.equal(game.state, "title");
    game.start();
    step(game, 9);
    assert.ok(game.elapsed <= 0.05);
    assert.equal(game.state, "playing");
  });

  it("uses deterministic spawning for a fixed seed and update sequence", () => {
    const a = new SurvivorGame(1234), b = new SurvivorGame(1234);
    a.start(); b.start();
    for (let i = 0; i < 45; i += 1) { step(a); step(b); }
    assert.equal(a.enemies.length, b.enemies.length);
    assert.deepEqual(a.enemies.map(({ type, x, y }) => [type, x, y]), b.enemies.map(({ type, x, y }) => [type, x, y]));
  });

  it("applies movement and clamps the survivor to the fixed world", () => {
    const game = new SurvivorGame(1); game.start();
    step(game, 0.05, { moveX: 1, moveY: 1 });
    assert.ok(game.player.x > 0 && game.player.y > 0);
    for (let i = 0; i < 400; i += 1) step(game, 0.05, { moveX: 1 });
    assert.equal(game.player.x, WORLD_SIZE.width / 2 - game.player.radius);
    assert.ok(isInsideWorld(game.player.x, game.player.y, game.player.radius));
  });

  it("rotates the survivor's facing toward movement and keeps it after stopping", () => {
    const game = new SurvivorGame(2); game.start();
    step(game, 0.05, { moveX: 0, moveY: -1 });
    assert.ok(Math.abs(game.player.facing + Math.PI / 2) < 1e-8);
    const stoppedFacing = game.player.facing;
    step(game, 0.05);
    assert.equal(game.player.facing, stoppedFacing);
    step(game, 0.05, { moveX: 1, moveY: 0 });
    assert.ok(Math.abs(game.player.facing) < 1e-8);
  });

  it("keeps the camera centered inside the map and clamps it at the edge", () => {
    assert.deepEqual(getCameraCenter(0, 0, 800, 600), { x: 0, y: 0 });
    assert.deepEqual(getCameraCenter(5000, 5000, 800, 600), {
      x: WORLD_SIZE.width / 2 - 400,
      y: WORLD_SIZE.height / 2 - 300,
    });
  });

  it("spawns enemies inside the reachable world", () => {
    const game = new SurvivorGame(3); game.start();
    game.player.x = WORLD_SIZE.width / 2 - game.player.radius;
    for (let i = 0; i < 40; i += 1) game.spawnEnemy({ width: 800, height: 600 });
    assert.ok(game.enemies.length > 0);
    assert.ok(game.enemies.every(enemy => isInsideWorld(enemy.x, enemy.y, enemy.radius)));
  });

  it("clamps dropped XP into the world if a kill happens outside", () => {
    const game = new SurvivorGame(4); game.start();
    const outsideEnemy = { id: "outside", x: WORLD_SIZE.width, y: WORLD_SIZE.height, xp: 1, color: "#fff" };
    game.enemies.push(outsideEnemy);
    game.killEnemy(outsideEnemy);
    assert.equal(game.gems.length, 1);
    assert.ok(isInsideWorld(game.gems[0].x, game.gems[0].y, game.gems[0].radius));
  });

  it("collects a defeated enemy's XP and enters upgrade selection", () => {
    const game = new SurvivorGame(77); game.start();
    game.player.damage = 1000;
    const enemy = { id: "test", type: "shade", x: 25, y: 0, hp: 1, maxHp: 1, speed: 0, radius: 10, damage: 0, color: "#fff", xp: 8, contactClock: 10, hitFlash: 0 };
    game.enemies.push(enemy);
    game.fireClock = 0;
    step(game);
    assert.equal(game.kills, 1);
    assert.equal(game.player.level, 2);
    assert.equal(game.state, "levelup");
    assert.equal(game.upgradeChoices.length, 3);
  });

  it("keeps excess XP and offers the next level after an upgrade", () => {
    const game = new SurvivorGame(12); game.start();
    game.player.xp = 300;
    game.checkLevelUp();
    assert.equal(game.player.level, 2);
    assert.equal(game.chooseUpgrade(game.upgradeChoices[0].id), true);
    assert.equal(game.state, "levelup");
    assert.equal(game.player.level, 3);
  });

  it("only activates a dash when there is a movement direction", () => {
    const game = new SurvivorGame(13); game.start();
    step(game, 0.05, { dash: true });
    assert.equal(game.player.dashCooldown, 0);
    step(game, 0.05, { moveX: 1, dash: true });
    assert.equal(game.player.dashCooldown, 2.1);
    assert.ok(game.player.x > 10);
  });

  it("only accepts offered upgrades and spends excess XP across levels", () => {
    const game = new SurvivorGame(9); game.start();
    game.player.xp = 35;
    game.checkLevelUp();
    game.player.xp += 30;
    const offered = game.upgradeChoices[0];
    assert.equal(game.chooseUpgrade("not-offered"), false);
    assert.equal(game.chooseUpgrade(offered.id), true);
    assert.equal(game.state, "levelup");
    assert.equal(game.player.level, 3);
    assert.equal(game.state, "levelup");
  });

  it("pauses and resumes without advancing simulation time", () => {
    const game = new SurvivorGame(10); game.start(); game.pause();
    const elapsed = game.elapsed;
    step(game, 0.05);
    assert.equal(game.elapsed, elapsed);
    game.resume(); step(game);
    assert.ok(game.elapsed > elapsed);
  });
});
