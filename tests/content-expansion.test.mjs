import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurvivorGame } from "../src/game/game.js";
import { WEAPONS, PASSIVES, CHARACTERS } from "../src/game/content.js";
import { defaultSave, normalizeSave, SaveStore, SAVE_KEY, unlockCharacter } from "../src/game/progression.js";

const VIEW = { width: 800, height: 600 };
const HP = 1e6;
const near = (actual, expected, message = `${actual} ≈ ${expected}`) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7, message);
const recipes = Object.entries(WEAPONS).flatMap(([weapon, definition]) =>
  Object.entries(definition.evolutions).map(([passive, recipe]) => ({ weapon, passive, ...recipe })));

function playing(character = "ranger") {
  const profile = defaultSave();
  profile.unlocked[character] = true;
  const game = new SurvivorGame(0xc0ffee, { profile });
  assert.equal(game.start(character), true);
  game.spawnClock = -1e6;
  game.nextWave = game.nextElite = game.nextBoss = Number.MAX_VALUE;
  game.fireClock = 1e6;
  for (const id of Object.keys(WEAPONS)) game.weaponClocks[id] = 1e6;
  game.particleLimit = 0;
  return game;
}

function equip(game, id, level = 5) {
  let owned = game.activeWeapons.find(item => item.id === id);
  if (!owned) {
    assert.equal(game.applyChoice({ type: "weapon", target: id }), true);
    owned = game.activeWeapons.find(item => item.id === id);
  }
  while (owned.level < level) assert.equal(game.applyChoice({ type: "weapon", target: id }), true);
  return owned;
}

function passiveLevel(game, id, level = 3) {
  while ((game.build.passives[id] || 0) < level)
    assert.equal(game.applyChoice({ type: "passive", target: id }), true);
}

const evolutionChoices = (game, weapon, chest = false) =>
  game.rollUpgradeChoices(chest).filter(choice => choice.type === "evolve" && choice.target === weapon);

function acquire(game, recipe) {
  const owned = equip(game, recipe.weapon);
  passiveLevel(game, recipe.passive);
  assert.ok(evolutionChoices(game, recipe.weapon).some(choice => choice.evolutionId === recipe.id),
    `${recipe.id} must be offered by the real level-up roller`);
  assert.equal(game.openChest(), true);
  const choice = game.chestChoices.find(item => item.evolutionId === recipe.id);
  assert.ok(choice, `${recipe.id} must be offered by the real chest roller`);
  assert.equal(game.chooseChestUpgrade(choice.id), true);
  assert.equal(owned.evolutionId, recipe.id);
  return owned;
}

function evolved(effect) {
  const recipe = recipes.find(item => item.effect === effect);
  assert.ok(recipe, `missing recipe for ${effect}`);
  const game = playing();
  return { game, owned: acquire(game, recipe) };
}

function enemy(game, x, y = 0) {
  const target = game.spawnEnemy(VIEW, "brute", { x, y });
  assert.ok(target);
  target.hp = target.maxHp = HP;
  game.enemyGrid.rebuild(game.enemies);
  return target;
}

function until(predicate, tick, message, frames = 250) {
  for (let i = 0; i < frames && !predicate(); i += 1) tick();
  assert.ok(predicate(), message);
}

function advance(game, seconds) {
  // update clamps a single delta to 0.05; exercise real elapsed-time behavior.
  for (let remaining = seconds; remaining > 1e-10;) {
    const dt = Math.min(0.05, remaining);
    game.update(dt, {}, VIEW);
    remaining -= dt;
  }
}

describe("expanded catalog and real evolution acquisition", () => {
  it("has eight weapons, eight passives, four characters and sixteen independent balanced recipes", () => {
    assert.equal(Object.keys(WEAPONS).length, 8);
    assert.equal(Object.keys(PASSIVES).length, 8);
    assert.equal(Object.keys(CHARACTERS).length, 4);
    assert.equal(recipes.length, 16);
    assert.equal(new Set(recipes.map(recipe => recipe.id)).size, 16);
    assert.equal(new Set(recipes.map(recipe => recipe.effect)).size, 16);
    for (const definition of Object.values(WEAPONS)) {
      assert.equal(definition.passives.length, 2);
      assert.equal(new Set(definition.passives).size, 2);
      assert.deepEqual(Object.keys(definition.evolutions).sort(), [...definition.passives].sort());
    }
    for (const id of Object.keys(PASSIVES)) assert.equal(recipes.filter(recipe => recipe.passive === id).length, 2, id);
    for (const recipe of recipes) {
      assert.ok(PASSIVES[recipe.passive]);
      for (const key of ["id", "name", "effect", "desc"]) assert.ok(typeof recipe[key] === "string" && recipe[key].trim(), key);
    }
  });

  for (const recipe of recipes) {
    it(`${recipe.id}: offers both branches, chooses this chest recipe once at 4+4 without consuming slots or passives`, () => {
      const game = playing(), owned = equip(game, recipe.weapon);
      for (const id of WEAPONS[recipe.weapon].passives) passiveLevel(game, id);
      for (const id of Object.keys(WEAPONS)) {
        if (game.activeWeapons.length === 4) break;
        if (!game.activeWeapons.some(item => item.id === id)) equip(game, id, 1);
      }
      for (const id of Object.keys(PASSIVES)) {
        if (Object.keys(game.build.passives).length === 4) break;
        if (!game.build.passives[id]) passiveLevel(game, id, 1);
      }
      const expected = Object.values(WEAPONS[recipe.weapon].evolutions).map(item => item.id).sort();
      for (const chest of [false, true])
        assert.deepEqual(evolutionChoices(game, recipe.weapon, chest).map(item => item.evolutionId).sort(), expected);
      const beforePassives = structuredClone(game.build.passives), beforeWeapons = game.activeWeapons.map(item => item.id);
      assert.equal(game.openChest(), true);
      const choices = game.chestChoices.filter(item => item.type === "evolve" && item.target === recipe.weapon);
      assert.equal(choices.length, 2);
      assert.equal(new Set(choices.map(item => item.id)).size, 2, "branches must have separate selectable IDs");
      const chosen = choices.find(item => item.evolutionId === recipe.id), other = choices.find(item => item !== chosen);
      assert.ok(chosen);
      assert.equal(game.chooseChestUpgrade(chosen.id), true);
      assert.equal(game.state, "playing");
      assert.equal(owned.evolved, true);
      assert.equal(owned.evolutionId, recipe.id);
      assert.equal(game.chestsOpened, 1);
      assert.equal(game.evolutions, 1);
      assert.deepEqual(game.build.passives, beforePassives);
      assert.deepEqual(game.activeWeapons.map(item => item.id), beforeWeapons);
      assert.equal(game.activeWeapons.length, 4);
      assert.equal(Object.keys(game.build.passives).length, 4);
      assert.equal(game.applyChoice(other), false);
      assert.equal(game.chooseChestUpgrade(other.id), false);
      assert.equal(owned.evolutionId, recipe.id);
      for (const chest of [false, true]) assert.deepEqual(evolutionChoices(game, recipe.weapon, chest), []);
      assert.equal(game.evolutions, 1);
    });

    for (const gate of ["wrong passive", "passive level two", "weapon level four"]) {
      it(`${recipe.id}: rejects ${gate} in rollers and application without changing the build`, () => {
        const game = playing();
        equip(game, recipe.weapon, gate === "weapon level four" ? 4 : 5);
        const id = gate === "wrong passive" ? Object.keys(PASSIVES).find(id => !WEAPONS[recipe.weapon].passives.includes(id)) : recipe.passive;
        passiveLevel(game, id, gate === "passive level two" ? 2 : 3);
        const before = structuredClone(game.build);
        for (const chest of [false, true])
          assert.ok(evolutionChoices(game, recipe.weapon, chest).every(choice => choice.evolutionId !== recipe.id));
        game.openChest();
        assert.ok(game.chestChoices.every(choice => choice.evolutionId !== recipe.id));
        assert.equal(game.applyChoice({ type: "evolve", target: recipe.weapon, passive: recipe.passive, evolutionId: recipe.id }), false);
        assert.deepEqual(game.build, before);
        assert.equal(game.evolutions, 0);
      });
    }
  }

  it("rolls both new weapons and passives and enforces four slots while allowing owned upgrades", () => {
    const game = playing(), seen = new Set();
    for (let i = 0; i < 120; i += 1) for (const choice of game.rollUpgradeChoices()) seen.add(choice.target);
    for (const id of ["starLance", "frostHalo", "focus", "ward"]) assert.ok(seen.has(id), `${id} must be obtainable`);
    for (const id of ["starLance", "frostHalo", "chainSpark"]) equip(game, id, 1);
    for (const id of ["focus", "ward", "area", "tempo"]) passiveLevel(game, id, 1);
    assert.equal(game.applyChoice({ type: "weapon", target: "graveField" }), false);
    assert.equal(game.applyChoice({ type: "passive", target: "might" }), false);
    assert.equal(game.applyChoice({ type: "weapon", target: "starLance" }), true);
    assert.equal(game.applyChoice({ type: "passive", target: "focus" }), true);
    for (let i = 0; i < 40; i += 1) for (const choice of game.rollUpgradeChoices()) {
      if (choice.type === "weapon") assert.ok(game.activeWeapons.some(item => item.id === choice.target));
      if (choice.type === "passive") assert.ok(game.build.passives[choice.target]);
    }
    assert.equal(game.activeWeapons.length, 4);
    assert.equal(Object.keys(game.build.passives).length, 4);
  });
});

describe("sentinel unlock and old-save migration", () => {
  it("loads an old v1 profile with sentinel:false and preserves every existing schema field", () => {
    const old = defaultSave();
    delete old.unlocked.sentinel;
    Object.assign(old, { echoes: 4321, meta: { life: 2, ember: 3, light: 4, fate: 1, fortune: 5 },
      unlocked: { ranger: true, warden: true, oracle: true }, achievements: { dawn: true, boss: true },
      stats: { runs: 9, bestTime: 421.5, bestKills: 678, bosses: 4, evolutions: 3 },
      preferences: { character: "oracle", sound: false, tutorialSeen: true } });
    const before = structuredClone(old), expected = { ...before, unlocked: { ...before.unlocked, sentinel: false } };
    assert.deepEqual(normalizeSave(old), expected);
    assert.deepEqual(old, before, "migration must not mutate the caller's profile");
    const values = new Map([[SAVE_KEY, JSON.stringify(old)]]);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const store = new SaveStore(storage);
    assert.deepEqual(store.load(), expected);
    store.save(store.load());
    assert.deepEqual(new SaveStore(storage).load(), expected);
    const game = new SurvivorGame(7, { profile: store.load() });
    assert.equal(game.selectedCharacter, "oracle");
    assert.equal(game.start(), true);
    assert.equal(game.character.id, "oracle");
  });

  it("denies locked sentinel, spends its exact price once, persists selection and starts with its real weapon", () => {
    const locked = new SurvivorGame(7);
    assert.equal(locked.setCharacter("sentinel"), false);
    assert.equal(locked.start("sentinel"), false);
    assert.equal(locked.state, "title");
    const price = CHARACTERS.sentinel.cost;
    assert.equal(unlockCharacter({ ...defaultSave(), echoes: price - 1 }, "sentinel", CHARACTERS).unlocked, false);
    const input = { ...defaultSave(), echoes: price }, result = unlockCharacter(input, "sentinel", CHARACTERS);
    assert.equal(result.unlocked, true);
    assert.equal(result.save.echoes, 0);
    assert.equal(input.unlocked.sentinel, false);
    assert.equal(unlockCharacter(result.save, "sentinel", CHARACTERS).unlocked, false);
    result.save.preferences.character = "sentinel";
    const store = new SaveStore(null);
    store.save(result.save);
    const game = new SurvivorGame(7, { profile: store.load() });
    assert.equal(game.selectedCharacter, "sentinel");
    assert.equal(game.setCharacter("sentinel"), true);
    assert.equal(game.start(), true);
    assert.equal(game.character.id, "sentinel");
    assert.equal(game.player.maxHealth, 90);
    assert.deepEqual(game.activeWeapons.map(item => item.id), ["starLance"]);
    enemy(game, 200);
    game.updateOtherWeapons(0.01);
    assert.ok(game.projectiles.some(shot => shot.kind === "lance"));
    assert.ok(game.projectiles.every(shot => shot.kind !== "arrow"));
  });
});

describe("independent expanded combat effects", () => {
  it("arrowBurst fires six arrows immediately, adds homing fragments and never splits on impact", () => {
    const { game } = evolved("arrowBurst"), first = enemy(game, 65);
    game.fireVolley(first);
    assert.equal(game.projectiles.length, 6);
    const homing = game.projectiles.filter(shot => shot.kind === "fragment");
    assert.ok(homing.length > 0);
    assert.ok(game.projectiles.every(shot => !shot.split));
    // Move the target off-axis after firing; observe real steering and damage.
    first.y = 100;
    const initialY = homing.map(shot => shot.vy);
    game.updateProjectiles(0.02);
    assert.ok(homing.some((shot, i) => shot.vy !== initialY[i]), "fragments must steer toward the moved target");
    until(() => first.hp < HP, () => game.updateProjectiles(0.01), "homing arrows must actually hit");
    assert.ok(game.projectiles.length <= 6, "impacts cannot create split fragments");
    assert.ok(game.projectiles.every(shot => !shot.split));
  });

  it("bladePulse starts on blade contact and damages a nearby bystander once after a delay", () => {
    const { game, owned } = evolved("bladePulse");
    game.fireOrbit(owned, 0);
    assert.equal(game.effects.filter(effect => effect.delayed > 0).length, 0, "no contact, no pulse");
    const blade = game.orbitBlades[0], contact = enemy(game, blade.x, blade.y);
    const nearby = enemy(game, blade.x + 44, blade.y), far = enemy(game, blade.x + 160, blade.y);
    game.fireOrbit(owned, 0.01);
    assert.ok(contact.hp < HP);
    assert.equal(nearby.hp, HP, "bystander is outside direct blade contact");
    const pulse = game.effects.find(effect => effect.delayed > 0 && effect.damage > 0);
    assert.ok(pulse, "contact must queue a damaging pulse");
    game.updateEffects(pulse.delayed / 2);
    assert.equal(nearby.hp, HP);
    game.updateEffects(pulse.delayed + 0.001);
    assert.ok(nearby.hp < HP);
    assert.equal(far.hp, HP, "pulse must remain local");
    const after = nearby.hp;
    game.updateEffects(1);
    assert.equal(nearby.hp, after);
    assert.ok(!game.zones.some(zone => zone.kind === "blade"), "pulse branch must not inherit trail branch");
  });

  it("novaCrown adds damage only in the nova center", () => {
    const { game, owned } = evolved("novaCrown");
    const center = enemy(game, 40), rim = enemy(game, 135), outside = enemy(game, 350);
    const damage = game.weaponDamage(owned.id);
    game.fireNova(owned);
    near(HP - center.hp, damage * 1.85);
    near(HP - rim.hp, damage);
    assert.equal(outside.hp, HP);
    const after = center.hp;
    game.updateEffects(1);
    assert.equal(center.hp, after, "crown must not inherit delayed nova damage");
  });

  it("chainFork hits two distinct targets beyond the terminal chain point without re-hitting the chain", () => {
    const { game, owned } = evolved("chainFork");
    const line = [100, 220, 340, 460, 580].map(x => enemy(game, x));
    const forks = [enemy(game, 680, 55), enemy(game, 680, -55)];
    const third = enemy(game, 740, 0), far = enemy(game, 950, 300);
    game.fireChain(owned);
    const damage = game.weaponDamage(owned.id);
    line.forEach((target, i) => near(HP - target.hp, damage * 0.88 ** i));
    forks.forEach(target => near(HP - target.hp, damage * 0.65));
    assert.equal(third.hp, HP, "only two unhit targets may receive terminal branches");
    const forkEffects = game.effects.filter(effect => effect.kind === "chain" && effect.points.length === 2);
    assert.equal(forkEffects.length, 2);
    for (const effect of forkEffects) assert.deepEqual(effect.points[0], { x: 580, y: 0 });
    assert.equal(far.hp, HP);
    assert.ok(!game.zones.some(zone => zone.kind === "lightning"));
  });

  it("fieldBloom damages outside the original field only at expiration and only once", () => {
    const { game, owned } = evolved("fieldBloom");
    enemy(game, 200);
    game.fireGraveField(owned);
    const field = game.zones[0];
    assert.ok(field);
    // Keep one real generated field to isolate expiry from overlapping casts.
    game.zones.splice(1);
    const bloom = enemy(game, field.x + field.radius + 35, field.y), far = enemy(game, field.x + field.radius * 3, field.y);
    game.updateZones(field.life - 0.01);
    assert.equal(bloom.hp, HP);
    game.updateZones(0.02);
    game.updateEffects(0.5);
    assert.ok(bloom.hp < HP, "expiration bloom must reach beyond the original field");
    assert.equal(far.hp, HP);
    const after = bloom.hp;
    game.updateZones(1); game.updateEffects(1);
    assert.equal(bloom.hp, after);
  });

  it("boomerangBurst waits for the first return hit and applies its splash once per projectile", () => {
    const { game, owned } = evolved("boomerangBurst");
    enemy(game, 400);
    game.fireBoomerang(owned);
    game.projectiles.splice(1);
    const shot = game.projectiles[0], angle = Math.atan2(shot.vy, shot.vx);
    const contact = enemy(game, Math.cos(angle) * 200, Math.sin(angle) * 200);
    const later = enemy(game, Math.cos(angle) * 145, Math.sin(angle) * 145);
    const side = enemy(game, contact.x - Math.sin(angle) * 55, contact.y + Math.cos(angle) * 55);
    until(() => shot.returning, () => game.updateProjectiles(0.01), "boomerang must enter return phase");
    near(HP - contact.hp, shot.damage);
    assert.equal(side.hp, HP, "outbound contact must not burst");
    until(() => side.hp < HP, () => game.updateProjectiles(0.01), "first return contact must damage the off-axis bystander");
    assert.ok(HP - contact.hp > shot.damage * 2, "return contact adds splash to direct damage");
    const after = side.hp;
    const laterBefore = later.hp;
    until(() => shot.hitIds.has(later.id), () => game.updateProjectiles(0.01), "return must also contact a second enemy");
    assert.ok(later.hp < laterBefore, "second contact still receives normal direct damage");
    assert.equal(side.hp, after, "second return contact must not trigger another splash");
    until(() => game.projectiles.length === 0, () => game.updateProjectiles(0.01), "boomerang must finish its return");
    assert.equal(side.hp, after);
  });

  it("lanceRain queues delayed starfall effects on impact and damages the impact area once", () => {
    const { game, owned } = evolved("lanceRain"), contact = enemy(game, 60);
    game.fireFan(owned);
    assert.equal(game.effects.filter(effect => effect.delayed > 0).length, 0);
    until(() => contact.hp < HP, () => game.updateProjectiles(0.01), "lance must hit");
    const rains = game.effects.filter(effect => effect.kind === "starfall" && effect.delayed > 0 && effect.damage > 0);
    const rain = rains[0];
    assert.ok(rain, "impact must queue starfall rather than arrow fragments");
    assert.ok(new Set(rains.map(effect => effect.delayed)).size >= 2, "starfall must arrive in two delayed waves");
    assert.ok(!game.projectiles.some(shot => shot.kind === "fragment"));
    game.projectiles.length = 0;
    const splash = enemy(game, rain.x, rain.y + rain.radius * 0.6);
    const firstDelay = Math.min(...rains.map(effect => effect.delayed));
    game.updateEffects(firstDelay / 2);
    assert.equal(splash.hp, HP);
    game.updateEffects(firstDelay / 2 + 0.001);
    assert.ok(splash.hp < HP);
    const afterFirst = splash.hp;
    game.updateEffects(0.5);
    assert.ok(splash.hp < afterFirst, "second delayed wave must damage the impact area too");
    const expected = rains.filter(effect => Math.hypot(effect.x - splash.x, effect.y - splash.y) <= effect.radius + splash.radius)
      .reduce((total, effect) => total + effect.damage, 0);
    near(HP - splash.hp, expected);
    const after = splash.hp;
    game.updateEffects(1);
    assert.equal(splash.hp, after);
  });

  it("lanceWard grants 0.7 seconds of real damage protection when firing and expires", () => {
    // Separate encounters prevent post-hit invulnerability masking expiry.
    for (const seconds of [0, 0.65, 0.75]) {
      const { game, owned } = evolved("lanceWard");
      game.fireFan(owned);
      near(game.player.shieldTime, 0.7);
      near(game.player.shield, 24);
      advance(game, seconds);
      const health = game.player.health;
      game.hurtPlayer(10);
      near(game.player.health, health - (seconds < 0.7 ? 0 : 10));
      near(game.player.shield, seconds < 0.7 ? 14 : 0);
    }
    const { game, owned } = evolved("lanceWard");
    game.fireFan(owned);
    const health = game.player.health;
    game.hurtPlayer(30);
    near(game.player.health, health - 6, "shield absorbs 24 damage and lets the remainder through");
    near(game.player.shield, 0);
  });

  it("frostRing repeatedly damages and slows actual movement inside its persistent zone", () => {
    const { game, owned } = evolved("frostRing");
    game.fireFrost(owned);
    const field = game.zones.find(zone => zone.kind === "frost");
    assert.ok(field);
    const target = enemy(game, 90), outside = enemy(game, 500);
    game.updateZones(0.41);
    assert.ok(target.hp < HP);
    assert.equal(outside.hp, HP);
    for (let i = 0; i < 2; i += 1) {
      const x = target.x, before = target.hp, farX = outside.x;
      game.updateEnemies(0.05);
      assert.ok(x - target.x > 0 && x - target.x < target.speed * 0.05, "field must reduce actual chase speed");
      near(farX - outside.x, outside.speed * 0.05);
      game.enemyGrid.rebuild(game.enemies);
      game.updateZones(0.41);
      assert.ok(target.hp < before, "persistent field must tick more than once");
    }
    advance(game, 3);
    target.x = 300;
    advance(game, 1);
    const x = target.x;
    game.updateEnemies(0.05);
    near(x - target.x, target.speed * 0.05, "slow must expire after leaving the expired field");
    assert.equal(game.zones.length, 0);
  });

  it("moonPrison delays an outer ring, then gives outer targets stronger actual slowing", () => {
    const { game, owned } = evolved("moonPrison");
    const inner = enemy(game, 90), outer = enemy(game, 195), far = enemy(game, 450);
    game.fireFrost(owned);
    assert.ok(inner.hp < HP);
    assert.equal(outer.hp, HP);
    inner.knockbackX = inner.knockbackY = 0;
    const innerX = inner.x;
    game.updateEnemies(0.01);
    const initialRatio = (innerX - inner.x) / (inner.speed * 0.01);
    game.updateEffects(0.19);
    assert.equal(outer.hp, HP);
    game.updateEffects(0.22);
    assert.ok(outer.hp < HP, "delayed ring must extend beyond initial nova");
    assert.equal(far.hp, HP);
    outer.knockbackX = outer.knockbackY = 0;
    const x = outer.x;
    game.updateEnemies(0.01);
    const prisonRatio = (x - outer.x) / (outer.speed * 0.01);
    assert.ok(prisonRatio > 0 && prisonRatio < initialRatio, "outer ring must slow more strongly than the initial frost hit");
    const after = outer.hp;
    game.updateEffects(1);
    assert.equal(outer.hp, after);
  });
});

describe("focus, sentinel range and ward actual stats", () => {
  for (const character of ["ranger", "sentinel"]) {
    it(`${character}: focus damage grows 8% per level and multiplies chain reach by 6% per level`, () => {
      const game = playing(character), owned = equip(game, "chainSpark", 1);
      for (const level of [0, 1, 3, 5]) {
        passiveLevel(game, "focus", level);
        const range = WEAPONS.chainSpark.range * (1 + 0.06 * level) * (character === "sentinel" ? 1.2 : 1);
        near(game.player.rangeMultiplier, (1 + 0.06 * level) * (character === "sentinel" ? 1.2 : 1));
        game.enemies.length = 0;
        const inside = enemy(game, range - 1);
        game.fireChain(owned);
        near(HP - inside.hp, WEAPONS.chainSpark.damage * (1 + 0.08 * level));
        game.enemies.length = 0;
        const outside = enemy(game, range + 1);
        game.fireChain(owned);
        assert.equal(outside.hp, HP, "chain cannot start beyond the scaled range");
      }
    });
  }

  it("ward adds five max HP per level and extends actual post-hit invulnerability by 6% per level", () => {
    for (const level of [1, 3, 5]) {
      const game = playing();
      passiveLevel(game, "ward", level);
      assert.equal(game.player.maxHealth, 100 + 5 * level);
      const health = game.player.health;
      game.hurtPlayer(10);
      near(game.player.health, health - 10);
      const duration = 0.58 * (1 + 0.06 * level);
      near(game.player.invulnerable, duration);
      advance(game, duration - 0.01);
      game.hurtPlayer(10);
      near(game.player.health, health - 10);
      game.update(0.02, {}, VIEW);
      game.hurtPlayer(10);
      near(game.player.health, health - 20);
    }
  });
});

describe("review regressions: boomerang range, speed and complete recipe groups", () => {
  for (const character of ["ranger", "sentinel", "warden", "oracle"]) {
    it(`${character}: focus Lv5 endlessEcho actually returns and splits before expiring`, () => {
      const game = playing(character);
      const owned = acquire(game, recipes.find(recipe => recipe.effect === "boomerangSplit"));
      passiveLevel(game, "focus", 5);
      game.fireBoomerang(owned);
      const originals = [...game.projectiles];
      assert.equal(originals.length, 2);

      // Run the real frame loop, with automatic casts suppressed by playing().
      // A larger maxTravel alone must not turn the upgrade into an expiry.
      until(() => originals.every(shot => !game.projectiles.includes(shot)),
        () => game.update(0.01, {}, VIEW), "both wheels must complete their return", 600);
      for (const shot of originals) {
        assert.equal(shot.returning, true);
        assert.equal(shot.splitCount, 1, "removal must follow a real return split, not lifetime expiry");
        assert.ok(shot.life > 0, "wheel must reach the player before its lifetime expires");
        assert.ok(Math.hypot(shot.x - game.player.x, shot.y - game.player.y) < game.player.radius + 12);
      }
      assert.equal(game.projectiles.length, 6, "each of the two returned wheels must create three actual bullets");
      for (const fragment of game.projectiles) {
        assert.notEqual(fragment.kind, "boomerang");
        near(fragment.damage, originals[0].damage * 0.45);
      }
      assert.equal(game.state, "playing");
    });

    it(`${character}: measures the actual outbound and return displacement of a boomerang`, () => {
      const game = playing(character), owned = equip(game, "echoBoomerang");
      const expectedSpeed = WEAPONS.echoBoomerang.speed * (character === "sentinel" ? 1.15 : 1);
      game.fireBoomerang(owned);
      const shot = game.projectiles[0], dt = 0.01;
      let x = shot.x, y = shot.y;
      game.updateProjectiles(dt);
      near(Math.hypot(shot.x - x, shot.y - y) / dt, expectedSpeed,
        "outbound movement must apply the character's projectile speed bonus");

      until(() => shot.returning, () => game.updateProjectiles(dt), "wheel must turn around", 300);
      assert.ok(game.projectiles.includes(shot));
      x = shot.x; y = shot.y;
      const before = Math.hypot(x - game.player.x, y - game.player.y);
      game.updateProjectiles(dt);
      near(Math.hypot(shot.x - x, shot.y - y) / dt, expectedSpeed,
        "return movement must retain the same character speed bonus");
      near(before - Math.hypot(shot.x - game.player.x, shot.y - game.player.y), expectedSpeed * dt,
        "return movement must head toward the player");
    });
  }

  for (const axis of ["x", "y"]) {
    it(`sentinel focus Lv5: a live lance travels past 1000 on the ${axis} axis and still expires normally`, () => {
      const game = playing("sentinel"), owned = game.activeWeapons.find(weapon => weapon.id === "starLance");
      passiveLevel(game, "focus", 5);
      game.player.facing = axis === "x" ? 0 : Math.PI / 2;
      game.fireFan(owned);
      // Keep the central lance from the real fan so the axis culling boundary is exercised.
      const shot = game.projectiles[Math.floor(game.projectiles.length / 2)];
      game.projectiles.splice(0, game.projectiles.length, shot);
      until(() => Math.abs(shot[axis] - game.player[axis]) > 1000,
        () => {
          assert.ok(game.projectiles.includes(shot), "range-enhanced lance must not be culled at the old 1000 boundary");
          game.updateProjectiles(0.01);
        }, "lance must actually cross the old culling boundary", 300);
      assert.ok(shot.life > 0);
      assert.ok(game.projectiles.includes(shot), "crossing 1000 must preserve a still-live enhanced projectile");
      until(() => !game.projectiles.includes(shot), () => game.updateProjectiles(0.01),
        "enhanced range must not make the lance immortal", 100);
      assert.ok(shot.life <= 0, "the real lifetime, rather than the old distance cutoff, must end this lance");
    });
  }

  function readyGroups(seed) {
    const game = new SurvivorGame(seed);
    assert.equal(game.start(), true);
    // These three dual-recipe groups share exactly four legal passive slots.
    for (const id of ["orbitBlade", "graveField", "chainSpark"]) equip(game, id);
    for (const id of ["area", "vitality", "magnet", "agility"]) passiveLevel(game, id);
    assert.equal(game.activeWeapons.length, 4);
    assert.equal(Object.keys(game.build.passives).length, 4);
    return game;
  }

  for (const seed of [0, 42, 0xc0ffee]) for (const chest of [false, true]) {
    it(`seed ${seed}, ${chest ? "chest" : "level-up"}: 30 reproducible rolls expose every complete dual-recipe group`, () => {
      const game = readyGroups(seed), replay = readyGroups(seed);
      const ids = ["orbitBlade", "graveField", "chainSpark"], seen = new Set();
      for (let i = 0; i < 30; i += 1) {
        const choices = game.rollUpgradeChoices(chest);
        assert.deepEqual(choices, replay.rollUpgradeChoices(chest),
          `same seed and build must replay the entire choice sequence at roll ${i}`);
        assert.ok(choices.length <= 3);
        const evolutions = choices.filter(choice => choice.type === "evolve");
        assert.equal(evolutions.length, 2, "three ready pairs must offer one complete pair within the three-card cap");
        for (const id of ids) {
          const offered = evolutions.filter(choice => choice.target === id);
          assert.ok(offered.length === 0 || offered.length === 2, `${id}: never offer just one of two ready recipes`);
          if (!offered.length) continue;
          assert.deepEqual(offered.map(choice => choice.evolutionId).sort(),
            Object.values(WEAPONS[id].evolutions).map(recipe => recipe.id).sort());
          seen.add(id);
        }
      }
      assert.deepEqual([...seen].sort(), [...ids].sort(), "rerolls must reach every weapon's recipe group");
    });
  }
});
