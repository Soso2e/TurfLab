// Learns from fixed pre-race records and official results. Everything is pure and
// time-ordered: a race is only ever scored with weights fitted on earlier days.
// Nothing here changes the production weights; adoption stays an owner decision.
import { obj, rows, type Row } from "../packages/shared/src/domain";
import { scoreWeights } from "../packages/shared/src/scoring";
import { financialOutcome } from "../workers/api/src/betting";

export const LEARNING_VERSION = "softmax-walk-forward-v1";
export const MIN_TRAIN_RACES = 30;
/** docs/turflab-next.md: a return claim needs several hundred time-split races. */
export const MIN_ROI_CLAIM_RACES = 300;
const FACTORS = Object.keys(scoreWeights) as (keyof typeof scoreWeights)[];
const totalWeight = FACTORS.reduce((sum, f) => sum + scoreWeights[f], 0);
export const PRIOR_WEIGHTS = FACTORS.map((f) => (6 * scoreWeights[f]) / totalWeight);

type Horse = { number: number; features: number[] };
export type Sample = {
  race_id: string;
  date: string;
  horses: Horse[];
  winners: number[];
  top1_flat?: { stake: number; returned: number };
  win_odds?: Record<string, number>;
};

/** Centers within the race; a factor with no score carries no information (0). */
export function features(evaluations: Row[]): Horse[] {
  const means = FACTORS.map((f) => {
    const known = evaluations.map((e) => obj(e.components ?? {})[f]).filter((v) => typeof v === "number") as number[];
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  });
  return evaluations.map((e) => ({
    number: Number(e.horse_number),
    features: FACTORS.map((f, i) => {
      const value = obj(e.components ?? {})[f];
      return typeof value === "number" ? (value - means[i]) / 25 : 0;
    }),
  }));
}

export function probabilities(horses: Horse[], weights: number[]): Map<number, number> {
  const utility = horses.map((h) => h.features.reduce((s, x, i) => s + x * weights[i], 0));
  const peak = Math.max(...utility);
  const exp = utility.map((u) => Math.exp(u - peak));
  const total = exp.reduce((a, b) => a + b, 0);
  return new Map(horses.map((h, i) => [h.number, exp[i] / total]));
}

const usable = (s: Sample) => s.horses.length >= 2 && s.winners.some((w) => s.horses.some((h) => h.number === w));

/** Conditional logit, pulled toward the prior so a thin sample stays near it. */
export function fitWeights(samples: Sample[], ridge = 0.5, steps = 300, rate = 0.05): number[] {
  const weights = [...PRIOR_WEIGHTS];
  const train = samples.filter(usable);
  if (!train.length) return weights;
  for (let step = 0; step < steps; step++) {
    const gradient = weights.map((w, i) => -ridge * (w - PRIOR_WEIGHTS[i]));
    for (const race of train) {
      const p = probabilities(race.horses, weights);
      const winners = race.winners.filter((w) => p.has(w));
      for (const h of race.horses) {
        const target = winners.includes(h.number) ? 1 / winners.length : 0;
        const error = target - p.get(h.number)!;
        h.features.forEach((x, i) => { gradient[i] += error * x; });
      }
    }
    gradient.forEach((g, i) => { weights[i] += (rate * g) / train.length; });
  }
  return weights;
}

/** Same factor mix as production; only the overall sharpness comes from data. */
export function fitScale(samples: Sample[]): number {
  const train = samples.filter(usable);
  let best = 1;
  let bestLoss = Infinity;
  for (const scale of [0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3]) {
    const loss = train.reduce((sum, s) => sum + raceLoss(s, PRIOR_WEIGHTS.map((w) => w * scale)), 0);
    if (loss < bestLoss) { bestLoss = loss; best = scale; }
  }
  return best;
}

function raceLoss(sample: Sample, weights: number[]) {
  const p = probabilities(sample.horses, weights);
  const known = sample.winners.filter((w) => p.has(w));
  return -Math.log(Math.max(known.reduce((sum, w) => sum + p.get(w)!, 0), 1e-9));
}

function raceBrier(probabilityOf: (n: number) => number, sample: Sample) {
  return sample.horses.reduce((sum, h) => {
    const y = sample.winners.includes(h.number) ? 1 : 0;
    return sum + (probabilityOf(h.number) - y) ** 2;
  }, 0);
}

function marketProbabilities(sample: Sample): Map<number, number> | null {
  const odds = sample.win_odds;
  if (!odds || !sample.horses.every((h) => Number(odds[h.number]) > 0)) return null;
  const inverse = sample.horses.map((h) => 1 / Number(odds[h.number]));
  const total = inverse.reduce((a, b) => a + b, 0);
  return new Map(sample.horses.map((h, i) => [h.number, inverse[i] / total]));
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (v: number | null, digits = 4) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Difference = { races: number; mean: number | null; ci95: [number, number] | null };

/** Mean of a - b over the same races with a race-level bootstrap interval.
 * Two models scored on the same races are compared pairwise, never by two
 * separate averages: the race-to-race noise is shared and cancels. */
export function pairedDifference(a: number[], b: number[], seed = 20261113): Difference {
  const diffs = a.map((value, i) => value - b[i]).filter((d) => Number.isFinite(d));
  if (!diffs.length) return { races: 0, mean: null, ci95: null };
  const random = seeded(seed);
  const means: number[] = [];
  for (let draw = 0; draw < 2000; draw++) {
    let total = 0;
    for (let i = 0; i < diffs.length; i++) total += diffs[Math.floor(random() * diffs.length)];
    means.push(total / diffs.length);
  }
  means.sort((x, y) => x - y);
  return {
    races: diffs.length,
    mean: round(mean(diffs)),
    ci95: [round(means[Math.floor(means.length * 0.025)])!, round(means[Math.floor(means.length * 0.975)])!],
  };
}

/** One record per race: the last one saved before the start, at its newest
 * result revision. Re-predictions of a race must not count as extra races. */
export function latestPerRace(outcomes: Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const outcome of outcomes) {
    const prior = latest.get(String(outcome.race_id));
    const order = prior == null ? 1
      : String(outcome.saved_at).localeCompare(String(prior.saved_at)) ||
        Number(outcome.result_revision ?? 0) - Number(prior.result_revision ?? 0);
    if (order >= 0) latest.set(String(outcome.race_id), outcome);
  }
  return [...latest.values()];
}

// ---- Model x market blend -------------------------------------------------
// score_i = alpha * (six-factor utility at the production mix) + beta * log(market share).
// alpha = 0, beta = 1 is the market itself. alpha is how much the six factors
// add once the market is known; it is the quantity a return claim depends on.
// Odds enter here only: the six-factor evaluation never sees them.
export const BLEND_VERSION = "model-market-logit-v1";
export const MIN_BLEND_RACES = 30;
export type Blend = { alpha: number; beta: number; races: number; fitted: boolean };
export const MARKET_ONLY: Blend = { alpha: 0, beta: 1, races: 0, fitted: false };

const utilities = (horses: Horse[]) =>
  horses.map((h) => h.features.reduce((s, x, i) => s + x * PRIOR_WEIGHTS[i], 0));

export function blendProbabilities(horses: Horse[], market: Map<number, number>, blend: Blend): Map<number, number> {
  const u = utilities(horses);
  const score = horses.map((h, i) => blend.alpha * u[i] + blend.beta * Math.log(market.get(h.number)!));
  const peak = Math.max(...score);
  const exp = score.map((v) => Math.exp(v - peak));
  const total = exp.reduce((a, b) => a + b, 0);
  return new Map(horses.map((h, i) => [h.number, exp[i] / total]));
}

/** Conditional logit by Newton steps, pulled toward the market (0, 1). */
export function fitBlend(samples: Sample[], ridge = 5): Blend {
  const train = samples.filter(usable).flatMap((s) => {
    const market = marketProbabilities(s);
    return market ? [{ s, market, u: utilities(s.horses) }] : [];
  });
  if (train.length < MIN_BLEND_RACES) return { ...MARKET_ONLY, races: train.length };
  const solve = (free: [boolean, boolean]) => {
    const w = [0, 1];
    for (let step = 0; step < 30; step++) {
      const g = [-ridge * w[0], -ridge * (w[1] - 1)];
      const h = [[ridge, 0], [0, ridge]];
      for (const { s, market, u } of train) {
        const x = s.horses.map((horse, i) => [u[i], Math.log(market.get(horse.number)!)]);
        const score = x.map((row) => w[0] * row[0] + w[1] * row[1]);
        const peak = Math.max(...score);
        const exp = score.map((v) => Math.exp(v - peak));
        const total = exp.reduce((a, b) => a + b, 0);
        const p = exp.map((v) => v / total);
        const winners = s.winners.filter((n) => s.horses.some((horse) => horse.number === n));
        const m = [0, 0];
        x.forEach((row, i) => { m[0] += p[i] * row[0]; m[1] += p[i] * row[1]; });
        x.forEach((row, i) => {
          const y = winners.includes(s.horses[i].number) ? 1 / winners.length : 0;
          for (let a = 0; a < 2; a++) {
            g[a] += (y - p[i]) * row[a];
            for (let b = 0; b < 2; b++) h[a][b] += p[i] * (row[a] - m[a]) * (row[b] - m[b]);
          }
        });
      }
      const delta = [0, 0];
      if (free[0] && free[1]) {
        const det = h[0][0] * h[1][1] - h[0][1] * h[1][0];
        delta[0] = (g[0] * h[1][1] - g[1] * h[0][1]) / det;
        delta[1] = (g[1] * h[0][0] - g[0] * h[1][0]) / det;
      } else {
        for (let a = 0; a < 2; a++) if (free[a]) delta[a] = g[a] / h[a][a];
      }
      w[0] += delta[0];
      w[1] += delta[1];
      if (Math.abs(delta[0]) + Math.abs(delta[1]) < 1e-9) break;
    }
    return w;
  };
  let [alpha, beta] = solve([true, true]);
  // A negative alpha would bet against the model; that is not a use of it.
  if (alpha < 0) { alpha = 0; beta = solve([false, true])[1]; }
  return { alpha: round(alpha)!, beta: round(beta)!, races: train.length, fitted: true };
}

/** Time-ordered test of "do the six factors add anything to the market?". */
export function walkForwardBlend(all: Sample[]): Row {
  const samples = all.filter((s) => usable(s) && marketProbabilities(s))
    .sort((a, b) => a.date.localeCompare(b.date) || a.race_id.localeCompare(b.race_id));
  const market: number[] = [], blended: number[] = [];
  const cache = new Map<string, Blend>();
  for (const sample of samples) {
    if (!cache.has(sample.date)) cache.set(sample.date, fitBlend(samples.filter((s) => s.date < sample.date)));
    const blend = cache.get(sample.date)!;
    if (!blend.fitted) continue;
    const q = marketProbabilities(sample)!;
    const p = blendProbabilities(sample.horses, q, blend);
    const loss = (table: Map<number, number>) =>
      -Math.log(Math.max(sample.winners.reduce((s, w) => s + (table.get(w) ?? 0), 0), 1e-9));
    market.push(loss(q));
    blended.push(loss(p));
  }
  const difference = pairedDifference(blended, market);
  const enough = difference.races >= MIN_BLEND_RACES;
  const evidence = enough && difference.ci95 != null && difference.ci95[1] < 0;
  return {
    version: BLEND_VERSION,
    races_with_odds: samples.length,
    holdout_races: difference.races,
    current_blend: fitBlend(samples),
    log_loss: { market: round(mean(market)), blend: round(mean(blended)) },
    blend_minus_market: difference,
    evidence,
    verdict: !enough
      ? `標本不足（オッズ付きの検証${difference.races}R。${MIN_BLEND_RACES}R以上が必要）。判定しない`
      : evidence
        ? "6評価は市場に情報を上乗せしている候補。前向き運用で再確認が必要"
        : "6評価が市場を上回る証拠なし。期待値買いは見送りが妥当",
    note: "alphaは市場を知ったうえでの6評価の上乗せ分。0なら市場と同じ確率になり、期待値は控除率ぶん1を下回る",
  };
}

/** Race-level bootstrap, because tickets within a race are not independent. */
export function returnRate(bets: { stake: number; returned: number }[], seed = 20261110): Row {
  const stake = bets.reduce((s, b) => s + b.stake, 0);
  const returned = bets.reduce((s, b) => s + b.returned, 0);
  if (!stake) return { races: bets.length, stake_yen: 0, returned_yen: 0, return_rate: null, ci95: null };
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rates: number[] = [];
  for (let round_ = 0; round_ < 2000; round_++) {
    let s = 0;
    let r = 0;
    for (let i = 0; i < bets.length; i++) {
      const bet = bets[Math.floor(random() * bets.length)];
      s += bet.stake;
      r += bet.returned;
    }
    if (s) rates.push(r / s);
  }
  rates.sort((a, b) => a - b);
  return {
    races: bets.length,
    stake_yen: stake,
    returned_yen: returned,
    return_rate: round(returned / stake),
    ci95: [round(rates[Math.floor(rates.length * 0.025)]), round(rates[Math.floor(rates.length * 0.975)])],
  };
}

/** Never reports success from a lucky run: both sample size and CI must clear. */
export function roiVerdict(summary: Row): string {
  const races = Number(summary.races ?? 0);
  const ci = summary.ci95 as number[] | null;
  if (races < MIN_ROI_CLAIM_RACES || !ci) return "標本不足（判定しない）";
  return ci[0] > 1 ? "100%超の候補。前向き運用で再確認が必要" : "100%超とは言えない";
}

export function walkForward(all: Sample[]): Row {
  const samples = all.filter(usable).sort((a, b) => a.date.localeCompare(b.date) || a.race_id.localeCompare(b.race_id));
  const fixed: number[] = [], learned: number[] = [], uniform: number[] = [];
  const fixedBrier: number[] = [], learnedBrier: number[] = [];
  const hits = { fixed: 0, learned: 0 };
  const modelVsMarket = { model: [] as number[], market: [] as number[] };
  let holdout = 0;
  const perRace: Row[] = [];
  const cache = new Map<string, { scaled: number[]; fit: number[] }>();
  for (const sample of samples) {
    const train = samples.filter((s) => s.date < sample.date);
    if (train.length < MIN_TRAIN_RACES) continue;
    holdout++;
    if (!cache.has(sample.date)) {
      const scale = fitScale(train);
      cache.set(sample.date, { scaled: PRIOR_WEIGHTS.map((w) => w * scale), fit: fitWeights(train) });
    }
    const { scaled, fit } = cache.get(sample.date)!;
    const f = probabilities(sample.horses, scaled);
    const l = probabilities(sample.horses, fit);
    fixed.push(raceLoss(sample, scaled));
    learned.push(raceLoss(sample, fit));
    perRace.push({ race_id: sample.race_id, learned_log_loss: round(learned.at(-1)!) });
    uniform.push(Math.log(sample.horses.length));
    fixedBrier.push(raceBrier((n) => f.get(n)!, sample));
    learnedBrier.push(raceBrier((n) => l.get(n)!, sample));
    const pick = (p: Map<number, number>) => [...p.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    if (sample.winners.includes(pick(f))) hits.fixed++;
    if (sample.winners.includes(pick(l))) hits.learned++;
    const market = marketProbabilities(sample);
    if (market) {
      const known = sample.winners.filter((w) => market.has(w));
      modelVsMarket.market.push(-Math.log(Math.max(known.reduce((s, w) => s + market.get(w)!, 0), 1e-9)));
      modelVsMarket.model.push(learned.at(-1)!);
    }
  }
  const fixedLoss = mean(fixed), learnedLoss = mean(learned);
  // A candidate must beat the fixed weights beyond race-to-race noise, not by any margin.
  const difference = pairedDifference(learned, fixed);
  const ready = holdout >= MIN_TRAIN_RACES && difference.ci95 != null && difference.ci95[1] < 0;
  const fit = fitWeights(samples);
  return {
    version: LEARNING_VERSION,
    samples: samples.length,
    holdout_races: holdout,
    per_race: perRace.slice(-500),
    log_loss: { uniform: round(mean(uniform)), fixed_weights: round(fixedLoss), learned_weights: round(learnedLoss) },
    brier: { fixed_weights: round(mean(fixedBrier)), learned_weights: round(mean(learnedBrier)) },
    learned_minus_fixed_log_loss: difference,
    top1_win_rate: {
      fixed_weights: holdout ? round(hits.fixed / holdout) : null,
      learned_weights: holdout ? round(hits.learned / holdout) : null,
    },
    versus_market: {
      races: modelVsMarket.market.length,
      model_log_loss: round(mean(modelVsMarket.model)),
      market_log_loss: round(mean(modelVsMarket.market)),
      model_minus_market: pairedDifference(modelVsMarket.model, modelVsMarket.market),
      note: "市場より低いlog lossを安定して出せない限り、控除率を超える回収は見込みにくい",
    },
    candidate_weights: Object.fromEntries(FACTORS.map((f, i) => [f, round(fit[i], 3)])),
    candidate_ready: ready,
    production_weights_changed: false,
    adoption: "本番重みは変更しない。candidate_readyでも本人の承認で採用する",
  };
}

const flat = (ticket: string, selection: number, result: Row) =>
  financialOutcome(
    { amount_yen: 100, ticket_type: ticket, selections_json: [selection] },
    result,
    rows(result.payouts ?? []),
  );

/** Compares one fixed pre-race record with the official result. Pure. */
export function labOutcome(record: Row, result: Row, labPath: string, pace: Row | null = null): Row {
  const ranking = rows(record.ranking ?? []);
  const order = (result.finish_order_json ?? []) as number[][];
  const winners = order[0] ?? [];
  const top3: number[] = [];
  for (const group of order) {
    if (top3.length >= 3) break;
    top3.push(...group);
  }
  const top1 = ranking[0] ? Number(ranking[0].horse_number) : null;
  const predicted3 = ranking.slice(0, 3).map((r) => Number(r.horse_number));
  return {
    schema_version: "1",
    outcome_version: "lab-outcome-v1",
    race_id: record.race_id!,
    race_date_jst: String(record.race_date_jst ?? String(labPath).slice(4, 14)),
    lab_path: labPath,
    prediction_status: record.prediction_status ?? "provisional",
    confidence: record.confidence ?? null,
    saved_at: record.saved_at ?? null,
    result_id: result.result_id!,
    result_revision: result.revision!,
    predicted_top1: top1,
    predicted_top3: predicted3,
    actual_winners: winners,
    actual_top3: top3,
    top1_win: top1 != null && winners.includes(top1),
    top1_top3: top1 != null && top3.includes(top1),
    top3_overlap: predicted3.filter((n) => top3.includes(n)).length,
    evaluations: rows(record.evaluations ?? []).map((e) => ({ horse_number: e.horse_number!, components: e.components ?? {} })),
    top1_flat: top1 == null ? null : {
      win: flat("win", top1, result),
      place: flat("place", top1, result),
    },
    pace_observation: pace,
  };
}

/** Fixed before the start from the record, weights and odds known at that time.
 * Win tickets only: place needs a place probability this model does not have. */
export function virtualPlan(record: Row, odds: Row, weights: number[], calibrated: boolean, now: string): Row {
  const horses = features(rows(record.evaluations ?? []));
  const p = probabilities(horses, weights);
  const table = rows(odds.win_odds ?? []);
  const lines = horses.flatMap((h) => {
    const quote = table.find((o) => o.horse_number === h.number);
    const price = Number(quote?.odds);
    if (!(price > 0)) return [];
    return [{ horse_number: h.number, probability: round(p.get(h.number)!), odds: price, ev: round(p.get(h.number)! * price) }];
  });
  const picks = lines
    .filter((l) => Number(l.ev) >= 1.1 && Number(l.probability) >= 0.05)
    .sort((a, b) => Number(b.ev) - Number(a.ev))
    .slice(0, 3)
    .map((l) => ({ ticket_type: "win", selections_json: [l.horse_number], amount_yen: 100, ev: l.ev }));
  return {
    schema_version: "1",
    plan_version: "ev-win-plan-v1",
    lane: "lab",
    adopted: false,
    real_money: false,
    race_id: record.race_id!,
    fixed_at: now,
    odds_checked_at: odds.checked_at ?? null,
    record_saved_at: record.saved_at ?? null,
    calibrated,
    confidence: record.confidence ?? null,
    weights: Object.fromEntries(FACTORS.map((f, i) => [f, round(weights[i], 3)])),
    lines,
    picks,
    skip_reason: picks.length ? null : "EV1.1以上の馬なし。見送りも記録する",
  };
}

export function planOutcome(plan: Row, result: Row): { stake: number; returned: number } {
  let stake = 0, returned = 0;
  for (const pick of rows(plan.picks ?? [])) {
    const outcome = financialOutcome(pick, result, rows(result.payouts ?? []));
    stake += Number(pick.amount_yen);
    returned += outcome.payout + outcome.refund;
  }
  return { stake, returned };
}

/** Training/evaluation rows from compared records, with pre-race win odds when saved. */
export function outcomeSamples(outcomes: Row[], oddsByRace: Map<string, Row> = new Map()): Sample[] {
  return outcomes.map((o) => {
    const odds = oddsByRace.get(String(o.race_id));
    return {
      race_id: String(o.race_id),
      date: String(o.race_date_jst),
      horses: features(rows(o.evaluations ?? [])),
      winners: (o.actual_winners ?? []) as number[],
      ...(odds ? { win_odds: Object.fromEntries(rows(odds.win_odds ?? []).map((q) => [String(q.horse_number), Number(q.odds)])) } : {}),
    };
  });
}

const BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0000001];

function reliability(pairs: { p: number; y: number }[]): Row[] {
  return BINS.slice(0, -1).flatMap((low, i) => {
    const inside = pairs.filter((x) => x.p >= low && x.p < BINS[i + 1]);
    if (!inside.length) return [];
    return [{
      range: `${Math.round(low * 100)}-${Math.round(Math.min(1, BINS[i + 1]) * 100)}%`,
      horses: inside.length,
      mean_predicted: round(mean(inside.map((x) => x.p))),
      observed_rate: round(mean(inside.map((x) => x.y))),
    }];
  });
}

/** Win probabilities exactly as a plan stated them before the start. */
function statedWin(plan: Row): Map<number, number> | null {
  const table = obj(obj(plan.simulation ?? {}).win ?? {});
  const fromSimulation = Object.entries(table).map(([n, p]) => [Number(n), Number(p)] as const);
  const fromLines = rows(plan.lines ?? []).flatMap((line) => {
    const n = line.horse_number ?? (line.ticket_type === "win" ? (line.selections_json as number[] | undefined)?.[0] : null);
    return n == null ? [] : [[Number(n), Number(line.probability)] as const];
  });
  const stated = fromSimulation.length ? fromSimulation : fromLines;
  return stated.length >= 2 && stated.every(([, p]) => p >= 0 && p <= 1) ? new Map(stated) : null;
}

/** Scores the probabilities the plans actually recorded, not a re-computation:
 * this is what the system claimed before each race. One plan per race, the
 * model's own lanes only (the market-anchored lane is scored in market_blend). */
export function recordedCalibration(plans: Row[], judged: Row[], oddsByRace: Map<string, Row>): Row {
  const outcomeOf = new Map(judged.map((o) => [String(o.race_id), o]));
  const stated = new Map<string, { win: Map<number, number>; top3: Map<number, number> | null }>();
  for (const plan of [...plans].sort((a, b) => String(a.fixed_at).localeCompare(String(b.fixed_at)))) {
    if (plan.plan_lane === "evm") continue;
    const win = statedWin(plan);
    if (!win || !outcomeOf.has(String(plan.race_id))) continue;
    const top3Table = Object.entries(obj(obj(plan.simulation ?? {}).top3 ?? {})).map(([n, p]) => [Number(n), Number(p)] as const);
    const prior = stated.get(String(plan.race_id));
    stated.set(String(plan.race_id), { win, top3: top3Table.length ? new Map(top3Table) : prior?.top3 ?? null });
  }
  const winPairs: { p: number; y: number }[] = [], top3Pairs: { p: number; y: number }[] = [];
  const model: number[] = [], uniform: number[] = [], market: number[] = [], modelOnMarket: number[] = [];
  for (const [raceId, { win, top3 }] of stated) {
    const outcome = outcomeOf.get(raceId)!;
    const winners = (outcome.actual_winners ?? []) as number[];
    const placed = (outcome.actual_top3 ?? []) as number[];
    const total = [...win.values()].reduce((a, b) => a + b, 0);
    if (!(total > 0) || !winners.some((w) => win.has(w))) continue;
    for (const [n, p] of win) winPairs.push({ p: p / total, y: winners.includes(n) ? 1 : 0 });
    if (top3) for (const [n, p] of top3) top3Pairs.push({ p, y: placed.includes(n) ? 1 : 0 });
    const loss = -Math.log(Math.max(winners.reduce((s, w) => s + (win.get(w) ?? 0), 0) / total, 1e-9));
    model.push(loss);
    uniform.push(Math.log(win.size));
    const sample = outcomeSamples([outcome], oddsByRace)[0];
    const q = marketProbabilities(sample);
    if (q) {
      market.push(-Math.log(Math.max(winners.reduce((s, w) => s + (q.get(w) ?? 0), 0), 1e-9)));
      modelOnMarket.push(loss);
    }
  }
  return {
    races: model.length,
    log_loss: { stated: round(mean(model)), uniform: round(mean(uniform)) },
    stated_minus_uniform: pairedDifference(model, uniform),
    versus_market: {
      races: market.length,
      stated_log_loss: round(mean(modelOnMarket)),
      market_log_loss: round(mean(market)),
      stated_minus_market: pairedDifference(modelOnMarket, market),
    },
    win_reliability: reliability(winPairs),
    top3_reliability: reliability(top3Pairs),
    note: "発走前にプランへ記録した確率そのものを採点。log lossは低いほど良く、差の95%区間が0をまたぐ間は優劣を言えない",
  };
}

/** What the EV lane actually bought: a lane that only ever buys the longest
 * prices is testing the odds board, not the model. */
export function pickProfile(plans: Row[]): Row {
  const odds: number[] = [];
  let picks = 0;
  for (const plan of plans) {
    const lines = rows(plan.lines ?? []);
    for (const pick of rows(plan.picks ?? [])) {
      picks++;
      const key = JSON.stringify([pick.ticket_type, pick.selections_json]);
      const line = lines.find((l) =>
        JSON.stringify([l.ticket_type ?? "win", l.selections_json ?? [l.horse_number]]) === key);
      if (line && Number(line.odds) > 0) odds.push(Number(line.odds));
    }
  }
  odds.sort((a, b) => a - b);
  return {
    picks,
    median_odds: odds.length ? odds[Math.floor(odds.length / 2)] : null,
    share_odds_20_plus: odds.length ? round(odds.filter((o) => o >= 20).length / odds.length) : null,
  };
}

/** One sample per race: the last pre-start record is what the race was judged on. */
export function learningReport(outcomes: Row[], plans: Row[], oddsByRace: Map<string, Row>, now: string): Row {
  const judged = latestPerRace(outcomes);
  const samples = outcomeSamples(judged, oddsByRace);
  const bets = (kind: "win" | "place") => judged.flatMap((o) => {
    const f = obj(o.top1_flat ?? {})[kind];
    if (!f) return [];
    const outcome = obj(f);
    return [{ stake: 100, returned: Number(outcome.payout) + Number(outcome.refund) }];
  });
  // race-flow-v2: the 600-yen hit lane and the 400-yen EV lane are settled apart.
  // The market-anchored lane ("evm") is a third, separately settled record.
  const laneOf = (p: Row) => (p.plan_lane === "hit" ? "hit" : p.plan_lane === "evm" ? "evm" : "ev");
  const lane = (name: "hit" | "ev" | "evm") => plans.filter((p) => laneOf(p) === name);
  const settledOf = (list: Row[]) =>
    list.filter((p) => p.settled).map((p) => obj(p.settled) as unknown as { stake: number; returned: number });
  const planBets = settledOf(lane("ev"));
  const planReturn = returnRate(planBets.filter((b) => b.stake > 0));
  const hitBets = settledOf(lane("hit"));
  const hitReturn = returnRate(hitBets.filter((b) => b.stake > 0));
  const anchoredBets = settledOf(lane("evm"));
  const anchoredReturn = returnRate(anchoredBets.filter((b) => b.stake > 0));
  const win = returnRate(bets("win"));
  const count = judged.length;
  return {
    schema_version: "1",
    generated_at: now,
    races: count,
    by_status: {
      formal: judged.filter((o) => o.prediction_status === "formal").length,
      provisional: judged.filter((o) => o.prediction_status !== "formal").length,
    },
    top1_win_rate: count ? round(judged.filter((o) => o.top1_win).length / count) : null,
    top1_top3_rate: count ? round(judged.filter((o) => o.top1_top3).length / count) : null,
    top1_flat_win: { ...win, verdict: roiVerdict(win) },
    top1_flat_place: returnRate(bets("place")),
    hit_plans: {
      fixed: lane("hit").length,
      settled: hitBets.length,
      hit_races: hitBets.filter((b) => b.returned > 0).length,
      ...hitReturn,
      verdict: roiVerdict(hitReturn),
    },
    ev_plans: {
      fixed: lane("ev").length,
      settled: planBets.length,
      skipped: planBets.filter((b) => b.stake === 0).length,
      ...planReturn,
      verdict: roiVerdict(planReturn),
      pick_profile: pickProfile(lane("ev")),
    },
    market_anchored_plans: {
      fixed: lane("evm").length,
      settled: anchoredBets.length,
      skipped: anchoredBets.filter((b) => b.stake === 0).length,
      ...anchoredReturn,
      verdict: roiVerdict(anchoredReturn),
    },
    recorded_probabilities: recordedCalibration(plans, judged, oddsByRace),
    market_blend: walkForwardBlend(samples),
    learning: walkForward(samples),
    note: "仮想の記録。実馬券は購入しない。回収率は標本数と信頼区間を併せて読む",
  };
}
