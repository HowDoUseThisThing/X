const codeMap = new Map([
  ["KeyW", "up"], ["ArrowUp", "up"], ["KeyA", "left"], ["ArrowLeft", "left"],
  ["KeyS", "down"], ["ArrowDown", "down"], ["KeyD", "right"], ["ArrowRight", "right"],
  ["Space", "dash"], ["ShiftLeft", "dash"], ["ShiftRight", "dash"],
]);

export class InputManager {
  constructor({ isBlocked = () => Boolean(document.querySelector(".overlay.is-visible")) } = {}) {
    this.isBlocked = isBlocked;
    this.keys = new Set(); this.listeners = [];
    this.touchVector = { x: 0, y: 0 };
    this.dashPressed = false; this.dashPending = false; this.dashLatch = false;
    this.dashPointers = new Set(); this.pointerId = null;
    this.zone = document.querySelector("#stick-zone");
    this.knob = document.querySelector("#stick-knob");
    this.dashButton = document.querySelector("#dash");
    this.mobile = document.querySelector("#mobile-controls");
    this.isTouch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    this.mobile?.classList.toggle("active", this.isTouch);

    this.listen(window, "keydown", event => {
      if (!codeMap.has(event.code) || this.isBlocked() || event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "")) return;
      if (event.code === "Space" && event.target?.tagName === "BUTTON") return;
      this.keys.add(event.code);
      // Keep Space/Enter activation available on focused buttons; movement keys
      // still work immediately after tutorial, resume and upgrade actions.
      event.preventDefault();
    }, { passive: false });
    this.listen(window, "keyup", event => this.keys.delete(event.code));
    this.listen(window, "blur", () => this.reset());
    this.listen(document, "visibilitychange", () => { if (document.hidden) this.reset(); });
    this.listen(this.zone, "pointerdown", event => this.onPointerDown(event));
    this.listen(window, "pointermove", event => this.onPointerMove(event));
    this.listen(window, "pointerup", event => this.onPointerEnd(event));
    this.listen(window, "pointercancel", event => this.onPointerEnd(event));
    this.listen(this.zone, "lostpointercapture", event => this.onPointerEnd(event));
    this.listen(this.dashButton, "lostpointercapture", event => this.onPointerEnd(event));
    this.listen(this.dashButton, "pointerdown", event => {
      if (this.isBlocked()) return;
      event.preventDefault();
      this.dashPointers.add(event.pointerId); this.dashPressed = true; this.dashPending = true;
      this.dashButton.setPointerCapture?.(event.pointerId);
    });
  }

  listen(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  reset() {
    this.keys.clear(); this.dashPressed = false; this.dashPending = false; this.dashLatch = false;
    const joystick = this.pointerId, dash = [...this.dashPointers];
    this.pointerId = null; this.dashPointers.clear(); this.touchVector = { x: 0, y: 0 };
    if (this.knob) this.knob.style.transform = "translate(0, 0)";
    if (joystick !== null && this.zone?.hasPointerCapture?.(joystick)) this.zone.releasePointerCapture(joystick);
    for (const id of dash) if (this.dashButton?.hasPointerCapture?.(id)) this.dashButton.releasePointerCapture(id);
  }

  onPointerDown(event) {
    if (this.isBlocked() || this.pointerId !== null) return;
    event.preventDefault(); this.pointerId = event.pointerId;
    this.zone.setPointerCapture?.(event.pointerId); this.onPointerMove(event);
  }

  onPointerMove(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.isBlocked()) { this.reset(); return; }
    const rect = this.zone.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2;
    const max = Math.max(1, rect.width * 0.32), length = Math.hypot(dx, dy);
    const scale = length > max ? max / length : 1;
    const x = dx * scale, y = dy * scale;
    this.touchVector = { x: x / max, y: y / max };
    if (this.knob) this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  onPointerEnd(event) {
    // A joystick finger or an unrelated finger must never release the dash finger.
    this.dashPointers.delete(event.pointerId);
    this.dashPressed = this.dashPointers.size > 0;
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null; this.touchVector = { x: 0, y: 0 };
    if (this.knob) this.knob.style.transform = "translate(0, 0)";
  }

  sample() {
    if (this.isBlocked()) { this.reset(); return { moveX: 0, moveY: 0, dash: false, isTouch: this.isTouch }; }
    const held = action => [...this.keys].some(code => codeMap.get(code) === action);
    let x = Number(held("right")) - Number(held("left"));
    let y = Number(held("down")) - Number(held("up"));
    if (!x && !y) { x = this.touchVector.x; y = this.touchVector.y; }
    const dash = held("dash");
    const input = { moveX: x, moveY: y, dash: this.dashPending || this.dashPressed || (dash && !this.dashLatch), isTouch: this.isTouch };
    this.dashLatch = dash; this.dashPending = false;
    return input;
  }

  dispose() { this.reset(); for (const remove of this.listeners) remove(); this.listeners = []; }
}
