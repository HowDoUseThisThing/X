import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurvivorGame } from "../src/game/game.js";
import { defaultSave, normalizeSave, SaveStore, purchaseMeta, unlockCharacter, calcEchoes } from "../src/game/progression.js";
import { CHARACTERS, META_UPGRADES, WEAPONS, PASSIVES } from "../src/game/content.js";

const step = (game, seconds = 0.05, input = {}) => game.update(seconds, input, { width: 800, height: 600 });

describe("strategy build", () => {
  it("keeps deterministic three-card choices and rerolls", () => {
    const a = new SurvivorGame(77), b = new SurvivorGame(77);
    for (const game of [a, b]) { game.start(); game.player.xp = 8; game.checkLevelUp(); }
    assert.deepEqual(a.upgradeChoices.map(c => c.id), b.upgradeChoices.map(c => c.id));
    assert.equal(a.upgradeChoices.length, 3);
    assert.equal(new Set(a.upgradeChoices.map(c => c.id)).size, 3);
    const before = a.upgradeChoices.map(c => c.id).join();
    assert.equal(a.rerollUpgrades(), true);
    assert.equal(a.rerollsRemaining, 1);
    assert.equal(a.state, "levelup");
    assert.notEqual(a.upgradeChoices.map(c => c.id).join(), "");
    assert.ok(before);
  });

  it("enforces four weapon and four passive slots", () => {
    const game = new SurvivorGame(4); game.start();
    for (const id of ["orbitBlade", "tideNova", "chainSpark"]) game.applyChoice({ type: "weapon", target: id });
    assert.equal(game.activeWeapons.length, 4);
    assert.equal(game.applyChoice({ type: "weapon", target: "graveField" }), false);
    for (const id of ["might", "tempo", "area", "vitality"]) game.applyChoice({ type: "passive", target: id });
    assert.equal(Object.keys(game.build.passives).length, 4);
    assert.equal(game.applyChoice({ type: "passive", target: "magnet" }), false);
  });

  it("applies weapon levels and evolution only when passive reaches level three", () => {
    const game = new SurvivorGame(8); game.start();
    const arrow = game.build.weapons.find(w => w.id === "moonArrow");
    arrow.level = 5;
    assert.equal(game.applyChoice({ type: "evolve", target: "moonArrow" }), false);
    game.applyChoice({ type: "passive", target: "might" });
    game.applyChoice({ type: "passive", target: "might" });
    game.applyChoice({ type: "passive", target: "might" });
    assert.equal(game.applyChoice({ type: "evolve", target: "moonArrow" }), true);
    assert.equal(arrow.evolved, true);
    assert.equal(game.evolutions, 1);
    const choices = game.rollUpgradeChoices(false);
    assert.ok(choices.every(c => !(c.type === "evolve" && c.target === "moonArrow")));
  });

  it("skips with compensation only twice and resumes play", () => {
    const game = new SurvivorGame(11); game.start();
    game.player.xp = 8; game.checkLevelUp();
    assert.equal(game.skipUpgrade(), true);
    assert.equal(game.skipsRemaining, 1);
    game.player.xp = game.player.xpNext; game.checkLevelUp();
    assert.equal(game.skipUpgrade(), true);
    game.player.xp = game.player.xpNext; game.checkLevelUp();
    assert.equal(game.skipUpgrade(), false);
    assert.equal(game.state, "levelup");
  });

  it("spawns weapons and keeps enemy/projectile collections bounded during play", () => {
    const game = new SurvivorGame(13); game.start();
    for (const id of ["orbitBlade", "tideNova", "chainSpark", "graveField"]) game.applyChoice({ type: "weapon", target: id });
    for (let i = 0; i < 1200; i += 1) step(game, 0.016, { moveX: 1, moveY: 0.3 });
    assert.ok(game.elapsed > 0);
    assert.ok(game.enemies.length < 1000);
    assert.ok(game.enemyProjectiles.length < 600);
    assert.ok(game.projectiles.length < 600);
  });
});

describe("bosses and progression", () => {
  it("spawns the timed boss, drops a chest and increments stats", () => {
    const game = new SurvivorGame(5); game.start(); game.elapsed = 181;
    const boss = game.spawnBoss({ width: 800, height: 600 }, 0);
    assert.equal(boss.name, "潮汐巨像");
    assert.ok(boss.maxHp > 1000);
    boss.hp = 1;
    game.projectiles.push({ x: boss.x, y: boss.y, vx: 0, vy: 0, radius: 20, damage: 100, life: 2, pierce: 0, hitIds: new Set(), trail: [] });
    game.updateProjectiles(0.01);
    assert.equal(game.boss, null);
    assert.equal(game.bossKills, 1);
    assert.equal(game.pickups.filter(p => p.type === "chest").length, 1);
  });

  it("round-trips valid saves and falls back on damaged or old saves", () => {
    const memory = new Map();
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
    const store = new SaveStore(storage), save = defaultSave();
    save.echoes = 999; save.meta.life = 3; save.unlocked.warden = true;
    store.save(save);
    const loaded = store.load();
    assert.equal(loaded.echoes, 999); assert.equal(loaded.meta.life, 3); assert.equal(loaded.unlocked.warden, true);
    storage.setItem("moonlit-survivor-save-v1", "{broken");
    assert.deepEqual(store.load(), defaultSave());
    storage.setItem("moonlit-survivor-save-v1", JSON.stringify({ version: 0, echoes: 999 }));
    assert.deepEqual(store.load(), defaultSave());
  });

  it("purchases meta levels and unlocks characters without overspending", () => {
    let save = defaultSave(); save.echoes = 1000;
    const bought = purchaseMeta(save, "life", META_UPGRADES);
    assert.equal(bought.purchased, true); assert.equal(bought.save.echoes, 880); assert.equal(bought.save.meta.life, 1);
    const unlocked = unlockCharacter(bought.save, "warden", CHARACTERS);
    assert.equal(unlocked.unlocked, true); assert.equal(unlocked.save.echoes, 480); assert.equal(unlocked.save.unlocked.warden, true);
    const denied = unlockCharacter({ ...unlocked.save, echoes: 0 }, "oracle", CHARACTERS);
    assert.equal(denied.unlocked, false);
  });

  it("calculates echo rewards and applies death penalty", () => {
    const survived = calcEchoes({ kills: 100, seconds: 300, bosses: 2, level: 20, chests: 2, died: false, altarRanks: 1 });
    const died = calcEchoes({ kills: 100, seconds: 300, bosses: 2, level: 20, chests: 2, died: true, altarRanks: 1 });
    assert.ok(survived > 0); assert.ok(died < survived);
    assert.equal(calcEchoes({}), 3);
  });
});
