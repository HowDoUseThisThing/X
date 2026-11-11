import { WORLD, getCameraCenter, isInsideWorld } from "../game/world.js";
import { TerrainRenderer } from "./terrain.js";

const TAU = Math.PI * 2;

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.terrain = new TerrainRenderer();
    this.footsteps = [];
    this.trackedPlayer = null;
    this.stepDistance = 0;
    this.stepSide = 1;
    this.stars = Array.from({ length: 130 }, (_, i) => ({
      x: Math.sin(i * 127.1) * 10000 % 1,
      y: Math.sin(i * 311.7 + 8) * 10000 % 1,
      size: 0.5 + (i * 17 % 10) / 10,
      alpha: 0.1 + (i * 13 % 30) / 100,
    }));
    this.resize();
    window.addEventListener("resize", () => this.resize(), { passive: true });
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(game, now = 0) {
    const ctx = this.context;
    const w = this.width, h = this.height;
    const p = game.player;
    this.updateFootsteps(game);
    const camera = getCameraCenter(p.x, p.y, w, h);
    const ox = camera.x - w / 2, oy = camera.y - h / 2;
    const vignette = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, Math.max(w, h) * 0.78);
    vignette.addColorStop(0, "#191722");
    vignette.addColorStop(0.56, "#11111a");
    vignette.addColorStop(1, "#090a11");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    const shake = game.shake * 7;
    ctx.translate(-ox + Math.sin(now * 79) * shake, -oy + Math.cos(now * 71) * shake);
    this.terrain.draw(ctx, ox, oy, w, h);

    for (const star of this.stars) {
      const x = ((star.x * 10400 - ox * 0.24) % (w + 80) + w + 80) % (w + 80) - 40 + ox;
      const y = ((star.y * 10400 - oy * 0.24) % (h + 80) + h + 80) % (h + 80) - 40 + oy;
      ctx.fillStyle = `rgba(196,183,226,${star.alpha * (0.2 + Math.sin(now * 1.4 + x) * 0.06)})`;
      ctx.beginPath(); ctx.arc(x, y, star.size, 0, TAU); ctx.fill();
    }

    this.drawFootsteps(ctx, game.elapsed);
    for (const gem of game.gems) this.drawGem(ctx, gem, now);
    for (const shot of game.projectiles) this.drawProjectile(ctx, shot);
    for (const enemy of game.enemies) this.drawEnemy(ctx, enemy, now);
    for (const particle of game.particles) {
      ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      ctx.fillStyle = particle.color;
      ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.radius, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.drawWorldBorder(ctx, WORLD);
    this.drawPlayer(ctx, p, now);
    ctx.restore();

    this.drawBoundaryWarning(ctx, p, w, h, now);

    // Edge-of-screen threat cues keep off-screen pursuers readable without clutter.
    for (const enemy of game.enemies) {
      const x = enemy.x - ox, y = enemy.y - oy;
      if (x > 28 && x < w - 28 && y > 56 && y < h - 40) continue;
      if (!isInsideWorld(enemy.x, enemy.y, 0)) continue;
      const angle = Math.atan2(y - h / 2, x - w / 2);
      const ex = Math.max(20, Math.min(w - 20, x)), ey = Math.max(48, Math.min(h - 26, y));
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(angle);
      ctx.fillStyle = "rgba(244,112,145,.65)";
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  updateFootsteps(game) {
    const p = game.player, now = game.elapsed;
    if (this.trackedPlayer !== p || now < this.lastStepTime) {
      this.trackedPlayer = p;
      this.footsteps.length = 0;
      this.stepDistance = 0;
      this.stepSide = 1;
      this.lastStepX = p.x; this.lastStepY = p.y;
    }
    this.footsteps = this.footsteps.filter(step => now - step.born < 1.8);
    const dx = p.x - this.lastStepX, dy = p.y - this.lastStepY;
    const distance = Math.hypot(dx, dy);
    if (game.state === "playing" && now > this.lastStepTime && distance > 0 && distance < 120) {
      let next = 26 - this.stepDistance;
      while (next <= distance) {
        const along = next / distance, side = this.stepSide * 5;
        this.footsteps.push({
          x: this.lastStepX + dx * along - dy / distance * side,
          y: this.lastStepY + dy * along + dx / distance * side,
          angle: Math.atan2(dy, dx), born: now,
        });
        this.stepSide *= -1;
        next += 26;
      }
      this.stepDistance = (this.stepDistance + distance) % 26;
    } else if (distance >= 120) this.stepDistance = 0;
    this.lastStepX = p.x; this.lastStepY = p.y; this.lastStepTime = now;
  }

  drawFootsteps(ctx, now) {
    ctx.save();
    ctx.beginPath(); ctx.rect(-WORLD.width / 2, -WORLD.height / 2, WORLD.width, WORLD.height); ctx.clip();
    for (const step of this.footsteps) {
      const age = now - step.born, fade = Math.max(0, 1 - age / 1.8);
      ctx.save(); ctx.translate(step.x, step.y); ctx.rotate(step.angle);
      ctx.fillStyle = `rgba(166,151,133,${fade * .25})`;
      ctx.beginPath(); ctx.ellipse(-4, 0, 4.5, 2, 0, 0, TAU); ctx.fill();
      if (age < .45) {
        ctx.fillStyle = `rgba(193,178,157,${(1 - age / .45) * .22})`;
        ctx.beginPath(); ctx.arc(-7 - age * 10, -3 - age * 5, 1.5 + age * 3, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(-9 - age * 6, 3 + age * 4, 1 + age * 2, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  drawPlayer(ctx, p, now) {
    ctx.save(); ctx.translate(p.x, p.y);
    const pulse = 1 + Math.sin(now * 4.5) * 0.035;
    ctx.shadowBlur = p.invulnerable ? 30 : 22;
    ctx.shadowColor = p.invulnerable ? "#fff3ce" : "#bb93ff";
    ctx.fillStyle = "rgba(174,133,244,.13)";
    ctx.beginPath(); ctx.arc(0, 0, 31 * pulse, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = p.invulnerable ? "#fff2d0" : "#f4e9ff";
    ctx.beginPath(); ctx.arc(0, 0, p.radius * pulse, 0, TAU); ctx.fill();
    ctx.fillStyle = "#604b84";
    ctx.beginPath(); ctx.arc(4, -1, 4, 0, TAU); ctx.fill();

    ctx.save();
    ctx.rotate(p.facing);
    ctx.shadowBlur = 12;
    ctx.shadowColor = "#c6a5ff";
    ctx.fillStyle = "#c6a5ff";
    ctx.beginPath();
    ctx.moveTo(23, 0);
    ctx.lineTo(11, -7);
    ctx.lineTo(13, 0);
    ctx.lineTo(11, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  drawWorldBorder(ctx, world) {
    const left = -world.width / 2, top = -world.height / 2;
    ctx.save();
    ctx.strokeStyle = "rgba(157, 118, 224, .22)";
    ctx.lineWidth = 12;
    ctx.shadowBlur = 24;
    ctx.shadowColor = "rgba(132, 92, 211, .7)";
    ctx.strokeRect(left, top, world.width, world.height);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(222, 194, 255, .82)";
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, world.width, world.height);
    ctx.strokeStyle = "rgba(118, 87, 176, .28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 7, top + 7, world.width - 14, world.height - 14);
    ctx.restore();
  }

  drawBoundaryWarning(ctx, player, w, h, now) {
    const threshold = 150;
    const distanceX = WORLD.width / 2 - Math.abs(player.x);
    const distanceY = WORLD.height / 2 - Math.abs(player.y);
    const strength = Math.max(0, 1 - Math.min(distanceX, distanceY) / threshold);
    if (strength <= 0) return;
    const pulse = 0.45 + Math.sin(now * 5) * 0.18;
    const gradient = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
    gradient.addColorStop(0, "rgba(123, 83, 188, 0)");
    gradient.addColorStop(1, "rgba(151, 101, 226, " + strength * pulse + ")");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  drawEnemy(ctx, enemy, now) {
    const pulse = 1 + Math.sin(now * (enemy.type === "runner" ? 8 : 3) + enemy.x * 0.1) * 0.055;
    ctx.save(); ctx.translate(enemy.x, enemy.y); ctx.scale(pulse, 1 / pulse);
    const gradient = ctx.createRadialGradient(-enemy.radius * 0.3, -enemy.radius * 0.4, 1, 0, 0, enemy.radius * 1.65);
    gradient.addColorStop(0, enemy.hitFlash ? "#fff" : enemy.color);
    gradient.addColorStop(1, "rgba(19,17,29,.86)");
    ctx.fillStyle = gradient;
    ctx.shadowBlur = 14; ctx.shadowColor = enemy.color;
    ctx.beginPath();
    const points = enemy.type === "wraith" ? 7 : 8;
    for (let i = 0; i < points; i += 1) {
      const r = enemy.radius * (i % 2 ? 0.78 : 1.12);
      const a = i / points * TAU + (enemy.type === "brute" ? 0.12 : 0);
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(13,11,22,.72)";
    ctx.beginPath(); ctx.arc(-3, -1, 2.1, 0, TAU); ctx.arc(4, -1, 2.1, 0, TAU); ctx.fill();
    if (enemy.hp < enemy.maxHp) {
      const width = enemy.radius * 2.1;
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(-width / 2, -enemy.radius - 8, width, 3);
      ctx.fillStyle = "#e77b9c"; ctx.fillRect(-width / 2, -enemy.radius - 8, width * Math.max(0, enemy.hp / enemy.maxHp), 3);
    }
    ctx.restore();
  }

  drawProjectile(ctx, shot) {
    for (let i = 0; i < shot.trail.length; i += 1) {
      const point = shot.trail[i];
      ctx.globalAlpha = (i + 1) / (shot.trail.length + 2) * 0.38;
      ctx.fillStyle = "#ffd9ad";
      ctx.beginPath(); ctx.arc(point.x, point.y, shot.radius * (i + 1) / (shot.trail.length + 1), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff1d8"; ctx.shadowBlur = 17; ctx.shadowColor = "#ffbc85";
    ctx.beginPath(); ctx.arc(shot.x, shot.y, shot.radius, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
  }

  drawGem(ctx, gem, now) {
    ctx.save(); ctx.translate(gem.x, gem.y); ctx.rotate(Math.PI / 4 + Math.sin(now + gem.phase) * 0.15);
    ctx.shadowBlur = 15; ctx.shadowColor = gem.color; ctx.fillStyle = gem.color;
    const size = gem.radius * (0.72 + Math.sin(gem.phase) * 0.08);
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.fillStyle = "rgba(255,255,255,.76)"; ctx.fillRect(-size / 2, -size / 2, size * 0.34, size * 0.34);
    ctx.restore();
  }
}
