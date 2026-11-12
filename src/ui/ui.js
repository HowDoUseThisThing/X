import { GameAudio } from "../audio/game-audio.js";
import { CHARACTERS, WEAPONS, PASSIVES, ACHIEVEMENTS } from "../game/content.js";
import { normalizeSave, defaultSave } from "../game/progression.js";

const $ = (selector, root = document) => root.querySelector(selector);
const setText = (element, text) => { if (element && element.textContent !== text) element.textContent = text; };
const widths = new WeakMap();
const setWidth = (element, width) => { if (!element || widths.get(element) === width) return; element.style.width = width; widths.set(element, width); };
const setAttribute = (element, name, value) => { if (element && element.getAttribute(name) !== value) element.setAttribute(name, value); };
const SOUND = Object.freeze({ hit: 260, dash: 330, level: 740, pickup: 1046 });
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const positive = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const number = value => Number(value.toFixed(2)).toString();
const evolutionEffects = { moonArrow: "命中分裂 2 枚追踪碎片", orbitBlade: "刀刃留下切割轨迹", tideNova: "爆发追加延迟波", chainSpark: "跳跃终点追加范围落雷", graveField: "领域缓慢跟随并治疗", echoBoomerang: "返程分裂为 3 枚" };

export class GameUI {
  constructor(game, { profile = defaultSave(), onSave = () => {}, metaUI = null } = {}) {
    this.game = game;
    this.profile = normalizeSave(profile);
    this.settledRuns = new Set();
    this.settledSummaries = new WeakSet();
    this.metaOpen = false; this.tutorialOpen = false;
    this.onSave = onSave;
    this.metaUI = metaUI;
    this.elements = { title: $("#title-screen"), level: $("#level-screen"), chest: null, pause: $("#pause-screen"), result: $("#result-screen"), meta: $("#meta-screen"), clock: $("#clock"), health: $("#health-fill"), healthText: $("#health-text"), xp: $("#xp-fill"), levelText: $("#level-text"), wave: $("#wave-text"), toast: $("#toast") };
    this.disposed = false;
    this.audio = new GameAudio({ createContext: () => { const Audio = window.AudioContext || window.webkitAudioContext; if (!Audio) throw new Error("Audio unavailable"); return new Audio(); }, onChange: (status, reason) => this.onAudioChange(status, reason) });
    this.listeners = []; this.heartbeatTimer = null; this.introTimer = null; this.introFrame = null; this.toastTimer = null;
    this.nextTideBell = 60; this.previousState = game.state; this.previousHealth = game.player.health; this.previousKills = game.kills;
    this.previousLevel = game.player.level; this.previousDashCooldown = game.player.dashCooldown; this.previousGemCount = game.gems.length;
    this.pausedByVisibility = false; this.lastBuildSignature = ""; this.lastBossId = null; this.lastEventAt = -1;
    setAttribute(this.elements.toast, "role", "status"); setAttribute(this.elements.toast, "aria-live", "polite"); setAttribute(this.elements.toast, "aria-atomic", "true");
    this.renderCharacterPicker();
    this.audio.setEnabled(this.profile.preferences.sound !== false);
    this.bind(); this.updateSoundButton();
    this.listen(window, "pagehide", event => { if (!event.persisted) this.dispose(); });
  }

  get audioContext() { return this.audio.context; }
  get masterGain() { return this.audio.masterGain; }
  get ambientOutput() { return this.audio.ambientOutput; }
  get ambientOscillators() { return this.audio.ambientOscillators; }
  get soundOn() { return this.audio.enabled; }
  set soundOn(value) { this.audio.setEnabled(value); }
  listen(target, type, listener) { if (!target) return; target.addEventListener(type, listener); this.listeners.push(() => target.removeEventListener(type, listener)); }
  persistProfile(value = this.profile) {
    const next = normalizeSave(value);
    this.profile = normalizeSave(this.onSave(next) || next);
    return this.profile;
  }
  isInputBlocked() { return this.game.state !== "playing" || this.metaOpen || this.tutorialOpen; }

  bind() {
    this.listen($("#start"), "click", () => this.startRun());
    this.listen($("#restart"), "click", () => this.startRun());
    this.listen($("#pause"), "click", () => { if (this.game.state === "playing") this.pauseRun(); else if (this.game.state === "paused") this.resumeRun(); });
    this.listen($("#resume"), "click", () => this.resumeRun());
    this.listen($("#sound"), "click", () => this.toggleSound());
    this.listen($("#open-meta"), "click", () => this.openMeta());
    this.listen($("#result-meta"), "click", () => this.openMeta());
    this.listen($("#pause-meta"), "click", () => this.openMeta());
    this.listen($("#open-help"), "click", () => this.openTutorial());
    this.listen($("#tutorial-close"), "click", () => this.closeTutorial());
    this.listen($("#evacuate"), "click", () => { if (!this.metaOpen && !this.tutorialOpen && this.game.evacuate()) this.showResult(this.game); });
    this.listen($("#reroll"), "click", () => this.reroll());
    this.listen($("#skip-upgrade"), "click", () => this.skipUpgrade());
    this.listen(document, "visibilitychange", () => this.onVisibilityChange());
    this.listen(window, "keydown", event => this.onKeyDown(event));
  }

  onKeyDown(event) {
    const modal = this.tutorialOpen ? $("#tutorial-screen") : this.metaOpen ? this.elements.meta : this.game.state === "paused" ? this.elements.pause : this.game.state === "levelup" ? this.elements.level : this.game.state === "chest" ? $("#chest-screen") : this.game.state === "gameover" ? this.elements.result : this.game.state === "title" ? this.elements.title : null;
    if (event.code === "Tab" && modal) { this.trapFocus(event, modal); return; }
    if (event.repeat || event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "")) return;
    if (this.metaOpen || this.tutorialOpen) {
      if (event.code === "Escape") { event.preventDefault(); if (this.tutorialOpen) this.closeTutorial(); else this.metaUI?.setVisible(false); }
      else if (/^(Digit[1-3]|Numpad[1-3]|Key[PRS])$/.test(event.code)) event.preventDefault();
      return;
    }
    if (this.game.state === "levelup" || this.game.state === "chest") {
      if (/^(Digit|Numpad)[1-3]$/.test(event.code)) { event.preventDefault(); const index = Number(event.code.slice(-1)) - 1; const choice = (this.game.state === "chest" ? this.game.chestChoices : this.game.upgradeChoices)[index]; if (choice) this.chooseUpgrade(choice.id); return; }
      if (event.code === "KeyR" && this.game.state === "levelup") { event.preventDefault(); this.reroll(); return; }
      if (event.code === "KeyS" && this.game.state === "levelup") { event.preventDefault(); this.skipUpgrade(); return; }
    }
    if (event.code !== "Escape" && event.code !== "KeyP") return;
    event.preventDefault();
    if (this.game.state === "playing") this.pauseRun(); else if (this.game.state === "paused") this.resumeRun();
  }

  trapFocus(event, modal) {
    const buttons = [...(modal.querySelectorAll?.('button:not(:disabled), [tabindex="0"], a[href]') || [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || (!event.shiftKey && index === buttons.length - 1) || (event.shiftKey && index === 0)) {
      event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus?.();
    }
  }

  onVisibilityChange() {
    if (this.disposed) return;
    if (document.hidden) { this.audio.park(); if (this.game.state === "playing") { this.pausedByVisibility = true; this.game.pause(); } return; }
    if (!document.hidden && this.game.state === "paused" && this.pausedByVisibility && !this.metaOpen && !this.tutorialOpen) this.resumeRun(false);
    else if (this.audioContext) this.resumeAudioFromGesture(false, false);
  }

  renderCharacterPicker() {
    const picker = $("#character-picker");
    if (!picker || typeof picker.replaceChildren !== "function" || typeof document.createElement !== "function") return;
    picker.replaceChildren();
    for (const character of Object.values(CHARACTERS)) {
      const unlocked = this.profile.unlocked[character.id];
      const button = document.createElement("button");
      button.className = `character-pick ${this.profile.preferences.character === character.id ? "active" : ""}`;
      button.setAttribute("aria-pressed", String(this.profile.preferences.character === character.id));
      button.innerHTML = `<span>${character.icon}</span><b>${character.name}</b><small>${unlocked ? character.desc : `潮回声廊解锁 ✦ ${character.cost}`}</small>`;
      button.addEventListener("click", () => { if (!unlocked) return this.openMeta("characters"); this.profile.preferences.character = character.id; this.persistProfile(); this.renderCharacterPicker(); });
      picker.append(button);
    }
  }

  startRun() {
    if (this.disposed) return;
    const audioReady = this.resumeAudioFromGesture();
    if (this.metaOpen || this.tutorialOpen || !["title", "gameover"].includes(this.game.state)) return audioReady;
    this.clearIntro(); this.game.setProfile(this.profile); this.game.setCharacter(this.profile.preferences.character);
    let seed = (Date.now() ^ ((this.game.runSequence || 0) + 1)) >>> 0;
    try {
      if (typeof globalThis.crypto?.getRandomValues === "function") seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    } catch { /* Fall back when cryptographic randomness is unavailable. */ }
    if (seed === this.game.seed) seed = (seed + 0x9e3779b9) >>> 0;
    if (this.game.start(null, seed) === false) return audioReady;
    this.hideAll(); this.resetFeedbackState(); this.showIntro(); this.pausedByVisibility = false;
    if (!this.profile.preferences.tutorialSeen) this.openTutorial();
    return audioReady;
  }

  resetFeedbackState() {
    this.nextTideBell = 60; this.previousState = this.game.state; this.previousHealth = this.game.player.health; this.previousKills = this.game.kills;
    this.previousLevel = this.game.player.level; this.previousDashCooldown = this.game.player.dashCooldown; this.previousGemCount = this.game.gems.length;
    this.lastBuildSignature = ""; this.lastBossId = null; this.lastEventAt = -1;
  }

  showIntro() { const card = $("#intro-location"); if (!card) return; card.classList.remove("on"); this.introFrame = requestAnimationFrame(() => { this.introFrame = null; if (!this.disposed) card.classList.add("on"); }); this.introTimer = setTimeout(() => card.classList.remove("on"), 2900); }
  clearIntro() { if (this.introFrame !== null) cancelAnimationFrame(this.introFrame); this.introFrame = null; if (this.introTimer !== null) clearTimeout(this.introTimer); this.introTimer = null; $("#intro-location")?.classList.remove("on"); }
  resumeAudioFromGesture(cue = true, retry = true) {
    if (!this.profile.preferences.sound) return Promise.resolve(false);
    return this.audio.unlock({ cue, retry });
  }
  createAmbientBed() { return this.ambientOutput; }
  playTone(...args) { return this.audio.playTone(...args); }

  updateSoundButton() {
    const button = $("#sound");
    if (!button) return;
    const ready = this.audio.ready, pending = this.audio.status === "pending";
    const label = ready ? "关闭声音" : pending ? "声音正在开启，点击重试" : this.audio.status === "blocked" ? "声音暂不可用，点击重试" : "开启声音";
    if (button.classList.contains("muted") === ready) button.classList.toggle("muted", !ready);
    setAttribute(button, "aria-label", label); setAttribute(button, "aria-pressed", String(ready)); setAttribute(button, "aria-busy", String(pending));
    setAttribute(button, "title", ready ? "声音已开启，点击静音" : label); setAttribute(button, "data-audio-state", this.audio.status);
  }

  onAudioChange(status, reason) {
    this.updateSoundButton();
    if (status !== "ready" && this.heartbeatTimer !== null) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
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
      const player = this.game.player, pressure = Math.max(0, 1 - player.health / player.maxHealth), base = 146 + pressure * 30;
      this.playTone(base + 35, base, 0.12 + pressure * 0.04, 0.025 + pressure * 0.03, 0.08, { key: "heartbeat" });
      this.heartbeatTimer = setTimeout(beat, 980 - pressure * 400);
    };
    this.heartbeatTimer = setTimeout(beat, 280);
  }

  syncFeedback(game) {
    const player = game.player;
    if (game.state !== this.previousState) {
      if (game.state === "levelup") this.playTone(720, 920, 0.23, 0.10, 0, { key: "level" });
      else if (game.state === "chest") this.playTone(620, 1040, 0.35, 0.11, 0, { key: "chest" });
      else if (game.state === "paused") this.playTone(330, 220, 0.16, 0.06, 0, { key: "pause" });
      else if (game.state === "gameover") this.playTone(392, 146, 0.42, 0.13, 0, { key: "gameover" });
      this.previousState = game.state;
    }
    if (player.health < this.previousHealth) this.playTone(SOUND.hit, 150, 0.15, 0.11, 0, { key: "hit", interval: 0.14 });
    if (game.kills > this.previousKills) this.playTone(880, 620, 0.075, 0.065, 0, { key: "kill", interval: 0.09 });
    if (player.level > this.previousLevel) this.playTone(SOUND.level, 980, 0.31, 0.12, 0, { key: "level" });
    if (this.previousDashCooldown - player.dashCooldown > 1.5 && player.dashCooldown > 0) this.playTone(SOUND.dash, 196, 0.11, 0.08, 0, { key: "dash" });
    if (game.gems.length < this.previousGemCount) this.playTone(SOUND.pickup, 784, 0.09, 0.055, 0, { key: "pickup", interval: 0.1 });
    if (game.elapsed >= this.nextTideBell) { this.playTone(392, 523, 0.38, 0.09, 0, { key: "tide-low" }); this.playTone(523, 659, 0.38, 0.08, 0.17, { key: "tide-high" }); this.nextTideBell += 60; }
    this.previousHealth = player.health; this.previousKills = game.kills; this.previousLevel = player.level;
    this.previousDashCooldown = player.dashCooldown; this.previousGemCount = game.gems.length;
    const critical = player.health / Math.max(1, player.maxHealth) < 0.3;
    this.audio.setAmbientLevel(game.state === "playing" ? (critical ? 0.055 : 0.04) : 0.012);
    this.startHeartbeat();
  }

  toggleSound() {
    if (this.disposed) return Promise.resolve(false);
    if (this.audio.ready) { this.audio.setEnabled(false); this.profile.preferences.sound = false; this.persistProfile(); this.toast("声音已静音"); return Promise.resolve(false); }
    this.profile.preferences.sound = true; this.persistProfile(); this.audio.setEnabled(true); return this.resumeAudioFromGesture();
  }

  pauseRun() { if (this.game.state !== "playing" || this.metaOpen || this.tutorialOpen) return; this.pausedByVisibility = false; this.game.pause(); this.renderPause(); this.show("pause"); }
  resumeRun(cue = true) { if (this.disposed || this.game.state !== "paused" || this.metaOpen || this.tutorialOpen) return; this.resumeAudioFromGesture(cue, cue); this.pausedByVisibility = false; this.game.resume(); this.hideAll(); }

  openMeta(tab = "meta") {
    if (!this.metaUI || this.metaOpen || this.tutorialOpen) return;
    const wasPlaying = this.game.state === "playing";
    if (wasPlaying) this.pauseRun();
    const previousFocus = document.activeElement;
    this.metaOpen = true;
    this.setUnderlayInert(true);
    this.metaUI.tab = tab;
    this.metaUI.onClose = () => {
      this.metaOpen = false; this.setUnderlayInert(false); this.renderCharacterPicker();
      if (wasPlaying && this.game.state === "paused") this.resumeRun();
      else previousFocus?.focus?.();
    };
    this.metaUI.setRunProgress?.(this.game);
    this.metaUI.setSave(this.profile);
    this.metaUI.setVisible(true);
  }

  setUnderlayInert(inert) {
    for (const element of [this.elements.title, this.elements.level, this.elements.pause, this.elements.result, $("#chest-screen")]) {
      if (element) element.inert = inert;
    }
  }

  openTutorial() {
    // Audio unit tests use a minimal DOM without element creation or dialogs.
    const screen = $("#tutorial-screen");
    if (!screen || typeof document.createElement !== "function" || this.metaOpen || this.tutorialOpen) return;
    this.tutorialWasPlaying = this.game.state === "playing";
    if (this.tutorialWasPlaying) this.pauseRun();
    this.tutorialFocus = document.activeElement;
    this.tutorialOpen = true; this.setUnderlayInert(true);
    screen.classList.remove("hidden"); screen.classList.add("is-visible");
    $("#tutorial-close")?.focus?.();
  }

  closeTutorial() {
    if (!this.tutorialOpen) return;
    if ($("#tutorial-screen")?.contains?.(document.activeElement)) document.activeElement?.blur?.();
    $("#tutorial-screen")?.classList.add("hidden"); $("#tutorial-screen")?.classList.remove("is-visible");
    this.tutorialOpen = false; this.setUnderlayInert(false);
    this.profile.preferences.tutorialSeen = true; this.persistProfile();
    if (this.tutorialWasPlaying) this.resumeRun(); else this.tutorialFocus?.focus?.();
  }

  hideAll() { for (const element of [this.elements.title, this.elements.level, this.elements.pause, this.elements.result, this.elements.meta, $("#chest-screen")]) { if (!element) continue; if (element.contains?.(document.activeElement)) document.activeElement?.blur?.(); element.classList.add("hidden"); element.classList.remove("is-visible"); } }
  show(id) { if (this.metaOpen || this.tutorialOpen) return; this.hideAll(); const screen = this.elements[id] || $(`#${id}-screen`); if (!screen) return; screen.classList.remove("hidden"); screen.classList.add("is-visible"); screen.querySelector?.("button:not(:disabled)")?.focus?.(); }

  chooseUpgrade(id) {
    if (this.metaOpen || this.tutorialOpen) return;
    const chest = this.game.state === "chest";
    const choice = (chest ? this.game.chestChoices : this.game.upgradeChoices).find(item => item.id === id);
    if (!(chest ? this.game.chooseChestUpgrade(id) : this.game.chooseUpgrade(id))) return;
    this.hideAll(); this.toast(choice?.type === "evolve" ? `武器进化 · ${choice.name}` : `构筑成形 · ${choice?.name || "新力量"}`);
    if (this.game.state === "levelup") this.showLevelUp(this.game);
    else if (this.game.state === "chest") this.showChest(this.game);
  }
  reroll() { if (!this.metaOpen && !this.tutorialOpen && this.game.rerollUpgrades()) this.showLevelUp(this.game); }
  skipUpgrade() { if (!this.metaOpen && !this.tutorialOpen && this.game.skipUpgrade()) { this.hideAll(); if (this.game.state === "levelup") this.showLevelUp(this.game); } }

  render(game) {
    if (this.disposed) return;
    const player = game.player;
    setText(this.elements.clock, formatTime(game.elapsed));
    setWidth(this.elements.health, `${Math.max(0, 100 * player.health / player.maxHealth)}%`);
    setText(this.elements.healthText, `${Math.ceil(player.health)} / ${player.maxHealth}`);
    setWidth(this.elements.xp, `${Math.min(100, 100 * player.xp / player.xpNext)}%`);
    setText(this.elements.levelText, `LV. ${player.level}`);
    const minute = Math.floor(game.elapsed / 60);
    setText(this.elements.wave, minute >= 10 ? "永夜 · 无尽回响" : minute >= 3 ? "暗潮 · 首领猎场" : minute >= 1 ? "暗潮 · 群影来袭" : "潮汐逼近");
    setText($("#footer-hint"), game.character?.id === "warden" ? "环刃护身 · 空格闪避" : "自动攻击 · 空格闪避");
    this.syncFeedback(game);
    this.renderBuildHud(game);
    this.renderBossHud(game);
    this.renderEvent(game);
    if (this.metaOpen || this.tutorialOpen) return;
    if (game.state === "levelup" && !this.elements.level.classList.contains("is-visible")) this.showLevelUp(game);
    if (game.state === "chest" && !$("#chest-screen")?.classList.contains("is-visible")) this.showChest(game);
    if (game.state === "gameover" && !this.elements.result.classList.contains("is-visible")) this.showResult(game);
    if (game.state === "paused" && !this.elements.pause.classList.contains("is-visible")) { this.renderPause(); this.show("pause"); }
    if (game.state === "playing" && this.game.state === "playing" && this.elements.pause.classList.contains("is-visible")) this.hideAll();
  }

  renderBuildHud(game) {
    const hud = $("#build-hud");
    if (!hud) return;
    const signature = [...game.build.weapons.map(w => `${w.id}:${w.level}:${w.evolved}`), ...Object.entries(game.build.passives).map(([id, level]) => `${id}:${level}`), game.curse, game.rerollsRemaining].join("|");
    if (signature === this.lastBuildSignature) return;
    this.lastBuildSignature = signature;
    hud.innerHTML = `<div class="build-weapons" aria-label="武器">${game.build.weapons.filter(w => !w.hidden).map(w => {
      const definition = WEAPONS[w.id]; if (!definition) return "";
      const ready = !w.evolved && w.level >= definition.maxLevel && (game.build.passives[definition.passive] || 0) >= 3;
      const name = w.evolved ? definition.evolutionName : definition.name;
      const condition = this.evolutionCondition(w, game);
      return `<span class="build-chip ${w.evolved ? "evolved" : ready ? "evolution-ready" : ""}" data-weapon="${w.id}" title="${escapeHtml(condition)}" aria-label="${escapeHtml(`${name} ${w.evolved ? "EVO" : `等级 ${w.level}`}；${condition}`)}"><i>${definition.icon}</i><span>${name}</span><b>${w.evolved ? "EVO" : `Lv.${w.level}`}</b>${ready ? '<em>可进化</em>' : ""}</span>`;
    }).join("")}</div><div class="build-passives" aria-label="被动">${Object.entries(game.build.passives).map(([id, level]) => { const definition = PASSIVES[id]; return definition ? `<span data-passive="${id}" title="${escapeHtml(definition.desc)}" aria-label="${definition.name} 等级 ${level}"><i>${definition.icon}</i><span>${definition.name}</span><b>Lv.${level}</b></span>` : ""; }).join("") || '<span class="build-empty">被动 0 / 4</span>'}</div>${game.curse ? `<span class="curse-chip">诅咒 ×${game.curse}</span>` : ""}<span class="reroll-chip">⟳ ${game.rerollsRemaining}</span>`;
  }

  evolutionCondition(weapon, game = this.game) {
    const definition = WEAPONS[weapon.id];
    if (!definition) return "";
    if (weapon.evolved) return `已进化 · ${evolutionEffects[weapon.id] || definition.evolutionName}`;
    const passive = PASSIVES[definition.passive], level = game.build.passives[definition.passive] || 0;
    return `${definition.evolutionName}：${definition.name} ${weapon.level}/${definition.maxLevel} 级 + ${passive.name} ${level}/3 级${weapon.level >= definition.maxLevel && level >= 3 ? " ✓ 下次选择可进化" : ""}`;
  }

  choiceDescription(choice, game = this.game) {
    const supplied = typeof game.describeChoice === "function" ? game.describeChoice(choice) : choice.desc;
    if (typeof supplied === "string" && supplied) return supplied;
    const definition = WEAPONS[choice.target] || PASSIVES[choice.target];
    if (!definition) return choice.desc || "恢复生命，继续生存";
    const current = game.build.weapons.find(w => w.id === choice.target)?.level || game.build.passives[choice.target] || 0;
    if (choice.type === "evolve") return `${this.evolutionCondition({ id: choice.target, level: current }, game)}；${evolutionEffects[choice.target]}`;
    if (WEAPONS[choice.target]) {
      const damageAt = level => level ? definition.damage * (1 + (definition.growth || 0.18)) ** (level - 1) * game.player.damageMultiplier : 0;
      return `Lv.${current} → Lv.${current + 1} · 伤害 ${number(damageAt(current))} → ${number(damageAt(current + 1))}；${definition.desc}。进化：武器 Lv.${definition.maxLevel} + ${PASSIVES[definition.passive].name} Lv.3`;
    }
    const values = { might: [10, "伤害 +", "%"], tempo: [7, "武器间隔 -", "%"], area: [10, "范围 +", "%"], vitality: [15, "最大生命 +", ""], agility: [6, "移速 +", "%"], magnet: [25, "吸取范围 +", "%"] };
    const [step, label, unit] = values[choice.target];
    const weapon = Object.values(WEAPONS).find(w => w.passive === choice.target);
    return `Lv.${current} → Lv.${current + 1} · ${label}${current * step}${unit} → ${label}${(current + 1) * step}${unit}；${definition.desc}。协同：${definition.name} Lv.3 + ${weapon.name} Lv.${weapon.maxLevel} → ${weapon.evolutionName}`;
  }

  renderChoiceList(list, choices, game = this.game) {
    list.replaceChildren();
    for (const [index, choice] of choices.entries()) {
      const button = document.createElement("button");
      button.className = `upgrade-option ${choice.category || ""}`;
      const category = choice.category === "evolution" ? "进化 · 占原武器槽" : choice.category === "weapon" ? "武器" : choice.category === "passive" ? "被动" : "补给";
      button.innerHTML = `<span class="upgrade-index">${index + 1}</span><span class="upgrade-icon">${escapeHtml(choice.icon)}</span><span class="upgrade-text"><b>${escapeHtml(choice.name)}</b><small>${escapeHtml(this.choiceDescription(choice, game))}</small><em>${category}</em></span><span class="upgrade-arrow">↗</span>`;
      button.addEventListener("click", () => this.chooseUpgrade(choice.id));
      list.append(button);
    }
  }

  renderBossHud(game) {
    const hud = $("#boss-hud"), boss = game.boss;
    if (!hud) return;
    if (!boss) { hud.classList.add("hidden"); this.lastBossId = null; return; }
    hud.classList.remove("hidden");
    setText($("#boss-name"), boss.name || "潮汐首领");
    setText($("#boss-hp-text"), `${Math.ceil(boss.hp)} / ${Math.ceil(boss.maxHp)}`);
    setWidth($("#boss-hp"), `${Math.max(0, 100 * boss.hp / boss.maxHp)}%`);
    this.lastBossId = boss.id;
  }

  renderEvent(game) {
    const event = game.toastEvent;
    const hud = $("#event-hud");
    const signature = event ? `${event.at}:${event.text}` : "";
    if (!hud || !event || signature === this.lastEventAt) return;
    this.lastEventAt = signature; setText(hud, event.text); hud.classList.add("show");
    clearTimeout(this.eventTimer); this.eventTimer = setTimeout(() => hud.classList.remove("show"), 2600);
    this.playTone(260, 520, 0.3, 0.08, 0, { key: "event" });
    if (/3\s*秒后/.test(event.text)) this.playTone(660, 880, 0.22, 0.08, 0.17, { key: "director-warning" });
  }

  showLevelUp(game) {
    const list = $("#upgrade-list");
    if (!list) return;
    setText($("#level-sub"), `LV.${game.player.level} · 选择构筑方向 · 武器 ${game.activeWeapons.length}/4 · 被动 ${Object.keys(game.build.passives).length}/4`);
    setText($("#reroll-count"), `×${game.rerollsRemaining}`); setText($("#skip-count"), `×${game.skipsRemaining}`);
    $("#reroll").disabled = game.rerollsRemaining <= 0; $("#skip-upgrade").disabled = game.skipsRemaining <= 0;
    this.renderChoiceList(list, game.upgradeChoices, game);
    this.show("level");
  }

  showChest(game) {
    let screen = $("#chest-screen");
    if (!screen) {
      screen = document.createElement("section"); screen.id = "chest-screen"; screen.className = "overlay hidden";
      screen.setAttribute("role", "dialog"); screen.setAttribute("aria-modal", "true"); screen.setAttribute("aria-label", "夜潮宝箱三选一");
      screen.innerHTML = '<div class="modal-card level-card chest-card"><p class="eyebrow">TREASURE IN THE TIDE</p><h2>夜潮宝箱</h2><p class="modal-sub">仅强化已有构筑 · 按 1 / 2 / 3 选择</p><div class="upgrade-list"></div></div>';
      $("#game").append(screen);
    }
    this.renderChoiceList(screen.querySelector(".upgrade-list"), game.chestChoices, game);
    this.show("chest");
  }

  renderPause() {
    const container = $("#pause-build"), game = this.game;
    if (!container) return;
    container.innerHTML = `<div class="pause-weapons"><small>武器 ${game.activeWeapons.length} / 4 · 进化目标</small>${game.activeWeapons.map(w => {
      const definition = WEAPONS[w.id];
      return `<article class="pause-weapon ${w.evolved ? "evolved" : ""}"><b>${definition.icon} ${w.evolved ? definition.evolutionName : definition.name} · ${w.evolved ? "EVO" : `Lv.${w.level}`}</b><p>${escapeHtml(this.evolutionCondition(w, game))}</p><progress max="8" value="${w.evolved ? 8 : Math.min(definition.maxLevel, w.level) + Math.min(3, game.build.passives[definition.passive] || 0)}" aria-label="${definition.evolutionName}条件进度"></progress></article>`;
    }).join("")}</div><div class="pause-passives"><small>被动 ${Object.keys(game.build.passives).length} / 4</small>${Object.entries(game.build.passives).map(([id, level]) => `<article><b>${PASSIVES[id].icon} ${PASSIVES[id].name} · Lv.${level}</b><p>每级：${PASSIVES[id].desc}</p></article>`).join("") || "<em>尚未选择 · 升级时补足协同条件</em>"}</div><p class="pause-meta-note">永久刻印和角色选择将在下一局生效。</p>`;
  }

  showResult(game) {
    if (this.metaOpen || this.tutorialOpen) return;
    const summary = game.summary || game.finishRun(true, "died");
    const saved = this.applyRunResult(summary);
    this.profile = saved;
    if (this.metaUI) this.metaUI.setSave(saved);
    setText($("#result-title"), summary.reason === "evacuated" ? "撤离 · 潮声回响" : "夜尽 · 回响");
    setText($("#result-copy"), summary.reason === "evacuated" ? "你带着已经成形的构筑离开夜色。回响已被记下。" : "构筑留在夜里，回响跟随你归来。");
    setText($("#final-time"), formatTime(summary.seconds)); setText($("#final-kills"), String(summary.kills)); setText($("#final-level"), `LV. ${summary.level}`);
    const ids = summary.achievementIds || summary.achievements || [];
    const result = $("#echo-result");
    if (result) result.innerHTML = `<span>本局回响 <b>✧ ${summary.echoes}</b></span><small>其中成就 +${positive(summary.achievementEchoes)}${ids.length ? ` · ${ids.map(id => escapeHtml(ACHIEVEMENTS[id]?.name || Object.values(ACHIEVEMENTS).find(a => a.id === id)?.name || "新成就")).join("、")}` : ""}</small>`;
    this.show("result");
  }

  applyRunResult(summary) {
    if (!summary || typeof summary !== "object") return this.profile;
    const runId = summary.runId == null ? null : String(summary.runId);
    if (this.settledSummaries.has(summary) || (runId && this.settledRuns.has(runId))) return this.profile;
    const next = structuredClone(this.profile);
    next.echoes += positive(summary.echoes);
    next.stats.runs += 1; next.stats.bestTime = Math.max(next.stats.bestTime, positive(summary.seconds)); next.stats.bestKills = Math.max(next.stats.bestKills, positive(summary.kills));
    next.stats.bosses += positive(summary.bosses); next.stats.evolutions += positive(summary.evolutions);
    for (const id of summary.achievementIds || summary.achievements || []) next.achievements[id] = true;
    const saved = this.persistProfile(next);
    this.settledSummaries.add(summary); if (runId) this.settledRuns.add(runId);
    return saved;
  }

  toast(text) { if (this.disposed) return; setText(this.elements.toast, text); this.elements.toast.classList.add("show"); if (this.toastTimer !== null) clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { this.elements.toast.classList.remove("show"); this.toastTimer = null; }, 1700); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners) remove(); this.listeners = [];
    this.clearIntro(); if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer); if (this.toastTimer !== null) clearTimeout(this.toastTimer); clearTimeout(this.eventTimer);
    this.heartbeatTimer = null; this.toastTimer = null; this.audio.dispose();
  }
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
