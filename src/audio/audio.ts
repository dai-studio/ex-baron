import * as THREE from 'three';

/**
 * Audio (design §3): Web Audio API, fully synthesised (no files).
 * Engine loop with "putt" modulation following RPM, wind with speed,
 * gunfire, hits and explosions, and a positional engine for each enemy.
 * The context starts on the first user gesture (autoplay policy).
 */
interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  panner: PannerNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private eng1!: OscillatorNode;
  private eng2!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private lfo!: OscillatorNode;
  private amp!: GainNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private voices = new Map<number, Voice>();
  private volume = 0.7;
  private lastGun = 0;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // white noise buffer
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // engine
    this.eng1 = ctx.createOscillator();
    this.eng1.type = 'sawtooth';
    this.eng2 = ctx.createOscillator();
    this.eng2.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 2;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0.6;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.4;
    this.lfo.connect(lfoDepth).connect(this.amp.gain);
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.eng1.connect(this.engFilter);
    this.eng2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.amp).connect(this.engGain).connect(this.master);
    this.eng1.start();
    this.eng2.start();
    this.lfo.start();

    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Per-frame update for the player's engine/wind and enemy voices. */
  update(rpm: number, airspeed: number, active: boolean, camera: THREE.Camera, enemies: { id: number; pos: THREE.Vector3; rpm: number; alive: boolean }[]) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 30 + rpm * 85;
    this.eng1.frequency.setTargetAtTime(f, t, 0.08);
    this.eng2.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.lfo.frequency.setTargetAtTime(f * 0.25, t, 0.08);
    this.engFilter.frequency.setTargetAtTime(350 + rpm * 1600, t, 0.08);
    this.engGain.gain.setTargetAtTime(active ? 0.05 + rpm * 0.11 : 0, t, 0.15);
    const w = Math.min(airspeed / 70, 1.4);
    this.windFilter.frequency.setTargetAtTime(400 + airspeed * 14, t, 0.2);
    this.windGain.gain.setTargetAtTime(active ? w * w * 0.22 : 0, t, 0.2);

    // listener
    const l = ctx.listener;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = camera.position.x;
      l.positionY.value = camera.position.y;
      l.positionZ.value = camera.position.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(camera.position.x, camera.position.y, camera.position.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }

    const seen = new Set<number>();
    for (const e of enemies) {
      seen.add(e.id);
      let v = this.voices.get(e.id);
      if (!v) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = 700;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const panner = ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = 40;
        panner.maxDistance = 4000;
        panner.rolloffFactor = 1.3;
        osc.connect(filt).connect(gain).connect(panner).connect(this.master);
        osc.start();
        v = { osc, gain, panner };
        this.voices.set(e.id, v);
      }
      v.osc.frequency.setTargetAtTime(34 + e.rpm * 80, t, 0.1);
      v.gain.gain.setTargetAtTime(active && e.alive ? 0.12 : 0, t, 0.2);
      if (v.panner.positionX) {
        v.panner.positionX.value = e.pos.x;
        v.panner.positionY.value = e.pos.y;
        v.panner.positionZ.value = e.pos.z;
      } else v.panner.setPosition(e.pos.x, e.pos.y, e.pos.z);
    }
    for (const [id, v] of this.voices) {
      if (seen.has(id)) continue;
      v.osc.stop();
      v.panner.disconnect();
      this.voices.delete(id);
    }
  }

  private burst(dur: number, filterType: BiquadFilterType, freq: number, gain: number, endFreq?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  gun(volume = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (volume < 1 && now - this.lastGun < 0.03) return;
    this.lastGun = now;
    this.burst(0.07, 'bandpass', 1400, 0.35 * volume);
    this.burst(0.05, 'lowpass', 300, 0.3 * volume);
  }

  hit() {
    this.burst(0.08, 'highpass', 2500, 0.3);
  }

  ouch() {
    this.burst(0.12, 'bandpass', 800, 0.4);
  }

  explosion(distance = 0) {
    const g = THREE.MathUtils.clamp(1 - distance / 2500, 0.08, 1);
    this.burst(1.6, 'lowpass', 1400, 0.9 * g, 80);
    this.burst(0.3, 'lowpass', 4000, 0.4 * g, 300);
  }

  splash() {
    this.burst(1.0, 'bandpass', 900, 0.6, 200);
  }

  click() {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.1);
  }

  fanfare(good: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const notes = good ? [523, 659, 784, 1047] : [392, 349, 311, 262];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.32);
    });
  }
}
