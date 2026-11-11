const $ = (selector, root = document) => root.querySelector(selector);

const SOUND = Object.freeze({ hit: 112, dash: 230, level: 740, pickup: 980 });

export class GameUI {
  constructor(game) {
    this.game = game;
    this.elements = {
      title: $("#title-screen"),
      level: $("#level-screen"),
      pause: $("#pause-screen"),
      result: $("#result-screen"),
      clock: $("#clock"),
      health: $("#health-fill"),
      healthText: $("#health-text"),
      xp: $("#xp-fill"),
      levelText: $("#level-text"),
      wave: $("#wave-text"),
      toast: $("#toast"),
    };
    this.soundOn = true;
    this.audioContext = null;
    this.masterGain = null;
    this.ambientOutput = null;
    this.ambientOscillators = [];
    this.heartbeatTimer = null;
    this.introTimer = null;
    this.toastTimer = null;
    this.nextTideBell = 60;
    this.previousState = game.state;
    this.previousHealth = game.player.health;
    this.previousKills = game.kills;
    this.previousLevel = game.player.level;
    this.previousDashCooldown = game.player.dashCooldown;
    this.previousGemCount = game.gems.length;
    this.pausedByVisibility = false;
    this.bind();
    window.addEventListener("pagehide", event => { if (!event.persisted) this.dispose(); });
  }

  bind() {
    $("#start").addEventListener("click", () => this.startRun());
    $("#restart").addEventListener("click", () => this.startRun());
    $("#pause").addEventListener("click", () => {
      if (this.game.state === "playing") this.pauseRun();
      else if (this.game.state === "paused") this.resumeRun();
    });
    $("#resume").addEventListener("click", () => this.resumeRun());
    $("#sound").addEventListener("click", event => this.toggleSound(event.currentTarget));
    document.addEventListener("visibilitychange", () => this.onVisibilityChange());
    window.addEventListener("keydown", event => this.onKeyDown(event));
  }

  onKeyDown(event) {
    if (event.code !== "Escape" && event.code !== "KeyP") return;
    if (this.game.state === "playing") this.pauseRun();
    else if (this.game.state === "paused") this.resumeRun();
  }

  onVisibilityChange() {
    if (document.hidden && this.game.state === "playing") {
      this.pausedByVisibility = true;
      this.game.pause();
      return;
    }
    if (!document.hidden && this.game.state === "paused" && this.pausedByVisibility) {
      this.pausedByVisibility = false;
      this.game.resume();
    }
  }

  async startRun() {
    this.clearIntro();
    this.game.start();
    this.hideAll();
    this.resetFeedbackState();
    this.showIntro();
    await this.resumeAudioFromGesture();
  }

  resetFeedbackState() {
    this.nextTideBell = 60;
    this.previousState = this.game.state;
    this.previousHealth = this.game.player.health;
    this.previousKills = this.game.kills;
    this.previousLevel = this.game.player.level;
    this.previousDashCooldown = this.game.player.dashCooldown;
    this.previousGemCount = this.game.gems.length;
  }

  showIntro() {
    const card = $("#intro-location");
    if (!card) return;
    card.classList.remove("on");
    requestAnimationFrame(() => card.classList.add("on"));
    this.introTimer = setTimeout(() => card.classList.remove("on"), 2900);
  }

  clearIntro() {
    if (this.introTimer !== null) clearTimeout(this.introTimer);
    this.introTimer = null;
    $("#intro-location")?.classList.remove("on");
  }

  async resumeAudioFromGesture() {
    if (!this.soundOn) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      this.audioContext ||= new Audio();
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      this.createAmbientBed();
      if (this.audioContext.state === "running") {
        this.masterGain.gain.setTargetAtTime(0.55, this.audioContext.currentTime, 0.045);
        this.playTone(523, 392, 0.17, 0.04);
        this.startHeartbeat();
      }
    } catch {
      // Web Audio is optional; continue silently when the browser denies access.
    }
  }

  createAmbientBed() {
    if (!this.audioContext || this.masterGain) return;
    const context = this.audioContext;
    this.masterGain = context.createGain();
    this.masterGain.gain.value = 0;
    this.masterGain.connect(context.destination);

    this.ambientOutput = context.createGain();
    this.ambientOutput.gain.value = 0.006;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 195;
    filter.Q.value = 0.5;
    this.ambientOutput.connect(filter).connect(this.masterGain);

    for (const [frequency, level] of [[49, 0.52], [73.42, 0.25], [110.19, 0.14]]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.value = level;
      oscillator.connect(gain).connect(this.ambientOutput);
      oscillator.start();
      this.ambientOscillators.push(oscillator);
    }
  }

  playTone(startHz, endHz, duration = 0.13, amplitude = 0.032, offset = 0) {
    if (!this.soundOn || !this.audioContext || !this.masterGain || this.audioContext.state !== "running") return;
    try {
      const context = this.audioContext;
      const start = context.currentTime + offset;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(Math.max(25, startHz), start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(25, endHz), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, amplitude), start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.075);
      oscillator.connect(gain).connect(this.masterGain);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.1);
    } catch {
      // A suspended/closing context can reject a sound event without affecting the game.
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer !== null || !this.soundOn || !this.audioContext || this.game.state !== "playing") return;
    const beat = () => {
      this.heartbeatTimer = null;
      if (!this.soundOn || !this.audioContext || this.game.state !== "playing") return;
      const player = this.game.player;
      const pressure = Math.max(0, 1 - player.health / player.maxHealth);
      const base = 45 + pressure * 13;
      this.playTone(base + 12, base, 0.12 + pressure * 0.04, 0.008 + pressure * 0.022, 0.08);
      this.heartbeatTimer = setTimeout(beat, 980 - pressure * 400);
    };
    this.heartbeatTimer = setTimeout(beat, 280);
  }

  syncFeedback(game) {
    const player = game.player;
    if (game.state !== this.previousState) {
      if (game.state === "levelup") this.playTone(720, 920, 0.23, 0.032);
      else if (game.state === "paused") this.playTone(277, 220, 0.16, 0.022);
      else if (game.state === "gameover") this.playTone(130, 48, 0.42, 0.04);
      this.previousState = game.state;
    }
    if (player.health < this.previousHealth) this.playTone(SOUND.hit, 54, 0.15, 0.04);
    if (game.kills > this.previousKills) this.playTone(920, 680, 0.075, 0.02);
    if (player.level > this.previousLevel) this.playTone(SOUND.level, 980, 0.31, 0.05);
    if (this.previousDashCooldown - player.dashCooldown > 1.5 && player.dashCooldown > 0) this.playTone(SOUND.dash, 116, 0.11, 0.025);
    if (game.gems.length < this.previousGemCount) this.playTone(SOUND.pickup, 720, 0.09, 0.018);

    if (game.elapsed >= this.nextTideBell) {
      this.playTone(392, 523, 0.38, 0.035);
      this.playTone(523, 659, 0.38, 0.03, 0.17);
      this.nextTideBell += 60;
    }

    this.previousHealth = player.health;
    this.previousKills = game.kills;
    this.previousLevel = player.level;
    this.previousDashCooldown = player.dashCooldown;
    this.previousGemCount = game.gems.length;
    if (this.ambientOutput && this.audioContext?.state === "running") {
      const critical = player.health / Math.max(1, player.maxHealth) < 0.3;
      const level = game.state === "playing" ? (critical ? 0.01 : 0.006) : 0.002;
      this.ambientOutput.gain.setTargetAtTime(level, this.audioContext.currentTime, 0.3);
    }
    this.startHeartbeat();
  }

  toggleSound(button) {
    this.soundOn = !this.soundOn;
    button.classList.toggle("muted", !this.soundOn);
    button.setAttribute("aria-label", this.soundOn ? "关闭声音" : "开启声音");
    if (this.soundOn && !this.audioContext) this.resumeAudioFromGesture();
    if (this.masterGain && this.audioContext) this.masterGain.gain.setTargetAtTime(this.soundOn ? 0.55 : 0, this.audioContext.currentTime, 0.035);
    if (!this.soundOn && this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.toast(this.soundOn ? "潮声与心跳已开启" : "声音已静音");
  }

  pauseRun() {
    if (this.game.state !== "playing") return;
    this.pausedByVisibility = false;
    this.game.pause();
    this.show("pause");
  }

  resumeRun() {
    if (this.game.state !== "paused") return;
    this.pausedByVisibility = false;
    this.game.resume();
    this.hideAll();
  }

  hideAll() {
    for (const element of [this.elements.title, this.elements.level, this.elements.pause, this.elements.result]) {
      element.classList.add("hidden");
      element.classList.remove("is-visible");
    }
  }

  show(id) {
    this.hideAll();
    const screen = this.elements[id];
    if (!screen) return;
    screen.classList.remove("hidden");
    screen.classList.add("is-visible");
  }

  render(game) {
    const player = game.player;
    this.elements.clock.textContent = formatTime(game.elapsed);
    this.elements.health.style.width = `${Math.max(0, 100 * player.health / player.maxHealth)}%`;
    this.elements.healthText.textContent = `${Math.ceil(player.health)} / ${player.maxHealth}`;
    this.elements.xp.style.width = `${Math.min(100, 100 * player.xp / player.xpNext)}%`;
    this.elements.levelText.textContent = `LV. ${player.level}`;
    const minute = Math.floor(game.elapsed / 60);
    this.elements.wave.textContent = minute >= 3 ? "暗潮 · 猎杀时刻" : minute >= 1 ? "暗潮 · 群影来袭" : "潮汐逼近";
    this.syncFeedback(game);
    if (game.state === "levelup" && this.elements.level.classList.contains("hidden")) this.showLevelUp(game);
    if (game.state === "gameover" && this.elements.result.classList.contains("hidden")) this.showResult(game);
  }

  showLevelUp(game) {
    const list = $("#upgrade-list");
    list.replaceChildren();
    for (const upgrade of game.upgradeChoices) {
      const button = document.createElement("button");
      button.className = "upgrade-option";
      button.innerHTML = `<span class="upgrade-icon">${upgrade.icon}</span><span class="upgrade-text"><b>${upgrade.name}</b><small>${upgrade.desc}</small></span><span class="upgrade-arrow">↗</span>`;
      button.addEventListener("click", () => {
        if (game.chooseUpgrade(upgrade.id)) {
          this.hideAll();
          this.toast(`力量进化 · ${upgrade.name}`);
        }
      });
      list.append(button);
    }
    this.show("level");
  }

  showResult(game) {
    $("#result-title").textContent = "夜尽 · 暂歇";
    $("#result-copy").textContent = "你在潮汐中留下了足迹。带着这份回响，再次迎接黑夜。";
    $("#final-time").textContent = formatTime(game.elapsed);
    $("#final-kills").textContent = String(game.kills);
    $("#final-level").textContent = `LV. ${game.player.level}`;
    this.show("result");
  }

  toast(text) {
    this.elements.toast.textContent = text;
    this.elements.toast.classList.add("show");
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.elements.toast.classList.remove("show");
      this.toastTimer = null;
    }, 1700);
  }

  dispose() {
    this.clearIntro();
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.heartbeatTimer = null;
    this.toastTimer = null;
    for (const oscillator of this.ambientOscillators) {
      try { oscillator.stop(); } catch {}
    }
    this.ambientOscillators = [];
    if (this.audioContext && this.audioContext.state !== "closed") {
      try { this.audioContext.close(); } catch {}
    }
    this.audioContext = null;
    this.masterGain = null;
    this.ambientOutput = null;
  }
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
  const remainder = String(whole % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
