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
【独立評価とAI展開判断 v2】
オッズ・人気・市場期待値を見る前に、次の順で全出走馬について考える。
1) horse_marks: 今回の騎手の巧拙を混ぜず、能力・近走5走（直近を重視）・距離・馬場・脚質・コースから馬の印を決める。
2) jockey_marks: 今回の馬の能力を混ぜず、騎手の同場・距離帯実績、位置取り、逃げ/先行/差し技術、近況を評価する。勝率には騎乗馬の質・標本数の偏りがあることに注意。各項目の根拠不足は不明とする。
3) partnership_marks: 馬の脚質と騎手の戦術、人馬の実績、乗り替わりを独立評価し、適合・不適合の理由を書く。過去に組んだことがない場合は不明、相性が悪いと断定しない。
4) scenario_decision: スロー/平均/ハイの3仮説を比較し、主展開の隊列・ペース・仕掛け・想定上位馬と、覆る条件を文章で書く。
5) final_marks: 1-4を統合して最終印。元の印から変えた馬と理由を示す。数字の順位だけで最終印を決めない。
6) ai_bet_decision: "bet" または "skip"。比較用の従来 hit_picks（600円枠）とは別に、ai_bet_picks を最大3点・合計1000円以下・100円単位で自由提案する。券種は win/place/wide/quinella/exacta/trio/trifecta の7種類。ai_bet_picks:[{ticket_type,selections_json:[馬番],amount_yen,rationale}]。券種を無理に埋めず、同一買い目の重複なし。見送りなら ai_bet_picks=[]。払戻の情報がない段階で利益があると断言しない。券種・馬番・金額はコード側で再検証して不備があれば見送る。
出力フィールド（従来フィールドは残す）:
horse_marks:[{horse_number,mark,reason,evidence_ids:[]}],
jockey_marks:[{horse_number,mark,reason,evidence_ids:[],sample_size:nullまたは整数}],
partnership_marks:[{horse_number,mark,reason,evidence_ids:[]}],
final_marks:[{horse_number,mark,reason}],
scenario_decision:{main_pace,pace_reason,expected_order:[馬番],counter_scenario},
ai_bet_decision:"bet"|"skip",ai_bet_reason:文字列,ai_bet_picks:[{ticket_type,selections_json,amount_yen,rationale}]。
【数値予測の提出（必須・forecast-v1）】印とは別に、検証可能な数値予測を forecast に必ず出す。オッズ・人気・外部予想・新聞印は一切参照しない（参照していないことが検証される）。
forecast:{
 win_probabilities:[{horse_number,p}]  // 全出走馬。合計1。極端な値を恐れず、根拠が弱い馬も均等割りに逃げず差をつける
 top3_probabilities:[{horse_number,p}]  // 全出走馬。3着内確率。合計は約3
 corner_ranks:[{horse_number,first,last}]  // 全出走馬。最初と最後のコーナー通過順位の想定。1..頭数の順列（同順位なし）
 pace_class:"slow"|"middle"|"high", pace_z:数値または null  // 同コース・同距離の平常ペースとの相対
 reason_categories:[${REASON_CATEGORIES.map((c) => `"${c}"`).join(",")} から、この予測を市場でなく根拠として動かした要因を選ぶ]
}
forecast が欠測・不正でも印と買い目は有効だが、その予想は精度検証の対象外として記録される。
各印は ◎ ○ ▲ △ ☆ 無印 不明 から選ぶ。馬番は出馬表と一致。根拠がない項目に数値や事実を創作しない。6項目の定量評価やPython統計は補助材料として利用し、最終判断は整合する根拠に基づきAIが説明する。
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
