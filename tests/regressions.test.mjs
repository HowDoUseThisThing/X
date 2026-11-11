import { it } from 'node:test';
import assert from 'node:assert/strict';
import { SurvivorGame } from '../src/game/game.js';

it('death takes priority over a simultaneous experience pickup', () => {
  const g = new SurvivorGame(4); g.start();
  g.player.health = 1; g.fireClock = 10;
  g.enemies.push({id:'fatal', x:0,y:0,hp:100,speed:0,radius:10,damage:10,contactClock:0,hitFlash:0});
  g.gems.push({x:0,y:0,radius:8,value:100,phase:0});
  g.update(0.01);
  assert.equal(g.state, 'gameover');
  assert.equal(g.player.level, 1);
  g.player.xp=100; g.checkLevelUp();
  assert.equal(g.state, 'gameover');
  g.start();
  assert.equal(g.state, 'playing');
  assert.equal(g.player.health, 100);
  assert.equal(g.gems.length, 0);
});

it('capped multishot is not offered as an ineffective upgrade', () => {
  for (let seed=0; seed<80; seed++) {
    const g=new SurvivorGame(seed); g.start(); g.player.projectileCount=5;
    g.player.xp=8; g.checkLevelUp();
    assert.equal(g.upgradeChoices.length,3);
    assert.ok(g.upgradeChoices.every(x=>x.id!=='multishot'));
  }
});
