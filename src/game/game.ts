import * as THREE from 'three';
import { AudioEngine } from '../audio/audio';
import { AIPilot, SKILLS, type Skill } from '../combat/ai';
import { Bullets, type HitInfo } from '../combat/weapons';
import { Input } from '../core/input';
import { Loop } from '../core/loop';
import { loadSettings, saveSettings, randomSeed, submitBest, type Difficulty, type Settings } from '../core/settings';
import { Effects } from '../fx/effects';
import { ENEMY_LIVERY, PLAYER_LIVERY } from '../plane/biplaneMesh';
import { DEFAULT_SPEC, groundAttitude, restHeight, stepFlight, type Env, type PlaneSpec } from '../plane/flight';
import { Plane } from '../plane/plane';
import { bankAngle } from '../plane/steer';
import { outlineMaterial } from '../render/outline';
import { PostFX } from '../render/post';
import { Sky, sunDirection } from '../render/sky';
import { toonMaterial } from '../render/toon';
import { Water } from '../render/water';
import { Hud } from '../ui/hud';
import { Menus } from '../ui/menus';
import { hash32, mulberry32 } from '../world/rng';
import { CHUNK_SIZE } from '../world/terrain';
import { World } from '../world/world';
import { CameraRig } from './camera';

/**
 * GameStateMachine (design §6) implementing the Core Gameplay Loop (§2):
 * Title/Hangar → Loading (world prewarm) → Sortie [takeoff | flight | combat |
 * landing] → Ending (crash/landed) → Debrief.
 */
type State = 'title' | 'loading' | 'sortie' | 'ending' | 'debrief';
type TierName = 'low' | 'medium' | 'high';
type Result = 'landed' | 'field landing' | 'crashed' | 'shot down' | 'ditched' | 'bailed out';

interface Tier {
  radius: number;
  post: boolean;
  shadows: boolean;
  shadowSize: number;
  maxPR: number;
}

const TIERS: Record<TierName, Tier> = {
  low: { radius: 4, post: false, shadows: false, shadowSize: 1024, maxPR: 1 },
  medium: { radius: 6, post: true, shadows: true, shadowSize: 1024, maxPR: 1.5 },
  high: { radius: 8, post: true, shadows: true, shadowSize: 2048, maxPR: 2 },
};

const PLAYER_DAMAGE: Record<Difficulty, number> = { rookie: 0.3, veteran: 0.4, ace: 0.5 };
const ENEMY_COUNT: Record<Difficulty, number> = { rookie: 2, veteran: 3, ace: 4 };
const ZONE_DAMAGE = { engine: 0.09, wings: 0.06, tail: 0.1, pilot: 0.15, fuselage: 0.05 };

interface Touchdown {
  sink: number;
  bank: number;
  speed: number;
  onRunway: boolean;
  t: number;
}

interface Mission {
  type: Settings['mission'];
  difficulty: Difficulty;
  tookOff: boolean;
  takeoffT: number;
  spawnAt: number;
  enemiesSpawned: boolean;
  enemiesTotal: number;
  objectiveDone: boolean;
  touch: Touchdown | null;
  bounces: number;
  stoppedT: number;
  result: Result | null;
  resultText: string;
  grade: string;
  endT: number;
  wreckAt: THREE.Vector3 | null;
  hintStage: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.5, 6000);
  readonly settings: Settings;
  private input: Input;
  private loop: Loop;
  private rig: CameraRig;
  private post = new PostFX();
  private sky = new Sky();
  private water = new Water();
  private sun = new THREE.DirectionalLight(0xffffff, 2.8);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 1.2);
  private fx = new Effects();
  private bullets = new Bullets();
  private audio = new AudioEngine();
  private hud: Hud;
  private ui: Menus;
  private world: World | null = null;
  private env: Env | null = null;
  private planes: Plane[] = [];
  private player: Plane | null = null;
  private planeToon = toonMaterial({ vertexColors: true, rim: 0.3 });
  private planeOutline = outlineMaterial(0x2b1d1a, 1.1, 400);
  private spec: PlaneSpec = { ...DEFAULT_SPEC };
  private state: State = 'title';
  private paused = false;
  private simTime = 0;
  private tick = 0;
  private time = 0;
  private loadT = 0;
  private tierName: TierName = 'medium';
  private tier: Tier = TIERS.medium;
  private renderScale = 1;
  private frameAvg = 16;
  private resTimer = 0;
  private hurt = 0;
  private rnd = mulberry32(1);
  private mission!: Mission;
  private contextLost = false;
  private stats: HTMLDivElement | null = null;

  constructor(canvas: HTMLCanvasElement, hudCanvas: HTMLCanvasElement) {
    this.settings = loadSettings();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x9fd3ef);

    this.input = new Input(canvas);
    this.input.invertPitch = this.settings.invertPitch;
    this.rig = new CameraRig(this.camera);
    this.hud = new Hud(hudCanvas);
    this.ui = new Menus(this.settings, {
      fly: () => this.fly(),
      resume: () => this.setPaused(false),
      restart: () => this.startSortie(),
      quit: () => this.toTitle(),
      again: () => this.startSortie(),
      newWorld: () => {
        this.settings.seed = randomSeed();
        saveSettings(this.settings);
        this.ui.setSeed(this.settings.seed);
        this.newWorld(this.settings.seed);
        this.startSortie();
      },
      seedChanged: (s) => this.newWorld(s),
      qualityChanged: () => this.applyTier(),
      volumeChanged: (v) => this.audio.setVolume(v),
      click: () => this.audio.click(),
    });
    this.audio.setVolume(this.settings.volume);

    this.scene.add(this.sky.mesh, this.water.mesh, this.hemi, this.sun, this.sun.target, this.fx.group, this.bullets.mesh);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -130;
    sc.right = 130;
    sc.top = 130;
    sc.bottom = -130;
    sc.near = 1;
    sc.far = 1500;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    this.scene.fog = new THREE.Fog(0xcfe9f5, 800, 3000);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.setPaused(true);
      this.ui.show('ctxlost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.ui.show(this.state === 'title' ? 'title' : 'pause');
    });
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'sortie' || this.state === 'ending')) this.setPaused(true);
    });

    this.applyTier();
    this.newWorld(this.settings.seed);
    this.resize();
    this.ui.show('title');
    this.loop = new Loop(
      (dt) => this.step(dt),
      (dt, a) => this.frame(dt, a),
    );
    if (location.search.includes('debug')) void this.setupDebug();
  }

  start() {
    this.loop.start();
  }

  // ------------------------------------------------------------------ setup

  private pickTier(): TierName {
    if (this.settings.quality !== 'auto') return this.settings.quality;
    const cores = navigator.hardwareConcurrency || 4;
    const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    return mobile || cores <= 4 ? 'low' : 'medium';
  }

  private applyTier() {
    const name = this.pickTier();
    const prevShadows = this.renderer.shadowMap.enabled;
    this.tierName = name;
    this.tier = TIERS[name];
    this.renderScale = 1;
    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.sun.castShadow = this.tier.shadows;
    if (this.sun.shadow.mapSize.x !== this.tier.shadowSize) {
      this.sun.shadow.mapSize.set(this.tier.shadowSize, this.tier.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (prevShadows !== this.tier.shadows) {
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    if (this.world) this.world.setRadius(this.tier.radius);
    this.updateDistances();
    this.resize();
  }

  private updateDistances() {
    const far = this.tier.radius * CHUNK_SIZE;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = far * 0.25;
    fog.far = far * 0.95;
    this.camera.far = far + 2500;
    this.camera.updateProjectionMatrix();
    this.post.setFade(far * 0.3, far * 0.85);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.tier.maxPR) * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w * pr, h * pr);
    this.hud.resize();
  }

  private newWorld(seed: number) {
    if (this.world) {
      this.scene.remove(this.world.group);
      this.world.dispose();
    }
    this.clearPlanes();
    const w = new World(seed, this.tier.radius);
    this.world = w;
    this.env = { groundHeight: (x, z) => w.groundHeight(x, z), wind: w.wind };
    this.scene.add(w.group);
    w.setRadius(this.tier.radius);
    const t = w.time;
    this.sky.setTime(t);
    this.sun.color.setHex(t.sunColor);
    this.sun.intensity = t.sunIntensity;
    this.hemi.color.setHex(t.hemiSky);
    this.hemi.groundColor.setHex(t.hemiGround);
    this.hemi.intensity = t.hemiIntensity;
    (this.scene.fog as THREE.Fog).color.setHex(t.horizon);
    this.renderer.setClearColor(t.horizon);
    this.post.setInk(t.ink);
    (this.planeOutline.uniforms.outlineColor.value as THREE.Color).setHex(t.ink);
    this.hud.invalidateMinimap();
    this.rnd = mulberry32(hash32(seed, 31337));
  }

  private clearPlanes() {
    for (const p of this.planes) {
      this.scene.remove(p.visual.root);
      p.visual.dispose();
    }
    this.planes = [];
    this.player = null;
    this.bullets.clear();
    this.fx.clear();
  }

  // ----------------------------------------------------------- state changes

  private fly() {
    this.audio.init();
    this.audio.click();
    this.startSortie();
  }

  private toTitle() {
    this.setPaused(false);
    this.clearPlanes();
    this.state = 'title';
    this.hud.visible = false;
    this.hud.clear();
    this.ui.clearHint();
    this.ui.setWhiteout(0);
    this.ui.refreshBest();
    this.ui.show('title');
  }

  private setPaused(p: boolean) {
    if (p && !(this.state === 'sortie' || this.state === 'ending')) return;
    this.paused = p;
    if (p) {
      this.audio.suspend();
      if (!this.contextLost) this.ui.show('pause');
    } else {
      this.audio.resume();
      this.input.invertPitch = this.settings.invertPitch;
      this.rig.shakeEnabled = this.settings.cameraShake;
      if (this.state === 'sortie' || this.state === 'ending') this.ui.show('none');
    }
  }

  private startSortie() {
    const w = this.world!;
    this.setPaused(false);
    this.clearPlanes();
    this.input.invertPitch = this.settings.invertPitch;
    this.rig.shakeEnabled = this.settings.cameraShake;
    const p = new Plane('player', PLAYER_LIVERY, this.planeToon, this.planeOutline, this.spec);
    const af = w.home;
    // take off into the wind
    let dx = af.dirX;
    let dz = af.dirZ;
    if (w.wind.x * dx + w.wind.z * dz > 0) {
      dx = -dx;
      dz = -dz;
    }
    const back = af.length / 2 - 30;
    const x = af.x - dx * back;
    const z = af.z - dz * back;
    p.s.quat.copy(groundAttitude(dx, dz));
    p.s.pos.set(x, w.groundHeight(x, z) + restHeight(p.s.quat), z);
    p.s.rpm = 0.15;
    p.teleport();
    this.input.resetThrottle(0);
    this.planes.push(p);
    this.player = p;
    this.scene.add(p.visual.root);
    this.simTime = 0;
    this.tick = 0;
    this.hurt = 0;
    this.mission = {
      type: this.settings.mission,
      difficulty: this.settings.difficulty,
      tookOff: false,
      takeoffT: 0,
      spawnAt: Infinity,
      enemiesSpawned: false,
      enemiesTotal: this.settings.mission === 'dogfight' ? ENEMY_COUNT[this.settings.difficulty] : 0,
      objectiveDone: false,
      touch: null,
      bounces: 0,
      stoppedT: 0,
      result: null,
      resultText: '',
      grade: '—',
      endT: 0,
      wreckAt: null,
      hintStage: 0,
    };
    this.rig.reset();
    this.rig.mode = 'chase';
    this.state = 'loading';
    this.loadT = 0;
    this.hud.visible = false;
    this.ui.setLoading(0);
    this.ui.show('loading');
    this.ui.clearHint();
  }

  private beginSortie() {
    this.state = 'sortie';
    this.hud.visible = true;
    this.hud.invalidateMinimap();
    this.ui.show('none');
    this.ui.hint('Open the throttle: hold Shift (or press 0). Steer with Q / E.', 6000);
  }

  private get enemies(): Plane[] {
    return this.planes.filter((p) => p.team === 'enemy');
  }

  private spawnEnemies() {
    const w = this.world!;
    const p = this.player!;
    const m = this.mission;
    m.enemiesSpawned = true;
    const ang = this.rnd() * Math.PI * 2;
    const base = _v.set(Math.cos(ang), 0, Math.sin(ang)).multiplyScalar(2600).add(p.s.pos);
    const toward = _v2.copy(p.s.pos).sub(base).setY(0).normalize();
    const gy = Math.max(w.groundHeight(base.x, base.z), 0);
    const y = Math.max(gy + 380, p.s.pos.y + 120);
    const lead = this.settings.difficulty;
    for (let i = 0; i < m.enemiesTotal; i++) {
      const skill: Skill = i === 0 ? SKILLS[lead] : SKILLS[lead === 'ace' ? 'veteran' : lead === 'veteran' ? 'rookie' : 'rookie'];
      const e = new Plane('enemy', ENEMY_LIVERY, this.planeToon, this.planeOutline, this.spec);
      const side = new THREE.Vector3(-toward.z, 0, toward.x);
      e.s.pos.copy(base).addScaledVector(side, (i - (m.enemiesTotal - 1) / 2) * 55).addScaledVector(toward, -i * 25);
      e.s.pos.y = y + i * 12;
      const right = new THREE.Vector3().crossVectors(toward, THREE.Object3D.DEFAULT_UP).normalize();
      const mat = new THREE.Matrix4().makeBasis(right, THREE.Object3D.DEFAULT_UP, toward.clone().negate());
      e.s.quat.setFromRotationMatrix(mat);
      e.s.vel.copy(toward).multiplyScalar(45);
      e.s.rpm = 1;
      e.ai = new AIPilot(skill, mulberry32(hash32(this.settings.seed, i, Math.floor(this.simTime))));
      e.teleport();
      this.planes.push(e);
      this.scene.add(e.visual.root);
    }
    this.ui.toast('BANDITS!');
    this.ui.hint('Get on their tail and fire with Space. Aim at the ◇ lead marker.', 6000);
  }

  // ---------------------------------------------------------------- combat

  private onHit(h: HitInfo) {
    const t = h.target;
    if (t.wrecked) return;
    const mult = t.team === 'player' ? PLAYER_DAMAGE[this.mission.difficulty] : 1;
    const dmg = ZONE_DAMAGE[h.zone] * mult * (0.8 + Math.random() * 0.4);
    const hl = t.s.health;
    switch (h.zone) {
      case 'engine':
        hl.engine -= dmg;
        break;
      case 'wings':
        hl.wings -= dmg;
        break;
      case 'tail':
        hl.tail -= dmg;
        break;
      case 'pilot':
        hl.pilot -= dmg;
        break;
      case 'fuselage':
        hl.tail -= dmg * 0.5;
        hl.engine -= dmg * 0.5;
        break;
    }
    hl.engine = Math.max(0, hl.engine);
    hl.wings = Math.max(0, hl.wings);
    hl.tail = Math.max(0, hl.tail);
    hl.pilot = Math.max(0, hl.pilot);
    t.damageTaken += dmg;
    t.lastAttacker = h.shooter;
    h.shooter.hits++;
    this.fx.sparksAt(h.point, 5);
    if (Math.random() < 0.3) this.fx.debris(h.point, t.s.vel, t.team === 'player' ? PLAYER_LIVERY.body : ENEMY_LIVERY.wing);
    if (t === this.player) {
      this.rig.addShake(0.25);
      this.hurt = Math.min(1, this.hurt + 0.35);
      this.audio.ouch();
    } else if (h.shooter === this.player) this.audio.hit();
    if (t.alive && (hl.wings <= 0 || hl.tail <= 0 || hl.pilot <= 0 || (t.team === 'enemy' && hl.engine <= 0))) this.downPlane(t, h.shooter);
  }

  private downPlane(t: Plane, by: Plane | null) {
    if (t.downed || t.wrecked) return;
    t.downed = true;
    t.downedSide = Math.random() < 0.5 ? -1 : 1;
    t.s.health.engine = 0;
    this.fx.explosion(t.s.pos, true);
    this.audio.explosion(this.camera.position.distanceTo(t.s.pos));
    if (t.team === 'enemy' && by === this.player && this.player) {
      this.player.kills++;
      const left = this.enemies.filter((e) => e.alive).length;
      this.ui.toast(left ? `KILL!  ${this.player.kills}/${this.mission.enemiesTotal}` : 'SKY CLEARED!');
    }
    if (t === this.player) {
      this.ui.toast('SHOT DOWN!');
      this.ui.hint('Out of control! Press X to bail out.', 4000);
    }
  }

  private crashPlane(t: Plane, reason: string, splash: boolean) {
    if (t.wrecked) return;
    t.wrecked = true;
    t.visual.root.visible = false;
    const pos = t.s.pos.clone();
    if (splash) {
      this.fx.splash(pos);
      this.audio.splash();
    } else {
      this.fx.explosion(pos, true);
      this.audio.explosion(this.camera.position.distanceTo(pos));
      const cols = t.team === 'player' ? [PLAYER_LIVERY.body, PLAYER_LIVERY.wing] : [ENEMY_LIVERY.body, ENEMY_LIVERY.wing];
      for (let i = 0; i < 12; i++) this.fx.debris(pos, t.s.vel.clone().multiplyScalar(0.3), cols[i % 2]);
    }
    if (t.team === 'enemy' && !t.downed && t.lastAttacker === this.player && this.player) {
      this.player.kills++;
      this.ui.toast(`KILL!  ${this.player.kills}/${this.mission.enemiesTotal}`);
    }
    const wasDowned = t.downed;
    t.downed = true;
    if (t === this.player) {
      const m = this.mission;
      if (!m.result) {
        m.result = splash ? 'ditched' : wasDowned ? 'shot down' : 'crashed';
        m.resultText = reason;
      }
      this.rig.addShake(1);
      this.ui.toast(splash ? 'SPLASH!' : 'CRASH!');
      this.endSortie(3.5, pos);
    }
  }

  private endSortie(delay: number, wreckAt: THREE.Vector3 | null) {
    const m = this.mission;
    if (this.state === 'ending') return;
    this.state = 'ending';
    m.endT = delay;
    m.wreckAt = wreckAt;
    this.hud.visible = wreckAt === null;
    this.ui.clearHint();
  }

  private finishLanding() {
    const m = this.mission;
    const p = this.player!;
    const w = this.world!;
    const onField = w.gen.fieldMask(p.s.pos.x, p.s.pos.z) > 0.5;
    m.result = onField ? 'landed' : 'field landing';
    const t = m.touch;
    let score = 0;
    if (t) {
      score += t.sink < 1.5 ? 2 : t.sink < 3 ? 1 : 0;
      score += t.bank < 0.09 ? 1 : 0;
      score += t.onRunway ? 1 : 0;
      score += m.bounces === 0 ? 1 : 0;
    }
    if (!onField) score = Math.min(score, 2);
    m.grade = score >= 5 ? 'A+' : score === 4 ? 'A' : score === 3 ? 'B' : score === 2 ? 'C' : 'D';
    const words: Record<string, string> = { 'A+': 'GREASER!', A: 'SMOOTH!', B: 'NOT BAD!', C: 'FIRM...', D: 'OOF!' };
    m.resultText = onField ? `Landed at ${w.home === w.gen.nearestAirfield(p.s.pos.x, p.s.pos.z).af ? 'home field' : 'an airfield'}` : 'Landed in a field';
    this.ui.toast(`${words[m.grade]}  ${m.grade}`);
    this.audio.fanfare(true);
    this.endSortie(2.5, null);
  }

  private showDebrief() {
    const m = this.mission;
    const p = this.player!;
    this.state = 'debrief';
    this.hud.visible = false;
    this.hud.clear();
    const landedOk = m.result === 'landed' || m.result === 'field landing';
    const allKilled = m.enemiesTotal > 0 && p.kills >= m.enemiesTotal;
    const damage = 1 - p.integrity;
    const gradeA = m.grade === 'A' || m.grade === 'A+';
    let medal = 0;
    if (m.type === 'dogfight') {
      if (landedOk && allKilled && damage < 0.3 && gradeA) medal = 3;
      else if (landedOk && allKilled) medal = 2;
      else if (landedOk || p.kills > 0) medal = 1;
    } else {
      if (landedOk && gradeA) medal = 3;
      else if (landedOk && m.grade === 'B') medal = 2;
      else if (landedOk) medal = 1;
    }
    const flight = m.tookOff ? this.simTime - m.takeoffT : 0;
    const mmss = `${Math.floor(flight / 60)}:${String(Math.floor(flight % 60)).padStart(2, '0')}`;
    const rows: [string, string][] = [['Result', `${m.result ?? '—'}${m.resultText ? ` (${m.resultText})` : ''}`]];
    if (m.type === 'dogfight') rows.push(['Kills', `${p.kills} / ${m.enemiesTotal}`]);
    rows.push(['Accuracy', p.shots ? `${Math.round((p.hits / p.shots) * 100)}%  (${p.hits}/${p.shots})` : '—']);
    rows.push(['Damage taken', `${Math.round(damage * 100)}%`]);
    if (m.touch) rows.push(['Touchdown', `${m.touch.sink.toFixed(1)} m/s sink, ${Math.round((m.touch.bank * 180) / Math.PI)}° bank`]);
    rows.push(['Landing grade', landedOk ? m.grade : '—']);
    rows.push(['Flight time', mmss]);
    rows.push(['World seed', String(this.settings.seed)]);
    const newBest = submitBest(this.settings.seed, m.type, { medal, kills: p.kills, landing: landedOk ? m.grade : '—' });
    const title = landedOk ? (medal >= 2 ? 'Mission accomplished!' : 'Back on the ground') : m.result === 'bailed out' ? 'Hit the silk!' : 'Better luck next time';
    this.ui.showDebrief({ title, medal, rows, newBest });
    this.audio.fanfare(medal >= 2);
  }

  // ------------------------------------------------------------ simulation

  private assist(p: Plane) {
    const a = this.settings.assist;
    const inp = p.input;
    const s = p.s;
    if (a === 'expert' || s.onGround) return;
    // auto-rudder
    inp.yaw = THREE.MathUtils.clamp(inp.yaw + inp.roll * 0.3, -1, 1);
    if (a === 'arcade') {
      if (Math.abs(inp.roll) < 0.05 && !this.input.mouseStick) {
        const level = bankAngle(s);
        if (Math.abs(level) < 1.4) inp.roll = THREE.MathUtils.clamp(level * 0.9 + s.angVel.z * 0.25, -0.6, 0.6);
      }
      if (s.alpha > p.spec.stallAlpha * 0.85 && inp.pitch > 0) inp.pitch *= 0.35;
    }
  }

  private downedControls(p: Plane) {
    const inp = p.input;
    inp.throttle = 0;
    inp.roll = 0.7 * p.downedSide;
    inp.pitch = 0.2;
    inp.yaw = 0.3 * p.downedSide;
    inp.fire = false;
    inp.brake = false;
  }

  private emitFx(p: Plane, dt: number) {
    const s = p.s;
    p.smokeT -= dt;
    if (p.smokeT <= 0) {
      p.smokeT = 1 / 30;
      const h = s.health;
      if (p.downed || h.engine < 0.6 || h.wings < 0.5) {
        _v.set(0, 0.4, -1.6).applyQuaternion(s.quat).add(s.pos);
        this.fx.smoke(_v, s.vel, p.downed ? 1 : 1 - h.engine);
        if (p.downed || h.engine < 0.25) this.fx.fire(_v, s.vel);
      }
    }
    p.dustT -= dt;
    if (s.onGround && p.dustT <= 0) {
      const sp = s.vel.length();
      if (sp > 6) {
        p.dustT = 1 / 8;
        _v.set(Math.random() < 0.5 ? -0.9 : 0.9, -1.3, -0.4).applyQuaternion(s.quat).add(s.pos);
        this.fx.dust(_v);
      }
    }
  }

  private step(dt: number) {
    if (this.paused || !this.world || !this.env) return;
    if (this.state !== 'sortie' && this.state !== 'ending') return;
    const w = this.world;
    const p = this.player!;
    const m = this.mission;
    this.tick++;
    this.simTime += dt;

    for (const pl of this.planes) pl.savePrev();

    // controls
    if (this.state === 'sortie' && p.alive) {
      this.input.sample(dt, p.input);
      this.assist(p);
    } else if (p.downed) this.downedControls(p);
    else {
      // landed / ending: idle and brake
      p.input.throttle = 0;
      p.input.pitch = p.input.roll = p.input.yaw = 0;
      p.input.fire = false;
      p.input.brake = true;
    }
    const enemies = this.enemies;
    const gh = this.env.groundHeight;
    for (const e of enemies) {
      if (e.wrecked) continue;
      if (e.alive && e.ai) e.ai.update(dt, e, p.alive ? p : null, enemies, gh);
      else this.downedControls(e);
    }

    // physics
    for (const pl of this.planes) {
      if (pl.wrecked) continue;
      const ev = stepFlight(pl.s, pl.spec, pl.input, this.env, dt);
      if (ev.crashed) {
        this.crashPlane(pl, ev.crashed, ev.splash);
        continue;
      }
      if (ev.propStrike) {
        pl.s.health.engine = Math.max(0, pl.s.health.engine - 1.5 * dt);
        if (this.tick % 6 === 0) this.fx.sparksAt(_v.set(0, -1.1, -2.9).applyQuaternion(pl.s.quat).add(pl.s.pos), 2);
      }
      if (ev.scrape) {
        pl.s.health.wings = Math.max(0, pl.s.health.wings - 0.4 * dt);
        if (this.tick % 8 === 0) this.fx.dust(pl.s.pos);
      }
      if (ev.touchdown && pl === p && m.tookOff) {
        const prev = m.touch;
        if (prev && this.simTime - prev.t < 4) m.bounces++;
        else {
          m.bounces = 0;
          const onRunway = !!w.gen.runwayAt(p.s.pos.x, p.s.pos.z, 4);
          m.touch = { ...ev.touchdown, onRunway, t: this.simTime };
        }
        if (ev.touchdown.sink > 2.5) this.rig.addShake(Math.min(0.6, ev.touchdown.sink * 0.1));
      }
      this.emitFx(pl, dt);
    }

    // guns & bullets
    for (const pl of this.planes) {
      if (pl.wrecked) continue;
      this.bullets.updateGuns(pl, dt, (muzzle, shooter) => {
        this.fx.muzzle(muzzle, shooter.s.vel);
        if (shooter === p) {
          this.audio.gun();
          this.rig.addShake(0.035);
        } else if (shooter.s.pos.distanceTo(this.camera.position) < 700) this.audio.gun(0.35);
      });
    }
    this.bullets.step(
      dt,
      this.planes,
      gh,
      (h) => this.onHit(h),
      (pt) => {
        if (pt.distanceToSquared(this.camera.position) < 1500 * 1500) this.fx.groundHit(pt);
      },
      this.tick,
    );

    // mid-air collisions
    for (let i = 0; i < this.planes.length; i++)
      for (let j = i + 1; j < this.planes.length; j++) {
        const a = this.planes[i];
        const b = this.planes[j];
        if (a.wrecked || b.wrecked) continue;
        if (a.s.pos.distanceToSquared(b.s.pos) < 4.5 * 4.5) {
          a.s.health.wings = 0;
          b.s.health.wings = 0;
          this.downPlane(a, b);
          this.downPlane(b, a);
        }
      }

    // remove long-gone wrecks
    for (const e of enemies) if (e.wrecked) e.wreckT += dt;

    // ------------------------------------------------------ mission logic
    if (this.state === 'sortie' && p.alive) {
      const agl = p.s.pos.y - Math.max(w.groundHeight(p.s.pos.x, p.s.pos.z), 0);
      if (m.hintStage === 0 && p.s.onGround && p.s.airspeed > 14) {
        m.hintStage = 1;
        this.ui.hint('Ease the tail up with W, then pull back gently with S at about 90 km/h.', 6000);
      }
      if (!m.tookOff && p.s.airTime > 2 && agl > 15) {
        m.tookOff = true;
        m.takeoffT = this.simTime;
        m.touch = null;
        this.ui.toast('AIRBORNE!');
        if (m.type === 'dogfight') {
          m.spawnAt = this.simTime + 15;
          this.ui.hint('Climb out! Bandits will show up soon — watch for red markers.', 6000);
        } else this.ui.hint('Enjoy the view! Land on any airfield strip to finish.', 6000);
      }
      if (m.type === 'dogfight' && m.tookOff && !m.enemiesSpawned && this.simTime >= m.spawnAt) this.spawnEnemies();
      if (m.enemiesSpawned && !m.objectiveDone && enemies.every((e) => !e.alive)) {
        m.objectiveDone = true;
        this.ui.hint('Sky cleared! Return to an airfield and land: throttle back, gentle descent.', 7000);
      }
      if (m.tookOff && p.s.onGround && p.s.vel.length() < 2.5) {
        m.stoppedT += dt;
        if (m.stoppedT > 1.2) this.finishLanding();
      } else m.stoppedT = 0;
    }
  }

  // ---------------------------------------------------------------- frame

  private handleKeys() {
    const i = this.input;
    if (i.wasPressed('Escape') || i.wasPressed('KeyP') || i.padWasPressed(9)) {
      if (this.state === 'sortie' || this.state === 'ending') this.setPaused(!this.paused);
    }
    if (this.paused) return;
    if (this.state === 'sortie' || this.state === 'ending') {
      if (i.wasPressed('KeyC') || i.padWasPressed(3)) {
        this.rig.cycle();
        this.ui.toast(this.rig.mode.toUpperCase(), 700);
      }
      if (i.wasPressed('KeyR')) this.startSortie();
    }
    if (this.state === 'sortie') {
      if (i.wasPressed('KeyM')) {
        i.mouseStick = !i.mouseStick;
        this.ui.hint(i.mouseStick ? 'Mouse stick ON: move the cursor to fly, click to fire.' : 'Mouse stick OFF', 3000);
      }
      const p = this.player;
      if (i.wasPressed('KeyX') && p && !p.wrecked && !p.s.onGround && this.mission.tookOff) {
        if (!p.downed) this.downPlane(p, null);
        this.mission.result = 'bailed out';
        this.mission.resultText = 'Parachuted to safety';
        this.ui.toast('BAILED OUT!');
        this.endSortie(4, p.s.pos.clone());
      }
    }
    if (this.state === 'title' && (i.wasPressed('Enter') || i.padWasPressed(0))) this.fly();
  }

  private objectiveText(): string {
    const m = this.mission;
    if (!m.tookOff) return 'Take off!';
    if (m.type === 'free') return 'Free flight — land on any strip to finish';
    if (!m.enemiesSpawned) return 'Climb and patrol — bandits incoming';
    const alive = this.enemies.filter((e) => e.alive).length;
    if (alive > 0) return `Shoot down the bandits  ${m.enemiesTotal - alive}/${m.enemiesTotal}`;
    return 'Return to an airfield and land!';
  }

  private frame(dt: number, alpha: number) {
    this.input.pollPad();
    this.handleKeys();
    this.time += dt;
    const w = this.world;
    if (!w) return;

    const t0 = performance.now();
    const p = this.player;

    switch (this.state) {
      case 'title':
      case 'debrief': {
        const af = w.home;
        this.rig.orbit(dt, _v.set(af.x, af.height + 20, af.z), 650, 170, 0.04);
        w.update(this.camera.position, null, dt);
        break;
      }
      case 'loading': {
        this.loadT += dt;
        w.update(p!.s.pos, null, dt);
        p!.syncVisual(1, dt);
        this.rig.follow(dt, p!.s.pos, p!.s.quat, 0, (x, z) => w.groundHeight(x, z), null);
        const r = w.chunks.readiness(p!.s.pos, 2);
        this.ui.setLoading(r);
        if (r >= 1 && this.loadT > 0.4) this.beginSortie();
        break;
      }
      case 'sortie':
      case 'ending': {
        for (const pl of this.planes) if (!pl.wrecked) pl.syncVisual(this.paused ? 1 : alpha, this.paused ? 0 : dt);
        // drop wrecks after a while
        for (const e of this.planes) if (e.wrecked && e.wreckT > 6 && e !== p) this.scene.remove(e.visual.root);
        const m = this.mission;
        if (this.state === 'ending' && m.wreckAt) {
          this.rig.orbit(dt, m.wreckAt, 45, 18, 0.35);
        } else if (p) {
          let padlock: THREE.Vector3 | null = null;
          if (this.rig.mode === 'padlock') {
            let best = Infinity;
            for (const e of this.enemies)
              if (e.alive) {
                const d = e.s.pos.distanceToSquared(p.s.pos);
                if (d < best) {
                  best = d;
                  padlock = e.visual.root.position;
                }
              }
          }
          this.rig.follow(dt, p.visual.root.position, p.visual.root.quaternion, p.s.airspeed, (x, z) => w.groundHeight(x, z), padlock);
        }
        w.update(this.camera.position, p ? p.s.vel : null, this.paused ? 0 : dt);
        if (this.state === 'ending' && !this.paused) {
          m.endT -= dt;
          if (m.endT <= 0) this.showDebrief();
        }
        break;
      }
    }

    // world dressing
    this.sky.follow(this.camera, this.camera.far * 0.9);
    this.water.update(this.camera, this.time, this.camera.far * 2.2);
    const focus = p && this.state !== 'title' && this.state !== 'debrief' ? p.s.pos : this.camera.position;
    const sd = sunDirection(w.time);
    const snap = (260 / this.tier.shadowSize) * 2;
    this.sun.target.position.set(Math.round(focus.x / snap) * snap, Math.round(focus.y / snap) * snap, Math.round(focus.z / snap) * snap);
    this.sun.position.copy(this.sun.target.position).addScaledVector(sd, 600);
    if (!this.paused) {
      this.fx.update(dt, this.camera.position);
      this.bullets.syncVisual();
    }

    // overlays
    const dens = w.clouds.densityAt(this.camera.position);
    this.ui.setWhiteout(Math.min(1, dens * 3) * 0.92);
    this.hurt = Math.max(0, this.hurt - dt * 1.2);
    const lowHealth = p && p.alive && this.state === 'sortie' ? Math.max(0, 0.45 - p.integrity) : 0;
    this.ui.setHurt(Math.min(1, this.hurt + lowHealth));
    if (p && (this.state === 'sortie' || this.state === 'ending')) {
      const enemies = this.enemies;
      const agl = p.s.pos.y - Math.max(w.groundHeight(p.s.pos.x, p.s.pos.z), 0);
      const m = this.mission;
      this.hud.draw(
        {
          player: p,
          enemies,
          world: w,
          camera: this.camera,
          objective: this.objectiveText(),
          mouseStick: this.input.mouseStick,
          mouse: this.input.mouse,
          stallWarn: p.s.stalled && !p.s.onGround,
          showLanding: m.tookOff && agl < 450 && (m.type === 'free' || m.objectiveDone || p.integrity < 0.5 || p.s.ammo === 0),
        },
        dt,
      );
      this.audio.update(
        p.s.rpm,
        p.s.airspeed,
        !this.paused && !p.wrecked,
        this.camera,
        enemies.map((e) => ({ id: e.id, pos: e.s.pos, rpm: e.s.rpm, alive: !e.wrecked })),
      );
    } else {
      this.audio.update(0, 0, false, this.camera, []);
    }

    // render
    if (!this.contextLost) {
      if (this.tier.post) this.post.render(this.renderer, this.scene, this.camera);
      else this.renderer.render(this.scene, this.camera);
    }

    // dynamic resolution
    const cpu = performance.now() - t0;
    this.frameAvg += (dt * 1000 - this.frameAvg) * 0.05;
    this.resTimer += dt;
    if (this.resTimer > 2 && this.state !== 'title') {
      this.resTimer = 0;
      if (this.frameAvg > 22 && this.renderScale > 0.6) {
        this.renderScale = Math.max(0.6, this.renderScale - 0.1);
        this.resize();
      } else if (this.frameAvg < 14 && this.renderScale < 1) {
        this.renderScale = Math.min(1, this.renderScale + 0.1);
        this.resize();
      }
    }
    if (this.stats) {
      const info = this.renderer.info.render;
      this.stats.textContent = `${(1000 / this.frameAvg).toFixed(0)} fps  cpu ${cpu.toFixed(1)}ms  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k  chunks ${w.chunks.chunkCount}  props ${w.props.instanceTotal}  tier ${this.tierName} x${this.renderScale.toFixed(1)}`;
    }
    this.input.endFrame();
  }

  // ---------------------------------------------------------------- debug

  private async setupDebug() {
    const { default: GUI } = await import('lil-gui');
    const gui = new GUI({ title: 'Flight model (live)' });
    const keys = Object.keys(this.spec) as (keyof PlaneSpec)[];
    for (const k of keys) gui.add(this.spec, k);
    gui.close();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;top:8px;font:12px monospace;color:#fff;background:rgba(0,0,0,.45);padding:3px 6px;border-radius:4px;pointer-events:none;z-index:10';
    document.body.append(el);
    this.stats = el;
    (window as unknown as { baron: Game }).baron = this;
  }
}
