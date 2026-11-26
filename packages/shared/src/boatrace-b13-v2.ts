// 研究専用（shadow only）: B13v2 — 特徴量付き Plackett–Luce モデル（コース別等級・枠別F・展示偏差・枠なり）。
// 既存v1の自動購入・既存B13（boatrace-b13.ts）は変更しない。実購入なし。
// JST日付単位の expanding window で学習し、標準化統計量も学習データ内のみで算出する。
import { BOATS, type BoatRecord } from "./boatrace";
import { decideB11, gradePoint, settleB11 } from "./boatrace-b11";
import { b13Distribution, fitB13, topThree } from "./boatrace-b13";

export const B13V2_VERSION = "b13-context-pl-shadow-v1" as const;
export const B13V2_CONFIG = {
  iterations: 350,
  step: 0.25,
  l2Intercept: 0.02,
  l2Feature: 0.1,
  stakePerTicket: 100,
  ticketCount: 2,
  innerSlope: [1.0, 0.4, 0.1, -0.4, -0.5, -0.6] as readonly number[],
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

export type B13V2ModelId = "B13v2" | "B13v2Pre" | "B13" | "FIXED123" | "B01" | "B02" | "B11";

export interface B13V2RaceFeatures {
  hasAllGrades: boolean;
  gradePoints: (number | null)[];
  innerDesc: boolean | null;
  b1MinusOthers: number | null;
  exhibitionSource: "freeze" | "exhibition" | null;
  exhibitionFetchedAt: string | null;
  exhibitionPreCutoff: boolean;
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
  weights: number[];
  norm: B13V2NormStats;
  trainingCount: number;
  namedWeights: Record<(typeof B13V2_FEATURE_NAMES)[number], number>;
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

  return {
    hasAllGrades,
    gradePoints,
    innerDesc,
    b1MinusOthers,
    exhibitionSource,
    exhibitionFetchedAt,
    exhibitionPreCutoff,
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

/** 6艇分の特徴量行列（6×24）を構築する。欠損項目は標準化中心 0（影響なし）として安全にフォールバック。 */
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
    v[i] = 1;
    v[6 + i] = gPoints[i] - gMean;
    v[12 + i] = feat.exhibitionF[i] === true ? 1 : 0;
    v[18] = feat.timeZ[i] ?? 0;
    v[19] = tStdC * slope;
    v[20] = stStdC * slope;
    v[21] = idC * slope;
    v[22] = i === 0 ? b1C : 0;
    v[23] = wakuC * slope;
    return v;
  });
}

export function fitB13V2(
  samples: readonly { features: B13V2RaceFeatures; order: readonly number[] }[],
): B13V2FittedModel | null {
  if (!samples.length) return null;
  for (const s of samples) {
    if (s.order.length !== 3 || new Set(s.order).size !== 3 || s.order.some((b) => !BOATS.some((n) => n === b))) {
      throw new Error("Invalid top-three training observation");
    }
  }
  const norm = computeNorm(samples.map((s) => s.features));
  const matrices = samples.map((s) => ({ x: buildBoatFeatureMatrix(s.features, norm), order: s.order }));
  const dim = B13V2_FEATURE_NAMES.length;
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

  const namedWeights = Object.fromEntries(
    B13V2_FEATURE_NAMES.map((name, i) => [name, w[i]]),
  ) as Record<(typeof B13V2_FEATURE_NAMES)[number], number>;

  return { weights: w, norm, trainingCount: n, namedWeights };
}

export function predictB13V2(model: B13V2FittedModel, features: B13V2RaceFeatures) {
  const x = buildBoatFeatureMatrix(features, model.norm);
  const scores = x.map((row) => row.reduce((sum, v, k) => sum + v * model.weights[k], 0));
  const distribution = b13Distribution(scores);
  return { scores, distribution };
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
  };
}
type Stats = ReturnType<typeof makeStats>;

function finishStats(s: Stats) {
  return {
    ...s,
    net: s.payout + s.refund - s.stake,
    roi: s.stake ? (s.payout + s.refund) / s.stake : null,
    hitRate: s.settled ? s.hits / s.settled : null,
    logLoss: s.logLossCount ? s.logLossSum / s.logLossCount : null,
  };
}

function recordOutcome(s: Stats, tickets: string[] | null, race: BoatRecord) {
  s.targets++;
  if (!tickets) { s.skipped++; return; }
  s.applied++;
  const outcome = settleB11(tickets, race.result);
  if (outcome.state === "pending") { s.pending++; return; }
  if (outcome.state === "excluded") { s.excluded++; return; }
  s.settled++;
  s.stake += outcome.stake;
  s.payout += outcome.payout;
  s.refund += outcome.refund;
  s.hits += Number(
    race.result!.status === "official" &&
      tickets.some(
        (t) =>
          !t.split("-").some((b) => race.result!.refundBoats.includes(Number(b))) &&
          (race.result!.payouts[t] ?? 0) > 0,
      ),
  );
}

const MODEL_IDS: B13V2ModelId[] = ["B13v2", "B13v2Pre", "B13", "FIXED123", "B01", "B02", "B11"];
const initModels = () => Object.fromEntries(MODEL_IDS.map((id) => [id, makeStats()])) as Record<B13V2ModelId, Stats>;
const finalizeModels = (m: Record<B13V2ModelId, Stats>) =>
  Object.fromEntries(MODEL_IDS.map((id) => [id, finishStats(m[id])])) as Record<B13V2ModelId, ReturnType<typeof finishStats>>;

/**
 * JST日付単位 expanding window による時系列比較評価（shadow only）。
 * - B13v2: 全展示データ利用（再構成研究）
 * - B13v2Pre: 締切前取得確認済みの展示データのみ利用（厳格リーク防止）
 * - B13: 既存の艇番のみ Plackett–Luce
 * - FIXED123: 固定 1-2-3 単点（100円）
 * - B01 (1-2-3 / 1-3-2), B02 (1-2-3 / 1-2-4), B11
 */
export function evaluateB13V2(races: readonly BoatRecord[]) {
  if (new Set(races.map((r) => r.id)).size !== races.length) {
    throw new Error("B13v2 requires deduplicated race IDs");
  }
  const sorted = [...races].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const dates = [...new Set(sorted.map((r) => r.date))];
  const overall = initModels();

  const missingness = {
    totalRaces: sorted.length,
    missingGrades: 0,
    missingExhibition: 0,
    preCutoffExhibition: 0,
    postCutoffExhibition: 0,
  };
  for (const r of sorted) {
    const f = extractB13V2Features(r, { preCutoffExhibitionOnly: false });
    if (!f.hasAllGrades) missingness.missingGrades++;
    if (f.exhibitionSource === null) missingness.missingExhibition++;
    else if (f.exhibitionPreCutoff) missingness.preCutoffExhibition++;
    else missingness.postCutoffExhibition++;
  }

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
    const b13Weights = fitB13(trainingRaw.map((t) => t.order));
    const b13Dist = b13Weights ? b13Distribution(b13Weights) : null;

    const dayStats = initModels();
    const targets = sorted.filter((r) => r.date === date);
    const rows = targets.map((race) => {
      const programOk = before(race.program.fetchedAt, race.cutoff);
      const status = !programOk ? "program-not-pre-cutoff" : !modelFull ? "no-prior-training" : "eligible";
      const fFull = extractB13V2Features(race, { preCutoffExhibitionOnly: false });
      const fPre = extractB13V2Features(race, { preCutoffExhibitionOnly: true });
      const predFull = status === "eligible" && modelFull ? predictB13V2(modelFull, fFull) : null;
      const predPre = status === "eligible" && modelPre ? predictB13V2(modelPre, fPre) : null;
      const b11 = decideB11(BOATS.map((b) => race.entries.find((e) => e.boat === b)?.grade_original ?? null));

      const tickets: Record<B13V2ModelId, string[] | null> =
        status === "eligible"
          ? {
              B13v2: predFull!.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B13v2Pre: predPre!.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              B13: b13Dist!.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
              FIXED123: ["1-2-3"],
              B01: ["1-2-3", "1-3-2"],
              B02: ["1-2-3", "1-2-4"],
              B11: b11.status === "bet" ? b11.tickets : null,
            }
          : { B13v2: null, B13v2Pre: null, B13: null, FIXED123: null, B01: null, B02: null, B11: null };

      for (const id of MODEL_IDS) {
        recordOutcome(dayStats[id], tickets[id], race);
        recordOutcome(overall[id], tickets[id], race);
      }

      const order = topThree(race);
      const actual = order?.join("-") ?? null;
      if (status === "eligible" && actual) {
        const addLoss = (id: "B13v2" | "B13v2Pre" | "B13", dist: { combination: string; probability: number }[] | null) => {
          const p = dist?.find((x) => x.combination === actual)?.probability;
          if (p !== undefined && p > 0) {
            const loss = -Math.log(p);
            dayStats[id].logLossSum += loss;
            dayStats[id].logLossCount++;
            overall[id].logLossSum += loss;
            overall[id].logLossCount++;
          }
        };
        addLoss("B13v2", predFull?.distribution ?? null);
        addLoss("B13v2Pre", predPre?.distribution ?? null);
        addLoss("B13", b13Dist);
      }

      return {
        raceId: race.id,
        venueName: race.venueName,
        number: race.number,
        cutoff: race.cutoff,
        status,
        actual,
        tickets,
        topProbs: predFull ? predFull.distribution.slice(0, 5) : null,
      };
    });

    return {
      date,
      asOf,
      trainingCount: trainingRaw.length,
      modelFull: modelFull ? { namedWeights: modelFull.namedWeights, norm: modelFull.norm } : null,
      modelPre: modelPre ? { namedWeights: modelPre.namedWeights, norm: modelPre.norm } : null,
      models: finalizeModels(dayStats),
      rows,
    };
  });

  // 全期間（探索用）で推定した最終係数スナップショット（前向き検証用のモデル定義）
  const allTrain = sorted.flatMap((r) => {
    if (!before(r.program.fetchedAt, r.cutoff)) return [];
    const order = topThree(r);
    return order ? [{ features: extractB13V2Features(r, { preCutoffExhibitionOnly: false }), order }] : [];
  });
  const frozenFullFit = fitB13V2(allTrain);

  return {
    schemaVersion: B13V2_VERSION,
    kind: "reconstructed-shadow" as const,
    config: B13V2_CONFIG,
    featureNames: B13V2_FEATURE_NAMES,
    missingness,
    totalRaces: sorted.length,
    models: finalizeModels(overall),
    frozenExploratoryModel: frozenFullFit,
    days,
  };
}
