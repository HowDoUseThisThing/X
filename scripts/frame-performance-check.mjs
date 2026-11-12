import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { launchTestBrowser } from "./browser-launch.mjs";

const baseline = new Map();
for (const path of ["src/core/math.js", "src/game/game.js", "src/game/world.js", "src/game/spatial-grid.js", "src/render/canvas.js", "src/render/quality.js", "src/render/sprites.js", "src/render/terrain.js"]) baseline.set(path, execFileSync("git", ["show", `9dbeb1b:${path}`], { encoding: "utf8" }));
const root = resolve(".");
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") { response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><style>body{margin:0}canvas{width:1440px;height:900px}</style><canvas id="world"></canvas>'); return; }
  const [mode, ...parts] = path.slice(1).split("/");
  const relative = parts.join("/"), target = resolve(root, relative);
  if (!target.startsWith(root + sep) || !relative.startsWith("src/") || !relative.endsWith(".js")) { response.writeHead(404).end(); return; }
  try {
    const code = mode === "baseline" ? baseline.get(relative) : mode === "current" ? await readFile(target, "utf8") : null;
    if (code == null) throw Error("Unknown module");
    response.writeHead(200, { "content-type": "text/javascript" }).end(code);
  } catch { response.writeHead(404).end(); }
});
const executablePath = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
assert.ok(executablePath, "Set CHROME_PATH");
let browser, browserSession;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browserSession = await launchTestBrowser(executablePath); browser = browserSession.browser;
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 }); await page.goto(origin);
  const results = await page.evaluate(async () => {
    const { SurvivorGame: Current } = await import("/current/src/game/game.js");
    const { SurvivorGame: Baseline } = await import("/baseline/src/game/game.js");
    const { CanvasRenderer: CurrentRenderer } = await import("/current/src/render/canvas.js");
    const { CanvasRenderer: BaselineRenderer } = await import("/baseline/src/render/canvas.js");
    const canvas = document.querySelector("canvas");
    function sample(Game, Renderer, expanded) {
      const game = new Game(42); game.start(); game.particleLimit = 120;
      if (expanded) {
        for (const id of ["orbitBlade", "tideNova", "chainSpark"]) game.applyChoice({ type: "weapon", target: id });
        for (const weapon of game.activeWeapons) { weapon.level = 5; weapon.evolved = true; }
        game.recalculateStats();
      }
      Object.assign(game.player, { health: 1e9, maxHealth: 1e9, invulnerable: 1e9, projectileCount: 4, pierce: 2, fireInterval: .2 });
      game.spawnClock = -1e9;
      game.enemies = Array.from({ length: 600 }, (_, i) => ({ id: `fixture-${i}`, type: "shade", behavior: "chase", x: (i % 30 - 14.5) * 46, y: (Math.floor(i / 30) - 9.5) * 42, radius: 12, hp: 1e12, maxHp: 1e12, damage: 0, xp: 1, speed: 0, color: "#fff", hitFlash: 0, contactClock: 0 }));
      const renderer = new Renderer(canvas);
      // Disable adaptive quality so both snapshots render the same desktop quality.
      renderer.quality.level = 0; renderer.resize();
      const frame = i => {
        game.update(1 / 60, {}, { width: 1440, height: 900 }); renderer.draw(game, i / 60);
        renderer.context.getImageData(0, 0, 1, 1); // Flush drawing work before timing the next frame.
      };
      for (let i = 0; i < 60; i++) frame(i);
      const started = performance.now();
      for (let i = 60; i < 240; i++) frame(i);
      return (performance.now() - started) / 180;
    }
    sample(Baseline, BaselineRenderer, false); sample(Current, CurrentRenderer, true);
    const baseline = [], expanded = [];
    for (let run = 0; run < 5; run++) {
      if (run % 2) { expanded.push(sample(Current, CurrentRenderer, true)); baseline.push(sample(Baseline, BaselineRenderer, false)); }
      else { baseline.push(sample(Baseline, BaselineRenderer, false)); expanded.push(sample(Current, CurrentRenderer, true)); }
    }
    return { baseline, expanded, userAgent: navigator.userAgent };
  });
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const baselineMs = median(results.baseline), expandedMs = median(results.expanded), ratio = expandedMs / baselineMs;
  const report = { date: new Date().toISOString(), baselineCommit: "9dbeb1b", fixture: "600 visible stationary durable enemies at 1440x900; four-arrow volley baseline versus four evolved weapons; update + Canvas draw + readback flush; quality fixed at desktop high; 120 particles; five alternating 180-frame samples", ...results, baselineMs, expandedMs, ratio, within25Percent: ratio <= 1.25, limitations: "Controlled headless desktop browser. Includes canvas readback overhead and excludes DOM HUD/audio, vsync and physical mobile hardware." };
  await mkdir("output", { recursive: true }); await writeFile("output/frame-performance-validation.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.within25Percent, `Frame time exceeded baseline +25% (${ratio.toFixed(2)}x)`);
} finally { try { if (browserSession) await browserSession.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
