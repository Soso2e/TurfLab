export type Probabilities = [number, number, number];
export const settings = { ridge: 0.08, iterations: 900, step: 0.22, bootstrap: 2000, coefficientBootstrap: 300,
  seed: 130, priorRaces: 12, calibrationPrior: 20 } as const;
export const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export function factor(q: number, r: number): Probabilities {
  return [1 - q, q * (1 - r), q * r];
}

export function marginalize(distribution: readonly { combination: string; probability: number }[]): Probabilities {
  if (distribution.length !== 120 || new Set(distribution.map(e => e.combination)).size !== 120) {
    throw new Error("B13 marginalization requires the complete distribution");
  }
  const p: Probabilities = [0, 0, 0];
  for (const { combination, probability } of distribution) {
    const order = combination.split("-").map(Number);
    p[order[0] === 1 ? 0 : order.includes(1) ? 1 : 2] += probability;
  }
  if (!p.every(Number.isFinite) || Math.abs(p[0] + p[1] + p[2] - 1) > 1e-9) {
    throw new Error("Invalid B13 class probabilities");
  }
  return p;
}

function dot(a: number[], b: number[]) {
  return a.reduce((sum, value, j) => sum + value * b[j], 0);
}

export function fitBinary(examples: readonly { x: number[]; y: number }[]) {
  if (!examples.length) return null;
  const center = examples[0].x.map((_, j) => mean(examples.map(e => e.x[j])));
  const scale = center.map((value, j) => Math.sqrt(mean(examples.map(e => (e.x[j] - value) ** 2))) || 1);
  const transform = (x: number[]) => [1, ...x.map((value, j) => Math.max(-5, Math.min(5, (value - center[j]) / scale[j])))];
  const training = examples.map(e => ({ x: transform(e.x), y: e.y }));
  const rate = (examples.reduce((sum, e) => sum + e.y, 0) + 0.5) / (examples.length + 1);
  const weights = [Math.log(rate / (1 - rate)), ...center.map(() => 0)];
  // A half-observation of each class keeps the intercept finite in a one-class fold.
  for (let i = 0; i < settings.iterations; i++) {
    const gradient = weights.map(w => settings.ridge * w);
    gradient[0] = (sigmoid(weights[0]) - 0.5) / training.length;
    for (const { x, y } of training) {
      const residual = (sigmoid(dot(x, weights)) - y) / training.length;
      x.forEach((value, j) => { gradient[j] += residual * value; });
    }
    let movement = 0;
    weights.forEach((w, j) => {
      const change = settings.step * gradient[j];
      weights[j] = w - change;
      movement = Math.max(movement, Math.abs(change));
    });
    if (movement < 1e-8) break;
  }
  return { n: examples.length, weights, center, scale, predict: (x: number[]) => sigmoid(dot(transform(x), weights)) };
}

export function fitFactor(examples: readonly { x: number[]; y: number }[]) {
  const q = fitBinary(examples.map(e => ({ x: e.x, y: Number(e.y !== 0) })));
  const r = fitBinary(examples.filter(e => e.y !== 0).map(e => ({ x: e.x, y: Number(e.y === 2) })));
  return q && r ? { q, r, predict: (x: number[]) => factor(q.predict(x), r.predict(x)) } : null;
}

function logits(p: Probabilities) {
  const logOdds = (x: number) => Math.log(Math.max(1e-12, x) / Math.max(1e-12, 1 - x));
  return [logOdds(p[1] + p[2]), logOdds(p[2] / (p[1] + p[2]))] as const;
}

export function calibrate(examples: readonly { p: Probabilities; y: number }[]) {
  const rows = examples.map(e => ({ z: logits(e.p), y: e.y }));
  function fit(j: 0 | 1) {
    const training = j === 0 ? rows : rows.filter(e => e.y !== 0);
    let intercept = 0;
    for (let i = 0; i < 40; i++) {
      let grad = settings.calibrationPrior * (sigmoid(intercept) - 0.5);
      let curvature = settings.calibrationPrior * sigmoid(intercept) * (1 - sigmoid(intercept));
      for (const { z, y } of training) {
        const p = sigmoid(z[j] + intercept);
        grad += p - Number(j === 0 ? y !== 0 : y === 2);
        curvature += p * (1 - p);
      }
      const step = grad / curvature;
      intercept -= step;
      if (Math.abs(step) < 1e-9) break;
    }
    return intercept;
  }
  const interceptQ = fit(0), interceptR = fit(1);
  return { n: rows.length, interceptQ, interceptR, predict: (p: Probabilities) => {
    const [q, r] = logits(p);
    return factor(sigmoid(q + interceptQ), sigmoid(r + interceptR));
  } };
}

export function groups<T>(rows: readonly T[], identify: (row: T) => string) {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = identify(row);
    const group = out.get(key) ?? [];
    group.push(row);
    out.set(key, group);
  }
  return out;
}

export function bootstrap<T>(clusters: readonly T[], stat: (sample: T[]) => number | null, iterations: number = settings.bootstrap) {
  if (clusters.length < 2) return null;
  let seed: number = settings.seed;
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = clusters.map(() => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return clusters[Math.floor(seed / 4294967296 * clusters.length)];
    });
    const value = stat(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  return values.length ? [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]] : null;
}

export function wilson(k: number, n: number) {
  if (!n) return null;
  const p = k / n;
  const z = 1.959963984540054;
  const center = p + z ** 2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n);
  return [(center - margin) / (1 + z ** 2 / n), (center + margin) / (1 + z ** 2 / n)];
}

export const loss = (p: number) => -Math.log(Math.max(1e-12, p));
export const outLoss = (y: number, p: Probabilities) => loss(y === 2 ? p[2] : 1 - p[2]);
export const brier = (y: number, p: Probabilities) => (Number(y === 2) - p[2]) ** 2;

function averagePrecision(rows: { y: number; p: Probabilities }[]) {
  const positives = rows.filter(e => e.y === 2).length;
  if (!positives) return null;
  // Group tied scores so ranking is independent of source order.
  const ties = [...groups(rows, e => String(e.p[2])).entries()].sort(([a], [b]) => Number(b) - Number(a));
  let tp = 0, seen = 0, area = 0;
  for (const [, block] of ties) {
    const hits = block.filter(e => e.y === 2).length;
    seen += block.length;
    tp += hits;
    area += (hits / positives) * (tp / seen);
  }
  return area;
}

export function metrics(rows: { y: number; p: Probabilities }[]) {
  if (!rows.length) return null;
  const conditioned = rows.filter(e => e.y !== 0).map(({ y, p }) => ({
    y, p: p[2] / (p[1] + p[2]),
  }));
  const calibration = [...groups(rows, ({ p }) => String(Math.min(9, Math.floor(p[2] * 10)))).entries()]
    .sort(([a], [b]) => Number(a) - Number(b)).map(([bin, block]) => ({
      bin: Number(bin), n: block.length, forecast: mean(block.map(e => e.p[2])),
      observed: mean(block.map(e => Number(e.y === 2))),
    }));
  return {
    n: rows.length, outs: rows.filter(e => e.y === 2).length,
    multiclassLogLoss: mean(rows.map(e => loss(e.p[e.y]))),
    outLogLoss: mean(rows.map(e => outLoss(e.y, e.p))),
    outBrier: mean(rows.map(e => brier(e.y, e.p))),
    averagePrecision: averagePrecision(rows),
    calibration,
    conditionalN: conditioned.length,
    conditionalLogLoss: conditioned.length ? mean(conditioned.map(e => loss(e.y === 2 ? e.p : 1 - e.p))) : null,
    conditionalBrier: conditioned.length ? mean(conditioned.map(e => (Number(e.y === 2) - e.p) ** 2)) : null,
  };
}
