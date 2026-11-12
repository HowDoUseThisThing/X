export const WEAPONS = Object.freeze({
  moonArrow: Object.freeze({ id: "moonArrow", icon: "➶", name: "月痕箭", category: "weapon", maxLevel: 5, passive: "might", evolution: "moonEclipse", evolutionName: "月蚀连星", kind: "projectile", damage: 22, growth: 0.18, interval: 0.62, speed: 460, shots: 1, pierce: 0, radius: 5, color: "#ffd9ad", desc: "+18% 伤害；Lv2/4 +1 弹体；Lv3 +1 穿透" }),
  orbitBlade: Object.freeze({ id: "orbitBlade", icon: "◌", name: "环葬刃", category: "weapon", maxLevel: 5, passive: "area", evolution: "eternalWaltz", evolutionName: "永夜轮舞", kind: "orbit", damage: 18, growth: 0.2, interval: 0.42, radius: 64, blades: 2, color: "#bda7ff", desc: "+20% 伤害；每 2 级 +1 刀刃；范围 +8" }),
  tideNova: Object.freeze({ id: "tideNova", icon: "◉", name: "潮汐新星", category: "weapon", maxLevel: 5, passive: "tempo", evolution: "deepEcho", evolutionName: "深海回响", kind: "nova", damage: 28, growth: 0.22, interval: 2.4, radius: 86, color: "#84dcd8", desc: "+22% 伤害；半径 +14；Lv4 间隔 -20%" }),
  chainSpark: Object.freeze({ id: "chainSpark", icon: "ϟ", name: "引雷针", category: "weapon", maxLevel: 5, passive: "magnet", evolution: "skyPrison", evolutionName: "天穹雷狱", kind: "chain", damage: 30, growth: 0.24, interval: 1.8, range: 280, jump: 130, jumps: 2, color: "#a9e9ff", desc: "+24% 伤害；Lv2/4 +1 跳跃" }),
  graveField: Object.freeze({ id: "graveField", icon: "▧", name: "墓土领域", category: "weapon", maxLevel: 5, passive: "vitality", evolution: "rotThrone", evolutionName: "腐土王座", kind: "field", damage: 10, growth: 0.2, interval: 3.2, radius: 55, duration: 4, areas: 1, color: "#a3bd70", desc: "+20% 伤害；每 2 级 +1 区域；半径 +8" }),
  echoBoomerang: Object.freeze({ id: "echoBoomerang", icon: "↻", name: "回声轮", category: "weapon", maxLevel: 5, passive: "agility", evolution: "endlessEcho", evolutionName: "无尽回声", kind: "boomerang", damage: 32, growth: 0.22, interval: 1.6, distance: 320, speed: 340, count: 1, color: "#f1b7cf", desc: "+22% 伤害；Lv3 +1 回声轮；往返距离 +30" }),
});

export const PASSIVES = Object.freeze({
  might: Object.freeze({ id: "might", icon: "✹", name: "余烬共鸣", category: "passive", maxLevel: 5, desc: "全武器伤害 +10%" }),
  tempo: Object.freeze({ id: "tempo", icon: "⟡", name: "潮汐节拍", category: "passive", maxLevel: 5, desc: "武器间隔 -7%" }),
  area: Object.freeze({ id: "area", icon: "◉", name: "引力余波", category: "passive", maxLevel: 5, desc: "范围效果 +10%，弹体体积 +8%" }),
  vitality: Object.freeze({ id: "vitality", icon: "♥", name: "月蚀庇护", category: "passive", maxLevel: 5, desc: "最大生命 +15，立刻回复 15" }),
  agility: Object.freeze({ id: "agility", icon: "➤", name: "逐浪步伐", category: "passive", maxLevel: 5, desc: "移速 +6%，闪避冷却 -4%" }),
  magnet: Object.freeze({ id: "magnet", icon: "◎", name: "拾光磁场", category: "passive", maxLevel: 5, desc: "吸取范围 +25%，经验 +5%" }),
});

export const CHARACTERS = Object.freeze({
  ranger: Object.freeze({ id: "ranger", icon: "➶", name: "月蚀游侠", weapon: "moonArrow", cost: 0, desc: "初始重抽 +1，属性均衡", health: 100, speed: 190, area: 1, xp: 1 }),
  warden: Object.freeze({ id: "warden", icon: "◌", name: "灰烬守夜人", weapon: "orbitBlade", cost: 400, desc: "+30 生命，近战范围 +10%，移速 -5%", health: 130, speed: 180, area: 1.1, xp: 1 }),
  oracle: Object.freeze({ id: "oracle", icon: "◉", name: "潮汐秘术师", weapon: "tideNova", cost: 700, desc: "+15% 范围，-15 生命，经验 +10%", health: 85, speed: 190, area: 1.15, xp: 1.1 }),
});

// behavior: chase | ranged | charge | bomb | split | wraith
export const ENEMIES = Object.freeze({
  shade: Object.freeze({ id: "shade", behavior: "chase", hp: 28, speed: 38, radius: 12, damage: 9, color: "#b2a0ee", xp: 1, weight: 0.28 }),
  runner: Object.freeze({ id: "runner", behavior: "chase", hp: 18, speed: 62, radius: 9, damage: 7, color: "#ff7990", xp: 1, weight: 0.22 }),
  brute: Object.freeze({ id: "brute", behavior: "chase", hp: 86, speed: 25, radius: 19, damage: 17, color: "#d17fba", xp: 3, weight: 0.12 }),
  wraith: Object.freeze({ id: "wraith", behavior: "wraith", hp: 38, speed: 49, radius: 14, damage: 12, color: "#71d5cf", xp: 2, weight: 0.11 }),
  gunner: Object.freeze({ id: "gunner", behavior: "ranged", hp: 42, speed: 34, radius: 13, damage: 10, color: "#f4bd77", xp: 2, weight: 0.09, minMinute: 1 }),
  charger: Object.freeze({ id: "charger", behavior: "charge", hp: 55, speed: 35, radius: 15, damage: 14, color: "#e58d5b", xp: 2, weight: 0.08, minMinute: 2 }),
  splitter: Object.freeze({ id: "splitter", behavior: "split", hp: 60, speed: 31, radius: 17, damage: 11, color: "#bbdf83", xp: 2, weight: 0.06, minMinute: 2 }),
  bomber: Object.freeze({ id: "bomber", behavior: "bomb", hp: 48, speed: 45, radius: 14, damage: 8, color: "#dfd16c", xp: 2, weight: 0.05, minMinute: 3 }),
});

export const BOSSES = Object.freeze({
  colossus: Object.freeze({ id: "colossus", name: "潮汐巨像", hp: 1650, speed: 24, radius: 34, damage: 24, color: "#72b7d4", xp: 35, phase: 0 }),
  executioner: Object.freeze({ id: "executioner", name: "雾中执刑者", hp: 2300, speed: 29, radius: 38, damage: 30, color: "#e08da6", xp: 45, phase: 1 }),
});

export const META_UPGRADES = Object.freeze({
  life: Object.freeze({ id: "life", icon: "♥", name: "生命刻印", max: 5, cost: level => 120 * (level + 1), desc: "最大生命 +3%" }),
  ember: Object.freeze({ id: "ember", icon: "✹", name: "余烬刻印", max: 5, cost: level => 150 * (level + 1), desc: "全部伤害 +3%" }),
  light: Object.freeze({ id: "light", icon: "✦", name: "拾光刻印", max: 5, cost: level => 130 * (level + 1), desc: "经验获取 +3%" }),
  fate: Object.freeze({ id: "fate", icon: "⟳", name: "命运刻印", max: 2, cost: level => 500 + level * 300, desc: "每局重抽次数 +1" }),
  fortune: Object.freeze({ id: "fortune", icon: "◇", name: "财富刻印", max: 5, cost: level => 160 * (level + 1), desc: "拾取物掉落率 +2%" }),
});

export const ACHIEVEMENTS = Object.freeze({
  dawn: Object.freeze({ id: "dawn", name: "初见黎明", desc: "存活 3 分钟", reward: 100 }),
  river: Object.freeze({ id: "river", name: "星火成河", desc: "单局击杀 500", reward: 150 }),
  evolution: Object.freeze({ id: "evolution", name: "进化之火", desc: "完成任意武器进化", reward: 200 }),
  boss: Object.freeze({ id: "boss", name: "夜潮驯服者", desc: "击败首个首领", reward: 250 }),
  build: Object.freeze({ id: "build", name: "构筑大师", desc: "集齐 4 武器 + 4 被动", reward: 300 }),
  endless: Object.freeze({ id: "endless", name: "无尽回响", desc: "存活 10 分钟", reward: 300 }),
});

export const ALTARS = Object.freeze([
  Object.freeze({ id: "altar-west", name: "潮痕祭坛", x: -980, y: -520, radius: 44 }),
  Object.freeze({ id: "altar-north", name: "断月祭坛", x: 1080, y: -660, radius: 44 }),
  Object.freeze({ id: "altar-south", name: "沉钟祭坛", x: 140, y: 840, radius: 44 }),
]);

export const PICKUP_TYPES = Object.freeze({
  heart: Object.freeze({ id: "heart", icon: "♥", color: "#f18ca7", name: "心之滴" }),
  magnet: Object.freeze({ id: "magnet", icon: "◎", color: "#9de2d6", name: "潮汐磁石" }),
  holy: Object.freeze({ id: "holy", icon: "✧", color: "#e9df9b", name: "圣水" }),
  bomb: Object.freeze({ id: "bomb", icon: "✹", color: "#f0a56d", name: "余烬炸弹" }),
  chest: Object.freeze({ id: "chest", icon: "▣", color: "#ffd77a", name: "夜潮宝箱" }),
});
