/** Small, fast, deterministic PRNG (mulberry32) with helpers. */
export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    if (this.s === 0) this.s = 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Standard normal via Box–Muller */
  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  lognormal(mu: number, sigma: number): number {
    return Math.exp(mu + sigma * this.normal());
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
  /** Weights that sum to 1, heavy-tailed (lognormal) */
  splitWeights(n: number, sigma = 1): number[] {
    const w: number[] = [];
    let s = 0;
    for (let i = 0; i < n; i++) { const x = Math.exp(sigma * this.normal()); w.push(x); s += x; }
    return w.map((x) => x / s);
  }
  digits(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 10);
    if (s[0] === '0') s = String(1 + Math.floor(this.next() * 9)) + s.slice(1);
    return s;
  }
  letters(n: number): string {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < n; i++) s += A[Math.floor(this.next() * A.length)];
    return s;
  }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
