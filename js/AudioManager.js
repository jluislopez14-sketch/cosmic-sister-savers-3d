// AudioManager.js — Voice (speechSynthesis) + background music (HTML5 Audio).
//
// Voice profiles tweak pitch/rate so each family member has a distinctive sound
// even when the browser only ships generic system voices.
//
// Greeny gets an "alien cadence" by inserting hyphenated splits and "..."
// pauses between words — speechSynthesis ignores SSML in most browsers, so we
// fake the cadence by mutating the input string.

const VOICES = {
  alaia:    { pitch: 1.65, rate: 1.10, volume: 1.00,
              prefer: ['Karen', 'Samantha', 'Microsoft Zira', 'Victoria', 'female'] },
  lisabel:  { pitch: 1.20, rate: 1.05, volume: 1.00,
              prefer: ['Allison', 'Samantha', 'Microsoft Zira', 'female'] },
  jose:     { pitch: 0.65, rate: 0.95, volume: 1.00,
              prefer: ['Daniel', 'Microsoft David', 'Alex', 'Fred', 'male'] },
  mom:      { pitch: 1.10, rate: 1.00, volume: 1.00,
              prefer: ['Karen', 'Samantha', 'Microsoft Zira', 'female'] },
  greeny:   { pitch: 0.55, rate: 0.85, volume: 0.95, alien: true,
              prefer: ['Whisper', 'Microsoft David', 'Alex', 'male'] },
  narrator: { pitch: 1.00, rate: 1.00, volume: 1.00,
              prefer: ['Daniel', 'Alex', 'male'] },
};

function alienize(text) {
  return text.split(/\s+/).map((w) => {
    if (w.length <= 4) return w;
    const m = Math.floor(w.length / 2);
    return w.slice(0, m) + '-' + w.slice(m);
  }).join('... ');
}

export class AudioManager {
  constructor() {
    this._synth = (typeof window !== 'undefined') ? window.speechSynthesis : null;
    this._voices = [];
    this._musicEl = null;
    this._muted = false;
    this._musicVolume = 0.30;

    if (this._synth) {
      this._refreshVoices();
      // Some browsers populate getVoices() asynchronously
      try { this._synth.addEventListener('voiceschanged', () => this._refreshVoices()); } catch {}
    } else {
      console.warn('[AudioManager] speechSynthesis unavailable in this browser');
    }
  }

  _refreshVoices() {
    if (!this._synth) return;
    this._voices = this._synth.getVoices() || [];
  }

  _pickVoice(profile) {
    if (!this._voices.length) return null;
    for (const want of (profile.prefer || [])) {
      const w = want.toLowerCase();
      const v = this._voices.find((vv) => (vv.name || '').toLowerCase().includes(w));
      if (v) return v;
    }
    return this._voices.find((v) => /en[-_]/i.test(v.lang || '')) || this._voices[0];
  }

  /**
   * Speak a line as a character. Returns the utterance (or null if unavailable).
   *   audio.speak("Smile Energy at maximum!", "alaia");
   */
  speak(text, character = 'narrator', { onEnd } = {}) {
    if (!this._synth || this._muted) { onEnd?.(); return null; }
    const profile = VOICES[character] || VOICES.narrator;
    const utter = new SpeechSynthesisUtterance(profile.alien ? alienize(text) : text);
    const voice = this._pickVoice(profile);
    if (voice) utter.voice = voice;
    utter.pitch  = profile.pitch;
    utter.rate   = profile.rate;
    utter.volume = profile.volume;
    if (onEnd) utter.onend = onEnd;
    console.log(`[Audio] ${character}: "${text}"`);
    try { this._synth.speak(utter); } catch (e) { console.warn('[Audio] speak failed', e); onEnd?.(); }
    return utter;
  }

  /** lines: [[character, text], ...] — speaks each in order with a small gap between. */
  speakSequence(lines, gapMs = 250) {
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (i >= lines.length) return resolve();
        const [character, text] = lines[i++];
        this.speak(text, character, { onEnd: () => setTimeout(next, gapMs) });
      };
      next();
    });
  }

  stopAllSpeech() { try { this._synth?.cancel(); } catch {} }

  // ---- Background music ----
  // Two paths:
  //   playMusic('audio/foo.mp3')   → HTML5 <audio> element
  //   playMusic('synth:space')     → procedural Web Audio loop (no file needed)
  playMusic(url, { loop = true, volume = this._musicVolume } = {}) {
    this.stopMusic();
    if (!url) return null;
    this._musicVolume = volume;
    if (typeof url === 'string' && url.startsWith('synth:')) {
      this._startProcedural(url.slice(6));
      return null;
    }
    const a = new Audio(url);
    a.loop = loop;
    a.volume = this._muted ? 0 : volume;
    a.play().catch((e) => console.warn('[Audio] music play blocked:', e?.message || e));
    this._musicEl = a;
    console.log(`[Audio] music ▶ ${url}`);
    return a;
  }

  stopMusic() {
    if (this._musicEl) { try { this._musicEl.pause(); } catch {} this._musicEl = null; }
    this._stopProcedural();
  }

  setMuted(flag) {
    this._muted = !!flag;
    if (this._musicEl)  this._musicEl.volume = this._muted ? 0 : this._musicVolume;
    if (this._procGain) this._procGain.gain.value = this._muted ? 0 : this._musicVolume;
    if (this._muted) this.stopAllSpeech();
  }

  // ============ Procedural music engine ============
  _ensureAudioCtx() {
    if (this._audioCtx) return this._audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { console.warn('[Audio] Web Audio unavailable'); return null; }
    this._audioCtx = new Ctx();
    this._procGain = this._audioCtx.createGain();
    this._procGain.gain.value = this._muted ? 0 : this._musicVolume;
    this._procGain.connect(this._audioCtx.destination);
    return this._audioCtx;
  }

  _startProcedural(profileName) {
    const ctx = this._ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const profile = MUSIC_PROFILES[profileName] || MUSIC_PROFILES.space;
    console.log(`[Audio] synth ▶ ${profileName} (${profile.bpm} bpm)`);
    this._procProfile = profile;
    this._procStep = 0;
    const stepMs = 60000 / profile.bpm / 4;     // 16th notes
    this._procIntervalId = setInterval(() => {
      const dest = this._procGain;
      profile.tick(ctx, dest, this._procStep);
      this._procStep = (this._procStep + 1) % 32;
    }, stepMs);
  }

  _stopProcedural() {
    if (this._procIntervalId) { clearInterval(this._procIntervalId); this._procIntervalId = null; }
    this._procProfile = null;
  }

  // ---- Sound effects (one-shots) ----
  /** Play a sound effect by name. Routes through Web Audio with a separate gain. */
  sfx(name) {
    if (this._muted) return;
    const ctx = this._ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const profile = SFX_PROFILES[name];
    if (!profile) { console.warn('[Audio] unknown sfx:', name); return; }
    if (!this._sfxGain) {
      this._sfxGain = ctx.createGain();
      this._sfxGain.gain.value = 0.55;
      this._sfxGain.connect(ctx.destination);
    }
    try { profile(ctx, this._sfxGain); } catch (e) { console.warn('[Audio] sfx error', e); }
  }
}

// ---------- Procedural music profiles ----------
// Tiny Web-Audio synth helpers. Each tick() schedules notes for the current
// 16th-note step. Designed to loop forever without bookkeeping.

function note(ctx, dest, freq, dur, type = 'sine', gain = 0.18, attack = 0.01, release = 0.30) {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur + release);
  osc.connect(g); g.connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + release + 0.05);
}
function noise(ctx, dest, dur, gain = 0.10, freq = 800, q = 6) {
  const t0 = ctx.currentTime;
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * dur, sr);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

const SCALE_PENT_C = [261.63, 293.66, 329.63, 392.00, 440.00];   // C D E G A
const SCALE_MINOR_A = [220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00];

// ---------- Sound effects ----------
// Each is a function (ctx, dest) that schedules a short one-shot. Volumes are
// designed to sit at ~0.20 master gain set by the procedural music bus.

const SFX_PROFILES = {
  shoot: (ctx, dest) => {
    note(ctx, dest, 880, 0.04, 'square', 0.10, 0.001, 0.06);
    note(ctx, dest, 1320, 0.03, 'triangle', 0.08, 0.001, 0.05);
  },
  hit: (ctx, dest) => {
    noise(ctx, dest, 0.10, 0.20, 1200, 4);
    note(ctx, dest, 220, 0.06, 'sawtooth', 0.10, 0.001, 0.10);
  },
  kill: (ctx, dest) => {
    noise(ctx, dest, 0.20, 0.30, 600, 2);
    note(ctx, dest, 165, 0.10, 'sawtooth', 0.18, 0.001, 0.20);
    note(ctx, dest, 110, 0.18, 'sine',     0.12, 0.005, 0.30);
  },
  pickup: (ctx, dest) => {
    note(ctx, dest, 880,  0.05, 'sine',     0.12, 0.001, 0.06);
    note(ctx, dest, 1175, 0.05, 'sine',     0.12, 0.001, 0.06);
    note(ctx, dest, 1568, 0.10, 'triangle', 0.10, 0.001, 0.10);
  },
  jump: (ctx, dest) => {
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(440, t0);
    o.frequency.linearRampToValueAtTime(880, t0 + 0.10);
    g.gain.setValueAtTime(0.10, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + 0.20);
  },
  hurt: (ctx, dest) => {
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(440, t0);
    o.frequency.linearRampToValueAtTime(110, t0 + 0.30);
    g.gain.setValueAtTime(0.18, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + 0.40);
    noise(ctx, dest, 0.10, 0.10, 400, 2);
  },
  mergeBlast: (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Rising whoosh
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t0);
    o.frequency.exponentialRampToValueAtTime(2200, t0 + 0.6);
    g.gain.setValueAtTime(0.18, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + 0.85);
    // Followed by a bright chord
    setTimeout(() => {
      [523.25, 659.25, 783.99, 1046.50].forEach((f) =>
        note(ctx, dest, f, 0.30, 'triangle', 0.14, 0.005, 0.35));
    }, 600);
    noise(ctx, dest, 0.45, 0.12, 5000, 1);
  },
  missionComplete: (ctx, dest) => {
    // 3-note ascending fanfare
    const seq = [523.25, 659.25, 783.99];
    seq.forEach((f, i) =>
      setTimeout(() => note(ctx, dest, f, 0.20, 'triangle', 0.18, 0.005, 0.25), i * 110));
  },
  combo: (ctx, dest) => {
    note(ctx, dest, 1568, 0.05, 'triangle', 0.10, 0.001, 0.06);
    note(ctx, dest, 2093, 0.05, 'triangle', 0.10, 0.001, 0.06);
  },
};

const MUSIC_PROFILES = {
  // Mission 1: dreamy pad + sparse arpeggio
  space: {
    bpm: 96,
    tick(ctx, dest, step) {
      // Sustained pad on every measure (16 steps)
      if (step % 16 === 0) {
        note(ctx, dest, 130.81, 4.0, 'sine',     0.10, 0.5, 1.5);  // C3
        note(ctx, dest, 196.00, 4.0, 'sine',     0.07, 0.6, 1.6);  // G3
        note(ctx, dest, 261.63, 4.0, 'triangle', 0.04, 0.7, 1.6);  // C4
      }
      // Arp every 4 steps
      if (step % 4 === 0) {
        const f = SCALE_PENT_C[(step / 4) % SCALE_PENT_C.length];
        note(ctx, dest, f * 2, 0.18, 'triangle', 0.16, 0.005, 0.20);
      }
    },
  },

  // Mission 2: low rumble + heartbeat thump
  reentry: {
    bpm: 100,
    tick(ctx, dest, step) {
      if (step === 0)            note(ctx, dest, 55.00, 4.0, 'sawtooth', 0.10, 0.5, 1.4);
      if (step === 0 || step === 8) noise(ctx, dest, 0.45, 0.25, 200, 3);  // boom
      if (step % 4 === 0)        note(ctx, dest, 65.41, 0.18, 'square', 0.18, 0.01, 0.10); // heartbeat
      if (step % 4 === 2)        note(ctx, dest, 65.41, 0.10, 'square', 0.10, 0.01, 0.08);
    },
  },

  // Mission 3: mystical lo-fi pad + chimes
  caves: {
    bpm: 88,
    tick(ctx, dest, step) {
      if (step % 16 === 0) {
        note(ctx, dest, 110.00, 5.0, 'sine',     0.10, 0.7, 1.8);  // A2
        note(ctx, dest, 164.81, 5.0, 'sine',     0.07, 0.7, 1.9);  // E3
        note(ctx, dest, 261.63, 5.0, 'triangle', 0.04, 0.8, 1.9);  // C4
      }
      if (step % 6 === 0) {
        const f = SCALE_MINOR_A[(step / 2) % SCALE_MINOR_A.length] * 2;
        note(ctx, dest, f, 0.10, 'triangle', 0.14, 0.005, 0.40);  // chime
      }
    },
  },

  // Mission 4: dark arp + bass thump
  boss: {
    bpm: 132,
    tick(ctx, dest, step) {
      if (step % 4 === 0)  note(ctx, dest, 55.00,  0.16, 'sawtooth', 0.20, 0.005, 0.10); // bass
      if (step % 2 === 0) {
        const arp = [110, 138.59, 164.81, 207.65]; // A2 C#3 E3 G#3
        const f = arp[(step / 2) % arp.length];
        note(ctx, dest, f, 0.10, 'square', 0.12, 0.005, 0.12);
      }
      if (step === 0 || step === 12) noise(ctx, dest, 0.18, 0.10, 4000, 1);  // hi-hat
    },
  },
};
