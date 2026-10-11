export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = { [key: string]: Json };
export const tableDefinitions = {
  tracks: ["track_id", "name jurisdiction location timezone"],
  course_layouts: [
    "course_id",
    "track_id surface distance_m direction layout rail_setting straight_length_m elevation_profile_json turn_geometry_json start_to_first_turn_m course_width_m revision",
  ],
  horses: [
    "horse_id",
    "horse_name sex birth_date pedigree_json trainer_external_id",
  ],
  jockeys: ["jockey_id", "jockey_name affiliation"],
  races: [
    "race_id",
    "course_id jurisdiction external_id race_date_jst race_number name scheduled_start_at status",
  ],
  race_entries: [
    "entry_id",
    "race_id horse_id jockey_id horse_number draw_number carried_weight_kg status",
  ],
  performances: [
    "performance_id",
    "horse_id race_id jockey_id finish_position finish_time_s last_3f_s corner_positions_json draw_number horse_number carried_weight_kg body_weight_kg body_weight_change_kg going margin pace_observed running_style_observed trouble_notes",
  ],
  race_snapshots: [
    "snapshot_id",
    "race_id captured_at weather going temperature_c wind_json track_bias_json bias_sample_size expected_pace entries_state_json scratch_status_json odds_snapshot_ids_json input_hash",
  ],
  model_versions: [
    "model_version_id",
    "provider model_identifier prompt_version prompt_hash feature_version weights_json engine_version parameters_json training_cutoff_at status",
  ],
  predictions: [
    "prediction_id",
    "race_id model_version_id snapshot_id revision kind status predicted_at information_cutoff_at locked_at supersedes_prediction_id input_hash feature_ids_json rationale import_id",
  ],
  horse_evaluations: [
    "evaluation_id",
    "prediction_id entry_id rank score win_probability top3_probability abilities_json course_fit jockey_fit expected_position evidence_json",
  ],
  simulation_runs: [
    "simulation_id",
    "prediction_id mode status scenarios_json engine_version input_hash seed trial_count outputs_json started_at completed_at",
  ],
  recommendations: [
    "recommendation_id",
    "prediction_id simulation_id ticket_type selections_json estimated_probability odds_snapshot_id estimated_ev suggested_amount_yen reason",
  ],
  virtual_bets: [
    "bet_id",
    "race_id prediction_id recommendation_id ticket_type selections_json amount_yen confirmed_at budget_date_jst status operation_id",
  ],
  race_results: [
    "result_id",
    "race_id revision official_status published_at finish_order_json entry_status_json supersedes_result_id",
  ],
  payouts: [
    "payout_id",
    "result_id ticket_type selections_json payout_per_100_yen refund_rule_json",
  ],
  settlements: [
    "settlement_id",
    "bet_id result_id revision stake_yen payout_yen refund_yen net_yen status settled_at supersedes_settlement_id",
  ],
  reviews: [
    "review_id",
    "race_id prediction_id result_id model_version_id observations_json hypotheses_json unknowns_json validation_plan_json reviewed_at",
  ],
  daily_runs: [
    "daily_run_id",
    "run_date_jst run_kind operation_id status race_ids_json expected_counts_json completed_counts_json started_at completed_at",
  ],
  run_logs: [
    "log_id",
    "daily_run_id race_id operation_id stage attempt status error_code safe_message expected_hash actual_hash",
  ],
  course_segments: [
    "segment_id",
    "course_id sequence start_m end_m gradient curvature",
  ],
  entity_features: [
    "feature_id",
    "horse_id jockey_id feature_version evaluation_at cutoff_at sample_size confidence features_json performance_ids_json",
  ],
  odds_snapshots: [
    "odds_snapshot_id",
    "race_id captured_at ticket_type selections_json odds",
  ],
  prediction_adoptions: [
    "adoption_id",
    "race_id prediction_id adopted_at selection_rule_version",
  ],
  import_operations: [
    "import_id",
    "idempotency_key payload_hash expected_rows_json stage_checkpoint_json status completed_at",
  ],
  audit_events: [
    "event_id",
    "operation_id actor action entity_type entity_id before_hash after_hash event_at",
  ],
} as const;
export type Table = keyof typeof tableDefinitions;
export const tables = Object.keys(tableDefinitions) as Table[];
export const commonColumns = [
  "schema_version",
  "created_at",
  "source",
  "source_url",
  "retrieved_at",
  "valid_as_of",
  "available_at",
  "is_estimated",
  "confidence",
  "sample_size",
  "evidence_json",
];
export function columns(table: Table): string[] {
  return [
    ...new Set([
      tableDefinitions[table][0],
      ...commonColumns,
      ...tableDefinitions[table][1].split(" "),
    ]),
  ];
}
export function idOf(table: Table, row: Row): string {
  return str(row, tableDefinitions[table][0]);
}
export function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new DomainError(`${key}: 文字列が必要です`);
  return v;
}
export function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new DomainError(`${key}: 有限数が必要です`);
  return v;
}
export function arr(row: Row, key: string): Json[] {
  const v = row[key];
  if (!Array.isArray(v)) throw new DomainError(`${key}: 配列が必要です`);
  return v;
}
export function obj(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("オブジェクトが必要です");
  return value as Row;
}
export function rows(value: Json): Row[] {
  if (!Array.isArray(value)) throw new DomainError("配列が必要です");
  return value.map(obj);
}
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function requireCondition(
  condition: unknown,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new DomainError(message, status);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function hash(value: unknown): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function instant(value: Json): number {
  requireCondition(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT.*(?:Z|\+00:00)$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "UTCのISO日時が必要です",
  );
  return Date.parse(value);
}
export function jstDate(time: string): string {
  return new Date(Date.parse(time) + 9 * 3600000).toISOString().slice(0, 10);
}
export function asOf(row: Row, cutoff: string): void {
  const limit = instant(cutoff);
  for (const k of ["valid_as_of", "available_at", "retrieved_at"]) {
    const value = row[k] ?? (k === "available_at" ? row.retrieved_at : null);
    requireCondition(
      value !== null && value !== undefined && instant(value) <= limit,
      `${k}: 不明または情報締切後です`,
    );
  }
  if (row.cutoff_at != null)
    requireCondition(instant(row.cutoff_at) <= limit, "特徴量の締切違反");
}
export const ticketSizes: Record<string, number> = {
  win: 1,
  place: 1,
  quinella: 2,
  wide: 2,
  exacta: 2,
  trio: 3,
  trifecta: 3,
};
export function ticket(
  type: string,
  selections: Json,
  validNumbers?: number[],
): number[] {
  requireCondition(
    type in ticketSizes && Array.isArray(selections),
    "券種・買い目が不正です",
  );
  const ns = selections as number[];
  requireCondition(
    ns.length === ticketSizes[type] &&
      ns.every(
        (n) =>
          Number.isInteger(n) &&
          n > 0 &&
          (!validNumbers || validNumbers.includes(n)),
      ) &&
      new Set(ns).size === ns.length,
    "買い目の頭数・馬番・重複が不正です",
  );
  return ["quinella", "wide", "trio"].includes(type)
    ? [...ns].sort((a, b) => a - b)
    : [...ns];
}
export function money(value: Json, allowZero = false): number {
  requireCondition(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (allowZero ? 0 : 100) &&
      value % 100 === 0,
    "金額は100円単位です",
  );
  return value;
}
export const references: Partial<Record<Table, Record<string, Table>>> = {
  course_layouts: { track_id: "tracks" },
  races: { course_id: "course_layouts" },
  race_entries: { race_id: "races", horse_id: "horses", jockey_id: "jockeys" },
  performances: { horse_id: "horses", race_id: "races", jockey_id: "jockeys" },
  race_snapshots: { race_id: "races" },
  predictions: {
    race_id: "races",
    snapshot_id: "race_snapshots",
    model_version_id: "model_versions",
    supersedes_prediction_id: "predictions",
  },
  horse_evaluations: { prediction_id: "predictions", entry_id: "race_entries" },
  simulation_runs: { prediction_id: "predictions" },
  recommendations: {
    prediction_id: "predictions",
    simulation_id: "simulation_runs",
    odds_snapshot_id: "odds_snapshots",
  },
  virtual_bets: {
    race_id: "races",
    prediction_id: "predictions",
    recommendation_id: "recommendations",
  },
  race_results: { race_id: "races", supersedes_result_id: "race_results" },
  payouts: { result_id: "race_results" },
  settlements: {
    bet_id: "virtual_bets",
    result_id: "race_results",
    supersedes_settlement_id: "settlements",
  },
  reviews: {
    race_id: "races",
    prediction_id: "predictions",
    result_id: "race_results",
    model_version_id: "model_versions",
  },
  course_segments: { course_id: "course_layouts" },
  entity_features: { horse_id: "horses", jockey_id: "jockeys" },
  odds_snapshots: { race_id: "races" },
  prediction_adoptions: { race_id: "races", prediction_id: "predictions" },
  run_logs: { daily_run_id: "daily_runs", race_id: "races" },
};
export function validateRow(table: Table, row: Row): void {
  requireCondition(row.schema_version === "0.2", "schema_versionは0.2です");
  requireCondition(idOf(table, row).length > 0, "安定IDが必要です");
  for (const [key, value] of Object.entries(row)) {
    requireCondition(
      columns(table).includes(key),
      `${table}.${key}: 未知の列です`,
    );
    if (typeof value === "number")
      requireCondition(Number.isFinite(value), `${key}: 有限数が必要です`);
    if (
      value !== null &&
      (key.endsWith("_at") ||
        ["retrieved_at", "valid_as_of", "available_at"].includes(key))
    )
      instant(value);
    if (value !== null && (key.includes("probability") || key === "confidence"))
      requireCondition(
        typeof value === "number" && value >= 0 && value <= 1,
        `${key}: 0〜1です`,
      );
  }
  const required: Partial<Record<Table, string[]>> = {
    tracks: ["name", "jurisdiction"],
    course_layouts: ["track_id", "surface", "distance_m", "revision"],
    horses: ["horse_name"],
    jockeys: ["jockey_name"],
    races: [
      "course_id",
      "jurisdiction",
      "external_id",
      "race_number",
      "source",
    ],
    race_entries: [
      "race_id",
      "horse_id",
      "jockey_id",
      "horse_number",
      "status",
    ],
    performances: ["horse_id", "race_id", "jockey_id"],
    race_snapshots: [
      "race_id",
      "captured_at",
      "input_hash",
      "entries_state_json",
      "odds_snapshot_ids_json",
    ],
    predictions: [
      "race_id",
      "snapshot_id",
      "model_version_id",
      "status",
      "information_cutoff_at",
      "input_hash",
    ],
    model_versions: [
      "provider",
      "model_identifier",
      "feature_version",
      "status",
    ],
    entity_features: ["feature_version", "cutoff_at", "performance_ids_json"],
  };
  for (const key of required[table] ?? [])
    requireCondition(row[key] != null, `${table}.${key}: 必須です`);
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue;
    if (key.endsWith("_id"))
      requireCondition(
        typeof value === "string" && value.length > 0,
        `${key}: 安定IDは文字列です`,
      );
    if (key.endsWith("_json"))
      requireCondition(
        typeof value === "object",
        `${key}: JSON配列・オブジェクトが必要です`,
      );
    if (
      [
        "distance_m",
        "race_number",
        "horse_number",
        "draw_number",
        "revision",
        "sample_size",
        "rank",
        "trial_count",
        "seed",
      ].includes(key)
    )
      requireCondition(
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
        `${key}: 非負整数です`,
      );
    if (
      [
        "finish_time_s",
        "last_3f_s",
        "carried_weight_kg",
        "body_weight_kg",
        "odds",
      ].includes(key)
    )
      requireCondition(
        typeof value === "number" && Number.isFinite(value) && value > 0,
        `${key}: 正の数です`,
      );
  }
  if (table === "races") {
    requireCondition(
      ["scheduled", "started", "provisional", "official", "cancelled"].includes(
        str(row, "status"),
      ),
      "レース状態が不正です",
    );
    instant(row.scheduled_start_at);
    requireCondition(
      /^\d{4}-\d\d-\d\d$/.test(str(row, "race_date_jst")),
      "開催日が不正です",
    );
  }
  if (table === "race_entries") {
    requireCondition(
      ["active", "scratched", "cancelled"].includes(str(row, "status")),
      "出走状態が不正です",
    );
    requireCondition(
      Number.isInteger(num(row, "horse_number")) &&
        num(row, "horse_number") > 0,
      "馬番が不正です",
    );
  }
}

export function snapshotContents(row: Row): Row {
  const keys = [
    "race_id",
    "captured_at",
    "entries_state_json",
    "scratch_status_json",
    "odds_snapshot_ids_json",
    "weather",
    "going",
    "temperature_c",
    "wind_json",
    "track_bias_json",
    "bias_sample_size",
    "expected_pace",
  ];
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}
