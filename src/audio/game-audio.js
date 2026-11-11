// All creation/resume/start calls in unlock() stay on the caller's gesture stack.
export class GameAudio {
  constructor({ createContext, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), timeoutMs = 3500 } = {}) {
    this.createContext = createContext;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timeoutMs = timeoutMs;
    this.enabled = true;
    this.status = "idle";
    this.reason = "";
    this.context = null;
    this.masterGain = null;
    this.ambientOutput = null;
    this.ambientOscillators = [];
    this.nodes = new Set();
    this.voices = new Set();
    this.lastPlayed = new Map();
    this.recentStarts = [];
    this.ambientLevel = null;
    this.pending = null;
    this.generation = 0;
    this.rebuild = false;
    this.disposed = false;
  }

  get ready() {
    return this.enabled && !this.disposed && this.status === "ready" && this.context?.state === "running";
  }

  setStatus(status, reason = "") {
    if (this.status === status && this.reason === reason) return;
    this.status = status;
    this.reason = reason;
    this.onChange(status, reason);
  }

  cancelAttempt() {
    this.generation += 1;
    if (!this.pending) return;
    this.clearTimer(this.pending.timer);
    this.pending.resolve(false);
    this.pending = null;
  }

  setEnabled(enabled) {
    if (this.disposed) return;
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.cancelAttempt();
      this.silence();
      this.setStatus("muted");
    }
  }

  unlock({ cue = true, retry = false } = {}) {
    if (this.disposed || !this.enabled) return Promise.resolve(false);
    if (this.pending && !retry) return this.pending.promise;
    this.cancelAttempt();
    this.silence();
    const attempt = { generation: this.generation };
    attempt.promise = new Promise(resolve => { attempt.resolve = resolve; });
    this.pending = attempt;
    this.setStatus("pending");
    try {
      if (this.rebuild || this.context?.state === "closed") this.releaseContext();
      this.ensureContext();
      attempt.context = this.context;
      attempt.timer = this.setTimer(() => this.fail(attempt, "timeout"), this.timeoutMs);
      // Queue the cue before yielding, including on engines that only accept
      // oscillator.start() during user activation. The master stays gated until ready.
      const resumed = this.context.state === "running" ? null : this.context.resume();
      if (cue) {
        this.playTone(523, 784, 0.13, 0.13, 0, { key: "start-low", pending: true });
        this.playTone(784, 1046, 0.14, 0.10, 0.11, { key: "start-high", pending: true });
      }
      if (this.context.state === "running") this.finish(attempt);
      // Always consume resume rejections, even after timeout/mute/dispose.
      Promise.resolve(resumed).then(() => this.finish(attempt), () => this.fail(attempt, "failed"));
    } catch {
      this.fail(attempt, "failed");
    }
    return attempt.promise;
  }

  isCurrent(attempt) {
    return this.pending === attempt && this.generation === attempt.generation && this.enabled && !this.disposed;
  }

  finish(attempt) {
    if (!this.isCurrent(attempt)) return;
    if (attempt.context !== this.context || this.context.state !== "running") {
      this.fail(attempt, "failed");
      return;
    }
    try {
      const gain = this.masterGain.gain;
      gain.cancelScheduledValues(this.context.currentTime);
      gain.setValueAtTime(0.68, this.context.currentTime);
    } catch {
      this.fail(attempt, "failed");
      return;
    }
    this.clearTimer(attempt.timer);
    this.pending = null;
    this.setStatus("ready");
    attempt.resolve(true);
  }

  fail(attempt, reason) {
    if (!this.isCurrent(attempt)) return;
    // A stuck resume can also block future resumes on the same context.
    if (reason === "timeout") this.rebuild = true;
    this.cancelAttempt();
    this.silence();
    this.setStatus("blocked", reason);
  }

  ensureContext() {
    if (this.context && this.masterGain) return;
    try {
      this.context ||= this.createContext();
      const context = this.context;
      const track = node => { this.nodes.add(node); return node; };
      this.masterGain = track(context.createGain());
      this.masterGain.gain.value = 0;
      this.masterGain.connect(context.destination);
      this.ambientOutput = track(context.createGain());
      this.ambientOutput.gain.value = 0.04;
      this.ambientLevel = 0.04;
      const filter = track(context.createBiquadFilter());
      filter.type = "lowpass";
      filter.frequency.value = 1100;
      filter.Q.value = 0.5;
      this.ambientOutput.connect(filter).connect(this.masterGain);
      // Audible fundamentals on small speakers, with a soft, sparse bed.
      for (const [frequency, level] of [[196, 0.5], [293.66, 0.28], [392, 0.16]]) {
        const oscillator = track(context.createOscillator());
        const gain = track(context.createGain());
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.value = level;
        oscillator.connect(gain).connect(this.ambientOutput);
        this.ambientOscillators.push(oscillator);
        oscillator.start();
      }
      this.stateListener = () => this.onStateChange();
      context.addEventListener("statechange", this.stateListener);
    } catch (error) {
      this.releaseContext();
      throw error;
    }
  }

  onStateChange() {
    if (this.disposed) return;
    if (this.context.state === "running") {
      if (this.pending) this.finish(this.pending);
      else if (!this.ready) this.silence();
      return;
    }
    // Keep gesture-queued cue nodes until the pending resume has a result.
    if (this.pending && this.context.state !== "closed") return;
    if (this.context.state === "closed") this.cancelAttempt();
    this.silence();
    if (!this.pending) this.setStatus(this.enabled ? "blocked" : "muted", this.enabled ? "interrupted" : "");
  }

  park() {
    if (this.disposed) return;
    this.cancelAttempt();
    this.silence();
    this.setStatus(this.enabled ? "blocked" : "muted", this.enabled ? "interrupted" : "");
  }

  silence() {
    if (this.masterGain && this.context) {
      try {
        this.masterGain.gain.cancelScheduledValues(this.context.currentTime);
        this.masterGain.gain.setValueAtTime(0, this.context.currentTime);
      } catch { /* A closed context has no audible output. */ }
    }
    for (const voice of [...this.voices]) this.endVoice(voice, true);
    this.lastPlayed.clear();
    this.recentStarts = [];
  }

  setAmbientLevel(level) {
    if (!this.ready || level === this.ambientLevel) return;
    try {
      this.ambientOutput.gain.cancelScheduledValues(this.context.currentTime);
      this.ambientOutput.gain.setTargetAtTime(level, this.context.currentTime, 0.3);
      this.ambientLevel = level;
    } catch {
      this.park();
    }
  }

  playTone(startHz, endHz, duration = 0.13, amplitude = 0.075, offset = 0, { key = "tone", interval = 0.07, pending = false } = {}) {
    if (!this.ready && !(pending && this.pending && this.enabled && !this.disposed && this.context?.state !== "closed")) return false;
    const context = this.context;
    const now = context.currentTime;
    this.recentStarts = this.recentStarts.filter(time => time > now - 1);
    if (this.voices.size >= 6 || this.recentStarts.length >= 18 || now - (this.lastPlayed.get(key) ?? -Infinity) < interval) return false;
    let voice;
    try {
      voice = { oscillator: context.createOscillator(), gain: null };
      voice.gain = context.createGain();
      const { oscillator, gain } = voice;
      const start = now + Math.max(0, Math.min(0.5, offset));
      duration = Math.max(0.03, Math.min(0.6, duration));
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(Math.max(120, startHz), start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(120, endHz), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, Math.min(0.15, amplitude)), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.06);
      oscillator.connect(gain).connect(this.masterGain);
      this.voices.add(voice);
      oscillator.onended = () => this.endVoice(voice);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.08);
      this.lastPlayed.set(key, now);
      this.recentStarts.push(now);
      return true;
    } catch {
      if (voice) this.endVoice(voice, true);
      return false;
    }
  }

  endVoice(voice, stop = false) {
    voice.oscillator.onended = null;
    if (stop) { try { voice.oscillator.stop(); } catch {} }
    try { voice.oscillator.disconnect(); } catch {}
    try { voice.gain?.disconnect(); } catch {}
    this.voices.delete(voice);
  }

  releaseContext() {
    const context = this.context;
    if (context && this.stateListener) context.removeEventListener("statechange", this.stateListener);
    this.silence();
    for (const oscillator of this.ambientOscillators) { try { oscillator.stop(); } catch {} }
    for (const node of this.nodes) { try { node.disconnect(); } catch {} }
    this.nodes.clear();
    this.ambientOscillators = [];
    if (context && context.state !== "closed") {
      try { Promise.resolve(context.close()).catch(() => {}); } catch {}
    }
    this.context = null;
    this.masterGain = null;
    this.ambientOutput = null;
    this.ambientLevel = null;
    this.stateListener = null;
    this.rebuild = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.cancelAttempt();
    this.releaseContext();
    this.setStatus("disposed");
  }
}
