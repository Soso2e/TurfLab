import type { Repository } from "../../../packages/shared/src/repository";
import type { Row } from "../../../packages/shared/src/domain";
import { rankPerformance } from "./rank-analytics";

// Read-only snapshot for the next ChatGPT scheduled analysis.
// Only two JST dates are included; no secrets, tokens, raw audits or odds.
const jst = (iso: string) =>
  new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
const previousJst = (iso: string) =>
  new Date(Date.parse(iso) - 15 * 3600000).toISOString().slice(0, 10);
const pick = (row: Row, keys: string[]): Row =>
  Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
const asString = (value: unknown) => typeof value === "string" ? value : "";
const byRevision = (a: Row, b: Row) => Number(b.revision ?? 0) - Number(a.revision ?? 0);

export async function dailyStateExport(repo: Repository, now: string): Promise<Row> {
  const today = jst(now);
  const yesterday = previousJst(now);
  const names = [
    "races", "race_entries", "horses", "jockeys", "predictions",
    "horse_evaluations", "recommendations", "reference_plans",
    "reference_adoptions", "prediction_adoptions", "virtual_bets",
    "race_results", "payouts", "settlements", "reviews",
  ] as const;
  const entries = await Promise.all(names.map((name) => repo.list(name)));
  const db = Object.fromEntries(names.map((name, i) => [name, entries[i]])) as Record<typeof names[number], Row[]>;
  const races = db.races
    .filter((r) => r.race_date_jst === today || r.race_date_jst === yesterday)
    .sort((a, b) => asString(a.scheduled_start_at).localeCompare(asString(b.scheduled_start_at)));
  const resultsCount = races.filter((race) =>
    db.race_results.some((result) => result.race_id === race.race_id && result.official_status === "official"),
  ).length;
  const records = races.map((race) => {
    const raceId = race.race_id;
    const predictions = db.predictions.filter((p) => p.race_id === raceId && p.status === "locked");
    const result = db.race_results.filter((r) => r.race_id === raceId).sort(byRevision)[0];
    const bets = db.virtual_bets.filter((b) => b.race_id === raceId);
    return {
      race: pick(race, ["race_id", "race_date_jst", "race_number", "name", "jurisdiction", "scheduled_start_at", "status", "source", "is_estimated", "evidence_json"]),
      entries: db.race_entries.filter((e) => e.race_id === raceId).map((e) => ({
        ...pick(e, ["entry_id", "horse_id", "jockey_id", "horse_number", "draw_number", "carried_weight_kg", "status", "source", "evidence_json"]),
        horse_name: db.horses.find((h) => h.horse_id === e.horse_id)?.horse_name ?? null,
        jockey_name: db.jockeys.find((j) => j.jockey_id === e.jockey_id)?.jockey_name ?? null,
      })),
      predictions: predictions.map((p) => ({
        ...pick(p, ["prediction_id", "kind", "model_version_id", "snapshot_id", "information_cutoff_at", "locked_at", "status"]),
        evaluations: db.horse_evaluations.filter((e) => e.prediction_id === p.prediction_id).map((e) =>
          pick(e, ["entry_id", "rank", "score", "abilities_json", "expected_position", "evidence_json"]),
        ),
        recommendations: db.recommendations.filter((r) => r.prediction_id === p.prediction_id).map((r) =>
          pick(r, ["ticket_type", "selections_json", "suggested_amount_yen", "reason"]),
        ),
        reference_plan: db.reference_plans.filter((x) => x.prediction_id === p.prediction_id)
          .map((x) => pick(x, ["plan_id", "amount_yen", "status", "tickets_json"])),
      })),
      adopted_reference: db.reference_adoptions.filter((a) => a.race_id === raceId)
        .map((a) => pick(a, ["prediction_id", "plan_id", "adopted_at"])),
      adopted_prediction: db.prediction_adoptions.filter((a) => a.race_id === raceId)
        .map((a) => pick(a, ["prediction_id", "adopted_at"])),
      official_result: result ? {
        ...pick(result, ["result_id", "official_status", "published_at", "revision", "finish_order_json", "entry_status_json"]),
        payouts: db.payouts.filter((p) => p.result_id === result.result_id)
          .map((p) => pick(p, ["ticket_type", "selections_json", "payout_per_100_yen", "refund_rule_json"])),
      } : null,
      personal_bets: bets.map((b) => ({
        ...pick(b, ["bet_id", "prediction_id", "ticket_type", "selections_json", "amount_yen", "status", "confirmed_at"]),
        settlements: db.settlements.filter((s) => s.bet_id === b.bet_id)
          .map((s) => pick(s, ["result_id", "revision", "stake_yen", "payout_yen", "refund_yen", "net_yen", "status"])),
      })),
      reviews: db.reviews.filter((r) => r.race_id === raceId)
        .map((r) => pick(r, ["prediction_id", "result_id", "reviewed_at", "observations_json", "hypotheses_json", "unknowns_json", "validation_plan_json"])),
    };
  });
  return {
    schema_version: "1",
    report_type: "turfLab_daily_state",
    report_date_jst: today,
    generated_at: now,
    included_dates_jst: [yesterday, today],
    origin: "authenticated_turflab_core_read_only",
    ranking_metrics: await rankPerformance(repo),
    counts: { races: races.length, official_results: resultsCount, locked_predictions: records.reduce((n, r) => n + r.predictions.length, 0) },
    races: records,
    limitations: [
      "このファイルは出力時点のスナップショット。後から確定した公式結果や修正は自動反映されない。",
      "未保存のChatGPT参考分析は含まれない。出力に存在しないレースを予想未実施と断定しない。",
      "本人購入とAI参考推奨を混同しない。収支は確定settlementを確認してから計算する。",
    ],
  };
}
