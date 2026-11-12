import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { launchTestBrowser } from './browser-launch.mjs';

const executablePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable');
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:'43928'},stdio:['ignore','pipe','pipe']});
let browser, browserSession;
const errors=[];
async function audioPeak(page, settle = false) {
  return page.evaluate(async(settle)=>{
    const {ui}=window.__MOON_SURVIVOR__;
    const analyser=ui.audioContext.createAnalyser();analyser.fftSize=2048;
    ui.masterGain.connect(analyser);
    const samples=new Float32Array(analyser.fftSize);
    let peak=0;
    try {
      // Drain buffered pre-mute samples before checking steady silent output.
      if(settle) await new Promise(resolve=>setTimeout(resolve,Math.ceil(analyser.fftSize/ui.audioContext.sampleRate*2000)));
      for(let frame=0;frame<8;frame++) {
        await new Promise(resolve=>setTimeout(resolve,16));
        analyser.getFloatTimeDomainData(samples);
        for(const value of samples) peak=Math.max(peak,Math.abs(value));
      }
    } finally {ui.masterGain.disconnect(analyser);}
    return peak;
  },settle);
}
try {
  await Promise.race([once(server.stdout,'data'), once(server,'exit').then(()=>{throw Error('Server exited before startup');})]);
  browserSession=await launchTestBrowser(executablePath); browser=browserSession.browser;
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('response',r=>{if(r.status()>=400) errors.push(`${r.status()} ${r.url()}`);});
  await page.setViewport({width:1440,height:900});
  await page.goto('http://127.0.0.1:43928',{waitUntil:'networkidle0'});
  await mkdir('output/screenshots',{recursive:true});
  await page.screenshot({path:'output/screenshots/title.png'});
  await page.click('#start');
  if (await page.$('#tutorial-screen.is-visible')) await page.click('#tutorial-close');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.state==='playing');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.ui.audio.ready);
  const startPeak=await audioPeak(page);
  assert.ok(startPeak>0.02,'Starting a run should produce a clear audio signal');
  await page.evaluate(()=>window.__MOON_SURVIVOR__.ui.audioContext.suspend());
  await page.waitForFunction(()=>!window.__MOON_SURVIVOR__.ui.audio.ready);
  await page.click('#sound');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.ui.audio.ready);
  assert.equal(await page.$eval('#sound',e=>e.getAttribute('aria-pressed')),'true');
  await page.click('#sound');
  assert.equal(await page.evaluate(()=>window.__MOON_SURVIVOR__.ui.soundOn),false);
  assert.ok(await audioPeak(page,true)<0.00001,'Muted audio should have zero output after buffered samples drain');
  await page.click('#sound');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.ui.audio.ready);
  const resumedPeak=await audioPeak(page);
  assert.ok(resumedPeak>0.02,'Re-enabling sound should restore a clear signal');
  const renderChecks=await page.evaluate(()=>{
    const {game,renderer}=window.__MOON_SURVIVOR__;
    const fixture={player:{...game.player,x:0,y:0},state:'paused',elapsed:0,shake:0,gems:[],projectiles:[],particles:[],enemies:[
      {id:'visible',type:'shade',x:0,y:0,radius:12,hp:28,maxHp:28,color:'#b2a0ee',hitFlash:0},
      {id:'distant',type:'runner',x:1500,y:900,radius:9,hp:18,maxHp:18,color:'#ff7990',hitFlash:0},
    ]};
    renderer.draw(fixture,0);
    const firstCacheSize=renderer.sprites.images.size;
    for(let i=0;i<12;i++)renderer.draw(fixture,0);
    const result={...renderer.metrics,cacheReused:renderer.sprites.images.size===firstCacheSize};
    const originalLevel=renderer.quality.level;
    renderer.quality.level=2;renderer.resize();renderer.draw(fixture,0);
    result.lowQualityDraws=renderer.metrics.enemiesDrawn;
    renderer.quality.level=originalLevel;renderer.resize();renderer.draw(game,0);
    return result;
  });
  assert.equal(renderChecks.enemiesDrawn,1);
  assert.equal(renderChecks.enemiesSkipped,1);
  assert.equal(renderChecks.cacheReused,true);
  assert.equal(renderChecks.lowQualityDraws,1);
  await page.keyboard.down('KeyD');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.player.x>30);
  await page.keyboard.up('KeyD');
  await page.waitForFunction(()=>{
    const {game,renderer}=window.__MOON_SURVIVOR__;
    const x=Math.round(renderer.width/2+5)*renderer.dpr;
    const y=Math.round(renderer.height/2-1)*renderer.dpr;
    const pixel=renderer.context.getImageData(x,y,1,1).data;
    return game.player.facing===0&&pixel[0]>70&&pixel[1]>50&&pixel[2]>90;
  },{timeout:3000}).catch(()=>{throw new Error('Player is not rendered centered after moving right');});

  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>Math.abs(window.__MOON_SURVIVOR__.game.player.facing+Math.PI/2)<1e-8);
  await page.keyboard.up('KeyW');
  await page.evaluate(()=>{
    const g=window.__MOON_SURVIVOR__.game;
    g.player.x=1600-g.player.radius;
    g.player.y=0;
  });
  await page.waitForFunction(()=>{
    const g=window.__MOON_SURVIVOR__.game;
    return g.player.x>1500;
  });
  await page.screenshot({path:'output/screenshots/edge.png'});
  const offCenter=await page.evaluate(()=>{
    const {game,renderer}=window.__MOON_SURVIVOR__;
    return game.player.x-(1600-renderer.width/2);
  });
  assert.ok(offCenter>0,'Player should leave screen center near the world edge');
  await page.click('#pause');
  assert.equal(await page.evaluate(()=>window.__MOON_SURVIVOR__.game.state),'paused');
  await page.click('#resume');
  await page.evaluate(()=>{const g=window.__MOON_SURVIVOR__.game;g.player.xp=8;g.checkLevelUp();});
  await page.waitForSelector('#level-screen.is-visible');
  assert.equal(await page.$$eval('.upgrade-option',items=>items.length),3);
  await page.click('.upgrade-option');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.state==='playing');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.elapsed>4);
  await page.screenshot({path:'output/screenshots/game.png'});
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.__resumeTime=window.__MOON_SURVIVOR__.game.elapsed;});
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.elapsed>window.__resumeTime+0.1);
  await page.evaluate(()=>{const g=window.__MOON_SURVIVOR__.game;g.player.health=1;g.fireClock=100;g.enemies=[{id:'fatal',x:g.player.x,y:g.player.y,hp:100,speed:0,radius:20,damage:100,contactClock:0,hitFlash:0,color:'#fff'}];});
  await page.waitForSelector('#result-screen.is-visible');
  await page.click('#restart');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.state==='playing'&&window.__MOON_SURVIVOR__.game.player.level===1);
  await page.setViewport({width:390,height:844,deviceScaleFactor:3,isMobile:true,hasTouch:true});
  await page.reload({waitUntil:'networkidle0'});
  await page.screenshot({path:'output/screenshots/mobile-title.png'});
  await page.click('#start');
  if (await page.$('#tutorial-screen.is-visible')) await page.click('#tutorial-close');
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.ui.audio.ready);
  const mobilePeak=await audioPeak(page);
  assert.ok(mobilePeak>0.02,'Mobile start gesture should produce audio');
  assert.ok(await page.evaluate(()=>window.__MOON_SURVIVOR__.renderer.dpr)<=1.5,'Phone render buffer should be bounded');
  assert.equal(await page.$eval('#mobile-controls',e=>e.classList.contains('active')),true);
  await page.evaluate(()=>{
    const z=document.querySelector('#stick-zone'),r=z.getBoundingClientRect();
    // Dispatch movement through the input adapter; native pointer capture requires a physical active pointer.
    const input=window.__MOON_SURVIVOR__.input;input.pointerId=9;
    input.onPointerMove({pointerId:9,clientX:r.left+r.width,clientY:r.top+r.height/2});
  });
  await page.waitForFunction(()=>window.__MOON_SURVIVOR__.game.player.x>25);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(()=>window.__MOON_SURVIVOR__.input.sample().moveX),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'output/screenshots/mobile-game.png'});
  assert.deepEqual(errors,[]);
  const report={passed:true,checked:['desktop start/movement','audio output signal','suspended audio recovery','mute and re-enable audio','offscreen enemy culling','sprite cache reuse','low quality preserves actors','player centered inside the map','player off-center at world edge','facing follows movement','pause/resume','upgrade choice','death/restart','page transition recovery (synthetic)','mobile audio output signal','mobile render resolution limit','mobile layout','touch vector adapter','blur clears input'],audio:{startPeak,resumedPeak,mobilePeak},renderChecks,errors,date:new Date().toISOString()};
  Object.assign(report,{browser:await browser.version(),launchMode:browserSession.mode,userAgent:await page.evaluate(()=>navigator.userAgent)});
  await writeFile('output/browser-validation.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { try { if(browserSession) await browserSession.close(); } finally { server.kill(); } }
