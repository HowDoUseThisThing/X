import { mulberry32 } from "../core/math.js";
import { MAP_THEMES, WORLD, generateMap } from "../game/world.js";

const TAU = Math.PI * 2;
// Retain only the latest bake (~28 MB), so repeated construction for one seed is cheap.
let latestBake;

// Bake scenery once with its own seed: moving the camera never rearranges the
// ground, and decoration cannot change the gameplay random sequence.
export class TerrainRenderer {
  constructor(world = WORLD, map = generateMap(1)) {
    this.world = world;
    this.map = map;
    const cacheKey = JSON.stringify([world.width, world.height, map]);
    if (latestBake?.key === cacheKey) {
      this.canvas = latestBake.canvas;
      return;
    }
    this.canvas = document.createElement("canvas");
    this.canvas.width = world.width;
    this.canvas.height = world.height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    const random = mulberry32(map.seed ^ 0x72a4d19);
    const range = (min, max) => min + random() * (max - min);
    const halfW = world.width / 2, halfH = world.height / 2;
    ctx.fillStyle = MAP_THEMES[map.themes[0]]?.ground || "#191b21";
    ctx.fillRect(0, 0, world.width, world.height);
    ctx.translate(halfW, halfH);

    for (const region of map.regions) {
      const theme = MAP_THEMES[region.theme];
      const local = mulberry32(region.seed);
      const localRange = (min, max) => min + local() * (max - min);
      ctx.save();
      ctx.beginPath(); ctx.rect(region.x, region.y, region.width, region.height); ctx.clip();
      ctx.fillStyle = theme.ground;
      ctx.fillRect(region.x, region.y, region.width, region.height);
      for (let i = 0; i < 35; i += 1) {
        const x = localRange(region.x, region.x + region.width);
        const y = localRange(region.y, region.y + region.height), radius = localRange(80, 260);
        const wash = ctx.createRadialGradient(x, y, 0, x, y, radius);
        wash.addColorStop(0, theme.wash[i % theme.wash.length]);
        wash.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = wash; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      ctx.restore();
    }
    // Fine ground grain is flat and intentionally subtle even in clearings.
    for (let i = 0; i < 19000; i += 1) {
      ctx.fillStyle = i % 3 ? "rgba(125,121,116,.075)" : "rgba(5,9,12,.2)";
      ctx.fillRect(range(-halfW, halfW), range(-halfH, halfH), range(.7, 2.5), range(.6, 1.7));
    }
    for (const road of map.roads) this.paintRoad(ctx, road.points, range, road.width);
    // Flat paving identifies the clear altar approach without obscuring the live altar UI.
    for (const altar of map.altars) {
      ctx.fillStyle = "rgba(72,70,77,.22)";
      ctx.beginPath(); ctx.arc(altar.x, altar.y, 100, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(168,158,175,.20)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(altar.x, altar.y, 88, 0, TAU); ctx.stroke();
    }
    for (const item of [...map.landmarks, ...map.decorations].sort((a, b) => a.y - b.y)) {
      this.paintLandscape(ctx, item);
    }
    latestBake = { key: cacheKey, canvas: this.canvas };
  }

  draw(ctx, left, top, width, height) {
    const halfW = this.world.width / 2, halfH = this.world.height / 2;
    const x = Math.max(-halfW, left - 10), y = Math.max(-halfH, top - 10);
    const w = Math.min(halfW, left + width + 10) - x;
    const h = Math.min(halfH, top + height + 10) - y;
    if (w <= 0 || h <= 0) return;
    ctx.drawImage(this.canvas, x + halfW, y + halfH, w, h, x, y, w, h);
  }

  paintRoad(ctx, points, range, width = 76) {
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(...points[0]);
    // Match the generated polyline exactly so road clearance also matches the pixels.
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.strokeStyle = "rgba(9,12,17,.24)"; ctx.lineWidth = width; ctx.stroke();
    ctx.strokeStyle = "rgba(86,76,71,.25)"; ctx.lineWidth = width * .82; ctx.stroke();
    ctx.strokeStyle = "rgba(91,83,78,.18)"; ctx.lineWidth = width * .55; ctx.stroke();
    ctx.restore();

    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const [ax, ay] = points[segment], [bx, by] = points[segment + 1];
      const length = Math.hypot(bx - ax, by - ay), angle = Math.atan2(by - ay, bx - ax);
      for (let d = 18; d < length; d += range(36, 52)) {
        for (const lane of [-1, 1]) {
          if (range(0, 1) < .19) continue;
          const offset = lane * range(9, width * .2);
          const x = ax + (bx - ax) * d / length - Math.sin(angle) * offset;
          const y = ay + (by - ay) * d / length + Math.cos(angle) * offset;
          ctx.save(); ctx.translate(x, y); ctx.rotate(angle + range(-.18, .18));
          const w = range(20, 33), h = range(13, 21);
          ctx.beginPath(); ctx.moveTo(-w / 2 + 3, -h / 2); ctx.lineTo(w / 2, -h / 2 + 2);
          ctx.lineTo(w / 2 - 2, h / 2); ctx.lineTo(-w / 2, h / 2 - 2); ctx.closePath();
          ctx.fillStyle = ["#36363b", "#303238", "#3c393d"][Math.floor(range(0, 3))];
          ctx.fill(); ctx.strokeStyle = "rgba(120,112,116,.25)"; ctx.lineWidth = .8; ctx.stroke();
          ctx.strokeStyle = "rgba(11,15,20,.55)";
          ctx.beginPath(); ctx.moveTo(-w / 2 + 3, h / 2); ctx.lineTo(w / 2 - 2, h / 2); ctx.stroke();
          if (range(0, 1) > .65) {
            ctx.beginPath(); ctx.moveTo(-3, -h / 2); ctx.lineTo(1, 1); ctx.lineTo(-3, h / 2); ctx.stroke();
          }
          ctx.restore();
        }
      }
    }
  }

  paintLandscape(ctx, item) {
    const random = mulberry32(item.seed);
    const range = (min, max) => min + random() * (max - min);
    const { x, y, radius: r, kind } = item;
    if (kind === "ruin") return this.paintRuin(ctx, x, y, r * .5, range);
    if (kind === "pillar") return this.paintPillar(ctx, x, y, r * .65);
    if (kind === "tree") return this.paintTree(ctx, x, y, r / 125, item.rotation < 0 ? -1 : 1);
    if (kind === "rock") return this.paintRock(ctx, x, y, r * .6, range);
    if (kind === "rubble" || kind === "rockGroup") {
      for (let i = 0; i < 6; i += 1) {
        this.paintRock(ctx, x + range(-r * .45, r * .45), y + range(-r * .3, r * .3), range(r * .1, r * .28), range);
      }
      return;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(item.rotation * .16);
    if (kind === "puddle") {
      // Irregular shore, still water, ripples and rushes: unmistakably wet ground.
      ctx.beginPath();
      for (let i = 0; i < 13; i += 1) {
        const angle = i / 12 * TAU, size = range(.65, .87) * r;
        const px = Math.cos(angle) * size, py = Math.sin(angle) * size * .56;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fillStyle = "#0c302f"; ctx.fill();
      ctx.strokeStyle = "#42604c"; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = "rgba(114,192,172,.35)"; ctx.lineWidth = 1;
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath(); ctx.ellipse(range(-r * .35, r * .35), range(-r * .18, r * .18), r * range(.12, .26), r * .055, 0, .2, 2.9); ctx.stroke();
      }
      for (let i = 0; i < 7; i += 1) this.paintGrass(ctx, range(-r * .6, r * .6), r * .45, range, true);
    } else if (kind === "grave") {
      ctx.fillStyle = "rgba(8,7,17,.4)";
      ctx.beginPath(); ctx.ellipse(0, r * .25, r * .5, r * .19, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#68616e"; ctx.strokeStyle = "#938499"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-r * .26, r * .2); ctx.lineTo(-r * .26, -r * .35);
      ctx.quadraticCurveTo(0, -r * .85, r * .26, -r * .35);
      ctx.lineTo(r * .26, r * .2); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "#332e41"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -r * .43); ctx.lineTo(0, -r * .05);
      ctx.moveTo(-r * .12, -r * .3); ctx.lineTo(r * .12, -r * .3); ctx.stroke();
      ctx.strokeStyle = "rgba(166,139,181,.2)";
      ctx.strokeRect(-r * .21, r * .3, r * .42, r * .27);
    } else if (kind === "crystal" || kind === "shard") {
      for (let i = 0; i < (kind === "crystal" ? 5 : 2); i += 1) {
        const dx = range(-r * .4, r * .4), dy = range(-r * .1, r * .25);
        const h = range(r * .3, r * .75), w = h * .24;
        ctx.beginPath(); ctx.moveTo(dx - w, dy); ctx.lineTo(dx - w, dy - h * .65);
        ctx.lineTo(dx, dy - h); ctx.lineTo(dx + w, dy - h * .65); ctx.lineTo(dx + w, dy); ctx.closePath();
        ctx.fillStyle = i % 2 ? "#417e9d" : "#679eae"; ctx.fill();
        ctx.strokeStyle = "#a2e0e6"; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx, dy - h); ctx.stroke();
      }
    } else if (kind === "ash" || kind === "cinder") {
      ctx.fillStyle = "#302626";
      ctx.beginPath(); ctx.ellipse(0, 0, r * .85, r * .48, 0, 0, TAU); ctx.fill();
      ctx.lineWidth = kind === "ash" ? 2 : 1;
      for (let i = 0; i < 9; i += 1) {
        const dx = range(-r * .65, r * .65), dy = range(-r * .25, r * .25);
        ctx.strokeStyle = i % 3 ? "#64504a" : "#b96d43";
        ctx.beginPath(); ctx.moveTo(dx - r * .08, dy - r * .08); ctx.lineTo(dx, dy);
        ctx.lineTo(dx - r * .03, dy + r * .1); ctx.stroke();
      }
    } else if (kind === "reeds") {
      for (let i = 0; i < 8; i += 1) {
        const dx = range(-r * .5, r * .5), dy = range(-r * .15, r * .35), h = range(r * .3, r * .6);
        ctx.strokeStyle = "#66886a"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx + 2, dy - h); ctx.stroke();
        ctx.fillStyle = "#9b9568"; ctx.fillRect(dx, dy - h, 3, h * .22);
      }
    }
    ctx.restore();
  }

  paintGrass(ctx, x, y, range, luminous) {
    ctx.save(); ctx.translate(x, y);
    if (luminous) {
      const glow = ctx.createRadialGradient(0, -4, 0, 0, -4, 20);
      glow.addColorStop(0, "rgba(91,150,125,.12)"); glow.addColorStop(1, "rgba(91,150,125,0)");
      ctx.fillStyle = glow; ctx.fillRect(-20, -24, 40, 40);
    }
    ctx.lineWidth = 1;
    const blades = luminous ? 5 : Math.floor(range(3, 7));
    for (let i = 0; i < blades; i += 1) {
      const dx = range(-9, 9), height = range(4, luminous ? 17 : 13);
      ctx.strokeStyle = luminous ? "rgba(105,155,132,.64)" : ["rgba(101,101,77,.4)", "rgba(82,100,86,.45)", "rgba(114,102,91,.36)"][i % 3];
      ctx.beginPath(); ctx.moveTo(dx * .25, 2); ctx.quadraticCurveTo(dx * .65, -height * .6, dx, -height); ctx.stroke();
      if (luminous) {
        ctx.fillStyle = "rgba(136,175,145,.6)";
        ctx.fillRect(dx - .6, -height - 1, 1.2, 2);
      }
    }
    ctx.restore();
  }

  paintRock(ctx, x, y, size, range) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = "rgba(5,9,12,.32)";
    ctx.beginPath(); ctx.ellipse(3, size * .35, size * 1.2, size * .52, 0, 0, TAU); ctx.fill();
    const vertices = Array.from({ length: 6 }, (_, i) => {
      const angle = i / 6 * TAU, radius = size * range(.75, 1.12);
      return [Math.cos(angle) * radius, Math.sin(angle) * radius * .65];
    });
    ctx.beginPath(); ctx.moveTo(...vertices[0]);
    for (const point of vertices.slice(1)) ctx.lineTo(...point);
    ctx.closePath(); ctx.fillStyle = "#34383e"; ctx.fill();
    ctx.strokeStyle = "rgba(129,130,132,.24)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...vertices[3]); ctx.lineTo(-size * .15, -size * .18); ctx.lineTo(...vertices[5]);
    ctx.lineTo(...vertices[4]); ctx.closePath(); ctx.fillStyle = "rgba(135,133,132,.14)"; ctx.fill();
    ctx.restore();
  }

  paintRuin(ctx, x, y, radius, range) {
    ctx.save(); ctx.translate(x, y);
    const wash = ctx.createRadialGradient(0, 0, 8, 0, 0, radius * 1.5);
    wash.addColorStop(0, "rgba(96,89,112,.14)"); wash.addColorStop(1, "rgba(96,89,112,0)");
    ctx.fillStyle = wash; ctx.fillRect(-radius * 1.5, -radius * 1.5, radius * 3, radius * 3);
    for (let i = 0; i < 15; i += 1) {
      if (i === 3 || i === 4 || i === 10) continue;
      const angle = i / 15 * TAU;
      ctx.beginPath(); ctx.arc(0, 0, radius, angle + .035, angle + .35);
      ctx.arc(0, 0, radius - 15, angle + .35, angle + .035, true); ctx.closePath();
      ctx.fillStyle = i % 3 ? "#424148" : "#363940"; ctx.fill();
      ctx.strokeStyle = "rgba(145,133,148,.3)"; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.strokeStyle = "rgba(118,106,134,.27)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, radius * .57, .2, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-radius * .3, -8); ctx.lineTo(8, -radius * .32);
    ctx.lineTo(radius * .25, 15); ctx.lineTo(-radius * .3, -8); ctx.stroke();
    for (let i = 0; i < 8; i += 1) {
      const angle = range(0, TAU), distance = range(radius - 8, radius + 24);
      this.paintRock(ctx, Math.cos(angle) * distance, Math.sin(angle) * distance, range(4, 9), range);
    }
    this.paintGrass(ctx, -radius * .7, radius * .6, range, true);
    ctx.restore();
  }

  paintPillar(ctx, x, y, height) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = "rgba(6,9,14,.36)";
    ctx.beginPath(); ctx.ellipse(12, 7, 35, 13, .28, 0, TAU); ctx.fill();
    ctx.fillStyle = "#35383f"; ctx.fillRect(-17, -5, 36, 13);
    ctx.strokeStyle = "rgba(128,122,137,.3)"; ctx.strokeRect(-17, -5, 36, 13);
    ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(-11, -height + 4); ctx.lineTo(-2, -height - 2);
    ctx.lineTo(9, -height + 4); ctx.lineTo(11, 0); ctx.closePath();
    ctx.fillStyle = "#4c4b54"; ctx.fill();
    ctx.beginPath(); ctx.moveTo(2, -height + 2); ctx.lineTo(9, -height + 4); ctx.lineTo(11, 0); ctx.lineTo(2, -2); ctx.closePath();
    ctx.fillStyle = "#30343d"; ctx.fill();
    ctx.strokeStyle = "rgba(158,145,165,.34)";
    ctx.beginPath(); ctx.moveTo(-8, -height + 7); ctx.lineTo(-7, -6); ctx.stroke();
    ctx.strokeStyle = "rgba(17,21,29,.7)";
    ctx.beginPath(); ctx.moveTo(-10, -height * .5); ctx.lineTo(-2, -height * .43); ctx.lineTo(-5, -height * .27); ctx.stroke();
    ctx.restore();
  }

  paintTree(ctx, x, y, size, flip) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size * flip, size);
    ctx.fillStyle = "rgba(5,9,14,.27)";
    ctx.beginPath(); ctx.ellipse(12, 5, 46, 13, .12, 0, TAU); ctx.fill();
    const branches = [
      [[-12, 5], [-2, -16], [3, -49], [-5, -83], [2, -104]],
      [[2, -38], [27, -57], [31, -83]],
      [[0, -54], [-26, -66], [-39, -87]],
      [[27, -57], [44, -61], [51, -74]],
      [[-25, -66], [-29, -86]],
      [[1, -16], [15, 5]],
    ];
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let i = 0; i < branches.length; i += 1) {
      ctx.beginPath(); ctx.moveTo(...branches[i][0]);
      for (const point of branches[i].slice(1)) ctx.lineTo(...point);
      ctx.strokeStyle = "#10151a"; ctx.lineWidth = i === 0 ? 11 : i < 3 ? 6 : 3; ctx.stroke();
      ctx.strokeStyle = "#454343"; ctx.lineWidth = i === 0 ? 5 : i < 3 ? 2 : 1; ctx.stroke();
    }
    ctx.restore();
  }
}
