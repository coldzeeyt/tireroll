// Synthesized audio: rolling rumble, wind, landing thuds and an ambient pad.
(function (root) {
  const TR = root.TR;

  class Audio {
    constructor() {
      this.ctx = null;
      this.muted = false;
      try { this.muted = localStorage.getItem('tireroll.muted') === '1'; } catch (e) { /* storage unavailable */ }
    }

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(ctx.destination);

      // noise buffer shared by rumble and wind
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02; // brown-ish
        d[i] = last * 3.5;
      }
      this.noiseBuf = buf;
      const white = ctx.createBuffer(1, len, ctx.sampleRate);
      const wd = white.getChannelData(0);
      for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;
      this.whiteBuf = white;

      const mk = (b, type, f) => {
        const src = ctx.createBufferSource();
        src.buffer = b; src.loop = true;
        const filt = ctx.createBiquadFilter();
        filt.type = type; filt.frequency.value = f;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(filt); filt.connect(gain); gain.connect(this.master);
        src.start();
        return { filt, gain };
      };
      this.rumble = mk(buf, 'lowpass', 200);
      this.wind = mk(white, 'bandpass', 600);
      this.wind.filt.Q.value = 0.6;
      this.startPad();
    }

    setMuted(m) {
      this.muted = m;
      try { localStorage.setItem('tireroll.muted', m ? '1' : '0'); } catch (e) { /* storage unavailable */ }
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
    }

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    // Soft evolving chord pad, per-map key.
    startPad() {
      const ctx = this.ctx;
      this.padGain = ctx.createGain();
      this.padGain.gain.value = 0.0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      this.padGain.connect(lp); lp.connect(this.master);
      this.padOscs = [];
      for (let i = 0; i < 4; i++) {
        for (const det of [-6, 6]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.detune.value = det;
          const g = ctx.createGain();
          g.gain.value = 0.03;
          o.connect(g); g.connect(this.padGain);
          o.start();
          this.padOscs.push(o);
        }
      }
      this.chordIdx = 0;
      this.padTimer = setInterval(() => this.nextChord(), 4200);
    }

    setMusic(music) {
      this.music = music;
      this.chordIdx = 0;
      this.nextChord(true);
      if (this.padGain) this.padGain.gain.setTargetAtTime(0.5, this.ctx.currentTime, 1.5);
    }

    nextChord(now) {
      if (!this.ctx || !this.music) return;
      const m = this.music;
      const scales = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11] };
      const sc = scales[m.mode] || scales.major;
      const deg = m.prog[this.chordIdx % m.prog.length];
      this.chordIdx++;
      const notes = [0, 2, 4, 7].map((k) => {
        const d = deg + k;
        return m.root + sc[d % 7] + 12 * Math.floor(d / 7);
      });
      const t = this.ctx.currentTime;
      this.padOscs.forEach((o, i) => {
        const n = notes[Math.floor(i / 2)] - 12 + (i >= 6 ? 12 : 0);
        o.frequency.setTargetAtTime(440 * Math.pow(2, (n - 69) / 12), t, now ? 0.01 : 0.6);
      });
    }

    // Called every frame with the tire state.
    update(sim) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const sp = sim ? sim.speed() : 0;
      const g = sim && sim.tire.grounded > 0 && !sim.settled;
      this.rumble.gain.gain.setTargetAtTime(g ? Math.min(0.55, sp * 0.018) : 0, t, 0.05);
      this.rumble.filt.frequency.setTargetAtTime(80 + sp * 9, t, 0.1);
      this.wind.gain.gain.setTargetAtTime(Math.min(0.25, Math.max(0, sp - 8) * 0.006), t, 0.2);
      this.wind.filt.frequency.setTargetAtTime(300 + sp * 22, t, 0.2);
    }

    thud(v) {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
      g.gain.setValueAtTime(Math.min(0.9, v * 0.06), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.4);
      // gritty crunch
      const src = ctx.createBufferSource();
      src.buffer = this.whiteBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(Math.min(0.4, v * 0.025), t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      src.connect(f); f.connect(ng); ng.connect(this.master);
      src.start(t, Math.random()); src.stop(t + 0.2);
    }

    chime() {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      [0, 4, 7, 12].forEach((k, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = 523.25 * Math.pow(2, k / 12);
        g.gain.setValueAtTime(0, t + i * 0.09);
        g.gain.linearRampToValueAtTime(0.18, t + i * 0.09 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.6);
        o.connect(g); g.connect(this.master);
        o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.7);
      });
    }
  }

  TR.Audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
