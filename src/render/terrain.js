import { mulberry32 } from "../core/math.js";
import { WORLD } from "../game/world.js";

const TAU = Math.PI * 2;

// Bake scenery once with its own seed: moving the camera never rearranges the
// ground, and decoration cannot change the gameplay random sequence.
export class TerrainRenderer {
  constructor(world = WORLD) {
    this.world = world;
    this.canvas = document.createElement("canvas");
    this.canvas.width = world.width;
    this.canvas.height = world.height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    const random = mulberry32(0x72a4d19);
    const range = (min, max) => min + random() * (max - min);
    const halfW = world.width / 2, halfH = world.height / 2;

    ctx.fillStyle = "#191b21";
    ctx.fillRect(0, 0, world.width, world.height);
    ctx.translate(halfW, halfH);

    for (let i = 0; i < 100; i += 1) {
      const x = range(-halfW, halfW), y = range(-halfH, halfH);
      const radius = range(90, 290);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, range(0.45, 0.85));
      const wash = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      wash.addColorStop(0, ["rgba(74,67,65,.23)", "rgba(47,67,60,.28)", "rgba(64,53,76,.25)"][i % 3]);
      wash.addColorStop(1, "rgba(25,27,33,0)");
      ctx.fillStyle = wash;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }

    const roads = [
      [[-1600, 720], [-1210, 570], [-820, 450], [-470, 200], [-150, 80], [160, -80], [510, -180], [870, -390], [1260, -470], [1600, -650]],
      [[-1100, -1100], [-800, -760], [-490, -430], [-250, -180], [-150, 80], [20, 360], [310, 650], [680, 1100]],
    ];
    for (const points of roads) this.paintRoad(ctx, points, range);

    // Small, irregular marks provide nearby motion references between landmarks.
    for (let i = 0; i < 19000; i += 1) {
      const x = range(-halfW, halfW), y = range(-halfH, halfH);
      ctx.fillStyle = i % 3 ? "rgba(125,121,116,.075)" : "rgba(5,9,12,.2)";
      ctx.fillRect(x, y, range(0.7, 2.5), range(0.6, 1.7));
    }
    for (let i = 0; i < 620; i += 1) {
      const x = range(-halfW, halfW), y = range(-halfH, halfH);
      const length = range(10, 34), angle = range(0, TAU);
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      ctx.strokeStyle = "rgba(7,10,14,.48)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-length / 2, -2); ctx.lineTo(-3, 1);
      ctx.lineTo(4, -1); ctx.lineTo(length / 2, 3); ctx.stroke();
      ctx.strokeStyle = "rgba(133,124,129,.11)";
      ctx.beginPath(); ctx.moveTo(-length / 2, -1); ctx.lineTo(-3, 2); ctx.lineTo(4, 0); ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i < 850; i += 1) {
      this.paintGrass(ctx, range(-halfW + 22, halfW - 22), range(-halfH + 22, halfH - 22), range, false);
    }
    for (let i = 0; i < 330; i += 1) {
      this.paintRock(ctx, range(-halfW + 30, halfW - 30), range(-halfH + 30, halfH - 30), range(3, 10), range);
    }

    const rockGroups = [[-260, 170], [260, -200], [330, 265], [-610, -170], [620, 470], [-980, 350], [1030, -700], [-1220, -810], [1260, 760], [-560, 870]];
    for (const [x, y] of rockGroups) {
      for (let i = 0; i < 5; i += 1) this.paintRock(ctx, x + range(-32, 32), y + range(-18, 18), range(7, 22), range);
      this.paintGrass(ctx, x - 26, y + 19, range, false);
    }

    this.paintRuin(ctx, -350, -190, 68, range);
    this.paintRuin(ctx, 740, -450, 91, range);
    this.paintRuin(ctx, -1060, 650, 58, range);
    for (const [x, y, height] of [[-450, -275, 58], [-255, -245, 35], [640, -505, 63], [830, -455, 39], [1090, 610, 74], [-1040, -740, 44], [340, 760, 49]]) {
      this.paintPillar(ctx, x, y, height);
    }
    for (const [x, y, size, flip] of [[410, 100, 1, 1], [-510, 340, .83, -1], [1050, 80, 1.18, 1], [-870, -540, 1.1, -1], [130, -760, .92, 1], [-1300, 80, .95, 1], [850, 850, .82, -1]]) {
      this.paintTree(ctx, x, y, size, flip);
    }
    for (let i = 0; i < 48; i += 1) {
      this.paintGrass(ctx, range(-halfW + 40, halfW - 40), range(-halfH + 40, halfH - 40), range, true);
    }
  }

  draw(ctx, left, top, width, height) {
    const halfW = this.world.width / 2, halfH = this.world.height / 2;
    const x = Math.max(-halfW, left - 10), y = Math.max(-halfH, top - 10);
    const w = Math.min(halfW, left + width + 10) - x;
    const h = Math.min(halfH, top + height + 10) - y;
    if (w <= 0 || h <= 0) return;
    ctx.drawImage(this.canvas, x + halfW, y + halfH, w, h, x, y, w, h);
  }

  paintRoad(ctx, points, range) {
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(...points[0]);
    for (let i = 1; i < points.length - 1; i += 1) {
      const next = points[i + 1];
      ctx.quadraticCurveTo(...points[i], (points[i][0] + next[0]) / 2, (points[i][1] + next[1]) / 2);
    }
    ctx.lineTo(...points[points.length - 1]);
    ctx.strokeStyle = "rgba(9,12,17,.24)"; ctx.lineWidth = 100; ctx.stroke();
    ctx.strokeStyle = "rgba(86,76,71,.19)"; ctx.lineWidth = 82; ctx.stroke();
    ctx.strokeStyle = "rgba(91,83,78,.12)"; ctx.lineWidth = 55; ctx.stroke();
    ctx.restore();

    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const [ax, ay] = points[segment], [bx, by] = points[segment + 1];
      const length = Math.hypot(bx - ax, by - ay), angle = Math.atan2(by - ay, bx - ax);
      for (let d = 18; d < length; d += range(36, 52)) {
        for (const lane of [-1, 1]) {
          if (range(0, 1) < .19) continue;
          const offset = lane * range(12, 21);
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
