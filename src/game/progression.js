import { ACHIEVEMENTS } from "./content.js";

export const SAVE_KEY = "moonlit-survivor-save-v1";
export const SAVE_VERSION = 1;

const META_LIMITS = Object.freeze({ life: 5, ember: 5, light: 5, fate: 2, fortune: 5 });

// Read only schema fields; malformed records and inherited data are not save data.
function field(value, key) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
      ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function nonNegativeNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.max(0, Math.min(max, number)) : 0;
}

const nonNegativeInteger = (value, max) => Math.floor(nonNegativeNumber(value, max));

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    echoes: 0,
    meta: { life: 0, ember: 0, light: 0, fate: 0, fortune: 0 },
    unlocked: { ranger: true, warden: false, oracle: false },
    achievements: {},
    stats: { runs: 0, bestTime: 0, bestKills: 0, bosses: 0, evolutions: 0 },
    preferences: { character: "ranger", sound: true, tutorialSeen: false },
  };
}

export function normalizeSave(value) {
  if (field(value, "version") !== SAVE_VERSION) return defaultSave();
  const meta = field(value, "meta"), achievements = field(value, "achievements");
  const stats = field(value, "stats"), preferences = field(value, "preferences");
  const savedUnlocks = field(value, "unlocked");
  const unlocked = {
    ranger: true,
    warden: field(savedUnlocks, "warden") === true,
    oracle: field(savedUnlocks, "oracle") === true,
  };
  const character = field(preferences, "character");
  return {
    version: SAVE_VERSION,
    echoes: nonNegativeInteger(field(value, "echoes")),
    meta: Object.fromEntries(Object.entries(META_LIMITS).map(([id, max]) => [id, nonNegativeInteger(field(meta, id), max)])),
    unlocked,
    achievements: Object.fromEntries(Object.keys(ACHIEVEMENTS).filter(id => field(achievements, id) === true).map(id => [id, true])),
    stats: {
      runs: nonNegativeInteger(field(stats, "runs")),
      bestTime: nonNegativeNumber(field(stats, "bestTime")),
      bestKills: nonNegativeInteger(field(stats, "bestKills")),
      bosses: nonNegativeInteger(field(stats, "bosses")),
      evolutions: nonNegativeInteger(field(stats, "evolutions")),
    },
    preferences: {
      character: typeof character === "string" && Object.hasOwn(unlocked, character) && unlocked[character] ? character : "ranger",
      sound: field(preferences, "sound") !== false,
      tutorialSeen: field(preferences, "tutorialSeen") === true,
    },
  };
}

export class SaveStore {
  constructor(storage) {
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; }
    catch { this.storage = null; }
    this.memory = defaultSave();
    this.pendingWrite = false;
  }

  load() {
    // A failed write/clear must not resurrect an older persistent save.
    if (this.pendingWrite || !this.storage) return normalizeSave(this.memory);
    let raw;
    try {
      raw = this.storage.getItem(SAVE_KEY);
    } catch {
      return normalizeSave(this.memory);
    }
    try { this.memory = raw ? normalizeSave(JSON.parse(raw)) : defaultSave(); }
    catch { this.memory = defaultSave(); }
    return normalizeSave(this.memory);
  }

  save(value) {
    const normalized = normalizeSave(value);
    this.memory = normalized;
    this.pendingWrite = true;
    try {
      if (this.storage) {
        this.storage.setItem(SAVE_KEY, JSON.stringify(normalized));
        this.pendingWrite = false;
      }
    } catch { /* keep playing with the in-memory save */ }
    return normalizeSave(normalized);
  }

  clear() {
    this.memory = defaultSave();
    this.pendingWrite = true;
    try {
      if (this.storage) {
        this.storage.removeItem(SAVE_KEY);
        this.pendingWrite = false;
      }
    } catch { /* keep the in-memory reset even when storage is unavailable */ }
  }
}

export function calcEchoes(result = {}) {
  const level = field(result, "level");
  const raw = nonNegativeNumber(field(result, "kills")) * 0.6 + nonNegativeNumber(field(result, "seconds")) * 0.35
    + nonNegativeNumber(field(result, "bosses")) * 40 + nonNegativeNumber(level === undefined ? 1 : level) * 3
    + nonNegativeNumber(field(result, "chests")) * 8;
  const bonus = 1 + Math.min(0.6, nonNegativeNumber(field(result, "altarRanks")) * 0.1);
  return nonNegativeInteger(raw * bonus * (field(result, "died") ? 0.8 : 1));
}

export function purchaseMeta(save, id, catalog) {
  const normalized = normalizeSave(save);
  const denied = { save: normalized, purchased: false };
  if (typeof id !== "string" || !Object.hasOwn(META_LIMITS, id)) return denied;
  const item = field(catalog, id), max = field(item, "max"), price = field(item, "cost");
  const level = normalized.meta[id];
  if (!Number.isSafeInteger(max) || max < 1 || level >= Math.min(max, META_LIMITS[id]) || typeof price !== "function") return denied;
  let cost;
  try { cost = price.call(item, level); } catch { return denied; }
  if (!Number.isSafeInteger(cost) || cost < 0 || normalized.echoes < cost) return denied;
  normalized.echoes -= cost;
  normalized.meta[id] = level + 1;
  return { save: normalized, purchased: true };
}

export function unlockCharacter(save, id, characters) {
  const normalized = normalizeSave(save);
  const denied = { save: normalized, unlocked: false };
  if (typeof id !== "string" || !Object.hasOwn(normalized.unlocked, id) || normalized.unlocked[id]) return denied;
  const cost = field(field(characters, id), "cost");
  if (!Number.isSafeInteger(cost) || cost < 0 || normalized.echoes < cost) return denied;
  normalized.echoes -= cost;
  normalized.unlocked[id] = true;
  return { save: normalized, unlocked: true };
}
