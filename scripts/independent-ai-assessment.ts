import { obj, rows, type Row } from "../packages/shared/src/domain";
import {
  FORECAST_VERSION, REASON_CATEGORIES, validateForecast, type Forecast,
} from "../packages/shared/src/forecast-contract";

/** Structured, independent judgements. These marks are opinions, never fabricated observations. */
const MARKS = new Set(["◎", "○", "▲", "△", "☆", "無印", "?", "不明"]);
const LIMIT = 400;
const clean = (v: unknown) => typeof v === "string" ? v.slice(0, LIMIT) : "";
const mark = (v: unknown) => typeof v === "string" && MARKS.has(v) ? v : "不明";

export const INDEPENDENT_ASSESSMENT_PROMPT = `
【出力手順と必須JSON項目（independent-ai-v2 / forecast-v1）】
オッズ・人気・市場期待値を使わず、python_analytics（当日傾向 same_day_analysis・数理事前予想 math_prediction）を土台に、以下の順で自由に再検討して出力する。
1) horse_marks / jockey_marks / partnership_marks: 馬能力・騎手実績・人馬相性をそれぞれ独立評価。根拠不足は「不明」。
2) scenario_decision: 主展開（slow/middle/high）・隊列・想定上位・覆る条件。
3) final_marks: 1-2と数理予想を突き合わせて最終印を決定（数理順位と変えた馬は理由を明記）。
4) ai_bet_decision / ai_bet_picks: "bet" または "skip"。買い目は適用ルール（3連複ベース1,000円・最大10点、自信時は馬連/馬単/3連単可）に従う。重複なし。見送りなら []。数理予想から変更・維持した理由を ai_bet_reason に書く。
フィールド:
horse_marks:[{horse_number,mark,reason,evidence_ids:[]}],
jockey_marks:[{horse_number,mark,reason,evidence_ids:[],sample_size:null|整数}],
partnership_marks:[{horse_number,mark,reason,evidence_ids:[]}],
final_marks:[{horse_number,mark,reason}],
scenario_decision:{main_pace,pace_reason,expected_order:[馬番],counter_scenario},
ai_bet_decision:"bet"|"skip", ai_bet_reason:文字列, ai_bet_picks:[{ticket_type,selections_json,amount_yen,rationale}]
印は ◎ ○ ▲ △ ☆ 無印 不明。
【数値予測（forecast）】オッズ・人気・外部予想・新聞印は一切参照しない。
forecast:{
 win_probabilities:[{horse_number,p}], // 全馬・合計1
 top3_probabilities:[{horse_number,p}], // 全馬・合計約3
 corner_ranks:[{horse_number,first,last}], // 全馬・1..頭数の順列
 pace_class:"slow"|"middle"|"high", pace_z:数値|null,
 reason_categories:[${REASON_CATEGORIES.map((c) => `"${c}"`).join(",")}]
}
`;

function normalizeMarks(raw: unknown, valid: Set<number>, withSample = false): Row[] | null {
  const data = Array.isArray(raw) ? rows(raw) : [];
  if (data.length !== valid.size) return null;
  const seen = new Set<number>();
  const out: Row[] = [];
  for (const entry of data) {
    const number = Number(entry.horse_number);
    if (!Number.isInteger(number) || !valid.has(number) || seen.has(number)) return null;
    seen.add(number);
    const sample = entry.sample_size;
    out.push({
      horse_number: number, mark: mark(entry.mark),
      reason: clean(entry.reason),
      evidence_ids: (Array.isArray(entry.evidence_ids) ? entry.evidence_ids : [])
        .filter((v): v is string => typeof v === "string").slice(0, 8).map(v => v.slice(0, 120)),
      ...(withSample ? { sample_size: Number.isSafeInteger(Number(sample)) && sample != null && Number(sample) >= 0 ? sample : null } : {}),
    });
  }
  return out;
}

/** Reject partial/duplicate/misaligned marks rather than inferring the missing horses. */
export function independentAssessment(answer: Row, pack: Row): Row | null {
  const active = rows(pack.entries).filter(e => e.status === "active");
  const valid = new Set(active.map(e => Number(e.horse_number)));
  if (!valid.size || valid.size !== active.length) return null;
  const horse = normalizeMarks(answer.horse_marks, valid);
  const jockey = normalizeMarks(answer.jockey_marks, valid, true);
  const partnership = normalizeMarks(answer.partnership_marks, valid);
  const final = normalizeMarks(answer.final_marks, valid);
  const scenario = obj(answer.scenario_decision ?? {});
  if (!horse || !jockey || !partnership || !final || !["slow", "middle", "high"].includes(String(scenario.main_pace))) return null;
  const order = Array.isArray(scenario.expected_order) ? scenario.expected_order.map(Number) : [];
  if (!order.length || order.some(n => !valid.has(n)) || new Set(order).size !== order.length) return null;
  if (answer.ai_bet_decision !== "bet" && answer.ai_bet_decision !== "skip") return null;
  const block = answer.forecast ?? answer.forecast_block;
  return {
    version: "independent-ai-v2",
    ...(block && typeof block === "object" ? { forecast_block: block as Row } : {}),
    horse_marks: horse, jockey_marks: jockey, partnership_marks: partnership, final_marks: final,
    scenario_decision: {
      main_pace: scenario.main_pace, pace_reason: clean(scenario.pace_reason),
      expected_order: order.slice(0, 5), counter_scenario: clean(scenario.counter_scenario),
    },
    ai_bet_decision: answer.ai_bet_decision,
    ai_bet_reason: clean(answer.ai_bet_reason),
  };
}

export interface AiForecastMeta {
  forecasterId: string; modelVersion: string; modelKnowledgeCutoff: string | null;
  generatedAt: string; cutoffAt: string; inputHash: string;
}
export type AiForecastResult =
  | { status: "valid"; forecast: Forecast }
  | { status: "missing" }
  | { status: "invalid"; errors: string[] };

/** Builds the frozen forecast-v1 record from the AI's `forecast` block. Never throws and never alters the marks. */
export function aiForecastFromAnswer(answer: Row, pack: Row, meta: AiForecastMeta): AiForecastResult {
  const block = obj((answer.forecast_block ?? answer.forecast ?? {}) as Row);
  if (!Object.keys(block).length) return { status: "missing" };
  const race = obj(pack.race ?? {}), track = obj(pack.track ?? {}), course = obj(pack.course ?? {});
  const active = rows(pack.entries).filter((e) => e.status === "active").map((e) => Number(e.horse_number));
  const byNumber = (value: unknown, key: string) => new Map(rows(Array.isArray(value) ? value as Row[] : []).map((r) => [Number(r.horse_number), r[key]]));
  const win = byNumber(block.win_probabilities, "p");
  const top3 = byNumber(block.top3_probabilities, "p");
  const corners = rows(Array.isArray(block.corner_ranks) ? block.corner_ranks as Row[] : []);
  const cornerBy = new Map(corners.map((r) => [Number(r.horse_number), r]));
  const raceNo = Number(race.race_number ?? NaN);
  const date = String(race.race_date_jst ?? "");
  const record = {
    schema_version: FORECAST_VERSION, report_type: "race_forecast",
    forecaster: { id: meta.forecasterId, kind: "ai", model_version: meta.modelVersion, model_knowledge_cutoff: meta.modelKnowledgeCutoff },
    race: {
      race_key_human: `${date}|${String(track.name ?? "")}|${raceNo}R`, date_jst: date, track: String(track.name ?? ""),
      race_no: raceNo, distance_m: typeof course.distance_m === "number" ? course.distance_m : null,
      surface: typeof course.surface === "string" ? course.surface : null,
      scheduled_start_at_jst: typeof race.scheduled_start_at === "string" ? race.scheduled_start_at : null,
    },
    cutoff_at: meta.cutoffAt, generated_at: meta.generatedAt, input_hash: meta.inputHash,
    inputs_attestation: { odds_used: false, popularity_used: false, external_forecasts_used: false },
    horses: active.map((n) => ({
      horse_number: n, win_probability: win.get(n),
      top3_probability: top3.size ? top3.get(n) ?? null : null,
      corner_ranks: cornerBy.size ? { first: cornerBy.get(n)?.first, last: cornerBy.get(n)?.last } : null,
      missing: null,
    })),
    pace: ["slow", "middle", "high"].includes(String(block.pace_class)) ? { class: block.pace_class, z: typeof block.pace_z === "number" ? block.pace_z : null } : null,
    reason_categories: Array.isArray(block.reason_categories) ? block.reason_categories : [],
  };
  const checked = validateForecast(record, active);
  return checked.ok ? { status: "valid", forecast: checked.forecast } : { status: "invalid", errors: checked.errors.slice(0, 8) };
}
