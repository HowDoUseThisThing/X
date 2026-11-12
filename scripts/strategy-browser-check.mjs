import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser } from './browser-launch.mjs';
import { defaultSave, SAVE_KEY, calcEchoes } from '../src/game/progression.js';
import { ACHIEVEMENTS, CHARACTERS } from '../src/game/content.js';

// Fixtures only arrange game/save state. All choices, purchases, starts and first
// settlements travel through real browser clicks/keys; touches use the CDP input stack.
const root = fileURLToPath(new URL('..', import.meta.url));
const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const output = resolve(root, 'output', 'strategy-browser', stamp);
const reportPath = resolve(output, 'validation.json');
const caseFilter = process.env.STRATEGY_FILTER || process.env.FILTER || '';
const viewports = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  landscape: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  compact: { width: 640, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
};
const executablePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const report = { passed: false, startedAt: new Date().toISOString(), executablePath,
  output, viewports, selectedFilter: caseFilter || null, cases: [], runtimeErrors: [], sourceHints: {},
  fixturePolicy: 'Only save/world/build/XP arrangement; real clicks/keys for selection and settlement; CDP for both simultaneous touch contacts.',
  scope: 'Functional/UI browser acceptance; no performance benchmark or physical-device certification.' };
let browser, browserSession, server, baseURL;
let serverLog = '';
const delay = ms => new Promise(done => setTimeout(done, ms));
const savedProfile = (echoes = 5000) => {
  const save = defaultSave(); save.echoes = echoes; save.preferences.tutorialSeen = true; return save;
};
const allCharacters = () => { const save = savedProfile(); save.unlocked.warden = true; save.unlocked.oracle = true; return save; };

async function saveReport() {
  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed) && !report.fatal && !report.runtimeErrors.length;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'output', 'strategy-browser-validation.json'), JSON.stringify(report, null, 2));
}

async function sourceHints() {
  for (const [path, pattern] of [
    ['src/ui/ui.js', /onKeyDown\(|startRun\(|openMeta\(|showChest\(|applyRunResult\(|renderBossHud\(/],
    ['src/core/input.js', /keydown|pointerup|pointercancel|onPointerEnd\(|sample\(/],
    ['src/game/game.js', /runId =|finishRun\(|chooseChestUpgrade\(|skipUpgrade\(|describeChoice\(/],
    ['src/ui/style.css', /boss-hud|meta-screen|@media.*height|overlay.*overflow/],
    ['src/main.js', /class .*Store|saveProfile|settledRun/],
  ]) {
    const lines = (await readFile(resolve(root, path), 'utf8')).split(/\r?\n/);
    report.sourceHints[path] = lines.flatMap((text, i) => pattern.test(text) ? [{ line: i + 1, text: text.slice(0, 240) }] : []);
  }
}

async function unusedPort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((done, fail) => probe.close(e => e ? fail(e) : done()));
  return port === 43928 ? unusedPort() : port;
}

async function startServer() {
  const port = process.env.STRATEGY_PORT ? Number(process.env.STRATEGY_PORT) : await unusedPort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && port !== 43928, 'Use a valid strategy port distinct from browser-check (43928)');
  baseURL = `http://127.0.0.1:${port}`; report.baseURL = baseURL;
  server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  let launchError;
  server.on('error', e => { launchError = e; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw Error(`Strategy server exited: ${serverLog}`);
    // Wait for this child to listen before probing; never test another process on a busy port.
    if (serverLog.includes(baseURL)) {
      const response = await fetch(baseURL, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    }
    await delay(40);
  }
  throw Error(`Strategy server startup timed out: ${serverLog}`);
}

async function waitState(page, state) {
  await page.waitForFunction(expected => window.__MOON_SURVIVOR__?.game.state === expected, { timeout: 5000 }, state);
}

async function waitModal(page, selector) {
  await page.waitForFunction(selector => {
    const el = document.querySelector(selector); if (!el) return false;
    const css = getComputedStyle(el);
    return el.classList.contains('is-visible') && !el.classList.contains('hidden') && css.visibility === 'visible' && Number(css.opacity) >= 0.99;
  }, { timeout: 5000 }, selector);
}

async function clickable(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });
  const result = await page.$eval(selector, element => {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = element.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, disabled: element.disabled,
      inViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      hit: hit && (hit === element || element.contains(hit)), blocker: hit?.outerHTML.slice(0, 240) };
  });
  assert.equal(result.inViewport, true, `${selector} is outside viewport: ${JSON.stringify(result)}`);
  assert.ok(result.rect.width >= 43.9 && result.rect.height >= 43.9, `${selector} touch target is smaller than 44px: ${JSON.stringify(result.rect)}`);
  assert.equal(result.disabled, false, `${selector} is disabled`);
  assert.equal(result.hit, true, `${selector} is covered: ${JSON.stringify(result)}`);
}

async function click(page, selector) { await clickable(page, selector); await page.click(selector); }

async function start(page) {
  await click(page, '#start');
  // New profiles deliberately exercise the automatic tutorial pause.
  if (await page.evaluate(() => window.__MOON_SURVIVOR__.ui.tutorialOpen)) {
    await waitModal(page, '#tutorial-screen'); await click(page, '#tutorial-close');
  }
  await waitState(page, 'playing');
  await quietWorld(page);
}

async function quietWorld(page) {
  await page.evaluate(() => {
    const g = window.__MOON_SURVIVOR__.game;
    g.spawnClock = -1000000;
    g.nextElite = g.nextBoss = g.nextWave = g.nextTidePulse = Infinity;
    g.player.invulnerable = 1000000;
    g.enemies = []; g.boss = null; g.gems = []; g.pickups = []; g.enemyProjectiles = [];
    g.projectiles = []; g.effects = []; g.zones = [];
  });
}

async function level(page) {
  assert.equal(await page.evaluate(() => {
    const g = window.__MOON_SURVIVOR__.game; g.player.xp = g.player.xpNext; return g.checkLevelUp();
  }), true, 'XP fixture should naturally enter levelup');
  await waitModal(page, '#level-screen');
}

async function buildFixture(page, evolution = false) {
  await page.evaluate(evolution => {
    const g = window.__MOON_SURVIVOR__.game;
    g.build = { weapons: [
      { id: 'moonArrow', level: evolution ? 5 : 2, evolved: false },
      { id: 'orbitBlade', level: 2, evolved: false },
      { id: 'tideNova', level: 2, evolved: false },
    ], passives: { might: evolution ? 3 : 1, area: 1, tempo: 1 } };
    g.recalculateStats(false);
  }, evolution);
}

async function chest(page) {
  await page.evaluate(() => {
    const g = window.__MOON_SURVIVOR__.game;
    g.pickups.push({ id: 'acceptance-chest', type: 'chest', x: g.player.x, y: g.player.y, radius: 16, phase: 0 });
  });
  await waitState(page, 'chest'); await waitModal(page, '#chest-screen');
}

async function state(page) {
  return page.evaluate(() => {
    const { game: g, ui, input, getProfile } = window.__MOON_SURVIVOR__;
    return { state: g.state, elapsed: g.elapsed, x: g.player.x, y: g.player.y,
      level: g.player.level, xp: g.player.xp, xpNext: g.player.xpNext,
      build: g.build, rerolls: g.rerollsRemaining, skips: g.skipsRemaining,
      chests: g.chestsOpened, evolutions: g.evolutions, summary: g.summary,
      profile: getProfile(), uiProfile: ui.profile, metaOpen: ui.metaOpen, tutorialOpen: ui.tutorialOpen,
      input: { pointerId: input.pointerId, dashPressed: input.dashPressed, touchVector: input.touchVector },
      overlays: [...document.querySelectorAll('.overlay.is-visible')].map(el => el.id),
      focus: document.activeElement?.outerHTML.slice(0, 240) };
  });
}

async function frozen(page) {
  const before = await state(page); await delay(240); const after = await state(page);
  assert.equal(after.elapsed, before.elapsed, 'A modal must stop simulation time');
  assert.equal(after.x, before.x, 'A modal must stop player movement');
  return after;
}

async function describeChoices(page, isChest = false) {
  const result = await page.evaluate(isChest => {
    const g = window.__MOON_SURVIVOR__.game;
    return { choices: isChest ? g.chestChoices : g.upgradeChoices,
      descriptions: (isChest ? g.chestChoices : g.upgradeChoices).map(c => g.describeChoice(c)),
      visible: [...document.querySelectorAll(isChest ? '#chest-screen .upgrade-option' : '#upgrade-list .upgrade-option')].map(el => el.textContent) };
  }, isChest);
  assert.equal(result.choices.length, 3, 'Fixture must offer all three numbered choices');
  assert.equal(new Set(result.choices.map(c => c.id)).size, 3, 'Choices must be distinct');
  for (let i = 0; i < 3; i++) {
    assert.ok(result.descriptions[i]?.length > 8, 'Choice must explain its actual effect');
    assert.ok(result.visible[i].includes(result.descriptions[i]), `Card ${i + 1} must display describeChoice: ${JSON.stringify(result)}`);
  }
  return result;
}

async function auditModal(page, selector) {
  await waitModal(page, selector);
  const metrics = await page.evaluate(selector => {
    const root = document.querySelector(selector);
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const visible = el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().height > 0;
    const inside = r => r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    const critical = [...root.querySelectorAll('h1,h2,.title-actions,.character-picker,.choice-actions,.pause-actions,.result-actions,.meta-tabs,#meta-close,#tutorial-close')].filter(visible).map(el => ({ element: el.id || el.className || el.tagName, rect: rect(el), inside: inside(rect(el)) }));
    const cards = [...root.querySelectorAll('.modal-card,.meta-card,.tutorial-card')].map(el => ({ element: el.className, rect: rect(el), inside: inside(rect(el)) }));
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      rootWidth: root.scrollWidth, rootClientWidth: root.clientWidth, critical, cards,
      buttons: [...root.querySelectorAll('button')].filter(visible).map((el, index) => ({ index, text: el.textContent, disabled: el.disabled })) };
  }, selector);
  assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `Horizontal document overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.rootWidth <= metrics.rootClientWidth + 1, `Modal horizontal overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.cards.every(c => c.inside), `Modal card is clipped: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.critical.every(c => c.inside), `Critical modal element outside viewport: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.buttons.some(b => !b.disabled), `${selector} must have an actionable control`);
  // Scrollable lists are allowed. Each control must become fully visible and pass
  // real hit-testing; clipped content cannot pass merely because scrollWidth is small.
  const handles = await page.$$(`${selector} button`);
  for (const handle of handles) {
    const check = await handle.evaluate(el => {
      const css = getComputedStyle(el); if (css.display === 'none' || css.visibility !== 'visible' || !el.getBoundingClientRect().height) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect(), inset = Math.min(5, r.width / 4, r.height / 4);
      const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + inset, r.top + inset], [r.right - inset, r.bottom - inset]];
      return { text: el.textContent, disabled: el.disabled, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        inside: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        hits: el.disabled ? [] : points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return { ok: hit === el || el.contains(hit), blocker: hit?.id || hit?.className || hit?.tagName }; }) };
    });
    if (check) {
      metrics.buttons.find(b => b.text === check.text).reachability = check;
      assert.ok(check.rect.width >= 43.9 && check.rect.height >= 43.9, `Modal touch target is smaller than 44px: ${JSON.stringify(check)}`);
      assert.equal(check.inside, true, `Modal button cannot fit viewport: ${JSON.stringify(check)}`);
      assert.ok(check.hits.every(h => h.ok), `Modal button is covered/clipped: ${JSON.stringify(check)}`);
    }
    await handle.dispose();
  }
  return metrics;
}

async function rotateAndAudit(page, selector, viewport, item) {
  const initial = await auditModal(page, selector);
  await page.screenshot({ path: resolve(output, `${item.slug}-initial.png`) });
  const rotated = { ...viewport, width: viewport.height, height: viewport.width };
  await page.setViewport(rotated);
  await delay(100);
  const rotation = await auditModal(page, selector);
  await page.screenshot({ path: resolve(output, `${item.slug}-rotated.png`) });
  await page.setViewport(viewport); await delay(100); await auditModal(page, selector);
  return { initial, rotated: rotation };
}

async function run(name, viewportName, steps, check, profile = savedProfile()) {
  if (caseFilter && !name.includes(caseFilter)) return;
  const item = { name, viewport: viewportName, steps, passed: false, startedAt: new Date().toISOString(),
    slug: `${String(report.cases.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` };
  report.cases.push(item);
  let context, page;
  try {
    context = await browser.createBrowserContext(); page = await context.newPage();
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(15000);
    page.on('pageerror', e => { report.runtimeErrors.push({ case: name, message: e.message, stack: e.stack }); });
    page.on('response', response => { if (response.status() >= 400) report.runtimeErrors.push({ case: name, message: `${response.status()} ${response.url()}` }); });
    page.on('console', message => { if (message.type() === 'error') report.runtimeErrors.push({ case: name, message: message.text() }); });
    await page.setViewport(viewports[viewportName]);
    await page.goto(baseURL, { waitUntil: 'networkidle0' });
    await page.evaluate((key, profile) => { localStorage.clear(); localStorage.setItem(key, JSON.stringify(profile)); }, SAVE_KEY, profile);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => Boolean(window.__MOON_SURVIVOR__));
    item.details = await check(page, item);
    assert.ok(!report.runtimeErrors.some(e => e.case === name), 'Browser runtime/network/console errors were recorded');
    item.passed = true;
  } catch (e) {
    item.error = { message: e.message, stack: e.stack, actual: e.actual, expected: e.expected };
    if (page) item.failureState = await state(page).catch(error => ({ unavailable: error.message }));
  } finally {
    item.finishedAt = new Date().toISOString();
    if (page && !page.isClosed()) {
      item.screenshot = resolve(output, `${item.slug}${item.passed ? '' : '-FAILED'}.png`);
      await page.screenshot({ path: item.screenshot }).catch(e => { item.screenshotError = e.message; });
    }
    if (context) await context.close();
    await saveReport();
    console.log(`${item.passed ? 'PASS' : 'FAIL'} ${name}${item.error ? `: ${item.error.message.slice(0, 200)}` : ''}`);
  }
}

async function functionalChecks() {
  await run('first-run-tutorial-and-keyboard', 'desktop', ['Start with a fresh profile', 'Tutorial pauses simulation', 'Close tutorial by click', 'Hold D while the clicked button retains focus'], async page => {
    await click(page, '#start'); await waitModal(page, '#tutorial-screen');
    assert.equal((await state(page)).state, 'paused'); await frozen(page);
    await click(page, '#tutorial-close'); await waitState(page, 'playing'); await quietWorld(page);
    await page.keyboard.down('KeyD');
    try { await page.waitForFunction(() => window.__MOON_SURVIVOR__.game.player.x > 30, { timeout: 3000 }); }
    finally { await page.keyboard.up('KeyD'); }
    const snapshot = await state(page); assert.equal(snapshot.profile.preferences.tutorialSeen, true);
    await page.reload({ waitUntil: 'networkidle0' }); await start(page);
    assert.equal((await state(page)).tutorialOpen, false, 'Tutorial acknowledgement persists after refresh');
    return snapshot;
  }, defaultSave());

  await run('purchase-unlock-character-sound-persistence', 'desktop', ['Open archive', 'Buy life for 120', 'Unlock warden for 400 and oracle for 700', 'Refresh', 'Start selected oracle and mute sound', 'Refresh/start/unmute/refresh'], async page => {
    await click(page, '#open-meta'); await waitModal(page, '#meta-screen'); await click(page, '[data-buy="life"]');
    let s = await state(page); assert.equal(s.profile.meta.life, 1); assert.equal(s.profile.echoes, 4880);
    await click(page, '[data-tab="characters"]');
    await click(page, '[data-character="warden"]'); await click(page, '[data-character="oracle"]');
    s = await state(page); assert.equal(s.profile.echoes, 3780); assert.equal(s.profile.unlocked.warden, true); assert.equal(s.profile.unlocked.oracle, true); assert.equal(s.profile.preferences.character, 'oracle');
    await click(page, '#meta-close'); await page.reload({ waitUntil: 'networkidle0' });
    s = await state(page); assert.equal(s.profile.echoes, 3780); assert.equal(s.profile.meta.life, 1); assert.equal(s.profile.preferences.character, 'oracle');
    assert.equal(await page.$eval('.character-pick.active', el => el.textContent.includes('潮汐秘术师')), true);
    await start(page); await page.waitForFunction(() => window.__MOON_SURVIVOR__.ui.audio.ready);
    await click(page, '#sound'); assert.equal((await state(page)).profile.preferences.sound, false);
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.evaluate(() => window.__MOON_SURVIVOR__.ui.soundOn), false);
    await start(page); assert.equal((await state(page)).profile.preferences.sound, false);
    await click(page, '#sound'); await page.waitForFunction(() => window.__MOON_SURVIVOR__.ui.audio.ready);
    await page.reload({ waitUntil: 'networkidle0' });
    s = await state(page); assert.equal(s.profile.preferences.sound, true); assert.equal(s.profile.preferences.character, 'oracle');
    return s;
  });

  for (const [index, [id, character]] of Object.entries(Object.entries(CHARACTERS))) {
    await run(`real-starting-weapon-${id}`, 'desktop', [`Select ${id} through title picker`, 'Start', 'Place a stationary high-HP target within weapon range', 'Observe normal animation frames dealing damage with the selected weapon'], async page => {
      await click(page, `.character-pick:nth-child(${Number(index) + 1})`); await start(page);
      const initial = await state(page);
      assert.deepEqual(initial.build.weapons, [{ id: character.weapon, level: 1, evolved: false }]);
      await page.evaluate(id => {
        const g = window.__MOON_SURVIVOR__.game;
        g.enemies = [{ id: 'weapon-target', type: 'shade', behavior: 'chase', x: id === 'ranger' ? 120 : 65, y: 0,
          hp: 10000, maxHp: 10000, radius: 22, speed: 0, damage: 0, xp: 0, color: '#fff', contactClock: 0, hitFlash: 0 }];
        g.fireClock = 0; g.weaponClocks[g.character.weapon] = 0;
      }, id);
      await page.waitForFunction(() => window.__MOON_SURVIVOR__.game.enemies[0]?.hp < 10000, { timeout: 3500 });
      const actual = await page.evaluate(() => {
        const g = window.__MOON_SURVIVOR__.game;
        return { hp: g.enemies[0].hp, weapon: g.character.weapon, arrowState: g.arrowState,
          projectileKinds: g.projectiles.map(p => p.kind), blades: g.orbitBlades.length, effects: g.effects.map(e => e.kind) };
      });
      assert.equal(actual.weapon, character.weapon);
      if (id !== 'ranger') { assert.equal(actual.arrowState, null); assert.ok(!actual.projectileKinds.includes('arrow'), 'Non-ranger must not secretly fire starter arrows'); }
      if (id === 'warden') assert.ok(actual.blades >= 2, 'Warden must produce real orbit blades');
      if (id === 'oracle') assert.ok(actual.effects.includes('nova'), 'Oracle must produce real nova effects');
      return actual;
    }, allCharacters());
  }

  await run('meta-paused-isolation', 'desktop', ['Start, P to pause, open archive', 'Press 1/R/S/P/D and Tab while archive is open', 'Close by Escape', 'Resume through pause button'], async page => {
    await start(page); await page.keyboard.press('KeyP'); await waitModal(page, '#pause-screen');
    await click(page, '#pause-meta'); await waitModal(page, '#meta-screen'); const before = await state(page);
    for (const key of ['Digit1', 'KeyR', 'KeyS', 'KeyP']) await page.keyboard.press(key);
    await page.keyboard.down('KeyD'); await frozen(page); await page.keyboard.up('KeyD');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('#meta-screen').contains(document.activeElement)), true, 'Focus must stay in the topmost archive');
    }
    const after = await state(page); assert.equal(after.state, 'paused'); assert.equal(after.metaOpen, true);
    assert.deepEqual(after.build, before.build); assert.equal(after.rerolls, before.rerolls); assert.equal(after.skips, before.skips);
    await page.keyboard.press('Escape'); await waitModal(page, '#pause-screen'); assert.equal((await state(page)).state, 'paused');
    await click(page, '#resume'); await waitState(page, 'playing'); return { before, after };
  });

  await run('reroll-skip-limits-and-descriptions', 'desktop', ['Trigger XP levelup', 'R then click reroll, exhaust charges', 'Skip by click and S, verify exact XP compensation', 'Third skip remains disabled and selection works with 1'], async page => {
    await start(page); await level(page); const first = await describeChoices(page);
    await page.keyboard.press('KeyR'); assert.equal((await state(page)).rerolls, 1); const second = await describeChoices(page);
    assert.notDeepEqual(second.choices.map(c => c.id), first.choices.map(c => c.id), 'Deterministic reroll fixture must replace cards');
    await click(page, '#reroll'); assert.equal((await state(page)).rerolls, 0);
    assert.equal(await page.$eval('#reroll', el => el.disabled), true);
    const exhausted = await describeChoices(page); await page.keyboard.press('KeyR');
    assert.deepEqual((await describeChoices(page)).choices, exhausted.choices);
    for (const [i, action] of ['click', 'key'].entries()) {
      let before = await state(page);
      if (before.state === 'playing') { await level(page); before = await state(page); }
      if (action === 'click') await click(page, '#skip-upgrade'); else await page.keyboard.press('KeyS');
      const after = await state(page); assert.equal(after.skips, 1 - i); assert.deepEqual(after.build, before.build);
      assert.equal(after.xp, before.xp + before.level * 8 - (after.level - before.level) * before.xpNext, 'Skipping must award the documented XP even if it triggers another level');
    }
    if ((await state(page)).state === 'playing') await level(page);
    assert.equal(await page.$eval('#skip-upgrade', el => el.disabled), true);
    const before = await state(page); await page.keyboard.press('KeyS'); const after = await state(page);
    assert.equal(after.state, 'levelup'); assert.equal(after.xp, before.xp); assert.equal(after.skips, 0);
    await page.keyboard.press('Digit1'); await waitState(page, 'playing'); return { first, second, final: await state(page) };
  });

  for (const number of [1, 2, 3]) {
    await run(`chest-key-${number}`, 'desktop', ['Start with three owned weapons/passives fixture', 'Collect chest in normal update', `Press ${number}`, 'Verify precisely that choice changes the build once'], async page => {
      await start(page); await buildFixture(page); await chest(page); const choices = await describeChoices(page, true); await frozen(page);
      const before = await state(page), choice = choices.choices[number - 1];
      assert.ok(['weapon', 'passive', 'evolve'].includes(choice.type));
      assert.ok(!choice.isNew, 'Chest must strengthen an existing build');
      await page.keyboard.press(`Digit${number}`); await waitState(page, 'playing'); const after = await state(page);
      assert.equal(after.chests, before.chests + 1);
      if (choice.type === 'weapon') assert.equal(after.build.weapons.find(w => w.id === choice.target).level, before.build.weapons.find(w => w.id === choice.target).level + 1);
      if (choice.type === 'passive') assert.equal(after.build.passives[choice.target], before.build.passives[choice.target] + 1);
      if (choice.type === 'evolve') assert.equal(after.build.weapons.find(w => w.id === choice.target).evolved, true);
      await page.keyboard.press(`Digit${number}`); assert.deepEqual((await state(page)).build, after.build);
      return { choice, before: before.build, after: after.build };
    });
  }

  await run('evolution-selection-and-real-split', 'desktop', ['Arrange Lv5 arrow + Lv3 might', 'Trigger levelup and inspect actual numeric descriptions', 'Select evolution with 1', 'Observe real evolved arrow splitting on hit'], async page => {
    await start(page); await buildFixture(page, true); await level(page);
    const choices = await describeChoices(page); assert.equal(choices.choices[0].type, 'evolve');
    await page.keyboard.press('Digit1'); await waitState(page, 'playing');
    const evolved = await state(page); assert.equal(evolved.evolutions, 1); assert.equal(evolved.build.weapons.length, 3); assert.equal(evolved.build.weapons[0].evolved, true);
    await page.waitForSelector('#build-hud [data-weapon="moonArrow"].evolved');
    await page.evaluate(() => {
      const g = window.__MOON_SURVIVOR__.game;
      g.enemies = [{ id: 'split-target', type: 'shade', behavior: 'chase', x: 150, y: 0, hp: 10000, maxHp: 10000, radius: 24, speed: 0, damage: 0, xp: 0, color: '#fff', contactClock: 0, hitFlash: 0 }];
      g.fireClock = 0; window.__strategyObservedKinds = [];
      function observe() {
        for (const shot of g.projectiles) if (!window.__strategyObservedKinds.includes(shot.kind)) window.__strategyObservedKinds.push(shot.kind);
        if (g.elapsed < 8) requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    });
    await page.waitForFunction(() => window.__strategyObservedKinds.includes('fragment'), { timeout: 4000 });
    return { choices, evolved, observedKinds: await page.evaluate(() => window.__strategyObservedKinds) };
  });

  await run('evacuation-idempotence-and-refresh-next-run', 'desktop', ['Arrange 500 kills/200s/1 boss/1 evolution', 'P then click evacuate', 'Reopen/close result archive, replay same serialized summary in same instance', 'Refresh, start a new run and evacuate again: runs and echoes must increase'], async page => {
    await start(page);
    await page.evaluate(() => { const g = window.__MOON_SURVIVOR__.game; g.kills = 500; g.elapsed = 200; g.bossKills = 1; g.evolutions = 1; g.chestsOpened = 2; g.player.level = 10; });
    const before = (await state(page)).profile;
    await page.keyboard.press('KeyP'); await waitModal(page, '#pause-screen'); await click(page, '#evacuate'); await waitModal(page, '#result-screen');
    const first = await state(page), summary = first.summary;
    assert.equal(summary.reason, 'evacuated'); assert.equal(summary.died, false); assert.ok(typeof summary.runId === 'string' && summary.runId.length > 0);
    assert.deepEqual([...summary.achievementIds].sort(), ['boss', 'dawn', 'evolution', 'river']);
    const achievementEchoes = summary.achievementIds.reduce((sum, id) => sum + ACHIEVEMENTS[id].reward, 0);
    assert.equal(summary.echoes, calcEchoes({ kills: 500, seconds: summary.seconds, bosses: 1, level: 10, chests: 2, died: false }) + achievementEchoes);
    assert.equal(first.profile.echoes, before.echoes + summary.echoes); assert.equal(first.profile.stats.runs, before.stats.runs + 1);
    await click(page, '#result-meta'); await waitModal(page, '#meta-screen'); await frozen(page);
    for (const key of ['KeyP', 'Digit1', 'KeyR', 'KeyS']) await page.keyboard.press(key);
    assert.equal((await state(page)).state, 'gameover');
    await click(page, '[data-buy="life"]'); const afterPurchase = (await state(page)).profile;
    await click(page, '#meta-close'); await waitModal(page, '#result-screen');
    // Re-display a cloned summary after ordinary save operations in the SAME page.
    // This is an adversarial UI fixture, not another user settlement.
    await page.evaluate(summary => {
      const { game, ui } = window.__MOON_SURVIVOR__;
      game.summary = JSON.parse(JSON.stringify(summary)); ui.showResult(game); ui.showResult(game);
    }, summary);
    assert.deepEqual((await state(page)).profile, afterPurchase, 'Duplicate result rendering must not grant rewards twice');
    await page.reload({ waitUntil: 'networkidle0' });
    assert.deepEqual((await state(page)).profile, afterPurchase, 'All settlement/purchase state must survive refresh');
    await start(page); await page.evaluate(() => { const g = window.__MOON_SURVIVOR__.game; g.kills = 10; g.elapsed = 20; });
    await page.keyboard.press('KeyP'); await click(page, '#evacuate'); await waitModal(page, '#result-screen');
    const second = await state(page);
    assert.notEqual(second.summary.runId, summary.runId, 'A refreshed page must not reuse seed:sequence run IDs');
    assert.equal(second.profile.stats.runs, afterPurchase.stats.runs + 1, 'A new run after refresh must settle normally');
    assert.equal(second.profile.echoes, afterPurchase.echoes + second.summary.echoes);
    assert.equal(second.summary.achievementEchoes, 0, 'Previously earned achievements must not grant another reward');
    return { firstSummary: summary, afterPurchase, secondSummary: second.summary, final: second.profile };
  }, savedProfile(0));
}

async function layoutChecks() {
  const scenes = ['title', 'tutorial', 'meta', 'characters', 'achievements', 'pause', 'pause-meta', 'level', 'chest', 'result', 'result-meta'];
  for (const viewportName of Object.keys(viewports)) {
    for (const scene of scenes) {
      await run(`layout-${viewportName}-${scene}`, viewportName, [`Open ${scene} at ${viewports[viewportName].width}x${viewports[viewportName].height}`, 'Inspect critical elements and every reachable button with real hit-testing', 'Rotate the same open modal, inspect again, rotate back', 'Complete/close the modal with a real UI action'], async (page, item) => {
        let selector;
        if (scene === 'title') selector = '#title-screen';
        else if (scene === 'tutorial') { await click(page, '#open-help'); selector = '#tutorial-screen'; }
        else if (['meta', 'characters', 'achievements'].includes(scene)) {
          await click(page, '#open-meta'); await waitModal(page, '#meta-screen');
          if (scene !== 'meta') await click(page, `[data-tab="${scene}"]`);
          selector = '#meta-screen';
        } else {
          await start(page); await buildFixture(page, scene === 'level');
          if (['pause', 'pause-meta', 'result', 'result-meta'].includes(scene)) {
            await page.keyboard.press('KeyP'); await waitModal(page, '#pause-screen');
            if (scene.startsWith('result')) { await click(page, '#evacuate'); await waitModal(page, '#result-screen'); }
            selector = scene.startsWith('result') ? '#result-screen' : '#pause-screen';
            if (scene.endsWith('-meta')) { await click(page, scene === 'pause-meta' ? '#pause-meta' : '#result-meta'); selector = '#meta-screen'; }
          } else if (scene === 'level') { await level(page); selector = '#level-screen'; }
          else { await chest(page); selector = '#chest-screen'; }
        }
        const metrics = await rotateAndAudit(page, selector, viewports[viewportName], item);
        await frozen(page);
        if (selector === '#meta-screen') { await click(page, '#meta-close'); await waitModal(page, scene === 'pause-meta' ? '#pause-screen' : scene === 'result-meta' ? '#result-screen' : '#title-screen'); }
        else if (scene === 'tutorial') { await click(page, '#tutorial-close'); await waitModal(page, '#title-screen'); }
        else if (scene === 'title') await start(page);
        else if (scene === 'pause') { await click(page, '#resume'); await waitState(page, 'playing'); }
        else if (scene === 'result') { await click(page, '#restart'); await waitState(page, 'playing'); }
        else { await click(page, `${selector} .upgrade-option`); await waitState(page, 'playing'); }
        return metrics;
      }, allCharacters());
    }

    await run(`boss-hud-${viewportName}`, viewportName, ['Start with full four weapons/four passives and curse', 'Spawn boss using real spawnBoss', 'Verify boss bar fits viewport and has no intersection with player/status/build/event/touch HUD', 'Rotate and recheck'], async (page, item) => {
      await start(page);
      await page.evaluate(() => {
        const { game: g } = window.__MOON_SURVIVOR__;
        g.build = { weapons: ['moonArrow', 'orbitBlade', 'tideNova', 'chainSpark'].map(id => ({ id, level: 5, evolved: true })), passives: { might: 5, tempo: 5, area: 5, vitality: 5 } };
        g.curse = 4; g.recalculateStats(false); g.spawnBoss({ width: innerWidth, height: innerHeight });
        g.toastEvent = { text: '首领降临 · 潮汐合围', at: 99 };
      });
      async function inspect() {
        await page.waitForSelector('#boss-hud:not(.hidden)'); await delay(80);
        const result = await page.evaluate(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const boss = rect(document.querySelector('#boss-hud'));
          const hud = [...document.querySelectorAll('.brand,.hud-right,.meters,.wave-tag,#build-hud,#event-hud.show,.footer-hint,#mobile-controls.active #stick-zone,#mobile-controls.active #dash')]
            .filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0)
            .map(el => ({ element: el.id || el.className, rect: rect(el) }));
          const overlaps = hud.filter(({ rect: r }) => Math.min(boss.right, r.right) - Math.max(boss.x, r.x) > 1 && Math.min(boss.bottom, r.bottom) - Math.max(boss.y, r.y) > 1);
          return { boss, hud, overlaps, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
        });
        assert.ok(result.documentWidth <= result.viewport.width + 1, 'Boss view has horizontal overflow');
        assert.ok(result.boss.x >= 0 && result.boss.y >= 0 && result.boss.right <= result.viewport.width + 1 && result.boss.bottom <= result.viewport.height + 1, `Boss bar must fit viewport: ${JSON.stringify(result)}`);
        assert.deepEqual(result.overlaps, [], `Boss bar overlaps HUD: ${JSON.stringify(result)}`);
        return result;
      }
      const initial = await inspect(); await page.screenshot({ path: resolve(output, `${item.slug}-initial.png`) });
      const v = viewports[viewportName]; await page.setViewport({ ...v, width: v.height, height: v.width });
      const rotated = await inspect(); return { initial, rotated };
    });
  }
}

async function touchChecks() {
  for (const viewportName of ['phone', 'landscape', 'compact']) {
    await run(`cdp-multitouch-${viewportName}`, viewportName, ['Native CDP touch: joystick finger 11 moves right', 'Add dash finger 22', 'Release dash finger while joystick keeps moving', 'Add dash finger then release joystick while dash stays held', 'Release all fingers and verify both states clear'], async (page, item) => {
      await start(page); await clickable(page, '#dash');
      const client = await page.createCDPSession();
      await page.evaluate(() => {
        window.__strategyPointerEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'touchstart', 'touchend', 'touchcancel']) {
          document.addEventListener(type, event => {
            window.__strategyPointerEvents.push({ type, trusted: event.isTrusted, pointerId: event.pointerId,
              target: event.target.closest?.('#stick-zone,#dash')?.id || event.target.id || event.target.tagName,
              touches: event.touches ? [...event.touches].map(t => t.identifier) : undefined,
              changedTouches: event.changedTouches ? [...event.changedTouches].map(t => t.identifier) : undefined });
          }, { capture: true, passive: true });
        }
      });
      const points = await page.evaluate(() => {
        const r = document.querySelector('#stick-zone').getBoundingClientRect(), d = document.querySelector('#dash').getBoundingClientRect();
        return { stick: { id: 11, x: r.left + r.width * 0.8, y: r.top + r.height / 2, radiusX: 4, radiusY: 4 },
          dash: { id: 22, x: d.left + d.width / 2, y: d.top + d.height / 2, radiusX: 4, radiusY: 4 } };
      });
      const events = [];
      item.details = { points, events, protocolMode: 'changed-touch-points' };
      async function touch(type, touchPoints, step) {
        await client.send('Input.dispatchTouchEvent', { type, touchPoints }); await delay(50);
        const s = await state(page); events.push({ step, type, ids: touchPoints.map(p => p.id), x: s.x, input: s.input });
        item.details.pointerEvents = await page.evaluate(() => window.__strategyPointerEvents);
        return s;
      }
      try {
        const one = await touch('touchStart', [points.stick], 'joystick down');
        assert.ok(one.input.touchVector.x > 0.5, 'Native touch must engage the joystick');
        const owner = one.input.pointerId; assert.ok(owner !== null);
        // Chromium's WebTouchEvent path expects changed contacts: touchEnd([dash])
        // releases dash, whereas touchEnd([stick]) releases the joystick. Newer
        // SyntheticPointerActions uses a full active-contact list on touchMove.
        // Accept only that explicit protocol rejection when selecting the latter.
        let activeListMode = false;
        let both;
        try { both = await touch('touchStart', [points.dash], 'dash down'); }
        catch (e) {
          if (!e.message.includes('Must have no prior active touch points')) throw e;
          activeListMode = true; item.details.protocolMode = 'active-touch-list';
          both = await touch('touchMove', [points.stick, points.dash], 'dash down');
        }
        assert.equal(both.input.dashPressed, true); assert.equal(both.input.pointerId, owner);
        const dashOwner = await page.evaluate(() => window.__strategyPointerEvents.find(e => e.type === 'pointerdown' && e.target === 'dash')?.pointerId);
        assert.ok(Number.isInteger(dashOwner) && dashOwner !== owner, 'CDP must create a separate native pointer for dash');
        await page.waitForFunction(() => window.__MOON_SURVIVOR__.game.player.dashCooldown > 0);
        const dashReleased = await touch(activeListMode ? 'touchMove' : 'touchEnd', [activeListMode ? points.stick : points.dash], 'dash up; joystick remains down');
        assert.ok(item.details.pointerEvents.some(e => e.type === 'pointerup' && e.pointerId === dashOwner), 'Protocol must release the dash pointer before asserting input state');
        assert.ok(!item.details.pointerEvents.some(e => e.type === 'pointerup' && e.pointerId === owner), 'Protocol must leave the joystick pointer active');
        assert.equal(dashReleased.input.dashPressed, false, 'Released dash pointer must clear dashPressed'); assert.equal(dashReleased.input.pointerId, owner);
        assert.ok(dashReleased.input.touchVector.x > 0.5, 'Releasing dash must not reset another finger’s joystick');
        const x = dashReleased.x; await delay(130); assert.ok((await state(page)).x > x + 10, 'Joystick must keep moving after the dash finger releases');
        await touch(activeListMode ? 'touchMove' : 'touchStart', activeListMode ? [points.stick, points.dash] : [points.dash], 'dash down again');
        const stickReleased = await touch(activeListMode ? 'touchMove' : 'touchEnd', [activeListMode ? points.dash : points.stick], 'joystick up; dash remains down');
        assert.ok(item.details.pointerEvents.some(e => e.type === 'pointerup' && e.pointerId === owner), 'Protocol must release the joystick pointer');
        assert.equal(stickReleased.input.pointerId, null); assert.deepEqual(stickReleased.input.touchVector, { x: 0, y: 0 });
        assert.equal(stickReleased.input.dashPressed, true, 'Releasing joystick must not reset another finger’s held dash');
        const allReleased = await touch('touchEnd', [], 'all fingers up');
        assert.equal(allReleased.input.dashPressed, false); assert.equal(allReleased.input.pointerId, null);
        assert.ok(allReleased.x > one.x, 'Two real touch contacts must produce player movement');
        assert.ok(item.details.pointerEvents.every(e => e.trusted), 'Every recorded touch/pointer event must be browser-generated');
        return { ...item.details, dashCooldown: await page.evaluate(() => window.__MOON_SURVIVOR__.game.player.dashCooldown) };
      } finally { await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {}); await client.detach(); }
    });
  }
}

await mkdir(output, { recursive: true });
try {
  assert.ok(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable');
  await sourceHints(); await startServer();
  browserSession = await launchTestBrowser(executablePath); browser = browserSession.browser;
  report.launchMode = browserSession.mode;
  report.browser = await browser.version();
  await functionalChecks(); await layoutChecks(); await touchChecks();
} catch (e) {
  report.fatal = { message: e.message, stack: e.stack }; console.error(e.stack);
} finally {
  if (browserSession) await browserSession.close().catch(e => { report.cleanupError = e.message; });
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit'); server.kill(); await Promise.race([exited, delay(3000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([exited, delay(1000)]); }
  }
  report.finishedAt = new Date().toISOString(); report.serverLog = serverLog;
  await sourceHints().catch(() => {}); await saveReport();
  const failed = report.cases.filter(item => !item.passed);
  console.log(JSON.stringify({ passed: report.passed, selectedFilter: report.selectedFilter, total: report.cases.length, failed: failed.map(item => ({ name: item.name, error: item.error?.message.slice(0, 200) })), runtimeErrors: report.runtimeErrors, reportPath }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
