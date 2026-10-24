/**
 * Fixed-timestep loop matching GameFrame (0x40ad80): the simulation advances in
 * obj_update_time steps (40 ms = 25 Hz) with at most 26 catch-up ticks, then rendering runs once
 * with an interpolation factor between the last two ticks. The simulation speed therefore does not
 * depend on the display refresh rate; `maxFps` only limits how often frames are drawn.
 */
export const MAX_CATCHUP_TICKS = 26;

export class FixedLoop {
  private last = 0;
  private lastRender = 0;
  private acc = 0;
  private running = false;
  private handle = 0;
  /** Render at most this many frames per second; 0 = every display refresh. */
  maxFps = 0;
  /**
   * Network races: how many ticks are waiting beyond the jitter buffer; they run at once. The tick
   * callback returns false when the next network frame has not arrived yet, which holds the clock.
   */
  backlog: (() => number) | null = null;

  constructor(
    readonly tickMs: number,
    private readonly tick: () => boolean | void,
    private readonly render: (alpha: number, frameMs: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = this.lastRender = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.handle = requestAnimationFrame(frame);
      // Skip display refreshes above the cap (with 1 ms slack for refresh jitter).
      if (this.maxFps > 0 && now - this.lastRender < 1000 / this.maxFps - 1) return;
      // rAF timestamps can precede the performance.now() taken in start(); clamp to >= 0.
      const dt = Math.max(0, Math.min(now - this.last, this.tickMs * MAX_CATCHUP_TICKS));
      this.last = now;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= this.tickMs && steps < MAX_CATCHUP_TICKS) {
        if (this.tick() === false) {
          this.acc = this.tickMs;
          break;
        }
        this.acc -= this.tickMs;
        steps++;
      }
      for (let extra = this.backlog?.() ?? 0; extra > 0 && steps < MAX_CATCHUP_TICKS; extra--, steps++) {
        if (this.tick() === false) break;
      }
      const frameMs = Math.max(0, now - this.lastRender);
      this.lastRender = now;
      this.render(this.acc / this.tickMs, frameMs);
    };
    this.handle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }
}
