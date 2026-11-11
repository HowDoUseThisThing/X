import { clamp, distance, mulberry32, normalize } from "../core/math.js";
import { WORLD, clampToWorld, isInsideWorld } from "./world.js";

const UPGRADES = [
  { id: "might", icon: "✹", name: "余烬共鸣", desc: "武器伤害提升 25%", apply: s => { s.damage *= 1.25; } },
  { id: "tempo", icon: "⟡", name: "潮汐节拍", desc: "攻击间隔缩短 18%", apply: s => { s.fireInterval = Math.max(0.12, s.fireInterval * 0.82); } },
  { id: "vitality", icon: "♥", name: "月蚀庇护", desc: "最大生命 +25，并恢复 25 点生命", apply: s => { s.maxHealth += 25; s.health = Math.min(s.maxHealth, s.health + 25); } },
  { id: "agility", icon: "➤", name: "逐浪步伐", desc: "移动速度提升 12%", apply: s => { s.speed *= 1.12; } },
  { id: "magnet", icon: "◎", name: "拾光磁场", desc: "经验吸取范围提升 50%", apply: s => { s.magnet *= 1.5; } },
  { id: "multishot", icon: "⋆", name: "双生流星", desc: "额外发射一枚弹体（最多 5 枚）", apply: s => { s.projectileCount = Math.min(5, s.projectileCount + 1); } },
  { id: "pierce", icon: "↠", name: "穿月箭矢", desc: "每枚弹体多穿透一名敌人", apply: s => { s.pierce += 1; } },
  { id: "area", icon: "◉", name: "引力余波", desc: "弹体范围和速度提升 15%", apply: s => { s.projectileSize *= 1.15; s.projectileSpeed *= 1.15; } },
];

export const WORLD_SIZE = WORLD;

const ENEMY_TYPES = [
  { id: "shade", hp: 28, speed: 38, radius: 12, damage: 9, color: "#b2a0ee", xp: 1, weight: 0.55 },
  { id: "runner", hp: 18, speed: 62, radius: 9, damage: 7, color: "#ff7990", xp: 1, weight: 0.25 },
  { id: "brute", hp: 86, speed: 25, radius: 19, damage: 17, color: "#d17fba", xp: 3, weight: 0.13 },
  { id: "wraith", hp: 38, speed: 49, radius: 14, damage: 12, color: "#71d5cf", xp: 2, weight: 0.07 },
];

export class SurvivorGame {
  constructor(seed = 0x51ea) {
    this.seed = seed >>> 0;
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.random = mulberry32(this.seed);
    this.state = "title";
    this.elapsed = 0;
    this.kills = 0;
    this.spawnClock = 0;
    this.fireClock = 0;
    this.dashClock = 0;
    this.shake = 0;
    this.player = {
      x: 0, y: 0, radius: 13, health: 100, maxHealth: 100, speed: 190,
      xp: 0, xpNext: 8, level: 1, damage: 22, fireInterval: 0.58,
      projectileSpeed: 460, projectileCount: 1, projectileSize: 5, facing: -Math.PI / 2,
      pierce: 0, magnet: 96, invulnerable: 0, dashCooldown: 0, dashTime: 0,
    };
    this.enemies = [];
    this.projectiles = [];
    this.gems = [];
    this.particles = [];
    this.upgradeChoices = [];
    this.lastAim = { x: 1, y: 0 };
  }

  start() {
    if (this.state === "title" || this.state === "gameover") {
      this.reset(this.seed);
      this.state = "playing";
    }
  }

  resume() { if (this.state === "paused") this.state = "playing"; }
  pause() { if (this.state === "playing") this.state = "paused"; }

  chooseUpgrade(id) {
    if (this.state !== "levelup") return false;
    const upgrade = UPGRADES.find(item => item.id === id && this.upgradeChoices.includes(item));
    if (!upgrade) return false;
    upgrade.apply(this.player);
    this.state = "playing";
    this.checkLevelUp();
    return true;
  }

  update(delta, input = {}, viewport = { width: 960, height: 640 }) {
    if (this.state !== "playing") return;
    const dt = clamp(Number.isFinite(delta) ? delta : 0, 0, 0.05);
    this.elapsed += dt;
    this.shake = Math.max(0, this.shake - dt * 2.8);
    const p = this.player;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTime = Math.max(0, p.dashTime - dt);
    const movement = normalize(input.moveX || 0, input.moveY || 0);
    if (input.dash && p.dashCooldown === 0 && (movement.x || movement.y)) {
      p.dashTime = 0.19;
      p.dashCooldown = 2.1;
      p.invulnerable = 0.24;
      this.burst(p.x, p.y, "#c5a3ff", 12);
    }
    const speed = p.speed * (p.dashTime > 0 ? 3.1 : 1);
    if (movement.x || movement.y) p.facing = Math.atan2(movement.y, movement.x);
    p.x += movement.x * speed * dt;
    p.y += movement.y * speed * dt;
    const playerPosition = clampToWorld(p.x, p.y, p.radius);
    p.x = playerPosition.x;
    p.y = playerPosition.y;

    this.spawnClock += dt;
    const spawnInterval = Math.max(0.25, 1.25 - this.elapsed * 0.008);
    while (this.spawnClock >= spawnInterval) {
      this.spawnClock -= spawnInterval;
      this.spawnEnemy(viewport);
    }
    this.fireClock -= dt;
    if (this.fireClock <= 0 && this.enemies.length) {
      const target = this.nearestEnemy();
      if (target) {
        this.lastAim = normalize(target.x - p.x, target.y - p.y);
        this.fireVolley(target);
        this.fireClock = p.fireInterval;
      }
    }
    this.updateProjectiles(dt);
    this.updateEnemies(dt);
    if (this.state === "playing") this.updateGems(dt);
    this.updateParticles(dt);
  }

  spawnEnemy(viewport = { width: 960, height: 640 }) {
    const r = this.random();
    let sum = 0;
    const type = ENEMY_TYPES.find(candidate => (sum += candidate.weight) >= r) || ENEMY_TYPES[0];
    const radius = Math.max(viewport.width, viewport.height) * (0.62 + this.random() * 0.17);
    let spawnPosition = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const candidate = {
        x: this.player.x + Math.cos(angle) * radius,
        y: this.player.y + Math.sin(angle) * radius,
      };
      if (isInsideWorld(candidate.x, candidate.y, type.radius)) {
        spawnPosition = candidate;
        break;
      }
    }
    if (!spawnPosition) {
      const inward = normalize(-this.player.x, -this.player.y);
      const fallback = clampToWorld(
        this.player.x + inward.x * radius,
        this.player.y + inward.y * radius,
        type.radius,
      );
      spawnPosition = fallback;
    }
    const pressure = 1 + Math.min(2.2, this.elapsed / 165);
    this.enemies.push({
      id: `${this.seed}-${this.enemies.length}-${Math.floor(this.elapsed * 1000)}`,
      type: type.id, x: spawnPosition.x,
      y: spawnPosition.y,
      hp: type.hp * pressure, maxHp: type.hp * pressure,
      speed: type.speed * (1 + Math.min(0.3, this.elapsed / 450)),
      radius: type.radius, damage: type.damage, color: type.color, xp: type.xp,
      hitFlash: 0, contactClock: 0,
    });
  }

  nearestEnemy() {
    let target = null;
    let best = Infinity;
    for (const enemy of this.enemies) {
      const d = (enemy.x - this.player.x) ** 2 + (enemy.y - this.player.y) ** 2;
      if (d < best) { best = d; target = enemy; }
    }
    return target;
  }

  fireVolley(target) {
    const p = this.player;
    const base = Math.atan2(target.y - p.y, target.x - p.x);
    const spread = p.projectileCount > 1 ? 0.16 : 0;
    for (let i = 0; i < p.projectileCount; i += 1) {
      const offset = (i - (p.projectileCount - 1) / 2) * spread;
      const angle = base + offset;
      this.projectiles.push({
        x: p.x, y: p.y, vx: Math.cos(angle) * p.projectileSpeed,
        vy: Math.sin(angle) * p.projectileSpeed, radius: p.projectileSize,
        damage: p.damage, life: 1.3, pierce: p.pierce,
        hitIds: new Set(), trail: [],
      });
    }
    this.burst(p.x + Math.cos(base) * 18, p.y + Math.sin(base) * 18, "#ffd59e", 2);
  }

  updateProjectiles(dt) {
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

  killEnemy(enemy) {
    const index = this.enemies.indexOf(enemy);
    if (index < 0) return;
    this.enemies.splice(index, 1);
    this.kills += 1;
    const gemPosition = clampToWorld(enemy.x, enemy.y, 8 + enemy.xp);
    this.gems.push({ x: gemPosition.x, y: gemPosition.y, radius: 7 + enemy.xp, value: enemy.xp, phase: this.random() * 6.28, color: enemy.xp > 1 ? "#9fe8df" : "#a8c8ff" });
    this.burst(enemy.x, enemy.y, enemy.color, 13);
  }

  updateEnemies(dt) {
    const p = this.player;
    for (const enemy of this.enemies) {
      const d = distance(p.x, p.y, enemy.x, enemy.y) || 1;
      const enemyPosition = clampToWorld(
        enemy.x + ((p.x - enemy.x) / d) * enemy.speed * dt,
        enemy.y + ((p.y - enemy.y) / d) * enemy.speed * dt,
        enemy.radius,
      );
      enemy.x = enemyPosition.x;
      enemy.y = enemyPosition.y;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      enemy.contactClock = Math.max(0, enemy.contactClock - dt);
      if (d < p.radius + enemy.radius && enemy.contactClock === 0 && p.invulnerable === 0) {
        p.health = Math.max(0, p.health - enemy.damage);
        p.invulnerable = 0.58;
        enemy.contactClock = 0.75;
        this.shake = 0.75;
        this.burst(p.x, p.y, "#ff7181", 14);
        if (p.health <= 0) this.state = "gameover";
      }
    }
  }

  updateGems(dt) {
    const p = this.player;
    for (let i = this.gems.length - 1; i >= 0; i -= 1) {
      const gem = this.gems[i];
      gem.phase += dt * 2;
      const d = distance(p.x, p.y, gem.x, gem.y);
      if (d < p.magnet) {
        const speed = 125 + Math.max(0, p.magnet - d) * 2.6;
        const n = normalize(p.x - gem.x, p.y - gem.y);
        gem.x += n.x * speed * dt;
        gem.y += n.y * speed * dt;
      }
      if (d < p.radius + gem.radius + 6) {
        p.xp += gem.value;
        this.gems.splice(i, 1);
        this.checkLevelUp();
      }
    }
  }

  checkLevelUp() {
    const p = this.player;
    if (p.xp < p.xpNext || this.state !== "playing") return;
    p.xp -= p.xpNext;
    p.level += 1;
    p.xpNext = Math.round(8 + p.level * 5.2 + Math.pow(p.level, 1.3));
    const pool = UPGRADES.filter(item => item.id !== "multishot" || p.projectileCount < 5);
    this.upgradeChoices = [];
    while (this.upgradeChoices.length < 3 && pool.length) {
      const index = Math.floor(this.random() * pool.length);
      this.upgradeChoices.push(pool.splice(index, 1)[0]);
    }
    this.state = "levelup";
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

export const upgradeCatalog = UPGRADES.map(({ apply, ...display }) => display);





