const PRESETS = Object.freeze([
  Object.freeze({ pixelRatio: 2, glow: true, particleLimit: 360, trailPoints: 4, starStride: 1 }),
  Object.freeze({ pixelRatio: 1.5, glow: true, particleLimit: 220, trailPoints: 2, starStride: 3 }),
  Object.freeze({ pixelRatio: 1, glow: false, particleLimit: 120, trailPoints: 0, starStride: 8 }),
]);

// Judge sustained frame pressure, not one slow frame or a background-tab gap.
// Recover much more slowly than we reduce quality to avoid visible oscillation.
export class AdaptiveQuality {
  constructor({ mobile = false } = {}) {
    this.mobile = mobile;
    this.level = mobile ? 1 : 0;
    this.resetSampling();
  }

  get settings() { return PRESETS[this.level]; }

  resetSampling() {
    this.windowMs = 0;
    this.frames = 0;
    this.slowWindows = 0;
    this.fastWindows = 0;
  }

  sample(milliseconds, playing = true) {
    if (!playing || !Number.isFinite(milliseconds) || milliseconds > 1000) {
      this.resetSampling();
      return false;
    }
    if (milliseconds <= 0) return false;
    this.windowMs += milliseconds;
    this.frames += 1;
    if (this.windowMs < 1000) return false;
    const average = this.windowMs / this.frames;
    this.windowMs = 0;
    this.frames = 0;
    this.slowWindows = average > 23 ? this.slowWindows + 1 : 0;
    this.fastWindows = average < 18.5 ? this.fastWindows + 1 : 0;
    if (this.slowWindows >= 2 && this.level < PRESETS.length - 1) {
      this.level += 1;
    } else if (this.fastWindows >= 8 && this.level > 0) {
      this.level -= 1;
    } else return false;
    this.resetSampling();
    return true;
  }

  pixelRatio(devicePixelRatio = 1) {
    return Math.min(devicePixelRatio || 1, this.settings.pixelRatio, this.mobile ? 1.5 : 2);
  }
}
