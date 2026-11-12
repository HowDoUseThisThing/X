import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchTestBrowser } from "./browser-launch.mjs";

const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ["scripts/serve.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
const executablePath = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
let session;
const errors = [], checked = [];
try {
  await Promise.race([once(server.stdout, "data"), once(server, "exit").then(() => { throw Error("Static server exited"); })]);
  const files = ["index.html"];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path); else files.push(path);
    }
  }
  await visit("src"); await visit("assets");
  for (const path of files) {
    const source = createHash("sha256").update(await readFile(path)).digest("hex");
    const packaged = createHash("sha256").update(await readFile(`output/release/${path}`)).digest("hex");
    assert.equal(packaged, source, `Outdated packaged file: ${path}`);
  }
  checked.push(`${files.length} runtime files match source SHA-256`);
  session = await launchTestBrowser(executablePath);
  const page = await session.browser.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/output/release/index.html`, { waitUntil: "networkidle0" });
  await page.click("#start");
  if (await page.$("#tutorial-screen.is-visible")) await page.click("#tutorial-close");
  await page.waitForFunction(() => window.__MOON_SURVIVOR__?.game.state === "playing");
  assert.equal(await page.$eval("#mobile-controls", element => element.classList.contains("active")), true);
  await page.evaluate(() => { const game = window.__MOON_SURVIVOR__.game; game.player.xp = game.player.xpNext; game.checkLevelUp(); });
  await page.waitForSelector("#level-screen.is-visible");
  assert.equal(await page.$$eval("#upgrade-list .upgrade-option", elements => elements.length), 3);
  await mkdir("output/screenshots", { recursive: true });
  await page.screenshot({ path: "output/screenshots/packaged-portrait-upgrade.png" });
  await page.click("#upgrade-list .upgrade-option");
  await page.waitForFunction(() => window.__MOON_SURVIVOR__.game.state === "playing");
  checked.push("packaged portrait start/tutorial/three-card selection");
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  await page.waitForFunction(() => window.__MOON_SURVIVOR__.renderer.width === 844 && window.__MOON_SURVIVOR__.renderer.height === 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "output/screenshots/packaged-landscape-game.png" });
  await page.click("#pause"); await page.waitForSelector("#pause-screen.is-visible");
  await page.click("#pause-meta"); await page.waitForSelector("#meta-screen.is-visible");
  await page.click("#meta-close"); await page.click("#evacuate");
  await page.waitForSelector("#result-screen.is-visible");
  const profile = await page.evaluate(() => window.__MOON_SURVIVOR__.getProfile());
  assert.equal(profile.stats.runs, 1); assert.ok(profile.echoes > 0);
  await page.screenshot({ path: "output/screenshots/packaged-landscape-result.png" });
  await page.reload({ waitUntil: "networkidle0" });
  assert.equal(await page.evaluate(() => window.__MOON_SURVIVOR__.game.state), "title");
  assert.deepEqual(await page.evaluate(() => window.__MOON_SURVIVOR__.getProfile()), profile);
  checked.push("rotation/landscape pause/meta/evacuation/refresh persistence");
  assert.deepEqual(errors, []);
  const report = { passed: true, date: new Date().toISOString(), browser: await session.browser.version(), launchMode: session.mode, checked, errors };
  await writeFile("output/release-validation.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { try { if (session) await session.close(); } finally { server.kill(); } }
