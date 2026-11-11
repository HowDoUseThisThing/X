const keys = new Set();
const codeMap = new Map([
  ["KeyW", "up"], ["ArrowUp", "up"], ["KeyA", "left"], ["ArrowLeft", "left"],
  ["KeyS", "down"], ["ArrowDown", "down"], ["KeyD", "right"], ["ArrowRight", "right"],
  ["Space", "dash"], ["ShiftLeft", "dash"], ["ShiftRight", "dash"],
]);

export class InputManager {
  constructor() {
    this.touchVector = { x: 0, y: 0 };
    this.dashPressed = false;
    this.dashLatch = false;
    this.pointerId = null;
    this.zone = document.querySelector("#stick-zone");
    this.knob = document.querySelector("#stick-knob");
    this.dashButton = document.querySelector("#dash");
    this.mobile = document.querySelector("#mobile-controls");
    this.isTouch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    this.mobile.classList.toggle("active", this.isTouch);

    window.addEventListener("keydown", event => {
      if (codeMap.has(event.code)) {
        keys.add(codeMap.get(event.code));
        event.preventDefault();
      }
    }, { passive: false });
    window.addEventListener("keyup", event => {
      if (codeMap.has(event.code)) keys.delete(codeMap.get(event.code));
    });
    window.addEventListener("blur", () => {
      keys.clear();
      this.dashPressed = false;
      this.dashLatch = false;
      this.pointerId = null;
      this.touchVector = { x: 0, y: 0 };
      this.knob.style.transform = "translate(0, 0)";
    });
    this.zone.addEventListener("pointerdown", event => this.onPointerDown(event));
    window.addEventListener("pointermove", event => this.onPointerMove(event));
    window.addEventListener("pointerup", event => this.onPointerEnd(event));
    window.addEventListener("pointercancel", event => this.onPointerEnd(event));
    this.dashButton.addEventListener("pointerdown", event => { event.preventDefault(); this.dashPressed = true; });
    window.addEventListener("pointerup", () => { this.dashPressed = false; });
    window.addEventListener("pointercancel", () => { this.dashPressed = false; });
  }

  onPointerDown(event) {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.zone.setPointerCapture(event.pointerId);
    this.onPointerMove(event);
  }

  onPointerMove(event) {
    if (event.pointerId !== this.pointerId) return;
    const rect = this.zone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const max = Math.max(1, rect.width * 0.32);
    const length = Math.hypot(dx, dy);
    const scale = length > max ? max / length : 1;
    const x = dx * scale, y = dy * scale;
    this.touchVector = { x: x / max, y: y / max };
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  onPointerEnd(event) {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.touchVector = { x: 0, y: 0 };
    this.knob.style.transform = "translate(0, 0)";
  }

  sample() {
    let x = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
    let y = (keys.has("down") ? 1 : 0) - (keys.has("up") ? 1 : 0);
    if (!x && !y && (this.touchVector.x || this.touchVector.y)) {
      x = this.touchVector.x;
      y = this.touchVector.y;
    }
    const input = {
      moveX: x,
      moveY: y,
      dash: this.dashPressed || (keys.has("dash") && !this.dashLatch),
      isTouch: this.isTouch,
    };
    this.dashLatch = keys.has("dash");
    return input;
  }
}
