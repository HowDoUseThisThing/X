import { defaultSave, normalizeSave } from "../game/progression.js";
import { CHARACTERS, META_UPGRADES, ACHIEVEMENTS } from "../game/content.js";

export class MetaUI {
  constructor(root, { save, onChange }) {
    this.root = root; this.save = normalizeSave(save); this.onChange = onChange;
    this.tab = "meta"; this.visible = false; this.runProgress = null; this.render();
  }

  setRunProgress(game) {
    this.runProgress = game && game.state !== "title" ? {
      seconds: game.elapsed, kills: game.kills, bosses: game.bossKills, evolutions: game.evolutions,
      weapons: game.activeWeapons.length, passives: Object.keys(game.build.passives).length,
      achievementIds: [...(game.summary?.achievementIds || game.earnedAchievements || [])],
    } : null;
  }

  setSave(save) { this.save = normalizeSave(save); this.render(); }
  setVisible(visible) {
    const wasVisible = this.visible;
    this.visible = visible;
    this.root.classList.toggle("hidden", !visible);
    this.root.classList.toggle("is-visible", visible);
    if (visible) this.root.querySelector("[data-tab].active")?.focus?.();
    if (!visible && wasVisible) this.onClose?.();
  }

  render() {
    const save = this.save;
    const focused = this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusSelector = focused?.dataset.buy ? `[data-buy="${focused.dataset.buy}"]` : focused?.dataset.character ? `[data-character="${focused.dataset.character}"]` : focused?.dataset.tab ? `[data-tab="${focused.dataset.tab}"]` : null;
    this.root.setAttribute("role", "dialog"); this.root.setAttribute("aria-modal", "true");
    this.root.innerHTML = `
      <div class="meta-card">
        <div class="meta-head"><div><p class="eyebrow">THE ECHO ARCHIVE</p><h2>潮回声廊</h2></div><div class="echo-balance"><small>回响</small><b>✧ ${save.echoes}</b></div></div>
        <nav class="meta-tabs" aria-label="局外成长">
          <button data-tab="meta" aria-pressed="${this.tab === "meta"}" class="${this.tab === "meta" ? "active" : ""}">永久刻印</button>
          <button data-tab="characters" aria-pressed="${this.tab === "characters"}" class="${this.tab === "characters" ? "active" : ""}">角色</button>
          <button data-tab="achievements" aria-pressed="${this.tab === "achievements"}" class="${this.tab === "achievements" ? "active" : ""}">成就</button>
        </nav>
        <p class="meta-next-run">永久刻印、解锁与角色选择：下一局生效。本局构筑和成就进度会保留。</p>
        <div class="meta-content">${this.tab === "meta" ? this.renderMeta() : this.tab === "characters" ? this.renderCharacters() : this.renderAchievements()}</div>
        <button class="primary-btn meta-close" id="meta-close">返回夜潮 <span>→</span></button>
      </div>`;
    this.root.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => { this.tab = button.dataset.tab; this.render(); }));
    this.root.querySelector("#meta-close")?.addEventListener("click", () => this.setVisible(false));
    this.root.querySelectorAll("[data-buy]").forEach(button => button.addEventListener("click", () => this.onChange("buy", button.dataset.buy)));
    this.root.querySelectorAll("[data-character]").forEach(button => button.addEventListener("click", () => this.onChange("character", button.dataset.character)));
    if (this.visible && focusSelector) {
      const target = this.root.querySelector(focusSelector);
      (target && !target.disabled ? target : this.root.querySelector("#meta-close"))?.focus?.();
    }
  }

  renderMeta() {
    return `<div class="meta-grid">${Object.values(META_UPGRADES).map(item => {
      const level = this.save.meta[item.id] || 0, maxed = level >= item.max, cost = item.cost(level), afford = this.save.echoes >= cost;
      return `<article class="meta-item"><div class="meta-icon">${item.icon}</div><div class="meta-copy"><b>${item.name} · ${level}/${item.max}</b><small>每级：${item.desc}</small><div class="meta-level">${Array.from({ length: item.max }, (_, i) => `<i class="${i < level ? "on" : ""}"></i>`).join("")}</div></div><button data-buy="${item.id}" aria-label="${item.name} ${maxed ? "已满级" : `购买下一级，${cost} 回响，下一局生效`}" ${maxed || !afford ? "disabled" : ""}>${maxed ? "已满级" : `购买 ✦ ${cost}`}</button></article>`;
    }).join("")}</div>`;
  }

  renderCharacters() {
    return `<div class="character-list">${Object.values(CHARACTERS).map(item => {
      const unlocked = this.save.unlocked[item.id], selected = this.save.preferences.character === item.id, afford = this.save.echoes >= item.cost;
      return `<article class="character-card ${selected ? "selected" : ""}"><div class="character-icon">${item.icon}</div><div><b>${item.name}</b><small>${item.desc}</small></div><button data-character="${item.id}" ${!unlocked && !afford ? "disabled" : ""}>${!unlocked ? `解锁 ✦ ${item.cost}` : selected ? "当前角色" : "选择"}</button></article>`;
    }).join("")}</div>`;
  }

  renderAchievements() {
    const run = this.runProgress, stats = this.save.stats;
    const seconds = Math.max(stats.bestTime, run?.seconds || 0), kills = Math.max(stats.bestKills, run?.kills || 0);
    const time = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
    return `<div class="achievement-list">${Object.entries(ACHIEVEMENTS).map(([id, item]) => {
      const earned = this.save.achievements[id], pending = !earned && run?.achievementIds.includes(id);
      let current = 0, goal = 1, text = "";
      if (id === "dawn" || id === "endless") { goal = id === "dawn" ? 180 : 600; current = Math.min(goal, seconds); text = `${time(current)} / ${time(goal)}`; }
      else if (id === "river") { goal = 500; current = Math.min(goal, kills); text = `${current} / ${goal} 击杀`; }
      else if (id === "evolution") { current = Math.min(1, stats.evolutions + (run?.evolutions || 0)); text = `${current} / 1 次进化`; }
      else if (id === "boss") { current = Math.min(1, stats.bosses + (run?.bosses || 0)); text = `${current} / 1 位首领`; }
      else if (id === "build") { goal = 8; const weapons = earned ? 4 : run?.weapons || 0, passives = earned ? 4 : run?.passives || 0; current = weapons + passives; text = `本局武器 ${weapons}/4 · 被动 ${passives}/4`; }
      const status = earned ? "已解锁" : pending ? "本局达成 · 待结算" : "挑战进行中";
      return `<article class="${earned ? "earned" : pending ? "pending" : ""}"><span>${earned ? "✦" : pending ? "✧" : "◇"}</span><div><b>${item.name}</b><small>${item.desc}</small><small class="achievement-progress">${text} · ${status}</small><progress max="${goal}" value="${earned || pending ? goal : current}" aria-label="${item.name}进度"></progress></div><i>${earned ? "奖励已领取" : `+${item.reward} 回响`}</i></article>`;
    }).join("")}</div><p class="meta-stats">累计 ${stats.runs} 局 · 最佳 ${time(stats.bestTime)} · 最高击杀 ${stats.bestKills}</p>`;
  }
}

export { defaultSave };
