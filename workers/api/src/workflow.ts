import {
  asOf,
  canonical,
  hash,
  idOf,
  instant,
  jstDate,
  obj,
  requireCondition,
  rows,
  str,
  tables,
  snapshotContents,
  references,
  validateRow,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import {
  get,
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
import { importSchema } from "../../../packages/shared/src/import-schema";
import { preview, saveImport } from "./imports";
import { purchaseStats, saveResult, settle } from "./betting";
import { SheetsRepository } from "./sheets";
import { StagedRepository } from "./storage";
const masterTables: Table[] = [
  "tracks",
  "course_layouts",
  "horses",
  "jockeys",
  "races",
  "race_entries",
  "performances",
  "odds_snapshots",
  "race_snapshots",
  "model_versions",
  "course_segments",
  "entity_features",
];
export async function ingestMaster(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const operation = str(input, "operation_id");
  const payloadHash = await hash(input);
  const prior = await repo.get("import_operations", `master:${operation}`);
  if (prior) {
    requireCondition(
      prior.payload_hash === payloadHash,
      "同操作ID・異内容のデータ取り込みです",
      409,
    );
    if (prior.status === "complete") return prior;
  }
  const content = obj(input.tables);
  requireCondition(
    Object.keys(content).every((t) => masterTables.includes(t as Table)),
    "マスター以外の書き込みはできません",
  );
  let count = 0;
  for (const t of masterTables)
    for (const r of rows(content[t] ?? [])) {
      for (const key of ["source", "source_url", "retrieved_at", "valid_as_of"])
        str(r, key);
      requireCondition(
        new URL(str(r, "source_url")).protocol === "https:",
        "出典URLはHTTPSです",
      );
      requireCondition(
        instant(r.retrieved_at) <= instant(now) &&
          instant(r.valid_as_of) <= instant(now),
        "取得・観測時刻が未来です",
      );
      if (t === "race_snapshots") {
        const state = r.entries_state_json;
        requireCondition(
          Array.isArray(state) && state.length > 0,
          "snapshotの固定出走情報が必要です",
        );
        requireCondition(
          str(r, "input_hash") === (await hash(snapshotContents(r))),
          "snapshot入力ハッシュが不正です",
        );
      }
      await immutablePut(repo, t, r);
      count++;
    }
  const record = {
    schema_version: "0.2",
    created_at: now,
    import_id: `master:${operation}`,
    idempotency_key: operation,
    payload_hash: payloadHash,
    expected_rows_json: { total: count },
    stage_checkpoint_json: { master: "complete" },
    status: "complete",
    completed_at: now,
  };
  await immutablePut(repo, "import_operations", record);
  return record;
}
export async function reanalysisPrompt(
  repo: Repository,
  raceId: string,
  snapshotId: string,
  modelId: string,
  cutoff: string,
  now = new Date().toISOString(),
): Promise<Row> {
  const race = await get(repo, "races", raceId),
    snapshot = await get(repo, "race_snapshots", snapshotId),
    model = await get(repo, "model_versions", modelId);
  requireCondition(snapshot.race_id === raceId, "snapshotのレース不一致");
  asOf(snapshot, cutoff);
  requireCondition(
    instant(cutoff) < instant(race.scheduled_start_at),
    "締切は発走前です",
  );
  asOf(race, cutoff);
  asOf(model, cutoff);
  const course = await get(repo, "course_layouts", str(race, "course_id"));
  asOf(course, cutoff);
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === raceId && e.status === "active",
  );
  for (const e of entries) asOf(e, cutoff);
  const horses = await Promise.all(
    entries.map((e) => get(repo, "horses", str(e, "horse_id"))),
  );
  const jockeys = await Promise.all(
    entries.map((e) => get(repo, "jockeys", str(e, "jockey_id"))),
  );
  for (const r of [...horses, ...jockeys]) asOf(r, cutoff);
  const missing: Row[] = [];
  const safe = (r: Row) => {
    try {
      asOf(r, cutoff);
      return true;
    } catch {
      missing.push({
        id: r.performance_id ?? r.feature_id ?? r.odds_snapshot_id ?? null,
        reason: "締切後または時刻不明のため除外",
      });
      return false;
    }
  };
  const performances = (await repo.list("performances"))
    .filter((p) => entries.some((e) => e.horse_id === p.horse_id) && safe(p))
    .sort((a, b) => instant(b.valid_as_of) - instant(a.valid_as_of));
  const recent = horses.flatMap((h) =>
    performances.filter((p) => p.horse_id === h.horse_id).slice(0, 5),
  );
  const features = (await repo.list("entity_features")).filter(
    (f) =>
      entries.some(
        (e) => e.horse_id === f.horse_id || e.jockey_id === f.jockey_id,
      ) && safe(f),
  );
  const odds = (await repo.list("odds_snapshots")).filter(
    (o) => o.race_id === raceId && safe(o),
  );
  const fixed = {
    race,
    course,
    entries,
    horses,
    jockeys,
    snapshot,
    model,
    performances: recent,
    features,
    odds,
    missing,
    information_cutoff_at: cutoff,
  };
  const prompt =
    "TurfLab prompt-v1\n事実・推定・欠測を区別してください。出典を捏造せず、全有効出走馬を評価してください。全レースにnarrative展開分析を付け、数値試行を実施したと自己申告しないでください。推奨は本人購入ではありません。出典確認は本人が行います。既存予想を改変せず新しいprediction_idを使用してください。\n固定入力:\n" +
    canonical(fixed) +
    "\n返却JSON Schema:\n" +
    canonical(importSchema);
  const promptHash = await hash(prompt);
  const eventId = `prompt:${promptHash}`;
  const prior = await repo.get("audit_events", eventId);
  await immutablePut(repo, "audit_events", {
    schema_version: "0.2",
    created_at: prior?.created_at ?? now,
    event_id: eventId,
    operation_id: eventId,
    actor: "owner",
    action: "generate-prompt",
    entity_type: "race_snapshots",
    entity_id: snapshotId,
    before_hash: null,
    after_hash: promptHash,
    event_at: prior?.event_at ?? now,
    evidence_json: {
      prompt_version: "prompt-v1",
      prompt,
      prompt_hash: promptHash,
      input_hash: await hash(fixed),
      model_version_id: modelId,
      information_cutoff_at: cutoff,
    },
  });
  return {
    prompt_id: eventId,
    prompt_version: "prompt-v1",
    prompt,
    prompt_hash: await hash(prompt),
    input_hash: await hash(fixed),
    missing,
  };
}
export async function detail(repo: Repository, raceId: string): Promise<Row> {
  const race = await get(repo, "races", raceId);
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === raceId,
  );
  const course = await get(repo, "course_layouts", str(race, "course_id"));
  const track = await get(repo, "tracks", str(course, "track_id"));
  const published = (await repo.list("predictions")).filter(
    (p) => p.race_id === raceId,
  );
  const predictions: Row[] = [];
  for (const p of published) {
    const op = await repo.get("import_operations", str(p, "import_id"));
    if (
      op &&
      obj(obj(op.stage_checkpoint_json)[str(p, "prediction_id")]).status ===
        "complete"
    )
      predictions.push(p);
  }
  const ids = predictions.map((p) => p.prediction_id);
  const select = async (t: Table) =>
    (await repo.list(t)).filter(
      (r) => r.race_id === raceId || ids.includes(r.prediction_id ?? null),
    );
  return {
    race,
    course,
    track,
    entries: await Promise.all(
      entries.map(async (e) => ({
        ...e,
        horse: await get(repo, "horses", str(e, "horse_id")),
        jockey: await get(repo, "jockeys", str(e, "jockey_id")),
        past5: (await repo.list("performances"))
          .filter((p) => p.horse_id === e.horse_id)
          .sort((a, b) => instant(b.valid_as_of) - instant(a.valid_as_of))
          .slice(0, 5),
      })),
    ),
    predictions,
    snapshots: await select("race_snapshots"),
    evaluations: await select("horse_evaluations"),
    simulations: await select("simulation_runs"),
    recommendations: await select("recommendations"),
    bets: await select("virtual_bets"),
    results: await select("race_results"),
    adoptions: await select("prediction_adoptions"),
    reviews: await select("reviews"),
  };
}
export async function dashboard(repo: Repository, date: string): Promise<Row> {
  requireCondition(/^\d{4}-\d\d-\d\d$/.test(date), "日付はYYYY-MM-DDです");
  const races = (await repo.list("races"))
    .filter((r) => r.race_date_jst === date)
    .sort(
      (a, b) => instant(a.scheduled_start_at) - instant(b.scheduled_start_at),
    );
  const bets = (await repo.list("virtual_bets")).filter(
    (b) => b.budget_date_jst === date && b.status === "confirmed",
  );
  const spent = bets.reduce((s, b) => s + Number(b.amount_yen), 0);
  const cards: Row[] = [];
  for (const r of races) {
    const d = await detail(repo, str(r, "race_id"));
    const predictions = rows(d.predictions);
    cards.push({
      ...r,
      prediction_status: predictions.some((p) => p.status === "locked")
        ? "locked"
        : predictions.length
          ? "validated"
          : "missing",
      missing: !rows(d.entries).length
        ? ["出走馬が未取得"]
        : !predictions.length
          ? ["予想が未取り込み"]
          : [],
      spent_yen: bets
        .filter((b) => b.race_id === r.race_id)
        .reduce((s, b) => s + Number(b.amount_yen), 0),
    });
  }
  return {
    date,
    races: cards,
    spent_yen: spent,
    remaining_yen: 5000 - spent,
    purchase_stats: await purchaseStats(repo),
    daily_runs: (await repo.list("daily_runs")).filter(
      (r) => r.run_date_jst === date,
    ),
    logs: (await repo.list("run_logs"))
      .filter((l) => jstDate(String(l.created_at)) === date)
      .slice(-30),
  };
}
export interface InboxItem {
  operation_id: string;
  kind: "master" | "prediction" | "result" | "review";
  payload: Row;
}
export async function sheetsInbox(
  sheets: SheetsRepository,
): Promise<InboxItem[]> {
  const metadata = await sheets.inspect();
  const present = (metadata.sheets as { properties: { title: string } }[]).some(
    (s) => s.properties.title === "TL_chatgpt_inbox",
  );
  if (!present) return [];
  const values =
    (await sheets.client.batchRead(["'TL_chatgpt_inbox'!A1:D501"]))[0]
      ?.values ?? [];
  requireCondition(
    canonical(values[0]) ===
      canonical(["operation_id", "kind", "payload_json", "ready"]),
    "ChatGPT受信タブの列が不一致です",
  );
  return values
    .slice(1)
    .filter((r) => r[0] && r[3] === true)
    .map((r) => {
      requireCondition(
        ["master", "prediction", "result", "review"].includes(String(r[1])),
        "受信種別が不正です",
      );
      requireCondition(typeof r[2] === "string", "payload_jsonが必要です");
      return {
        operation_id: String(r[0]),
        kind: r[1] as InboxItem["kind"],
        payload: obj(JSON.parse(r[2] as string)),
      };
    });
}
export async function dailyRun(
  repo: Repository,
  items: InboxItem[],
  operationId: string,
  now: string,
): Promise<Row> {
  const date = jstDate(now);
  const id = `daily:${operationId}`;
  const prior = await repo.get("daily_runs", id);
  if (prior?.status === "complete" || prior?.status === "skipped") return prior;
  let failures = 0,
    completed = 0;
  const logs = await repo.list("run_logs");
  // Results are ingested before predictions. The existing 09:00 ChatGPT task supplies analysis.
  const ordered = [...items].sort(
    (a, b) =>
      (a.kind === "result" ? 0 : a.kind === "master" ? 1 : 2) -
      (b.kind === "result" ? 0 : b.kind === "master" ? 1 : 2),
  );
  const daily: Row = {
    schema_version: "0.2",
    created_at: prior?.created_at ?? now,
    daily_run_id: id,
    run_date_jst: date,
    run_kind: "sheets-sync",
    operation_id: operationId,
    status: "running",
    race_ids_json: [],
    expected_counts_json: { items: ordered.length },
    completed_counts_json: { items: 0 },
    started_at: prior?.started_at ?? now,
    completed_at: null,
  };
  await repo.put("daily_runs", daily);
  for (const item of ordered) {
    const completedLog = logs.find(
      (l) => l.operation_id === item.operation_id && l.status === "complete",
    );
    if (completedLog) {
      requireCondition(
        completedLog.expected_hash === (await hash(item.payload)),
        "受信操作IDの内容が変更されています",
        409,
      );
      completed++;
      continue;
    }
    const attempts = logs.filter(
      (l) => l.operation_id === item.operation_id,
    ).length;
    const logId = `log:${item.operation_id}:${attempts + 1}`;
    if (attempts >= 3) {
      failures++;
      continue;
    }
    try {
      const itemRepo = new StagedRepository(repo);
      if (item.kind === "master")
        await ingestMaster(
          repo,
          { ...item.payload, operation_id: item.operation_id },
          now,
        );
      else if (item.kind === "result") {
        const result = await saveResult(itemRepo, item.payload, now);
        if (["official", "cancelled"].includes(str(result, "official_status")))
          await settle(itemRepo, str(result, "result_id"), now);
      } else if (item.kind === "prediction") {
        const report = await preview(itemRepo, item.payload, now);
        requireCondition(
          rows(report.predictions).every((p) => p.valid),
          "受信予想の検証失敗",
        );
        const op = await saveImport(itemRepo, item.payload, now);
        requireCondition(op.status === "complete", "受信予想が部分保存です");
      } else {
        requireCondition(
          false,
          "レビューは本人が画面から内容確認後に保存してください",
        );
      }
      for (const change of itemRepo.changes.values())
        await repo.put(change.table, change.after);
      await immutablePut(repo, "run_logs", {
        schema_version: "0.2",
        created_at: now,
        log_id: logId,
        daily_run_id: id,
        operation_id: item.operation_id,
        stage: item.kind,
        attempt: attempts + 1,
        status: "complete",
        error_code: null,
        safe_message: "保存・読み返し完了",
        expected_hash: await hash(item.payload),
        actual_hash: await hash(item.payload),
      });
      completed++;
    } catch {
      failures++;
      await immutablePut(repo, "run_logs", {
        schema_version: "0.2",
        created_at: now,
        log_id: logId,
        daily_run_id: id,
        operation_id: item.operation_id,
        stage: item.kind,
        attempt: attempts + 1,
        status: "failed",
        error_code: "VALIDATION_OR_STORAGE",
        safe_message: "取り込み失敗。入力・接続・参照を確認してください",
        expected_hash: await hash(item.payload),
        actual_hash: null,
      });
    }
  }
  const candidates = (await repo.list("races"))
    .filter((r) => r.race_date_jst === date && r.status === "scheduled")
    .slice(0, 5);
  const output = {
    ...daily,
    status: failures ? "partial" : ordered.length ? "complete" : "skipped",
    race_ids_json: candidates.map((r) => r.race_id),
    completed_counts_json: { items: completed, failed: failures },
    completed_at: failures ? null : now,
    evidence_json: {
      ai_api_cost_yen: 0,
      analysis_source: "既存ChatGPT毎朝9時タスク",
      reason: ordered.length
        ? "受信処理"
        : "新しい受信データなし。開催なし・不足時も正常",
    },
  };
  await repo.put("daily_runs", output);
  return output;
}
export async function integrityReport(repo: Repository): Promise<Row> {
  const errors: Row[] = [];
  const counts: Row = {};
  for (const t of tables) {
    const content = await repo.list(t);
    counts[t] = content.length;
    const seen = new Set<string>();
    for (const r of content) {
      const id = idOf(t, r);
      if (seen.has(id)) errors.push({ table: t, id, error: "ID重複" });
      seen.add(id);
      try {
        validateRow(t, r);
        for (const [key, target] of Object.entries(references[t] ?? {}))
          if (r[key] != null) await get(repo, target, String(r[key]));
        if (t === "race_snapshots")
          requireCondition(
            r.input_hash === (await hash(snapshotContents(r))),
            "snapshotハッシュ不一致",
          );
      } catch (e) {
        errors.push({
          table: t,
          id,
          error: e instanceof Error ? e.message : "整合性エラー",
        });
      }
    }
  }
  return { counts, errors, checked_at: new Date().toISOString() };
}
