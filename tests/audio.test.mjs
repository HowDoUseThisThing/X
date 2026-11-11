import { it } from "node:test";
import assert from "node:assert/strict";
import { GameAudio } from "../src/audio/game-audio.js";
import { GameUI } from "../src/ui/ui.js";
import { SurvivorGame } from "../src/game/game.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function timerClock() {
  let now = 0, next = 0;
  const tasks = new Map();
  return {
    tasks,
    setTimer(fn, delay) { const id = ++next; tasks.set(id, { fn, due: now + delay }); return id; },
    clearTimer(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks]) {
        if (task.due <= now) { tasks.delete(id); task.fn(); }
      }
    },
  };
}

class Param {
  constructor() { this.value = 0; this.calls = []; }
  cancelScheduledValues(time) { this.calls.push(["cancel", time]); }
  setValueAtTime(value, time) { this.value = value; this.calls.push(["set", value, time]); }
  exponentialRampToValueAtTime(value, time) { this.calls.push(["ramp", value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.calls.push(["target", value, time, constant]); }
}

class Node {
  constructor(context, kind) {
    this.kind = kind;
    this.context = context;
    this.gain = new Param();
    this.frequency = new Param();
    this.Q = new Param();
    this.disconnected = false;
    this.connections = [];
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; this.connections = []; }
  start(time = 0) { this.started = time; this.context.starts.push(this); }
  stop(time = 0) { this.stopped = time; }
}

class Context extends EventTarget {
  constructor(state = "suspended") {
    super();
    this.state = state;
    this.currentTime = 0;
    this.destination = {};
    this.nodes = [];
    this.starts = [];
    this.resumeCalls = 0;
    this.closeCalls = 0;
    this.listeners = new Set();
    this.resumeImpl = () => { this.transition("running"); return Promise.resolve(); };
  }
  addEventListener(type, listener) { super.addEventListener(type, listener); this.listeners.add(listener); }
  removeEventListener(type, listener) { super.removeEventListener(type, listener); this.listeners.delete(listener); }
  make(kind) { const node = new Node(this, kind); this.nodes.push(node); return node; }
  createGain() { return this.make("gain"); }
  createBiquadFilter() { return this.make("filter"); }
  createOscillator() { return this.make("oscillator"); }
  resume() { this.resumeCalls += 1; return this.resumeImpl(); }
  close() { this.closeCalls += 1; this.transition("closed"); return Promise.resolve(); }
  transition(state) { this.state = state; this.dispatchEvent(new Event("statechange")); }
  advance(seconds) {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (node.onended && node.stopped <= this.currentTime) node.onended();
    }
  }
}

function rig(context = new Context()) {
  const clock = timerClock();
  const changes = [];
  const contexts = [context];
  const audio = new GameAudio({
    createContext: () => contexts.shift() ?? new Context(),
    onChange: (status, reason) => changes.push([status, reason]),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100,
  });
  return { audio, context, clock, changes, contexts };
}

it("creates, resumes, and schedules an audible cue synchronously in the gesture", async () => {
  const { audio, context } = rig();
  const pending = audio.unlock();
  assert.equal(context.resumeCalls, 1);
  assert.equal(context.starts.length, 5); // Three bed oscillators plus two cue notes.
  assert.equal(audio.voices.size, 2);
  assert.equal(audio.masterGain.gain.value, 0.68);
  assert.ok([...audio.voices][0].gain.gain.calls.some(([op, gain]) => op === "ramp" && gain >= 0.1));
  assert.ok(audio.ambientOscillators.every(node => node.frequency.value >= 196));
  assert.equal(await pending, true);
  audio.dispose();
});

it("calls default browser timers without binding their receiver to the audio controller", async t => {
  const clock = timerClock();
  t.mock.method(globalThis, "setTimeout", function (fn, ms) {
    assert.ok(this === undefined || this === globalThis, "Window timers reject an unrelated receiver");
    return clock.setTimer(fn, ms);
  });
  t.mock.method(globalThis, "clearTimeout", function (id) {
    assert.ok(this === undefined || this === globalThis);
    clock.clearTimer(id);
  });
  const audio = new GameAudio({ createContext: () => new Context() });
  assert.equal(await audio.unlock(), true);
  audio.dispose();
  assert.equal(clock.tasks.size, 0);
});

it("resumes the existing suspended or interrupted context instead of toggling intent off", async () => {
  const { audio, context } = rig();
  await audio.unlock();
  const master = audio.masterGain;
  for (const state of ["suspended", "interrupted"]) {
    context.transition(state);
    assert.equal(audio.ready, false);
    assert.equal(audio.enabled, true);
    assert.equal(master.gain.value, 0);
    assert.equal(await audio.unlock(), true);
    assert.equal(audio.context, context);
    assert.equal(audio.masterGain, master);
  }
  assert.equal(context.resumeCalls, 3);
  audio.dispose();
});

it("rebuilds an externally closed context and disconnects its whole graph", async () => {
  const { audio, context, contexts } = rig();
  await audio.unlock();
  context.transition("closed");
  const replacement = new Context();
  contexts.push(replacement);
  assert.equal(await audio.unlock(), true);
  assert.equal(audio.context, replacement);
  assert.ok(context.nodes.every(node => node.disconnected));
  assert.equal(context.listeners.size, 0);
  audio.dispose();
});

it("reports denied resume and allows a later gesture to retry", async () => {
  const { audio, context, clock } = rig();
  context.resumeImpl = () => Promise.reject(new Error("denied"));
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.status, "blocked");
  assert.equal(audio.reason, "failed");
  assert.equal(audio.masterGain.gain.value, 0);
  assert.equal(audio.voices.size, 0);
  assert.equal(clock.tasks.size, 0);
  context.resumeImpl = () => { context.transition("running"); return Promise.resolve(); };
  assert.equal(await audio.unlock(), true);
  audio.dispose();
});

it("keeps a gesture-queued cue through intermediate non-running notifications", async () => {
  const { audio, context } = rig();
  const resumed = deferred();
  context.resumeImpl = () => resumed.promise;
  const waiting = audio.unlock();
  context.transition("suspended");
  context.transition("interrupted");
  assert.equal(audio.status, "pending");
  assert.equal(audio.voices.size, 2);
  assert.equal(audio.masterGain.gain.value, 0);
  context.transition("running");
  resumed.resolve();
  assert.equal(await waiting, true);
  assert.equal(audio.voices.size, 2);
  audio.dispose();
});

it("handles unavailable APIs, synchronous throws and resumes that never become playable", async () => {
  const { audio, context } = rig();
  let available = false;
  audio.createContext = () => { if (!available) throw new Error("unsupported"); return context; };
  assert.equal(await audio.unlock(), false);
  available = true;
  context.resumeImpl = () => { throw new Error("blocked"); };
  assert.equal(await audio.unlock(), false);
  context.resumeImpl = () => Promise.resolve();
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.status, "blocked");
  context.resumeImpl = () => { context.transition("running"); return Promise.resolve(); };
  assert.equal(await audio.unlock(), true);
  audio.dispose();
});

it("times out pending resume, gates late completion, and retries with a fresh context", async () => {
  const { audio, context, clock, contexts } = rig();
  const late = deferred();
  context.resumeImpl = () => late.promise;
  const waiting = audio.unlock();
  assert.equal(audio.status, "pending");
  assert.equal(audio.masterGain.gain.value, 0);
  clock.advance(100);
  assert.equal(await waiting, false);
  assert.equal(audio.reason, "timeout");
  const oldMaster = audio.masterGain;
  context.transition("running");
  late.resolve();
  await flush();
  assert.equal(audio.ready, false);
  assert.equal(oldMaster.gain.value, 0);
  const replacement = new Context();
  contexts.push(replacement);
  assert.equal(await audio.unlock(), true);
  assert.equal(context.closeCalls, 1);
  assert.equal(audio.context, replacement);
  assert.equal(clock.tasks.size, 0);
  audio.dispose();
});

it("mute invalidates pending resume and every delayed callback without losing mute intent", async () => {
  const { audio, context, clock } = rig();
  const late = deferred();
  context.resumeImpl = () => late.promise;
  const waiting = audio.unlock();
  audio.setEnabled(false);
  assert.equal(await waiting, false);
  assert.equal(audio.voices.size, 0);
  context.transition("running");
  late.resolve();
  await flush();
  assert.equal(audio.enabled, false);
  assert.equal(audio.status, "muted");
  assert.equal(audio.masterGain.gain.value, 0);
  assert.equal(audio.playTone(500, 700), false);
  assert.equal(await audio.unlock(), false);
  assert.equal(clock.tasks.size, 0);
  audio.dispose();
});

it("an old failure cannot cancel a newer successful retry", async () => {
  const { audio, context } = rig();
  const late = deferred();
  context.resumeImpl = () => late.promise;
  const first = audio.unlock();
  context.resumeImpl = () => { context.transition("running"); return Promise.resolve(); };
  assert.equal(await audio.unlock({ retry: true }), true);
  assert.equal(await first, false);
  late.reject(new Error("old attempt"));
  await flush();
  assert.equal(audio.ready, true);
  assert.equal(audio.masterGain.gain.value, 0.68);
  audio.dispose();
});

it("deduplicates passive recovery, and backgrounding cancels pending audio", async () => {
  const { audio, context } = rig();
  const late = deferred();
  context.resumeImpl = () => late.promise;
  const first = audio.unlock();
  assert.equal(audio.unlock({ cue: false }), first);
  assert.equal(context.resumeCalls, 1);
  audio.park();
  assert.equal(await first, false);
  context.transition("running");
  late.resolve();
  await flush();
  assert.equal(audio.masterGain.gain.value, 0);
  assert.equal(audio.ready, false);
  assert.equal(await audio.unlock({ cue: false }), true);
  audio.dispose();
});

it("bounds polyphony and event rate, disconnects ended voices, and avoids frame automation growth", async () => {
  const { audio, context } = rig();
  await audio.unlock({ cue: false });
  const baseline = context.nodes.length;
  for (let i = 0; i < 200; i++) audio.playTone(880, 620, 0.075, 0.065, 0, { key: "kill", interval: 0.09 });
  assert.equal(audio.voices.size, 1);
  for (let i = 0; i < 20; i++) audio.playTone(500, 600, 0.1, 0.06, 0, { key: `burst-${i}` });
  assert.equal(audio.voices.size, 6);
  context.advance(0.3);
  assert.equal(audio.voices.size, 0);
  assert.ok(context.nodes.slice(baseline).every(node => node.disconnected));
  for (let i = 0; i < 200; i++) {
    context.advance(0.001);
    audio.playTone(500, 600, 0.03, 0.06, 0, { key: "rapid", interval: 0 });
    // Simulate ended sounds to exercise the global rate cap independently of polyphony.
    for (const voice of [...audio.voices]) voice.oscillator.onended();
  }
  assert.ok(audio.recentStarts.length <= 18);
  const gain = audio.ambientOutput.gain;
  for (let i = 0; i < 1000; i++) audio.setAmbientLevel(0.04);
  assert.equal(gain.calls.length, 0);
  for (let i = 0; i < 1000; i++) audio.setAmbientLevel(0.055);
  assert.equal(gain.calls.filter(([op]) => op === "target").length, 1);
  assert.equal(audio.nodes.size, baseline);
  audio.dispose();
  assert.ok(context.nodes.every(node => node.disconnected));
});

it("dispose is terminal, clears timeout/listeners/nodes, and consumes a late rejection", async () => {
  const { audio, context, clock } = rig();
  const late = deferred();
  context.resumeImpl = () => late.promise;
  const waiting = audio.unlock();
  const master = audio.masterGain;
  audio.dispose();
  audio.dispose();
  assert.equal(await waiting, false);
  late.reject(new Error("closed"));
  await flush();
  context.transition("running");
  assert.equal(master.gain.value, 0);
  assert.equal(audio.context, null);
  assert.equal(audio.nodes.size, 0);
  assert.equal(audio.voices.size, 0);
  assert.equal(clock.tasks.size, 0);
  assert.equal(context.listeners.size, 0);
  assert.equal(context.closeCalls, 1);
  assert.ok(context.nodes.every(node => node.disconnected));
  audio.setEnabled(true);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.status, "disposed");
});

class Element extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.classes = new Set(["hidden"]);
    this.writes = 0;
    this.text = "";
    this.width = "";
    this.style = {};
    Object.defineProperty(this.style, "width", {
      get: () => this.width,
      // Mimic CSSOM's canonicalized fractional widths.
      set: value => { this.width = `${Number.parseFloat(value).toFixed(4)}%`; this.writes++; },
    });
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  get textContent() { return this.text; }
  set textContent(value) { this.writes++; this.text = value; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function uiRig(t, ContextType = Context) {
  const elements = new Map();
  const doc = new EventTarget();
  doc.hidden = false;
  doc.querySelector = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const win = new EventTarget();
  win.AudioContext = ContextType;
  const clock = timerClock();
  const globals = { document: doc, window: win, requestAnimationFrame: fn => clock.setTimer(fn, 16), cancelAnimationFrame: clock.clearTimer };
  const previousGlobals = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.method(globalThis, "setTimeout", clock.setTimer);
  t.mock.method(globalThis, "clearTimeout", clock.clearTimer);
  const game = new SurvivorGame(1);
  const ui = new GameUI(game);
  t.after(() => {
    ui.dispose();
    for (const [key, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    }
  });
  return { ui, game, doc, win, clock, elements, button: doc.querySelector("#sound") };
}

it("UI retries suspended audio on sound click and only mutes when actually ready", async t => {
  const { ui, button } = uiRig(t);
  await ui.startRun();
  const context = ui.audioContext;
  assert.equal(button.getAttribute("aria-pressed"), "true");
  context.transition("suspended");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.match(button.getAttribute("aria-label"), /重试/);
  await ui.toggleSound();
  assert.equal(context.resumeCalls, 2);
  assert.equal(ui.soundOn, true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(await ui.toggleSound(), false);
  assert.equal(ui.soundOn, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.classList.contains("muted"), true);
  await ui.startRun();
  assert.equal(ui.soundOn, false);
  assert.equal(ui.masterGain.gain.value, 0);
});

it("UI exposes pending/timeout feedback and retries instead of treating pending as on", async t => {
  const late = deferred();
  class SlowContext extends Context { constructor() { super(); this.resumeImpl = () => late.promise; } }
  const { ui, button, clock, elements } = uiRig(t, SlowContext);
  const waiting = ui.startRun();
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  const retry = ui.toggleSound();
  assert.equal(await waiting, false);
  assert.equal(ui.soundOn, true);
  assert.equal(ui.audioContext.resumeCalls, 2);
  clock.advance(3500);
  assert.equal(await retry, false);
  assert.equal(button.getAttribute("aria-busy"), "false");
  assert.match(elements.get("#toast").textContent, /超时.*重试/);
  late.reject(new Error("late"));
  await flush();
});

it("visibility return and resumeRun recover audio while preserving explicit mute", async t => {
  const { ui, game, doc } = uiRig(t);
  await ui.startRun();
  const context = ui.audioContext;
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(game.state, "paused");
  context.transition("interrupted");
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(game.state, "playing");
  assert.equal(ui.audio.ready, true);
  ui.pauseRun();
  context.transition("suspended");
  ui.resumeRun();
  assert.equal(ui.audio.ready, true);
  ui.toggleSound();
  const calls = context.resumeCalls;
  doc.hidden = true;
  ui.onVisibilityChange();
  doc.hidden = false;
  ui.onVisibilityChange();
  ui.pauseRun();
  ui.resumeRun();
  assert.equal(ui.soundOn, false);
  assert.equal(ui.masterGain.gain.value, 0);
  assert.equal(context.resumeCalls, calls);
});

it("unchanged HUD values and ambient state do not cause DOM or automation writes", async t => {
  const { ui, game, elements } = uiRig(t);
  await ui.startRun();
  game.player.health = 85.1234567;
  game.player.xp = 1;
  ui.render(game);
  const keys = ["#clock", "#health-fill", "#health-text", "#xp-fill", "#level-text", "#wave-text"];
  const counts = keys.map(key => elements.get(key).writes);
  const calls = ui.ambientOutput.gain.calls.length;
  for (let i = 0; i < 1000; i++) ui.render(game);
  assert.deepEqual(keys.map(key => elements.get(key).writes), counts);
  assert.equal(ui.ambientOutput.gain.calls.length, calls);
  game.player.health = 20;
  ui.render(game);
  assert.equal(elements.get("#health-fill").writes, counts[1] + 1);
  assert.equal(ui.ambientOutput.gain.calls.length, calls + 2); // cancel + new target
});

it("UI dispose removes interaction handlers and intro/heartbeat/toast timers", async t => {
  const { ui, game, doc, clock, elements } = uiRig(t);
  await ui.startRun();
  const context = ui.audioContext;
  ui.dispose();
  assert.equal(clock.tasks.size, 0);
  assert.equal(ui.listeners.length, 0);
  elements.get("#start").dispatchEvent(new Event("click"));
  elements.get("#sound").dispatchEvent(new Event("click"));
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(game.state, "playing");
  assert.equal(ui.audioContext, null);
  assert.equal(context.closeCalls, 1);
  assert.ok(context.nodes.every(node => node.disconnected));
});
