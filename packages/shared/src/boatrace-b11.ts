// 研究専用: B11（固定仕様）× 6艇級別の母標準偏差による適用条件の検証。
// 既存v1の購入経路・台帳とは独立。実購入なし、各100円相当の仮想評価のみ。
// 閾値判定は丸め前の値を使うため、整数演算（D = 6Σx² − (Σx)² = 36σ²）で厳密に比較する。
import { BOATS, GRADES, type BoatRecord, type Grade } from "./boatrace";

export const B11_VERSION = "b11-sigma-research-v1";
export const B11_STAKE = 100;
export const GRADE_POINTS: Record<Grade, number> = { A1: 4, A2: 3, B1: 2, B2: 1 };
/** 軸モデルの枠補正（2〜6号艇）。10倍の整数で保持。 */
const LANE_BONUS_X10: Record<number, number> = { 2: 5, 3: 7, 4: 9, 5: 10, 6: 11 };

/** 並行比較する標準偏差の上限。null は制限なし（control）。 */
export const SIGMA_CAPS = [0.2, 0.3, 0.4, 0.5, 0.6, null] as const;
export type SigmaCap = (typeof SIGMA_CAPS)[number];
export const capKey = (cap: SigmaCap) => (cap === null ? "control" : `le${cap}`);
export const SIGMA_CLASSES = ["small", "normal", "large"] as const;
export type SigmaClass = (typeof SIGMA_CLASSES)[number];
export const SIGMA_CLASS_LABEL: Record<SigmaClass, string> = { small: "小", normal: "普通", large: "大" };

export type B11Branch = "axis" | "inner-outer" | "default";
export type B11SkipReason = "boat3-above-boat1" | "boat1-below-others-mean";

export interface GradeFeatures {
  /** 6艇すべてが有効な級別のときのみ数値。欠損・無効は null（0とは区別）。 */
  sigma: number | null;
  /** 36σ²（整数）。閾値判定用。 */
  variance36: number | null;
  mean: number | null;
  /** 1号艇 − 2〜6号艇平均 */
  boat1MinusOthers: number | null;
  /** 内（1〜3号艇平均）− 外（4〜6号艇平均） */
  innerMinusOuter: number | null;
  points: (number | null)[];
  missingBoats: number[];
}

export type B11Decision =
  | { status: "unjudged"; reason: "missing-grade" }
  | { status: "skip"; reason: B11SkipReason }
  | { status: "bet"; branch: B11Branch; tickets: string[] };

export type ThresholdStatus = "applied" | "model-skip" | "outside-threshold" | "unjudged";
export interface ThresholdJudgement { cap: SigmaCap; status: ThresholdStatus }

export interface B11Evaluation {
  version: typeof B11_VERSION;
  features: GradeFeatures;
  sigmaClass: SigmaClass | null;
  b11: B11Decision;
  thresholds: ThresholdJudgement[];
}

export function gradePoint(grade: unknown): number | null {
  return typeof grade === "string" && (GRADES as readonly string[]).includes(grade)
    ? GRADE_POINTS[grade as Grade] : null;
}

export function gradeFeatures(grades: readonly unknown[]): GradeFeatures {
  const points = BOATS.map((_, i) => gradePoint(grades[i]));
  const missingBoats = BOATS.filter((_, i) => points[i] === null);
  if (grades.length !== 6 || missingBoats.length) {
    return { sigma: null, variance36: null, mean: null, boat1MinusOthers: null, innerMinusOuter: null, points, missingBoats };
  }
  const p = points as number[];
  const sum = p.reduce((a, b) => a + b, 0);
  const variance36 = 6 * p.reduce((a, b) => a + b * b, 0) - sum * sum;
  return {
    sigma: Math.sqrt(variance36) / 6, variance36, mean: sum / 6,
    boat1MinusOthers: p[0] - (sum - p[0]) / 5,
    innerMinusOuter: (p[0] + p[1] + p[2]) / 3 - (p[3] + p[4] + p[5]) / 3,
    points, missingBoats,
  };
}

/** 小 σ<=0.5 / 普通 0.5<σ<1 / 大 σ>=1。 */
export function classifySigma(features: GradeFeatures): SigmaClass | null {
  const d = features.variance36;
  if (d === null) return null;
  if (d <= 9) return "small";
  return d < 36 ? "normal" : "large";
}

function withinCap(variance36: number, cap: SigmaCap) {
  if (cap === null) return true;
  const hundredths = Math.round(cap * 100); // σ<=cap ⇔ D*10000 <= 36*(cap*100)^2
  return variance36 * 10000 <= 36 * hundredths * hundredths;
}

/** B11の固定仕様。展示F・オッズ補正は使わない。 */
export function decideB11(grades: readonly unknown[]): B11Decision {
  const points = BOATS.map((_, i) => gradePoint(grades[i]));
  if (grades.length !== 6 || points.some((x) => x === null)) return { status: "unjudged", reason: "missing-grade" };
  const [p1, p2, p3, p4, p5, p6] = points as number[];
  if (p3 > p1) return { status: "skip", reason: "boat3-above-boat1" };
  const sum123 = p1 + p2 + p3;
  // max(5,6) − m >= 2, m = sum123/3
  if (3 * Math.max(p5, p6) - sum123 >= 6) {
    if (5 * p1 < p2 + p3 + p4 + p5 + p6) return { status: "skip", reason: "boat1-below-others-mean" };
    const ranked = [2, 3, 4, 5, 6]
      .map((boat) => ({ boat, score: (points[boat - 1] as number) * 10 + LANE_BONUS_X10[boat] }))
      .sort((a, b) => b.score - a.score || a.boat - b.boat);
    const [a, b, c] = ranked;
    return { status: "bet", branch: "axis", tickets: [`1-${a.boat}-${b.boat}`, `1-${a.boat}-${c.boat}`] };
  }
  if (sum123 - 3 * p4 >= 6) return { status: "bet", branch: "inner-outer", tickets: ["1-2-3", "1-3-2"] };
  return { status: "bet", branch: "default", tickets: ["1-2-3", "1-2-4"] };
}

export function evaluateB11(grades: readonly unknown[]): B11Evaluation {
  const features = gradeFeatures(grades);
  const b11 = decideB11(grades);
  const thresholds = SIGMA_CAPS.map((cap): ThresholdJudgement => ({
    cap,
    status: features.variance36 === null ? "unjudged"
      : !withinCap(features.variance36, cap) ? "outside-threshold"
      : b11.status === "bet" ? "applied" : "model-skip",
  }));
  return { version: B11_VERSION, features, sigmaClass: classifySigma(features), b11, thresholds };
}

/** 発走前に凍結して保存する研究レコード。 */
export interface B11ResearchRecord {
  raceId: string;
  date: string;
  /** forward=発走前凍結 / reconstructed=過去データからの再構成（事後計算） */
  kind: "forward" | "reconstructed";
  frozenAt: string | null;
  cutoff: string | null;
  source: { url: string; fetchedAt: string } | null;
  evaluation: B11Evaluation;
}

export const gradesOf = (race: Pick<BoatRecord, "entries">) =>
  BOATS.map((boat) => race.entries.find((entry) => entry.boat === boat)?.grade_original ?? null);

// ---------- 仮想精算 ----------
export type B11Settlement =
  | { state: "pending"; reason: string }
  | { state: "excluded"; reason: string }
  | { state: "settled"; stake: number; payout: number; refund: number; hit: boolean; maxPayout: number };

export function settleB11(tickets: string[], result: BoatRecord["result"] | undefined): B11Settlement {
  if (!result) return { state: "pending", reason: "公式結果が未確定" };
  if (result.status === "official" && !Object.keys(result.payouts).length && !result.special)
    return { state: "excluded", reason: "公式払戻が未取得" };
  let payout = 0, refund = 0, maxPayout = 0;
  for (const ticket of tickets) {
    const refunded = result.status === "void" ||
      ticket.split("-").some((boat) => result.refundBoats.includes(Number(boat)));
    if (refunded) { refund += B11_STAKE; continue; }
    const paid = (result.payouts[ticket] ?? 0) +
      (result.special && !result.special.winning.includes(ticket) ? result.special.per100 : 0);
    payout += paid;
    maxPayout = Math.max(maxPayout, paid);
  }
  const stake = tickets.length * B11_STAKE;
  return { state: "settled", stake, payout, refund, hit: payout > 0, maxPayout };
}

// ---------- 集計 ----------
export interface B11ResearchItem {
  record: B11ResearchRecord;
  venueName?: string;
  cutoff: string | null;
  result?: BoatRecord["result"];
}

export interface B11Stats {
  targets: number;
  applied: number;
  modelSkip: number;
  outside: number;
  unjudged: number;
  settled: number;
  pending: number;
  excluded: number;
  excludedReasons: Record<string, number>;
  hits: number;
  hitRate: number | null;
  stake: number;
  payout: number;
  refund: number;
  net: number;
  roi: number | null;
  maxLosingStreak: number;
  /** 最大単一払戻が総払戻に占める割合（高額払戻依存の目安） */
  topPayoutShare: number | null;
  smallSample: boolean;
  days: { date: string; applied: number; settled: number; hits: number; stake: number; payout: number; refund: number; net: number }[];
}

export const SMALL_SAMPLE = 30;

function summarizeScope(items: { item: B11ResearchItem; status: ThresholdStatus; tickets: string[] }[]): B11Stats {
  const stats: B11Stats = {
    targets: items.length, applied: 0, modelSkip: 0, outside: 0, unjudged: 0, settled: 0, pending: 0, excluded: 0,
    excludedReasons: {}, hits: 0, hitRate: null, stake: 0, payout: 0, refund: 0, net: 0, roi: null,
    maxLosingStreak: 0, topPayoutShare: null, smallSample: true, days: [],
  };
  const days = new Map<string, B11Stats["days"][number]>();
  let streak = 0, topPayout = 0, eligible = 0;
  const ordered = [...items].sort((a, b) => (a.item.cutoff ?? "").localeCompare(b.item.cutoff ?? "") ||
    a.item.record.raceId.localeCompare(b.item.record.raceId));
  for (const { item, status, tickets } of ordered) {
    if (status === "unjudged") { stats.unjudged++; continue; }
    if (status === "outside-threshold") { stats.outside++; continue; }
    if (status === "model-skip") { stats.modelSkip++; continue; }
    stats.applied++;
    const date = item.record.date;
    const day = days.get(date) ?? { date, applied: 0, settled: 0, hits: 0, stake: 0, payout: 0, refund: 0, net: 0 };
    day.applied++;
    days.set(date, day);
    const settlement = settleB11(tickets, item.result);
    if (settlement.state === "pending") { stats.pending++; continue; }
    if (settlement.state === "excluded") {
      stats.excluded++;
      stats.excludedReasons[settlement.reason] = (stats.excludedReasons[settlement.reason] ?? 0) + 1;
      continue;
    }
    stats.settled++;
    stats.stake += settlement.stake; stats.payout += settlement.payout; stats.refund += settlement.refund;
    day.settled++; day.stake += settlement.stake; day.payout += settlement.payout; day.refund += settlement.refund;
    day.net += settlement.payout + settlement.refund - settlement.stake;
    topPayout = Math.max(topPayout, settlement.maxPayout);
    if (settlement.refund < settlement.stake) {
      eligible++;
      if (settlement.hit) { stats.hits++; day.hits++; streak = 0; }
      else { streak++; stats.maxLosingStreak = Math.max(stats.maxLosingStreak, streak); }
    }
  }
  stats.net = stats.payout + stats.refund - stats.stake;
  stats.roi = stats.stake ? (stats.payout + stats.refund) / stats.stake : null;
  stats.hitRate = eligible ? stats.hits / eligible : null;
  stats.topPayoutShare = stats.payout ? topPayout / stats.payout : null;
  stats.smallSample = stats.settled < SMALL_SAMPLE;
  stats.days = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return stats;
}

export interface B11Summary {
  kind: B11ResearchRecord["kind"];
  total: number;
  byCap: { key: string; cap: SigmaCap; stats: B11Stats }[];
  byClass: { sigmaClass: SigmaClass; stats: B11Stats }[];
  note: string;
}

/** 同一kindのレコードだけを集計する。forward と reconstructed は混ぜない。閾値比較は重複標本。 */
export function summarizeB11(items: B11ResearchItem[], kind: B11ResearchRecord["kind"]): B11Summary {
  const own = items.filter((item) => item.record.kind === kind);
  const tickets = (item: B11ResearchItem) => {
    const b11 = item.record.evaluation.b11;
    return b11.status === "bet" ? b11.tickets : [];
  };
  const byCap = SIGMA_CAPS.map((cap) => ({
    key: capKey(cap), cap,
    stats: summarizeScope(own.map((item) => ({
      item, tickets: tickets(item),
      status: item.record.evaluation.thresholds.find((t) => t.cap === cap)?.status ?? "unjudged",
    }))),
  }));
  const byClass = SIGMA_CLASSES.map((sigmaClass) => ({
    sigmaClass,
    stats: summarizeScope(own.map((item) => {
      const evaluation = item.record.evaluation;
      const status: ThresholdStatus = evaluation.sigmaClass === null ? "unjudged"
        : evaluation.sigmaClass !== sigmaClass ? "outside-threshold"
        : evaluation.b11.status === "bet" ? "applied" : "model-skip";
      return { item, tickets: tickets(item), status };
    })),
  }));
  return {
    kind, total: own.length, byCap, byClass,
    note: "閾値間は同一レースを含む重複標本で独立ではない。少数標本・高額払戻への依存に注意。実資金移動なし。",
  };
}

export function reconstructB11(race: BoatRecord): B11ResearchRecord {
  return {
    raceId: race.id, date: race.date, kind: "reconstructed", frozenAt: null, cutoff: race.cutoff,
    source: race.program, evaluation: evaluateB11(gradesOf(race)),
  };
}

export function freezeB11(race: BoatRecord, now: Date): B11ResearchRecord | null {
  const cutoff = race.cutoff ? Date.parse(race.cutoff) : NaN;
  const fetched = Date.parse(race.program.fetchedAt);
  if (!Number.isFinite(cutoff) || now.getTime() >= cutoff || !Number.isFinite(fetched) || fetched > now.getTime()) return null;
  return {
    raceId: race.id, date: race.date, kind: "forward", frozenAt: now.toISOString(), cutoff: race.cutoff,
    source: race.program, evaluation: evaluateB11(gradesOf(race)),
  };
}
