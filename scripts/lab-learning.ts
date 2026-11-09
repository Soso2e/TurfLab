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
  const ready = holdout >= MIN_TRAIN_RACES && fixedLoss != null && learnedLoss != null && learnedLoss < fixedLoss;
  const fit = fitWeights(samples);
  return {
    version: LEARNING_VERSION,
    samples: samples.length,
    holdout_races: holdout,
    per_race: perRace.slice(-500),
    log_loss: { uniform: round(mean(uniform)), fixed_weights: round(fixedLoss), learned_weights: round(learnedLoss) },
    brier: { fixed_weights: round(mean(fixedBrier)), learned_weights: round(mean(learnedBrier)) },
    top1_win_rate: {
      fixed_weights: holdout ? round(hits.fixed / holdout) : null,
      learned_weights: holdout ? round(hits.learned / holdout) : null,
    },
    versus_market: {
      races: modelVsMarket.market.length,
      model_log_loss: round(mean(modelVsMarket.model)),
      market_log_loss: round(mean(modelVsMarket.market)),
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

/** One sample per race: the last pre-start record is what the race was judged on. */
export function learningReport(outcomes: Row[], plans: Row[], oddsByRace: Map<string, Row>, now: string): Row {
  const latest = new Map<string, Row>();
  for (const outcome of outcomes) {
    const prior = latest.get(String(outcome.race_id));
    if (!prior || String(prior.saved_at) <= String(outcome.saved_at)) latest.set(String(outcome.race_id), outcome);
  }
  const judged = [...latest.values()];
  const samples: Sample[] = judged.map((o) => {
    const odds = oddsByRace.get(String(o.race_id));
    return {
      race_id: String(o.race_id),
      date: String(o.race_date_jst),
      horses: features(rows(o.evaluations ?? [])),
      winners: (o.actual_winners ?? []) as number[],
      ...(odds ? { win_odds: Object.fromEntries(rows(odds.win_odds ?? []).map((q) => [String(q.horse_number), Number(q.odds)])) } : {}),
    };
  });
  const bets = (kind: "win" | "place") => judged.flatMap((o) => {
    const f = obj(o.top1_flat ?? {})[kind];
    if (!f) return [];
    const outcome = obj(f);
    return [{ stake: 100, returned: Number(outcome.payout) + Number(outcome.refund) }];
  });
  const planBets = plans.filter((p) => p.settled).map((p) => obj(p.settled) as unknown as { stake: number; returned: number });
  const planReturn = returnRate(planBets.filter((b) => b.stake > 0));
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
    ev_plans: {
      fixed: plans.length,
      settled: planBets.length,
      skipped: planBets.filter((b) => b.stake === 0).length,
      ...planReturn,
      verdict: roiVerdict(planReturn),
    },
    learning: walkForward(samples),
    note: "仮想の記録。実馬券は購入しない。回収率は標本数と信頼区間を併せて読む",
  };
}
