import { obj, rows, type Row } from "../packages/shared/src/domain";

/** Structured, independent judgements. These marks are opinions, never fabricated observations. */
const MARKS = new Set(["◎", "○", "▲", "△", "☆", "無印", "?", "不明"]);
const LIMIT = 400;
const clean = (v: unknown) => typeof v === "string" ? v.slice(0, LIMIT) : "";
const mark = (v: unknown) => typeof v === "string" && MARKS.has(v) ? v : "不明";

export const INDEPENDENT_ASSESSMENT_PROMPT = `
【独立評価とAI展開判断 v2】
オッズ・人気・市場期待値を見る前に、次の順で全出走馬について考える。
1) horse_marks: 今回の騎手の巧拙を混ぜず、能力・近走3走・距離・馬場・脚質・コースから馬の印を決める。
2) jockey_marks: 今回の馬の能力を混ぜず、騎手の同場・距離帯実績、位置取り、逃げ/先行/差し技術、近況を評価する。勝率には騎乗馬の質・標本数の偏りがあることに注意。各項目の根拠不足は不明とする。
3) partnership_marks: 馬の脚質と騎手の戦術、人馬の実績、乗り替わりを独立評価し、適合・不適合の理由を書く。過去に組んだことがない場合は不明、相性が悪いと断定しない。
4) scenario_decision: スロー/平均/ハイの3仮説を比較し、主展開の隊列・ペース・仕掛け・想定上位馬と、覆る条件を文章で書く。
5) final_marks: 1-4を統合して最終印。元の印から変えた馬と理由を示す。数字の順位だけで最終印を決めない。
6) ai_bet_decision: "bet" または "skip"。買う場合の hit_picks は展開仮説に対応する必要最小限の組合せだけ（合計600円以下、100円単位、0点も可）。券種を埋めるための買い目は作らない。同じ2頭を軸に複数券種を購入する場合は重複リスクを説明する。見送りなら hit_picks=[]。オッズが無い段階では利益が見込めると断言しない。
出力フィールド（従来フィールドは残す）:
horse_marks:[{horse_number,mark,reason,evidence_ids:[]}],
jockey_marks:[{horse_number,mark,reason,evidence_ids:[],sample_size:nullまたは整数}],
partnership_marks:[{horse_number,mark,reason,evidence_ids:[]}],
final_marks:[{horse_number,mark,reason}],
scenario_decision:{main_pace,pace_reason,expected_order:[馬番],counter_scenario},
ai_bet_decision:"bet"|"skip",ai_bet_reason:文字列。
各印は ◎ ○ ▲ △ ☆ 無印 不明 から選ぶ。馬番は出馬表と一致。根拠がない項目に数値や事実を創作しない。6項目の定量評価やPython統計は補助材料として利用し、最終判断は整合する根拠に基づきAIが説明する。
`;

function normalizeMarks(raw: unknown, valid: Set<number>, withSample = false): Row[] | null {
  const data = rows(raw);
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
  const scenario = obj(answer.scenario_decision);
  if (!horse || !jockey || !partnership || !final || !["slow", "middle", "high"].includes(String(scenario.main_pace))) return null;
  const order = Array.isArray(scenario.expected_order) ? scenario.expected_order.map(Number) : [];
  if (!order.length || order.some(n => !valid.has(n)) || new Set(order).size !== order.length) return null;
  if (answer.ai_bet_decision !== "bet" && answer.ai_bet_decision !== "skip") return null;
  return {
    version: "independent-ai-v2",
    horse_marks: horse, jockey_marks: jockey, partnership_marks: partnership, final_marks: final,
    scenario_decision: {
      main_pace: scenario.main_pace, pace_reason: clean(scenario.pace_reason),
      expected_order: order.slice(0, 5), counter_scenario: clean(scenario.counter_scenario),
    },
    ai_bet_decision: answer.ai_bet_decision,
    ai_bet_reason: clean(answer.ai_bet_reason),
  };
}
