import { BOATS } from "../packages/shared/src/boatrace";
import { b13Distribution } from "../packages/shared/src/boatrace-b13";
import { scoreDistribution } from "../packages/shared/src/boatrace-b13-v2";

export type Barrier = number | "max" | "near" | "separate";

export function gradeBarrier(grades: readonly number[], courses: readonly number[], barrier: Barrier) {
  if (grades.length !== 6 || !grades.every(Number.isFinite) ||
      courses.length !== 6 || !BOATS.every((course) => courses.includes(course))) {
    throw new Error("Six grades and a course permutation are required");
  }
  return courses.map((course, i) => {
    const gaps = BOATS.map((distance) => {
      const opponent = courses.indexOf(course - distance);
      return opponent < 0 ? 0 : Math.max(0, grades[opponent] - grades[i]);
    });
    if (barrier === "near") return [gaps.find((gap) => gap > 0) ?? 0];
    if (barrier === "max") return [Math.max(...gaps)];
    if (barrier === "separate") return [gaps[0], gaps[1] + gaps[2] + gaps[3] + gaps[4]];
    return [gaps.reduce((total, gap, index) => total + gap * barrier ** index, 0)];
  });
}

type Observation = { base: number[]; matrix: number[][]; order: readonly number[] };

export function addTerms(base: number[], matrix: number[][], weights: number[]) {
  return base.map((score, i) => matrix[i].reduce((sum, value, j) => sum + value * weights[j], score));
}

/** The offsets and design rows are fixed before maximizing penalized top-three likelihood. */
export function fitOffsets(samples: Observation[], bounds: readonly boolean[], ridge: number) {
  if (!samples.length) return bounds.map(() => 0);
  const scale = bounds.map((_, j) => Math.max(1, Math.sqrt(
    samples.reduce((sum, { matrix }) => sum + matrix.reduce((s, row) => s + row[j] ** 2, 0), 0) /
      (6 * samples.length),
  )));
  const rows = samples.map(({ base, matrix, order }) => ({
    base, matrix: matrix.map((row) => row.map((value, j) => value / scale[j])),
    stages: order.map((boat, stage) => ({
      winner: boat - 1,
      remaining: BOATS.map((b) => b - 1).filter((b) => !order.slice(0, stage).includes(b + 1)),
    })),
  }));
  const weights = bounds.map(() => 0);
  for (let iteration = 0; iteration < 350; iteration++) {
    const gradient = weights.map(() => 0);
    for (const { base, matrix, stages } of rows) {
      const scores = addTerms(base, matrix, weights).map(Math.exp);
      for (const { winner, remaining } of stages) {
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

export function evaluateScores(scores: number[], order: readonly number[]) {
  const distribution = b13Distribution(scores);
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

export function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Resample whole races and retain the observed race-day mix. */
export function bootstrap<T>(groups: T[][], statistic: (sample: T[]) => number | null, draws = 1200) {
  let seed = 129;
  const stats: number[] = [];
  for (let run = 0; run < draws; run++) {
    const sample = groups.flatMap((group) => group.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return group[Math.floor(seed / 2 ** 32 * group.length)];
    }));
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
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(center - margin) / (1 + z * z / n), (center + margin) / (1 + z * z / n)];
}
