import {
  arr,
  asOf,
  hash,
  canonical,
  snapshotContents,
  instant,
  num,
  obj,
  requireCondition,
  str,
  type Row,
} from "../../../packages/shared/src/domain";
import {
  get,
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
import {
  simulate,
  type SimulationInput,
} from "../../../packages/simulation/src/engine";
export interface ProbabilitySample {
  prediction_id?: string;
  memberships?: Record<string, string[]>;
  race_id: string;
  model_version_id: string;
  date: string;
  probabilities: number[];
  winners: number[];
  dimensions: Record<string, string>;
}
export function evaluate(samples: ProbabilitySample[]): Row {
  let brier = 0,
    loss = 0;
  const calibration = Array.from({ length: 10 }, (_, i) => ({
    lower: i / 10,
    upper: (i + 1) / 10,
    count: 0,
    predicted: 0,
    observed: 0,
  }));
  const perRace: number[] = [];
  for (const s of samples) {
    const ps = s.probabilities;
    requireCondition(
      ps.length >= 2 &&
        ps.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) &&
        Math.abs(ps.reduce((a, b) => a + b, 0) - 1) <= 0.001,
      "評価確率が不正です",
    );
    requireCondition(
      s.winners.length > 0 &&
        new Set(s.winners).size === s.winners.length &&
        s.winners.every((i) => Number.isInteger(i) && i >= 0 && i < ps.length),
      "勝者位置が不正です",
    );
    let rb = 0,
      rl = 0;
    ps.forEach((p, i) => {
      const y = s.winners.includes(i) ? 1 / s.winners.length : 0;
      rb += (p - y) ** 2;
      rl -= y * Math.log(Math.max(1e-15, p));
      const bin = calibration[Math.min(9, Math.floor(p * 10))];
      bin.count++;
      bin.predicted += p;
      bin.observed += y;
    });
    brier += rb;
    loss += rl;
    perRace.push(rb);
  }
  const n = samples.length,
    mean = n ? brier / n : null;
  const variance =
    n > 1
      ? perRace.reduce((a, b) => a + (b - (mean ?? 0)) ** 2, 0) / (n - 1)
      : null;
  return {
    sample_races: n,
    period_start: n ? samples.map((s) => s.date).sort()[0] : null,
    period_end: n
      ? samples
          .map((s) => s.date)
          .sort()
          .at(-1)!
      : null,
    brier_score: mean,
    log_loss: n ? loss / n : null,
    brier_standard_error: variance !== null ? Math.sqrt(variance / n) : null,
    calibration: calibration.map((b) => ({
      ...b,
      predicted: b.count ? b.predicted / b.count : null,
      observed: b.count ? b.observed / b.count : null,
    })),
    rule: "全採用予想。取消レース・欠測確率は除外。同着勝者へ目的確率を均等配分。Log Lossは1e-15でクリップ。取消馬が評価対象に残るレースは除外。購入の有無を問わない。",
  };
}
export function chronologicalSplit(
  samples: ProbabilitySample[],
  trainEnd: string,
  tuneEnd: string,
) {
  requireCondition(
    instant(trainEnd) < instant(tuneEnd),
    "学習→調整→検証の順で締切を指定してください",
  );
  const sorted = [...samples].sort((a, b) => instant(a.date) - instant(b.date));
  return {
    train: sorted.filter((s) => instant(s.date) <= instant(trainEnd)),
    tune: sorted.filter(
      (s) =>
        instant(s.date) > instant(trainEnd) &&
        instant(s.date) <= instant(tuneEnd),
    ),
    test: sorted.filter((s) => instant(s.date) > instant(tuneEnd)),
  };
}
export async function predictionSamples(
  repo: Repository,
): Promise<{ samples: ProbabilitySample[]; excluded: Row[] }> {
  const referenceAdoptions = await repo.list("reference_adoptions");
  const adoptions = [
    ...(await repo.list("prediction_adoptions")).filter(
      (a) => !referenceAdoptions.some((r) => r.race_id === a.race_id),
    ),
    ...referenceAdoptions,
  ];
  const results = await repo.list("race_results");
  const evaluations = await repo.list("horse_evaluations");
  const entries = await repo.list("race_entries");
  const samples: ProbabilitySample[] = [];
  const excluded: Row[] = [];
  for (const a of adoptions) {
    const p = await get(repo, "predictions", str(a, "prediction_id"));
    const race = await get(repo, "races", str(a, "race_id"));
    const r = results
      .filter((r) => r.race_id === race.race_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
    const es = evaluations
      .filter((e) => e.prediction_id === p.prediction_id)
      .sort((a, b) => str(a, "entry_id").localeCompare(str(b, "entry_id")));
    if (!r || r.official_status !== "official") {
      excluded.push({ race_id: race.race_id, reason: "公式結果なし・取消" });
      continue;
    }
    const status = obj(r.entry_status_json);
    if (
      es.some(
        (e) =>
          status[
            String(entries.find((x) => x.entry_id === e.entry_id)?.horse_number)
          ] === "scratched" || typeof e.win_probability !== "number",
      )
    ) {
      excluded.push({ race_id: race.race_id, reason: "取消・欠測" });
      continue;
    }
    const winners = arr(r, "finish_order_json")[0];
    requireCondition(Array.isArray(winners), "勝者情報がありません");
    const winnerIndices = es.flatMap((e, i) =>
      winners.includes(
        entries.find((x) => x.entry_id === e.entry_id)?.horse_number ?? null,
      )
        ? [i]
        : [],
    );
    const course = await get(repo, "course_layouts", str(race, "course_id"));
    const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
    const track = await get(repo, "tracks", str(course, "track_id"));
    const jockeyNames = await Promise.all(
      es.map(async (e) => {
        const entry = entries.find((x) => x.entry_id === e.entry_id)!;
        return str(
          await get(repo, "jockeys", str(entry, "jockey_id")),
          "jockey_name",
        );
      }),
    );
    samples.push({
      prediction_id: str(p, "prediction_id"),
      memberships: {
        jockey: [...new Set(jockeyNames)],
        running_style: [
          ...new Set(es.map((e) => String(e.expected_position ?? "欠測"))),
        ],
      },
      race_id: str(race, "race_id"),
      model_version_id: str(p, "model_version_id"),
      date: str(race, "scheduled_start_at"),
      probabilities: es.map((e) => num(e, "win_probability")),
      winners: winnerIndices,
      dimensions: {
        track: str(track, "name"),
        distance: String(course.distance_m),
        going: String(snapshot.going ?? "欠測"),
        model: str(p, "model_version_id"),
        jurisdiction: str(race, "jurisdiction"),
      },
    });
  }
  return { samples, excluded };
}
export async function analytics(repo: Repository): Promise<Row> {
  const { samples, excluded } = await predictionSamples(repo);
  const groups: Row[] = [];
  for (const dimension of [
    "track",
    "distance",
    "going",
    "model",
    "jurisdiction",
  ])
    for (const value of new Set(samples.map((s) => s.dimensions[dimension])))
      groups.push({
        dimension,
        value,
        ...evaluate(samples.filter((s) => s.dimensions[dimension] === value)),
      });
  for (const dimension of ["jockey", "running_style"])
    for (const value of new Set(
      samples.flatMap((s) => s.memberships?.[dimension] ?? []),
    ))
      groups.push({
        dimension,
        value,
        population_rule:
          "当該騎手・推定脚質を含むレースの全馬確率。騎手単独の因果効果ではない。",
        ...evaluate(
          samples.filter((s) => s.memberships?.[dimension]?.includes(value)),
        ),
      });
  return { ...evaluate(samples), groups, excluded };
}
export async function backtest(repo: Repository, input: Row): Promise<Row> {
  const ids = arr(input, "prediction_ids");
  const replay: Row[] = [];
  const numericReplays: Row[] = [];
  for (const id of ids) {
    requireCondition(typeof id === "string", "予想IDが不正です");
    const p = await get(repo, "predictions", id);
    const cutoff = str(p, "information_cutoff_at");
    const snapshot = await get(repo, "race_snapshots", str(p, "snapshot_id"));
    asOf(snapshot, cutoff);
    requireCondition(
      snapshot.input_hash === p.input_hash,
      "入力ハッシュ不一致",
    );
    requireCondition(
      snapshot.input_hash === (await hash(snapshotContents(snapshot))),
      "固定入力内容のハッシュ不一致",
    );
    for (const sim of (await repo.list("simulation_runs")).filter(
      (s) =>
        s.prediction_id === id &&
        s.mode === "numeric" &&
        s.status === "complete",
    )) {
      const saved = obj(sim.outputs_json);
      const { input: fixed, ...expected } = saved;
      const output = await simulate(
        obj(fixed) as unknown as SimulationInput,
        num(sim, "seed"),
        num(sim, "trial_count"),
      );
      requireCondition(
        sim.engine_version === output.engine_version &&
          canonical(expected) === canonical(output),
        "数値再評価の版・出力が一致しません",
      );
      numericReplays.push({
        simulation_id: sim.simulation_id,
        seed: sim.seed,
        input_hash: output.input_hash,
        output_hash: await hash(output),
        trial_count: sim.trial_count,
      });
    }
    const model = await get(repo, "model_versions", str(p, "model_version_id"));
    if (model.training_cutoff_at != null)
      requireCondition(
        instant(model.training_cutoff_at) <= instant(cutoff),
        "学習データの時点リーク",
      );
    for (const fid of arr(p, "feature_ids_json")) {
      requireCondition(typeof fid === "string", "特徴量IDが不正です");
      const f = await get(repo, "entity_features", fid);
      asOf(f, cutoff);
      for (const pid of arr(f, "performance_ids_json")) {
        requireCondition(typeof pid === "string", "戦績IDが不正です");
        asOf(await get(repo, "performances", pid), cutoff);
      }
    }
    const odds = arr(snapshot, "odds_snapshot_ids_json");
    for (const oid of odds) {
      requireCondition(typeof oid === "string", "オッズIDが不正です");
      asOf(await get(repo, "odds_snapshots", oid), cutoff);
    }
    replay.push({
      prediction_id: id,
      input_hash: p.input_hash,
      model_version_id: p.model_version_id,
      cutoff_at: cutoff,
    });
  }
  const { samples } = await predictionSamples(repo);
  const raceIds = await Promise.all(
    ids.map(async (id) =>
      str(await get(repo, "predictions", String(id)), "race_id"),
    ),
  );
  const split = chronologicalSplit(
    samples.filter(
      (s) =>
        raceIds.includes(s.race_id) && ids.includes(s.prediction_id ?? null),
    ),
    str(input, "train_end_at"),
    str(input, "tune_end_at"),
  );
  return {
    replay_hash: await hash({ replay, numericReplays }),
    numeric_replays: numericReplays,
    replay,
    train: evaluate(split.train),
    tune: evaluate(split.tune),
    test: evaluate(split.test),
    limitations:
      "固定済み採用予想を時間順に再評価します。新しい能力推定の再学習は行いません。",
  };
}
export async function saveReview(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const p = await get(repo, "predictions", str(input, "prediction_id"));
  const result = await get(repo, "race_results", str(input, "result_id"));
  requireCondition(
    result.race_id === p.race_id && result.official_status === "official",
    "採用予想と公式結果を指定してください",
  );
  requireCondition(
    (await repo.list("prediction_adoptions")).some(
      (a) => a.prediction_id === p.prediction_id,
    ),
    "採用予想が必要です",
  );
  for (const k of [
    "observations_json",
    "hypotheses_json",
    "unknowns_json",
    "validation_plan_json",
  ])
    arr(input, k);
  const row = {
    ...input,
    schema_version: "0.2",
    created_at: now,
    race_id: p.race_id,
    model_version_id: p.model_version_id,
    reviewed_at: now,
  };
  await immutablePut(repo, "reviews", row);
  return row;
}
export async function adoptModel(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  requireCondition(input.owner_approved === true, "本人の採用承認が必要です");
  const model = await get(
    repo,
    "model_versions",
    str(input, "candidate_model_id"),
  );
  const baseline = await get(
    repo,
    "model_versions",
    str(input, "baseline_model_id"),
  );
  const comparison = obj(input.comparison);
  for (const k of ["accuracy", "return_rate", "load_ms", "cost_yen"]) {
    const c = obj(comparison[k]);
    requireCondition(
      typeof c.baseline === "number" && typeof c.candidate === "number",
      `${k}: 基準・候補の比較が必要です`,
    );
  }
  requireCondition(
    Number.isInteger(num(input, "unused_sample_size")) &&
      num(input, "unused_sample_size") >= 30,
    "未使用期間の30レース以上で検証してください",
  );
  requireCondition(
    instant(input.test_start_at) > instant(input.tuning_end_at),
    "検証期間が調整期間と重複しています",
  );
  str(input, "reason");
  str(input, "rollback_plan");
  const id = str(input, "operation_id");
  const record = {
    ...input,
    candidate_model_id: model.model_version_id,
    baseline_model_id: baseline.model_version_id,
    approved_at: now,
  };
  const row = {
    schema_version: "0.2",
    created_at: now,
    event_id: `adopt-model:${id}`,
    operation_id: id,
    actor: "owner",
    action: "adopt-model",
    entity_type: "model_versions",
    entity_id: model.model_version_id,
    before_hash: await hash(baseline),
    after_hash: await hash(model),
    event_at: now,
    evidence_json: record,
  };
  await immutablePut(repo, "audit_events", row);
  return row;
}
