// 研究専用（shadow only）: B01モデル（三連単 1-2-3 / 1-3-2 各100円、1R=200円）の収益性・再現性検証モジュール。
// 既存B01・B13・B13v2・固定済み前向き検証プロトコルには一切触れず、独立した研究・比較・仮説検証を行う。
import { BOATS, type BoatRecord, type BoatResult, type Grade } from "./boatrace";
import { gradeFeatures, settleB11 } from "./boatrace-b11";
import { b13Distribution, fitB13, topThree } from "./boatrace-b13";
import {
  B13V2_CONFIG,
  extractB13V2Features,
  fitB13V2,
  fitB13V2NoEx,
  predictB13V2,
  scoreDistribution,
  VIRTUAL_BANKROLL_INITIAL_YEN,
} from "./boatrace-b13-v2";

export const B01_STUDY_VERSION = "b01-profitability-study-v1" as const;
export const B01_TICKETS = ["1-2-3", "1-3-2"] as const;
export const B02_TICKETS = ["1-2-3", "1-2-4"] as const;
export const B01_STAKE_PER_TICKET = 100 as const;
export const B01_STAKE_PER_RACE = 200 as const;

export interface B01RacelistEntry {
  boat: number;
  name: string;
  grade: Grade | null;
  nationalWinRate: number | null;
  localWinRate: number | null;
  motor2Rate: number | null;
  avgSt: number | null;
}

export interface B01BeforeInfoEntry {
  boat: number;
  course: number | null;
  st: string | null;
  flying: boolean | null;
}

export interface B01RaceInput {
  id: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  entries: B01RacelistEntry[];
  exhibition: {
    entries: B01BeforeInfoEntry[];
    times: Partial<Record<number, number>>;
    fetchedAt: string | null;
    preCutoff: boolean | null;
  } | null;
  result: BoatResult | null;
  sources: string[];
  /** アーカイブ／SQLite由来でB13v2等との直接互換用（任意） */
  boatRecord?: BoatRecord;
}

export type TimeSlot = "morning" | "day" | "evening" | "night" | "unknown";

export interface B01RaceFeatures {
  timeSlot: TimeSlot;
  cutoffHourJst: number | null;
  // 級別
  hasAllGrades: boolean;
  grade1: Grade | null;
  gradePoints: (number | null)[];
  gradeSigma: number | null;
  gradeSigmaClass: "small" | "normal" | "large" | null;
  gradeInnerDesc: boolean | null; // 1>=2>=3
  gradeGate1Ge3: boolean | null; // 1>=3
  gradeB1Gt2: boolean | null; // 1>2
  gradeB2Ge3: boolean | null; // 2>=3
  gradeInnerMinusOuter: number | null;
  gradeB1MinusOthers: number | null;
  gradeInnerPattern: string | null; // e.g. "A1-A2-B1"
  // 実質能力差
  winRate1: number | null;
  winRateDiffOthers: number | null; // w1 - mean(w2..6)
  winRateDiffMax23: number | null; // w1 - max(w2, w3)
  winRatePair23: string | null; // "00" | "10" | "01" | "11" (2/3が1を上回るか)
  localWinRateDiffMax23: number | null;
  avgSt1: number | null;
  avgStDiffMin23: number | null; // avgSt1 - min(avgSt2, avgSt3) (負ほど1号艇が速い)
  avgStDiffOthers: number | null;
  // モーター性能
  motor2_1: number | null;
  motor2DiffOthers: number | null;
  motor2DiffMax23: number | null;
  // 展示情報
  hasCompleteExTime: boolean;
  exTimeStd: number | null;
  exTimeZ1: number | null;
  exTimeDiffMin23: number | null; // t1 - min(t2, t3) (負ほど1号艇が速い)
  exStStdSigned: number | null;
  exStStdNoF: number | null;
  hasCompleteExCourse: boolean;
  exOrder: string | null;
  exWakunari: boolean | null;
  exInnerWakunari: boolean | null; // 展示進入の1-3コースが1,2,3号艇
  exCourse1: number | null;
  exFlyingCount: number | null;
  exFlying1: boolean | null;
  exFlying2: boolean | null;
  exFlying3: boolean | null;
  exFlyingOuter: boolean | null; // 4-6号艇にFあり
  // 実進入（事後分析用）
  actualOrder: string | null;
  actualWakunari: boolean | null;
}

export interface B01RaceOutcome {
  race: B01RaceInput;
  features: B01RaceFeatures;
  state: "settled" | "pending" | "excluded";
  stake: number;
  payout: number;
  refund: number;
  net: number;
  hit: boolean;
  hitTicket: "1-2-3" | "1-3-2" | null;
  actualTop3: string | null;
  boat1Finish: number | null;
  isFullRefund: boolean;
  isVoid: boolean;
}

export interface PayoutBucketRow {
  label: string;
  count: number;
  payoutSum: number;
  roiContribution: number;
}

export interface TicketBreakdownRow {
  ticket: string;
  hits: number;
  hitRate: number | null;
  payoutSum: number;
  meanPayout: number | null;
  medianPayout: number | null;
  maxPayout: number;
  roiContribution: number;
}

export interface PerformanceMetrics {
  settled: number;
  hits: number;
  hitRate: number | null;
  stake: number;
  payout: number;
  refund: number;
  net: number;
  balanceEnd: number;
  roi: number | null;
  maxDrawdown: number;
  maxLosingStreak: number;
  maxLosingStreakExclRefund: number;
  roiCi95Bootstrap: [number | null, number | null];
  roiCi95Cluster: [number | null, number | null];
  roiCi95Normal: [number | null, number | null];
  trimmedRoi: {
    exclTop1: number | null;
    exclTop3: number | null;
    exclTop5: number | null;
    exclTop10: number | null;
  };
  topPayouts: { raceId: string; date: string; venueName: string; number: number; ticket: string | null; payout: number }[];
  payoutBuckets: PayoutBucketRow[];
  ticketBreakdown: TicketBreakdownRow[];
}

// 決定論的 PRNG (Mulberry32)
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCutoffHourJst(cutoff: string | null): number | null {
  if (!cutoff) return null;
  const ms = Date.parse(cutoff);
  if (!Number.isFinite(ms)) return null;
  const jst = new Date(ms + 9 * 3600 * 1000);
  return jst.getUTCHours() + jst.getUTCMinutes() / 60;
}

export function classifyTimeSlot(cutoff: string | null): { slot: TimeSlot; hour: number | null } {
  const hour = parseCutoffHourJst(cutoff);
  if (hour === null) return { slot: "unknown", hour: null };
  if (hour < 12) return { slot: "morning", hour };
  if (hour < 15) return { slot: "day", hour };
  if (hour < 18) return { slot: "evening", hour };
  return { slot: "night", hour };
}

function parseExSt(st: string | null, flying: boolean | null): { signed: number | null; noF: number | null; isF: boolean | null } {
  if (st === null || st === undefined) return { signed: null, noF: null, isF: null };
  const s = st.trim();
  if (!s || s === "-") return { signed: null, noF: null, isF: null };
  if (s.startsWith("L")) return { signed: null, noF: null, isF: false };
  if (s.startsWith("F")) {
    const val = Number(s.slice(1));
    if (!Number.isFinite(val)) return { signed: null, noF: null, isF: true };
    return { signed: -val, noF: null, isF: true };
  }
  const val = Number(s);
  if (!Number.isFinite(val)) return { signed: null, noF: null, isF: null };
  const isF = flying === true;
  return { signed: isF ? -val : val, noF: isF ? null : val, isF };
}

function buildOrderString(pairs: { boat: number; course: number | null }[]): string | null {
  if (pairs.length !== 6) return null;
  const byCourse = new Array<number>(6).fill(0);
  const seen = new Set<number>();
  for (const p of pairs) {
    if (p.course === null || !Number.isInteger(p.course) || p.course < 1 || p.course > 6) return null;
    if (seen.has(p.boat) || byCourse[p.course - 1] !== 0) return null;
    seen.add(p.boat);
    byCourse[p.course - 1] = p.boat;
  }
  return byCourse.join("");
}

function popStd(values: number[]): number {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

export function extractB01RaceFeatures(race: B01RaceInput): B01RaceFeatures {
  const { slot: timeSlot, hour: cutoffHourJst } = classifyTimeSlot(race.cutoff);
  const byBoat = new Map(race.entries.map((e) => [e.boat, e]));
  const grades = BOATS.map((b) => byBoat.get(b)?.grade ?? null);
  const gf = gradeFeatures(grades);
  const hasAllGrades = gf.sigma !== null;
  const gp = gf.points;
  const gradeSigmaClass =
    gf.variance36 === null ? null : gf.variance36 <= 9 ? "small" : gf.variance36 < 36 ? "normal" : "large";

  const gradeInnerDesc = hasAllGrades ? gp[0]! >= gp[1]! && gp[1]! >= gp[2]! : null;
  const gradeGate1Ge3 = hasAllGrades ? gp[0]! >= gp[2]! : null;
  const gradeB1Gt2 = hasAllGrades ? gp[0]! > gp[1]! : null;
  const gradeB2Ge3 = hasAllGrades ? gp[1]! >= gp[2]! : null;
  const gradeInnerPattern =
    grades[0] && grades[1] && grades[2] ? `${grades[0]}-${grades[1]}-${grades[2]}` : null;

  const winRates = BOATS.map((b) => byBoat.get(b)?.nationalWinRate ?? null);
  const hasAllWinRates = winRates.every((v): v is number => v !== null && Number.isFinite(v));
  const winRate1 = winRates[0];
  const winRateDiffOthers = hasAllWinRates
    ? winRates[0]! - (winRates[1]! + winRates[2]! + winRates[3]! + winRates[4]! + winRates[5]!) / 5
    : null;
  const winRateDiffMax23 =
    winRates[0] !== null && winRates[1] !== null && winRates[2] !== null
      ? winRates[0]! - Math.max(winRates[1]!, winRates[2]!)
      : null;
  const winRatePair23 =
    winRates[0] !== null && winRates[1] !== null && winRates[2] !== null
      ? `${Number(winRates[1]! > winRates[0]!)}${Number(winRates[2]! > winRates[0]!)}`
      : null;

  const localWinRates = BOATS.map((b) => byBoat.get(b)?.localWinRate ?? null);
  const localWinRateDiffMax23 =
    localWinRates[0] !== null && localWinRates[1] !== null && localWinRates[2] !== null
      ? localWinRates[0]! - Math.max(localWinRates[1]!, localWinRates[2]!)
      : null;

  const avgSts = BOATS.map((b) => byBoat.get(b)?.avgSt ?? null);
  const hasAllAvgSt = avgSts.every((v): v is number => v !== null && Number.isFinite(v));
  const avgSt1 = avgSts[0];
  const avgStDiffMin23 =
    avgSts[0] !== null && avgSts[1] !== null && avgSts[2] !== null
      ? avgSts[0]! - Math.min(avgSts[1]!, avgSts[2]!)
      : null;
  const avgStDiffOthers = hasAllAvgSt
    ? avgSts[0]! - (avgSts[1]! + avgSts[2]! + avgSts[3]! + avgSts[4]! + avgSts[5]!) / 5
    : null;

  const motor2s = BOATS.map((b) => byBoat.get(b)?.motor2Rate ?? null);
  const hasAllMotor2 = motor2s.every((v): v is number => v !== null && Number.isFinite(v));
  const motor2_1 = motor2s[0];
  const motor2DiffOthers = hasAllMotor2
    ? motor2s[0]! - (motor2s[1]! + motor2s[2]! + motor2s[3]! + motor2s[4]! + motor2s[5]!) / 5
    : null;
  const motor2DiffMax23 =
    motor2s[0] !== null && motor2s[1] !== null && motor2s[2] !== null
      ? motor2s[0]! - Math.max(motor2s[1]!, motor2s[2]!)
      : null;

  // Exhibition
  let hasCompleteExTime = false;
  let exTimeStd: number | null = null;
  let exTimeZ1: number | null = null;
  let exTimeDiffMin23: number | null = null;
  let exStStdSigned: number | null = null;
  let exStStdNoF: number | null = null;
  let hasCompleteExCourse = false;
  let exOrder: string | null = null;
  let exWakunari: boolean | null = null;
  let exInnerWakunari: boolean | null = null;
  let exCourse1: number | null = null;
  let exFlyingCount: number | null = null;
  let exFlying1: boolean | null = null;
  let exFlying2: boolean | null = null;
  let exFlying3: boolean | null = null;
  let exFlyingOuter: boolean | null = null;

  if (race.exhibition) {
    const times = BOATS.map((b) => race.exhibition!.times[b] ?? NaN);
    if (times.every(Number.isFinite)) {
      hasCompleteExTime = true;
      const meanT = times.reduce((a, b) => a + b, 0) / 6;
      exTimeStd = popStd(times);
      exTimeZ1 = exTimeStd > 1e-9 ? (times[0] - meanT) / exTimeStd : 0;
      exTimeDiffMin23 = times[0] - Math.min(times[1], times[2]);
    }

    const exByBoat = new Map(race.exhibition.entries.map((e) => [e.boat, e]));
    exOrder = buildOrderString(BOATS.map((b) => ({ boat: b, course: exByBoat.get(b)?.course ?? null })));
    if (exOrder !== null) {
      hasCompleteExCourse = true;
      exWakunari = exOrder === "123456";
      exInnerWakunari = exOrder.startsWith("123");
      exCourse1 = exByBoat.get(1)?.course ?? null;
    }

    const parsedSts = BOATS.map((b) => {
      const e = exByBoat.get(b);
      return parseExSt(e?.st ?? null, e?.flying ?? null);
    });
    if (parsedSts.every((p) => p.signed !== null)) {
      exStStdSigned = popStd(parsedSts.map((p) => p.signed!));
    }
    if (parsedSts.every((p) => p.noF !== null)) {
      exStStdNoF = popStd(parsedSts.map((p) => p.noF!));
    }
    if (parsedSts.every((p) => p.isF !== null)) {
      const fs = parsedSts.map((p) => p.isF!);
      exFlyingCount = fs.filter(Boolean).length;
      exFlying1 = fs[0];
      exFlying2 = fs[1];
      exFlying3 = fs[2];
      exFlyingOuter = fs[3] || fs[4] || fs[5];
    }
  }

  let actualOrder: string | null = null;
  if (race.result?.courses?.length) {
    actualOrder = buildOrderString(race.result.courses.map((c) => ({ boat: c.boat, course: c.course })));
  }
  const actualWakunari = actualOrder === null ? null : actualOrder === "123456";

  return {
    timeSlot,
    cutoffHourJst,
    hasAllGrades,
    grade1: grades[0],
    gradePoints: gp,
    gradeSigma: gf.sigma,
    gradeSigmaClass,
    gradeInnerDesc,
    gradeGate1Ge3,
    gradeB1Gt2,
    gradeB2Ge3,
    gradeInnerMinusOuter: gf.innerMinusOuter,
    gradeB1MinusOthers: gf.boat1MinusOthers,
    gradeInnerPattern,
    winRate1,
    winRateDiffOthers,
    winRateDiffMax23,
    winRatePair23,
    localWinRateDiffMax23,
    avgSt1,
    avgStDiffMin23,
    avgStDiffOthers,
    motor2_1,
    motor2DiffOthers,
    motor2DiffMax23,
    hasCompleteExTime,
    exTimeStd,
    exTimeZ1,
    exTimeDiffMin23,
    exStStdSigned,
    exStStdNoF,
    hasCompleteExCourse,
    exOrder,
    exWakunari,
    exInnerWakunari,
    exCourse1,
    exFlyingCount,
    exFlying1,
    exFlying2,
    exFlying3,
    exFlyingOuter,
    actualOrder,
    actualWakunari,
  };
}

export function extractTop3FromResult(result: BoatResult | null): string | null {
  if (!result || result.status !== "official") return null;
  const ranks = ["1", "2", "3"].map((p) => result.finishes.filter((f) => f.position === p));
  if (ranks.some((r) => r.length !== 1)) return null;
  const order = ranks.map((r) => r[0].boat);
  if (new Set(order).size !== 3) return null;
  return order.join("-");
}

export function evaluateB01Race(race: B01RaceInput): B01RaceOutcome {
  const features = extractB01RaceFeatures(race);
  const settlement = settleB11([...B01_TICKETS], race.result ?? undefined);
  const actualTop3 = extractTop3FromResult(race.result);
  const b1FinishRaw = race.result?.finishes.find((f) => f.boat === 1)?.position ?? null;
  const boat1Finish = b1FinishRaw && /^[1-6]$/.test(b1FinishRaw) ? Number(b1FinishRaw) : null;

  if (settlement.state !== "settled") {
    return {
      race,
      features,
      state: settlement.state,
      stake: 0,
      payout: 0,
      refund: 0,
      net: 0,
      hit: false,
      hitTicket: null,
      actualTop3,
      boat1Finish,
      isFullRefund: false,
      isVoid: race.result?.status === "void",
    };
  }

  let hitTicket: "1-2-3" | "1-3-2" | null = null;
  if (settlement.hit && race.result) {
    for (const t of B01_TICKETS) {
      const refunded = race.result.status === "void" || t.split("-").some((b) => race.result!.refundBoats.includes(Number(b)));
      if (!refunded && (race.result.payouts[t] ?? 0) > 0) {
        hitTicket = t;
        break;
      }
    }
  }

  return {
    race,
    features,
    state: "settled",
    stake: settlement.stake,
    payout: settlement.payout,
    refund: settlement.refund,
    net: settlement.payout + settlement.refund - settlement.stake,
    hit: settlement.hit,
    hitTicket,
    actualTop3,
    boat1Finish,
    isFullRefund: settlement.refund === settlement.stake && settlement.stake > 0,
    isVoid: race.result?.status === "void",
  };
}

export interface SimpleBetRow {
  raceId: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  stake: number;
  payout: number;
  refund: number;
  hit: boolean;
  hitTicket: string | null;
  isFullRefund?: boolean;
}

export function computePerformanceMetrics(
  rows: readonly SimpleBetRow[],
  options: { bootstrapReps?: number; seed?: number; ticketLabels?: readonly string[] } = {},
): PerformanceMetrics {
  const reps = options.bootstrapReps ?? 2000;
  const seed = options.seed ?? 20261128;
  const n = rows.length;
  let hits = 0;
  let stake = 0;
  let payout = 0;
  let refund = 0;
  let cumNet = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let curStreak = 0;
  let maxLosingStreak = 0;
  let curStreakExcl = 0;
  let maxLosingStreakExclRefund = 0;

  for (const r of rows) {
    stake += r.stake;
    payout += r.payout;
    refund += r.refund;
    if (r.hit) {
      hits++;
      curStreak = 0;
      curStreakExcl = 0;
    } else {
      curStreak++;
      if (curStreak > maxLosingStreak) maxLosingStreak = curStreak;
      const isFullRefund = r.isFullRefund ?? (r.refund === r.stake && r.stake > 0);
      if (!isFullRefund) {
        curStreakExcl++;
        if (curStreakExcl > maxLosingStreakExclRefund) maxLosingStreakExclRefund = curStreakExcl;
      }
    }
    cumNet += r.payout + r.refund - r.stake;
    if (cumNet > peak) peak = cumNet;
    const dd = peak - cumNet;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const net = payout + refund - stake;
  const roi = stake > 0 ? (payout + refund) / stake : null;
  const hitRate = n > 0 ? hits / n : null;

  // Normal approximation 95% CI for ROI (ratio of return_i / stake_i assuming uniform stake or delta method)
  let roiCi95Normal: [number | null, number | null] = [null, null];
  if (n >= 2 && stake > 0) {
    const returns = rows.map((r) => (r.stake > 0 ? (r.payout + r.refund) / r.stake : 0));
    const meanR = returns.reduce((a, b) => a + b, 0) / n;
    const varR = returns.reduce((s, v) => s + (v - meanR) ** 2, 0) / (n - 1);
    const se = Math.sqrt(varR / n);
    roiCi95Normal = [Math.max(0, meanR - 1.96 * se), meanR + 1.96 * se];
  }

  // Race-level bootstrap 95% CI
  let roiCi95Bootstrap: [number | null, number | null] = [null, null];
  if (n >= 2 && stake > 0 && reps > 0) {
    const rng = mulberry32(seed);
    const samples: number[] = [];
    for (let b = 0; b < reps; b++) {
      let sSum = 0;
      let rSum = 0;
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(rng() * n);
        const row = rows[idx];
        sSum += row.stake;
        rSum += row.payout + row.refund;
      }
      if (sSum > 0) samples.push(rSum / sSum);
    }
    samples.sort((a, b) => a - b);
    roiCi95Bootstrap = [
      samples[Math.floor(samples.length * 0.025)] ?? null,
      samples[Math.floor(samples.length * 0.975)] ?? null,
    ];
  }

  // Date×Venue cluster bootstrap 95% CI
  let roiCi95Cluster: [number | null, number | null] = [null, null];
  const clusterMap = new Map<string, { stake: number; ret: number }>();
  for (const r of rows) {
    const key = `${r.date}|${r.venue}`;
    const cur = clusterMap.get(key) ?? { stake: 0, ret: 0 };
    cur.stake += r.stake;
    cur.ret += r.payout + r.refund;
    clusterMap.set(key, cur);
  }
  const clusters = [...clusterMap.values()];
  if (clusters.length >= 2 && stake > 0 && reps > 0) {
    const rng = mulberry32(seed + 1337);
    const samples: number[] = [];
    const cLen = clusters.length;
    for (let b = 0; b < reps; b++) {
      let sSum = 0;
      let rSum = 0;
      for (let i = 0; i < cLen; i++) {
        const c = clusters[Math.floor(rng() * cLen)];
        sSum += c.stake;
        rSum += c.ret;
      }
      if (sSum > 0) samples.push(rSum / sSum);
    }
    samples.sort((a, b) => a - b);
    roiCi95Cluster = [
      samples[Math.floor(samples.length * 0.025)] ?? null,
      samples[Math.floor(samples.length * 0.975)] ?? null,
    ];
  }

  // Trimmed ROI (removing top k payouts)
  const hitRowsSorted = [...rows].filter((r) => r.payout > 0).sort((a, b) => b.payout - a.payout);
  const trim = (k: number): number | null => {
    if (stake <= 0) return null;
    const removed = hitRowsSorted.slice(0, k).reduce((s, r) => s + r.payout, 0);
    return (payout + refund - removed) / stake;
  };
  const topPayouts = hitRowsSorted.slice(0, 10).map((r) => ({
    raceId: r.raceId,
    date: r.date,
    venueName: r.venueName,
    number: r.number,
    ticket: r.hitTicket,
    payout: r.payout,
  }));

  // Payout buckets
  const bucketDefs: { label: string; min: number; max: number }[] = [
    { label: "<=1000", min: 1, max: 1000 },
    { label: "1001-2000", min: 1001, max: 2000 },
    { label: "2001-5000", min: 2001, max: 5000 },
    { label: "5001-10000", min: 5001, max: 10000 },
    { label: ">10000", min: 10001, max: Infinity },
  ];
  const payoutBuckets: PayoutBucketRow[] = bucketDefs.map((bd) => {
    const matched = hitRowsSorted.filter((r) => r.payout >= bd.min && r.payout <= bd.max);
    const pSum = matched.reduce((s, r) => s + r.payout, 0);
    return {
      label: bd.label,
      count: matched.length,
      payoutSum: pSum,
      roiContribution: stake > 0 ? pSum / stake : 0,
    };
  });

  // Ticket breakdown
  const ticketLabels = options.ticketLabels ?? [...B01_TICKETS];
  const ticketBreakdown: TicketBreakdownRow[] = ticketLabels.map((t) => {
    const matched = hitRowsSorted.filter((r) => r.hitTicket === t);
    const pays = matched.map((r) => r.payout).sort((a, b) => a - b);
    const pSum = pays.reduce((a, b) => a + b, 0);
    const median =
      pays.length === 0
        ? null
        : pays.length % 2 === 1
          ? pays[(pays.length - 1) / 2]
          : (pays[pays.length / 2 - 1] + pays[pays.length / 2]) / 2;
    return {
      ticket: t,
      hits: matched.length,
      hitRate: n > 0 ? matched.length / n : null,
      payoutSum: pSum,
      meanPayout: matched.length > 0 ? pSum / matched.length : null,
      medianPayout: median,
      maxPayout: pays.length > 0 ? pays[pays.length - 1] : 0,
      roiContribution: stake > 0 ? pSum / stake : 0,
    };
  });

  return {
    settled: n,
    hits,
    hitRate,
    stake,
    payout,
    refund,
    net,
    balanceEnd: VIRTUAL_BANKROLL_INITIAL_YEN + net,
    roi,
    maxDrawdown,
    maxLosingStreak,
    maxLosingStreakExclRefund,
    roiCi95Bootstrap,
    roiCi95Cluster,
    roiCi95Normal,
    trimmedRoi: {
      exclTop1: trim(1),
      exclTop3: trim(3),
      exclTop5: trim(5),
      exclTop10: trim(10),
    },
    topPayouts,
    payoutBuckets,
    ticketBreakdown,
  };
}

export interface BlockSummary {
  blockSize: number;
  fullBlockCount: number;
  remainderCount: number;
  profitableBlocks: number;
  profitableRate: number | null;
  roiMedian: number | null;
  roiMin: number | null;
  roiMax: number | null;
  roiStd: number | null;
  maxDrawdownMedian: number | null;
  maxDrawdownMax: number | null;
  maxLosingStreakMax: number | null;
  blocks: {
    index: number;
    fromRaceId: string;
    toRaceId: string;
    fromDate: string;
    toDate: string;
    metrics: PerformanceMetrics;
  }[];
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function computeBlockAnalysis(
  rows: readonly SimpleBetRow[],
  windowSizes: readonly number[] = [100, 500, 1000, 3000],
  options: { bootstrapReps?: number } = {},
): Record<string, BlockSummary> {
  const out: Record<string, BlockSummary> = {};
  for (const size of windowSizes) {
    const fullCount = Math.floor(rows.length / size);
    const remainder = rows.length - fullCount * size;
    const blocks: BlockSummary["blocks"] = [];
    for (let i = 0; i < fullCount; i++) {
      const slice = rows.slice(i * size, (i + 1) * size);
      blocks.push({
        index: i + 1,
        fromRaceId: slice[0].raceId,
        toRaceId: slice[slice.length - 1].raceId,
        fromDate: slice[0].date,
        toDate: slice[slice.length - 1].date,
        metrics: computePerformanceMetrics(slice, {
          bootstrapReps: options.bootstrapReps ?? 1000,
          seed: 10000 + size * 100 + i,
        }),
      });
    }
    const rois = blocks.map((b) => b.metrics.roi).filter((v): v is number => v !== null);
    const dds = blocks.map((b) => b.metrics.maxDrawdown);
    const streaks = blocks.map((b) => b.metrics.maxLosingStreak);
    const profitableBlocks = rois.filter((r) => r >= 1.0).length;
    out[`block_${size}`] = {
      blockSize: size,
      fullBlockCount: fullCount,
      remainderCount: remainder,
      profitableBlocks,
      profitableRate: fullCount > 0 ? profitableBlocks / fullCount : null,
      roiMedian: medianOf(rois),
      roiMin: rois.length ? Math.min(...rois) : null,
      roiMax: rois.length ? Math.max(...rois) : null,
      roiStd: rois.length >= 2 ? popStd(rois) : null,
      maxDrawdownMedian: medianOf(dds),
      maxDrawdownMax: dds.length ? Math.max(...dds) : null,
      maxLosingStreakMax: streaks.length ? Math.max(...streaks) : null,
      blocks,
    };
  }
  return out;
}

// 2-sided normal p-value approximation (Abramowitz & Stegun)
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax);
  return sign * y;
}

export function welchPValue(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (se <= 1e-12) return 1;
  const z = Math.abs((ma - mb) / se);
  return Math.max(0, Math.min(1, 1 - erf(z / Math.SQRT2)));
}

export function bhFdr(pValues: readonly (number | null)[]): (number | null)[] {
  const indexed = pValues
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p !== null && Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const m = indexed.length;
  const out = new Array<number | null>(pValues.length).fill(null);
  let minSoFar = 1;
  for (let rank = m; rank >= 1; rank--) {
    const item = indexed[rank - 1];
    const q = Math.min(minSoFar, (item.p * m) / rank);
    minSoFar = q;
    out[item.i] = Math.min(1, q);
  }
  return out;
}

export interface GroupPerformanceRow {
  group: string;
  metrics: PerformanceMetrics;
  vsRestPValue: number | null;
  bhFdrQ: number | null;
}

export function outcomeToSimpleRow(o: B01RaceOutcome): SimpleBetRow {
  return {
    raceId: o.race.id,
    date: o.race.date,
    venue: o.race.venue,
    venueName: o.race.venueName,
    number: o.race.number,
    stake: o.stake,
    payout: o.payout,
    refund: o.refund,
    hit: o.hit,
    hitTicket: o.hitTicket,
    isFullRefund: o.isFullRefund,
  };
}

export function groupPerformance(
  outcomes: readonly B01RaceOutcome[],
  keyFn: (o: B01RaceOutcome) => string | null,
  options: { bootstrapReps?: number; sortBy?: "key" | "roi" | "count" } = {},
): GroupPerformanceRow[] {
  const settled = outcomes.filter((o) => o.state === "settled");
  const buckets = new Map<string, B01RaceOutcome[]>();
  for (const o of settled) {
    const k = keyFn(o);
    if (k === null) continue;
    const list = buckets.get(k) ?? [];
    list.push(o);
    buckets.set(k, list);
  }

  const keys = [...buckets.keys()];
  const rows: GroupPerformanceRow[] = keys.map((k, idx) => {
    const subset = buckets.get(k)!;
    const subsetIds = new Set(subset.map((o) => o.race.id));
    const rest = settled.filter((o) => !subsetIds.has(o.race.id));
    const subRet = subset.map((o) => (o.stake > 0 ? (o.payout + o.refund) / o.stake : 0));
    const restRet = rest.map((o) => (o.stake > 0 ? (o.payout + o.refund) / o.stake : 0));
    return {
      group: k,
      metrics: computePerformanceMetrics(subset.map(outcomeToSimpleRow), {
        bootstrapReps: options.bootstrapReps ?? 1000,
        seed: 50000 + idx * 17,
      }),
      vsRestPValue: welchPValue(subRet, restRet),
      bhFdrQ: null,
    };
  });

  const qs = bhFdr(rows.map((r) => r.vsRestPValue));
  rows.forEach((r, i) => {
    r.bhFdrQ = qs[i];
  });

  const sortBy = options.sortBy ?? "key";
  if (sortBy === "roi") {
    rows.sort((a, b) => (b.metrics.roi ?? -1) - (a.metrics.roi ?? -1) || b.metrics.settled - a.metrics.settled);
  } else if (sortBy === "count") {
    rows.sort((a, b) => b.metrics.settled - a.metrics.settled || a.group.localeCompare(b.group));
  } else {
    rows.sort((a, b) => a.group.localeCompare(b.group));
  }
  return rows;
}

export interface FeatureComparisonRow {
  feature: string;
  hitMean: number | null;
  missMean: number | null;
  highPayoutHitMean: number | null; // >=2000
  lowPayoutHitMean: number | null; // <1000
  cohensDHitVsMiss: number | null;
  pValueHitVsMiss: number | null;
  hitN: number;
  missN: number;
}

function meanOf(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function cohensD(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = meanOf(a)!;
  const mb = meanOf(b)!;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
  const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
  return pooled > 1e-12 ? (ma - mb) / pooled : 0;
}

export function compareHitVsMissFeatures(outcomes: readonly B01RaceOutcome[]) {
  const settled = outcomes.filter((o) => o.state === "settled" && !o.isVoid);
  const hits = settled.filter((o) => o.hit);
  const misses = settled.filter((o) => !o.hit);
  const highHits = hits.filter((o) => o.payout >= 2000);
  const lowHits = hits.filter((o) => o.payout > 0 && o.payout < 1000);

  const extractors: { name: string; get: (o: B01RaceOutcome) => number | null }[] = [
    { name: "grade1_point", get: (o) => o.features.gradePoints[0] },
    { name: "gradeSigma", get: (o) => o.features.gradeSigma },
    { name: "gradeB1MinusOthers", get: (o) => o.features.gradeB1MinusOthers },
    { name: "gradeInnerMinusOuter", get: (o) => o.features.gradeInnerMinusOuter },
    { name: "gradeInnerDesc", get: (o) => (o.features.gradeInnerDesc === null ? null : Number(o.features.gradeInnerDesc)) },
    { name: "winRate1", get: (o) => o.features.winRate1 },
    { name: "winRateDiffOthers", get: (o) => o.features.winRateDiffOthers },
    { name: "winRateDiffMax23", get: (o) => o.features.winRateDiffMax23 },
    { name: "avgSt1", get: (o) => o.features.avgSt1 },
    { name: "avgStDiffMin23", get: (o) => o.features.avgStDiffMin23 },
    { name: "motor2_1", get: (o) => o.features.motor2_1 },
    { name: "motor2DiffMax23", get: (o) => o.features.motor2DiffMax23 },
    { name: "exTimeStd", get: (o) => o.features.exTimeStd },
    { name: "exTimeZ1", get: (o) => o.features.exTimeZ1 },
    { name: "exTimeDiffMin23", get: (o) => o.features.exTimeDiffMin23 },
    { name: "exStStdSigned", get: (o) => o.features.exStStdSigned },
    { name: "exStStdNoF", get: (o) => o.features.exStStdNoF },
    { name: "exWakunari", get: (o) => (o.features.exWakunari === null ? null : Number(o.features.exWakunari)) },
    { name: "exFlyingCount", get: (o) => o.features.exFlyingCount },
    { name: "exFlying1", get: (o) => (o.features.exFlying1 === null ? null : Number(o.features.exFlying1)) },
    { name: "raceNumber", get: (o) => o.race.number },
  ];

  const featureComparison: FeatureComparisonRow[] = extractors.map(({ name, get }) => {
    const hv = hits.map(get).filter((v): v is number => v !== null && Number.isFinite(v));
    const mv = misses.map(get).filter((v): v is number => v !== null && Number.isFinite(v));
    const hhv = highHits.map(get).filter((v): v is number => v !== null && Number.isFinite(v));
    const lhv = lowHits.map(get).filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      feature: name,
      hitMean: meanOf(hv),
      missMean: meanOf(mv),
      highPayoutHitMean: meanOf(hhv),
      lowPayoutHitMean: meanOf(lhv),
      cohensDHitVsMiss: cohensD(hv, mv),
      pValueHitVsMiss: welchPValue(hv, mv),
      hitN: hv.length,
      missN: mv.length,
    };
  });

  // Miss breakdown
  const missActualCounts = new Map<string, number>();
  let missBoat1First = 0;
  let missBoat1Top3 = 0;
  let missBoat1Out = 0;
  let missOther = 0;
  for (const m of misses) {
    if (m.actualTop3) {
      missActualCounts.set(m.actualTop3, (missActualCounts.get(m.actualTop3) ?? 0) + 1);
    }
    if (m.boat1Finish === 1) missBoat1First++;
    else if (m.boat1Finish === 2 || m.boat1Finish === 3) missBoat1Top3++;
    else if (m.boat1Finish !== null && m.boat1Finish >= 4) missBoat1Out++;
    else missOther++;
  }
  const topMissCombinations = [...missActualCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([combination, count]) => ({
      combination,
      count,
      shareOfMisses: misses.length > 0 ? count / misses.length : 0,
      shareOfAll: settled.length > 0 ? count / settled.length : 0,
    }));

  return {
    counts: {
      settledExclVoid: settled.length,
      hits: hits.length,
      highPayoutHits: highHits.length,
      lowPayoutHits: lowHits.length,
      misses: misses.length,
      missBoat1First,
      missBoat1Top3,
      missBoat1Out,
      missOther,
    },
    featureComparison,
    topMissCombinations,
  };
}

/** B01RaceInput を B13/B13v2 互換の BoatRecord に変換する。
 * preCutoffMode="strict" の場合、アーカイブ本来の fetchedAt を尊重する。
 * preCutoffMode="backfill-as-pre" の場合、公式過去バックフィルを締切前取得扱いとして比較する（明示注記付き）。
 */
export function toBoatRecordForComparison(
  race: B01RaceInput,
  preCutoffMode: "strict" | "backfill-as-pre",
): BoatRecord {
  if (preCutoffMode === "strict" && race.boatRecord) {
    return race.boatRecord;
  }
  const cutoffMs = race.cutoff ? Date.parse(race.cutoff) : Date.parse(`${race.date}T09:00:00+09:00`);
  const syntheticPreIso = new Date((Number.isFinite(cutoffMs) ? cutoffMs : Date.parse(`${race.date}T09:00:00+09:00`)) - 5 * 60 * 1000).toISOString();
  const syntheticResultIso = `${race.date}T23:30:00+09:00`;

  const result: BoatResult | undefined = race.result
    ? {
        ...race.result,
        evidence:
          preCutoffMode === "backfill-as-pre"
            ? { ...race.result.evidence, fetchedAt: syntheticResultIso }
            : race.result.evidence,
      }
    : undefined;

  return {
    id: race.id,
    date: race.date,
    venue: race.venue,
    venueName: race.venueName,
    number: race.number,
    cutoff: race.cutoff ?? `${race.date}T12:00:00+09:00`,
    program: {
      url: race.boatRecord?.program.url ?? `https://www.boatrace.jp/owpc/pc/race/racelist?rno=${race.number}&jcd=${race.venue}&hd=${race.date.replace(/-/g, "")}`,
      fetchedAt: preCutoffMode === "backfill-as-pre" ? syntheticPreIso : (race.boatRecord?.program.fetchedAt ?? syntheticPreIso),
    },
    entries: BOATS.map((b) => {
      const e = race.entries.find((x) => x.boat === b);
      return { boat: b, name: e?.name ?? "", grade_original: e?.grade ?? null };
    }),
    ...(race.exhibition
      ? {
          exhibition: {
            entries: race.exhibition.entries
              .filter((e): e is { boat: number; course: number; st: string; flying: boolean } =>
                e.course !== null && e.st !== null && e.flying !== null,
              )
              .map((e) => ({ boat: e.boat, course: e.course, st: e.st, flying: e.flying })),
            times: race.exhibition.times,
            evidence: {
              url: `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${race.number}&jcd=${race.venue}&hd=${race.date.replace(/-/g, "")}`,
              fetchedAt:
                preCutoffMode === "backfill-as-pre"
                  ? syntheticPreIso
                  : (race.exhibition.fetchedAt ?? `${race.date}T23:59:59+09:00`),
            },
          },
        }
      : {}),
    ...(result ? { result } : {}),
  };
}

export type ComparisonModelId = "B01" | "B02" | "B13" | "B13v2Pre" | "B13v2NoEx" | "FIXED123";

export interface ModelComparisonResult {
  mode: "strict-archive" | "full-backfill-reconstructed";
  note: string;
  evalDates: string[];
  eligibleRaces: number;
  models: Record<
    ComparisonModelId,
    PerformanceMetrics & {
      logLoss: number | null;
      brierScore: number | null;
      sameTicketsAsB01Rate: number | null;
    }
  >;
}

/** B01, B02, B13, B13v2Pre, B13v2NoEx, FIXED123 を同一レース・同一仮想予算（1R=200円）で比較する。 */
export function compareModelsSameRaces(
  races: readonly B01RaceInput[],
  options: {
    mode: "strict-archive" | "full-backfill-reconstructed";
    evalFromDate?: string;
    bootstrapReps?: number;
  },
): ModelComparisonResult {
  const preMode = options.mode === "strict-archive" ? "strict" : "backfill-as-pre";
  const records = [...races]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.cutoff ?? "").localeCompare(b.cutoff ?? "") || a.id.localeCompare(b.id))
    .map((r) => toBoatRecordForComparison(r, preMode));

  const dates = [...new Set(records.map((r) => r.date))];
  const evalFrom = options.evalFromDate ?? "0000-00-00";
  const modelIds: ComparisonModelId[] = ["B01", "B02", "B13", "B13v2Pre", "B13v2NoEx", "FIXED123"];

  const rowsByModel = Object.fromEntries(modelIds.map((id) => [id, [] as SimpleBetRow[]])) as Record<ComparisonModelId, SimpleBetRow[]>;
  const probStats = Object.fromEntries(
    modelIds.map((id) => [id, { llSum: 0, llCount: 0, brierSum: 0, brierCount: 0, sameAsB01: 0, compared: 0 }]),
  ) as Record<ComparisonModelId, { llSum: number; llCount: number; brierSum: number; brierCount: number; sameAsB01: number; compared: number }>;

  const before = (a: string | null | undefined, b: string | null | undefined) =>
    Boolean(a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) < Date.parse(b));

  const evalDates: string[] = [];
  let eligibleRaces = 0;

  for (const date of dates) {
    const asOf = `${date}T00:00:00+09:00`;
    const trainingRaw = records.flatMap((r) => {
      if (r.date >= date || !before(r.program.fetchedAt, r.cutoff) || !before(r.result?.evidence.fetchedAt, asOf)) {
        return [];
      }
      const order = topThree(r);
      return order ? [{ race: r, order }] : [];
    });
    if (!trainingRaw.length) continue;
    if (date < evalFrom) continue;

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
    if (!modelPre || !modelNoEx || !b13Dist) continue;

    evalDates.push(date);
    const targets = records.filter((r) => r.date === date);
    for (const race of targets) {
      if (!before(race.program.fetchedAt, race.cutoff)) continue;
      if (!race.result) continue;
      if (race.result.status === "official" && !Object.keys(race.result.payouts).length && !race.result.special) continue;

      eligibleRaces++;
      const fPre = extractB13V2Features(race, { preCutoffExhibitionOnly: true });
      const predPre = fPre.hasCompleteExhibition ? predictB13V2(modelPre, fPre) : predictB13V2(modelNoEx, fPre);
      const predNoEx = predictB13V2(modelNoEx, fPre);

      const ticketMap: Record<ComparisonModelId, string[]> = {
        B01: [...B01_TICKETS],
        B02: [...B02_TICKETS],
        B13: b13Dist.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
        B13v2Pre: predPre.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
        B13v2NoEx: predNoEx.distribution.slice(0, B13V2_CONFIG.ticketCount).map((p) => p.combination),
        FIXED123: ["1-2-3"],
      };

      const b01Set = new Set(ticketMap.B01);
      const actual = topThree(race)?.join("-") ?? null;

      for (const id of modelIds) {
        const tickets = ticketMap[id];
        const unit = id === "FIXED123" ? 200 : 100;
        let stake = 0;
        let payout = 0;
        let refund = 0;
        let hit = false;
        let hitTicket: string | null = null;
        for (const t of tickets) {
          stake += unit;
          const refunded = race.result.status === "void" || t.split("-").some((b) => race.result!.refundBoats.includes(Number(b)));
          if (refunded) {
            refund += unit;
          } else {
            const p100 =
              (race.result.payouts[t] ?? 0) +
              (race.result.special && !race.result.special.winning.includes(t) ? race.result.special.per100 : 0);
            const paid = (p100 * unit) / 100;
            payout += paid;
            if (paid > 0) {
              hit = true;
              hitTicket = t;
            }
          }
        }
        rowsByModel[id].push({
          raceId: race.id,
          date: race.date,
          venue: race.venue,
          venueName: race.venueName,
          number: race.number,
          stake,
          payout,
          refund,
          hit,
          hitTicket,
          isFullRefund: refund === stake && stake > 0,
        });

        probStats[id].compared++;
        if (tickets.length === b01Set.size && tickets.every((t) => b01Set.has(t))) {
          probStats[id].sameAsB01++;
        }

        if (actual) {
          const dist =
            id === "B13"
              ? b13Dist
              : id === "B13v2Pre"
                ? predPre.distribution
                : id === "B13v2NoEx"
                  ? predNoEx.distribution
                  : id === "B01"
                    ? [
                        { combination: "1-2-3", probability: 0.5 },
                        { combination: "1-3-2", probability: 0.5 },
                      ]
                    : id === "B02"
                      ? [
                          { combination: "1-2-3", probability: 0.5 },
                          { combination: "1-2-4", probability: 0.5 },
                        ]
                      : [{ combination: "1-2-3", probability: 1 }];
          const sc = scoreDistribution(dist, actual);
          if ((id === "B13" || id === "B13v2Pre" || id === "B13v2NoEx") && sc.logLoss !== null) {
            probStats[id].llSum += sc.logLoss;
            probStats[id].llCount++;
          }
          probStats[id].brierSum += sc.brierScore;
          probStats[id].brierCount++;
        }
      }
    }
  }

  const models = Object.fromEntries(
    modelIds.map((id, idx) => {
      const m = computePerformanceMetrics(rowsByModel[id], {
        bootstrapReps: options.bootstrapReps ?? 2000,
        seed: 70000 + idx * 101,
        ticketLabels: id === "B01" ? [...B01_TICKETS] : id === "B02" ? [...B02_TICKETS] : ["1-2-3", "1-3-2", "1-2-4"],
      });
      const ps = probStats[id];
      return [
        id,
        {
          ...m,
          logLoss: ps.llCount ? ps.llSum / ps.llCount : null,
          brierScore: ps.brierCount ? ps.brierSum / ps.brierCount : null,
          sameTicketsAsB01Rate: ps.compared ? ps.sameAsB01 / ps.compared : null,
        },
      ];
    }),
  ) as ModelComparisonResult["models"];

  return {
    mode: options.mode,
    note:
      options.mode === "strict-archive"
        ? "アーカイブ／SQLite本来の取得時刻に基づき、締切前番組＋締切前展示（欠損時はB13v2NoExフォールバック）を厳密適用。"
        : "公式過去バックフィル全期間の再構成比較（前日までのデータで日次学習。バックフィルは展示取得時刻を持たないため展示完備レースを締切前展示相当としてB13v2Preを算出）。",
    evalDates,
    eligibleRaces,
    models,
  };
}

// ---------- 時系列分割による仮説検証（既存B01は基準維持、改善仮説はB01H-*として別管理） ----------

export interface HypothesisModelSpec {
  id: string;
  name: string;
  hypothesis: string;
  kind: "baseline" | "a-priori-rule" | "discovery-fitted";
  predicate: (o: B01RaceOutcome) => boolean;
}

export interface HypothesisSplitEvaluation {
  id: string;
  name: string;
  hypothesis: string;
  kind: HypothesisModelSpec["kind"];
  discovery: {
    selectedCount: number;
    selectionRate: number;
    metrics: PerformanceMetrics;
  };
  holdout: {
    selectedCount: number;
    selectionRate: number;
    metrics: PerformanceMetrics;
    vsBaselinePValue: number | null;
  };
  verdict: "baseline" | "reproduced-positive" | "overfit-not-reproduced" | "rejected-both";
}

function fitB01HitLogistic(train: readonly B01RaceOutcome[]) {
  const extract = (o: B01RaceOutcome): number[] | null => {
    const f = o.features;
    if (
      f.gradeSigma === null ||
      f.gradeB1MinusOthers === null ||
      f.winRateDiffMax23 === null ||
      f.motor2DiffMax23 === null ||
      f.exWakunari === null ||
      f.exTimeZ1 === null ||
      f.exTimeStd === null
    ) {
      return null;
    }
    return [
      f.gradeSigma,
      f.gradeB1MinusOthers,
      Number(f.gradeInnerDesc ?? false),
      f.winRateDiffMax23,
      f.motor2DiffMax23,
      Number(f.exWakunari),
      f.exTimeZ1,
      f.exTimeStd,
      Number(f.exFlying1 ?? false),
    ];
  };

  const raw = train
    .map((o) => ({ x: extract(o), y: Number(o.hit) }))
    .filter((r): r is { x: number[]; y: number } => r.x !== null);
  if (raw.length < 50) return null;

  const d = raw[0].x.length;
  const means = Array.from({ length: d }, (_, j) => raw.reduce((s, r) => s + r.x[j], 0) / raw.length);
  const stds = Array.from({ length: d }, (_, j) => {
    const v = raw.reduce((s, r) => s + (r.x[j] - means[j]) ** 2, 0) / raw.length;
    return Math.sqrt(v) || 1;
  });

  const normX = (x: number[]) => [1, ...x.map((v, j) => Math.max(-4, Math.min(4, (v - means[j]) / stds[j])))];
  const data = raw.map((r) => ({ x: normX(r.x), y: r.y }));
  const w = new Array<number>(d + 1).fill(0);
  const lr = 0.15;
  const ridge = 0.05;

  for (let it = 0; it < 250; it++) {
    const grad = w.map((wj, j) => (j === 0 ? 0 : ridge * wj));
    for (const row of data) {
      let z = 0;
      for (let j = 0; j < w.length; j++) z += w[j] * row.x[j];
      const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = p - row.y;
      for (let j = 0; j < w.length; j++) grad[j] += (err * row.x[j]) / data.length;
    }
    for (let j = 0; j < w.length; j++) w[j] -= lr * grad[j];
  }

  const score = (o: B01RaceOutcome): number | null => {
    const x = extract(o);
    if (!x) return null;
    const nx = normX(x);
    let z = 0;
    for (let j = 0; j < w.length; j++) z += w[j] * nx[j];
    return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
  };

  // 探索期間の上位25%・下位50%などの閾値を探索期間のみで確定
  const trainScores = train.map(score).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const q75 = trainScores[Math.floor(trainScores.length * 0.75)] ?? 0.2;
  const q50 = trainScores[Math.floor(trainScores.length * 0.5)] ?? 0.15;
  return { score, q75, q50, weights: w };
}

export function evaluateHypothesesSplit(
  outcomes: readonly B01RaceOutcome[],
  splitDate: string, // discovery: date < splitDate, holdout: date >= splitDate
  options: { bootstrapReps?: number } = {},
) {
  const settled = outcomes.filter((o) => o.state === "settled");
  const discovery = settled.filter((o) => o.race.date < splitDate);
  const holdout = settled.filter((o) => o.race.date >= splitDate);

  // 探索期間のみで場別ROI上位（最低50R以上 & ROI>=100%）を抽出（データスヌーピングの再現性検証用）
  const discVenueGroups = groupPerformance(discovery, (o) => o.race.venueName, { bootstrapReps: 200 });
  const topDiscVenues = new Set(
    discVenueGroups
      .filter((g) => g.metrics.settled >= 50 && (g.metrics.roi ?? 0) >= 1.0)
      .map((g) => g.group),
  );

  // 探索期間のみでB01的中確率ロジスティックモデルを学習
  const logit = fitB01HitLogistic(discovery);

  const specs: HypothesisModelSpec[] = [
    {
      id: "B01",
      name: "B01 ベースライン（全レース無条件）",
      hypothesis: "比較基準。オッズ・級別・展示による組番変更・見送りなし。",
      kind: "baseline",
      predicate: () => true,
    },
    {
      id: "B01H-wakunari",
      name: "B01H: 展示枠なり限定",
      hypothesis: "進入変化のあるレースを除外し、展示枠なり(123456)のみ購入すれば回収率が改善する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exWakunari === true,
    },
    {
      id: "B01H-inner-strong",
      name: "B01H: 1号艇勝率優位＋展示枠なり",
      hypothesis: "1号艇が2・3号艇より全国勝率が高く(winRateDiffMax23>=0)かつ展示枠なりのレースで収益性が向上する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exWakunari === true && (o.features.winRateDiffMax23 ?? -99) >= 0,
    },
    {
      id: "B01H-inner-desc",
      name: "B01H: 内3艇級別降順 (1>=2>=3)",
      hypothesis: "内3艇の級別が1>=2>=3の順に並ぶレースは1-2-3/1-3-2が決まりやすく収益性が高い。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.gradeInnerDesc === true,
    },
    {
      id: "B01H-sigma-small",
      name: "B01H: 級別標準偏差 小 (σ<=0.5)",
      hypothesis: "級別差が小さい混戦レースの方が1-2-3/1-3-2のオッズが下がりにくく回収率が高い。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.gradeSigmaClass === "small",
    },
    {
      id: "B01H-sigma-large",
      name: "B01H: 級別標準偏差 大 (σ>=1.0)",
      hypothesis: "級別格差が大きいレースの方が上位艇決着が安定する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.gradeSigmaClass === "large",
    },
    {
      id: "B01H-anti-chalk",
      name: "B01H: 非本命1号艇＋枠なり（中穴仮説）",
      hypothesis: "1号艇がA1ではない(A2/B1/B2)が展示枠なりのレースは、過剰人気を避けて1-2-3/1-3-2の期待回収率が上がる。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exWakunari === true && o.features.grade1 !== null && o.features.grade1 !== "A1",
    },
    {
      id: "B01H-no-ex-f",
      name: "B01H: 展示Fなし限定",
      hypothesis: "展示フライング艇がいる波乱含みレースを避けると回収率が安定する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exFlyingCount === 0,
    },
    {
      id: "B01H-sigma-normal",
      name: "B01H-R2: 級別標準偏差 中庸 (0.5<σ<1.0)",
      hypothesis: "第2ラウンド仮説: 級別差が極端に小さくも大きくもない中庸帯でオッズと的中率のバランスが改善する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.gradeSigmaClass === "normal",
    },
    {
      id: "B01H-no-f3-no-outerf",
      name: "B01H-R2: 3号艇Fなし＋外枠(4-6)Fなし",
      hypothesis: "第2ラウンド仮説: 3号艇F（スタート自重）と外枠F（外攻め波乱）を除外すると1-2-3/1-3-2の回収率が向上する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exFlying3 === false && o.features.exFlyingOuter === false,
    },
    {
      id: "B01H-nof-sigma-normal",
      name: "B01H-R2: 展示Fなし＋級別σ中庸",
      hypothesis: "第2ラウンド仮説: 展示Fなしと級別σ中庸の積集合で回収率100%超が再現されるか検証する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exFlyingCount === 0 && o.features.gradeSigmaClass === "normal",
    },
    {
      id: "B01H-late-nof",
      name: "B01H-R2: 夕方/ナイター＋展示Fなし",
      hypothesis: "第2ラウンド仮説: イン優位が出やすい15時以降かつ展示Fなしに絞ると収益性が再現されるか検証する。",
      kind: "a-priori-rule",
      predicate: (o) =>
        (o.features.timeSlot === "evening" || o.features.timeSlot === "night") && o.features.exFlyingCount === 0,
    },
    {
      id: "B01H-r11-12",
      name: "B01H-R2: 11R・12R限定",
      hypothesis: "第2ラウンド仮説: 番組構成が明確な11R・12R限定で100%超が再現されるか検証する。",
      kind: "a-priori-rule",
      predicate: (o) => o.race.number === 11 || o.race.number === 12,
    },
    {
      id: "B01H-b1-ex-fast",
      name: "B01H: 1号艇展示タイム優位＋枠なり",
      hypothesis: "1号艇の展示タイムがレース平均より速く(exTimeZ1<0)かつ枠なりのレースに絞ると回収率が改善する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exWakunari === true && (o.features.exTimeZ1 ?? 99) < 0,
    },
    {
      id: "B01H-b1-motor-edge",
      name: "B01H: 1号艇モーター優位＋枠なり",
      hypothesis: "1号艇モーター2連率が2・3号艇最大値以上かつ枠なりのレースに絞ると回収率が改善する。",
      kind: "a-priori-rule",
      predicate: (o) => o.features.exWakunari === true && (o.features.motor2DiffMax23 ?? -99) >= 0,
    },
    {
      id: "B01H-disc-top-venues",
      name: `B01H: 探索期間ROI>=100%場フィルタ (${topDiscVenues.size}場)`,
      hypothesis: "探索期間で高回収だった場だけを選べば独立検証期間でも高回収が再現される（場選択バイアス検証）。",
      kind: "discovery-fitted",
      predicate: (o) => topDiscVenues.has(o.race.venueName),
    },
    {
      id: "B01H-logit-top25",
      name: "B01H: 探索学習ロジスティック的中確率上位25%",
      hypothesis: "探索期間のみで学習したB01的中確率モデルの上位25%レースのみ購入すると収益性が改善する。",
      kind: "discovery-fitted",
      predicate: (o) => {
        if (!logit) return false;
        const s = logit.score(o);
        return s !== null && s >= logit.q75;
      },
    },
    {
      id: "B01H-logit-mid50",
      name: "B01H: 探索学習ロジスティック的中確率上位50%",
      hypothesis: "探索期間のみで学習したB01的中確率モデルの上位50%レースのみ購入すると収益性が改善する。",
      kind: "discovery-fitted",
      predicate: (o) => {
        if (!logit) return false;
        const s = logit.score(o);
        return s !== null && s >= logit.q50;
      },
    },
  ];

  const holdoutBaseReturns = holdout.map((o) => (o.stake > 0 ? (o.payout + o.refund) / o.stake : 0));

  const results: HypothesisSplitEvaluation[] = specs.map((spec, idx) => {
    const discSub = discovery.filter(spec.predicate);
    const holdSub = holdout.filter(spec.predicate);
    const discMetrics = computePerformanceMetrics(discSub.map(outcomeToSimpleRow), {
      bootstrapReps: options.bootstrapReps ?? 1500,
      seed: 80000 + idx * 31,
    });
    const holdMetrics = computePerformanceMetrics(holdSub.map(outcomeToSimpleRow), {
      bootstrapReps: options.bootstrapReps ?? 1500,
      seed: 90000 + idx * 31,
    });

    const holdSubReturns = holdSub.map((o) => (o.stake > 0 ? (o.payout + o.refund) / o.stake : 0));
    const vsBaselinePValue = spec.kind === "baseline" ? null : welchPValue(holdSubReturns, holdoutBaseReturns);

    let verdict: HypothesisSplitEvaluation["verdict"] = "rejected-both";
    if (spec.kind === "baseline") {
      verdict = "baseline";
    } else {
      const discPos = (discMetrics.roi ?? 0) >= 1.0;
      const holdPos = (holdMetrics.roi ?? 0) >= 1.0;
      if (discPos && holdPos) verdict = "reproduced-positive";
      else if (discPos && !holdPos) verdict = "overfit-not-reproduced";
      else verdict = "rejected-both";
    }

    return {
      id: spec.id,
      name: spec.name,
      hypothesis: spec.hypothesis,
      kind: spec.kind,
      discovery: {
        selectedCount: discSub.length,
        selectionRate: discovery.length ? discSub.length / discovery.length : 0,
        metrics: discMetrics,
      },
      holdout: {
        selectedCount: holdSub.length,
        selectionRate: holdout.length ? holdSub.length / holdout.length : 0,
        metrics: holdMetrics,
        vsBaselinePValue,
      },
      verdict,
    };
  });

  return {
    splitDate,
    discoveryDates: [...new Set(discovery.map((o) => o.race.date))].sort(),
    holdoutDates: [...new Set(holdout.map((o) => o.race.date))].sort(),
    discoveryCount: discovery.length,
    holdoutCount: holdout.length,
    topDiscoveryVenues: [...topDiscVenues].sort(),
    results,
  };
}
