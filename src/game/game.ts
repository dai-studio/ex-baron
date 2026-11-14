import * as THREE from 'three';
import { AudioEngine } from '../audio/audio';
import { Input } from '../core/input';
import { Loop } from '../core/loop';
import { bestKey, loadSettings, saveSettings, randomSeed, submitBest, type Settings } from '../core/settings';
import { Effects } from '../fx/effects';
import { DEFAULT_SPEC, LANDING_FORGIVENESS, groundAttitude, restHeight, stepFlight, type Env, type PlaneSpec } from '../plane/flight';
import { AIRFRAMES, composeSpec, describeLoadout, engineOf, loadLoadout, stallSpeed, type Loadout } from '../plane/loadout';
import { Plane } from '../plane/plane';
import { bankAngle } from '../plane/steer';
import { outlineMaterial } from '../render/outline';
import { GuideArrows } from '../render/guide';
import { PostFX } from '../render/post';
import { Sky, sunDirection } from '../render/sky';
import { toonMaterial } from '../render/toon';
import { Water } from '../render/water';
import { Hangar } from '../ui/hangar';
import { Hud } from '../ui/hud';
import { Menus } from '../ui/menus';
import { drawRouteMap } from '../ui/routeMap';
import { CHUNK_SIZE } from '../world/terrain';
import { World } from '../world/world';
import { CameraRig } from './camera';
import { CRUISE_SPEED, TURN_RADIUS, RouteTracker, airfieldNames, bearing, planRoute, pointAt, runwayDir, type Route } from './route';

/**
 * GameStateMachine (design §6) implementing the Core Gameplay Loop (§2):
 * Title (main menu over a terrain flyover) ⇄ Hangar (customize the plane);
 * Title → Loading (world prewarm) → Sortie [takeoff | flight | landing]
 * → Ending (crash/landed) → Debrief.
 */
type State = 'title' | 'hangar' | 'loading' | 'sortie' | 'ending' | 'debrief';
type TierName = 'low' | 'medium' | 'high';
type Result = 'landed' | 'field landing' | 'crashed' | 'ditched' | 'bailed out';

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

interface Touchdown {
  sink: number;
  bank: number;
  speed: number;
  onRunway: boolean;
  t: number;
}

interface Mission {
  tookOff: boolean;
  takeoffT: number;
  touch: Touchdown | null;
  bounces: number;
  stoppedT: number;
  result: Result | null;
  resultText: string;
  grade: string;
  endT: number;
  wreckAt: THREE.Vector3 | null;
  hintStage: number;
  /** cross-country: seconds airborne, seconds of that on the path, landed at the destination */
  airT: number;
  pathT: number;
  atDest: boolean;
  offPathHintT: number;
}

/** pilot eye point per airframe (body space) */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

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
  private loadout: Loadout = loadLoadout();
  private hangar: Hangar;
  /** the plane on the hangar apron while the title / hangar screen is up */
  private preview: Plane | null = null;
  private previewYaw = 2.2;
  private previewDrag: number | null = null;
  private readonly previewCam = new THREE.Vector3();
  private previewCamReady = false;
  /** px the hangar view is slid right, so the plane shows left of the dialog */
  private viewShift = 0;
  private state: State = 'title';
  private paused = false;
  private simTime = 0;
  private tick = 0;
  private time = 0;
  private loadT = 0;
  private whiteout = 0;
  private tierName: TierName = 'medium';
  private tier: Tier = TIERS.medium;
  private renderScale = 1;
  private frameAvg = 16;
  private resTimer = 0;
  private mission!: Mission;
  /** cross-country flight plan for the menu's destination (null in free flight) */
  private route: Route | null = null;
  /** the route the current sortie flies, its arrows and progress along it */
  private sortieRoute: Route | null = null;
  private guide: GuideArrows | null = null;
  private tracker: RouteTracker | null = null;
  private names: string[] = [];
  private readonly rejoin = new THREE.Vector3();
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
      openHangar: () => this.openHangar(),
      closeHangar: () => this.closeHangar(),
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
      modeChanged: () => this.refreshRoute(),
      destStep: (d) => this.stepDest(d),
      click: () => this.uiClick(),
    });
    // redraw the flight-plan map when its size changes (window resize, controls list opened)
    let mapTimer = 0;
    let mapSize = '';
    new ResizeObserver(() => {
      const c = this.ui.routeCanvas;
      const size = `${c.clientWidth}x${c.clientHeight}`;
      if (size === mapSize) return;
      mapSize = size;
      clearTimeout(mapTimer);
      mapTimer = window.setTimeout(() => this.drawMap(), 80);
    }).observe(this.ui.routeCanvas);
    this.hangar = new Hangar(
      this.loadout,
      () => this.buildPreview(),
      () => this.uiClick(),
      () => this.state === 'hangar',
    );
    canvas.addEventListener('pointerdown', (e) => {
      if (this.state === 'hangar') this.previewDrag = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
      if (this.previewDrag === null) return;
      this.previewYaw += (e.clientX - this.previewDrag) * 0.01;
      this.previewDrag = e.clientX;
    });
    window.addEventListener('pointerup', () => (this.previewDrag = null));
    this.audio.setVolume(this.settings.volume);

    this.scene.add(this.sky.mesh, this.water.mesh, this.hemi, this.sun, this.sun.target, this.fx.group);
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
      this.ui.show(this.state === 'title' ? 'title' : this.state === 'hangar' ? 'hangar-screen' : 'pause');
    });
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'sortie' || this.state === 'ending')) this.setPaused(true);
    });

    this.applyTier();
    this.newWorld(this.settings.seed);
    this.resize();
    this.ui.setAircraft(describeLoadout(this.loadout));
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
    this.env = { groundHeight: (x, z) => w.groundHeight(x, z), surfaceAt: (x, z) => w.surfaceAt(x, z), wind: w.wind };
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
    this.previewCamReady = false;
    if (this.state === 'hangar') this.buildPreview();
    this.clearGuide();
    this.refreshRoute();
  }

  // ------------------------------------------------------- cross-country

  /** Re-plan the menu's cross-country route (mode, destination, world or plane changed). */
  private refreshRoute() {
    const w = this.world;
    if (!w) return;
    const st = this.settings;
    const fields = w.gen.airfields;
    this.names = airfieldNames(fields);
    if (st.dest < 1 || st.dest >= fields.length) st.dest = 1;
    this.ui.setRoutePanel(st.mode === 'route');
    this.ui.refreshBest();
    if (st.mode !== 'route') {
      this.route = null;
      return;
    }
    const to = fields[st.dest];
    const r = planRoute(w.gen, w.home, to, w.baseWind, TURN_RADIUS[this.loadout.style]);
    this.route = r;
    this.drawMap();
    const km = (r.sAim / 1000).toFixed(1);
    const min = Math.max(1, Math.round(r.sAim / CRUISE_SPEED[this.loadout.style] / 60));
    const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing(w.home.x, w.home.z, to.x, to.z) / 45) % 8];
    const downwind = r.land.dx * w.baseWind.x + r.land.dz * w.baseWind.z > 0 ? ' · downwind landing' : '';
    this.ui.setRouteInfo(this.names[st.dest], `${km} km ${dir} · about ${min} min · up to ${Math.round(r.maxAlt / 10) * 10} m${downwind}`);
  }

  /** Draw the flight-plan map at the canvas's on-screen size (it stretches to the menu's height). */
  private drawMap() {
    const c = this.ui.routeCanvas;
    if (!this.route || !this.world || !c.clientWidth || !c.clientHeight) return;
    const k = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(c.clientWidth * k);
    c.height = Math.round(c.clientHeight * k);
    drawRouteMap(c, this.world.gen, this.route, this.names);
  }

  private stepDest(d: number) {
    const w = this.world;
    if (!w || this.settings.mode !== 'route') return;
    const n = w.gen.airfields.length - 1;
    this.settings.dest = ((this.settings.dest - 1 + d + n) % n) + 1;
    saveSettings(this.settings);
    this.refreshRoute();
  }

  private clearGuide() {
    if (this.guide) {
      this.scene.remove(this.guide.mesh);
      this.guide.dispose();
    }
    this.guide = null;
    this.tracker = null;
    this.sortieRoute = null;
  }

  // ------------------------------------------------------------ hangar

  private openHangar() {
    if (this.state !== 'title') return;
    this.uiClick();
    this.state = 'hangar';
    this.previewCamReady = false;
    this.ui.show('hangar-screen');
    this.buildPreview();
  }

  /** Back to the main menu (the only place to start a sortie). */
  private closeHangar() {
    if (this.state !== 'hangar') return;
    this.uiClick();
    this.clearPreview();
    this.clearViewShift();
    this.state = 'title';
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.ui.setAircraft(describeLoadout(this.loadout));
    this.refreshRoute();
    this.ui.show('title');
  }

  private uiClick() {
    // any click in the menus is a user gesture: audio may start now
    this.audio.init();
    this.audio.click();
  }

  /** (Re)build the preview plane for the current loadout on the home apron. */
  private buildPreview() {
    this.clearPreview();
    if (!this.world || this.state !== 'hangar') return;
    this.preview = new Plane(this.loadout, this.planeToon, this.planeOutline);
    this.scene.add(this.preview.visual.root);
    this.audio.setEngine(engineOf(this.loadout.style));
  }

  private clearPreview() {
    if (!this.preview) return;
    this.scene.remove(this.preview.visual.root);
    this.preview.visual.dispose();
    this.preview = null;
  }

  /** Turntable on the apron in front of the home hangar, camera on the runway side. */
  private updatePreview(dt: number) {
    const w = this.world!;
    const p = this.preview;
    const field = w.fields[0];
    field.group.updateMatrixWorld();
    const spot = field.group.localToWorld(_v.copy(field.previewSpot));
    const size = this.loadout.style === 'jet' ? 1.3 : this.loadout.style === 'turboprop' ? 1.12 : 1;
    if (p) {
      if (this.previewDrag === null) this.previewYaw += dt * 0.35;
      const q = groundAttitude(Math.cos(this.previewYaw), Math.sin(this.previewYaw), p.gear);
      p.s.quat.copy(q);
      p.s.pos.set(spot.x, spot.y + restHeight(q, p.gear), spot.z);
      p.teleport();
      p.input.pitch = p.input.roll = p.input.yaw = 0;
      p.s.rpm = 0.18;
      p.syncVisual(1, dt);
    }
    // camera: in front of the hangar door, looking back at the plane
    const af = w.home;
    const ox = -af.dirZ;
    const oz = af.dirX; // local +z (towards the hangars) in world space
    const target = _v2.set(spot.x, spot.y + 1.4 * size, spot.z);
    const want = _v3.set(spot.x + af.dirX * 8 * size - ox * 11 * size, spot.y + 3.4 * size, spot.z + af.dirZ * 8 * size - oz * 11 * size);
    if (!this.previewCamReady) {
      this.previewCam.copy(want);
      this.previewCamReady = true;
    }
    this.previewCam.lerp(want, 1 - Math.exp(-dt * 3));
    this.camera.position.copy(this.previewCam);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    if (this.camera.fov !== 50) {
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
    }
    // balance the screen: slide the view so the plane sits in the middle of the
    // free space left of the hangar dialog (none when the dialog is below, on narrow screens)
    const W = window.innerWidth;
    const H = window.innerHeight;
    const panel = document.getElementById('hangar')!.getBoundingClientRect();
    const beside = panel.width > 0 && panel.left > W * 0.4;
    const shift = beside ? W / 2 - panel.left / 2 : 0;
    this.viewShift += (shift - this.viewShift) * (1 - Math.exp(-dt * 6));
    this.camera.setViewOffset(W, H, this.viewShift, 0, W, H);
  }

  private clearViewShift() {
    this.viewShift = 0;
    this.camera.clearViewOffset();
  }

  private clearPlanes() {
    for (const p of this.planes) {
      this.scene.remove(p.visual.root);
      p.visual.dispose();
    }
    this.planes = [];
    this.player = null;
    this.fx.clear();
  }

  // ----------------------------------------------------------- state changes

  private fly() {
    this.uiClick();
    this.startSortie();
  }

  private toTitle() {
    this.setPaused(false);
    this.clearPlanes();
    this.clearGuide();
    this.state = 'title';
    this.hud.visible = false;
    this.hud.clear();
    this.ui.clearHint();
    this.ui.setWhiteout(0);
    this.ui.refreshBest();
    this.ui.setAircraft(describeLoadout(this.loadout));
    this.ui.show('title');
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
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
    this.clearPreview();
    this.input.invertPitch = this.settings.invertPitch;
    this.rig.shakeEnabled = this.settings.cameraShake;
    // compose into the same object so the ?debug panel keeps tuning it live
    Object.assign(this.spec, composeSpec(this.loadout));
    const p = new Plane({ ...this.loadout }, this.planeToon, this.planeOutline, this.spec);
    this.audio.setEngine(engineOf(this.loadout.style));
    this.rig.chaseScale = this.loadout.style === 'jet' ? 1.25 : this.loadout.style === 'turboprop' ? 1.1 : 1;
    const eye = AIRFRAMES[this.loadout.style].eye;
    this.rig.cockpit.set(eye[0], eye[1], eye[2]);
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    const af = w.home;
    // cross-country: fly the planned route (its take-off direction); free flight: into the wind
    this.clearGuide();
    if (this.settings.mode === 'route') {
      if (!this.route) this.refreshRoute();
      const r = this.route!;
      this.sortieRoute = r;
      this.guide = new GuideArrows(r);
      this.scene.add(this.guide.mesh);
      this.tracker = new RouteTracker(r);
    }
    const { dx, dz } = this.sortieRoute ? this.sortieRoute.depart : runwayDir(af, w.wind);
    // line up just inside the asphalt threshold
    const back = af.paved / 2 - 20;
    const x = af.x - dx * back;
    const z = af.z - dz * back;
    p.s.quat.copy(groundAttitude(dx, dz, p.gear));
    p.s.pos.set(x, w.groundHeight(x, z) + restHeight(p.s.quat, p.gear), z);
    p.s.rpm = 0.15;
    p.teleport();
    this.input.resetThrottle(0);
    this.planes.push(p);
    this.player = p;
    this.scene.add(p.visual.root);
    this.simTime = 0;
    this.tick = 0;
    this.mission = {
      tookOff: false,
      takeoffT: 0,
      touch: null,
      bounces: 0,
      stoppedT: 0,
      result: null,
      resultText: '',
      grade: '—',
      endT: 0,
      wreckAt: null,
      hintStage: 0,
      airT: 0,
      pathT: 0,
      atDest: false,
      offPathHintT: 0,
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
    const jet = this.loadout.style === 'jet' ? ' The jet takes a few seconds to spool up.' : '';
    const follow = this.sortieRoute ? ` Follow the arrows to ${this.destName()}.` : '';
    this.ui.hint(`Open the throttle: hold Shift (or press 0). Steer with Q / E.${jet}${follow}`, 6000);
  }

  // ------------------------------------------------------------- outcomes

  /** The pilot has bailed out: the empty plane spirals down. */
  private abandonPlane(t: Plane) {
    if (t.downed || t.wrecked) return;
    t.downed = true;
    t.downedSide = Math.random() < 0.5 ? -1 : 1;
    t.s.health.engine = 0;
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
      const cols = [t.livery.body, t.livery.wing];
      for (let i = 0; i < 12; i++) this.fx.debris(pos, t.s.vel.clone().multiplyScalar(0.3), cols[i % 2]);
    }
    t.downed = true;
    if (t === this.player) {
      const m = this.mission;
      if (!m.result) {
        m.result = splash ? 'ditched' : 'crashed';
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
      // softer tyres forgive a firmer touchdown (design §8.2 Wheels)
      const k = (p.spec.crashSpeed / 6) * LANDING_FORGIVENESS;
      score += t.sink < 1.5 * k ? 2 : t.sink < 3 * k ? 1 : 0;
      score += t.bank < 0.09 * LANDING_FORGIVENESS ? 1 : 0;
      score += t.onRunway ? 1 : 0;
      score += m.bounces === 0 ? 1 : 0;
    }
    if (!onField) score = Math.min(score, 2);
    m.grade = score >= 5 ? 'A+' : score === 4 ? 'A' : score === 3 ? 'B' : score === 2 ? 'C' : 'D';
    const words: Record<string, string> = { 'A+': 'GREASER!', A: 'SMOOTH!', B: 'NOT BAD!', C: 'FIRM...', D: 'OOF!' };
    const at = w.gen.nearestAirfield(p.s.pos.x, p.s.pos.z).af;
    m.resultText = onField ? `Landed at ${at === w.home ? 'home field' : 'an airfield'}` : 'Landed in a field';
    if (this.sortieRoute) {
      m.atDest = onField && at === this.sortieRoute.to;
      const atName = this.names[w.gen.airfields.indexOf(at)];
      m.resultText = m.atDest ? `Landed at ${atName}` : onField ? `Landed at ${atName}, not ${this.destName()}` : 'Landed in a field';
    }
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
    const damage = 1 - p.integrity;
    const gradeA = m.grade === 'A' || m.grade === 'A+';
    let medal = 0;
    if (landedOk && gradeA) medal = 3;
    else if (landedOk && m.grade === 'B') medal = 2;
    else if (landedOk) medal = 1;
    // cross-country: land at the destination; the medal is also capped by how well the path was followed
    const route = this.sortieRoute;
    const pathPct = m.airT > 0 ? Math.round((100 * m.pathT) / m.airT) : 0;
    if (route) {
      const pathMedal = pathPct >= 75 ? 3 : pathPct >= 50 ? 2 : 1;
      medal = m.atDest ? Math.min(medal, pathMedal) : 0;
    }
    const flight = m.tookOff ? this.simTime - m.takeoffT : 0;
    const mmss = `${Math.floor(flight / 60)}:${String(Math.floor(flight % 60)).padStart(2, '0')}`;
    const rows: [string, string][] = [['Result', `${m.result ?? '—'}${m.resultText ? ` (${m.resultText})` : ''}`]];
    if (route) {
      rows.push(['Route', `Home Field → ${this.destName()}`]);
      rows.push(['On the path', m.tookOff ? `${pathPct}%` : '—']);
    }
    rows.push(['Damage taken', `${Math.round(damage * 100)}%`]);
    if (m.touch) rows.push(['Touchdown', `${m.touch.sink.toFixed(1)} m/s sink, ${Math.round((m.touch.bank * 180) / Math.PI)}° bank`]);
    rows.push(['Landing grade', landedOk ? m.grade : '—']);
    rows.push(['Flight time', mmss]);
    rows.push(['Aircraft', describeLoadout(p.loadout)]);
    rows.push(['World seed', String(this.settings.seed)]);
    const key = route ? bestKey(this.settings.seed, 'route', this.settings.dest) : bestKey(this.settings.seed);
    const newBest = submitBest(key, { medal, landing: landedOk ? m.grade : '—', ...(route ? { path: pathPct } : {}) });
    let title = landedOk ? (medal >= 2 ? 'Nicely done!' : 'Back on the ground') : m.result === 'bailed out' ? 'Hit the silk!' : 'Better luck next time';
    if (route && landedOk) title = !m.atDest ? 'Wrong airfield!' : medal >= 2 ? `Welcome to ${this.destName()}!` : 'Made it!';
    this.ui.showDebrief({ title, medal, rows, newBest, bestOf: route ? 'route' : 'world' });
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
      p.input.brake = true;
    }

    // physics
    for (const pl of this.planes) {
      if (pl.wrecked) continue;
      const ev = stepFlight(pl.s, pl.spec, pl.input, this.env, dt, pl.gear);
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

    // ------------------------------------------------------ mission logic
    if (this.state === 'sortie' && p.alive) {
      const agl = p.s.pos.y - Math.max(w.groundHeight(p.s.pos.x, p.s.pos.z), 0);
      if (m.hintStage === 0 && p.s.onGround && p.s.airspeed > 14) {
        m.hintStage = 1;
        const vr = Math.round((stallSpeed(p.spec) * 1.25 * 3.6) / 5) * 5;
        this.ui.hint(
          p.gear.tricycle
            ? `Keep it straight with Q / E, then pull back gently with S at about ${vr} km/h.`
            : `Ease the tail up with W, then pull back gently with S at about ${vr} km/h.`,
          6000,
        );
      }
      if (!m.tookOff && p.s.airTime > 2 && agl > 15) {
        m.tookOff = true;
        m.takeoffT = this.simTime;
        m.touch = null;
        this.ui.toast('AIRBORNE!');
        if (this.sortieRoute) this.ui.hint(`Follow the white arrows to ${this.destName()} and land there.`, 6000);
        else this.ui.hint('Enjoy the view! Land on any airfield strip to finish.', 6000);
      }
      // cross-country: progress along the path and how much of the flight stayed on it
      const tr = this.tracker;
      if (tr) {
        tr.update(p.s.pos.x, p.s.pos.y, p.s.pos.z);
        if (m.tookOff && !p.s.onGround) {
          m.airT += dt;
          if (tr.onPath()) m.pathT += dt;
        }
        m.offPathHintT -= dt;
        if (m.tookOff && tr.lateral > 400 && m.offPathHintT <= 0) {
          m.offPathHintT = 20;
          this.ui.hint('Off the path! Turn toward the PATH marker and pick up the arrows again.', 5000);
        }
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
        this.ui.hint(i.mouseStick ? 'Mouse stick ON: move the cursor to fly.' : 'Mouse stick OFF', 3000);
      }
      const p = this.player;
      if (i.wasPressed('KeyX') && p && !p.wrecked && !p.s.onGround && this.mission.tookOff) {
        this.abandonPlane(p);
        this.mission.result = 'bailed out';
        this.mission.resultText = 'Parachuted to safety';
        this.ui.toast('BAILED OUT!');
        this.endSortie(4, p.s.pos.clone());
      }
    }
    if (this.state === 'title') {
      if (i.wasPressed('Enter') || i.padWasPressed(0)) this.fly();
      if (i.wasPressed('KeyH') || i.padWasPressed(3)) this.openHangar();
      if (i.wasPressed('ArrowLeft') || i.padWasPressed(14)) this.stepDest(-1);
      if (i.wasPressed('ArrowRight') || i.padWasPressed(15)) this.stepDest(1);
    } else if (this.state === 'hangar') {
      // to fly, go back to the main menu first
      if (i.wasPressed('Escape') || i.wasPressed('Enter') || i.wasPressed('Backspace') || i.padWasPressed(1)) this.closeHangar();
      // gamepad: bumpers / d-pad left-right = category, d-pad up-down = option
      if (i.padWasPressed(4) || i.padWasPressed(14)) this.hangar.nav(-1, 0);
      if (i.padWasPressed(5) || i.padWasPressed(15)) this.hangar.nav(1, 0);
      if (i.padWasPressed(12)) this.hangar.nav(0, -1);
      if (i.padWasPressed(13)) this.hangar.nav(0, 1);
    }
  }

  private objectiveText(): string {
    const m = this.mission;
    const tr = this.tracker;
    if (this.sortieRoute && tr) {
      const name = this.destName();
      if (!m.tookOff) return `Take off — follow the arrows to ${name}`;
      const km = Math.max(0, (this.sortieRoute.sAim - tr.progress) / 1000).toFixed(1);
      return tr.onPath() ? `Fly to ${name} — ${km} km` : `Back to the path! ${name} ${km} km`;
    }
    if (!m.tookOff) return 'Take off!';
    return 'Free flight — land on any strip to finish';
  }

  private destName(): string {
    const r = this.sortieRoute;
    return r && this.world ? this.names[this.world.gen.airfields.indexOf(r.to)] : '';
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
      case 'hangar': {
        this.updatePreview(dt);
        w.update(this.camera.position, null, dt);
        break;
      }
      case 'title':
      case 'debrief': {
        const af = w.home;
        // keep the menu flyover under the (now low) cloud base
        this.rig.orbit(dt, _v.set(af.x, af.height + 20, af.z), 650, 110, 0.04);
        w.update(this.camera.position, null, dt);
        break;
      }
      case 'loading': {
        this.loadT += dt;
        w.update(p!.s.pos, null, dt);
        p!.syncVisual(1, dt);
        this.rig.follow(dt, p!.s.pos, p!.s.quat, 0, (x, z) => w.groundHeight(x, z));
        const r = w.chunks.readiness(p!.s.pos, 2);
        this.ui.setLoading(r);
        if (r >= 1 && this.loadT > 0.4) this.beginSortie();
        break;
      }
      case 'sortie':
      case 'ending': {
        for (const pl of this.planes) if (!pl.wrecked) pl.syncVisual(this.paused ? 1 : alpha, this.paused ? 0 : dt);
        const m = this.mission;
        if (p) p.visual.setCockpitView(this.rig.mode === 'cockpit' && !(this.state === 'ending' && m.wreckAt));
        if (this.state === 'ending' && m.wreckAt) {
          this.rig.orbit(dt, m.wreckAt, 45, 18, 0.35);
        } else if (p) {
          this.rig.follow(dt, p.visual.root.position, p.visual.root.quaternion, p.s.airspeed, (x, z) => w.groundHeight(x, z));
        }
        w.update(this.camera.position, p ? p.s.vel : null, this.paused ? 0 : dt);
        if (p) w.updatePapi(p.s.pos);
        if (this.guide && this.tracker) this.guide.update(this.tracker.progress, this.time);
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
    const focus = p && this.state !== 'title' && this.state !== 'hangar' && this.state !== 'debrief' ? p.s.pos : this.camera.position;
    const sd = sunDirection(w.time);
    const snap = (260 / this.tier.shadowSize) * 2;
    this.sun.target.position.set(Math.round(focus.x / snap) * snap, Math.round(focus.y / snap) * snap, Math.round(focus.z / snap) * snap);
    this.sun.position.copy(this.sun.target.position).addScaledVector(sd, 600);
    if (!this.paused) {
      this.fx.update(dt, this.camera.position);
    }

    // overlays
    // cloud whiteout: snap to white on entering a cloud, fade back to clear after leaving it
    const flying = this.state === 'sortie' || this.state === 'ending';
    const dens = flying ? w.clouds.densityAt(this.camera.position) : 0;
    const target = Math.min(1, dens * 5);
    const rate = target > this.whiteout ? 6 : 0.7; // per second: ~0.2 s in, ~1.5 s out
    if (!this.paused) this.whiteout += Math.sign(target - this.whiteout) * Math.min(Math.abs(target - this.whiteout), rate * dt);
    if (!flying) this.whiteout = 0;
    this.ui.setWhiteout(this.whiteout);
    const lowHealth = p && p.alive && this.state === 'sortie' ? Math.max(0, 0.45 - p.integrity) : 0;
    this.ui.setHurt(Math.min(1, lowHealth));
    if (p && (this.state === 'sortie' || this.state === 'ending')) {
      const agl = p.s.pos.y - Math.max(w.groundHeight(p.s.pos.x, p.s.pos.z), 0);
      const m = this.mission;
      this.hud.draw(
        {
          player: p,
          world: w,
          camera: this.camera,
          objective: this.objectiveText(),
          mouseStick: this.input.mouseStick,
          mouse: this.input.mouse,
          stallWarn: p.s.stalled && !p.s.onGround,
          // cross-country: the landing guide is for the destination only
          showLanding: m.tookOff && agl < 450 && (!this.sortieRoute || w.gen.nearestAirfield(p.s.pos.x, p.s.pos.z).af === this.sortieRoute.to),
          guide: this.hudGuide(),
        },
        dt,
      );
      this.audio.update(p.s.rpm, p.s.airspeed, !this.paused && !p.wrecked);
    } else if (this.state === 'hangar' && this.preview) {
      // the preview engine idles quietly in the hangar
      this.audio.update(0.18, 0, true, 0.45);
    } else {
      this.audio.update(0, 0, false);
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
    if (this.resTimer > 2 && this.state !== 'title' && this.state !== 'hangar') {
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

  private hudGuide() {
    const r = this.sortieRoute;
    const tr = this.tracker;
    if (!r || !tr) return undefined;
    // off the path: point at it a little ahead of the nearest point
    const off = this.state === 'sortie' && this.mission.tookOff && !tr.onPath();
    const rejoin = off ? (pointAt(r, tr.progress + 500, this.rejoin), this.rejoin) : null;
    return { route: r, dest: r.to, rejoin };
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
