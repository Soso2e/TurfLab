// Small, dependency-free statistics used by every stats panel. Every rate the
// UI shows carries its denominator, a 95% interval and a confidence label so a
// 2-of-3 is never read like a 200-of-300.

export type Confidence = "high" | "medium" | "low" | "insufficient";

/** Sample-size thresholds for the confidence label (starts or races). */
export const CONFIDENCE_THRESHOLDS = { high: 30, medium: 10, low: 3 } as const;

export function confidenceOf(n: number): Confidence {
  if (n >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (n >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  if (n >= CONFIDENCE_THRESHOLDS.low) return "low";
  return "insufficient";
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
  insufficient: "不足",
};

export const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stdev(xs: number[]): number | null {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Wilson score interval (95%) for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round(Math.max(0, (c - r) / d)), round(Math.min(1, (c + r) / d))];
}

/** Empirical-Bayes style shrinkage of k/n toward `prior` with `strength`
 * pseudo-observations. Small samples stay close to the prior. */
export function shrink(k: number, n: number, prior: number, strength = 10): number {
  return (k + prior * strength) / (n + strength);
}

export type Rate = {
  /** Successes / denominator. */
  k: number;
  n: number;
  rate: number | null;
  ci95: [number, number] | null;
  confidence: Confidence;
};

export function rate(k: number, n: number): Rate {
  return {
    k,
    n,
    rate: n ? round(k / n) : null,
    ci95: wilson(k, n),
    confidence: confidenceOf(n),
  };
}

/** A tally of starts with wins and top-3 finishes. */
export type Tally = { starts: number; wins: number; top3: number };
export const emptyTally = (): Tally => ({ starts: 0, wins: 0, top3: 0 });

export function addFinish(t: Tally, finish: number | null): void {
  t.starts++;
  if (finish === 1) t.wins++;
  if (finish != null && finish <= 3) t.top3++;
}

export type TallyView = Tally & {
  win: Rate;
  place3: Rate;
};

export function viewTally(t: Tally): TallyView {
  return { ...t, win: rate(t.wins, t.starts), place3: rate(t.top3, t.starts) };
}

/** Weight of the k-th most recent run (k = 0 newest). Recent runs count more:
 * 1, 0.8, 0.64, 0.51, 0.41 for the five stored runs. */
export const RECENCY_DECAY = 0.8;
export function recencyWeight(k: number): number {
  return RECENCY_DECAY ** k;
}

/** Recency-weighted mean of values ordered newest first (nulls skipped). */
export function recencyMean(values: (number | null)[]): number | null {
  let s = 0;
  let w = 0;
  values.forEach((v, k) => {
    if (v == null || !Number.isFinite(v)) return;
    s += v * recencyWeight(k);
    w += recencyWeight(k);
  });
  return w ? s / w : null;
}

/** Position in the field as 0 (front/winner) … 1 (last). */
export function relativePosition(pos: number | null, size: number | null): number | null {
  return pos != null && size != null && size > 1 && pos >= 1 && pos <= size
    ? (pos - 1) / (size - 1)
    : null;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
