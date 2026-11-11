import { it } from "node:test";
import assert from "node:assert/strict";
import { AdaptiveQuality } from "../src/render/quality.js";

it("starts phones with a smaller render buffer without changing screen coordinates", () => {
  const quality = new AdaptiveQuality({ mobile: true });
  assert.equal(quality.pixelRatio(3), 1.5);
  assert.equal(quality.pixelRatio(1), 1);
  assert.ok(quality.settings.particleLimit > 0);
});

it("reduces quality for sustained pressure and recovers slowly", () => {
  const quality = new AdaptiveQuality();
  for (let i = 0; i < 70; i += 1) quality.sample(30);
  assert.equal(quality.level, 1);
  for (let i = 0; i < 70; i += 1) quality.sample(30);
  assert.equal(quality.level, 2);
  for (let i = 0; i < 300; i += 1) quality.sample(1000 / 60);
  assert.equal(quality.level, 2);
  for (let i = 0; i < 185; i += 1) quality.sample(1000 / 60);
  assert.equal(quality.level, 1);
});

it("ignores one slow frame, paused screens, and a background-tab time gap", () => {
  const quality = new AdaptiveQuality();
  quality.sample(150);
  for (let i = 0; i < 140; i += 1) quality.sample(1000 / 60);
  assert.equal(quality.level, 0);
  for (let i = 0; i < 70; i += 1) quality.sample(40, false);
  quality.sample(3000);
  for (let i = 0; i < 40; i += 1) quality.sample(30);
  assert.equal(quality.level, 0);
});

it("still reduces quality when an active device is severely overloaded", () => {
  const quality = new AdaptiveQuality();
  for (let i = 0; i < 6; i += 1) quality.sample(400);
  assert.equal(quality.level, 1);
  for (let i = 0; i < 6; i += 1) quality.sample(400);
  assert.equal(quality.level, 2);
});
