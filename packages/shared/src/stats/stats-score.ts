// Data score (stats-score-v1): the existing six-factor frame (scoring.ts,
// six-factor-v1 weights) filled from statistics instead of an AI's judgement.
// It sits next to the AI's components for comparison and never replaces a
// locked prediction. Odds are not used (same rule as the six-factor score).
//
//   ability             TL指数 recency mean (z within field); fallback: finishing position
//   course              top-3 at today's track+surface and distance band (shrunk), slope fit
//   pace                horse's style mix × course/today style bias
//   going               finishing position on today's going class vs overall
//   draw_weight         today's lane bias × the horse's lane record, carried-weight change
//   horse_jockey_course jockey at course/track (shrunk) and the pair's record
//
// Small samples are shrunk toward the field prior; a component with no data
// is 50 and flagged estimated.
import type { Json, Row } from "../domain";
import { scoreWeights, totalScore } from "../scoring";
import { clamp, confidenceOf, mean, round, shrink, stdev, type Tally } from "./stat-math";
import type { Lane } from "./corpus";
import type { RunningStyle } from "../run-record";

export const STATS_SCORE_VERSION = "stats-score-v1";
type Component = keyof typeof scoreWeights;

export type ScoreInput = {
  horse_number: number;
  field_size: number;
  figure_recency: number | null;
  figure_n: number;
  figure_estimated: boolean;
  /** Recency-weighted relative finishing position (0 = won). */
  rel_recency: number | null;
  rel_n: number;
  course_track: Tally;
  course_band: Tally;
  slope_today: boolean | null;
  slope_tally: Tally;
  flat_tally: Tally;
  styles: { style: RunningStyle; w: number }[];
  going_today: "良" | "道悪" | null;
  rel_by_going: number | null;
  going_n: number;
  lane_today: Lane | null;
  horse_lane: Tally;
  horse_all: Tally;
  weight_change: number | null;
  jockey_course: Tally;
  jockey_track: Tally;
  jockey_overall: Tally;
  combo: Tally;
};

export type ScoreContext = {
  course_styles: Record<RunningStyle, Tally> | null;
  course_style_races: number;
  today_styles: Record<RunningStyle, Tally> | null;
  course_lanes: Record<Lane, Tally> | null;
  today_lanes: Record<Lane, Tally> | null;
};

type Part = { value: number; n: number; confidence: string; estimated: boolean; basis: string };

const part = (value: number, n: number, estimated: boolean, basis: string): Part => ({
  value: round(clamp(value, 1, 99), 2),
  n,
  confidence: confidenceOf(n),
  estimated,
  basis,
});
const neutral = (basis: string): Part => part(50, 0, true, `データなし（50）: ${basis}`);

function zScores(values: (number | null)[], higherBetter: boolean): (number | null)[] {
  const known = values.filter((v): v is number => v != null);
  const m = mean(known);
  const s = stdev(known);
  return values.map((v) => (v == null || m == null ? null : !s ? 0 : ((higherBetter ? v - m : m - v) / s)));
}

const sumTally = (ts: Tally[]): Tally => ts.reduce((a, t) => ({ starts: a.starts + t.starts, wins: a.wins + t.wins, top3: a.top3 + t.top3 }), { starts: 0, wins: 0, top3: 0 });
const top3Rate = (t: Tally | undefined) => (t && t.starts ? t.top3 / t.starts : null);

export function scoreSheet(inputs: ScoreInput[], ctx: ScoreContext): Row[] {
  const figZ = zScores(inputs.map((i) => i.figure_recency), true);
  const relZ = zScores(inputs.map((i) => i.rel_recency), false);
  // Style bias rates: course table shrunk toward its overall top-3 rate, then
  // today's tally shrunk toward the course rate.
  const styleRate = (s: RunningStyle): number | null => {
    if (!ctx.course_styles) return null;
    const all = sumTally(Object.values(ctx.course_styles));
    const base = top3Rate(all);
    if (base == null) return null;
    const c = ctx.course_styles[s];
    let r = shrink(c.top3, c.starts, base, 20);
    if (ctx.today_styles) {
      const t = ctx.today_styles[s];
      r = shrink(t.top3, t.starts, r, 15);
    }
    return r;
  };
  const styleBase = ctx.course_styles ? top3Rate(sumTally(Object.values(ctx.course_styles))) : null;
  const laneRate = (l: Lane): number | null => {
    if (!ctx.course_lanes) return null;
    const base = top3Rate(sumTally(Object.values(ctx.course_lanes)));
    if (base == null) return null;
    let r = shrink(ctx.course_lanes[l].top3, ctx.course_lanes[l].starts, base, 20);
    if (ctx.today_lanes) r = shrink(ctx.today_lanes[l].top3, ctx.today_lanes[l].starts, r, 15);
    return r;
  };
  const laneBase = ctx.course_lanes ? top3Rate(sumTally(Object.values(ctx.course_lanes))) : null;

  const out = inputs.map((x, i) => {
    const prior = Math.min(1, 3 / Math.max(3, x.field_size));
    const parts = {} as Record<Component, Part>;
    // ability
    if (figZ[i] != null && x.figure_n > 0)
      parts.ability = part(50 + 12 * figZ[i]!, x.figure_n, x.figure_estimated, "TL指数の直近重視平均（出走馬内の偏差）");
    else if (relZ[i] != null && x.rel_n > 0)
      parts.ability = part(50 + 10 * relZ[i]!, x.rel_n, true, "TL指数なし。過去走の着順位置（直近重視）で代替");
    else parts.ability = neutral("過去走なし");
    // course
    const n1 = x.course_track.starts;
    const n2 = x.course_band.starts;
    if (n1 + n2 > 0) {
      const r = (shrink(x.course_track.top3, n1, prior, 4) + shrink(x.course_band.top3, n2, prior, 4)) / 2;
      let v = 50 + 100 * (r - prior);
      let basis = `同場同面 ${x.course_track.top3}/${n1}・同面同距離帯 ${x.course_band.top3}/${n2}（3着内、縮小推定）`;
      if (x.slope_today === true && x.slope_tally.starts + x.flat_tally.starts > 0) {
        const d = shrink(x.slope_tally.top3, x.slope_tally.starts, prior, 3) - shrink(x.flat_tally.top3, x.flat_tally.starts, prior, 3);
        v += 30 * d;
        basis += `・坂コース ${x.slope_tally.top3}/${x.slope_tally.starts}`;
      }
      parts.course = part(v, n1 + n2, false, basis);
    } else parts.course = neutral("同場・同距離帯の出走なし");
    // pace
    if (x.styles.length && styleBase != null) {
      const w = x.styles.reduce((a, s) => a + s.w, 0);
      const expected = x.styles.reduce((a, s) => a + (s.w / w) * (styleRate(s.style) ?? styleBase), 0);
      parts.pace = part(50 + 150 * (expected - styleBase), Math.min(x.styles.length, ctx.course_style_races), ctx.course_style_races < 10,
        `脚質構成×コース${ctx.today_styles ? "・当日" : ""}の脚質別3着内率`);
    } else parts.pace = neutral(x.styles.length ? "コースの脚質集計なし" : "通過順なし");
    // going
    if (x.going_today && x.rel_by_going != null && x.rel_recency != null && x.going_n > 0)
      parts.going = part(50 + 60 * (x.rel_recency - x.rel_by_going), x.going_n, false, `${x.going_today}での着順位置と全体の差`);
    else parts.going = neutral(x.going_today ? `${x.going_today}の出走なし` : "当日馬場が未確認");
    // draw & weight
    if (x.lane_today) {
      const lr = laneRate(x.lane_today);
      let v = 50;
      let n = 0;
      const basis: string[] = [];
      if (lr != null && laneBase != null) {
        v += 150 * (lr - laneBase);
        n += 10;
        basis.push(`今日の位置（${x.lane_today === "inner" ? "内" : x.lane_today === "outer" ? "外" : "中"}）のコース${ctx.today_lanes ? "・当日" : ""}3着内率`);
      }
      if (x.horse_lane.starts) {
        const h = shrink(x.horse_lane.top3, x.horse_lane.starts, prior, 3) - shrink(x.horse_all.top3, x.horse_all.starts, prior, 3);
        v += 50 * h;
        n += x.horse_lane.starts;
        basis.push(`自身の同位置 ${x.horse_lane.top3}/${x.horse_lane.starts}`);
      }
      if (x.weight_change != null) {
        v -= 2 * x.weight_change;
        basis.push(`斤量${x.weight_change >= 0 ? "+" : ""}${x.weight_change}kg`);
      }
      parts.draw_weight = basis.length ? part(v, n, lr == null, basis.join("・")) : neutral("枠・斤量の材料なし");
    } else parts.draw_weight = neutral("頭数不明");
    // horse × jockey × course
    const jo = x.jockey_overall;
    if (jo.starts) {
      const jBase = shrink(jo.top3, jo.starts, prior, 20);
      const jc = x.jockey_course.starts ? shrink(x.jockey_course.top3, x.jockey_course.starts, jBase, 10)
        : shrink(x.jockey_track.top3, x.jockey_track.starts, jBase, 10);
      let v = 50 + 120 * (jc - prior);
      const basis = [`騎手 ${x.jockey_course.starts ? `同コース ${x.jockey_course.top3}/${x.jockey_course.starts}` : `同場 ${x.jockey_track.top3}/${x.jockey_track.starts}`}（全体 ${jo.top3}/${jo.starts}）`];
      if (x.combo.starts) {
        v += 30 * (shrink(x.combo.top3, x.combo.starts, prior, 3) - prior);
        basis.push(`コンビ ${x.combo.top3}/${x.combo.starts}`);
      }
      parts.horse_jockey_course = part(v, jo.starts, x.jockey_course.starts + x.jockey_track.starts === 0, basis.join("・"));
    } else parts.horse_jockey_course = neutral("騎手の過去成績なし");
    const components = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p.value]));
    return {
      horse_number: x.horse_number,
      total: totalScore(components),
      components: parts as unknown as Json,
      estimated_components: Object.entries(parts).filter(([, p]) => p.estimated).map(([k]) => k),
      min_confidence: Object.values(parts).map((p) => p.confidence).sort((a, b) => order(a) - order(b))[0],
    } as Row;
  });
  const sorted = [...out].sort((a, b) => Number(b.total) - Number(a.total) || Number(a.horse_number) - Number(b.horse_number));
  sorted.forEach((s, i) => (s.rank = i + 1));
  return out.map((s) => ({ version: STATS_SCORE_VERSION, ...s }));
}

const order = (c: string) => ({ insufficient: 0, low: 1, medium: 2, high: 3 })[c] ?? 0;
