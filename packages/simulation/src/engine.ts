import {
  asOf,
  hash,
  requireCondition,
  type Json,
  ticket,
  instant,
  type Row,
} from "../../shared/src/domain";
export const ENGINE_VERSION = "segment-mc-v1";
export interface Runner {
  entry_id: string;
  horse_number: number;
  speed: number;
  stamina: number;
  acceleration: number;
  early_position: number;
  jockey_control: number;
  draw: number;
  going_fit: number;
  confidence: number;
  source: Row;
}
export interface Segment {
  length_m: number;
  gradient: number;
  curvature: number;
  phase: "start" | "early" | "middle" | "turn" | "straight" | "finish";
}
export interface SimulationInput {
  place_positions?: number | null;
  cutoff_at: string;
  distance_m: number;
  going_factor: number;
  segments: Segment[];
  runners: Runner[];
  scenarios: { pace: "slow" | "middle" | "high"; weight: number }[];
}
export interface SimulationOutput {
  place_positions: number | null;
  horse_numbers: number[];
  engine_version: string;
  input_hash: string;
  seed: number;
  trial_count: number;
  rank_probabilities: Record<string, number[]>;
  win_probabilities: Record<string, number>;
  top3_probabilities: Record<string, number>;
  ticket_probabilities: Record<string, number>;
  limitations: string;
}
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function validateSimulation(
  input: SimulationInput,
  seed: number,
  trials: number,
) {
  requireCondition(
    Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff,
    "seedはuint32です",
  );
  requireCondition(
    Number.isInteger(trials) && trials >= 100 && trials <= 10000,
    "試行回数は100〜10,000です",
  );
  requireCondition(
    Array.isArray(input.runners) &&
      input.runners.length >= 2 &&
      input.runners.length <= 18,
    "出走馬は2〜18頭です",
  );
  requireCondition(
    Number.isFinite(input.distance_m) &&
      input.distance_m > 0 &&
      Number.isFinite(input.going_factor) &&
      input.going_factor >= 0.5 &&
      input.going_factor <= 1.5,
    "距離・馬場係数が不正です",
  );
  requireCondition(
    input.segments.length >= 2 &&
      input.segments.every(
        (s) =>
          Number.isFinite(s.length_m) &&
          s.length_m > 0 &&
          Number.isFinite(s.gradient) &&
          Math.abs(s.gradient) <= 0.2 &&
          Number.isFinite(s.curvature) &&
          s.curvature >= 0 &&
          s.curvature <= 1 &&
          ["start", "early", "middle", "turn", "straight", "finish"].includes(
            s.phase,
          ),
      ),
    "区間入力が不正です",
  );
  requireCondition(
    Math.abs(
      input.segments.reduce((n, s) => n + s.length_m, 0) - input.distance_m,
    ) < 0.01,
    "区間長の合計が距離と不一致です",
  );
  if (input.place_positions != null)
    requireCondition(
      Number.isInteger(input.place_positions) &&
        input.place_positions >= 1 &&
        input.place_positions <= Math.min(3, input.runners.length),
      "公式の複勝払戻対象順位が不正です",
    );
  requireCondition(
    input.scenarios.length > 0 &&
      input.scenarios.every(
        (s) =>
          ["slow", "middle", "high"].includes(s.pace) &&
          Number.isFinite(s.weight) &&
          s.weight >= 0 &&
          s.weight <= 1,
      ) &&
      Math.abs(input.scenarios.reduce((n, s) => n + s.weight, 0) - 1) < 0.001,
    "ペース重みが不正です",
  );
  requireCondition(
    new Set(input.runners.map((r) => r.entry_id)).size ===
      input.runners.length &&
      new Set(input.runners.map((r) => r.horse_number)).size ===
        input.runners.length,
    "出走馬ID・馬番の重複です",
  );
  for (const r of input.runners) {
    requireCondition(
      typeof r.entry_id === "string" &&
        r.entry_id.length > 0 &&
        Number.isInteger(r.horse_number) &&
        r.horse_number > 0 &&
        Number.isInteger(r.draw) &&
        r.draw > 0 &&
        r.draw <= 18,
      "出走馬ID・馬番・枠が不正です",
    );
    for (const key of [
      "speed",
      "stamina",
      "acceleration",
      "early_position",
      "jockey_control",
      "going_fit",
      "confidence",
    ] as const)
      requireCondition(
        Number.isFinite(r[key]) && r[key] >= 0 && r[key] <= 1,
        `${r.entry_id}.${key}: 欠測または0〜1範囲外です`,
      );
    asOf(r.source, input.cutoff_at);
  }
}
export async function simulate(
  input: SimulationInput,
  seed: number,
  trialCount: number,
): Promise<SimulationOutput> {
  validateSimulation(input, seed, trialCount);
  const rng = random(seed);
  const ranks: Record<string, number[]> = {};
  const wins: Record<string, number> = {};
  const tops: Record<string, number> = {};
  const tickets: Record<string, number> = {};
  input.runners.forEach((r) => {
    ranks[r.entry_id] = Array(input.runners.length).fill(0);
    wins[r.entry_id] = 0;
    tops[r.entry_id] = 0;
  });
  const count = (type: string, ns: number[]) => {
    const order = ["quinella", "wide", "trio"].includes(type)
      ? [...ns].sort((a, b) => a - b)
      : ns;
    const k = type + ":" + order.join("-");
    tickets[k] = (tickets[k] ?? 0) + 1;
  };
  for (let trial = 0; trial < trialCount; trial++) {
    let choice = rng(),
      pace = "middle";
    for (const s of input.scenarios) {
      choice -= s.weight;
      if (choice <= 0) {
        pace = s.pace;
        break;
      }
    }
    const paceFactor = pace === "high" ? 1.08 : pace === "slow" ? 0.94 : 1;
    const sharedGoing = (rng() - 0.5) * 0.015;
    const result = input.runners
      .map((r) => {
        let time = 0,
          fatigue = 0,
          position = r.early_position;
        const startDelay =
          rng() < 0.06
            ? (0.15 + rng() * 0.6) * (1 - r.jockey_control * 0.3)
            : 0;
        for (const segment of input.segments) {
          const effort = paceFactor * (0.96 + position * 0.08);
          fatigue +=
            (segment.length_m / input.distance_m) *
            effort *
            (1.15 - r.stamina * 0.5);
          const turnLoss =
            segment.curvature *
            (r.draw - 1) *
            0.1 *
            (1 - r.jockey_control * 0.4);
          const slope = segment.gradient * (1.2 - r.stamina * 0.4);
          const acceleration = ["straight", "finish"].includes(segment.phase)
            ? r.acceleration * 0.045
            : 0;
          const uncertainty =
            (rng() - 0.5) * (0.05 + (1 - r.confidence) * 0.08);
          const velocity = Math.max(
            6,
            (13 + r.speed * 5) *
              input.going_factor *
              (0.94 + r.going_fit * 0.06 + sharedGoing) *
              (1 +
                acceleration -
                fatigue * 0.05 -
                slope -
                turnLoss * 0.01 +
                uncertainty),
          );
          time += segment.length_m / velocity;
          position = Math.max(
            0,
            Math.min(1, position + (rng() - 0.5) * 0.15 * r.jockey_control),
          );
        }
        return { runner: r, time: time + startDelay };
      })
      .sort((a, b) => a.time - b.time);
    result.forEach((x, index) => {
      ranks[x.runner.entry_id][index]++;
      if (index === 0) wins[x.runner.entry_id]++;
      if (index < 3) tops[x.runner.entry_id]++;
    });
    const ns = result.map((x) => x.runner.horse_number);
    count("win", [ns[0]]);
    ns.slice(0, input.place_positions ?? 0).forEach((n) => count("place", [n]));
    count("quinella", ns.slice(0, 2));
    count("exacta", ns.slice(0, 2));
    const top = ns.slice(0, 3);
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) count("wide", [top[i], top[j]]);
    if (ns.length >= 3) {
      count("trio", top);
      count("trifecta", top);
    }
  }
  Object.keys(ranks).forEach((k) => {
    ranks[k] = ranks[k].map((n) => n / trialCount);
    wins[k] /= trialCount;
    tops[k] /= trialCount;
  });
  Object.keys(tickets).forEach((k) => (tickets[k] /= trialCount));
  return {
    place_positions: input.place_positions ?? null,
    horse_numbers: input.runners.map((r) => r.horse_number),
    engine_version: ENGINE_VERSION,
    input_hash: await hash(input),
    seed,
    trial_count: trialCount,
    rank_probabilities: ranks,
    win_probabilities: wins,
    top3_probabilities: tops,
    ticket_probabilities: tickets,
    limitations:
      "未検証の区間モデル。能力・馬場・騎手の相互作用は仮説です。試行回数は精度の保証ではありません。欠測能力は補完せず実行を拒否します。",
  };
}
export function expectedValues(
  output: SimulationOutput,
  odds: {
    ticket_type: string;
    selections: number[];
    odds: number;
    source: Row;
  }[],
  cutoff: string,
): Row[] {
  return odds.map((o) => {
    asOf(o.source, cutoff);
    requireCondition(Number.isFinite(o.odds) && o.odds > 0, "オッズが不正です");
    if (o.source.captured_at != null)
      requireCondition(
        instant(o.source.captured_at) <= instant(cutoff),
        "オッズ観測が締切後です",
      );
    if (o.ticket_type === "place")
      requireCondition(
        output.place_positions !== null,
        "公式の複勝払戻対象順位が未取得です",
      );
    const ns = ticket(o.ticket_type, o.selections, output.horse_numbers);
    const key = o.ticket_type + ":" + ns.join("-");
    const p = output.ticket_probabilities[key] ?? 0;
    return {
      ticket_type: o.ticket_type,
      selections: ns as Json[],
      estimated_probability: p,
      estimated_ev: p * o.odds,
    };
  });
}
