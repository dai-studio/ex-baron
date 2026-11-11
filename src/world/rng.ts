/**
 * World seed & RNG (design §4). Deterministic hashing + a small PRNG.
 * Never use Math.random() in world generation.
 */
export type Rng = () => number;

/** Hash any number of integers into a 32-bit unsigned value. */
export function hash32(...vals: number[]): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < vals.length; i++) {
    let x = Math.imul((vals[i] | 0) ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    h ^= x;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** mulberry32 PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rangeOf = (r: Rng, a: number, b: number) => a + (b - a) * r();
