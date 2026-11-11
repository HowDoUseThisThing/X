import { GameAudio } from "../audio/game-audio.js";

const $ = (selector, root = document) => root.querySelector(selector);
const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
// CSSOM rounds percentage strings; cache the requested value to avoid rewriting
// an unchanged fractional health/XP width on every frame.
const widths = new WeakMap();
const setWidth = (element, width) => {
  if (widths.get(element) === width) return;
  element.style.width = width;
  widths.set(element, width);
};
const setAttribute = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };

const SOUND = Object.freeze({ hit: 260, dash: 330, level: 740, pickup: 1046 });

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
    this.disposed = false;
    this.audio = new GameAudio({
      createContext: () => {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) throw new Error("Audio unavailable");
        return new Audio();
      },
      onChange: (status, reason) => this.onAudioChange(status, reason),
    });
    this.listeners = [];
    this.heartbeatTimer = null;
    this.introTimer = null;
    this.introFrame = null;
    this.toastTimer = null;
    this.nextTideBell = 60;
    this.previousState = game.state;
    this.previousHealth = game.player.health;
    this.previousKills = game.kills;
    this.previousLevel = game.player.level;
    this.previousDashCooldown = game.player.dashCooldown;
    this.previousGemCount = game.gems.length;
    this.pausedByVisibility = false;
    setAttribute(this.elements.toast, "role", "status");
    setAttribute(this.elements.toast, "aria-live", "polite");
    setAttribute(this.elements.toast, "aria-atomic", "true");
    this.bind();
    this.updateSoundButton();
    this.listen(window, "pagehide", event => { if (!event.persisted) this.dispose(); });
  }

  // Keep the diagnostic surface used by browser checks.
  get audioContext() { return this.audio.context; }
  get masterGain() { return this.audio.masterGain; }
  get ambientOutput() { return this.audio.ambientOutput; }
  get ambientOscillators() { return this.audio.ambientOscillators; }
  get soundOn() { return this.audio.enabled; }
  set soundOn(value) { this.audio.setEnabled(value); }

  listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  bind() {
    this.listen($("#start"), "click", () => this.startRun());
    this.listen($("#restart"), "click", () => this.startRun());
    this.listen($("#pause"), "click", () => {
      if (this.game.state === "playing") this.pauseRun();
      else if (this.game.state === "paused") this.resumeRun();
    });
    this.listen($("#resume"), "click", () => this.resumeRun());
    this.listen($("#sound"), "click", () => this.toggleSound());
    this.listen(document, "visibilitychange", () => this.onVisibilityChange());
    this.listen(window, "keydown", event => this.onKeyDown(event));
  }

  onKeyDown(event) {
    if (event.code !== "Escape" && event.code !== "KeyP") return;
    if (this.game.state === "playing") this.pauseRun();
    else if (this.game.state === "paused") this.resumeRun();
  }

  onVisibilityChange() {
    if (this.disposed) return;
    if (document.hidden) {
      this.audio.park();
      if (this.game.state === "playing") {
        this.pausedByVisibility = true;
        this.game.pause();
      }
      return;
    }
    if (!document.hidden && this.game.state === "paused" && this.pausedByVisibility) {
      this.resumeRun(false);
    } else if (this.audioContext) {
      this.resumeAudioFromGesture(false, false);
    }
  }

  startRun() {
    if (this.disposed) return;
    const audioReady = this.resumeAudioFromGesture();
    this.clearIntro();
    this.game.start();
    this.hideAll();
    this.resetFeedbackState();
    this.showIntro();
    return audioReady;
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
    this.introFrame = requestAnimationFrame(() => {
      this.introFrame = null;
      if (!this.disposed) card.classList.add("on");
    });
    this.introTimer = setTimeout(() => card.classList.remove("on"), 2900);
  }

  clearIntro() {
    if (this.introFrame !== null) cancelAnimationFrame(this.introFrame);
    this.introFrame = null;
    if (this.introTimer !== null) clearTimeout(this.introTimer);
    this.introTimer = null;
    $("#intro-location")?.classList.remove("on");
  }

  resumeAudioFromGesture(cue = true, retry = true) {
    return this.audio.unlock({ cue, retry });
  }

  createAmbientBed() {
    // Compatibility entry point; graph creation is owned by the gesture path.
    return this.ambientOutput;
  }

  playTone(...args) {
    return this.audio.playTone(...args);
  }

  updateSoundButton() {
    const button = $("#sound");
    const ready = this.audio.ready;
    const pending = this.audio.status === "pending";
    const label = ready ? "关闭声音" : pending ? "声音正在开启，点击重试" : this.audio.status === "blocked" ? "声音暂不可用，点击重试" : "开启声音";
    if (button.classList.contains("muted") === ready) button.classList.toggle("muted", !ready);
    setAttribute(button, "aria-label", label);
    setAttribute(button, "aria-pressed", String(ready));
    setAttribute(button, "aria-busy", String(pending));
    setAttribute(button, "title", ready ? "声音已开启，点击静音" : label);
    setAttribute(button, "data-audio-state", this.audio.status);
  }

  onAudioChange(status, reason) {
    this.updateSoundButton();
    if (status !== "ready" && this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (status === "ready") this.startHeartbeat();
    if (this.disposed || document.hidden) return;
    if (status === "ready") this.toast("声音已开启");
    if (status === "pending") this.toast("正在开启声音…未听到时可点声音按钮重试");
    if (status === "blocked") this.toast(reason === "timeout" ? "声音开启超时，请点声音按钮重试" : reason === "interrupted" ? "声音已暂停，请点声音按钮恢复" : "声音暂未开启，请点声音按钮重试");
  }

  startHeartbeat() {
    if (this.heartbeatTimer !== null || !this.audio.ready || this.game.state !== "playing") return;
    const beat = () => {
      this.heartbeatTimer = null;
      if (!this.audio.ready || this.game.state !== "playing") return;
      const player = this.game.player;
      const pressure = Math.max(0, 1 - player.health / player.maxHealth);
      const base = 146 + pressure * 30;
      this.playTone(base + 35, base, 0.12 + pressure * 0.04, 0.025 + pressure * 0.03, 0.08, { key: "heartbeat" });
      this.heartbeatTimer = setTimeout(beat, 980 - pressure * 400);
    };
    this.heartbeatTimer = setTimeout(beat, 280);
  }

  syncFeedback(game) {
    const player = game.player;
    if (game.state !== this.previousState) {
      if (game.state === "levelup") this.playTone(720, 920, 0.23, 0.10, 0, { key: "level" });
      else if (game.state === "paused") this.playTone(330, 220, 0.16, 0.06, 0, { key: "pause" });
      else if (game.state === "gameover") this.playTone(392, 146, 0.42, 0.13, 0, { key: "gameover" });
      this.previousState = game.state;
    }
    if (player.health < this.previousHealth) this.playTone(SOUND.hit, 150, 0.15, 0.11, 0, { key: "hit", interval: 0.14 });
    if (game.kills > this.previousKills) this.playTone(880, 620, 0.075, 0.065, 0, { key: "kill", interval: 0.09 });
    if (player.level > this.previousLevel) this.playTone(SOUND.level, 980, 0.31, 0.12, 0, { key: "level" });
    if (this.previousDashCooldown - player.dashCooldown > 1.5 && player.dashCooldown > 0) this.playTone(SOUND.dash, 196, 0.11, 0.08, 0, { key: "dash" });
    if (game.gems.length < this.previousGemCount) this.playTone(SOUND.pickup, 784, 0.09, 0.055, 0, { key: "pickup", interval: 0.1 });

    if (game.elapsed >= this.nextTideBell) {
      this.playTone(392, 523, 0.38, 0.09, 0, { key: "tide-low" });
      this.playTone(523, 659, 0.38, 0.08, 0.17, { key: "tide-high" });
      this.nextTideBell += 60;
    }

    this.previousHealth = player.health;
    this.previousKills = game.kills;
    this.previousLevel = player.level;
    this.previousDashCooldown = player.dashCooldown;
    this.previousGemCount = game.gems.length;
    const critical = player.health / Math.max(1, player.maxHealth) < 0.3;
    this.audio.setAmbientLevel(game.state === "playing" ? (critical ? 0.055 : 0.04) : 0.012);
    this.startHeartbeat();
  }

  toggleSound() {
    if (this.disposed) return Promise.resolve(false);
    if (this.audio.ready) {
      this.audio.setEnabled(false);
      this.toast("声音已静音");
      return Promise.resolve(false);
    }
    this.audio.setEnabled(true);
    return this.resumeAudioFromGesture();
  }

  pauseRun() {
    if (this.game.state !== "playing") return;
    this.pausedByVisibility = false;
    this.game.pause();
    this.show("pause");
  }

  resumeRun(cue = true) {
    if (this.disposed || this.game.state !== "paused") return;
    this.resumeAudioFromGesture(cue, cue);
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
    if (this.disposed) return;
    const player = game.player;
    setText(this.elements.clock, formatTime(game.elapsed));
    setWidth(this.elements.health, `${Math.max(0, 100 * player.health / player.maxHealth)}%`);
    setText(this.elements.healthText, `${Math.ceil(player.health)} / ${player.maxHealth}`);
    setWidth(this.elements.xp, `${Math.min(100, 100 * player.xp / player.xpNext)}%`);
    setText(this.elements.levelText, `LV. ${player.level}`);
    const minute = Math.floor(game.elapsed / 60);
    setText(this.elements.wave, minute >= 3 ? "暗潮 · 猎杀时刻" : minute >= 1 ? "暗潮 · 群影来袭" : "潮汐逼近");
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
    setText($("#result-title"), "夜尽 · 暂歇");
    setText($("#result-copy"), "你在潮汐中留下了足迹。带着这份回响，再次迎接黑夜。");
    setText($("#final-time"), formatTime(game.elapsed));
    setText($("#final-kills"), String(game.kills));
    setText($("#final-level"), `LV. ${game.player.level}`);
    this.show("result");
  }

  toast(text) {
    if (this.disposed) return;
    setText(this.elements.toast, text);
    this.elements.toast.classList.add("show");
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.elements.toast.classList.remove("show");
      this.toastTimer = null;
    }, 1700);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.clearIntro();
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.heartbeatTimer = null;
    this.toastTimer = null;
    this.audio.dispose();
  }
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
  const remainder = String(whole % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
