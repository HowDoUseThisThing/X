import { SurvivorGame } from "./game/game.js";
import { CanvasRenderer } from "./render/canvas.js";
import { InputManager } from "./core/input.js";
import { GameUI } from "./ui/ui.js";
import { MetaUI } from "./ui/meta-ui.js";
import { SaveStore, purchaseMeta, unlockCharacter } from "./game/progression.js";
import { CHARACTERS, META_UPGRADES } from "./game/content.js";

const canvas = document.querySelector("#world");
const store = new SaveStore();
let profile = store.load();
const game = new SurvivorGame(0x51ea, { profile });
const renderer = new CanvasRenderer(canvas);
let ui;
const input = new InputManager({ isBlocked: () => !ui || ui.isInputBlocked() });
const saveProfile = value => {
  profile = store.save(value);
  // Active-run rules and achievement ledgers are owned by game. Supply the new
  // profile only at startRun; purchases and preferences must not reset them.
  if (ui) ui.profile = profile;
  return profile;
};
const metaUI = new MetaUI(document.querySelector("#meta-screen"), {
  save: profile,
  onChange: (action, id) => {
    if (action === "buy") {
      const result = purchaseMeta(profile, id, META_UPGRADES);
      if (result.purchased) { saveProfile(result.save); metaUI.setSave(profile); ui.renderCharacterPicker(); ui.toast("刻印已购买 · 下一局生效"); }
    } else if (action === "character") {
      let result = { save: profile, unlocked: profile.unlocked[id] };
      if (!profile.unlocked[id]) result = unlockCharacter(profile, id, CHARACTERS);
      if (result.unlocked) {
        result.save.preferences.character = id;
        saveProfile(result.save); metaUI.setSave(profile); ui.renderCharacterPicker(); ui.toast("角色已选择 · 下一局生效");
      }
    }
  },
});
metaUI.setVisible(false);
ui = new GameUI(game, { profile, onSave: saveProfile, metaUI });
window.__MOON_SURVIVOR__ = { game, renderer, input, ui, metaUI, store, getProfile: () => profile };
let lastTime = 0;
let running = true;
let frameId = 0;

function frame(timestamp) {
  if (!running) return;
  const seconds = lastTime ? (timestamp - lastTime) / 1000 : 0;
  lastTime = timestamp;
  renderer.recordFrame(seconds * 1000, game.state === "playing");
  game.particleLimit = renderer.quality.settings.particleLimit;
  const controls = input.sample();
  game.update(seconds, controls, { width: renderer.width, height: renderer.height });
  renderer.draw(game, timestamp / 1000);
  ui.render(game);
  frameId = requestAnimationFrame(frame);
}

window.addEventListener("pagehide", () => { running = false; input.reset(); cancelAnimationFrame(frameId); });
window.addEventListener("pageshow", () => {
  if (running) return;
  running = true; lastTime = 0; frameId = requestAnimationFrame(frame);
});
frameId = requestAnimationFrame(frame);
