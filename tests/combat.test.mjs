import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurvivorGame, ENTITY_LIMITS } from "../src/game/game.js";
import { ACHIEVEMENTS, CHARACTERS, WEAPONS } from "../src/game/content.js";
import { defaultSave } from "../src/game/progression.js";

const VIEW = { width: 800, height: 600 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, message ?? `${actual} ≈ ${expected}`);

function playing(character = "ranger") {
  const profile = defaultSave();
  profile.unlocked = { ranger: true, warden: true, oracle: true };
  const game = new SurvivorGame(0xc0ffee, { profile });
  assert.equal(game.start(character), true);
  // Isolate the encounter without replacing any combat methods.
  game.spawnClock = -1e6;
  game.nextWave = game.nextElite = game.nextBoss = Number.MAX_VALUE;
  game.fireClock = 1e6;
  game.particleLimit = 0;
  return game;
}

function weapon(game, id, level = 1, evolved = false) {
  let owned = game.activeWeapons.find(item => item.id === id);
  if (!owned) {
    assert.equal(game.applyChoice({ type: "weapon", target: id }), true);
    owned = game.activeWeapons.find(item => item.id === id);
  }
  while (owned.level < level) assert.equal(game.applyChoice({ type: "weapon", target: id }), true);
  if (evolved) {
    const passive = WEAPONS[id].passive;
    while ((game.build.passives[passive] || 0) < 3) assert.equal(game.applyChoice({ type: "passive", target: passive }), true);
    assert.equal(game.applyChoice({ type: "evolve", target: id }), true);
  }
  return owned;
}

function target(game, x, y = 0, type = "shade", hp = 10000) {
  const enemy = game.spawnEnemy(VIEW, type, { x, y });
  assert.ok(enemy);
  enemy.hp = enemy.maxHp = hp;
  enemy.speed = 0;
  return enemy;
}

function pickup(game, type, extra = {}) {
  const item = { type, x: game.player.x, y: game.player.y, radius: 11, phase: 0, ...extra };
  game.addEntity("pickups", item);
  return item;
}

function until(game, predicate, tick, max = 200) {
  for (let i = 0; i < max && !predicate(); i += 1) tick();
  assert.ok(predicate(), "combat transition did not complete within its frame budget");
}

describe("real weapon combat", () => {
  it("automatically fires arrows, hits a real enemy and produces death drops", () => {
    const game = playing();
    const enemy = target(game, 46, 0, "shade", 10);
    game.player.pickupChance = 0;
    game.fireClock = 0;
    game.update(0.05, {}, VIEW);
    assert.equal(game.projectiles.length, 1);
    assert.equal(enemy.hp, 10, "the arrow has not reached the target yet");
    game.update(0.05, {}, VIEW);
    assert.equal(game.enemies.includes(enemy), false);
    assert.equal(game.kills, 1);
    assert.equal(game.gems.length, 1);
    assert.equal(game.projectiles.length, 0);
  });

  it("resolves the same real projectile kill with an independent or a prepared shared grid", () => {
    const snapshots = [];
    for (const prepared of [false, true]) {
      const game = playing(), enemy = target(game, 46, 0, "shade", 10);
      target(game, 400);
      game.player.pickupChance = 0;
      game.fireVolley(enemy);
      if (prepared) game.enemyGrid.rebuild(game.enemies);
      game.updateProjectiles(0.1, prepared);
      assert.equal(game.kills, 1);
      assert.equal(game.enemies.includes(enemy), false);
      assert.equal(game.gems.length, 1);
      snapshots.push({ enemies: game.enemies, gems: game.gems, projectiles: game.projectiles, kills: game.kills });
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  });

  for (const id of ["warden", "oracle"]) {
    it(`${id} starts without hidden arrows and can acquire and fire them later`, () => {
      const game = playing(id);
      target(game, 400);
      game.fireClock = 0;
      for (let i = 0; i < 8; i += 1) game.update(0.05, {}, VIEW);
      assert.equal(game.arrowState, null);
      assert.deepEqual(game.activeWeapons.map(item => item.id), [CHARACTERS[id].weapon]);
      assert.equal(game.projectiles.some(shot => shot.kind === "arrow"), false);
      weapon(game, "moonArrow");
      game.update(0.05, {}, VIEW);
      assert.equal(game.arrowState.level, 1);
      assert.ok(game.projectiles.some(shot => shot.kind === "arrow"));
    });
  }

  it("updates orbit geometry every frame despite a positive weapon clock and respects hit cooldowns", () => {
    const game = playing();
    weapon(game, "orbitBlade");
    const enemy = target(game, 64);
    game.weaponClocks.orbitBlade = 100;
    game.update(0.05, {}, VIEW);
    near(enemy.hp, 10000 - game.weaponDamage("orbitBlade"));
    const afterHit = enemy.hp, first = { ...game.orbitBlades[0] };
    game.update(0.05, {}, VIEW);
    assert.notEqual(game.orbitBlades[0].y, first.y);
    assert.equal(enemy.hp, afterHit, "overlapping blades cannot damage again on the next frame");
    for (let i = 0; i < 9; i += 1) game.update(0.05, {}, VIEW);
    Object.assign(enemy, { x: game.orbitBlades[0].x, y: game.orbitBlades[0].y });
    game.enemyGrid.rebuild(game.enemies);
    game.updateOtherWeapons(0);
    near(enemy.hp, afterHit - game.weaponDamage("orbitBlade"));
  });

  it("chains actual damage between nearby targets with attenuation and excludes distant enemies", () => {
    const game = playing();
    weapon(game, "chainSpark");
    const targets = [100, 220, 340, 700].map(x => target(game, x));
    game.update(0.05, {}, VIEW);
    targets.slice(0, 3).forEach((enemy, index) => near(10000 - enemy.hp, 30 * 0.88 ** index));
    assert.equal(targets[3].hp, 10000);
    const health = targets.map(enemy => enemy.hp);
    game.update(0.05, {}, VIEW);
    assert.deepEqual(targets.map(enemy => enemy.hp), health);
  });

  it("casts a nova that damages, knocks back and waits for its next cooldown", () => {
    const game = playing();
    weapon(game, "tideNova");
    const inside = target(game, 70), outside = target(game, 250);
    game.update(0.05, {}, VIEW);
    near(inside.hp, 9972);
    assert.ok(inside.x > 70);
    assert.equal(outside.hp, 10000);
    game.update(0.05, {}, VIEW);
    assert.equal(inside.hp, 9972);
  });

  it("places a grave field in the densest nearby occupied bucket and applies timed damage", () => {
    const game = playing();
    weapon(game, "graveField");
    const sparse = target(game, 80, 10);
    const dense = [260, 265, 270].map(x => target(game, x, 20));
    const far = [900, 905, 910, 915].map(x => target(game, x, 20));
    game.enemyGrid.rebuild(game.enemies);
    game.updateOtherWeapons(0.01);
    assert.equal(game.zones.length, 1);
    assert.deepEqual([game.zones[0].x, game.zones[0].y], [dense[0].x, dense[0].y]);
    game.updateZones(0.39);
    assert.ok(dense.every(enemy => enemy.hp === 10000));
    game.updateZones(0.02);
    dense.forEach(enemy => near(enemy.hp, 9996));
    assert.equal(sparse.hp, 10000);
    assert.ok(far.every(enemy => enemy.hp === 10000));
  });

  it("hits once outbound and again on the return of a real boomerang", () => {
    const game = playing();
    const owned = weapon(game, "echoBoomerang");
    const enemy = target(game, 100);
    game.fireBoomerang(owned);
    until(game, () => game.projectiles.length === 0, () => game.updateProjectiles(0.02));
    near(enemy.hp, 10000 - 2 * game.weaponDamage("echoBoomerang"));
  });
});

describe("all six weapon evolutions", () => {
  for (const id of Object.keys(WEAPONS)) {
    it(`${id} requires level five and its level-three passive, then evolves through a real chest choice`, () => {
      const underleveled = playing();
      weapon(underleveled, id, 4);
      for (let i = 0; i < 3; i += 1) underleveled.applyChoice({ type: "passive", target: WEAPONS[id].passive });
      assert.equal(underleveled.applyChoice({ type: "evolve", target: id }), false);
      const game = playing();
      const owned = weapon(game, id, 4), passive = WEAPONS[id].passive;
      assert.equal(game.applyChoice({ type: "evolve", target: id }), false);
      weapon(game, id, 5);
      for (let i = 0; i < 2; i += 1) game.applyChoice({ type: "passive", target: passive });
      assert.equal(game.applyChoice({ type: "evolve", target: id }), false);
      game.applyChoice({ type: "passive", target: passive });
      const slots = game.activeWeapons.length;
      assert.equal(game.openChest(), true);
      const choice = game.chestChoices.find(item => item.type === "evolve" && item.target === id);
      assert.ok(choice);
      assert.equal(game.chooseChestUpgrade(choice.id), true);
      assert.equal(owned.evolved, true);
      assert.equal(game.evolutions, 1);
      assert.equal(game.chestsOpened, 1);
      assert.equal(game.activeWeapons.length, slots);
      assert.equal(game.applyChoice({ type: "evolve", target: id }), false);
      assert.equal(game.rollUpgradeChoices(true).some(item => item.type === "evolve" && item.target === id), false);
    });
  }

  it("evolved arrow hits split into homing fragments which damage a second enemy", () => {
    const game = playing();
    weapon(game, "moonArrow", 5, true);
    const first = target(game, 46), second = target(game, 150, 120);
    game.fireVolley(first);
    game.updateProjectiles(0.1);
    const fragments = game.projectiles.filter(shot => shot.kind === "fragment");
    assert.ok(fragments.length >= 2);
    assert.ok(fragments.every(shot => shot.hitIds.has(first.id)));
    for (let i = 0; i < 35; i += 1) game.updateProjectiles(0.02);
    assert.ok(second.hp < 10000, "off-axis enemies are hit by homing fragments");
  });

  it("evolved orbit leaves blade trails that damage enemies independently", () => {
    const game = playing();
    weapon(game, "orbitBlade", 5, true);
    game.enemyGrid.rebuild(game.enemies);
    game.updateOtherWeapons(0.01);
    const trail = game.zones.find(zone => zone.kind === "blade");
    assert.ok(trail);
    const enemy = target(game, trail.x, trail.y);
    game.enemyGrid.rebuild(game.enemies);
    game.updateZones(0.01);
    near(enemy.hp, 10000 - game.weaponDamage("orbitBlade") * 0.18);
  });

  it("evolved nova delays its second hit and deals 65% of its actual scaled damage once", () => {
    const game = playing();
    weapon(game, "tideNova", 5, true);
    const enemy = target(game, 40), damage = game.weaponDamage("tideNova");
    game.update(0.05, {}, VIEW);
    near(enemy.hp, 10000 - damage);
    for (let i = 0; i < 3; i += 1) game.update(0.05, {}, VIEW);
    near(enemy.hp, 10000 - damage);
    game.update(0.05, {}, VIEW);
    near(enemy.hp, 10000 - damage * 1.65);
    game.updateEffects(1);
    near(enemy.hp, 10000 - damage * 1.65);
  });

  it("evolved lightning ticks immediately before its short-lived terminal zone expires", () => {
    const game = playing();
    weapon(game, "chainSpark", 5, true);
    const targets = [100, 220, 340, 460, 580].map(x => target(game, x));
    const damage = game.weaponDamage("chainSpark");
    game.update(0.05, {}, VIEW);
    const terminal = targets.at(-1);
    near(10000 - terminal.hp, damage * 0.88 ** 4 + damage * 0.5);
    assert.ok(game.zones.some(zone => zone.kind === "lightning" && zone.life > 0));
    game.updateZones(0.36);
    near(10000 - terminal.hp, damage * 0.88 ** 4 + damage * 0.5);
  });

  it("evolved grave fields follow and heal only while the player is inside, without stacking healing", () => {
    const game = playing();
    weapon(game, "graveField", 5, true);
    game.enemyGrid.rebuild(game.enemies);
    game.updateOtherWeapons(0.01);
    const field = game.zones[0];
    assert.ok(game.zones.filter(zone => Math.hypot(zone.x - game.player.x, zone.y - game.player.y) <= zone.radius).length > 1,
      "multiple overlapping fields are required to exercise healing deduplication");
    game.player.health = game.player.maxHealth - 20;
    const before = game.player.health;
    game.updateZones(0.1);
    near(game.player.health, before + 0.12);
    game.player.x = 500;
    const x = field.x, outsideHealth = game.player.health;
    game.updateZones(0.1);
    assert.ok(field.x > x);
    assert.equal(game.player.health, outsideHealth);
    game.player.x = field.x; game.player.y = field.y;
    game.updateZones(0.1);
    near(game.player.health, outsideHealth + 0.12);
  });

  it("evolved boomerang return splits into three real damaging echo shots", () => {
    const game = playing();
    const owned = weapon(game, "echoBoomerang", 5, true);
    game.fireBoomerang(owned);
    game.projectiles.splice(1); // Follow one returning boomerang in isolation.
    until(game, () => !game.projectiles.some(shot => shot.kind === "boomerang"), () => game.updateProjectiles(0.02));
    assert.equal(game.projectiles.length, 3);
    const shot = game.projectiles.find(item => item.vx > 0);
    const enemy = target(game, shot.x + 50, shot.y);
    game.updateProjectiles(0.1);
    near(enemy.hp, 10000 - game.weaponDamage("echoBoomerang") * 0.45);
  });
});

describe("eight enemy types and boss attacks", () => {
  for (const id of ["shade", "runner", "brute"]) {
    it(`${id} chases and deals contact damage with invulnerability preventing repeated hits`, () => {
      const game = playing();
      const enemy = game.spawnEnemy(VIEW, id, { x: 200, y: 0 });
      game.updateEnemies(0.1);
      near(enemy.x, 200 - enemy.speed * 0.1);
      assert.equal(enemy.y, 0);
      enemy.x = 1;
      const before = game.player.health;
      game.updateEnemies(0);
      near(game.player.health, before - enemy.damage);
      game.updateEnemies(0);
      near(game.player.health, before - enemy.damage);
    });
  }

  it("wraiths weave laterally while approaching", () => {
    const game = playing();
    const enemy = game.spawnEnemy(VIEW, "wraith", { x: 200, y: 0 });
    game.elapsed = 0.5;
    game.updateEnemies(0.1);
    assert.ok(enemy.x < 200);
    assert.ok(Math.abs(enemy.y) > 0.1);
  });

  it("gunners retreat nearby, slow at firing distance and launch a projectile that hurts the player", () => {
    const game = playing();
    const enemy = game.spawnEnemy(VIEW, "gunner", { x: 100, y: 0 });
    enemy.shootClock = 0;
    game.updateEnemies(0.1);
    assert.ok(enemy.x > 100);
    assert.equal(game.enemyProjectiles.length, 1);
    assert.ok(game.enemyProjectiles[0].vx < 0);
    const before = game.player.health;
    until(game, () => game.player.health < before, () => game.updateEnemyProjectiles(0.05));
    near(game.player.health, before - enemy.damage * 0.85);
    enemy.x = 250; enemy.shootClock = 10;
    game.updateEnemies(0.1);
    const middleStep = 250 - enemy.x;
    enemy.x = 400;
    game.updateEnemies(0.1);
    assert.ok(400 - enemy.x > middleStep * 5);
  });

  it("chargers telegraph, lock direction before the player moves and enter a cooldown after dashing", () => {
    const game = playing();
    const enemy = game.spawnEnemy(VIEW, "charger", { x: 200, y: 0 });
    game.updateEnemies(0.05);
    assert.equal(enemy.state, "windup");
    assert.equal(enemy.x, 200);
    near(enemy.dashX, -1); near(enemy.dashY, 0);
    game.player.y = 150;
    until(game, () => enemy.state === "dash", () => game.updateEnemies(0.05));
    assert.equal(enemy.x, 200);
    game.updateEnemies(0.05);
    assert.ok(enemy.x < 200);
    assert.equal(enemy.y, 0);
    until(game, () => enemy.state === "chase", () => game.updateEnemies(0.05));
    assert.ok(enemy.chargeClock > 0);
  });

  it("bombers ignite nearby, explode after the fuse and leave a hostile damaging zone without an XP drop", () => {
    const game = playing();
    const enemy = game.spawnEnemy(VIEW, "bomber", { x: 50, y: 0 });
    game.updateEnemies(0.05);
    assert.ok(enemy.fuse > 0);
    game.player.x = 600;
    until(game, () => !game.enemies.includes(enemy), () => game.updateEnemies(0.05));
    assert.equal(game.kills, 1);
    assert.equal(game.gems.length, 0);
    const zone = game.zones.find(item => item.kind === "bomb" && item.hostile);
    assert.ok(zone);
    game.player.x = zone.x; game.player.y = zone.y;
    const health = game.player.health;
    game.updateZones(0.4);
    near(game.player.health, health - zone.damage);
  });

  it("a killed splitter creates two chasing children which cannot split again", () => {
    const game = playing();
    const enemy = game.spawnEnemy(VIEW, "splitter", { x: 200, y: 0 });
    game.damageEnemy(enemy, enemy.hp);
    assert.equal(game.enemies.length, 2);
    assert.ok(game.enemies.every(child => child.noSplit && child.behavior === "chase"));
    const [child] = game.enemies, before = child.x;
    game.updateEnemies(0.1);
    assert.ok(child.x < before);
    game.damageEnemy(child, child.hp);
    assert.equal(game.enemies.length, 1);
    assert.equal(game.kills, 2);
  });

  it("colossus alternates a twelve-shot ring, four runner summons, then another ring", () => {
    const game = playing();
    const boss = game.spawnBoss(VIEW, 0);
    boss.shootClock = 0;
    game.updateEnemies(0.05);
    assert.equal(game.enemyProjectiles.length, 12);
    for (const shot of game.enemyProjectiles) near(Math.hypot(shot.vx, shot.vy), 145);
    const [a, , , , , , opposite] = game.enemyProjectiles;
    near(a.vx + opposite.vx, 0); near(a.vy + opposite.vy, 0);
    boss.shootClock = 0;
    game.updateEnemies(0.05);
    assert.equal(game.enemyProjectiles.length, 12);
    assert.equal(game.enemies.filter(enemy => enemy.type === "runner").length, 4);
    boss.shootClock = 0;
    game.updateEnemies(0.05);
    assert.equal(game.enemyProjectiles.length, 24);
  });

  it("executioner locks its windup direction, dashes, then alternates to a four-shot cross", () => {
    const game = playing();
    const boss = game.spawnBoss(VIEW, 1);
    boss.x = 300; boss.y = 0; boss.shootClock = 0;
    game.updateEnemies(0.05);
    assert.equal(boss.state, "windup");
    near(boss.dashX, -1); near(boss.dashY, 0);
    game.player.y = 200;
    until(game, () => boss.state === "dash", () => game.updateEnemies(0.05));
    assert.equal(boss.x, 300);
    game.updateEnemies(0.05);
    assert.ok(boss.x < 300);
    assert.equal(boss.y, 0);
    until(game, () => boss.state === "chase", () => game.updateEnemies(0.05));
    boss.shootClock = 0;
    game.updateEnemies(0.05);
    assert.equal(game.enemyProjectiles.length, 4);
    const shots = game.enemyProjectiles;
    for (const shot of shots) near(Math.hypot(shot.vx, shot.vy), 210);
    near(shots[0].vx + shots[2].vx, 0); near(shots[1].vy + shots[3].vy, 0);
  });

  for (const index of [0, 1]) {
    it(`${index ? "executioner" : "colossus"} enters phase two at exactly half HP and attacks faster`, () => {
      const game = playing(), boss = game.spawnBoss(VIEW, index);
      game.player.invulnerable = 100;
      boss.hp = boss.maxHp / 2 + 1; boss.shootClock = 0;
      game.updateEnemies(0);
      assert.equal(boss.phase, 1);
      const phaseOneCooldown = boss.shootClock;
      game.damageEnemy(boss, 1);
      game.updateEnemies(0);
      assert.equal(boss.phase, 2);
      until(game, () => boss.state === "chase", () => game.updateEnemies(0.05));
      boss.shootClock = 0;
      game.updateEnemies(0);
      assert.ok(boss.shootClock < phaseOneCooldown);
    });
  }

  it("a real boss kill heals, awards a single chest and cannot be counted twice", () => {
    const game = playing(), boss = game.spawnBoss(VIEW, 0);
    game.player.health = 50;
    assert.equal(game.damageEnemy(boss, boss.hp), true);
    assert.equal(game.boss, null);
    assert.equal(game.bossKills, 1);
    assert.equal(game.player.health, 70);
    assert.equal(game.pickups.filter(item => item.type === "chest").length, 1);
    assert.equal(game.damageEnemy(boss, 1), false);
    game.checkAchievements();
    assert.deepEqual(game.earnedAchievements, ["boss"]);
  });

  it("merges simultaneous wave, elite and boss warnings once and warns again for the next scheduled events", () => {
    const game = playing();
    game.nextWave = game.nextElite = game.nextBoss = 180;
    game.elapsed = 176.99;
    game.update(0, {}, VIEW);
    assert.equal(game.toastEvent, null);
    game.update(0.02, {}, VIEW);
    const warning = game.toastEvent;
    assert.match(warning.text, /潮汐合围/);
    assert.match(warning.text, /精英来袭/);
    assert.match(warning.text, /首领降临/);
    assert.match(warning.text, /3 秒后/);
    near(warning.at, 177.01);
    assert.deepEqual(game.prewarnings, { wave: 180, elite: 180, boss: 180 });
    game.update(0.05, {}, VIEW);
    assert.strictEqual(game.toastEvent, warning, "the same warnings must not be emitted every frame");
    game.elapsed = 180;
    game.update(0, {}, VIEW);
    assert.ok(game.boss);
    assert.ok(game.enemies.some(enemy => enemy.elite));
    assert.ok(game.enemies.some(enemy => !enemy.boss && !enemy.elite));
    game.nextWave = game.nextElite = game.nextBoss = 240;
    game.elapsed = 237;
    game.update(0, {}, VIEW);
    assert.notStrictEqual(game.toastEvent, warning);
    assert.match(game.toastEvent.text, /潮汐合围.*精英来袭.*首领降临/);
    assert.equal(game.toastEvent.at, 237);
  });
});

describe("altars, chests and four consumable pickups", () => {
  for (const kind of ["shade", "colossus", "executioner"]) {
    it(`altar curses immediately scale a wounded ${kind}, preserve its HP ratio and equally strengthen future spawns`, () => {
      const game = playing();
      const spawn = () => kind === "shade" ? game.spawnEnemy(VIEW, "shade", { x: 200, y: 0 })
        : game.spawnBoss(VIEW, kind === "colossus" ? 0 : 1);
      const enemy = spawn(), initial = { maxHp: enemy.maxHp, speed: enemy.speed };
      game.damageEnemy(enemy, enemy.maxHp * 0.25);
      for (const [index, altar] of game.altars.slice(0, 2).entries()) {
        game.player.x = altar.x; game.player.y = altar.y;
        game.updateAltars(2);
        const rank = index + 1;
        assert.equal(game.curse, rank);
        near(enemy.maxHp, initial.maxHp * (rank === 1 ? 1.1 : 1.2));
        near(enemy.hp / enemy.maxHp, 0.75, "activation preserves damage already dealt");
        near(enemy.speed, initial.speed * (rank === 1 ? 1.05 : 1.1));
      }
      game.damageEnemy(enemy, enemy.hp);
      const later = spawn();
      near(later.hp, initial.maxHp * 1.2);
      near(later.maxHp, enemy.maxHp);
      near(later.speed, enemy.speed);
    });
  }

  it("requires an altar dwell, adds curse pressure and supplies a usable chest while cooldown prevents repeats", () => {
    const game = playing(), baseline = playing(), altar = game.altars[0];
    game.player.x = altar.x; game.player.y = altar.y;
    game.updateAltars(1.99);
    assert.equal(game.curse, 0);
    game.updateAltars(0.02);
    assert.equal(game.curse, 1);
    assert.equal(game.altarRanks, 1);
    assert.equal(altar.cooldown, 180);
    const cursed = game.spawnEnemy(VIEW, "shade", { x: 0, y: 0 });
    const normal = baseline.spawnEnemy(VIEW, "shade", { x: 0, y: 0 });
    assert.ok(cursed.hp > normal.hp);
    assert.ok(cursed.speed > normal.speed);
    game.updatePickups(0);
    assert.equal(game.state, "chest");
    const choice = game.chestChoices[0];
    assert.equal(game.chooseChestUpgrade(choice.id), true);
    assert.equal(game.chestsOpened, 1);
    assert.equal(game.arrowState.level, 2);
    game.updateAltars(3);
    assert.equal(game.curse, 1);
    assert.equal(game.pickups.length, 0);
  });

  it("decays unfinished altar progress after leaving its radius", () => {
    const game = playing(), altar = game.altars[0];
    game.player.x = altar.x; game.player.y = altar.y;
    game.updateAltars(1.5);
    game.player.x += altar.radius + 100;
    game.updateAltars(1);
    near(altar.progress, 0.5);
    assert.equal(game.pickups.length, 0);
  });

  it("heart pickup restores 20% health and caps at maximum health", () => {
    const game = playing();
    game.player.health = 70;
    pickup(game, "heart"); game.updatePickups(0);
    assert.equal(game.player.health, 90);
    pickup(game, "heart"); game.updatePickups(0);
    assert.equal(game.player.health, 100);
    assert.equal(game.pickups.length, 0);
  });

  it("magnet pickup pulls otherwise unreachable XP gems and expires after six seconds", () => {
    const game = playing();
    const gem = { x: 450, y: 0, radius: 8, value: 1, phase: 0 };
    game.addEntity("gems", gem);
    game.updateGems(0.1);
    assert.equal(gem.x, 450);
    pickup(game, "magnet"); game.updatePickups(0);
    game.updateGems(0.1);
    assert.ok(gem.x < 450);
    until(game, () => game.gems.length === 0, () => game.updateGems(0.02));
    assert.equal(game.player.xp, 1);
    game.elapsed = 6.01;
    const later = { ...gem, x: 450 };
    game.addEntity("gems", later);
    game.updateGems(0.1);
    assert.equal(later.x, 450);
  });

  it("holy pickup creates a friendly zone which damages an enemy after the hazard interval", () => {
    const game = playing(), enemy = target(game, 100);
    pickup(game, "holy"); game.updatePickups(0);
    game.enemyGrid.rebuild(game.enemies);
    game.updateZones(0.39);
    assert.equal(enemy.hp, 10000);
    game.updateZones(0.02);
    near(enemy.hp, 9987);
    assert.equal(game.player.health, 100);
  });

  it("bomb pickup damages nearby enemies and excludes enemies outside its blast", () => {
    const game = playing(), inside = target(game, 100), outside = target(game, 600);
    pickup(game, "bomb"); game.updatePickups(0);
    near(inside.hp, 9840);
    assert.equal(outside.hp, 10000);
    assert.equal(game.pickups.length, 0);
  });
});

describe("achievements, profiles and death priority", () => {
  const triggers = {
    dawn(game) { game.elapsed = 179.99; game.update(0.02, {}, VIEW); },
    river(game) { game.kills = 499; const enemy = target(game, 200); game.damageEnemy(enemy, enemy.hp); game.update(0, {}, VIEW); },
    evolution(game) { weapon(game, "moonArrow", 5, true); },
    boss(game) { const boss = game.spawnBoss(VIEW, 0); game.damageEnemy(boss, boss.hp); game.update(0, {}, VIEW); },
    build(game) {
      for (const id of ["orbitBlade", "tideNova", "chainSpark"]) weapon(game, id);
      for (const id of ["might", "tempo", "area", "vitality"]) game.applyChoice({ type: "passive", target: id });
    },
    endless(game) { game.elapsed = 599.99; game.update(0.02, {}, VIEW); },
  };

  for (const [id, trigger] of Object.entries(triggers)) {
    it(`earns ${id} through gameplay and does not duplicate it after a same-run profile replacement`, () => {
      const game = playing();
      game.checkAchievements();
      assert.equal(game.earnedAchievements.includes(id), false);
      trigger(game);
      assert.equal(game.earnedAchievements.filter(earned => earned === id).length, 1);
      assert.equal(game.profile.achievements[id], undefined);
      const rewards = game.achievementRewards;
      game.setProfile(defaultSave());
      game.checkAchievements(); game.checkAchievements();
      assert.equal(game.earnedAchievements.filter(earned => earned === id).length, 1);
      assert.equal(game.achievementRewards, rewards);
      assert.equal(rewards, game.earnedAchievements.reduce((sum, earned) => sum + ACHIEVEMENTS[earned].reward, 0));
    });
  }

  it("does not award persisted achievements again even when every trigger is reached", () => {
    const game = playing(), profile = defaultSave();
    profile.achievements = Object.fromEntries(Object.keys(ACHIEVEMENTS).map(id => [id, true]));
    game.setProfile(profile);
    for (const trigger of Object.values(triggers)) trigger(game);
    assert.deepEqual(game.earnedAchievements, []);
    assert.equal(game.achievementRewards, 0);
  });

  it("freezes current-run meta stats and applies a changed profile at the next start", () => {
    const game = playing(), profile = defaultSave();
    profile.meta = { life: 5, ember: 5, light: 5, fate: 2, fortune: 5 };
    game.setProfile(profile);
    game.applyChoice({ type: "passive", target: "agility" }); // Recalculate real stats mid-run.
    assert.equal(game.player.maxHealth, 100);
    assert.equal(game.player.damageMultiplier, 1);
    assert.equal(game.player.xpMultiplier, 1);
    assert.equal(game.player.pickupChance, 0.04);
    assert.equal(game.rerollsRemaining, 2);
    const runId = game.runId;
    game.pause(); assert.equal(game.evacuate(), true);
    assert.equal(game.summary.runId, runId);
    game.start();
    assert.notEqual(game.runId, runId);
    assert.equal(game.player.maxHealth, 115);
    near(game.player.damageMultiplier, 1.15);
    near(game.player.xpMultiplier, 1.15);
    near(game.player.pickupChance, 0.14);
    assert.equal(game.rerollsRemaining, 4);
  });

  it("snapshots the run ID and earned achievement list and returns the same settlement on repeat", () => {
    const game = playing();
    triggers.dawn(game);
    const id = game.runId;
    game.pause(); game.evacuate();
    const summary = game.summary, snapshot = structuredClone(summary);
    game.earnedAchievements.push("river"); game.kills += 1000;
    assert.strictEqual(game.finishRun(true), summary);
    assert.deepEqual(summary, snapshot);
    assert.equal(summary.runId, id);
    assert.deepEqual(summary.achievementIds, ["dawn"]);
    assert.equal(summary.echoes, summary.baseEchoes + ACHIEVEMENTS.dawn.reward);
    game.start();
    assert.notEqual(game.runId, id);
    assert.equal(game.summary, null);
    assert.deepEqual(summary, snapshot);
  });

  for (const source of ["contact", "projectile", "hostile zone"]) {
    it(`lethal ${source} prevents simultaneous XP, healing and chest transitions`, () => {
      const game = playing();
      if (source === "contact") target(game, 1);
      else if (source === "projectile") game.fireEnemyProjectile({ x: -1, y: 0 }, 100, 0, 150, 10, "#fff", 7);
      else {
        const bomber = game.spawnEnemy(VIEW, "bomber", { x: 0, y: 0 });
        game.explodeEnemy(bomber);
        game.zones[0].tick = 0.39;
      }
      game.player.health = 1;
      game.addEntity("gems", { x: 0, y: 0, radius: 8, value: 1000, phase: 0 });
      pickup(game, "heart"); pickup(game, "chest");
      game.update(0.02, {}, VIEW);
      assert.equal(game.state, "gameover");
      assert.equal(game.player.health, 0);
      assert.equal(game.player.level, 1);
      assert.equal(game.player.xp, 0);
      assert.equal(game.gems.length, 1);
      assert.equal(game.pickups.length, 2);
      assert.equal(game.chestsOpened, 0);
      assert.equal(game.summary.died, true);
      assert.equal(game.summary.reason, "died");
      assert.equal(game.summary.runId, game.runId);
      const summary = structuredClone(game.summary);
      game.update(1, {}, VIEW);
      assert.deepEqual(game.summary, summary);
    });
  }
});

describe("entity budgets under real production and collection", () => {
  it("bounds arrows and enemy bullets while preserving existing projectiles", () => {
    const game = playing(), enemy = target(game, 400);
    game.fireVolley(enemy);
    const first = game.projectiles[0];
    for (let i = 0; i < ENTITY_LIMITS.projectiles + 10; i += 1) game.fireVolley(enemy);
    assert.equal(game.projectiles.length, ENTITY_LIMITS.projectiles);
    assert.strictEqual(game.projectiles[0], first);
    for (let i = 0; i < ENTITY_LIMITS.enemyProjectiles + 10; i += 1) game.fireEnemyProjectile(enemy, 0, 0, 150, 5, "#fff", 7);
    assert.equal(game.enemyProjectiles.length, ENTITY_LIMITS.enemyProjectiles);
    const boss = game.spawnBoss(VIEW, 0);
    boss.shootClock = 0;
    game.updateEnemies(0.01);
    assert.equal(game.enemyProjectiles.length, ENTITY_LIMITS.enemyProjectiles);
    game.updateProjectiles(2);
    assert.equal(game.projectiles.length, 0);
    game.fireVolley(enemy);
    assert.equal(game.projectiles.length, 1, "expired projectiles release capacity");
  });

  it("bounds actual enemy spawns, waves, elites, split children and priority bosses", () => {
    const game = playing();
    const splitter = game.spawnEnemy(VIEW, "splitter", { x: 400, y: 0 });
    for (let i = 1; i < ENTITY_LIMITS.enemies; i += 1) game.spawnEnemy(VIEW, "shade", { x: 600, y: 100 });
    assert.equal(game.spawnEnemy(VIEW, "runner"), null);
    game.spawnWave(VIEW); game.spawnElite(VIEW, 4);
    assert.equal(game.enemies.length, ENTITY_LIMITS.enemies);
    game.damageEnemy(splitter, splitter.hp);
    assert.equal(game.enemies.length, ENTITY_LIMITS.enemies);
    assert.equal(game.enemies.filter(enemy => enemy.noSplit).length, 1);
    game.enemyGrid.rebuild(game.enemies);
    const replaced = game.enemies.at(-1), boss = game.spawnBoss(VIEW, 0);
    assert.ok(game.enemies.includes(boss));
    assert.equal(game.enemies.includes(replaced), false);
    assert.equal(game.enemies.length, ENTITY_LIMITS.enemies);
    assert.ok(game.enemyGrid.query(replaced.x, replaced.y, 100).every(index => game.enemyGrid.items[index] !== replaced));
  });

  it("evicts the oldest effects and zones under sustained real weapon casts", () => {
    const game = playing(), nova = weapon(game, "tideNova"), grave = weapon(game, "graveField");
    game.enemyGrid.rebuild(game.enemies);
    game.fireNova(nova); game.fireGraveField(grave);
    const firstEffect = game.effects[0], firstZone = game.zones[0];
    for (let i = 0; i < Math.max(ENTITY_LIMITS.effects, ENTITY_LIMITS.zones) + 5; i += 1) {
      game.fireNova(nova); game.fireGraveField(grave);
    }
    assert.equal(game.effects.length, ENTITY_LIMITS.effects);
    assert.equal(game.zones.length, ENTITY_LIMITS.zones);
    assert.equal(game.effects.includes(firstEffect), false);
    assert.equal(game.zones.includes(firstZone), false);
    game.updateEffects(1); game.updateZones(5);
    assert.equal(game.effects.length, 0);
    assert.equal(game.zones.length, 0);
  });

  it("merges XP overflow from actual kills without losing its total value", () => {
    const game = playing(), count = ENTITY_LIMITS.gems + 9;
    game.player.pickupChance = 0;
    for (let i = 0; i < count; i += 1) {
      const enemy = game.spawnEnemy(VIEW, "shade", { x: 400, y: 0 });
      game.damageEnemy(enemy, enemy.hp);
    }
    assert.equal(game.kills, count);
    assert.equal(game.gems.length, ENTITY_LIMITS.gems);
    near(game.gems.reduce((sum, gem) => sum + gem.value, 0), count);
  });

  it("prioritizes a boss chest over ordinary pickups when the pickup budget is full", () => {
    const game = playing();
    for (let i = 0; i < ENTITY_LIMITS.pickups; i += 1) pickup(game, "heart", { x: 400 });
    const boss = game.spawnBoss(VIEW, 0);
    game.damageEnemy(boss, boss.hp);
    assert.equal(game.pickups.length, ENTITY_LIMITS.pickups);
    assert.equal(game.pickups.filter(item => item.type === "heart").length, ENTITY_LIMITS.pickups - 1);
    assert.equal(game.pickups.filter(item => item.type === "chest").length, 1);
  });

  it("compresses chest overflow into charges and still lets the player consume every earned chest", () => {
    const game = playing(), count = ENTITY_LIMITS.pickups + 2;
    for (let i = 0; i < count; i += 1) pickup(game, "chest");
    assert.equal(game.pickups.length, ENTITY_LIMITS.pickups);
    assert.equal(game.pickups.reduce((sum, item) => sum + (item.charges || 1), 0), count);
    until(game, () => game.pickups.length === 0 && game.state !== "chest", () => {
      if (game.state === "chest") assert.equal(game.chooseChestUpgrade(game.chestChoices[0].id), true);
      else game.updatePickups(0);
    }, count * 2);
    assert.equal(game.chestsOpened, count);
    assert.equal(game.state, "playing");
  });

  it("keeps every entity collection within budget during a real dense evolved-weapon encounter", () => {
    const game = playing();
    for (const id of ["moonArrow", "orbitBlade", "tideNova", "chainSpark"]) weapon(game, id, 5, true);
    game.nextWave = 60; game.nextElite = 120; game.nextBoss = 180;
    game.elapsed = 610; game.spawnClock = 0; game.fireClock = 0;
    game.player.invulnerable = 100;
    game.particleLimit = 24;
    for (let frame = 0; frame < 120; frame += 1) {
      game.update(0.05, { moveX: 0.5, moveY: 0.1 }, VIEW);
      if (game.state === "levelup") game.chooseUpgrade(game.upgradeChoices[0].id);
      if (game.state === "chest") game.chooseChestUpgrade(game.chestChoices[0].id);
      for (const [collection, limit] of Object.entries(ENTITY_LIMITS)) assert.ok(game[collection].length <= limit, `${collection} exceeded ${limit}`);
      assert.ok(game.particles.length <= 24);
    }
    assert.ok(game.enemies.length > 100);
    assert.ok(game.kills > 0 || game.enemies.some(enemy => enemy.hp < enemy.maxHp));
    assert.equal(game.state, "playing");
  });
});
