/**
 * Evaluation of frozen forecast-v1 records: M (math) vs A (AI) vs a log-linear pool E.
 * Odds-free. Everything is walk-forward by race date; paired by race; intervals are day-block
 * bootstrap (races on one day share going/bias, so the day is the unit of resampling).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cornersByHorse } from "../workers/api/src/run-records";
import {
  leakFreeEligible, REASON_CATEGORIES, scoreForecast, validateForecast,
  type Forecast, type RaceResult, type ReasonCategory,
} from "../packages/shared/src/forecast-contract";

export const EVAL_VERSION = "forecast-eval-v1";
export const MIN_RACES_NO_WORSE = 30;
export const MIN_RACES_SUPERIORITY = 300;
const MIN_TRAIN = 30;
const REFIT_DAYS = 7;
const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DayDiff = { races: number; days: number; mean: number | null; ci95: [number, number] | null; p: number | null };

/** Mean of (a - b) with a day-block bootstrap interval. Negative: a has the lower loss. */
export function dayBlockDifference(a: number[], b: number[], days: string[], seed = 20261121, boot = 2000): DayDiff {
  const n = a.length;
  if (!n) return { races: 0, days: 0, mean: null, ci95: null, p: null };
  const sums = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < n; i++) {
    const cur = sums.get(days[i]) ?? { s: 0, n: 0 };
    cur.s += a[i] - b[i]; cur.n++;
    sums.set(days[i], cur);
  }
  const blocks = [...sums.values()];
  const random = seeded(seed);
  const means: number[] = [];
  for (let k = 0; k < boot; k++) {
    let s = 0, c = 0;
    for (let j = 0; j < blocks.length; j++) {
      const bl = blocks[Math.floor(random() * blocks.length)];
      s += bl.s; c += bl.n;
    }
    means.push(s / c);
  }
  means.sort((x, y) => x - y);
  const m = mean(a.map((x, i) => x - b[i]));
  const ci: [number, number] = [round(means[Math.floor(boot * 0.025)]), round(means[Math.floor(boot * 0.975)])];
  const se = (ci[1] - ci[0]) / (2 * 1.96);
  return { races: n, days: blocks.length, mean: round(m), ci95: ci, p: se > 0 ? erfc(Math.abs(m) / se / Math.SQRT2) : 1 };
}

function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

export type Verdict = "insufficient_sample" | "superiority_candidate" | "better_but_below_claim_threshold" | "worse" | "no_difference_detected";
/** Claim ladder. Lower loss is better; never claims beyond what the sample allows. */
export function verdict(d: DayDiff): Verdict {
  if (d.races < MIN_RACES_NO_WORSE || !d.ci95) return "insufficient_sample";
  if (d.ci95[1] < 0) return d.races >= MIN_RACES_SUPERIORITY ? "superiority_candidate" : "better_but_below_claim_threshold";
  if (d.ci95[0] > 0) return "worse";
  return "no_difference_detected";
}

export function benjaminiHochberg(p: number[], q = 0.1): boolean[] {
  const order = p.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  let cutoff = 0;
  order.forEach(([v], r) => { if (v <= (q * (r + 1)) / p.length) cutoff = r + 1; });
  const keep = new Array<boolean>(p.length).fill(false);
  order.forEach(([, i], r) => { if (r + 1 <= cutoff) keep[i] = true; });
  return keep;
}

/* ---------------- probability algebra ---------------- */

export const normalise = (xs: number[]) => { const s = xs.reduce((a, b) => a + b, 0); return xs.map((x) => x / s); };
export const raceLoss = (p: number[], winners: number[]) => mean(winners.map((w) => -Math.log(Math.max(p[w], 1e-6))));
export function temper(p: number[], temperature: number): number[] {
  return normalise(p.map((x) => Math.max(x, 1e-9) ** (1 / temperature)));
}
export function logPool(pM: number[], pA: number[], wM: number, wA: number): number[] {
  const z = pM.map((m, i) => wM * Math.log(Math.max(m, 1e-9)) + wA * Math.log(Math.max(pA[i], 1e-9)));
  const top = Math.max(...z);
  return normalise(z.map((v) => Math.exp(v - top)));
}
export function jsDivergence(p: number[], q: number[]): number {
  const m = p.map((x, i) => (x + q[i]) / 2);
  const kl = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x > 0 ? x * Math.log(x / b[i]) : 0), 0);
  return 0.5 * kl(p, m) + 0.5 * kl(q, m);
}

export interface PairedRace {
  race_key: string; date: string; pM: number[]; pA: number[]; winners: number[]; reasons: ReasonCategory[];
}

/** Temperature for the AI's probabilities (LLMs avoid extremes), chosen on past races only. */
export function fitTemperature(train: PairedRace[]): number {
  let best = 1, bestLoss = Infinity;
  for (let t = 0.5; t <= 3.0001; t += 0.1) {
    const loss = mean(train.map((r) => raceLoss(temper(r.pA, t), r.winners)));
    if (loss < bestLoss) { bestLoss = loss; best = t; }
  }
  return round(best, 2);
}

/** Weights (wM, wA) of the log-linear pool; shrunk toward 0.5/0.5 so a small sample cannot overfit.
 * Coarse grid, then a local refinement; logs are computed once per race. */
export function fitPoolWeights(train: PairedRace[], pA: (r: PairedRace) => number[], shrink = 5): { wM: number; wA: number } {
  const lm = train.map((r) => r.pM.map((x) => Math.log(Math.max(x, 1e-9))));
  const la = train.map((r) => pA(r).map((x) => Math.log(Math.max(x, 1e-9))));
  const objective = (wM: number, wA: number) => {
    let total = shrink * ((wM - 0.5) ** 2 + (wA - 0.5) ** 2);
    for (let i = 0; i < train.length; i++) {
      const m = lm[i], a = la[i], k = m.length;
      let top = -Infinity;
      const z = new Array<number>(k);
      for (let j = 0; j < k; j++) { z[j] = wM * m[j] + wA * a[j]; if (z[j] > top) top = z[j]; }
      let s = 0;
      for (let j = 0; j < k; j++) s += Math.exp(z[j] - top);
      const lse = top + Math.log(s);
      let loss = 0;
      for (const w of train[i].winners) loss += lse - z[w];
      total += loss / train[i].winners.length;
    }
    return total;
  };
  let best = { wM: 0.5, wA: 0.5 }, bestLoss = Infinity;
  const search = (c: { wM: number; wA: number }, half: number, step: number) => {
    for (let wM = Math.max(0, c.wM - half); wM <= Math.min(1.5, c.wM + half) + 1e-9; wM += step)
      for (let wA = Math.max(0, c.wA - half); wA <= Math.min(1.5, c.wA + half) + 1e-9; wA += step) {
        const v = objective(wM, wA);
        if (v < bestLoss) { bestLoss = v; best = { wM, wA }; }
      }
  };
  search({ wM: 0.75, wA: 0.75 }, 0.75, 0.25);
  search(best, 0.2, 0.05);
  return { wM: round(best.wM, 2), wA: round(best.wA, 2) };
}

export interface EvalRow {
  race_key: string; date: string; reasons: ReasonCategory[]; divergence: number;
  lossM: number; lossA: number; lossAcal: number; lossE: number;
}

export interface EnsembleReport {
  status: "ok" | "insufficient_data";
  races_paired: number; races_evaluated: number;
  mean_loss?: { M: number; A_raw: number; A_calibrated: number; E_pool: number };
  paired?: Record<string, DayDiff & { verdict: Verdict }>;
  final_weights?: { wM: number; wA: number; temperature: number };
  rows: EvalRow[];
}

/** Walk-forward: every race is scored with temperature/weights fitted on strictly earlier dates. */
export function walkForwardEnsemble(samples: PairedRace[], minTrain = MIN_TRAIN): EnsembleReport {
  const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date) || a.race_key.localeCompare(b.race_key));
  const rows: EvalRow[] = [];
  const cache = new Map<string, { T: number; w: { wM: number; wA: number } }>();
  let fitted: { on: string; T: number; w: { wM: number; wA: number } } | null = null;
  for (const r of sorted) {
    const train = sorted.filter((s) => s.date < r.date);
    if (train.length < minTrain) continue;
    // Refit at most weekly: each race is still scored with parameters fitted on strictly earlier dates only.
    if (!fitted || (Date.parse(r.date) - Date.parse(fitted.on)) / 86_400_000 >= REFIT_DAYS) {
      const T = fitTemperature(train);
      fitted = { on: r.date, T, w: fitPoolWeights(train, (x) => temper(x.pA, T)) };
    }
    cache.set(r.date, fitted);
    const { T, w } = fitted;
    const aCal = temper(r.pA, T);
    rows.push({
      race_key: r.race_key, date: r.date, reasons: r.reasons, divergence: jsDivergence(r.pM, aCal),
      lossM: raceLoss(r.pM, r.winners), lossA: raceLoss(r.pA, r.winners), lossAcal: raceLoss(aCal, r.winners),
      lossE: raceLoss(logPool(r.pM, aCal, w.wM, w.wA), r.winners),
    });
  }
  if (!rows.length) return { status: "insufficient_data", races_paired: samples.length, races_evaluated: 0, rows };
  const days = rows.map((r) => r.date);
  const pair = (a: keyof EvalRow, b: keyof EvalRow) => {
    const d = dayBlockDifference(rows.map((r) => r[a] as number), rows.map((r) => r[b] as number), days);
    return { ...d, verdict: verdict(d) };
  };
  const last = [...cache.values()].at(-1)!;
  return {
    status: "ok", races_paired: samples.length, races_evaluated: rows.length,
    mean_loss: { M: round(mean(rows.map((r) => r.lossM))), A_raw: round(mean(rows.map((r) => r.lossA))),
      A_calibrated: round(mean(rows.map((r) => r.lossAcal))), E_pool: round(mean(rows.map((r) => r.lossE))) },
    paired: { "A_cal_vs_M": pair("lossAcal", "lossM"), "E_vs_M": pair("lossE", "lossM"), "E_vs_A_cal": pair("lossE", "lossAcal"),
      "A_cal_vs_A_raw": pair("lossAcal", "lossA") },
    final_weights: { ...last.w, temperature: last.T }, rows,
  };
}

/* ---------------- discovery ---------------- */

export interface DisagreementReport {
  status: "ok" | "insufficient_data";
  strata: { name: string; races: number; mean_loss_M: number; mean_loss_A_cal: number; mean_loss_E: number; A_minus_M: DayDiff & { verdict: Verdict }; A_better_share: number }[];
  note: string;
}

/** Where do M and A disagree, and who was right? Descriptive: strata are split at the median divergence. */
export function disagreementReport(rows: EvalRow[]): DisagreementReport {
  const note = "分割は評価集合の発散中央値による記述的層別。因果・採用判断には使わず、仮説生成のみ。";
  if (rows.length < 20) return { status: "insufficient_data", strata: [], note };
  const med = [...rows].map((r) => r.divergence).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const mk = (name: string, sel: EvalRow[]) => {
    const d = dayBlockDifference(sel.map((r) => r.lossAcal), sel.map((r) => r.lossM), sel.map((r) => r.date));
    return { name, races: sel.length, mean_loss_M: round(mean(sel.map((r) => r.lossM))), mean_loss_A_cal: round(mean(sel.map((r) => r.lossAcal))),
      mean_loss_E: round(mean(sel.map((r) => r.lossE))), A_minus_M: { ...d, verdict: verdict(d) },
      A_better_share: round(sel.filter((r) => r.lossAcal < r.lossM).length / sel.length, 3) };
  };
  return { status: "ok", strata: [mk("high_disagreement", rows.filter((r) => r.divergence > med)), mk("low_disagreement", rows.filter((r) => r.divergence <= med))], note };
}

export interface ReasonFinding {
  category: ReasonCategory; races: number; A_minus_M: DayDiff; bh_significant: boolean;
  reading: "ai_adds_value_candidate" | "ai_hurts_when_citing" | "no_evidence";
}

/** Does the AI add information beyond M when it cites a given reason? BH-adjusted over categories. */
export function reasonCategoryDiscovery(rows: EvalRow[], minRaces = MIN_RACES_NO_WORSE, q = 0.1): ReasonFinding[] {
  const tested = REASON_CATEGORIES.map((c) => {
    const sel = rows.filter((r) => r.reasons.includes(c));
    return { c, sel, d: sel.length >= minRaces ? dayBlockDifference(sel.map((r) => r.lossAcal), sel.map((r) => r.lossM), sel.map((r) => r.date)) : null };
  }).filter((t) => t.d !== null);
  const keep = benjaminiHochberg(tested.map((t) => t.d!.p ?? 1), q);
  return tested.map((t, i) => ({
    category: t.c, races: t.sel.length, A_minus_M: t.d!, bh_significant: keep[i],
    reading: keep[i] ? ((t.d!.mean ?? 0) < 0 ? "ai_adds_value_candidate" : "ai_hurts_when_citing") : "no_evidence",
  }));
}

/* ---------------- feature registry ---------------- */

export type FeatureStatus = "proposed" | "testing" | "adopted" | "rejected";
export interface FeatureTest { at: string; races: number; delta_log_loss: number; ci95: [number, number]; p: number; trials_at_time: number }
export interface FeatureEntry {
  id: string; definition: string; available_at_rule: string; expected_sign: "positive" | "negative" | "unknown";
  source: "human" | "ai_hypothesis" | "disagreement_analysis"; registered_at: string; status: FeatureStatus; tests: FeatureTest[];
}
export type Registry = { version: "feature-registry-v1"; trials: number; features: FeatureEntry[] };
export const emptyRegistry = (): Registry => ({ version: "feature-registry-v1", trials: 0, features: [] });

export function registerFeature(reg: Registry, entry: Omit<FeatureEntry, "status" | "tests">): Registry {
  if (reg.features.some((f) => f.id === entry.id)) throw new Error(`feature ${entry.id} is already registered`);
  if (!entry.definition.trim() || !entry.available_at_rule.trim()) throw new Error("definition and available_at_rule (when it becomes known) are required before testing");
  if (/odds|オッズ|人気|popular/i.test(`${entry.id} ${entry.definition}`)) throw new Error("odds/popularity features are not allowed");
  return { ...reg, features: [...reg.features, { ...entry, status: "proposed", tests: [] }] };
}

/** Decide only when enough races exist; every test counts toward the trial total (Bonferroni). */
export function recordFeatureTest(reg: Registry, id: string, test: Omit<FeatureTest, "trials_at_time" | "p">): Registry {
  const f = reg.features.find((x) => x.id === id);
  if (!f) throw new Error(`unknown feature ${id}`);
  const trials = reg.trials + 1;
  const se = (test.ci95[1] - test.ci95[0]) / (2 * 1.96);
  const p = se > 0 ? erfc(Math.abs(test.delta_log_loss) / se / Math.SQRT2) : 1;
  const adj = Math.min(1, p * trials);
  let status: FeatureStatus = "testing";
  if (test.races >= MIN_RACES_SUPERIORITY) {
    if (test.ci95[1] < 0 && adj < 0.05) status = "adopted"; // adding the feature lowers loss, beyond multiplicity
    else status = "rejected";
  }
  return { ...reg, trials, features: reg.features.map((x) => x.id === id ? { ...x, status, tests: [...x.tests, { ...test, p: round(p), trials_at_time: trials }] } : x) };
}

/* ---------------- ledger ---------------- */

export const safeKey = (s: string) => s.replace(/[^\w぀-ヿ一-鿿-]+/g, "_");
export type LockResult = { status: "locked" | "already_locked_same" | "conflict"; path: string };

/** Immutable, write-once forecast file per (race, forecaster). A different later body never overwrites. */
export async function lockForecast(root: string, forecast: Forecast): Promise<LockResult> {
  const file = path.join(root, "forecasts", forecast.race.date_jst, safeKey(forecast.race.race_key_human), `${forecast.forecaster.id}.json`);
  const body = JSON.stringify(forecast, null, 1);
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing !== null) return { status: existing === body ? "already_locked_same" : "conflict", path: file };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, { flag: "wx" });
  return { status: "locked", path: file };
}

async function jsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonFiles(p)));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

export async function loadForecasts(root: string): Promise<{ forecasts: Forecast[]; rejected: { file: string; errors: string[] }[] }> {
  const forecasts: Forecast[] = [], rejected: { file: string; errors: string[] }[] = [];
  for (const file of await jsonFiles(path.join(root, "forecasts"))) {
    const v = validateForecast(JSON.parse(await readFile(file, "utf8")));
    if (v.ok) forecasts.push(v.forecast); else rejected.push({ file, errors: v.errors });
  }
  return { forecasts, rejected };
}

export async function loadResults(root: string): Promise<RaceResult[]> {
  const out: RaceResult[] = [];
  for (const file of await jsonFiles(path.join(root, "forecast-results"))) out.push(JSON.parse(await readFile(file, "utf8")) as RaceResult);
  return out;
}

/**
 * Converts an official-result document (finish_order_json groups, pace_observation.corners lines)
 * into the evaluation result. Pace class stays null: it needs a time-consistent course baseline.
 */
export function raceResultFromOfficial(doc: Record<string, unknown>, raceKeyHuman: string, dateJst: string): RaceResult | null {
  const result = (doc.result ?? doc) as Record<string, unknown>;
  const order = Array.isArray(result.finish_order_json) ? result.finish_order_json : [];
  const groups = order.map((g) => (Array.isArray(g) ? g : [g]).map(Number).filter(Number.isFinite));
  if (!groups.length || !groups[0].length) return null;
  const finishers: RaceResult["finishers"] = [];
  let ahead = 0;
  for (const g of groups) { for (const n of g) finishers.push({ horse_number: n, finish: ahead + 1 }); ahead += g.length; }
  const statuses = (result.entry_status_json ?? {}) as Record<string, string>;
  for (const [n, st] of Object.entries(statuses))
    if (["dnf", "disqualified"].includes(st) && !finishers.some((f) => f.horse_number === Number(n))) finishers.push({ horse_number: Number(n), finish: null });
  const pace = (doc.pace_observation ?? {}) as Record<string, unknown>;
  const byHorse = cornersByHorse((pace.corners ?? []) as never);
  const corners: NonNullable<RaceResult["corners"]> = {};
  for (const [n, ranks] of byHorse) if (ranks.length) corners[String(n)] = { first: ranks[0], last: ranks[ranks.length - 1] };
  return { race_key_human: raceKeyHuman, date_jst: dateJst, winners: groups[0], finishers, ...(Object.keys(corners).length ? { corners } : {}), pace_observed: null };
}

export interface FullReport {
  version: string; math_id: string; ai_id: string;
  counts: { forecasts: number; rejected: number; results: number; paired: number; ai_excluded_knowledge_cutoff: number };
  single: Record<string, { races: number; log_loss: number; brier: number; top3_brier: number | null; pace_class_accuracy: number | null }>;
  ensemble: Omit<EnsembleReport, "rows">;
  disagreement: DisagreementReport;
  reason_discovery: ReasonFinding[];
  claim: string;
}

export function buildReport(forecasts: Forecast[], results: RaceResult[], rejectedCount: number, mathId: string, aiId: string): FullReport {
  const resultBy = new Map(results.map((r) => [r.race_key_human, r]));
  const byRace = new Map<string, { M?: Forecast; A?: Forecast }>();
  for (const f of forecasts) {
    const slot = byRace.get(f.race.race_key_human) ?? {};
    if (f.forecaster.id === mathId) slot.M = f; else if (f.forecaster.id === aiId) slot.A = f;
    byRace.set(f.race.race_key_human, slot);
  }
  const single: FullReport["single"] = {};
  const acc: Record<string, { ll: number[]; br: number[]; t3: number[]; pace: boolean[] }> = {};
  const pairs: PairedRace[] = [];
  let aiExcluded = 0;
  for (const [key, { M, A }] of byRace) {
    const result = resultBy.get(key);
    if (!result) continue;
    for (const f of [M, A]) {
      if (!f) continue;
      if (f.forecaster.kind === "ai" && !leakFreeEligible(f)) { aiExcluded++; continue; }
      const s = scoreForecast(f, result);
      const a = (acc[f.forecaster.id] ??= { ll: [], br: [], t3: [], pace: [] });
      a.ll.push(s.log_loss); a.br.push(s.brier);
      if (s.top3_brier != null) a.t3.push(s.top3_brier);
      if (s.pace_class_match != null) a.pace.push(s.pace_class_match);
    }
    if (M && A && leakFreeEligible(A)) {
      const order = (f: Forecast) => [...f.horses].sort((x, y) => x.horse_number - y.horse_number);
      const hm = order(M), ha = order(A);
      if (hm.length === ha.length && hm.every((h, i) => h.horse_number === ha[i].horse_number)) {
        const idx = result.winners.map((w) => hm.findIndex((h) => h.horse_number === w)).filter((i) => i >= 0);
        if (idx.length) pairs.push({ race_key: key, date: M.race.date_jst, pM: normalise(hm.map((h) => h.win_probability)),
          pA: normalise(ha.map((h) => h.win_probability)), winners: idx, reasons: A.reason_categories });
      }
    }
  }
  for (const [id, a] of Object.entries(acc)) single[id] = {
    races: a.ll.length, log_loss: round(mean(a.ll)), brier: round(mean(a.br)),
    top3_brier: a.t3.length ? round(mean(a.t3)) : null, pace_class_accuracy: a.pace.length ? round(a.pace.filter(Boolean).length / a.pace.length, 3) : null,
  };
  const ens = walkForwardEnsemble(pairs);
  const { rows, ...ensemble } = ens;
  const eVsM = ens.paired?.["E_vs_M"];
  const claim = !eVsM ? "標本不足: 統合の効果は判定しない"
    : eVsM.verdict === "superiority_candidate" ? "統合Eは数式Mに対し確率精度の優位候補（前向き運用で再確認）"
    : eVsM.verdict === "worse" ? "統合EはMより悪い。統合を採用しない"
    : eVsM.verdict === "better_but_below_claim_threshold" ? "改善傾向はあるが主張水準未満（300R未満）"
    : "統合の効果は検出されていない（採用しない）";
  return {
    version: EVAL_VERSION, math_id: mathId, ai_id: aiId,
    counts: { forecasts: forecasts.length, rejected: rejectedCount, results: results.length, paired: pairs.length, ai_excluded_knowledge_cutoff: aiExcluded },
    single, ensemble, disagreement: disagreementReport(rows), reason_discovery: reasonCategoryDiscovery(rows), claim,
  };
}
