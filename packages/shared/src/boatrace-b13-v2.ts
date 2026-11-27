// 研究専用（shadow only）: B13v2 — 特徴量付き Plackett–Luce モデル群。
// - B13v2Pre (メイン昇格): 締切前展示あり時は展示特徴量モデル、欠損時は展示欠損専用モデル(B13v2NoEx)を使用。
// - B13v2: 全展示データ（事後含む）を使う再構成比較用モデル。
// - B13v2NoEx: 展示欠損時の専用モデル（枠番・コース別級別・内3艇降順・1号艇能力差のみ）。
// - 既存 B13 / B01 / B02 / FIXED123 も廃止せず同一レース・同一予算条件（仮想予算10万円、1R=200円）で並行比較。
import { BOATS, type BoatRecord } from "./boatrace";
import { decideB11, gradePoint } from "./boatrace-b11";
import { b13Distribution, fitB13, topThree } from "./boatrace-b13";

export const B13V2_VERSION = "b13-context-pl-shadow-v2" as const;
export const VIRTUAL_BANKROLL_INITIAL_YEN = 100_000 as const;
export const B13V2_CONFIG = {
  iterations: 350,
  step: 0.25,
  l2Intercept: 0.02,
  l2Feature: 0.1,
  stakePerTicket: 100,
  ticketCount: 2,
  /** 合計0のゼロ和コントラスト。Plackett-Luce の Softmax でレース共通特徴量が相殺されないことを保証する。 */
  innerSlope: [1.0, 0.4, 0.1, -0.4, -0.5, -0.6] as readonly number[],
  b1FocusContrast: [5 / 6, -1 / 6, -1 / 6, -1 / 6, -1 / 6, -1 / 6] as readonly number[],
} as const;

export const B13V2_FEATURE_NAMES = [
  "lane_1", "lane_2", "lane_3", "lane_4", "lane_5", "lane_6",
  "grade_c1", "grade_c2", "grade_c3", "grade_c4", "grade_c5", "grade_c6",
  "f_c1", "f_c2", "f_c3", "f_c4", "f_c5", "f_c6",
  "ex_time_z",
  "race_time_std",
  "race_st_std",
  "race_inner_desc",
  "race_b1_minus_others",
  "race_ex_wakunari",
] as const;

export const B13V2_NOEX_FEATURE_NAMES = [
  "lane_1", "lane_2", "lane_3", "lane_4", "lane_5", "lane_6",
  "grade_c1", "grade_c2", "grade_c3", "grade_c4", "grade_c5", "grade_c6",
  "race_inner_desc",
  "race_b1_minus_others",
] as const;

export type B13V2ModelId = "B13v2Pre" | "B13v2" | "B13v2NoEx" | "B13" | "B01" | "B02" | "FIXED123" | "B11";

export interface B13V2RaceFeatures {
  hasAllGrades: boolean;
  gradePoints: (number | null)[];
  innerDesc: boolean | null;
  b1MinusOthers: number | null;
  exhibitionSource: "freeze" | "exhibition" | null;
  exhibitionFetchedAt: string | null;
  exhibitionPreCutoff: boolean;
  hasCompleteExhibition: boolean;
  exhibitionWakunari: boolean | null;
  exhibitionOrder: string | null;
  timeStd: number | null;
  timeZ: (number | null)[];
  stStd: number | null;
  exhibitionF: (boolean | null)[];
  exhibitionFDepth: (number | null)[];
}

export interface B13V2NormStats {
  timeStdMean: number;
  timeStdStd: number;
  stStdMean: number;
  stStdStd: number;
  wakunariMean: number;
  b1DiffMean: number;
  b1DiffStd: number;
  innerDescMean: number;
}

export interface B13V2FittedModel {
  version: typeof B13V2_VERSION;
  kind: "full" | "noex";
  weights: number[];
  norm: B13V2NormStats;
  trainingCount: number;
  namedWeights: Record<string, number>;
}

function before(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(
    a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) < Date.parse(b),
  );
}

function parseExhibitionSt(st: string | null | undefined, flying: boolean | null | undefined): {
  signed: number | null;
  isF: boolean | null;
  depth: number | null;
} {
  if (st === null || st === undefined) return { signed: null, isF: null, depth: null };
  const s = st.trim();
  if (!s || s === "-") return { signed: null, isF: null, depth: null };
  if (s.startsWith("L")) return { signed: null, isF: false, depth: 0 };
  if (s.startsWith("F")) {
    const val = Number(s.slice(1));
    if (!Number.isFinite(val)) return { signed: null, isF: true, depth: null };
    return { signed: -val, isF: true, depth: val };
  }
  const val = Number(s);
  if (!Number.isFinite(val)) return { signed: null, isF: null, depth: null };
  const isF = flying === true;
  return { signed: isF ? -val : val, isF, depth: isF ? val : 0 };
}

/** 締切前の番組情報と展示情報から B13v2 特徴量を抽出する。欠損は null を保持する。 */
export function extractB13V2Features(
  race: BoatRecord,
  options: { preCutoffExhibitionOnly?: boolean } = {},
): B13V2RaceFeatures {
  const preOnly = options.preCutoffExhibitionOnly ?? false;
  const cutoff = race.freeze?.cutoff ?? race.cutoff;

  const gradePoints = BOATS.map((b) => gradePoint(race.entries.find((e) => e.boat === b)?.grade_original));
  const hasAllGrades = gradePoints.every((p): p is number => p !== null);
  const innerDesc = hasAllGrades ? gradePoints[0]! >= gradePoints[1]! && gradePoints[1]! >= gradePoints[2]! : null;
  const b1MinusOthers = hasAllGrades
    ? gradePoints[0]! - (gradePoints[1]! + gradePoints[2]! + gradePoints[3]! + gradePoints[4]! + gradePoints[5]!) / 5
    : null;

  let exhibitionSource: "freeze" | "exhibition" | null = null;
  let exhibitionFetchedAt: string | null = null;
  const courseMap = new Map<number, number>();
  const timeMap = new Map<number, number>();
  const stMap = new Map<number, number>();
  const fMap = new Map<number, boolean>();
  const fDepthMap = new Map<number, number>();

  const freezeHasEx = Boolean(race.freeze?.entries?.some((e) => e.exhibitionST !== null || e.exhibitionSeconds !== null));
  if (freezeHasEx && race.freeze) {
    exhibitionSource = "freeze";
    exhibitionFetchedAt = race.freeze.evidence.exhibition?.fetchedAt ?? null;
  } else if (race.exhibition?.entries?.length) {
    exhibitionSource = "exhibition";
    exhibitionFetchedAt = race.exhibition.evidence?.fetchedAt ?? null;
  }

  const exhibitionPreCutoff = before(exhibitionFetchedAt, cutoff);
  const allowEx = exhibitionSource !== null && (!preOnly || exhibitionPreCutoff);

  if (allowEx) {
    if (exhibitionSource === "freeze" && race.freeze) {
      for (const e of race.freeze.entries) {
        if (e.exhibitionCourse !== null) courseMap.set(e.boat, e.exhibitionCourse);
        if (e.exhibitionSeconds !== null && Number.isFinite(e.exhibitionSeconds)) timeMap.set(e.boat, e.exhibitionSeconds);
        const parsed = parseExhibitionSt(e.exhibitionST, e.exhibitionF);
        if (parsed.signed !== null) stMap.set(e.boat, parsed.signed);
        if (parsed.isF !== null) fMap.set(e.boat, parsed.isF);
        if (parsed.depth !== null) fDepthMap.set(e.boat, parsed.depth);
      }
    } else if (exhibitionSource === "exhibition" && race.exhibition) {
      for (const e of race.exhibition.entries) {
        if (Number.isInteger(e.course)) courseMap.set(e.boat, e.course);
        const parsed = parseExhibitionSt(e.st, e.flying);
        if (parsed.signed !== null) stMap.set(e.boat, parsed.signed);
        if (parsed.isF !== null) fMap.set(e.boat, parsed.isF);
        if (parsed.depth !== null) fDepthMap.set(e.boat, parsed.depth);
      }
      if (race.exhibition.times) {
        for (const [k, v] of Object.entries(race.exhibition.times)) {
          if (typeof v === "number" && Number.isFinite(v)) timeMap.set(Number(k), v);
        }
      }
    }
  }

  let exhibitionOrder: string | null = null;
  if (courseMap.size === 6) {
    const byCourse = new Array<number>(6).fill(0);
    let ok = true;
    for (const [boat, course] of courseMap) {
      if (course < 1 || course > 6 || byCourse[course - 1] !== 0) { ok = false; break; }
      byCourse[course - 1] = boat;
    }
    if (ok) exhibitionOrder = byCourse.join("");
  }
  const exhibitionWakunari = exhibitionOrder === null ? null : exhibitionOrder === "123456";

  let timeStd: number | null = null;
  const timeZ: (number | null)[] = BOATS.map(() => null);
  if (timeMap.size === 6) {
    const vals = BOATS.map((b) => timeMap.get(b)!);
    const mean = vals.reduce((a, b) => a + b, 0) / 6;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / 6);
    timeStd = sd;
    for (let i = 0; i < 6; i++) {
      timeZ[i] = sd > 1e-9 ? (vals[i] - mean) / sd : 0;
    }
  }

  let stStd: number | null = null;
  if (stMap.size === 6) {
    const vals = BOATS.map((b) => stMap.get(b)!);
    const mean = vals.reduce((a, b) => a + b, 0) / 6;
    stStd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / 6);
  }

  const exhibitionF = BOATS.map((b) => (fMap.size === 6 ? (fMap.get(b) ?? null) : null));
  const exhibitionFDepth = BOATS.map((b) => (fDepthMap.size === 6 ? (fDepthMap.get(b) ?? null) : null));
  const hasCompleteExhibition = timeStd !== null && stStd !== null && exhibitionWakunari !== null && fMap.size === 6;

  return {
    hasAllGrades,
    gradePoints,
    innerDesc,
    b1MinusOthers,
    exhibitionSource,
    exhibitionFetchedAt,
    exhibitionPreCutoff,
    hasCompleteExhibition,
    exhibitionWakunari,
    exhibitionOrder,
    timeStd,
    timeZ,
    stStd,
    exhibitionF,
    exhibitionFDepth,
  };
}

function meanStd(values: number[], fallbackMean: number, fallbackStd: number) {
  if (values.length < 2) return { mean: fallbackMean, std: fallbackStd };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, std: sd > 1e-9 ? sd : fallbackStd };
}

function computeNorm(items: readonly B13V2RaceFeatures[]): B13V2NormStats {
  const timeStds = items.map((x) => x.timeStd).filter((v): v is number => v !== null);
  const stStds = items.map((x) => x.stStd).filter((v): v is number => v !== null);
  const wakus = items.map((x) => x.exhibitionWakunari).filter((v): v is boolean => v !== null).map(Number);
  const b1Diffs = items.map((x) => x.b1MinusOthers).filter((v): v is number => v !== null);
  const innerDescs = items.map((x) => x.innerDesc).filter((v): v is boolean => v !== null).map(Number);

  const t = meanStd(timeStds, 0.04, 0.015);
  const s = meanStd(stStds, 0.07, 0.03);
  const b = meanStd(b1Diffs, 0.3, 0.8);
  return {
    timeStdMean: t.mean,
    timeStdStd: t.std,
    stStdMean: s.mean,
    stStdStd: s.std,
    wakunariMean: wakus.length ? wakus.reduce((a, c) => a + c, 0) / wakus.length : 0.85,
    b1DiffMean: b.mean,
    b1DiffStd: b.std,
    innerDescMean: innerDescs.length ? innerDescs.reduce((a, c) => a + c, 0) / innerDescs.length : 0.5,
  };
}

/** 6艇分の特徴量行列（6×24）を構築する。すべてのレース共通特徴量はゼロ和コントラストで相殺を防止。 */
export function buildBoatFeatureMatrix(feat: B13V2RaceFeatures, norm: B13V2NormStats): number[][] {
  const gPoints = feat.hasAllGrades ? (feat.gradePoints as number[]) : [2.5, 2.5, 2.5, 2.5, 2.5, 2.5];
  const gMean = gPoints.reduce((a, b) => a + b, 0) / 6;
  const tStdC = feat.timeStd !== null ? (feat.timeStd - norm.timeStdMean) / norm.timeStdStd : 0;
  const stStdC = feat.stStd !== null ? (feat.stStd - norm.stStdMean) / norm.stStdStd : 0;
  const wakuC = feat.exhibitionWakunari !== null ? Number(feat.exhibitionWakunari) - norm.wakunariMean : 0;
  const b1C = feat.b1MinusOthers !== null ? (feat.b1MinusOthers - norm.b1DiffMean) / norm.b1DiffStd : 0;
  const idC = feat.innerDesc !== null ? Number(feat.innerDesc) - norm.innerDescMean : 0;

  return BOATS.map((_, i) => {
    const v = new Array<number>(B13V2_FEATURE_NAMES.length).fill(0);
    const slope = B13V2_CONFIG.innerSlope[i];
    const b1Contrast = B13V2_CONFIG.b1FocusContrast[i];
    v[i] = 1;
    v[6 + i] = gPoints[i] - gMean;
    v[12 + i] = feat.exhibitionF[i] === true ? 1 : 0;
    v[18] = feat.timeZ[i] ?? 0;
    v[19] = tStdC * slope;
    v[20] = stStdC * slope;
    v[21] = idC * slope;
    v[22] = b1C * b1Contrast;
    v[23] = wakuC * slope;
    return v;
  });
}

/** 展示欠損専用モデル用の特徴量行列（6×14）。展示情報に一切依存しない。 */
export function buildNoExFeatureMatrix(feat: B13V2RaceFeatures, norm: B13V2NormStats): number[][] {
  const gPoints = feat.hasAllGrades ? (feat.gradePoints as number[]) : [2.5, 2.5, 2.5, 2.5, 2.5, 2.5];
  const gMean = gPoints.reduce((a, b) => a + b, 0) / 6;
  const b1C = feat.b1MinusOthers !== null ? (feat.b1MinusOthers - norm.b1DiffMean) / norm.b1DiffStd : 0;
  const idC = feat.innerDesc !== null ? Number(feat.innerDesc) - norm.innerDescMean : 0;

  return BOATS.map((_, i) => {
    const v = new Array<number>(B13V2_NOEX_FEATURE_NAMES.length).fill(0);
    v[i] = 1;
    v[6 + i] = gPoints[i] - gMean;
    v[12] = idC * B13V2_CONFIG.innerSlope[i];
    v[13] = b1C * B13V2_CONFIG.b1FocusContrast[i];
    return v;
  });
}

function fitLinearPL(
  samples: readonly { features: B13V2RaceFeatures; order: readonly number[] }[],
  kind: "full" | "noex",
): B13V2FittedModel | null {
  if (!samples.length) return null;
  for (const s of samples) {
    if (s.order.length !== 3 || new Set(s.order).size !== 3 || s.order.some((b) => !BOATS.some((n) => n === b))) {
      throw new Error("Invalid top-three training observation");
    }
  }
  const norm = computeNorm(samples.map((s) => s.features));
  const featureNames = kind === "full" ? B13V2_FEATURE_NAMES : B13V2_NOEX_FEATURE_NAMES;
  const builder = kind === "full" ? buildBoatFeatureMatrix : buildNoExFeatureMatrix;
  const matrices = samples.map((s) => ({ x: builder(s.features, norm), order: s.order }));
  const dim = featureNames.length;
  const w = new Array<number>(dim).fill(0);
  const n = matrices.length;

  for (let it = 0; it < B13V2_CONFIG.iterations; it++) {
    const grad = new Array<number>(dim).fill(0);
    for (const { x, order } of matrices) {
      const scores = x.map((row) => {
        let sum = 0;
        for (let k = 0; k < dim; k++) sum += w[k] * row[k];
        return sum;
      });
      let remaining: number[] = [...BOATS];
      for (const winner of order) {
        const max = Math.max(...remaining.map((b) => scores[b - 1]));
        const exps = remaining.map((b) => Math.exp(scores[b - 1] - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        remaining.forEach((b, idx) => {
          const coef = Number(b === winner) - exps[idx] / sum;
          const row = x[b - 1];
          for (let k = 0; k < dim; k++) {
            if (row[k] !== 0) grad[k] += coef * row[k];
          }
        });
        remaining = remaining.filter((b) => b !== winner);
      }
    }
    for (let k = 0; k < dim; k++) {
      const reg = k < 6 ? B13V2_CONFIG.l2Intercept : B13V2_CONFIG.l2Feature;
      w[k] += B13V2_CONFIG.step * (grad[k] / n - reg * w[k]);
    }
  }

  const namedWeights = Object.fromEntries(featureNames.map((name, i) => [name, w[i]]));
  return { version: B13V2_VERSION, kind, weights: w, norm, trainingCount: n, namedWeights };
}

export function fitB13V2(samples: readonly { features: B13V2RaceFeatures; order: readonly number[] }[]) {
  return fitLinearPL(samples, "full");
}

export function fitB13V2NoEx(samples: readonly { features: B13V2RaceFeatures; order: readonly number[] }[]) {
  return fitLinearPL(samples, "noex");
}

export function predictB13V2(model: B13V2FittedModel, features: B13V2RaceFeatures) {
  const x = model.kind === "full" ? buildBoatFeatureMatrix(features, model.norm) : buildNoExFeatureMatrix(features, model.norm);
  const scores = x.map((row) => row.reduce((sum, v, k) => sum + v * model.weights[k], 0));
  const distribution = b13Distribution(scores);
  return { scores, distribution };
}

/** 120通り3連単確率分布に対する Multi-class Brier Score と Top-3 Log Loss を計算する。 */
export function scoreDistribution(dist: readonly { combination: string; probability: number }[], actual: string) {
  let pActual = 0;
  let sumSq = 0;
  for (const item of dist) {
    sumSq += item.probability * item.probability;
    if (item.combination === actual) pActual = item.probability;
  }
  return {
    logLoss: pActual > 0 ? -Math.log(pActual) : null,
    brierScore: 1 - 2 * pActual + sumSq,
  };
}

function makeStats() {
  return {
    targets: 0,
    applied: 0,
    skipped: 0,
    pending: 0,
    excluded: 0,
    settled: 0,
    hits: 0,
    stake: 0,
    payout: 0,
    refund: 0,
    logLossSum: 0,
    logLossCount: 0,
    brierSum: 0,
    brierCount: 0,
  };
}
type Stats = ReturnType<typeof makeStats>;

function finishStats(s: Stats) {
  const net = s.payout + s.refund - s.stake;
  return {
    ...s,
    net,
    balanceEnd: VIRTUAL_BANKROLL_INITIAL_YEN + net,
    roi: s.stake ? (s.payout + s.refund) / s.stake : null,
    hitRate: s.settled ? s.hits / s.settled : null,
    logLoss: s.logLossCount ? s.logLossSum / s.logLossCount : null,
    brierScore: s.brierCount ? s.brierSum / s.brierCount : null,
  };
}

function recordOutcome(s: Stats, tickets: string[] | null, race: BoatRecord, unitStakePerTicket: number = B13V2_CONFIG.stakePerTicket) {
  s.targets++;
  if (!tickets) { s.skipped++; return; }
  s.applied++;
  const result = race.result;
  if (!result) { s.pending++; return; }
  if (result.status === "official" && !Object.keys(result.payouts).length && !result.special) { s.excluded++; return; }
  s.settled++;
  let stake = 0;
  let payout = 0;
  let refund = 0;
  let hit = false;
  for (const t of tickets) {
    stake += unitStakePerTicket;
    const refunded = result.status === "void" || t.split("-").some((b) => result.refundBoats.includes(Number(b)));
    if (refunded) {
      refund += unitStakePerTicket;
    } else {
      const p100 = result.payouts[t] ?? 0;
      const mult = unitStakePerTicket / 100;
      payout += p100 * mult;
      if (p100 > 0) hit = true;
    }
  }
  s.stake += stake;
  s.payout += payout;
  s.refund += refund;
  s.hits += Number(hit);
}

const MODEL_IDS: B13V2ModelId[] = ["B13v2Pre", "B13v2", "B13v2NoEx", "B13", "B01", "B02", "FIXED123", "B11"];
const initModels = () => Object.fromEntries(MODEL_IDS.map((id) => [id, makeStats()])) as Record<B13V2ModelId, Stats>;
const finalizeModels = (m: Record<B13V2ModelId, Stats>) =>
  Object.fromEntries(MODEL_IDS.map((id) => [id, finishStats(m[id])])) as Record<B13V2ModelId, ReturnType<typeof finishStats>>;

/** 固定モデル（B01, B02, FIXED123）にも疑似確率分布を割り当てて Brier/LogLoss を算出したい場合のヘルパー。 */
function fixedTicketsAndDist(model: "B01" | "B02" | "FIXED123") {
  if (model === "FIXED123") return [{ combination: "1-2-3", probability: 1 }];
  if (model === "B01") return [{ combination: "1-2-3", probability: 0.5 }, { combination: "1-3-2", probability: 0.5 }];
  return [{ combination: "1-2-3", probability: 0.5 }, { combination: "1-2-4", probability: 0.5 }];
}

/**
 * JST日付単位 expanding window による全モデル同一レース・同一予算条件（1R=200円、仮想予算10万円）比較。
 * - B13v2Pre (メイン): 締切前展示あり時は展示特徴量モデル、欠損時は B13v2NoEx を使用
 * - B13v2: 全展示データ利用（再構成比較）
 * - B13v2NoEx: 展示欠損専用モデル（全レースに適用）
 * - B13 / B01 / B02 / FIXED123(200円相当) / B11
 */
export function evaluateB13V2(races: readonly BoatRecord[], options: { from?: string } = {}) {
  if (new Set(races.map((r) => r.id)).size !== races.length) {
    throw new Error("B13v2 requires deduplicated race IDs");
  }
  const sorted = [...races].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const dates = [...new Set(sorted.map((r) => r.date))];
  const evalFrom = options.from ?? "0000-00-00";
  const overall = initModels();

  const missingness = {
    totalRaces: sorted.length,
    missingGrades: 0,
    missingExhibition: 0,
    preCutoffExhibition: 0,
    postCutoffExhibition: 0,
    preCutoffExhibitionRate: 0,
  };
  for (const r of sorted) {
    const f = extractB13V2Features(r, { preCutoffExhibitionOnly: false });
    if (!f.hasAllGrades) missingness.missingGrades++;
    if (f.exhibitionSource === null) missingness.missingExhibition++;
    else if (f.exhibitionPreCutoff) missingness.preCutoffExhibition++;
    else missingness.postCutoffExhibition++;
  }
  missingness.preCutoffExhibitionRate = sorted.length ? missingness.preCutoffExhibition / sorted.length : 0;

  const days = dates.map((date) => {
    const asOf = date + "T00:00:00+09:00";
    const trainingRaw = sorted.flatMap((r) => {
      if (r.date >= date || !before(r.program.fetchedAt, r.cutoff) || !before(r.result?.evidence.fetchedAt, asOf)) {
        return [];
      }
      const order = topThree(r);
      return order ? [{ race: r, order }] : [];
    });

    const modelFull = fitB13V2(
      trainingRaw.map(({ race, order }) => ({
        features: extractB13V2Features(race, { preCutoffExhibitionOnly: false }),
        order,
      })),
    );
    const modelPre = fitB13V2(
      trainingRaw.map(({ race, order }) => ({
        features: extractB13V2Features(race, { preCutoffExhibitionOnly: true }),
        order,
      })),
    );
    const modelNoEx = fitB13V2NoEx(
      trainingRaw.map(({ race, order }) => ({
        features: extractB13V2Features(race, { preCutoffExhibitionOnly: true }),
        order,
      })),
    );
    const b13Weights = fitB13(trainingRaw.map((t) => t.order));
    const b13Dist = b13Weights ? b13Distribution(b13Weights) : null;

    const dayStats = initModels();
    const targets = sorted.filter((r) => r.date === date);
    const includeInOverall = date >= evalFrom;

    const rows = targets.map((race) => {
      const programOk = before(race.program.fetchedAt, race.cutoff);
      const status = !programOk ? "program-not-pre-cutoff" : !modelFull ? "no-prior-training" : "eligible";
      const fFull = extractB13V2Features(race, { preCutoffExhibitionOnly: false });
      const fPre = extractB13V2Features(race, { preCutoffExhibitionOnly: true });

      const predFull = status === "eligible" && modelFull ? predictB13V2(modelFull, fFull) : null;
      // B13v2Pre (メイン): 締切前展示が揃っていれば modelPre、欠損なら専用モデル modelNoEx を使用
      const preUsedNoEx = status === "eligible" && !fPre.hasCompleteExhibition;
      const predPre =
        status === "eligible"
          ? fPre.hasCompleteExhibition && modelPre
            ? predictB13V2(modelPre, fPre)
            : modelNoEx
              ? predictB13V2(modelNoEx, fPre)
              : null
          : null;
      const predNoEx = status === "eligible" && modelNoEx ? predictB13V2(modelNoEx, fPre) : null;
      const b11 = decideB11(BOATS.map((b) => race.entries.find((e) => e.boat === b)?.grade_original ?? null));

      const tickets: Record<B13V2ModelId, string[] | null> =
        status === "eligible"
          ? {
              B13v2Pre: predPre!.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B13v2: predFull!.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B13v2NoEx: predNoEx!.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B13: b13Dist!.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B01: ["1-2-3", "1-3-2"],
              B02: ["1-2-3", "1-2-4"],
              FIXED123: ["1-2-3"],
              B11: b11.status === "bet" ? b11.tickets : null,
            }
          : { B13v2Pre: null, B13v2: null, B13v2NoEx: null, B13: null, B01: null, B02: null, FIXED123: null, B11: null };

      for (const id of MODEL_IDS) {
        // 同一予算条件（1レース200円）で比較するため FIXED123 も 1点200円換算で記録
        const unit = id === "FIXED123" ? 200 : B13V2_CONFIG.stakePerTicket;
        recordOutcome(dayStats[id], tickets[id], race, unit);
        if (includeInOverall) recordOutcome(overall[id], tickets[id], race, unit);
      }

      const order = topThree(race);
      const actual = order?.join("-") ?? null;
      if (status === "eligible" && actual) {
        const addProbMetrics = (
          id: B13V2ModelId,
          dist: readonly { combination: string; probability: number }[] | null,
          includeLogLoss = true,
        ) => {
          if (!dist) return;
          const m = scoreDistribution(dist, actual);
          const targetsStats = includeInOverall ? [dayStats[id], overall[id]] : [dayStats[id]];
          for (const st of targetsStats) {
            if (includeLogLoss && m.logLoss !== null) {
              st.logLossSum += m.logLoss;
              st.logLossCount++;
            }
            st.brierSum += m.brierScore;
            st.brierCount++;
          }
        };
        addProbMetrics("B13v2Pre", predPre?.distribution ?? null);
        addProbMetrics("B13v2", predFull?.distribution ?? null);
        addProbMetrics("B13v2NoEx", predNoEx?.distribution ?? null);
        addProbMetrics("B13", b13Dist);
        addProbMetrics("B01", fixedTicketsAndDist("B01"), false);
        addProbMetrics("B02", fixedTicketsAndDist("B02"), false);
        addProbMetrics("FIXED123", fixedTicketsAndDist("FIXED123"), false);
      }

      return {
        raceId: race.id,
        venueName: race.venueName,
        number: race.number,
        cutoff: race.cutoff,
        status,
        preUsedNoEx,
        actual,
        tickets,
        topProbs: predPre ? predPre.distribution.slice(0, 5) : null,
      };
    });

    return {
      date,
      asOf,
      trainingCount: trainingRaw.length,
      modelFull: modelFull ? { namedWeights: modelFull.namedWeights, norm: modelFull.norm } : null,
      modelPre: modelPre ? { namedWeights: modelPre.namedWeights, norm: modelPre.norm } : null,
      modelNoEx: modelNoEx ? { namedWeights: modelNoEx.namedWeights, norm: modelNoEx.norm } : null,
      models: finalizeModels(dayStats),
      rows,
    };
  });

  const allTrain = sorted.flatMap((r) => {
    if (!before(r.program.fetchedAt, r.cutoff)) return [];
    const order = topThree(r);
    return order ? [{ features: extractB13V2Features(r, { preCutoffExhibitionOnly: false }), order }] : [];
  });
  const allTrainPre = sorted.flatMap((r) => {
    if (!before(r.program.fetchedAt, r.cutoff)) return [];
    const order = topThree(r);
    return order ? [{ features: extractB13V2Features(r, { preCutoffExhibitionOnly: true }), order }] : [];
  });

  return {
    schemaVersion: B13V2_VERSION,
    kind: "reconstructed-shadow" as const,
    mainModel: "B13v2Pre" as const,
    virtualBankrollInitialYen: VIRTUAL_BANKROLL_INITIAL_YEN,
    config: B13V2_CONFIG,
    featureNames: B13V2_FEATURE_NAMES,
    noExFeatureNames: B13V2_NOEX_FEATURE_NAMES,
    missingness,
    totalRaces: sorted.length,
    models: finalizeModels(overall),
    frozenExploratoryModel: fitB13V2(allTrain),
    frozenExploratoryNoExModel: fitB13V2NoEx(allTrainPre),
    days,
  };
}
