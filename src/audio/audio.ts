import * as THREE from 'three';
import type { EngineId } from '../plane/loadout';

/**
 * Audio (design §3): Web Audio API, fully synthesised (no files).
 * Engine loop following RPM with a profile per engine type (design §8.2):
 * prop = pulsing "putt", turbo = prop buzz + turbine whine, jet = filtered
 * noise roar + rising whistle. Wind with speed, explosions and splashes.
 * The context starts on the first user gesture (autoplay policy).
 */
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
  private lfoDepth!: GainNode;
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private roarFilter!: BiquadFilterNode;
  private roarGain!: GainNode;
  private engine: EngineId = 'prop';
  private volume = 0.7;

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
    this.lfoDepth = lfoDepth;
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

    // turbine whine / jet whistle
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.master);
    this.whine.start();

    // jet roar
    const roar = ctx.createBufferSource();
    roar.buffer = this.noise;
    roar.loop = true;
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.Q.value = 0.7;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    roar.connect(this.roarFilter).connect(this.roarGain).connect(this.master);
    roar.start();
  }

  setEngine(e: EngineId) {
    this.engine = e;
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

  /** Per-frame update for the player's engine and wind; gain scales the engine. */
  update(rpm: number, airspeed: number, active: boolean, gain = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const on = active ? gain : 0;
    let f: number;
    let engGain: number;
    let whineF = 1000;
    let whineGain = 0;
    let roarGain = 0;
    if (this.engine === 'turbo') {
      f = 45 + rpm * 120;
      engGain = 0.04 + rpm * 0.09;
      whineF = 900 + rpm * 1700;
      whineGain = 0.012 + rpm * 0.028;
      this.lfoDepth.gain.setTargetAtTime(0.15, t, 0.1);
      this.lfo.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    } else if (this.engine === 'jet') {
      f = 24 + rpm * 30;
      engGain = 0.02 + rpm * 0.02;
      whineF = 1400 + rpm * 2600;
      whineGain = 0.008 + rpm * 0.03;
      roarGain = 0.04 + rpm * 0.22;
      this.lfoDepth.gain.setTargetAtTime(0.05, t, 0.1);
      this.lfo.frequency.setTargetAtTime(7, t, 0.08);
    } else {
      f = 30 + rpm * 85;
      engGain = 0.05 + rpm * 0.11;
      this.lfoDepth.gain.setTargetAtTime(0.4, t, 0.1);
      this.lfo.frequency.setTargetAtTime(f * 0.25, t, 0.08);
    }
    this.eng1.frequency.setTargetAtTime(f, t, 0.08);
    this.eng2.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.engFilter.frequency.setTargetAtTime(350 + rpm * 1600, t, 0.08);
    this.engGain.gain.setTargetAtTime(engGain * on, t, 0.15);
    this.whine.frequency.setTargetAtTime(whineF, t, 0.3);
    this.whineGain.gain.setTargetAtTime(whineGain * on, t, 0.2);
    this.roarFilter.frequency.setTargetAtTime(250 + rpm * 1800, t, 0.2);
    this.roarGain.gain.setTargetAtTime(roarGain * on, t, 0.2);
    const w = Math.min(airspeed / 70, 1.4);
    this.windFilter.frequency.setTargetAtTime(400 + airspeed * 14, t, 0.2);
    this.windGain.gain.setTargetAtTime(active ? w * w * 0.22 : 0, t, 0.2);

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
