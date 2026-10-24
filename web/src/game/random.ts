/**
 * The simulation's random numbers. Network races run in lockstep (every client simulates the same
 * inputs), so everything that changes game state draws from this one seeded generator instead of
 * Math.random; the seed comes from the lobby's start message. Cosmetic effects (sounds, splashes)
 * keep using Math.random so they do not move the shared sequence.
 */
let state = (Math.random() * 0x100000000) >>> 0;

/** Restart the sequence (before loading a level). */
export function seedRandom(seed: number): void {
  state = seed >>> 0;
}

/** mulberry32: a uniform number in [0, 1). */
export function simRandom(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
}
