import { WORLD, getCameraCenter, isInsideWorld } from "../game/world.js";
import { TerrainRenderer } from "./terrain.js";
import { AdaptiveQuality } from "./quality.js";
import { SpriteCache } from "./sprites.js";
import { PICKUP_TYPES, WEAPONS } from "../game/content.js";

const TAU = Math.PI * 2;

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.width = 1; this.height = 1; this.dpr = 1;
    this.quality = new AdaptiveQuality({ mobile: window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0 });
    this.sprites = new SpriteCache();
    this.view = { left: 0, top: 0, right: 1, bottom: 1 };
    this.threats = Array.from({ length: 12 }, () => ({ enemy: null, distance: Infinity }));
    this.metrics = { enemiesDrawn: 0, enemiesSkipped: 0, gemsDrawn: 0, threatsDrawn: 0, pickupsDrawn: 0, effectsDrawn: 0 };
    this.terrain = new TerrainRenderer();
    this.terrainSeed = this.terrain.map.seed;
    this.footsteps = []; this.trackedPlayer = null; this.stepDistance = 0; this.stepSide = 1;
    this.stars = Array.from({ length: 130 }, (_, i) => ({ x: Math.sin(i * 127.1) * 10000 % 1, y: Math.sin(i * 311.7 + 8) * 10000 % 1, size: 0.5 + (i * 17 % 10) / 10, alpha: 0.1 + (i * 13 % 30) / 100 }));
    this.resize();
    window.addEventListener("resize", () => this.resize(), { passive: true });
  }

  resize() {
    this.dpr = this.quality.pixelRatio(window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.boundaryGradient = this.context.createRadialGradient(this.width / 2, this.height / 2, Math.min(this.width, this.height) * .32, this.width / 2, this.height / 2, Math.max(this.width, this.height) * .72);
    this.boundaryGradient.addColorStop(0, "rgba(123,83,188,0)"); this.boundaryGradient.addColorStop(1, "rgba(151,101,226,1)");
  }

  recordFrame(milliseconds, playing) { if (this.quality.sample(milliseconds, playing)) this.resize(); }
  inView(x, y, radius = 0) { const view = this.view; return x + radius >= view.left && x - radius <= view.right && y + radius >= view.top && y - radius <= view.bottom; }

  draw(game, now = 0) {
    const ctx = this.context, w = this.width, h = this.height, p = game.player, settings = this.quality.settings;
    this.lastElapsed = game.elapsed;
    if (game.map && game.map.seed !== this.terrainSeed) { this.terrain = new TerrainRenderer(WORLD, game.map); this.terrainSeed = game.map.seed; }
    this.updateFootsteps(game);
    const camera = getCameraCenter(p.x, p.y, w, h);
    const ox = camera.x - w / 2, oy = camera.y - h / 2;
    this.view.left = ox - 10; this.view.top = oy - 10; this.view.right = ox + w + 10; this.view.bottom = oy + h + 10;
    this.metrics.enemiesDrawn = 0; this.metrics.enemiesSkipped = 0; this.metrics.gemsDrawn = 0; this.metrics.threatsDrawn = 0; this.metrics.pickupsDrawn = 0; this.metrics.effectsDrawn = 0;
    for (const threat of this.threats) { threat.enemy = null; threat.distance = Infinity; }
    ctx.fillStyle = "#090b12"; ctx.fillRect(0, 0, w, h);
    ctx.save();
    const shake = game.shake * 7;
    ctx.translate(-ox + Math.sin(now * 79) * shake, -oy + Math.cos(now * 71) * shake);
    this.terrain.draw(ctx, ox, oy, w, h);
    for (let i = 0; i < this.stars.length; i += settings.starStride) {
      const star = this.stars[i];
      const x = ((star.x * 10400 - ox * 0.24) % (w + 80) + w + 80) % (w + 80) - 40 + ox;
      const y = ((star.y * 10400 - oy * 0.24) % (h + 80) + h + 80) % (h + 80) - 40 + oy;
      ctx.fillStyle = `rgba(196,183,226,${star.alpha * (0.2 + Math.sin(now * 1.4 + x) * 0.06)})`;
      ctx.beginPath(); ctx.arc(x, y, star.size, 0, TAU); ctx.fill();
    }
    this.drawFootsteps(ctx, game.elapsed);
    this.drawAltars(ctx, game, now);
    this.drawZones(ctx, game, now);
    this.drawEffects(ctx, game, now);
    for (const gem of game.gems) { if (!this.inView(gem.x, gem.y, gem.radius + 22)) continue; this.drawGem(ctx, gem, now); this.metrics.gemsDrawn += 1; }
    for (const pickup of game.pickups || []) {
      if (!this.inView(pickup.x, pickup.y, pickup.radius + 20)) continue;
      this.drawPickup(ctx, pickup, now); this.metrics.pickupsDrawn += 1;
    }
    for (const shot of game.projectiles) {
      if (this.inView(shot.x, shot.y, shot.radius + 60)) this.drawProjectile(ctx, shot);
    }
    for (const shot of game.enemyProjectiles || []) {
      if (!this.inView(shot.x, shot.y, shot.radius + 16)) continue;
      ctx.save(); ctx.fillStyle = shot.color; ctx.shadowBlur = settings.glow ? 12 : 0; ctx.shadowColor = shot.color;
      ctx.beginPath(); ctx.arc(shot.x, shot.y, shot.radius, 0, TAU); ctx.fill(); ctx.restore();
    }
    this.drawWeaponBodies(ctx, game, now);
    this.drawTelegraphs(ctx, game);
    for (const enemy of game.enemies) {
      if (this.inView(enemy.x, enemy.y, enemy.radius * 1.2 + 24)) { this.drawEnemy(ctx, enemy, now); this.metrics.enemiesDrawn += 1; }
      else this.metrics.enemiesSkipped += 1;
      const x = enemy.x - ox, y = enemy.y - oy;
      if (x > 28 && x < w - 28 && y > 56 && y < h - 40) continue;
      if (!isInsideWorld(enemy.x, enemy.y)) continue;
      const dx = enemy.x - p.x, dy = enemy.y - p.y;
      const sector = Math.floor((Math.atan2(dy, dx) + Math.PI) / TAU * this.threats.length) % this.threats.length;
      const threat = this.threats[sector], distance = dx * dx + dy * dy;
      if (distance < threat.distance) { threat.enemy = enemy; threat.distance = distance; }
    }
    let particlesDrawn = 0;
    for (let i = game.particles.length - 1; i >= 0 && particlesDrawn < settings.particleLimit; i -= 1) {
      const particle = game.particles[i];
      if (!this.inView(particle.x, particle.y, particle.radius)) continue;
      ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife); ctx.fillStyle = particle.color;
      ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.radius, 0, TAU); ctx.fill(); particlesDrawn += 1;
    }
    ctx.globalAlpha = 1;
    this.drawWorldBorder(ctx, WORLD);
    this.drawPlayer(ctx, p, now);
    ctx.restore();
    this.drawBoundaryWarning(ctx, p, w, h, now);
    if (game.elapsed < game.tidePulseUntil) {
      ctx.save(); ctx.strokeStyle = `rgba(227,162,194,${0.25 + Math.sin(now * 7) * 0.12})`; ctx.lineWidth = 10;
      ctx.strokeRect(3, 3, w - 6, h - 6); ctx.restore();
    }
    for (const threat of this.threats) {
      const enemy = threat.enemy;
      if (!enemy) continue;
      const x = enemy.x - ox, y = enemy.y - oy, angle = Math.atan2(enemy.y - p.y, enemy.x - p.x);
      const ex = Math.max(20, Math.min(w - 20, x)), ey = Math.max(48, Math.min(h - 26, y));
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(angle); ctx.fillStyle = enemy.boss ? "rgba(255,109,140,.9)" : "rgba(244,112,145,.65)";
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.restore();
      this.metrics.threatsDrawn += 1;
    }
  }

  drawAltars(ctx, game, now) {
    for (const altar of game.altars || []) {
      if (!this.inView(altar.x, altar.y, altar.radius + 30)) continue;
      const ready = altar.cooldown <= 0, progress = altar.progress / 2;
      ctx.save(); ctx.translate(altar.x, altar.y);
      ctx.strokeStyle = ready ? "rgba(216,184,255,.72)" : "rgba(112,101,123,.35)"; ctx.lineWidth = 2;
      ctx.shadowBlur = this.quality.settings.glow && ready ? 18 : 0; ctx.shadowColor = "#c99cff";
      ctx.beginPath(); ctx.arc(0, 0, 28, 0, TAU); ctx.stroke();
      ctx.rotate(Math.PI / 4); ctx.strokeRect(-15, -15, 30, 30); ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = ready ? "#d9bcff" : "#756d7e"; ctx.font = "18px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("✦", 0, 1);
      if (progress > 0) { ctx.strokeStyle = "#f4d89b"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 36, -Math.PI / 2, -Math.PI / 2 + TAU * progress); ctx.stroke(); }
      if (Math.hypot(game.player.x - altar.x, game.player.y - altar.y) < 160) {
        ctx.shadowBlur = 0; ctx.font = "11px sans-serif"; ctx.fillStyle = "#e1d4ee";
        ctx.fillText(altar.name, 0, -48);
        ctx.fillText(ready ? "驻留 2 秒：诅咒 +1 · 宝箱 +1" : `冷却 ${Math.ceil(altar.cooldown)} 秒`, 0, 53);
        if (ready) { ctx.fillStyle = "#f2be94"; ctx.fillText("敌人生命 +10% · 速度 +5% · 回响 +10%", 0, 69); }
      }
      ctx.restore();
    }
  }

  drawZones(ctx, game, now) {
    for (const zone of game.zones || []) {
      if (!this.inView(zone.x, zone.y, zone.radius + 12)) continue;
      ctx.save(); ctx.globalAlpha = Math.min(1, zone.life / Math.min(1, zone.maxLife)) * 0.32; ctx.fillStyle = zone.color;
      ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.radius, 0, TAU); ctx.fill();
      ctx.globalAlpha *= 1.8; ctx.strokeStyle = zone.hostile ? "#ff796f" : zone.color; ctx.lineWidth = zone.hostile ? 3 : 1.5;
      if (zone.hostile) ctx.setLineDash([8, 5]); ctx.stroke(); ctx.restore();
      if (zone.kind === "frost") {
        ctx.save(); ctx.strokeStyle = zone.color; ctx.globalAlpha = 0.5; ctx.translate(zone.x, zone.y);
        for (let i = 0; i < 6; i += 1) { const a = i / 6 * TAU + now * 0.15; ctx.beginPath(); ctx.moveTo(Math.cos(a) * zone.radius * .4, Math.sin(a) * zone.radius * .4); ctx.lineTo(Math.cos(a) * zone.radius * .9, Math.sin(a) * zone.radius * .9); ctx.stroke(); }
        ctx.restore();
      }
    }
  }

  drawEffects(ctx, game, now) {
    for (const effect of game.effects || []) {
      if (effect.delayed > 0 && effect.kind !== "starfall" && effect.kind !== "prison") continue;
      if (effect.radius < 500 && !this.inView(effect.x, effect.y, effect.radius)) continue;
      const fade = Math.max(0, effect.life / effect.maxLife);
      ctx.save(); ctx.globalAlpha = fade * 0.45; ctx.strokeStyle = effect.color; ctx.lineWidth = 3;
      ctx.shadowBlur = this.quality.settings.glow ? 18 : 0; ctx.shadowColor = effect.color;
      if (effect.kind === "chain") {
        ctx.beginPath(); effect.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
      } else if (effect.kind === "starfall") {
        ctx.translate(effect.x, effect.y);
        ctx.globalAlpha = effect.delayed > 0 ? .3 : fade;
        ctx.beginPath(); ctx.arc(0, 0, effect.radius, 0, TAU); ctx.stroke();
        const fall = effect.delayed > 0 ? -effect.delayed * 180 : 0;
        ctx.beginPath(); ctx.moveTo(0, fall - 20); ctx.lineTo(8, fall); ctx.lineTo(0, fall + 12); ctx.lineTo(-8, fall); ctx.closePath(); ctx.stroke();
      } else if (["crown", "frost", "prison", "bloom", "bladePulse"].includes(effect.kind)) {
        const points = effect.kind === "bloom" ? 12 : effect.kind === "crown" ? 16 : 6;
        const radius = effect.radius * (1 - fade * .2);
        ctx.translate(effect.x, effect.y); ctx.rotate(effect.kind === "bloom" ? now * .3 : 0);
        if (effect.delayed > 0) { ctx.globalAlpha = .25; ctx.setLineDash([6, 5]); }
        ctx.beginPath();
        for (let i = 0; i <= points; i += 1) {
          const a = i / points * TAU, r = radius * (effect.kind === "crown" && i % 2 ? .7 : 1);
          if (i) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.stroke();
        if (effect.kind === "frost" || effect.kind === "bloom") for (let i = 0; i < 6; i += 1) { const a = i / 6 * TAU; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius); ctx.stroke(); }
      } else {
        ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * (1 - fade * 0.25), 0, TAU); ctx.stroke();
      }
      ctx.restore(); this.metrics.effectsDrawn += 1;
    }
  }

  drawWeaponBodies(ctx, game, now) {
    for (const blade of game.orbitBlades || []) {
      if (!this.inView(blade.x, blade.y, 20)) continue;
      ctx.save(); ctx.translate(blade.x, blade.y); ctx.rotate(blade.angle);
      ctx.fillStyle = blade.color || "#e7dbff"; ctx.shadowBlur = this.quality.settings.glow ? 16 : 0; ctx.shadowColor = blade.color || WEAPONS.orbitBlade.color;
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 4, 0, 0, TAU); ctx.fill(); ctx.restore();
    }
  }

  drawPickup(ctx, pickup, now) {
    ctx.save(); ctx.translate(pickup.x, pickup.y);
    const pulse = 1 + Math.sin(now * 4 + (pickup.phase || 0)) * 0.08;
    ctx.scale(pulse, pulse); ctx.fillStyle = "#111018"; ctx.strokeStyle = PICKUP_TYPES[pickup.type]?.color || "#e8d7ff"; ctx.lineWidth = 2;
    ctx.shadowBlur = this.quality.settings.glow ? 15 : 0; ctx.shadowColor = ctx.strokeStyle;
    if (pickup.type === "chest") { ctx.fillRect(-10, -8, 20, 15); ctx.strokeRect(-10, -8, 20, 15); ctx.fillStyle = "#ffd77a"; ctx.fillRect(-2, -4, 4, 7); }
    else { ctx.beginPath(); ctx.arc(0, 0, pickup.radius, 0, TAU); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#efdfff"; ctx.font = "11px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(pickup.type === "heart" ? "♥" : pickup.type === "magnet" ? "◎" : pickup.type === "holy" ? "✧" : "✹", 0, 0); }
    ctx.restore();
  }

  updateFootsteps(game) {
    const p = game.player, now = game.elapsed;
    if (this.trackedPlayer !== p || now < this.lastStepTime) {
      this.trackedPlayer = p; this.footsteps.length = 0; this.stepDistance = 0; this.stepSide = 1;
      this.lastStepX = p.x; this.lastStepY = p.y;
    }
    this.footsteps = this.footsteps.filter(step => now - step.born < 1.8);
    const dx = p.x - this.lastStepX, dy = p.y - this.lastStepY, distance = Math.hypot(dx, dy);
    if (game.state === "playing" && now > this.lastStepTime && distance > 0 && distance < 120) {
      let next = 26 - this.stepDistance;
      while (next <= distance) {
        const along = next / distance, side = this.stepSide * 5;
        this.footsteps.push({ x: this.lastStepX + dx * along - dy / distance * side, y: this.lastStepY + dy * along + dx / distance * side, angle: Math.atan2(dy, dx), born: now });
        this.stepSide *= -1; next += 26;
      }
      this.stepDistance = (this.stepDistance + distance) % 26;
    } else if (distance >= 120) this.stepDistance = 0;
    this.lastStepX = p.x; this.lastStepY = p.y; this.lastStepTime = now;
  }

  drawFootsteps(ctx, now) {
    ctx.save(); ctx.beginPath(); ctx.rect(-WORLD.width / 2, -WORLD.height / 2, WORLD.width, WORLD.height); ctx.clip();
    for (const step of this.footsteps) {
      const age = now - step.born, fade = Math.max(0, 1 - age / 1.8);
      ctx.save(); ctx.translate(step.x, step.y); ctx.rotate(step.angle); ctx.fillStyle = `rgba(166,151,133,${fade * .25})`;
      ctx.beginPath(); ctx.ellipse(-4, 0, 4.5, 2, 0, 0, TAU); ctx.fill(); ctx.restore();
    }
    ctx.restore();
  }

  drawPlayer(ctx, p, now) {
    ctx.save(); ctx.translate(p.x, p.y);
    const pulse = 1 + Math.sin(now * 4.5) * 0.035;
    ctx.shadowBlur = p.invulnerable ? 30 : 22; ctx.shadowColor = p.invulnerable ? "#fff3ce" : "#bb93ff";
    ctx.fillStyle = "rgba(174,133,244,.13)"; ctx.beginPath(); ctx.arc(0, 0, 31 * pulse, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = p.invulnerable ? "#fff2d0" : "#f4e9ff"; ctx.beginPath(); ctx.arc(0, 0, p.radius * pulse, 0, TAU); ctx.fill();
    ctx.fillStyle = "#604b84"; ctx.beginPath(); ctx.arc(4, -1, 4, 0, TAU); ctx.fill();
    if (p.shieldTime > 0 && p.shield > 0) { ctx.strokeStyle = "#f1e4a8"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, p.radius + 14, 0, TAU); ctx.stroke(); }
    ctx.save(); ctx.rotate(p.facing); ctx.shadowBlur = 12; ctx.shadowColor = "#c6a5ff"; ctx.fillStyle = "#c6a5ff";
    ctx.beginPath(); ctx.moveTo(23, 0); ctx.lineTo(11, -7); ctx.lineTo(13, 0); ctx.lineTo(11, 7); ctx.closePath(); ctx.fill(); ctx.restore(); ctx.restore();
  }

  drawWorldBorder(ctx, world) {
    const left = -world.width / 2, top = -world.height / 2, right = -left, bottom = -top, view = this.view;
    const visibleLeft = left >= view.left - 24 && left <= view.right + 24, visibleRight = right >= view.left - 24 && right <= view.right + 24;
    const visibleTop = top >= view.top - 24 && top <= view.bottom + 24, visibleBottom = bottom >= view.top - 24 && bottom <= view.bottom + 24;
    if (!visibleLeft && !visibleRight && !visibleTop && !visibleBottom) return;
    const trace = inset => {
      const y1 = Math.max(top + inset, view.top - 24), y2 = Math.min(bottom - inset, view.bottom + 24);
      const x1 = Math.max(left + inset, view.left - 24), x2 = Math.min(right - inset, view.right + 24);
      ctx.beginPath();
      if (visibleLeft) { ctx.moveTo(left + inset, y1); ctx.lineTo(left + inset, y2); }
      if (visibleRight) { ctx.moveTo(right - inset, y1); ctx.lineTo(right - inset, y2); }
      if (visibleTop) { ctx.moveTo(x1, top + inset); ctx.lineTo(x2, top + inset); }
      if (visibleBottom) { ctx.moveTo(x1, bottom - inset); ctx.lineTo(x2, bottom - inset); }
      ctx.stroke();
    };
    ctx.save(); ctx.strokeStyle = "rgba(157,118,224,.22)"; ctx.lineWidth = 12; ctx.shadowBlur = this.quality.settings.glow ? 24 : 0; ctx.shadowColor = "rgba(132,92,211,.7)"; trace(0);
    ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(222,194,255,.82)"; ctx.lineWidth = 2; trace(0); ctx.strokeStyle = "rgba(118,87,176,.28)"; ctx.lineWidth = 1; trace(7); ctx.restore();
  }

  drawBoundaryWarning(ctx, player, w, h, now) {
    const distanceX = WORLD.width / 2 - Math.abs(player.x), distanceY = WORLD.height / 2 - Math.abs(player.y);
    const strength = Math.max(0, 1 - Math.min(distanceX, distanceY) / 150); if (strength <= 0) return;
    ctx.save(); ctx.globalAlpha = strength * (0.45 + Math.sin(now * 5) * 0.18); ctx.fillStyle = this.boundaryGradient; ctx.fillRect(0, 0, w, h); ctx.restore();
  }

  drawEnemy(ctx, enemy, now) {
    const pulse = 1 + Math.sin(now * (enemy.type === "runner" ? 8 : 3) + enemy.x * 0.1) * 0.055;
    ctx.save(); ctx.translate(enemy.x, enemy.y); ctx.scale(pulse, 1 / pulse);
    const sprite = this.sprites.enemy(enemy, this.quality.settings.glow); ctx.drawImage(sprite.canvas, -sprite.size / 2, -sprite.size / 2, sprite.size, sprite.size);
    if (enemy.elite) { ctx.strokeStyle = "#ffe19a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 7, 0, TAU); ctx.stroke(); }
    if (enemy.slowUntil > this.lastElapsed) { ctx.strokeStyle = "#9ed7ff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 3, 0, TAU); ctx.stroke(); }
    if (enemy.behavior === "charge" && enemy.state === "windup") { ctx.strokeStyle = "#ffb17b"; ctx.globalAlpha = .7; ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 12, 0, TAU); ctx.stroke(); }
    if (enemy.behavior === "bomb" && enemy.fuse > 0) { ctx.strokeStyle = "#f5df73"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 16, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - enemy.fuse / .75)); ctx.stroke(); }
    if (enemy.hp < enemy.maxHp && !enemy.boss) {
      const width = enemy.radius * 2.1; ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(-width / 2, -enemy.radius - 8, width, 3);
      ctx.fillStyle = "#e77b9c"; ctx.fillRect(-width / 2, -enemy.radius - 8, width * Math.max(0, enemy.hp / enemy.maxHp), 3);
    }
    ctx.restore();
  }

  drawTelegraphs(ctx, game) {
    for (const enemy of game.enemies) {
      if (enemy.state !== "windup" || !Number.isFinite(enemy.dashX)) continue;
      const reach = enemy.boss ? 340 : 85;
      const x = enemy.x + enemy.dashX * reach, y = enemy.y + enemy.dashY * reach;
      if (!this.inView((enemy.x + x) / 2, (enemy.y + y) / 2, reach / 2 + enemy.radius)) continue;
      ctx.save(); ctx.strokeStyle = enemy.boss ? "#ff88a0" : "#ffb17b"; ctx.globalAlpha = 0.25 + (1 - enemy.stateClock / 0.7) * 0.35;
      ctx.lineWidth = enemy.radius * 2; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(enemy.x, enemy.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.lineWidth = 2; ctx.setLineDash([10, 7]); ctx.stroke(); ctx.restore();
    }
  }

  drawProjectile(ctx, shot) {
    const trail = shot.trail || [];
    const first = Math.max(0, trail.length - this.quality.settings.trailPoints);
    for (let i = first; i < trail.length; i += 1) {
      const point = trail[i]; ctx.globalAlpha = (i + 1) / (trail.length + 2) * 0.38; ctx.fillStyle = shot.kind === "boomerang" ? "#f6bed5" : "#ffd9ad";
      ctx.beginPath(); ctx.arc(point.x, point.y, shot.radius * (i + 1) / (trail.length + 1), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (shot.kind === "boomerang") { ctx.fillStyle = "#f6bed5"; ctx.shadowBlur = this.quality.settings.glow ? 12 : 0; ctx.shadowColor = "#f6bed5"; ctx.beginPath(); ctx.arc(shot.x, shot.y, shot.radius, 0, TAU); ctx.fill(); ctx.shadowBlur = 0; }
    else if (shot.kind === "lance") {
      ctx.save(); ctx.translate(shot.x, shot.y); ctx.rotate(Math.atan2(shot.vy, shot.vx));
      ctx.fillStyle = shot.color || "#f6e59d"; ctx.beginPath(); ctx.moveTo(shot.radius * 2.4, 0); ctx.lineTo(-shot.radius, -shot.radius * .6); ctx.lineTo(-shot.radius * .3, 0); ctx.lineTo(-shot.radius, shot.radius * .6); ctx.closePath(); ctx.fill(); ctx.restore();
    } else { const sprite = this.sprites.projectile(this.quality.settings.glow), size = sprite.size * shot.radius / 5; ctx.drawImage(sprite.canvas, shot.x - size / 2, shot.y - size / 2, size, size); }
  }

  drawGem(ctx, gem, now) {
    ctx.save(); ctx.translate(gem.x, gem.y); ctx.rotate(Math.PI / 4 + Math.sin(now + gem.phase) * 0.15);
    const sprite = this.sprites.gem(gem.color, this.quality.settings.glow), size = sprite.size * gem.radius / 8 * (.72 + Math.sin(gem.phase) * .08);
    ctx.drawImage(sprite.canvas, -size / 2, -size / 2, size, size); ctx.restore();
  }
}
