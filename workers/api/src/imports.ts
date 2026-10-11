import Ajv from "ajv";
import validate from "./import-validator.js";
import {
  arr,
  asOf,
  canonical,
  hash,
  idOf,
  instant,
  money,
  num,
  obj,
  requireCondition,
  rows,
  str,
  snapshotContents,
  ticket,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import {
  get,
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
const ajv = new Ajv({ allErrors: true, strict: false });
export function validateStructure(payload: unknown): Row {
  requireCondition(
    validate(payload),
    ajv.errorsText(validate.errors, { separator: "\n" }),
  );
  return obj(payload);
}
export async function validatePrediction(
  repo: Repository,
  p: Row,
  now: string,
  example = false,
): Promise<string[]> {
  const race = await get(repo, "races", str(p, "race_id"));
  const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
  requireCondition(
    snapshot.input_hash === (await hash(snapshotContents(snapshot))),
    "snapshot内容のハッシュ不一致",
  );
  const model = await get(repo, "model_versions", str(p, "model_version_id"));
  requireCondition(snapshot.race_id === race.race_id, "snapshotは別レースです");
  const cutoff = str(p, "information_cutoff_at");
  requireCondition(
    instant(cutoff) <= instant(now) &&
      instant(cutoff) < instant(race.scheduled_start_at),
    "情報締切は発走前です",
  );
  requireCondition(
    instant(snapshot.captured_at) <= instant(cutoff),
    "snapshotが締切後です",
  );
  asOf(snapshot, cutoff);
  if (model.training_cutoff_at != null)
    requireCondition(
      instant(model.training_cutoff_at) <= instant(cutoff),
      "モデルの学習時点違反",
    );
  for (const id of arr(snapshot, "odds_snapshot_ids_json")) {
    requireCondition(typeof id === "string", "オッズIDが不正です");
    const odds = await get(repo, "odds_snapshots", id);
    requireCondition(
      odds.race_id === race.race_id,
      "snapshotのオッズは別レースです",
    );
    asOf(odds, cutoff);
    requireCondition(
      instant(odds.captured_at) <= instant(cutoff),
      "オッズ観測が締切後です",
    );
  }
  const validEntries = (await repo.list("race_entries")).filter(
    (x) => x.race_id === race.race_id && x.status === "active",
  );
  const evaluations = rows(p.horse_evaluations);
  const fixedEntries = rows(snapshot.entries_state_json);
  requireCondition(
    canonical(
      fixedEntries
        .filter((e) => e.status === "active")
        .map((e) => e.entry_id)
        .sort(),
    ) === canonical(validEntries.map((e) => e.entry_id).sort()),
    "snapshotと有効出走馬の対応が不一致です",
  );
  requireCondition(
    validEntries.length > 0 &&
      canonical(validEntries.map((x) => x.entry_id).sort()) ===
        canonical(evaluations.map((x) => x.entry_id).sort()),
    "評価対象は全有効出走馬と一致する必要があります",
  );
  const sum = (key: string) => evaluations.reduce((v, x) => v + num(x, key), 0);
  requireCondition(
    Math.abs(sum("win_probability") - 1) <= 0.001,
    "勝率合計は1です",
  );
  requireCondition(
    Math.abs(sum("top3_probability") - Math.min(3, validEntries.length)) <=
      0.001,
    "複勝圏確率の合計が不正です",
  );
  requireCondition(
    new Set(evaluations.map((x) => x.rank)).size === evaluations.length &&
      evaluations.every((x) => num(x, "rank") <= evaluations.length),
    "評価順位が重複または範囲外です",
  );
  const evidence = rows(p.evidence);
  const evidenceIds = evidence.map((x) => x.evidence_id);
  requireCondition(
    new Set(evidenceIds).size === evidence.length,
    "出典IDが重複しています",
  );
  const warnings: string[] = [];
  for (const e of evidence) {
    asOf(e, cutoff);
    const u = new URL(str(e, "source_url"));
    requireCondition(
      ["https:", "http:"].includes(u.protocol),
      "出典URLはHTTP(S)です",
    );
    if (e.confirmed !== true || u.hostname.endsWith(".invalid"))
      warnings.push(`${e.evidence_id}: 出典の確認待ち`);
  }
  const sim = obj(p.simulation);
  for (const e of [...evaluations, sim]) {
    requireCondition(
      arr(e, "evidence_ids").length > 0 &&
        arr(e, "evidence_ids").every((id) => evidenceIds.includes(id)),
      "根拠IDの参照不足",
    );
    if (e.win_probability != null)
      requireCondition(
        num(e, "top3_probability") >= num(e, "win_probability"),
        "複勝圏確率は勝率以上です",
      );
  }
  const scenarios = rows(sim.scenarios);
  requireCondition(
    Math.abs(scenarios.reduce((s, x) => s + num(x, "weight"), 0) - 1) <= 0.001,
    "シナリオ重み合計は1です",
  );
  if (sim.mode === "narrative")
    requireCondition(
      sim.engine_version === null &&
        sim.seed === null &&
        sim.trial_count === null,
      "文章分析に数値実行証跡は指定できません",
    );
  else {
    const numeric = await get(
      repo,
      "simulation_runs",
      str(sim, "simulation_id"),
    );
    requireCondition(
      numeric.mode === "numeric" &&
        numeric.status === "complete" &&
        numeric.prediction_id === p.prediction_id &&
        numeric.input_hash === sim.input_hash &&
        numeric.engine_version === sim.engine_version &&
        numeric.seed === sim.seed &&
        numeric.trial_count === sim.trial_count,
      "数値実行台帳と一致しません",
    );
  }
  const recs = rows(p.recommendations);
  const seen = new Set<string>();
  let total = 0;
  for (const r of recs) {
    const selection = ticket(
      str(r, "ticket_type"),
      r.selections,
      validEntries.map((x) => num(x, "horse_number")),
    );
    const key = canonical([r.ticket_type, selection]);
    requireCondition(!seen.has(key), "推奨買い目が重複しています");
    seen.add(key);
    total += money(r.suggested_amount_yen, true);
    if (r.odds_snapshot_id != null) {
      const odds = await get(
        repo,
        "odds_snapshots",
        str(r, "odds_snapshot_id"),
      );
      requireCondition(
        odds.race_id === race.race_id &&
          odds.ticket_type === r.ticket_type &&
          canonical(ticket(str(odds, "ticket_type"), odds.selections_json)) ===
            canonical(selection),
        "オッズの買い目参照が不正です",
      );
      asOf(odds, cutoff);
      requireCondition(
        instant(odds.captured_at) <= instant(cutoff),
        "オッズ取得が締切後です",
      );
      const ev = num(r, "estimated_probability") * num(odds, "odds");
      if (r.estimated_ev != null)
        requireCondition(
          Math.abs(num(r, "estimated_ev") - ev) < 0.001,
          "オッズ期待値が一致しません",
        );
    } else
      requireCondition(r.estimated_ev == null, "オッズなしの期待値はnullです");
  }
  requireCondition(total <= 1000, "推奨額はレース合計1,000円以内です");
  if (!recs.length)
    requireCondition(
      typeof p.skip_reason === "string" && p.skip_reason.length > 0,
      "推奨なしの理由が必要です",
    );
  for (const id of (p.feature_ids ?? []) as string[]) {
    const f = await get(repo, "entity_features", id);
    asOf(f, cutoff);
    requireCondition(
      f.feature_version === model.feature_version,
      "特徴量版が不一致です",
    );
    for (const pid of (f.performance_ids_json ?? []) as string[])
      asOf(await get(repo, "performances", pid), cutoff);
  }
  if (example) warnings.push("架空サンプルは確定できません");
  return warnings;
}
export async function preview(
  repo: Repository,
  payload: unknown,
  now: string,
): Promise<Row> {
  const input = validateStructure(payload);
  requireCondition(
    instant(input.generated_at) <= instant(now),
    "生成日時が未来です",
  );
  const ps = rows(input.predictions);
  requireCondition(
    new Set(ps.map((p) => p.prediction_id)).size === ps.length,
    "予想IDが重複しています",
  );
  const result: Row[] = [];
  for (let i = 0; i < ps.length; i++) {
    try {
      requireCondition(
        instant(ps[i].information_cutoff_at) <= instant(input.generated_at),
        "生成日時より後の情報締切は使えません",
      );
      result.push({
        prediction_id: ps[i].prediction_id,
        valid: true,
        warnings: await validatePrediction(
          repo,
          ps[i],
          now,
          input.example_only === true,
        ),
      });
    } catch (e) {
      result.push({
        prediction_id: ps[i].prediction_id,
        valid: false,
        path: `predictions[${i}]`,
        error: e instanceof Error ? e.message : "検証失敗",
      });
    }
  }
  return {
    import_id: input.import_id,
    payload_hash: await hash(input),
    predictions: result,
  };
}
export async function saveImport(
  repo: Repository,
  payload: unknown,
  now: string,
): Promise<Row> {
  const input = validateStructure(payload);
  const inputHash = await hash(input);
  const prior = await repo.get("import_operations", str(input, "import_id"));
  if (prior) {
    requireCondition(
      prior.payload_hash === inputHash,
      "同import_id・異内容です",
      409,
    );
    if (prior.status === "complete") return prior;
  }
  const report = await preview(repo, input, now);
  const targets = rows(input.predictions);
  const checks = rows(report.predictions);
  const checkpoint: Row = {};
  const expected: Row = {};
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    if (!checks[i].valid) {
      checkpoint[str(p, "prediction_id")] = {
        status: "failed",
        error: checks[i].error ?? "検証失敗",
      };
      continue;
    }
    const base = {
      schema_version: "0.2",
      created_at: str(input, "generated_at"),
    };
    const pid = str(p, "prediction_id");
    const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
    const prediction: Row = {
      ...base,
      prediction_id: pid,
      race_id: p.race_id,
      model_version_id: p.model_version_id,
      snapshot_id: p.snapshot_id,
      revision: 1,
      kind: p.kind,
      status: "validated",
      predicted_at: input.generated_at,
      information_cutoff_at: p.information_cutoff_at,
      locked_at: null,
      supersedes_prediction_id: p.supersedes_prediction_id ?? null,
      input_hash: snapshot.input_hash,
      feature_ids_json: p.feature_ids ?? [],
      rationale: p.rationale ?? null,
      import_id: input.import_id,
      evidence_json: {
        evidence: p.evidence,
        warnings: checks[i].warnings,
        example_only: input.example_only ?? false,
      },
    };
    const planned: { table: Table; row: Row }[] = [
      { table: "predictions", row: prediction },
    ];
    for (const e of rows(p.horse_evaluations))
      planned.push({
        table: "horse_evaluations",
        row: {
          ...base,
          evaluation_id: `${pid}:${e.entry_id}`,
          prediction_id: pid,
          entry_id: e.entry_id,
          rank: e.rank,
          score: e.score ?? null,
          win_probability: e.win_probability,
          top3_probability: e.top3_probability,
          abilities_json: e.abilities,
          course_fit: e.course_fit,
          jockey_fit: e.jockey_fit,
          expected_position: e.expected_position,
          evidence_json: e,
        },
      });
    const sim = obj(p.simulation);
    if (sim.mode === "narrative")
      planned.push({
        table: "simulation_runs",
        row: {
          ...base,
          simulation_id: sim.simulation_id,
          prediction_id: pid,
          mode: "narrative",
          status: "complete",
          scenarios_json: sim.scenarios,
          engine_version: null,
          input_hash: snapshot.input_hash,
          seed: null,
          trial_count: null,
          outputs_json: {
            limitations: sim.limitations,
            evidence_ids: sim.evidence_ids,
          },
          started_at: input.generated_at,
          completed_at: input.generated_at,
        },
      });
    for (const r of rows(p.recommendations))
      planned.push({
        table: "recommendations",
        row: {
          ...base,
          recommendation_id: r.recommendation_id,
          prediction_id: pid,
          simulation_id: sim.simulation_id,
          ticket_type: r.ticket_type,
          selections_json: ticket(str(r, "ticket_type"), r.selections),
          estimated_probability: r.estimated_probability,
          odds_snapshot_id: r.odds_snapshot_id ?? null,
          estimated_ev: r.estimated_ev ?? null,
          suggested_amount_yen: r.suggested_amount_yen,
          reason: r.reason,
        },
      });
    // Preflight the entire race before staging; conflicts cannot expose half a prediction.
    for (const x of planned) {
      const existing = await repo.get(x.table, idOf(x.table, x.row));
      requireCondition(
        !existing || canonical(existing) === canonical(x.row),
        `${x.table}: ID競合`,
        409,
      );
    }
    for (const x of planned) await immutablePut(repo, x.table, x.row);
    checkpoint[pid] = {
      status: "complete",
      rows: planned.length,
      hash: await hash(planned),
      keys: planned.map((x) => ({ table: x.table, id: idOf(x.table, x.row) })),
    };
    expected[pid] = planned.length;
  }
  const complete = Object.values(checkpoint).every(
    (v) => obj(v).status === "complete",
  );
  const operation: Row = {
    schema_version: "0.2",
    created_at: prior?.created_at ?? now,
    import_id: input.import_id,
    idempotency_key: input.import_id,
    payload_hash: inputHash,
    expected_rows_json: expected,
    stage_checkpoint_json: checkpoint,
    status: complete ? "complete" : "partial",
    completed_at: complete ? now : null,
  };
  await repo.put("import_operations", operation);
  return operation;
}
export async function lockPrediction(
  repo: Repository,
  id: string,
  now: string,
): Promise<Row> {
  const p = await get(repo, "predictions", id);
  if (p.status === "locked") return p;
  const operation = await get(repo, "import_operations", str(p, "import_id"));
  const check = obj(obj(operation.stage_checkpoint_json)[id]);
  requireCondition(check.status === "complete", "予想保存が完了していません");
  const saved = [];
  for (const key of rows(check.keys)) {
    const table = str(key, "table") as Table;
    saved.push({ table, row: await get(repo, table, str(key, "id")) });
  }
  requireCondition(
    (await hash(saved)) === check.hash,
    "保存済み予想の件数・内容ハッシュが不一致です",
  );
  const race = await get(repo, "races", str(p, "race_id"));
  requireCondition(
    race.status === "scheduled" &&
      instant(now) < instant(race.scheduled_start_at),
    "発走後・取消の予想確定は禁止です",
  );
  requireCondition(p.kind !== "backtest", "バックテストは当日採用できません");
  const evidence = obj(p.evidence_json);
  requireCondition(
    evidence.example_only !== true && arr(evidence, "warnings").length === 0,
    "未確認出典・架空入力は確定できません",
  );
  const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
  asOf(snapshot, str(p, "information_cutoff_at"));
  requireCondition(
    snapshot.input_hash === (await hash(snapshotContents(snapshot))),
    "固定入力内容のハッシュ不一致",
  );
  requireCondition(
    snapshot.input_hash === p.input_hash,
    "固定入力ハッシュが不一致です",
  );
  const locked = { ...p, status: "locked", locked_at: now };
  await repo.put("predictions", locked);
  return locked;
}
export async function adopt(
  repo: Repository,
  raceId: string,
  predictionId: string,
  now: string,
): Promise<Row> {
  const existing = (await repo.list("prediction_adoptions")).find(
    (a) => a.race_id === raceId,
  );
  if (existing) {
    requireCondition(
      existing.prediction_id === predictionId,
      "採用版は固定済みです",
      409,
    );
    return existing;
  }
  const race = await get(repo, "races", raceId);
  requireCondition(
    instant(now) < instant(race.scheduled_start_at) &&
      race.status === "scheduled",
    "採用固定は発走前です",
  );
  const candidates = (await repo.list("predictions"))
    .filter(
      (p) =>
        p.race_id === raceId &&
        p.status === "locked" &&
        ["morning", "final"].includes(str(p, "kind")),
    )
    .sort(
      (a, b) =>
        (a.kind === "final" ? -1 : 1) - (b.kind === "final" ? -1 : 1) ||
        instant(b.locked_at) - instant(a.locked_at),
    );
  requireCondition(
    candidates[0]?.prediction_id === predictionId,
    "確定Finalを優先し、なければMorningを採用します",
  );
  const row = {
    schema_version: "0.2",
    created_at: now,
    adoption_id: `adopt:${raceId}`,
    race_id: raceId,
    prediction_id: predictionId,
    adopted_at: now,
    selection_rule_version: "final-first-v1",
  };
  await immutablePut(repo, "prediction_adoptions", row);
  return row;
}
