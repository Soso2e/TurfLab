import {
  asOf,
  canonical,
  DomainError,
  hash,
  idOf,
  instant,
  money,
  num,
  obj,
  requireCondition,
  rows,
  snapshotContents,
  str,
  type Row,
} from "../../../packages/shared/src/domain";
import {
  get,
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
import {
  rankEvaluations,
  SCORE_VERSION,
  scoreWeights,
} from "../../../packages/shared/src/scoring";
import {
  simulate,
  type SimulationInput,
} from "../../../packages/simulation/src/engine";
import {
  lockPrediction,
  saveImport,
  validatePrediction,
  validateStructure,
} from "./imports";
import { applyChanges, StagedRepository, type Change } from "./storage";

type Commit = (changes: Change[]) => Promise<void>;
const terminal = (r: Row) =>
  r.status === "complete" &&
  ["BET_LOCKED", "SKIPPED"].includes(str(r, "stage"));

export function safeFailure(
  error: unknown,
  operation: string,
  key: string,
): Row {
  const original = error instanceof Error ? error.message : "不明な保存エラー";
  const transient =
    /temporary|network|fetch failed|timeout|timed out|一時|書込失敗/i.test(
      original,
    );
  const status =
    error instanceof DomainError ? error.status : transient ? 503 : 500;
  // Keep the diagnostic, but remove common credentials, URLs and PEM blocks.
  const message = original
    .replace(/-----BEGIN[\s\S]*?-----END[^\n]*-----/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s)]+/g, "[URL redacted]")
    .replace(
      /((?:token|secret|password|api_key|private_key|assertion|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 500);
  return {
    operation,
    key,
    status,
    message,
    retryable:
      [429, 502, 503, 504].includes(status) &&
      !/設定がありません|列が不足|認証|権限/.test(original),
  };
}

async function fixedData(repo: Repository, p: Row, now: string) {
  const race = await get(repo, "races", str(p, "race_id"));
  requireCondition(
    race.status === "scheduled" &&
      instant(now) < instant(race.scheduled_start_at),
    "発走後・取消のMorning/Finalは作成できません",
  );
  requireCondition(
    ["morning", "final"].includes(str(p, "kind")),
    "CoreはMorning/Final専用です",
  );
  const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
  requireCondition(
    snapshot.input_hash === (await hash(snapshotContents(snapshot))),
    "snapshotハッシュ不一致",
  );
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === race.race_id,
  );
  const fixed = rows(snapshot.entries_state_json);
  requireCondition(
    canonical(entries.map((e) => e.entry_id).sort()) ===
      canonical(fixed.map((e) => e.entry_id).sort()),
    "取消を含む全出走馬の固定snapshotが必要です",
  );
  for (const entry of entries) {
    const saved = obj(fixed.find((e) => e.entry_id === entry.entry_id));
    for (const key of [
      "status",
      "horse_number",
      "horse_id",
      "jockey_id",
      "draw_number",
      "carried_weight_kg",
    ])
      requireCondition(
        saved[key] != null && canonical(saved[key]) === canonical(entry[key]),
        `固定出走馬の${key}が不足または変更されています`,
      );
    asOf(entry, str(p, "information_cutoff_at"));
  }
  asOf(race, str(p, "information_cutoff_at"));
  asOf(
    await get(repo, "course_layouts", str(race, "course_id")),
    str(p, "information_cutoff_at"),
  );
  return {
    race,
    snapshot,
    entries: entries.filter((e) => e.status === "active"),
  };
}

export async function prepareRace(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const p = structuredClone(obj(input.prediction));
  const { entries } = await fixedData(repo, p, now);
  requireCondition(
    rows(p.horse_evaluations).length === entries.length &&
      canonical(
        rows(p.horse_evaluations)
          .map((e) => e.entry_id)
          .sort(),
      ) === canonical(entries.map((e) => e.entry_id).sort()),
    "評価は全有効出走馬と一致する必要があります",
  );
  p.horse_evaluations = rankEvaluations(rows(p.horse_evaluations), entries);
  const sim = obj(p.simulation);
  const scenarios = rows(sim.scenarios);
  requireCondition(
    canonical(scenarios.map((s) => s.pace).sort()) ===
      canonical(["slow", "middle", "high"].sort()),
    "スロー・平均・ハイの3展開が必要です",
  );
  for (const scenario of scenarios) {
    const lineup = rows(scenario.lineup);
    requireCondition(
      canonical(lineup.map((e) => e.entry_id).sort()) ===
        canonical(entries.map((e) => e.entry_id).sort()),
      "各展開には全有効馬の隊列・有利不利が必要です",
    );
  }
  const payload = {
    schema_version: "0.2",
    import_id: `pipeline:${str(input, "pipeline_id")}`,
    generated_at: str(input, "generated_at"),
    example_only: input.example_only ?? false,
    predictions: [p],
  };
  validateStructure(payload);
  requireCondition(
    instant(payload.generated_at) <= instant(now) &&
      instant(p.information_cutoff_at) <= instant(payload.generated_at),
    "生成日時・情報締切の不整合です",
  );
  return payload;
}

async function finalGuard(repo: Repository, input: Row, p: Row) {
  const adoption = (await repo.list("reference_adoptions")).find(
    (a) => a.race_id === p.race_id,
  );
  if (!adoption || adoption.prediction_id === p.prediction_id) return;
  requireCondition(
    p.kind === "final" && p.supersedes_prediction_id === adoption.prediction_id,
    "採用版の変更は直前の採用予想を参照するFinalです",
    409,
  );
  const previous = await get(
    repo,
    "predictions",
    str(adoption, "prediction_id"),
  );
  const before = await get(
    repo,
    "race_snapshots",
    str(previous, "snapshot_id"),
  );
  const after = await get(repo, "race_snapshots", str(p, "snapshot_id"));
  const changes = rows(input.final_changes);
  requireCondition(
    changes.length > 0,
    "Finalは能力・状態に関わる変更根拠が必要です",
  );
  const evidenceIds = rows(p.evidence).map((e) => e.evidence_id);
  const fields: Record<string, string> = {
    scratch: "entries_state_json",
    jockey: "entries_state_json",
    body_weight: "entries_state_json",
    going: "going",
    track_bias: "track_bias_json",
    condition: "entries_state_json",
    recent_form: "feature_ids_json",
  };
  for (const change of changes) {
    const field = fields[str(change, "type")];
    requireCondition(
      field &&
        str(change, "reason").trim() &&
        rows(p.evidence).some(
          (e) =>
            e.evidence_id === change.evidence_id &&
            evidenceIds.includes(change.evidence_id),
        ),
      "Finalの変更種別・理由・出典が不正です（オッズのみは対象外）",
    );
    const entryFields: Record<string, string[]> = {
      scratch: ["status"],
      jockey: ["jockey_id"],
      body_weight: ["body_weight_kg", "body_weight_change_kg"],
      condition: ["condition"],
    };
    const value = (snapshot: Row) =>
      field === "entries_state_json"
        ? rows(snapshot.entries_state_json)
            .map((e) => [
              e.entry_id,
              ...entryFields[str(change, "type")].map((k) => e[k] ?? null),
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        : snapshot[field];
    const oldValue =
      field === "feature_ids_json" ? previous.feature_ids_json : value(before);
    const newValue =
      field === "feature_ids_json" ? (p.feature_ids ?? []) : value(after);
    requireCondition(
      canonical(oldValue) !== canonical(newValue),
      "Final根拠に対応する固定入力の変更がありません",
    );
  }
}

export async function referenceBudget(
  repo: Repository,
  date: string,
): Promise<number> {
  const adoptions = await repo.list("reference_adoptions");
  const runs = await repo.list("race_pipeline_runs");
  const perRace = new Map<string, number>();
  for (const plan of await repo.list("reference_plans")) {
    if (plan.budget_date_jst !== date) continue;
    const active = adoptions.some((a) => a.plan_id === plan.plan_id);
    const unfinished =
      plan.status !== "rejected" &&
      runs.some((r) => r.bet_key === plan.plan_id && !terminal(r));
    if (active || unfinished)
      perRace.set(
        str(plan, "race_id"),
        Math.max(
          perRace.get(str(plan, "race_id")) ?? 0,
          num(plan, "amount_yen"),
        ),
      );
  }
  return [...perRace.values()].reduce((s, n) => s + n, 0);
}

export async function runRace(
  repo: Repository,
  input: Row,
  now: string,
  commit: Commit = (changes) => applyChanges(repo, changes),
  clock: () => string = () => now,
): Promise<Row> {
  const id = str(input, "pipeline_id");
  requireCondition(id.length > 0, "pipeline_idは必須です");
  const payloadHash = await hash(input);
  let run = await repo.get("race_pipeline_runs", id);
  if (run) {
    requireCondition(
      run.payload_hash === payloadHash,
      "同pipeline_id・異内容です",
      409,
    );
    if (terminal(run)) return run;
    requireCondition(num(run, "attempt") < 3, "再試行は3回までです", 409);
    requireCondition(
      run.status !== "failed" || obj(run.error_json).retryable === true,
      "恒久エラーは新しいID・修正入力で実行してください",
      409,
    );
  }
  const p = obj(input.prediction);
  const predictionId = str(p, "prediction_id"),
    raceId = str(p, "race_id");
  // One unfinished writer per race; owner Durable Object serializes requests.
  requireCondition(
    !(await repo.list("race_pipeline_runs")).some(
      (r) =>
        r.pipeline_id !== id &&
        r.race_id === raceId &&
        !terminal(r) &&
        (r.status !== "failed" || obj(r.error_json).retryable === true),
    ),
    "このレースには再開待ちの処理があります",
    409,
  );
  const planId = `reference:${predictionId}`;
  const checkpoint = run ? obj(run.checkpoint_json) : {};
  run = {
    schema_version: "0.2",
    created_at: run?.created_at ?? now,
    pipeline_id: id,
    race_id: raceId,
    prediction_id: predictionId,
    snapshot_id: str(p, "snapshot_id"),
    race_key: raceId,
    prediction_key: predictionId,
    bet_key: planId,
    payload_hash: payloadHash,
    stage: run?.stage ?? "SELECTED",
    status: "running",
    attempt: Number(run?.attempt ?? 0) + 1,
    checkpoint_json: checkpoint,
    error_json: null,
    updated_at: now,
    completed_at: null,
    evidence_json: { score_version: SCORE_VERSION, weights: scoreWeights },
  };
  const persist = async () => {
    const staged = new StagedRepository(repo);
    await staged.put("race_pipeline_runs", run!);
    await commit([...staged.changes.values()]);
    repo.refresh?.();
  };
  const stage = async (
    name: string,
    action: (staged: Repository) => Promise<unknown>,
  ) => {
    now = clock();
    const staged = new StagedRepository(repo);
    const result = await action(staged);
    await commit([...staged.changes.values()]);
    repo.refresh?.();
    // Read actual storage, never the staging overlay, before advancing.
    for (const c of staged.changes.values())
      requireCondition(
        canonical(await repo.get(c.table, idOf(c.table, c.after))) ===
          canonical(c.after),
        "保存後の読み返し不一致",
        503,
      );
    checkpoint[name] = {
      input_hash: payloadHash,
      output_hash: await hash(result),
      completed_at: now,
    };
    run = {
      ...run!,
      stage: name,
      checkpoint_json: checkpoint,
      updated_at: now,
    };
    await persist();
    return result;
  };
  await persist();
  let operation = "DATA_READY";
  try {
    const payload = await prepareRace(repo, input, now);
    const prepared = rows(payload.predictions)[0];
    await finalGuard(repo, input, prepared);
    const { race } = await fixedData(repo, prepared, now);
    const amount = rows(prepared.recommendations).reduce(
      (s, r) => s + money(r.suggested_amount_yen, true),
      0,
    );
    requireCondition(amount <= 1000, "参考プランは1R1,000円以内です");
    requireCondition(
      amount > 0 ||
        (typeof prepared.skip_reason === "string" &&
          prepared.skip_reason.trim()),
      "0円の参考プランには見送り理由が必要です",
    );
    const date = str(race, "race_date_jst");
    const priorPlan = (await repo.list("reference_plans")).filter(
      (r) => r.race_id === raceId && r.budget_date_jst === date,
    );
    const budgetBefore = await referenceBudget(repo, date);
    const oldAmount = priorPlan
      .filter((r) => r.plan_id === planId)
      .reduce((s, r) => Math.max(s, num(r, "amount_yen")), 0);
    const adopted = (await repo.list("reference_adoptions")).find(
      (a) => a.race_id === raceId,
    );
    const adoptedAmount = adopted
      ? num(
          await get(repo, "reference_plans", str(adopted, "plan_id")),
          "amount_yen",
        )
      : 0;
    requireCondition(
      budgetBefore -
        Math.max(oldAmount, adoptedAmount) +
        Math.max(amount, adoptedAmount) <=
        5000,
      "JST当日の参考プランは5,000円以内です",
      409,
    );
    await stage("DATA_READY", async (staged) => {
      const existing = await staged.get("reference_plans", planId);
      if (existing) {
        requireCondition(
          existing.payload_hash === payloadHash,
          "同plan_id・異内容です",
          409,
        );
        return existing;
      }
      const plan = {
        schema_version: "0.2",
        created_at: now,
        plan_id: planId,
        race_id: raceId,
        prediction_id: predictionId,
        budget_date_jst: date,
        amount_yen: amount,
        status: "reserved",
        tickets_json: rows(prepared.recommendations),
        payload_hash: payloadHash,
        locked_at: null,
      };
      await immutablePut(staged, "reference_plans", plan);
      return plan;
    });
    operation = "SIMULATED";
    await stage("SIMULATED", async (staged) => {
      const sim = obj(prepared.simulation);
      if (sim.mode === "narrative") return sim;
      const numeric = obj(input.numeric);
      const simInput = obj(numeric.input) as unknown as SimulationInput;
      requireCondition(
        simInput.cutoff_at === prepared.information_cutoff_at,
        "数値入力の情報締切不一致",
      );
      const { entries } = await fixedData(repo, prepared, now);
      requireCondition(
        canonical(
          simInput.runners.map((r) => [r.entry_id, r.horse_number]).sort(),
        ) ===
          canonical(entries.map((e) => [e.entry_id, e.horse_number]).sort()),
        "数値入力は全有効馬・馬番と一致してください",
      );
      requireCondition(
        canonical(simInput.scenarios) ===
          canonical(
            rows(sim.scenarios).map((s) => ({
              pace: s.pace,
              weight: s.weight,
            })),
          ),
        "数値と文章の3展開・重みが不一致です",
      );
      const model = await get(
        repo,
        "model_versions",
        str(prepared, "model_version_id"),
      );
      requireCondition(
        model.engine_version === "segment-mc-v1",
        "モデルのエンジン版不一致",
      );
      const output = await simulate(
        simInput,
        num(numeric, "seed"),
        num(numeric, "trial_count"),
      );
      for (const evaluation of rows(prepared.horse_evaluations)) {
        evaluation.win_probability =
          output.win_probabilities[str(evaluation, "entry_id")];
        evaluation.top3_probability =
          output.top3_probabilities[str(evaluation, "entry_id")];
      }
      Object.assign(sim, {
        input_hash: output.input_hash,
        engine_version: output.engine_version,
        seed: output.seed,
        trial_count: output.trial_count,
      });
      const existing = await staged.get(
        "simulation_runs",
        str(sim, "simulation_id"),
      );
      const row: Row = {
        schema_version: "0.2",
        created_at: existing?.created_at ?? now,
        simulation_id: sim.simulation_id,
        prediction_id: predictionId,
        mode: "numeric",
        status: "complete",
        scenarios_json: sim.scenarios,
        input_hash: output.input_hash,
        engine_version: output.engine_version,
        seed: output.seed,
        trial_count: output.trial_count,
        outputs_json: JSON.parse(
          JSON.stringify({ ...output, input: simInput }),
        ),
        started_at: existing?.started_at ?? now,
        completed_at: existing?.completed_at ?? now,
      };
      // As in the existing simulate endpoint, stage numeric evidence before the
      // prediction import that validates it. Unfinished runs are not published.
      requireCondition(
        !existing || canonical(existing) === canonical(row),
        "数値実行IDの競合",
        409,
      );
      await staged.put("simulation_runs", row);
      return row;
    });
    operation = "VALIDATED";
    await stage("VALIDATED", async (staged) => {
      validateStructure(payload);
      const warnings = await validatePrediction(
        staged,
        prepared,
        now,
        input.example_only === true,
      );
      requireCondition(
        warnings.length === 0,
        "未確認出典・架空入力は確定できません",
      );
      const existing = await staged.get(
        "import_operations",
        str(payload, "import_id"),
      );
      if (existing?.status === "complete") {
        requireCondition(
          existing.payload_hash === (await hash(payload)),
          "保存入力ハッシュ不一致",
          409,
        );
        return existing;
      }
      return saveImport(staged, payload, now);
    });
    operation = "LOCK";
    await stage("VALIDATED", async (staged) => {
      await fixedData(repo, prepared, now);
      const locked = await lockPrediction(staged, predictionId, now);
      const plan = await get(staged, "reference_plans", planId);
      await staged.put("reference_plans", {
        ...plan,
        status: "locked",
        locked_at: plan.locked_at ?? locked.locked_at,
      });
      return locked;
    });
    operation = "READBACK";
    repo.refresh?.();
    const saved = await get(repo, "predictions", predictionId);
    const plan = await get(repo, "reference_plans", planId);
    requireCondition(
      saved.status === "locked" &&
        saved.locked_at != null &&
        plan.status === "locked" &&
        plan.locked_at != null,
      "ロック後の読み返し不一致",
      503,
    );
    const importOp = await get(
      repo,
      "import_operations",
      str(payload, "import_id"),
    );
    const savedCheck = obj(obj(importOp.stage_checkpoint_json)[predictionId]);
    const savedRows = [];
    for (const key of rows(savedCheck.keys)) {
      const table = str(
        key,
        "table",
      ) as import("../../../packages/shared/src/domain").Table;
      const row = await get(repo, table, str(key, "id"));
      savedRows.push({
        table,
        row:
          table === "predictions"
            ? { ...row, status: "validated", locked_at: null }
            : row,
      });
    }
    requireCondition(
      savedRows.length === savedCheck.rows &&
        (await hash(savedRows)) === savedCheck.hash,
      "ロック後の件数・内容ハッシュ不一致",
      503,
    );
    requireCondition(
      plan.payload_hash === payloadHash &&
        canonical(plan.tickets_json) === canonical(prepared.recommendations),
      "参考プランの読み返し不一致",
      503,
    );
    const evaluations = (await repo.list("horse_evaluations")).filter(
      (e) => e.prediction_id === predictionId,
    );
    requireCondition(
      evaluations.length === rows(prepared.horse_evaluations).length &&
        evaluations.every((e) =>
          rows(prepared.horse_evaluations).some(
            (x) =>
              x.entry_id === e.entry_id &&
              x.score === e.score &&
              x.rank === e.rank,
          ),
        ),
      "評価件数・スコアの読み返し不一致",
      503,
    );
    const adoptionId = `reference-adopt:${raceId}`;
    await stage(amount === 0 ? "SKIPPED" : "BET_LOCKED", async (staged) => {
      await fixedData(repo, prepared, clock());
      const previous = await staged.get("reference_adoptions", adoptionId);
      const adoption: Row = {
        schema_version: "0.2",
        created_at: previous?.created_at ?? now,
        reference_adoption_id: adoptionId,
        race_id: raceId,
        prediction_id: predictionId,
        plan_id: planId,
        adopted_at:
          previous?.prediction_id === predictionId ? previous.adopted_at : now,
        history_json:
          previous?.prediction_id === predictionId
            ? previous.history_json
            : [
                ...((previous?.history_json ?? []) as Row[]),
                {
                  prediction_id: predictionId,
                  plan_id: planId,
                  adopted_at: now,
                  final_changes: input.final_changes ?? [],
                },
              ],
      };
      await staged.put("reference_adoptions", adoption);
      return adoption;
    });
    run = { ...run, status: "complete", completed_at: now, error_json: null };
    await persist();
    return run;
  } catch (error) {
    const failure = safeFailure(error, operation, `${raceId}/${predictionId}`);
    if (num(run, "attempt") >= 3) {
      failure.retryable = false;
      failure.exhausted = true;
    }
    run = {
      ...run,
      status: "failed",
      error_json: failure,
      updated_at: now,
    };
    const plan = await repo.get("reference_plans", planId);
    if (
      plan?.status === "reserved" &&
      plan.payload_hash === payloadHash &&
      obj(run.error_json).retryable === false
    ) {
      const staged = new StagedRepository(repo);
      await staged.put("reference_plans", { ...plan, status: "rejected" });
      await commit([...staged.changes.values()]);
    }
    await persist();
    return run;
  }
}

export async function runBatch(
  repo: Repository,
  input: Row,
  now: string,
  commit?: Commit,
  clock: () => string = () => now,
): Promise<Row> {
  const races = rows(input.races);
  requireCondition(races.length <= 5, "最大5Rです");
  requireCondition(
    new Set(races.map((r) => obj(r.prediction).race_id)).size === races.length,
    "同一レースが重複しています",
  );
  const results: Row[] = [];
  for (const race of races) {
    try {
      results.push(await runRace(repo, race, clock(), commit, clock));
    } catch (error) {
      results.push({
        pipeline_id: race.pipeline_id ?? null,
        status: "failed",
        error_json: safeFailure(error, "SELECTED", String(race.pipeline_id)),
      });
    }
  }
  const failed = results.filter((r) => r.status === "failed").length;
  return {
    status: !races.length
      ? "skipped"
      : failed === races.length
        ? "failed"
        : failed
          ? "partial"
          : "complete",
    score_version: SCORE_VERSION,
    completed: results.length - failed,
    failed,
    races: results,
  };
}
