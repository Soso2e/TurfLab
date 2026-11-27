import { BOATS } from "../packages/shared/src/boatrace";
import { b13Distribution } from "../packages/shared/src/boatrace-b13";
import { scoreDistribution } from "../packages/shared/src/boatrace-b13-v2";

export type Barrier =
  | number
  | "max"
  | "max_decay"
  | "near"
  | "near_decay"
  | "exists"
  | "exists_decay"
  | "separate";

/**
 * Compute inside-opponent barrier features for each boat using an arbitrary ability vector
 * (e.g. grade points or composite ability scores) and predicted/exhibition course order.
 */
export function abilityBarrier(values: readonly number[], courses: readonly number[], barrier: Barrier) {
  if (
    values.length !== 6 ||
    !values.every(Number.isFinite) ||
    courses.length !== 6 ||
    !BOATS.every((course) => courses.includes(course))
  ) {
    throw new Error("Six finite values and a course permutation are required");
  }
  const rho = 0.5;
  return courses.map((course, i) => {
    const gaps = BOATS.map((distance) => {
      const opponent = courses.indexOf(course - distance);
      return opponent < 0 ? 0 : Math.max(0, values[opponent] - values[i]);
    });
    if (barrier === "near") return [gaps.find((gap) => gap > 0) ?? 0];
    if (barrier === "near_decay") {
      const idx = gaps.findIndex((gap) => gap > 0);
      return [idx < 0 ? 0 : gaps[idx] * rho ** idx];
    }
    if (barrier === "max") return [Math.max(...gaps)];
    if (barrier === "max_decay") {
      return [Math.max(...gaps.map((gap, index) => gap * rho ** index))];
    }
    if (barrier === "exists") return [gaps.some((gap) => gap > 0) ? 1 : 0];
    if (barrier === "exists_decay") {
      const idx = gaps.findIndex((gap) => gap > 0);
      return [idx < 0 ? 0 : rho ** idx];
    }
    if (barrier === "separate") return [gaps[0], gaps[1] + gaps[2] + gaps[3] + gaps[4]];
    return [gaps.reduce((total, gap, index) => total + gap * barrier ** index, 0)];
  });
}

export function gradeBarrier(grades: readonly number[], courses: readonly number[], barrier: Barrier) {
  return abilityBarrier(grades, courses, barrier);
}

export type Observation = {
  base: number[];
  matrix: number[][];
  order: readonly number[];
  /** Optional per-stage design matrices [stage0(1st), stage1(2nd), stage2(3rd)]; defaults to `matrix`. */
  stageMatrices?: number[][][];
};

export function addTerms(base: number[], matrix: number[][], weights: number[]) {
  return base.map((score, i) => matrix[i].reduce((sum, value, j) => sum + value * weights[j], score));
}

function matrixAtStage(obs: Pick<Observation, "matrix" | "stageMatrices">, stage: number) {
  return obs.stageMatrices?.[stage] ?? obs.matrix;
}

/** The offsets and design rows are fixed before maximizing penalized top-three likelihood. */
export function fitOffsets(samples: Observation[], bounds: readonly boolean[], ridge: number) {
  if (!samples.length) return bounds.map(() => 0);
  const scale = bounds.map((_, j) => {
    const sq = samples.reduce((sum, obs) => {
      const m = matrixAtStage(obs, 0);
      return sum + m.reduce((s, row) => s + (row[j] ?? 0) ** 2, 0);
    }, 0);
    return Math.max(1, Math.sqrt(sq / (6 * samples.length)));
  });
  const scaleMatrix = (m: number[][]) => m.map((row) => row.map((value, j) => value / scale[j]));
  const rows = samples.map((obs) => ({
    base: obs.base,
    stages: obs.order.map((boat, stage) => ({
      matrix: scaleMatrix(matrixAtStage(obs, stage)),
      winner: boat - 1,
      remaining: BOATS.map((b) => b - 1).filter((b) => !obs.order.slice(0, stage).includes(b + 1)),
    })),
  }));
  const weights = bounds.map(() => 0);
  for (let iteration = 0; iteration < 350; iteration++) {
    const gradient = weights.map(() => 0);
    for (const { base, stages } of rows) {
      for (const { matrix, winner, remaining } of stages) {
        const scores = addTerms(base, matrix, weights).map(Math.exp);
        const total = remaining.reduce((sum, i) => sum + scores[i], 0);
        for (const i of remaining) {
          const residual = Number(i === winner) - scores[i] / total;
          for (let j = 0; j < weights.length; j++) gradient[j] += residual * matrix[i][j];
        }
      }
    }
    let change = 0;
    for (let j = 0; j < weights.length; j++) {
      const next = weights[j] + 0.12 * (gradient[j] / samples.length - ridge * weights[j]);
      const projected = bounds[j] ? Math.max(0, next) : next;
      change = Math.max(change, Math.abs(projected - weights[j]));
      weights[j] = projected;
    }
    if (change < 1e-8) break;
  }
  return weights.map((value, j) => value / scale[j]);
}

/** Exact 120-outcome Plackett-Luce distribution allowing stage-specific score vectors. */
export function stageDistribution(stageScores: readonly (readonly number[])[]) {
  if (stageScores.length !== 3 || stageScores.some((s) => s.length !== 6 || !s.every(Number.isFinite))) {
    throw new Error("Three finite 6-boat score vectors are required");
  }
  const max0 = Math.max(...stageScores[0]);
  const max1 = Math.max(...stageScores[1]);
  const max2 = Math.max(...stageScores[2]);
  const w0 = stageScores[0].map((v) => Math.exp(v - max0));
  const w1 = stageScores[1].map((v) => Math.exp(v - max1));
  const w2 = stageScores[2].map((v) => Math.exp(v - max2));
  const total0 = w0.reduce((a, b) => a + b, 0);
  const outcomes: { combination: string; probability: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const p1 = w0[i] / total0;
    const total1 = w1.reduce((sum, w, idx) => (idx === i ? sum : sum + w), 0);
    for (let j = 0; j < 6; j++) {
      if (j === i) continue;
      const p2 = w1[j] / total1;
      const total2 = w2.reduce((sum, w, idx) => (idx === i || idx === j ? sum : sum + w), 0);
      for (let k = 0; k < 6; k++) {
        if (k === i || k === j) continue;
        outcomes.push({
          combination: `${BOATS[i]}-${BOATS[j]}-${BOATS[k]}`,
          probability: p1 * p2 * (w2[k] / total2),
        });
      }
    }
  }
  outcomes.sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
  return outcomes;
}

export function evaluateScores(scores: number[] | readonly (readonly number[])[], order: readonly number[]) {
  const distribution = Array.isArray(scores[0])
    ? stageDistribution(scores as readonly (readonly number[])[])
    : b13Distribution(scores as number[]);
  if (distribution.length !== 120 || Math.abs(distribution.reduce((s, x) => s + x.probability, 0) - 1) > 1e-10) {
    throw new Error("Invalid 120-outcome probability distribution");
  }
  const actual = order.join("-");
  const win = BOATS.map(() => 0);
  const place = BOATS.map(() => 0);
  for (const item of distribution) {
    const boats = item.combination.split("-").map(Number);
    win[boats[0] - 1] += item.probability;
    for (const b of boats) place[b - 1] += item.probability;
  }
  return {
    ...scoreDistribution(distribution, actual),
    exact: Number(distribution[0].combination === actual),
    winHit: Number(win.indexOf(Math.max(...win)) + 1 === order[0]),
    win,
    place,
  };
}

export type FDepthBin = "none" | "shallow" | "medium" | "deep";

/** Classify exhibition flying start depth: shallow (0.01-0.02), medium (0.03-0.05), deep (0.06+). */
export function classifyFDepth(isF: boolean | null, depth: number | null): FDepthBin | null {
  if (isF === null) return null;
  if (!isF) return "none";
  if (depth === null || !Number.isFinite(depth)) return null;
  if (depth <= 0.02 + 1e-9) return "shallow";
  if (depth <= 0.05 + 1e-9) return "medium";
  return "deep";
}

export function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Resample whole races and retain the observed race-day mix. */
export function bootstrap<T>(groups: T[][], statistic: (sample: T[]) => number | null, draws = 1200) {
  let seed = 129;
  const stats: number[] = [];
  for (let run = 0; run < draws; run++) {
    const sample = groups.flatMap((group) =>
      group.map(() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return group[Math.floor((seed / 2 ** 32) * group.length)];
      }),
    );
    const value = statistic(sample);
    if (value !== null) stats.push(value);
  }
  stats.sort((a, b) => a - b);
  return stats.length ? [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]] : null;
}

export function wilson(k: number, n: number) {
  if (!n) return null;
  const p = k / n;
  const z = 1.95996398454;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / (1 + (z * z) / n), (center + margin) / (1 + (z * z) / n)];
}
