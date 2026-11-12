import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_KEY, SAVE_VERSION, defaultSave, normalizeSave, SaveStore,
  calcEchoes, purchaseMeta, unlockCharacter,
} from "../src/game/progression.js";
import { ACHIEVEMENTS, CHARACTERS, META_UPGRADES } from "../src/game/content.js";

function memoryStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
  };
}

function earnedSave() {
  return {
    version: SAVE_VERSION,
    echoes: 4200,
    meta: { life: 3, ember: 2, light: 4, fate: 2, fortune: 1 },
    unlocked: { ranger: true, warden: true, oracle: false },
    achievements: { dawn: true, boss: true },
    stats: { runs: 7, bestTime: 613.25, bestKills: 901, bosses: 4, evolutions: 2 },
    preferences: { character: "warden", sound: false, tutorialSeen: true },
  };
}

describe("save normalization", () => {
  it("returns independent defaults and preserves a valid profile without mutating it", () => {
    const save = earnedSave(), before = structuredClone(save);
    const normalized = normalizeSave(save);
    assert.deepEqual(normalized, before);
    normalized.meta.life = 5;
    normalized.unlocked.oracle = true;
    normalized.achievements.river = true;
    assert.deepEqual(save, before);
    const first = defaultSave();
    first.meta.life = 5;
    first.preferences.character = "oracle";
    assert.deepEqual(normalizeSave(null), defaultSave());
  });

  it("rejects malformed roots and missing, old, future or incorrectly typed versions", () => {
    for (const value of [undefined, null, false, 42, "save", [], [earnedSave()], new Date()]) {
      assert.deepEqual(normalizeSave(value), defaultSave());
    }
    for (const version of [undefined, null, 0, SAVE_VERSION + 1, String(SAVE_VERSION), NaN, Infinity]) {
      assert.deepEqual(normalizeSave({ ...earnedSave(), version }), defaultSave());
    }
  });

  it("defaults malformed nested records instead of treating arrays or primitives as records", () => {
    const array = Object.assign([], { life: 5, ranger: false, warden: true, dawn: true, runs: 10, character: "warden", sound: false });
    for (const value of [null, false, true, 100, "corrupt", array]) {
      assert.deepEqual(normalizeSave({
        version: SAVE_VERSION, meta: value, unlocked: value, achievements: value, stats: value, preferences: value,
      }), defaultSave());
    }
  });

  it("rejects inherited fields and handles throwing getters and numeric coercion hooks", () => {
    const corruptNumber = { [Symbol.toPrimitive]() { throw new Error("do not coerce objects"); } };
    const save = {
      version: SAVE_VERSION,
      echoes: corruptNumber,
      meta: Object.create({ life: 5 }),
      unlocked: Object.create({ warden: true }),
      achievements: Object.create({ dawn: true }),
      stats: { runs: corruptNumber },
      preferences: Object.create({ sound: false, tutorialSeen: true }),
    };
    Object.defineProperty(save.meta, "ember", { get() { throw new Error("bad field"); } });
    assert.deepEqual(normalizeSave(save), defaultSave());
    assert.deepEqual(normalizeSave(Object.create(earnedSave())), defaultSave());
  });

  it("removes nonfinite and malformed values from every numeric save field", () => {
    for (const invalid of [NaN, Infinity, -Infinity, "Infinity", "-Infinity", "NaN", "1e999", "broken", {}, [], [12], true, 12n, Symbol("number")]) {
      const save = earnedSave();
      save.echoes = invalid;
      for (const key of Object.keys(save.meta)) save.meta[key] = invalid;
      for (const key of Object.keys(save.stats)) save.stats[key] = invalid;
      const normalized = normalizeSave(save);
      assert.equal(normalized.echoes, 0);
      assert.deepEqual(normalized.meta, defaultSave().meta);
      assert.deepEqual(normalized.stats, defaultSave().stats);
      assert.deepEqual(normalizeSave(JSON.parse(JSON.stringify(normalized))), normalized);
    }
  });

  it("floors counters, keeps fractional time, clamps levels and saturates huge finite numbers", () => {
    const save = earnedSave();
    save.echoes = "123.9";
    save.meta = { life: 99, ember: -3, light: 2.9, fate: 99, fortune: "4" };
    save.stats = { runs: "7.8", bestTime: "45.75", bestKills: -99, bosses: 4.8, evolutions: 1.9 };
    const normalized = normalizeSave(save);
    assert.equal(normalized.echoes, 123);
    assert.deepEqual(normalized.meta, { life: 5, ember: 0, light: 2, fate: 2, fortune: 4 });
    assert.deepEqual(normalized.stats, { runs: 7, bestTime: 45.75, bestKills: 0, bosses: 4, evolutions: 1 });
    save.echoes = Number.MAX_VALUE;
    for (const key of Object.keys(save.stats)) save.stats[key] = Number.MAX_VALUE;
    const saturated = normalizeSave(save);
    assert.equal(saturated.echoes, Number.MAX_SAFE_INTEGER);
    assert.ok(Object.values(saturated.stats).every(value => value === Number.MAX_SAFE_INTEGER));
    assert.deepEqual(normalizeSave(saturated), saturated);
  });

  it("falls back to ranger unless the preferred character is known and explicitly unlocked", () => {
    for (const character of ["warden", "oracle", "unknown", "__proto__", "constructor", {}, ["warden"]]) {
      const save = defaultSave();
      save.preferences.character = character;
      assert.equal(normalizeSave(save).preferences.character, "ranger");
    }
    for (const id of ["warden", "oracle"]) {
      const save = defaultSave();
      save.preferences.character = id;
      for (const unlocked of [false, "false", "true", 1, {}, []]) {
        save.unlocked[id] = unlocked;
        assert.equal(normalizeSave(save).preferences.character, "ranger");
        assert.equal(normalizeSave(save).unlocked[id], false);
      }
      save.unlocked[id] = true;
      assert.equal(normalizeSave(save).preferences.character, id);
    }
    assert.equal(normalizeSave({ ...defaultSave(), unlocked: { ranger: false } }).unlocked.ranger, true);
  });

  it("keeps only catalog achievement keys that are explicitly true", () => {
    const achievements = JSON.parse('{"__proto__":true,"constructor":true,"toString":true,"unknown":true,"wraith":true}');
    for (const id of Object.keys(ACHIEVEMENTS)) achievements[id] = true;
    assert.deepEqual(normalizeSave({ ...defaultSave(), achievements }).achievements,
      Object.fromEntries(Object.keys(ACHIEVEMENTS).map(id => [id, true])));
    for (const earned of [false, 1, "true", [], {}, null]) {
      assert.deepEqual(normalizeSave({ ...defaultSave(), achievements: { dawn: earned } }).achievements, {});
    }
    assert.equal(Object.hasOwn(normalizeSave({ ...defaultSave(), achievements }).achievements, "boss"), true);
    assert.equal({}.polluted, undefined);
  });

  it("accepts null-prototype records and normalizes preference flags", () => {
    const save = Object.assign(Object.create(null), earnedSave());
    save.achievements = Object.assign(Object.create(null), { dawn: true });
    assert.deepEqual(normalizeSave(save).achievements, { dawn: true });
    save.preferences = { character: "warden", sound: null, tutorialSeen: "false" };
    assert.deepEqual(normalizeSave(save).preferences, { character: "warden", sound: true, tutorialSeen: false });
  });
});

describe("SaveStore persistence and memory fallback", () => {
  it("round-trips all fields through persistent storage and clears the save", () => {
    const storage = memoryStorage(), store = new SaveStore(storage), save = earnedSave();
    assert.deepEqual(store.load(), defaultSave());
    assert.deepEqual(store.save(save), save);
    assert.deepEqual(JSON.parse(storage.getItem(SAVE_KEY)), save);
    assert.deepEqual(new SaveStore(storage).load(), save);
    store.clear();
    assert.equal(storage.getItem(SAVE_KEY), null);
    assert.deepEqual(store.load(), defaultSave());
  });

  it("resets damaged JSON, malformed roots and incompatible stored versions", () => {
    const storage = memoryStorage(), store = new SaveStore(storage);
    for (const raw of ["{broken", "", "null", "[]", "42", '"save"',
      JSON.stringify({ ...earnedSave(), version: 0 }), JSON.stringify({ ...earnedSave(), version: SAVE_VERSION + 1 })]) {
      store.save(earnedSave());
      storage.setItem(SAVE_KEY, raw);
      assert.deepEqual(store.load(), defaultSave());
    }
  });

  it("sanitizes numeric overflow parsed from otherwise valid JSON", () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, '{"version":1,"echoes":1e999,"meta":{"fate":1e999},"stats":{"runs":1e999,"bestTime":1e999}}');
    const store = new SaveStore(storage);
    assert.deepEqual(store.load(), defaultSave());
    const save = earnedSave(); save.echoes = Infinity; save.stats.bestTime = NaN;
    const normalized = store.save(save);
    assert.equal(normalized.echoes, 0);
    assert.equal(normalized.stats.bestTime, 0);
    assert.deepEqual(new SaveStore(storage).load(), normalized);
  });

  it("starts when the default localStorage getter throws and keeps progress in memory", t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete globalThis.localStorage;
    });
    let accesses = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { accesses += 1; throw new Error("SecurityError"); },
    });
    const store = new SaveStore();
    assert.equal(accesses, 1);
    assert.deepEqual(store.load(), defaultSave());
    assert.deepEqual(store.save(earnedSave()), earnedSave());
    assert.deepEqual(store.load(), earnedSave());
    store.clear();
    assert.deepEqual(store.load(), defaultSave());
    assert.deepEqual(new SaveStore(memoryStorage()).load(), defaultSave());
    assert.equal(accesses, 1, "explicit storage must bypass the default getter");
  });

  it("uses the default localStorage when available", t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete globalThis.localStorage;
    });
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    new SaveStore().save(earnedSave());
    assert.deepEqual(new SaveStore().load(), earnedSave());
  });

  it("keeps saves playable when storage is absent or every operation throws", () => {
    const unavailable = () => { throw new Error("storage unavailable"); };
    for (const storage of [null, {}, { getItem: unavailable, setItem: unavailable, removeItem: unavailable }]) {
      const store = new SaveStore(storage);
      assert.deepEqual(store.load(), defaultSave());
      const bought = purchaseMeta({ ...store.load(), echoes: 1000 }, "life", META_UPGRADES);
      assert.equal(bought.purchased, true);
      store.save(bought.save);
      assert.equal(store.load().echoes, 880);
      const unlocked = unlockCharacter(store.load(), "warden", CHARACTERS);
      assert.equal(unlocked.unlocked, true);
      store.save(unlocked.save);
      assert.equal(store.load().echoes, 480);
      assert.equal(store.load().unlocked.warden, true);
      store.clear();
      assert.deepEqual(store.load(), defaultSave());
    }
  });

  it("retains the last readable save when reads later fail", () => {
    const storage = memoryStorage();
    new SaveStore(storage).save(earnedSave());
    const store = new SaveStore(storage);
    assert.deepEqual(store.load(), earnedSave());
    storage.getItem = () => { throw new Error("read failed"); };
    assert.deepEqual(store.load(), earnedSave());
    const next = { ...earnedSave(), echoes: 5000 };
    assert.deepEqual(store.save(next), next);
    assert.deepEqual(store.load(), next);
  });

  it("does not resurrect stale disk data after failed writes and resumes persistence on a later save", () => {
    const storage = memoryStorage(), store = new SaveStore(storage);
    store.save(earnedSave());
    const write = storage.setItem;
    storage.setItem = () => { throw new Error("quota exceeded"); };
    const next = { ...earnedSave(), echoes: 5000 };
    store.save(next);
    assert.equal(JSON.parse(storage.getItem(SAVE_KEY)).echoes, 4200);
    assert.deepEqual(store.load(), next);
    storage.setItem = write;
    store.save(store.load());
    assert.deepEqual(new SaveStore(storage).load(), next);
  });

  it("retains an in-memory clear when removing a persistent save fails", () => {
    const storage = memoryStorage(), store = new SaveStore(storage);
    store.save(earnedSave());
    storage.removeItem = () => { throw new Error("remove failed"); };
    store.clear();
    assert.ok(storage.getItem(SAVE_KEY));
    assert.deepEqual(store.load(), defaultSave());
    store.save({ ...defaultSave(), echoes: 10 });
    assert.equal(new SaveStore(storage).load().echoes, 10);
  });

  it("isolates in-memory snapshots from input and returned object mutations", () => {
    const store = new SaveStore(null), input = earnedSave();
    const saved = store.save(input);
    input.meta.life = 0; saved.meta.life = 5; saved.stats.runs = 999;
    const loaded = store.load();
    loaded.unlocked.oracle = true; loaded.achievements.river = true;
    assert.deepEqual(store.load(), earnedSave());
  });
});

describe("progression purchases and rewards", () => {
  it("charges each meta level once and enforces every catalog cap without mutating the input", () => {
    for (const [id, item] of Object.entries(META_UPGRADES)) {
      let save = { ...defaultSave(), echoes: 100000 };
      let spent = 0;
      for (let level = 0; level < item.max; level += 1) {
        const before = structuredClone(save), result = purchaseMeta(save, id, META_UPGRADES);
        spent += item.cost(level);
        assert.equal(result.purchased, true);
        assert.equal(result.save.meta[id], level + 1);
        assert.equal(result.save.echoes, 100000 - spent);
        assert.deepEqual(save, before);
        assert.deepEqual(normalizeSave(result.save), result.save);
        save = result.save;
      }
      assert.deepEqual(purchaseMeta(save, id, META_UPGRADES), { save, purchased: false });
    }
  });

  it("allows exact-price purchases and rejects insufficient funds, unknown ids and inflated caps", () => {
    const cost = META_UPGRADES.life.cost(0);
    assert.equal(purchaseMeta({ ...defaultSave(), echoes: cost }, "life", META_UPGRADES).save.echoes, 0);
    for (const echoes of [0, cost - 1, Infinity, NaN]) {
      assert.equal(purchaseMeta({ ...defaultSave(), echoes }, "life", META_UPGRADES).purchased, false);
    }
    const save = earnedSave();
    for (const id of ["unknown", "__proto__", "constructor", null, ["life"]]) {
      assert.deepEqual(purchaseMeta(save, id, META_UPGRADES), { save, purchased: false });
    }
    save.meta.life = 5;
    assert.deepEqual(purchaseMeta(save, "life", { life: { max: 99, cost: () => 0 } }), { save, purchased: false });
  });

  it("rejects malformed catalogs and invalid prices without spending or minting currency", () => {
    const save = earnedSave();
    for (const cost of [-1, Infinity, -Infinity, NaN, undefined, "100", 1.5, Number.MAX_VALUE]) {
      assert.deepEqual(purchaseMeta(save, "life", { life: { max: 5, cost: () => cost } }), { save, purchased: false });
      assert.deepEqual(unlockCharacter(save, "oracle", { oracle: { cost } }), { save, unlocked: false });
    }
    for (const catalog of [null, undefined, [], {}, Object.create(META_UPGRADES),
      { life: { max: Infinity, cost: () => 1 } }, { life: { max: 5 } },
      { life: { max: 5, cost() { throw new Error("bad catalog"); } } }]) {
      assert.deepEqual(purchaseMeta(save, "life", catalog), { save, purchased: false });
    }
    for (const characters of [null, undefined, [], {}, Object.create(CHARACTERS)]) {
      assert.deepEqual(unlockCharacter(save, "oracle", characters), { save, unlocked: false });
    }
  });

  it("unlocks characters at the exact price once, preserves selection and survives saving", () => {
    for (const id of ["warden", "oracle"]) {
      const cost = CHARACTERS[id].cost;
      const input = { ...defaultSave(), echoes: cost };
      const result = unlockCharacter(input, id, CHARACTERS);
      assert.equal(result.unlocked, true);
      assert.equal(result.save.echoes, 0);
      assert.equal(result.save.unlocked[id], true);
      assert.equal(result.save.preferences.character, "ranger");
      assert.equal(input.unlocked[id], false);
      result.save.preferences.character = id;
      const store = new SaveStore(memoryStorage());
      store.save(result.save);
      assert.equal(store.load().preferences.character, id);
      assert.deepEqual(unlockCharacter(store.load(), id, CHARACTERS), { save: store.load(), unlocked: false });
      assert.equal(unlockCharacter({ ...defaultSave(), echoes: cost - 1 }, id, CHARACTERS).unlocked, false);
    }
    for (const id of ["ranger", "unknown", "__proto__", "constructor", null, ["warden"]]) {
      assert.equal(unlockCharacter(earnedSave(), id, CHARACTERS).unlocked, false);
    }
  });

  it("preserves normal reward math, death penalties and the altar bonus limit", () => {
    const run = { kills: 100, seconds: 300, bosses: 2, level: 20, chests: 2, altarRanks: 1 };
    assert.equal(calcEchoes(), 3);
    assert.equal(calcEchoes(run), Math.floor((60 + 105 + 80 + 60 + 16) * 1.1));
    assert.equal(calcEchoes({ ...run, died: true }), Math.floor((60 + 105 + 80 + 60 + 16) * 1.1 * 0.8));
    assert.equal(calcEchoes({ ...run, altarRanks: 100 }), calcEchoes({ ...run, altarRanks: 6 }));
  });

  it("never produces negative, nonfinite or unsafe rewards from malformed inputs or overflow", () => {
    for (const value of [Infinity, -Infinity, NaN, "Infinity", "broken", -999, {}, [], Symbol("number")]) {
      const reward = calcEchoes({ kills: value, seconds: value, bosses: value, level: value, chests: value, altarRanks: value });
      assert.equal(reward, 0);
    }
    for (const input of [null, false, [], "broken"]) assert.equal(calcEchoes(input), 3);
    assert.equal(calcEchoes({ kills: Number.MAX_VALUE, bosses: Number.MAX_VALUE, altarRanks: Number.MAX_VALUE }), Number.MAX_SAFE_INTEGER);
  });
});
