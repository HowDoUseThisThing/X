import { SurvivorGame } from "./game/game.js";
import { CanvasRenderer } from "./render/canvas.js";
import { InputManager } from "./core/input.js";
import { GameUI } from "./ui/ui.js";

const canvas = document.querySelector("#world");
const game = new SurvivorGame();
const renderer = new CanvasRenderer(canvas);
const input = new InputManager();
const ui = new GameUI(game);

window.__MOON_SURVIVOR__ = { game, renderer, input, ui };
let lastTime = 0;
let running = true;

function frame(timestamp) {
  if (!running) return;
  const seconds = lastTime ? (timestamp - lastTime) / 1000 : 0;
  lastTime = timestamp;
  const controls = input.sample();
  game.update(seconds, controls, { width: renderer.width, height: renderer.height });
  renderer.draw(game, timestamp / 1000);
  ui.render(game);
  frameId = requestAnimationFrame(frame);
}

window.addEventListener("pagehide", () => { running = false; cancelAnimationFrame(frameId); });
window.addEventListener("pageshow", () => {
  if (running) return;
  running = true;
  lastTime = 0;
  frameId = requestAnimationFrame(frame);
});
let frameId = requestAnimationFrame(frame);


