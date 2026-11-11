const TAU = Math.PI * 2;

export class SpriteCache {
  constructor() {
    this.images = new Map();
  }

  get(key, size, paint) {
    if (this.images.has(key)) return this.images.get(key);
    const canvas = document.createElement("canvas");
    // Small cached sprites stay sharp at every supported canvas resolution.
    canvas.width = canvas.height = Math.ceil(size * 2);
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.translate(size / 2, size / 2);
    paint(ctx);
    const sprite = { canvas, size };
    if (this.images.size >= 96) this.images.delete(this.images.keys().next().value);
    this.images.set(key, sprite);
    return sprite;
  }

  enemy(enemy, glow) {
    const radius = enemy.radius, hit = enemy.hitFlash > 0;
    const key = `enemy:${enemy.type}:${radius}:${enemy.color}:${hit}:${glow}`;
    return this.get(key, Math.ceil(radius * 2.4 + 48), ctx => {
      const gradient = ctx.createRadialGradient(-radius * .3, -radius * .4, 1, 0, 0, radius * 1.65);
      gradient.addColorStop(0, hit ? "#fff" : enemy.color);
      gradient.addColorStop(1, "rgba(19,17,29,.86)");
      ctx.fillStyle = gradient;
      if (glow) { ctx.shadowBlur = 14; ctx.shadowColor = enemy.color; }
      const points = enemy.type === "wraith" ? 7 : 8;
      ctx.beginPath();
      for (let i = 0; i < points; i += 1) {
        const r = radius * (i % 2 ? .78 : 1.12);
        const angle = i / points * TAU + (enemy.type === "brute" ? .12 : 0);
        if (i === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
      ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(13,11,22,.72)";
      ctx.beginPath(); ctx.arc(-3, -1, 2.1, 0, TAU); ctx.arc(4, -1, 2.1, 0, TAU); ctx.fill();
    });
  }

  gem(color, glow) {
    return this.get(`gem:${color}:${glow}`, 48, ctx => {
      ctx.fillStyle = color;
      if (glow) { ctx.shadowBlur = 15; ctx.shadowColor = color; }
      ctx.fillRect(-4, -4, 8, 8);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,.76)"; ctx.fillRect(-4, -4, 8 * .34, 8 * .34);
    });
  }

  projectile(glow) {
    return this.get(`projectile:${glow}`, 52, ctx => {
      ctx.fillStyle = "#fff1d8";
      if (glow) { ctx.shadowBlur = 17; ctx.shadowColor = "#ffbc85"; }
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    });
  }
}
