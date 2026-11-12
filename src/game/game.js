import { clamp, distance, mulberry32, normalize } from "../core/math.js";
import { WORLD, clampToWorld, isInsideWorld } from "./world.js";
import { SpatialGrid } from "./spatial-grid.js";
import { ACHIEVEMENTS, ALTARS, BOSSES, CHARACTERS, ENEMIES, PASSIVES, WEAPONS } from "./content.js";
import { calcEchoes, defaultSave, normalizeSave } from "./progression.js";

export const WORLD_SIZE = WORLD;
export const upgradeCatalog = [
  ...Object.values(WEAPONS).map(item => ({ id: item.id, icon: item.icon, name: item.name, desc: item.desc })),
  ...Object.values(PASSIVES).map(item => ({ id: item.id, icon: item.icon, name: item.name, desc: item.desc })),
];

const TAU = Math.PI * 2;
const weaponList = Object.values(WEAPONS);
const passiveList = Object.values(PASSIVES);
const HAZARD_TICK = 0.4;
const choiceForUpgrade = item => ({ id: `${item.category}:${item.id}`, type: item.category, target: item.id, category: item.category, icon: item.icon, name: `${item.name} · 强化`, desc: item.desc, from: 1 });
const pressureFor = elapsed => 1 + Math.min(4.2, elapsed / 145) + Math.max(0, elapsed - 600) / 300;
export const ENTITY_LIMITS = Object.freeze({ enemies: 800, projectiles: 256, enemyProjectiles: 240, zones: 96, effects: 128, gems: 600, pickups: 100 });

export class SurvivorGame {
  constructor(seed = 0x51ea, { profile = null } = {}) {
    this.seed = seed >>> 0;
    this.particleLimit = 360;
    this.enemyGrid = new SpatialGrid();
    this.profile = normalizeSave(profile || defaultSave());
    this.selectedCharacter = this.profile.unlocked[this.profile.preferences.character] ? this.profile.preferences.character : "ranger";
    this.reset(this.seed);
  }

  setProfile(profile) {
    this.profile = normalizeSave(profile);
    if (!this.profile.unlocked[this.selectedCharacter]) this.selectedCharacter = "ranger";
  }

  setCharacter(id) {
    if (!this.profile.unlocked[id] || !CHARACTERS[id]) return false;
    this.selectedCharacter = id;
    return true;
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.runSequence = (this.runSequence || 0) + 1;
    this.runId = `${this.seed}:${this.runSequence}`;
    this.runMeta = { ...this.profile.meta };
    this.random = mulberry32(this.seed);
    this.state = "title";
    this.elapsed = 0; this.kills = 0; this.spawnClock = 0; this.fireClock = 0; this.shake = 0;
    this.curse = 0; this.bossKills = 0; this.eliteKills = 0; this.chestsOpened = 0; this.evolutions = 0;
    this.altarRanks = 0; this.achievementRewards = 0; this.earnedAchievements = [];
    this.summary = null; this.resultReason = ""; this.boss = null; this.toastEvent = null;
    this.nextElite = 120; this.nextBoss = 180; this.nextWave = 60; this.nextTidePulse = -1;
    this.tidePulseUntil = 0; this.prewarnings = {};
    this.magnetUntil = 0; this.holyUntil = 0; this.enemySerial = 0;
    this.weaponClocks = Object.fromEntries(weaponList.map(item => [item.id, 0]));
    this.orbitHits = new Map(); this.enemyProjectiles = []; this.projectiles = []; this.zones = [];
    this.orbitBlades = []; this.orbitTrailClock = 0;
    this.effects = []; this.pickups = []; this.gems = []; this.particles = [];
    this.upgradeChoices = []; this.chestChoices = []; this.skipsRemaining = 2;
    this.collisionChecksLastUpdate = 0; this.lastAim = { x: 1, y: 0 };
    this.enemies = []; this.enemyGrid.clear();
    this.altars = ALTARS.map(item => ({ ...item, cooldown: 0, progress: 0 }));
    const character = CHARACTERS[this.selectedCharacter] || CHARACTERS.ranger;
    this.character = character;
    this.build = { weapons: [{ id: character.weapon, level: 1, evolved: false }], passives: {} };
    this.player = {
      x: 0, y: 0, radius: 13, health: character.health, maxHealth: character.health, speed: character.speed,
      xp: 0, xpNext: 8, level: 1, damage: 22, fireInterval: 0.62, projectileSpeed: 460, projectileCount: 1,
      projectileSize: 5, facing: -Math.PI / 2, pierce: 0, magnet: 96, invulnerable: 0, dashCooldown: 0,
      dashTime: 0, dashCooldownMax: 2.1, xpMultiplier: 1, damageMultiplier: 1, cooldownMultiplier: 1,
      areaMultiplier: 1, pickupChance: 0.04, baseHealth: character.health, baseSpeed: character.speed, characterId: character.id,
    };
    this.rerollsRemaining = 1 + (character.id === "ranger" ? 1 : 0) + this.profile.meta.fate;
    this.recalculateStats(false);
    this.player.health = this.player.maxHealth;
  }

  get arrowState() { return this.build.weapons.find(item => item.id === "moonArrow") || null; }
  get activeWeapons() { return this.build.weapons; }

  addEntity(collection, item) {
    const list = this[collection], limit = ENTITY_LIMITS[collection];
    if (list.length >= limit) {
      if (collection === "gems") { list[0].value += item.value; return; }
      if (collection === "pickups" && item.type === "chest") {
        const index = list.findIndex(pickup => pickup.type !== "chest");
        if (index >= 0) list.splice(index, 1);
        else { list[0].charges = (list[0].charges || 1) + (item.charges || 1); return; }
      } else if (collection === "effects" || collection === "zones") list.shift();
      else return;
    }
    list.push(item);
  }

  start(characterId = null, seed = this.seed) {
    if (this.state !== "title" && this.state !== "gameover") return false;
    if (characterId && !this.setCharacter(characterId)) return false;
    this.reset(seed); this.state = "playing"; return true;
  }

  resume() { if (this.state === "paused") this.state = "playing"; }
  pause() { if (this.state === "playing") this.state = "paused"; }

  evacuate() {
    if (this.state !== "paused") return false;
    this.finishRun(false, "evacuated"); this.state = "gameover"; return true;
  }

  finishRun(died, reason = died ? "died" : "evacuated") {
    if (this.summary) return this.summary;
    this.checkAchievements();
    this.resultReason = reason;
    const base = calcEchoes({ kills: this.kills, seconds: this.elapsed, bosses: this.bossKills, level: this.player.level, chests: this.chestsOpened, died, altarRanks: this.altarRanks });
    this.summary = { runId: this.runId, died, reason, baseEchoes: base, achievementEchoes: this.achievementRewards, echoes: base + this.achievementRewards, kills: this.kills, seconds: this.elapsed, level: this.player.level, bosses: this.bossKills, chests: this.chestsOpened, evolutions: this.evolutions, achievements: this.earnedAchievements.slice(), achievementIds: this.earnedAchievements.slice() };
    return this.summary;
  }

  recalculateStats(healVitality = false) {
    const p = this.player;
    const level = id => this.build.passives[id] || 0;
    const meta = this.runMeta;
    p.damageMultiplier = (1 + 0.1 * level("might")) * (1 + meta.ember * 0.03);
    p.cooldownMultiplier = 1 - 0.07 * level("tempo");
    p.areaMultiplier = (1 + 0.1 * level("area")) * (this.character.area || 1);
    p.xpMultiplier = (1 + 0.05 * level("magnet")) * (this.character.xp || 1) * (1 + meta.light * 0.03);
    const previousMax = p.maxHealth || 1;
    p.maxHealth = Math.max(1, Math.round((p.baseHealth + level("vitality") * 15) * (1 + meta.life * 0.03)));
    p.health = Math.min(p.maxHealth, healVitality ? p.health + 15 : p.health * p.maxHealth / previousMax);
    p.speed = p.baseSpeed * (1 + 0.06 * level("agility"));
    p.magnet = 96 * (1 + 0.25 * level("magnet"));
    p.dashCooldownMax = Math.max(0.8, 2.1 * (1 - 0.04 * level("agility")));
    p.pickupChance = 0.04 + meta.fortune * 0.02 + this.curse * 0.005;
    const arrow = this.arrowState;
    const arrowLevel = arrow?.evolved ? 6 : arrow?.level || 1;
    p.damage = 22 * Math.pow(1.18, arrowLevel - 1) * p.damageMultiplier * (arrow?.evolved ? 1.45 : 1);
    p.fireInterval = Math.max(0.16, 0.62 * p.cooldownMultiplier);
    p.projectileCount = arrow?.evolved ? 4 : 1 + (arrowLevel >= 2 ? 1 : 0) + (arrowLevel >= 4 ? 1 : 0);
    p.pierce = arrow?.evolved ? 2 : arrowLevel >= 3 ? 1 : 0;
    p.projectileSize = 5 * Math.pow(1.08, level("area"));
  }

  applyChoice(choice) {
    if (!choice) return false;
    if (choice.type === "weapon") {
      if (!WEAPONS[choice.target]) return false;
      const weapon = this.build.weapons.find(item => item.id === choice.target);
      if (weapon && (weapon.evolved || weapon.level >= WEAPONS[weapon.id].maxLevel)) return false;
      if (weapon) weapon.level += 1;
      else if (this.activeWeapons.length < 4) this.build.weapons.push({ id: choice.target, level: 1, evolved: false });
      else return false;
    } else if (choice.type === "passive") {
      if (!PASSIVES[choice.target]) return false;
      const current = this.build.passives[choice.target] || 0;
      if (current >= PASSIVES[choice.target].maxLevel || (!current && Object.keys(this.build.passives).length >= 4)) return false;
      this.build.passives[choice.target] = current + 1;
    } else if (choice.type === "evolve") {
      const weapon = this.build.weapons.find(item => item.id === choice.target);
      if (!weapon || weapon.evolved || weapon.level < WEAPONS[weapon.id].maxLevel) return false;
      if ((this.build.passives[WEAPONS[weapon.id].passive] || 0) < 3) return false;
      weapon.evolved = true; this.evolutions += 1;
    } else return false;
    this.recalculateStats(choice.type === "passive" && choice.target === "vitality");
    this.checkAchievements(); return true;
  }

  describeChoice(choice) {
    if (choice.fallback) return choice.desc;
    const definition = WEAPONS[choice.target] || PASSIVES[choice.target];
    if (!definition) return "";
    const owned = this.build.weapons.find(item => item.id === choice.target);
    const current = owned?.level || this.build.passives[choice.target] || 0;
    if (choice.type === "evolve") {
      const effects = { moonArrow: "命中分裂两枚追踪碎片", orbitBlade: "旋转刀刃留下切割轨迹", tideNova: "爆发后追加 65% 伤害的延迟波", chainSpark: "跳跃终点追加 50% 伤害的范围落雷", graveField: "领域缓慢跟随，站在领域内每秒回复 1.2 生命", echoBoomerang: "返程结束分裂三枚回声弹" };
      return `${definition.name} Lv5 + ${PASSIVES[definition.passive].name} Lv3 ✓；${effects[choice.target]}。占原武器槽。`;
    }
    const next = current + 1;
    if (choice.type === "passive") {
      const values = {
        might: [`伤害 +${current * 10}% → +${next * 10}%`, "月痕箭"],
        tempo: [`间隔 -${current * 7}% → -${next * 7}%`, "潮汐新星"],
        area: [`范围 +${current * 10}% → +${next * 10}%；弹体 +${current * 8}% → +${next * 8}%`, "环葬刃"],
        vitality: [`生命 +${current * 15} → +${next * 15}；立即回复 15`, "墓土领域"],
        agility: [`移速 +${current * 6}% → +${next * 6}%；闪避冷却 -${current * 4}% → -${next * 4}%`, "回声轮"],
        magnet: [`吸取 +${current * 25}% → +${next * 25}%；经验 +${current * 5}% → +${next * 5}%`, "引雷针"],
      };
      return `Lv${current} → Lv${next} · ${values[choice.target][0]}。Lv3 配合 ${values[choice.target][1]} Lv5 可进化。`;
    }
    const damageAt = level => level ? Math.round(definition.damage * Math.pow(1 + definition.growth, level - 1) * this.player.damageMultiplier) : 0;
    const behavior = {
      moonArrow: "自动锁定最近目标；Lv2/4 各加一发，Lv3 穿透 +1",
      orbitBlade: "刀刃持续环绕；同一目标每 0.42 秒可受伤；每两级多一刀",
      tideNova: "向四周爆发并击退；每级半径 +14，Lv4 间隔 -20%",
      chainSpark: "附近敌人间连锁，后续每跳衰减 12%；Lv2/4 各多一跳",
      graveField: "敌群密集处生成持续领域；每两级多一区域，每级半径 +8",
      echoBoomerang: "穿透飞出再返回，可往返命中；Lv3 多一枚，每级距离 +30",
    };
    return `Lv${current} → Lv${next} · ${choice.target === "graveField" ? "每秒伤害" : "伤害"} ${damageAt(current)} → ${damageAt(next)}。${behavior[choice.target]}。进化：${definition.name} Lv5 + ${PASSIVES[definition.passive].name} Lv3。`;
  }

  rollUpgradeChoices(chest = false) {
    const choices = [];
    const add = choice => { if (choices.length < 3 && !choices.some(item => item.id === choice.id)) choices.push(choice); };
    for (const weapon of this.build.weapons) {
      if (weapon.evolved || weapon.level < WEAPONS[weapon.id].maxLevel) continue;
      if ((this.build.passives[WEAPONS[weapon.id].passive] || 0) >= 3) add({ id: `evolve:${weapon.id}`, type: "evolve", target: weapon.id, category: "evolution", icon: "✦", name: WEAPONS[weapon.id].evolutionName, desc: `进化 ${WEAPONS[weapon.id].name}；保留武器槽`, evolved: true });
    }
    const pool = [];
    for (const weapon of this.build.weapons) if (!weapon.evolved && weapon.level < WEAPONS[weapon.id].maxLevel) pool.push(choiceForUpgrade(WEAPONS[weapon.id]));
    for (const [id, level] of Object.entries(this.build.passives)) if (level < PASSIVES[id].maxLevel) pool.push(choiceForUpgrade(PASSIVES[id]));
    if (!chest && this.activeWeapons.length < 4) for (const item of weaponList) if (!this.build.weapons.some(w => w.id === item.id)) pool.push({ id: `newWeapon:${item.id}`, type: "weapon", target: item.id, category: "weapon", icon: item.icon, name: `新武器 · ${item.name}`, desc: item.desc, isNew: true });
    if (!chest && Object.keys(this.build.passives).length < 4) for (const item of passiveList) if (!this.build.passives[item.id]) pool.push({ id: `newPassive:${item.id}`, type: "passive", target: item.id, category: "passive", icon: item.icon, name: `新被动 · ${item.name}`, desc: item.desc, isNew: true });
    const available = [...pool];
    const weight = choice => (choice.isNew ? 1 : 2) * (choice.type === "passive" && this.activeWeapons.some(weapon => WEAPONS[weapon.id].passive === choice.target) ? 1.4 : 1);
    while (choices.length < 3 && available.length) {
      let ticket = this.random() * available.reduce((sum, item) => sum + weight(item), 0);
      const index = Math.max(0, available.findIndex(item => (ticket -= weight(item)) < 0));
      add(available.splice(index, 1)[0]);
    }
    if (!choices.length) choices.push({ id: "fallback:heal", type: "heal", category: "utility", icon: "♥", name: "潮汐回响", desc: "恢复 25 点生命", fallback: true });
    return choices.map(choice => {
      const from = this.build.weapons.find(item => item.id === choice.target)?.level || this.build.passives[choice.target] || 0;
      return { ...choice, from, to: choice.type === "evolve" ? "EVO" : from + 1, desc: this.describeChoice(choice) };
    });
  }

  checkLevelUp() {
    const p = this.player;
    if (p.xp < p.xpNext || this.state !== "playing") return false;
    p.xp -= p.xpNext; p.level += 1;
    p.xpNext = Math.round(8 + p.level * 5.2 + Math.pow(p.level, 1.3));
    this.upgradeChoices = this.rollUpgradeChoices(false); this.state = "levelup";
    this.checkAchievements(); return true;
  }

  chooseUpgrade(id) {
    if (this.state !== "levelup") return false;
    const choice = this.upgradeChoices.find(item => item.id === id);
    if (!choice) return false;
    if (choice.fallback) this.player.health = Math.min(this.player.maxHealth, this.player.health + 25);
    else if (!this.applyChoice(choice)) return false;
    this.state = "playing"; this.checkLevelUp(); return true;
  }

  rerollUpgrades() {
    if (this.state !== "levelup" || this.rerollsRemaining <= 0) return false;
    this.rerollsRemaining -= 1; this.upgradeChoices = this.rollUpgradeChoices(false); return true;
  }

  skipUpgrade() {
    if (this.state !== "levelup" || this.skipsRemaining <= 0) return false;
    this.skipsRemaining -= 1; this.player.xp += this.player.level * 8;
    this.state = "playing"; this.checkLevelUp(); return true;
  }

  openChest() {
    if (this.state !== "playing") return false;
    this.chestChoices = this.rollUpgradeChoices(true);
    if (this.chestChoices[0]?.fallback) { this.player.health = Math.min(this.player.maxHealth, this.player.health + 20); this.chestsOpened += 1; return false; }
    this.state = "chest"; return true;
  }

  chooseChestUpgrade(id) {
    if (this.state !== "chest") return false;
    const choice = this.chestChoices.find(item => item.id === id);
    if (!choice || !this.applyChoice(choice)) return false;
    this.chestsOpened += 1; this.chestChoices = []; this.state = "playing"; return true;
  }

  checkAchievements() {
    const unlock = id => { if (this.profile.achievements[id] || this.earnedAchievements.includes(id)) return; this.achievementRewards += ACHIEVEMENTS[id].reward; this.earnedAchievements.push(id); };
    if (this.elapsed >= 180) unlock("dawn");
    if (this.kills >= 500) unlock("river");
    if (this.evolutions > 0) unlock("evolution");
    if (this.bossKills > 0) unlock("boss");
    if (this.activeWeapons.length >= 4 && Object.keys(this.build.passives).length >= 4) unlock("build");
    if (this.elapsed >= 600) unlock("endless");
  }

  weaponDamage(id) {
    const weapon = this.build.weapons.find(item => item.id === id);
    if (!weapon) return 0;
    if (id === "moonArrow") return this.player.damage;
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    return WEAPONS[id].damage * Math.pow(1 + WEAPONS[id].growth, Math.max(0, level - 1)) * this.player.damageMultiplier * (weapon.evolved ? 1.55 : 1);
  }

  weaponInterval(id) {
    const weapon = this.build.weapons.find(item => item.id === id);
    if (!weapon) return Infinity;
    let interval = WEAPONS[id].interval * this.player.cooldownMultiplier;
    if (id === "tideNova" && weapon.level >= 4) interval *= 0.8;
    return Math.max(0.1, interval);
  }

  update(delta, input = {}, viewport = { width: 960, height: 640 }) {
    if (this.state !== "playing") return;
    const dt = clamp(Number.isFinite(delta) ? delta : 0, 0, 0.05);
    this.elapsed += dt; this.shake = Math.max(0, this.shake - dt * 2.8);
    const p = this.player;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTime = Math.max(0, p.dashTime - dt);
    for (const altar of this.altars) altar.cooldown = Math.max(0, altar.cooldown - dt);
    for (const key of Object.keys(this.weaponClocks)) this.weaponClocks[key] -= dt;
    for (const [id, value] of this.orbitHits) { if (value <= dt) this.orbitHits.delete(id); else this.orbitHits.set(id, value - dt); }
    const movement = normalize(input.moveX || 0, input.moveY || 0);
    if (input.dash && p.dashCooldown === 0 && (movement.x || movement.y)) {
      p.dashTime = 0.19; p.dashCooldown = p.dashCooldownMax; p.invulnerable = 0.24;
      this.burst(p.x, p.y, "#c5a3ff", 12);
    }
    const speed = p.speed * (p.dashTime > 0 ? 3.1 : 1);
    if (movement.x || movement.y) p.facing = Math.atan2(movement.y, movement.x);
    p.x += movement.x * speed * dt; p.y += movement.y * speed * dt;
    const playerPosition = clampToWorld(p.x, p.y, p.radius); p.x = playerPosition.x; p.y = playerPosition.y;

    this.updateDirector(dt, viewport); this.updateAltars(dt);
    this.enemyGrid.rebuild(this.enemies);
    this.fireClock -= dt;
    if (this.fireClock <= 0 && this.enemies.length && this.arrowState) {
      const target = this.nearestEnemy();
      if (target) { this.lastAim = normalize(target.x - p.x, target.y - p.y); this.fireVolley(target); this.fireClock = p.fireInterval; }
    }
    this.updateOtherWeapons(dt); this.updateProjectiles(dt, true); this.updateEnemyProjectiles(dt);
    if (this.state !== "playing") return;
    this.updateEnemies(dt);
    if (this.state !== "playing") return;
    if (this.zones.some(zone => zone.tick + dt >= HAZARD_TICK) || this.effects.some(effect => effect.delayed > 0 && effect.delayed <= dt)) this.enemyGrid.rebuild(this.enemies);
    this.updateZones(dt);
    if (this.state !== "playing") return;
    this.updateEffects(dt);
    if (this.state === "playing") this.updateGems(dt);
    if (this.state === "playing") this.updatePickups(dt);
    this.updateParticles(dt); this.checkAchievements();
  }

  updateDirector(dt, viewport) {
    this.spawnClock += dt;
    const pulse = this.elapsed < this.tidePulseUntil ? 1.6 : 1;
    const spawnInterval = Math.max(0.2, (1.25 - this.elapsed * 0.008) / (1 + this.curse * 0.08)) / pulse;
    const warnings = [];
    for (const [kind, time, text] of [["wave", this.nextWave, "潮汐合围"], ["elite", this.nextElite, "精英来袭"], ["boss", this.nextBoss, "首领降临"]]) {
      if (time - this.elapsed <= 3 && time > this.elapsed && this.prewarnings[kind] !== time) {
        this.prewarnings[kind] = time;
        warnings.push(text);
      }
    }
    if (warnings.length) this.toastEvent = { text: `${warnings.join(" / ")} · 3 秒后`, at: this.elapsed };
    while (this.spawnClock >= spawnInterval) { this.spawnClock -= spawnInterval; this.spawnEnemy(viewport); }
    while (this.elapsed >= this.nextWave) { this.spawnWave(viewport); this.nextWave += 60; }
    if (this.elapsed >= this.nextElite) { this.spawnElite(viewport, 2 + Math.floor(this.random() * 3)); this.nextElite += Math.max(60, 110 - Math.floor(this.elapsed / 180) * 15); }
    if (this.elapsed >= this.nextBoss) { this.spawnBoss(viewport, this.bossKills); this.nextBoss += 180; }
  }

  spawnEnemy(viewport = { width: 960, height: 640 }, forced = null, position = null) {
    if (this.enemies.length >= ENTITY_LIMITS.enemies) return null;
    const minute = Math.floor(this.elapsed / 60);
    let type = forced ? ENEMIES[forced] : null;
    if (!type) {
      const available = Object.values(ENEMIES).filter(candidate => (candidate.minMinute || 0) <= minute);
      const total = available.reduce((sum, candidate) => sum + candidate.weight, 0);
      let r = this.random() * total;
      type = available.find(candidate => (r -= candidate.weight) < 0) || available[0];
    }
    let spawnPosition = position;
    if (!spawnPosition) {
      const radius = Math.max(viewport.width, viewport.height) * (0.62 + this.random() * 0.17);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const angle = this.random() * TAU;
        const candidate = { x: this.player.x + Math.cos(angle) * radius, y: this.player.y + Math.sin(angle) * radius };
        if (isInsideWorld(candidate.x, candidate.y, type.radius)) { spawnPosition = candidate; break; }
      }
      if (!spawnPosition) { const inward = normalize(-this.player.x, -this.player.y); spawnPosition = clampToWorld(this.player.x + inward.x * radius, this.player.y + inward.y * radius, type.radius); }
    }
    const pressure = pressureFor(this.elapsed) * (1 + this.curse * 0.1) * 0.72;
    const enemy = {
      id: `${this.seed}-${this.enemySerial++}-${Math.floor(this.elapsed * 1000)}`, type: type.id, behavior: type.behavior,
      x: spawnPosition.x, y: spawnPosition.y, hp: type.hp * pressure, maxHp: type.hp * pressure,
      speed: type.speed * (1 + Math.min(0.3, this.elapsed / 450) + Math.max(0, this.elapsed - 600) / 6000) * (1 + this.curse * 0.05),
      radius: type.radius, damage: type.damage, color: type.color, xp: type.xp, hitFlash: 0, contactClock: 0,
      state: "chase", stateClock: 0, shootClock: 0.4 + this.random(), chargeClock: 0, fuse: 0, elite: false, boss: false,
    };
    this.enemies.push(enemy); return enemy;
  }

  spawnWave(viewport) {
    const count = Math.min(40, 10 + Math.floor(this.elapsed / 60));
    this.tidePulseUntil = this.elapsed + 6;
    const ring = Math.max(viewport.width, viewport.height) * 0.7;
    for (let i = 0; i < count; i += 1) {
      const angle = i / count * TAU + this.random() * 0.08;
      const position = clampToWorld(this.player.x + Math.cos(angle) * ring, this.player.y + Math.sin(angle) * ring, 20);
      this.spawnEnemy(viewport, i % 2 === 0 ? "shade" : "runner", position);
    }
    this.addEntity("effects", { kind: "wave", x: this.player.x, y: this.player.y, radius: Math.max(viewport.width, viewport.height) * 0.8, life: 0.8, maxLife: 0.8, color: "#e3a2c2" });
    this.toastEvent = { text: "潮汐合围", at: this.elapsed };
  }

  spawnElite(viewport, count = 2) {
    for (let i = 0; i < count; i += 1) {
      if (this.enemies.length >= ENTITY_LIMITS.enemies) {
        const replace = this.enemies.findLastIndex(enemy => !enemy.boss && !enemy.elite);
        if (replace < 0) break;
        const [removed] = this.enemies.splice(replace, 1); this.enemyGrid.remove(removed);
      }
      const base = i % 2 ? ENEMIES.brute : ENEMIES.wraith;
      const enemy = this.spawnEnemy(viewport, base.id);
      if (!enemy) break;
      enemy.elite = true; enemy.hp *= 5.5; enemy.maxHp = enemy.hp; enemy.radius *= 1.3;
      enemy.damage *= 1.15; enemy.xp *= 5; enemy.color = "#f4bd77";
    }
    this.toastEvent = { text: "精英 · 潮影巡视者出现", at: this.elapsed };
  }

  spawnBoss(viewport, index = 0) {
    if (this.boss) return this.boss;
    if (this.enemies.length >= ENTITY_LIMITS.enemies) {
      const removed = this.enemies.pop(); this.enemyGrid.remove(removed);
    }
    const definition = index % 2 === 0 ? BOSSES.colossus : BOSSES.executioner;
    const cycle = Math.floor(index / 2) + 1;
    const hp = definition.hp * (1 + Math.max(0, cycle - 1) * 0.55) * (1 + this.curse * 0.1);
    const position = clampToWorld(this.player.x, this.player.y + Math.max(viewport.width, viewport.height) * 0.6, definition.radius);
    const boss = {
      id: `${this.seed}-boss-${index}`, type: definition.id, behavior: "boss", boss: true, bossIndex: index, name: definition.name,
      x: position.x, y: position.y, hp, maxHp: hp, speed: definition.speed * (1 + Math.min(0.25, cycle * 0.04)) * (1 + this.curse * 0.05),
      radius: definition.radius, damage: definition.damage * (1 + Math.min(0.35, cycle * 0.06)), color: definition.color,
      xp: definition.xp + cycle * 4, hitFlash: 0, contactClock: 0, state: "chase", stateClock: 0, shootClock: 1.2, chargeClock: 0, fuse: 0, elite: false,
    };
    this.enemies.push(boss); this.boss = boss;
    this.addEntity("effects", { kind: "boss", x: boss.x, y: boss.y, radius: 150, life: 1.2, maxLife: 1.2, color: boss.color });
    return boss;
  }

  nearestEnemy() {
    let target = null, best = Infinity;
    for (const enemy of this.enemies) {
      const d = (enemy.x - this.player.x) ** 2 + (enemy.y - this.player.y) ** 2;
      if (d < best) { best = d; target = enemy; }
    }
    return target;
  }

  fireVolley(target) {
    const p = this.player, base = Math.atan2(target.y - p.y, target.x - p.x), count = Math.max(1, p.projectileCount), spread = count > 1 ? 0.16 : 0;
    for (let i = 0; i < count; i += 1) {
      const angle = base + (i - (count - 1) / 2) * spread;
      this.addEntity("projectiles", { x: p.x, y: p.y, vx: Math.cos(angle) * p.projectileSpeed, vy: Math.sin(angle) * p.projectileSpeed, radius: p.projectileSize, damage: p.damage, life: 1.3, pierce: p.pierce, kind: "arrow", split: Boolean(this.arrowState?.evolved), hitIds: new Set(), trail: [] });
    }
    this.burst(p.x + Math.cos(base) * 18, p.y + Math.sin(base) * 18, "#ffd59e", 2);
  }

  updateOtherWeapons(dt = 1 / 60) {
    for (const weapon of this.activeWeapons) {
      if (weapon.id === "orbitBlade") { this.fireOrbit(weapon, dt); continue; }
      if (weapon.id === "moonArrow" || (this.weaponClocks[weapon.id] ?? 0) > 0) continue;
      if (weapon.id === "tideNova") this.fireNova(weapon);
      else if (weapon.id === "chainSpark" && this.enemies.length) this.fireChain(weapon);
      else if (weapon.id === "graveField") this.fireGraveField(weapon);
      else if (weapon.id === "echoBoomerang") this.fireBoomerang(weapon);
      this.weaponClocks[weapon.id] = this.weaponInterval(weapon.id);
    }
  }

  damageCircle(x, y, radius, damage, color, knockback = 0) {
    const candidates = this.enemyGrid.query(x, y, radius);
    for (const index of candidates) {
      const enemy = this.enemyGrid.items[index];
      if (enemy.hp <= 0 || distance(x, y, enemy.x, enemy.y) > radius + enemy.radius) continue;
      this.damageEnemy(enemy, damage, { color, amount: 2 });
      if (knockback && !enemy.boss) {
        const n = normalize(enemy.x - x, enemy.y - y);
        enemy.knockbackX = n.x * knockback; enemy.knockbackY = n.y * knockback;
      }
    }
  }

  fireOrbit(weapon, dt = 1 / 60) {
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    const blades = WEAPONS.orbitBlade.blades + Math.floor((level - 1) / 2);
    const radius = (WEAPONS.orbitBlade.radius + (level - 1) * 8) * this.player.areaMultiplier;
    const damage = this.weaponDamage(weapon.id);
    const angle = this.elapsed * (2.8 + (level - 1) * 0.18);
    this.orbitTrailClock -= dt;
    this.orbitBlades.length = blades;
    for (let i = 0; i < blades; i += 1) {
      const a = angle + i / blades * TAU;
      const blade = this.orbitBlades[i] ||= {};
      Object.assign(blade, { x: this.player.x + Math.cos(a) * radius, y: this.player.y + Math.sin(a) * radius, radius: 11, color: WEAPONS.orbitBlade.color, angle: a });
    }
    for (const blade of this.orbitBlades) {
      const candidates = this.enemyGrid.query(blade.x, blade.y, blade.radius);
      for (const index of candidates) {
        const enemy = this.enemyGrid.items[index];
        if (distance(blade.x, blade.y, enemy.x, enemy.y) > blade.radius + enemy.radius || (this.orbitHits.get(enemy.id) || 0) > 0) continue;
        this.orbitHits.set(enemy.id, this.weaponInterval("orbitBlade"));
        this.damageEnemy(enemy, damage, { x: enemy.x, y: enemy.y, color: WEAPONS.orbitBlade.color, amount: 4 });
      }
      if (weapon.evolved && this.orbitTrailClock <= 0) this.addEntity("zones", { kind: "blade", x: blade.x, y: blade.y, radius: 18, life: 0.7, maxLife: 0.7, tick: HAZARD_TICK, damage: damage * 0.18, color: WEAPONS.orbitBlade.color });
    }
    if (this.orbitTrailClock <= 0) this.orbitTrailClock = 0.18;
  }

  fireNova(weapon) {
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    const radius = (WEAPONS.tideNova.radius + (level - 1) * 14) * this.player.areaMultiplier;
    const damage = this.weaponDamage(weapon.id);
    this.addEntity("effects", { kind: "nova", x: this.player.x, y: this.player.y, radius, life: 0.45, maxLife: 0.45, color: WEAPONS.tideNova.color });
    this.damageCircle(this.player.x, this.player.y, radius, damage, WEAPONS.tideNova.color, 12 + level * 3);
    if (weapon.evolved) this.addEntity("effects", { kind: "nova", x: this.player.x, y: this.player.y, radius: radius * 1.25, life: 0.8, maxLife: 0.8, color: "#d1fff8", damage: damage * 0.65, delayed: 0.24 });
  }

  fireChain(weapon) {
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    const jumps = WEAPONS.chainSpark.jumps + (level >= 2 ? 1 : 0) + (level >= 4 ? 1 : 0);
    const range = WEAPONS.chainSpark.range * this.player.areaMultiplier;
    let current = this.nearestEnemy();
    if (!current || distance(this.player.x, this.player.y, current.x, current.y) > range) return;
    const points = [{ x: this.player.x, y: this.player.y }], hit = new Set();
    for (let i = 0; i <= jumps && current; i += 1) {
      hit.add(current.id); points.push({ x: current.x, y: current.y });
      this.damageEnemy(current, this.weaponDamage(weapon.id) * Math.pow(0.88, i), { x: current.x, y: current.y, color: WEAPONS.chainSpark.color, amount: 4 });
      let next = null, best = Infinity;
      const candidates = this.enemyGrid.query(current.x, current.y, WEAPONS.chainSpark.jump * this.player.areaMultiplier);
      for (const index of candidates) {
        const enemy = this.enemyGrid.items[index];
        if (hit.has(enemy.id)) continue;
        const d = distance(current.x, current.y, enemy.x, enemy.y);
        if (d <= WEAPONS.chainSpark.jump * this.player.areaMultiplier && d < best) { best = d; next = enemy; }
      }
      if (weapon.evolved && (i === jumps || !next)) this.addEntity("zones", { kind: "lightning", x: current.x, y: current.y, radius: 45 * this.player.areaMultiplier, life: 0.35, maxLife: 0.35, tick: HAZARD_TICK, damage: this.weaponDamage(weapon.id) * 0.5, color: "#b9f5ff" });
      current = next;
    }
    this.addEntity("effects", { kind: "chain", points, life: 0.25, maxLife: 0.25, color: WEAPONS.chainSpark.color });
  }

  fireGraveField(weapon) {
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    const areas = WEAPONS.graveField.areas + Math.floor(level / 2);
    const radius = (WEAPONS.graveField.radius + (level - 1) * 8) * this.player.areaMultiplier;
    let target = this.player, density = -1;
    // Sample occupied grid buckets instead of comparing every pair of enemies.
    for (const row of this.enemyGrid.rows.values()) for (const bucket of row.values()) {
      if (bucket.length <= density) continue;
      const candidate = this.enemyGrid.items[bucket[0]];
      if (candidate.hp > 0 && distance(candidate.x, candidate.y, this.player.x, this.player.y) < 600) { density = bucket.length; target = candidate; }
    }
    for (let i = 0; i < areas; i += 1) {
      this.addEntity("zones", {
        kind: weapon.evolved ? "graveEvolved" : "grave", x: target.x + (i ? (this.random() - 0.5) * radius * 2.2 : 0), y: target.y + (i ? (this.random() - 0.5) * radius * 2.2 : 0),
        radius, life: WEAPONS.graveField.duration, maxLife: WEAPONS.graveField.duration, tick: 0,
        damage: this.weaponDamage(weapon.id) * 0.4, color: WEAPONS.graveField.color,
      });
    }
  }

  fireBoomerang(weapon) {
    const level = weapon.level + (weapon.evolved ? 1 : 0);
    const count = WEAPONS.echoBoomerang.count + (level >= 3 ? 1 : 0);
    const target = this.nearestEnemy();
    const base = target ? Math.atan2(target.y - this.player.y, target.x - this.player.x) : this.player.facing;
    for (let i = 0; i < count; i += 1) {
      const angle = base + (i - (count - 1) / 2) * 0.42;
      this.addEntity("projectiles", {
        kind: "boomerang", x: this.player.x, y: this.player.y, vx: Math.cos(angle) * WEAPONS.echoBoomerang.speed, vy: Math.sin(angle) * WEAPONS.echoBoomerang.speed,
        radius: 10 * this.player.areaMultiplier, damage: this.weaponDamage(weapon.id), life: 3, travel: 0,
        maxTravel: WEAPONS.echoBoomerang.distance + (level - 1) * 30, returning: false, hitIds: new Set(), trail: [], echoSplit: weapon.evolved, splitCount: 0,
      });
    }
  }

  updateProjectiles(dt, prepared = false) {
    this.collisionChecksLastUpdate = 0;
    if (!this.projectiles.length) { if (!prepared) this.enemyGrid.clear(); return; }
    if (!prepared) this.enemyGrid.rebuild(this.enemies);
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const shot = this.projectiles[i];
      if (shot.kind === "boomerang") { this.updateBoomerang(shot, dt); if (shot.remove) this.projectiles.splice(i, 1); continue; }
      if (shot.kind === "fragment") {
        let target = null, best = 240 ** 2;
        const targets = this.enemyGrid.query(shot.x, shot.y, 240);
        for (const index of targets) {
          const enemy = this.enemyGrid.items[index];
          const d = (enemy.x - shot.x) ** 2 + (enemy.y - shot.y) ** 2;
          if (!shot.hitIds.has(enemy.id) && d < best) { best = d; target = enemy; }
        }
        if (target) {
          const direction = normalize(target.x - shot.x, target.y - shot.y);
          const turn = Math.min(1, dt * 8);
          const velocity = normalize(shot.vx * (1 - turn) + direction.x * 420 * turn, shot.vy * (1 - turn) + direction.y * 420 * turn);
          shot.vx = velocity.x * 420; shot.vy = velocity.y * 420;
        }
      }
      shot.x += shot.vx * dt; shot.y += shot.vy * dt; shot.life -= dt;
      shot.trail.push({ x: shot.x, y: shot.y }); if (shot.trail.length > 4) shot.trail.shift();
      let consumed = false;
      const candidates = this.enemyGrid.query(shot.x, shot.y, shot.radius);
      for (const index of candidates) {
        const enemy = this.enemyGrid.items[index];
        if (shot.hitIds.has(enemy.id)) continue;
        this.collisionChecksLastUpdate += 1;
        if (distance(shot.x, shot.y, enemy.x, enemy.y) <= shot.radius + enemy.radius) {
          shot.hitIds.add(enemy.id); enemy.hp -= shot.damage; enemy.hitFlash = 0.12;
          this.shake = Math.max(this.shake, 0.12); this.burst(shot.x, shot.y, enemy.color, 4);
          if (shot.split) this.spawnArrowFragments(shot, enemy, shot.damage * 0.35, 2);
          if (enemy.hp <= 0) this.killEnemy(enemy);
          if (shot.pierce > 0) shot.pierce -= 1; else { consumed = true; break; }
        }
      }
      if (consumed || shot.life <= 0 || Math.abs(shot.x - this.player.x) > 1000 || Math.abs(shot.y - this.player.y) > 1000) this.projectiles.splice(i, 1);
    }
  }

  updateBoomerang(shot, dt) {
    shot.life -= dt;
    if (!shot.returning) {
      shot.x += shot.vx * dt; shot.y += shot.vy * dt; shot.travel += Math.hypot(shot.vx, shot.vy) * dt;
      if (shot.travel >= shot.maxTravel) { shot.returning = true; shot.hitIds.clear(); }
    } else {
      const direction = normalize(this.player.x - shot.x, this.player.y - shot.y);
      shot.x += direction.x * WEAPONS.echoBoomerang.speed * dt; shot.y += direction.y * WEAPONS.echoBoomerang.speed * dt;
      if (distance(shot.x, shot.y, this.player.x, this.player.y) < this.player.radius + 12) {
        if (shot.echoSplit && !shot.splitCount) {
          shot.splitCount = 1;
          for (let i = 0; i < 3; i += 1) {
            const angle = i / 3 * TAU;
            this.addEntity("projectiles", { x: shot.x, y: shot.y, vx: Math.cos(angle) * 500, vy: Math.sin(angle) * 500, radius: 6, damage: shot.damage * 0.45, life: 0.7, pierce: 1, hitIds: new Set(), trail: [] });
          }
        }
        shot.remove = true; return;
      }
    }
    shot.trail.push({ x: shot.x, y: shot.y }); if (shot.trail.length > 8) shot.trail.shift();
    const candidates = this.enemyGrid.query(shot.x, shot.y, shot.radius);
    for (const index of candidates) {
      const enemy = this.enemyGrid.items[index];
      if (shot.hitIds.has(enemy.id) || distance(shot.x, shot.y, enemy.x, enemy.y) > shot.radius + enemy.radius) continue;
      shot.hitIds.add(enemy.id); enemy.hp -= shot.damage; enemy.hitFlash = 0.12; this.burst(shot.x, shot.y, enemy.color, 4);
      if (enemy.hp <= 0) this.killEnemy(enemy);
    }
    if (shot.life <= 0) shot.remove = true;
  }

  spawnArrowFragments(shot, enemy, damage, count) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.atan2(enemy.y - shot.y, enemy.x - shot.x) + (i ? 0.7 : -0.7);
      this.addEntity("projectiles", { x: enemy.x, y: enemy.y, vx: Math.cos(angle) * 420, vy: Math.sin(angle) * 420, radius: 4 * this.player.projectileSize / 5, damage, life: 0.8, pierce: 0, kind: "fragment", hitIds: new Set([enemy.id]), trail: [] });
    }
  }

  damageEnemy(enemy, amount, { x = enemy.x, y = enemy.y, color = enemy.color, amount: particles = 3 } = {}) {
    if (!enemy || enemy.hp <= 0) return false;
    enemy.hp -= amount; enemy.hitFlash = 0.12; this.burst(x, y, color, particles);
    if (enemy.hp <= 0) this.killEnemy(enemy);
    return true;
  }

  killEnemy(enemy, { dropGem = true, suicide = false } = {}) {
    const index = this.enemies.indexOf(enemy);
    if (index < 0) return;
    this.enemies.splice(index, 1); this.enemyGrid.remove(enemy); this.kills += 1;
    if (enemy.boss) {
      this.boss = null; this.bossKills += 1;
      this.addEntity("pickups", { id: `chest-${enemy.id}`, type: "chest", x: enemy.x, y: enemy.y, radius: 16, phase: this.random() * TAU });
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 20);
      this.addEntity("effects", { kind: "boss", x: enemy.x, y: enemy.y, radius: 190, life: 1.2, maxLife: 1.2, color: enemy.color });
    } else if (enemy.elite) {
      this.eliteKills += 1; this.player.health = Math.min(this.player.maxHealth, this.player.health + 8);
      if (this.random() < 0.35) this.addEntity("pickups", { id: `chest-${enemy.id}`, type: "chest", x: enemy.x, y: enemy.y, radius: 15, phase: this.random() * TAU });
    }
    if (enemy.behavior === "split" && !enemy.noSplit) {
      for (let i = 0; i < 2 && this.enemies.length < ENTITY_LIMITS.enemies; i += 1) {
        const type = ENEMIES.shade, angle = i / 2 * TAU + this.random();
        this.enemies.push({
          id: `${enemy.id}-split-${i}`, type: "shade", behavior: "chase", x: enemy.x + Math.cos(angle) * 12, y: enemy.y + Math.sin(angle) * 12,
          hp: type.hp * 0.65, maxHp: type.hp * 0.65, speed: type.speed * 1.3, radius: 8, damage: 5, color: "#cdeb9a", xp: 1,
          hitFlash: 0, contactClock: 0, state: "chase", stateClock: 0, shootClock: 1, chargeClock: 0, fuse: 0, elite: false, boss: false, noSplit: true,
        });
      }
    }
    if (dropGem) {
      const gemPosition = clampToWorld(enemy.x, enemy.y, 8 + enemy.xp);
      this.addEntity("gems", { x: gemPosition.x, y: gemPosition.y, radius: 7 + enemy.xp, value: enemy.xp * this.player.xpMultiplier, phase: this.random() * 6.28, color: enemy.xp > 1 ? "#9fe8df" : "#a8c8ff" });
    }
    if (!suicide && !enemy.boss && this.random() < (enemy.elite ? 0.35 : this.player.pickupChance)) {
      const types = ["heart", "magnet", "holy", "bomb"], type = types[Math.floor(this.random() * types.length)];
      const position = clampToWorld(enemy.x, enemy.y, 12);
      this.addEntity("pickups", { id: `pickup-${enemy.id}`, type, x: position.x, y: position.y, radius: 11, phase: this.random() * TAU });
    }
    this.burst(enemy.x, enemy.y, enemy.color, 13);
  }

  updateEnemies(dt) {
    const p = this.player;
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const d = distance(p.x, p.y, enemy.x, enemy.y) || 1;
      let moveX = (p.x - enemy.x) / d, moveY = (p.y - enemy.y) / d, speed = enemy.speed || 0;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      enemy.contactClock = Math.max(0, (enemy.contactClock || 0) - dt);
      enemy.stateClock = Math.max(0, (enemy.stateClock || 0) - dt);
      enemy.chargeClock = Math.max(0, (enemy.chargeClock || 0) - dt);
      if (enemy.behavior === "wraith") {
        const sway = Math.sin(this.elapsed * 4 + enemy.x * 0.01) * 0.55;
        moveX += -moveY * sway; moveY += moveX * sway;
      } else if (enemy.behavior === "ranged") {
        if (d < 210) { moveX *= -0.7; moveY *= -0.7; } else if (d < 280) speed *= 0.15;
        enemy.shootClock -= dt;
        if (enemy.shootClock <= 0 && d < 520) { this.fireEnemyProjectile(enemy, p.x, p.y, 150, enemy.damage * 0.85, "#ffc47e", 7); enemy.shootClock = 2.1 + this.random() * 0.7; }
      } else if (enemy.behavior === "charge") {
        if (enemy.state === "windup") {
          speed = 0;
          if (enemy.stateClock <= 0) { enemy.state = "dash"; enemy.stateClock = 0.42; }
        } else if (enemy.state === "dash") {
          moveX = enemy.dashX; moveY = enemy.dashY; speed *= 4.2;
          if (enemy.stateClock <= 0) { enemy.state = "chase"; enemy.chargeClock = 2.4; }
        } else if (d < 260 && enemy.chargeClock <= 0) { enemy.state = "windup"; enemy.stateClock = 0.7; enemy.dashX = moveX; enemy.dashY = moveY; speed = 0; }
      } else if (enemy.behavior === "bomb") {
        if (enemy.fuse > 0) { enemy.fuse -= dt; speed *= 0.4; if (enemy.fuse <= 0) { this.explodeEnemy(enemy); continue; } }
        else if (d < 62) enemy.fuse = 0.75;
      } else if (enemy.behavior === "boss") {
        this.updateBossAttack(enemy, dt, d);
        if (enemy.state === "windup") {
          speed = 0;
          if (enemy.stateClock <= 0) { enemy.state = "dash"; enemy.stateClock = 0.65; }
        } else if (enemy.state === "dash") {
          moveX = enemy.dashX; moveY = enemy.dashY; speed = 480;
          if (enemy.stateClock <= 0) { enemy.state = "chase"; speed = enemy.speed; }
        }
      }
      const position = clampToWorld(enemy.x + moveX * speed * dt + (enemy.knockbackX || 0), enemy.y + moveY * speed * dt + (enemy.knockbackY || 0), enemy.radius);
      enemy.knockbackX = 0; enemy.knockbackY = 0;
      enemy.x = position.x; enemy.y = position.y;
      if (d < p.radius + enemy.radius && enemy.contactClock === 0 && p.invulnerable === 0) {
        this.hurtPlayer(enemy.damage); enemy.contactClock = enemy.boss ? 0.9 : 0.75;
        if (this.state !== "playing") return;
      }
    }
  }

  updateBossAttack(boss, dt, d) {
    boss.phase = boss.hp <= boss.maxHp * 0.5 ? 2 : 1;
    if (boss.state !== "chase") return;
    boss.shootClock -= dt;
    if (boss.shootClock > 0) return;
    const isSecond = boss.type === "executioner";
    boss.shootClock = (boss.bossIndex > 2 ? 1.8 : 2.6) * (boss.phase === 2 ? 0.72 : 1);
    boss.attackCount = (boss.attackCount || 0) + 1;
    if (isSecond && boss.attackCount % 2 === 1) {
      const direction = normalize(this.player.x - boss.x, this.player.y - boss.y);
      boss.dashX = direction.x; boss.dashY = direction.y;
      boss.state = "windup"; boss.stateClock = 0.7;
    } else if (isSecond) {
      for (let i = 0; i < 4; i += 1) {
        const angle = i / 4 * TAU + this.elapsed;
        this.fireEnemyProjectile({ x: boss.x + Math.cos(angle) * boss.radius, y: boss.y + Math.sin(angle) * boss.radius }, boss.x + Math.cos(angle) * 600, boss.y + Math.sin(angle) * 600, 210, boss.damage * 0.55, "#efa7bb", 8);
      }
    } else if (boss.attackCount % 2 === 1) {
      for (let i = 0; i < 12; i += 1) {
        const angle = i / 12 * TAU + this.elapsed * 0.4;
        this.fireEnemyProjectile({ x: boss.x + Math.cos(angle) * boss.radius, y: boss.y + Math.sin(angle) * boss.radius }, boss.x + Math.cos(angle) * 600, boss.y + Math.sin(angle) * 600, 145, boss.damage * 0.42, "#9ce1f0", 7);
      }
    } else {
      for (let i = 0; i < 4; i += 1) {
        const angle = i / 4 * TAU;
        const point = clampToWorld(boss.x + Math.cos(angle) * 55, boss.y + Math.sin(angle) * 55, 9);
        this.spawnEnemy({ width: 960, height: 640 }, "runner", point);
      }
    }
  }

  fireEnemyProjectile(source, targetX, targetY, speed, damage, color, radius) {
    const direction = normalize(targetX - source.x, targetY - source.y);
    this.addEntity("enemyProjectiles", { x: source.x, y: source.y, vx: direction.x * speed, vy: direction.y * speed, radius, damage, color, life: 5 });
  }

  updateEnemyProjectiles(dt) {
    const p = this.player;
    for (let i = this.enemyProjectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.enemyProjectiles[i];
      projectile.x += projectile.vx * dt; projectile.y += projectile.vy * dt; projectile.life -= dt;
      if (projectile.life <= 0 || !isInsideWorld(projectile.x, projectile.y)) { this.enemyProjectiles.splice(i, 1); continue; }
      if (distance(projectile.x, projectile.y, p.x, p.y) <= projectile.radius + p.radius && p.invulnerable === 0) {
        this.hurtPlayer(projectile.damage); this.enemyProjectiles.splice(i, 1);
        if (this.state !== "playing") return;
      }
    }
  }

  explodeEnemy(enemy) {
    if (!this.enemies.includes(enemy)) return;
    this.addEntity("zones", { kind: "bomb", x: enemy.x, y: enemy.y, radius: 72, life: 2.5, maxLife: 2.5, tick: 0, damage: 7, color: "#e7cf6b", hostile: true });
    this.addEntity("effects", { kind: "bomb", x: enemy.x, y: enemy.y, radius: 90, life: 0.45, maxLife: 0.45, color: "#f0df83" });
    this.killEnemy(enemy, { dropGem: false, suicide: true });
  }

  hurtPlayer(amount) {
    const p = this.player;
    if (p.invulnerable > 0 || this.state !== "playing") return;
    p.health = Math.max(0, p.health - amount); p.invulnerable = 0.58; this.shake = 0.75;
    this.burst(p.x, p.y, "#ff7181", 14);
    if (p.health <= 0) { this.finishRun(true, "died"); this.state = "gameover"; }
  }

  updateZones(dt) {
    const p = this.player;
    let healing = false;
    for (let i = this.zones.length - 1; i >= 0; i -= 1) {
      const zone = this.zones[i];
      zone.life -= dt;
      if (zone.life <= 0) { this.zones.splice(i, 1); continue; }
      if (!zone.tick) zone.tick = 0;
      zone.tick += dt;
      if (zone.kind === "graveEvolved") {
        const direction = normalize(p.x - zone.x, p.y - zone.y);
        zone.x += direction.x * 14 * dt; zone.y += direction.y * 14 * dt;
        if (distance(p.x, p.y, zone.x, zone.y) <= zone.radius) healing = true;
      }
      if (zone.tick < HAZARD_TICK) continue;
      zone.tick = 0;
      if (zone.hostile && distance(zone.x, zone.y, p.x, p.y) < zone.radius + p.radius) this.hurtPlayer(zone.damage);
      if (this.state !== "playing") return;
      this.damageCircle(zone.x, zone.y, zone.radius, zone.damage, zone.color);
    }
    if (healing) p.health = Math.min(p.maxHealth, p.health + 1.2 * dt);
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      if (effect.delayed) {
        effect.delayed -= dt;
        if (effect.delayed > 0) continue;
        effect.delayed = 0;
        this.damageCircle(effect.x, effect.y, effect.radius, effect.damage, effect.color);
        effect.life = 0.4; effect.maxLife = 0.4; continue;
      }
      effect.life -= dt;
      if (effect.life <= 0) this.effects.splice(i, 1);
    }
  }

  updateGems(dt) {
    const p = this.player, allMagnet = this.magnetUntil > this.elapsed;
    for (let i = this.gems.length - 1; i >= 0; i -= 1) {
      const gem = this.gems[i];
      gem.phase += dt * 2;
      const d = distance(p.x, p.y, gem.x, gem.y);
      if (allMagnet || d < p.magnet) {
        const speed = allMagnet ? 780 : 125 + Math.max(0, p.magnet - d) * 2.6;
        const n = normalize(p.x - gem.x, p.y - gem.y);
        gem.x += n.x * speed * dt; gem.y += n.y * speed * dt;
      }
      if (d < p.radius + gem.radius + 6) {
        p.xp += gem.value; this.gems.splice(i, 1); this.checkLevelUp();
        if (this.state !== "playing") break;
      }
    }
  }

  updatePickups(dt) {
    const p = this.player;
    for (let i = this.pickups.length - 1; i >= 0; i -= 1) {
      const pickup = this.pickups[i];
      pickup.phase = (pickup.phase || 0) + dt;
      if (distance(p.x, p.y, pickup.x, pickup.y) > p.radius + pickup.radius + 4) continue;
      this.pickups.splice(i, 1);
      if (pickup.type === "heart") p.health = Math.min(p.maxHealth, p.health + p.maxHealth * 0.2);
      else if (pickup.type === "magnet") this.magnetUntil = this.elapsed + 6;
      else if (pickup.type === "holy") this.addEntity("zones", { kind: "holy", x: p.x, y: p.y, radius: 120 * p.areaMultiplier, life: 8, maxLife: 8, tick: 0, damage: 13 * p.damageMultiplier, color: "#e9df9b" });
      else if (pickup.type === "bomb") {
        for (const enemy of [...this.enemies]) if (distance(p.x, p.y, enemy.x, enemy.y) < 520) this.damageEnemy(enemy, 160 * p.damageMultiplier, { x: enemy.x, y: enemy.y, color: "#f0a56d", amount: 3 });
        this.shake = 1;
      } else if (pickup.type === "chest") {
        if (pickup.charges > 1) this.addEntity("pickups", { ...pickup, charges: pickup.charges - 1 });
        this.openChest();
      }
      if (this.state !== "playing") break;
    }
  }

  updateAltars(dt) {
    const p = this.player;
    for (const altar of this.altars) {
      if (altar.cooldown > 0) continue;
      if (distance(p.x, p.y, altar.x, altar.y) <= altar.radius) {
        altar.progress += dt;
        if (altar.progress >= 2) {
          altar.progress = 0; altar.cooldown = 180; this.altarRanks += 1; this.curse += 1; this.recalculateStats(false);
          const hpRatio = (1 + this.curse * 0.1) / (1 + (this.curse - 1) * 0.1);
          const speedRatio = (1 + this.curse * 0.05) / (1 + (this.curse - 1) * 0.05);
          for (const enemy of this.enemies) { enemy.hp *= hpRatio; enemy.maxHp *= hpRatio; enemy.speed *= speedRatio; }
          this.addEntity("pickups", { id: `altar-chest-${altar.id}`, type: "chest", x: p.x + 24, y: p.y, radius: 16, phase: 0 });
          this.addEntity("effects", { kind: "altar", x: altar.x, y: altar.y, radius: 110, life: 1, maxLife: 1, color: "#d9bcff" });
          this.toastEvent = { text: `祭坛觉醒 · 诅咒 ${this.curse}`, at: this.elapsed };
        }
      } else altar.progress = Math.max(0, altar.progress - dt);
    }
  }

  burst(x, y, color, amount) {
    const limit = Math.max(0, Math.floor(this.particleLimit));
    if (this.particles.length > limit) this.particles.length = limit;
    for (let i = 0; i < amount; i += 1) {
      const angle = this.random() * Math.PI * 2, speed = 24 + this.random() * 145;
      const life = 0.28 + this.random() * 0.42, radius = 1.2 + this.random() * 2.3;
      if (this.particles.length < limit) this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, maxLife: 0.7, radius, color });
    }
  }

  updateParticles(dt) {
    const limit = Math.max(0, Math.floor(this.particleLimit));
    let alive = 0;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      particle.x += particle.vx * dt; particle.y += particle.vy * dt;
      particle.vx *= 0.95; particle.vy *= 0.95; particle.life -= dt;
      if (particle.life > 0 && alive < limit) this.particles[alive++] = particle;
    }
    this.particles.length = alive;
  }
}

