import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash } from "node:crypto";
import { launchTestBrowser } from "./browser-launch.mjs";
import { WEAPONS, CHARACTERS } from "../src/game/content.js";
import { defaultSave, SAVE_KEY } from "../src/game/progression.js";

const root = resolve(".");
const output = resolve(root, "output", "expansion-browser", `${Date.now()}`);
const executablePath = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
assert.ok(executablePath, "Set CHROME_PATH to an installed Chromium browser");
const report = { passed: false, executablePath, recipes: [], maps: [], runtimeErrors: [], output };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const target = resolve(root, path === "/" ? "index.html" : `.${decodeURIComponent(path)}`);
  if (!target.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try { response.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream" }).end(await readFile(target)); }
  catch { response.writeHead(404).end(); }
});
let session;
try {
  await mkdir(output, { recursive: true });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  session = await launchTestBrowser(executablePath);
  const page = await session.browser.newPage();
  page.on("pageerror", error => report.runtimeErrors.push(error.message));
  const save = defaultSave(); save.preferences.tutorialSeen = true; save.preferences.sound = false;
  for (const id of Object.keys(CHARACTERS)) save.unlocked[id] = true;
  await page.evaluateOnNewDocument((key, save) => localStorage.setItem(key, JSON.stringify(save)), SAVE_KEY, save);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__MOON_SURVIVOR__);
  for (const [weapon, definition] of Object.entries(WEAPONS)) for (const [passive, recipe] of Object.entries(definition.evolutions)) {
    const prepared = await page.evaluate(async ({ weapon, passive, recipe }) => {
      const { WEAPONS } = await import("/src/game/content.js");
      const { game: g, ui } = window.__MOON_SURVIVOR__;
      ui.hideAll(); g.reset(12); g.state = "playing";
      g.spawnClock = -1e6; g.nextWave = g.nextElite = g.nextBoss = 1e9;
      let owned = g.activeWeapons.find(item => item.id === weapon);
      if (!owned) { g.applyChoice({ type: "weapon", target: weapon }); owned = g.activeWeapons.find(item => item.id === weapon); }
      while (owned.level < 5) g.applyChoice({ type: "weapon", target: weapon });
      for (const id of WEAPONS[weapon].passives) for (let i = 0; i < 3; i++) g.applyChoice({ type: "passive", target: id });
      const before = JSON.stringify(g.build.passives);
      g.openChest(); ui.showChest(g);
      return { before, index: g.chestChoices.findIndex(item => item.evolutionId === recipe.id), branches: g.chestChoices.filter(item => item.target === weapon && item.type === "evolve").length };
    }, { weapon, passive, recipe });
    assert.equal(prepared.branches, 2);
    assert.ok(prepared.index >= 0);
    await page.locator(`#chest-screen .upgrade-option:nth-child(${prepared.index + 1})`).click();
    const result = await page.evaluate(({ weapon, recipe, before }) => {
      const { game: g, renderer, ui } = window.__MOON_SURVIVOR__;
      const owned = g.activeWeapons.find(item => item.id === weapon);
      const selected = owned.evolutionId;
      if (JSON.stringify(g.build.passives) !== before) throw Error("Consumed passive");
      // Observe every branch through real update, collision and Canvas rendering.
      g.player.invulnerable = 1e6;
      for (let i = 0; i < 120; i++) {
        const e = g.spawnEnemy({ width: 1440, height: 900 }, "brute", { x: (i % 12 - 5.5) * 55, y: (Math.floor(i / 12) - 4.5) * 50 });
        e.hp = e.maxHp = 1e7; e.speed = 0;
      }
      for (let i = 0; i < 360; i++) { g.update(1 / 60, {}, { width: 1440, height: 900 }); renderer.draw(g, i / 60); }
      const dealtDamage = g.enemies.some(enemy => enemy.hp < 1e7);
      g.pause(); ui.renderBuildHud(g); ui.renderPause(); ui.show("pause");
      return { selected, dealtDamage, hud: document.querySelector(`[data-weapon="${weapon}"]`).textContent, pause: document.querySelector("#pause-build").textContent };
    }, { weapon, recipe, before: prepared.before });
    assert.equal(result.selected, recipe.id);
    assert.ok(result.dealtDamage, recipe.id);
    assert.ok(result.hud.includes(recipe.name));
    assert.ok(result.pause.includes(recipe.desc));
    await page.screenshot({ path: resolve(output, `${recipe.id}.png`) });
    report.recipes.push({ id: recipe.id, passed: true, ...result });
  }
  // Recreate a seed after evicting the terrain bake, checking real pixels as well as metadata.
  const hashes = new Map();
  for (const seed of [7, 8, 9, 7]) {
    const data = await page.evaluate(seed => {
      const { game: g, renderer, ui } = window.__MOON_SURVIVOR__;
      g.reset(seed); ui.hideAll(); renderer.draw(g, 0);
      return { seed: g.map.seed, themes: g.map.themes, pixels: renderer.terrain.canvas.toDataURL("image/png") };
    }, seed);
    const bytes = Buffer.from(data.pixels.split(",")[1], "base64"), hash = createHash("sha256").update(bytes).digest("hex");
    if (hashes.has(seed)) assert.equal(hash, hashes.get(seed), "same seed must redraw the same terrain pixels");
    else { hashes.set(seed, hash); await writeFile(resolve(output, `map-${seed}.png`), bytes); }
    report.maps.push({ seed, themes: data.themes, hash });
  }
  assert.equal(new Set(hashes.values()).size, 3);
  report.browser = await session.browser.version();
  assert.deepEqual(report.runtimeErrors, []);
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await writeFile(resolve(root, "output", "expansion-browser-validation.json"), JSON.stringify(report, null, 2));
  await writeFile(resolve(output, "validation.json"), JSON.stringify(report, null, 2));
  if (session) await session.close();
  await new Promise(done => server.close(done));
}
console.log(JSON.stringify({ passed: report.passed, recipes: report.recipes.length, maps: report.maps.length, runtimeErrors: report.runtimeErrors, error: report.error, output }, null, 2));
