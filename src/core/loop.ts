/**
 * Fixed-timestep game loop (design §6 "Game loop").
 * The simulation runs at a fixed 120 Hz; rendering interpolates between
 * the last two simulation states using `alpha`.
 */
export const SIM_DT = 1 / 120;
const MAX_FRAME = 0.1; // clamp after tab switches / hitches
const MAX_STEPS = 12;

export class Loop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  running = false;

  constructor(
    private onStep: (dt: number) => void,
    private onFrame: (frameDt: number, alpha: number) => void,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      let frameDt = (now - this.last) / 1000;
      this.last = now;
      if (frameDt > MAX_FRAME) frameDt = MAX_FRAME;
      if (frameDt < 0) frameDt = 0;
      this.acc += frameDt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < MAX_STEPS) {
        this.onStep(SIM_DT);
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0;
      this.onFrame(frameDt, this.acc / SIM_DT);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
