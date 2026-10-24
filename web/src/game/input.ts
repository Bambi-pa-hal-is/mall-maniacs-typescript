/**
 * Per-tick control values, mirroring the player struct fields the original writes from input or
 * AI steering (+0x2e0 turn in [-1, 1], +0x2e4 throttle). Keeping input in this form is also what a
 * network layer would send each tick.
 *
 * Network play sends these per tick as NetInput (src/net/protocol.ts); see README "Network play".
 */
export type PlayerCommand = 'grab cart' | 'release cart' | 'get item' | 'drop item';

export interface Controls {
  turn: number;
  throttle: number;
  /** One-button context action ("action smart"). */
  action: boolean;
  /** Explicit action, as the AI issues them ("action grab cart", ...). */
  command?: PlayerCommand;
  /** Quiz answer: true = J (ja), false = N (nej). Keys J/Y and N, as in mm_key 0x40db80. */
  answer?: boolean;
}

export class Keyboard {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True once per key press; cleared when read. */
  consume(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  controls(): Controls {
    const left = this.isDown('ArrowLeft', 'KeyA');
    const right = this.isDown('ArrowRight', 'KeyD');
    const up = this.isDown('ArrowUp', 'KeyW');
    const back = this.isDown('ArrowDown', 'KeyS');
    return {
      turn: (right ? 1 : 0) - (left ? 1 : 0),
      throttle: (up ? 1 : 0) - (back ? 1 : 0),
      action: this.consume('Space'),
      answer: this.consume('KeyJ') || this.consume('KeyY') ? true : this.consume('KeyN') ? false : undefined,
    };
  }
}
