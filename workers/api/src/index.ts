import { entityMemory, saveEntityMemory } from "./entity-memory";
import { backfillRunRecords, horseRunView, raceRunView, saveCsvRuns, saveJockeyStats, statRuns } from "./run-records";
import { raceTrends } from "./race-trends";
import { coreCorpusExport, raceStatsDay, raceStatsSheet, saveTrackObservation } from "./race-stats";
import { chunkJson, digestSummary, validateDigest, type StatsDigest } from "../../../packages/shared/src/stats/digest";
import {
  canonical,
  DomainError,
  hash,
  obj,
  str,
  requireCondition,
  type Json,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import {
  backup,
  restoreEmpty,
  type Backup,
  type Repository,
} from "../../../packages/shared/src/repository";
import {
  simulate,
  expectedValues,
  type SimulationInput,
} from "../../../packages/simulation/src/engine";
import {
  SheetsRepository,
  GoogleSheetsClient,
  type GoogleCredentials,
} from "./sheets";
import {
  DurableRepository,
  StagedRepository,
  applyChanges,
  type Change,
} from "./storage";
import { adopt, lockPrediction, preview, saveImport } from "./imports";
import {
  backfillProvisional,
  enrichCoursesAndPerformances,
} from "./maintenance";
import { prepareRace, runBatch, runRace, safeFailure } from "./race-pipeline";
import {
  previewMaster,
  reviewIdentityCandidates,
  confirmMaster,
  inputPack,
  convertAnswer,
} from "./race-wizard";
import {
  audit,
  confirmBet,
  reviseBet,
  purchaseStats,
  recommendationStats,
  saveResult,
  settle,
  skipRace,
  voidBet,
} from "./betting";
import { adoptModel, analytics, backtest, saveReview } from "./analytics";
import { bridgeConvert } from "./github-bridge";
import { dailyStateExport, historicalOfficialResults } from "./daily-export";
import { importNameReference, withFormalStatus } from "./name-reference-intake";
import { reconcileReference } from "./reference-intake";
import { validateReferenceMirror } from "./reference-report";
import { importOfficialResult } from "./official-result-intake";
import { importGitHubChatReview } from "./github-chat-review-intake";
import { rankPerformance } from "./rank-analytics";
import { saveResearchBaseline } from "./local-research-baseline";
import { emitOperationalEvent } from "../../../packages/shared/src/operational-event";
import {
  getTablesMetadata,
  getTableData,
  executeQuery,
  type QueryRequest,
} from "./db-explorer";
import {
  dashboard,
  dailyRun,
  detail,
  ingestMaster,
  integrityReport,
  reanalysisPrompt,
  refreshEntries,
  sheetsInbox,
} from "./workflow";
export interface Env extends GoogleCredentials {
  API_TOKEN: string;
  STORAGE_MODE: "local" | "sheets";
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTOMATION_ENABLED: string;
}
function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
async function authenticated(
  request: Request,
  token: string,
): Promise<boolean> {
  if (!token || !(/^[0-9]{8}$/.test(token) || token.length >= 24)) return false;
  const provided =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const [a, b] = await Promise.all([hash(provided), hash(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function readBody(request: Request): Promise<Row> {
  requireCondition(
    request.headers.get("Content-Type")?.split(";")[0] === "application/json",
    "Content-Typeはapplication/jsonです",
    415,
  );
  // Catalog receipts include complete source documents; even one normal
  // production backup exceeds the ordinary mutation limit.
  const pathname = new URL(request.url).pathname;
  const largeBody = ["/api/restore", "/api/local-predictions/nar-csv/upload", "/api/local-predictions/stats-digest"].includes(pathname);
  // The worker publishes two days of race plans, evidence and reviews together.
  const limitKiB = largeBody ? 16 * 1024 : pathname === "/api/local-predictions/status" ? 1024 : 256;
  const reader = request.body?.getReader();
  requireCondition(reader, "本文が必要です", 400);
  let length = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limitKiB * 1024) {
      await reader.cancel();
      throw new DomainError(
        largeBody ? "アップロードまたは復元入力は16MiB以内です" :
          limitKiB === 1024 ? "状態通知は1MiB以内です" : "入力は256KiB以内です",
        413,
      );
    }
    parts.push(value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  try {
    return obj(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    throw new DomainError("JSON構文または本文が不正です", 400);
  }
}
export async function route(
  repo: Repository,
  request: Request,
  now: string,
  sheets?: SheetsRepository,
  digest: StatsDigest | null = null,
): Promise<unknown> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;
  const input = method === "POST" ? await readBody(request) : null;
  if (method === "GET" && path === "/race-stats")
    return raceStatsDay(repo, url.searchParams.get("date"), now, digest);
  if (method === "GET" && path === "/race-stats/corpus")
    return { digest: digestSummary(digest) };
  if (method === "GET" && path === "/race-stats/core-corpus")
    return coreCorpusExport(repo);
  if (method === "GET" && /^\/race-stats\/races\/[^/]+$/.test(path))
    return raceStatsSheet(repo, decodeURIComponent(path.split("/")[3]), digest, now);
  if (method === "POST" && path === "/race-stats/track-observations")
    return saveTrackObservation(repo, input!, now);
  if (method === "GET" && path === "/status")
    return {
      storage_mode: sheets ? "sheets" : "local",
      ai_api_enabled: false,
      timezone: "Asia/Tokyo",
      analysis_source: "既存ChatGPT毎朝9時タスク",
      schema_version: "0.2",
    };
  if (method === "GET" && path === "/races")
    return dashboard(
      repo,
      url.searchParams.get("date") ??
        new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10),
    );
  if (method === "GET" && /^\/races\/[^/]+\/runs$/.test(path))
    return raceRunView(repo, decodeURIComponent(path.split("/")[2]));
  if (method === "GET" && /^\/horses\/[^/]+\/runs$/.test(path))
    return horseRunView(repo, decodeURIComponent(path.split("/")[2]), url.searchParams.get("before"));
  if (method === "GET" && /^\/races\/[^/]+$/.test(path))
    return detail(repo, decodeURIComponent(path.split("/")[2]));
  if (method === "GET" && path === "/stats")
    return {
      purchases: await purchaseStats(repo),
      predictions: await analytics(repo),
      recommendations: await recommendationStats(repo),
      adopted_reference: await recommendationStats(repo, true),
      rank_metrics: await rankPerformance(repo),
    };
  if (method === "GET" && path === "/analytics/ranks")
    return rankPerformance(repo);
  if (method === "GET" && path === "/daily-state") {
    requireCondition(!sheets, "日次GitHubエクスポートはlocal保存専用です");
    return dailyStateExport(repo, now);
  }
  if (method === "GET" && path === "/backup") return backup(repo);
  if (method === "GET" && path === "/integrity") return integrityReport(repo);
  if (method === "GET" && path === "/db/tables") {
    return getTablesMetadata(repo);
  }
  const dbTableMatch = path.match(/^\/db\/table\/([^/]+)$/);
  if (method === "GET" && dbTableMatch) {
    const table = decodeURIComponent(dbTableMatch[1]) as Table;
    return getTableData(repo, table, {
      search: url.searchParams.get("search") ?? undefined,
      sortBy: url.searchParams.get("sortBy") ?? undefined,
      sortOrder: (url.searchParams.get("sortOrder") as "asc" | "desc") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
      filterSql: url.searchParams.get("filterSql") ?? undefined,
    });
  }
  if (method === "POST" && path === "/db/query") {
    return executeQuery(repo, input as unknown as QueryRequest);
  }
  if (method === "GET" && path === "/legacy") {
    requireCondition(sheets, "Sheets接続が未設定です", 503);
    return sheets.legacy();
  }
  if (method === "GET" && /^\/imports\/[^/]+$/.test(path))
    return repo.get(
      "import_operations",
      decodeURIComponent(path.split("/")[2]),
    );
  if (!input) throw new DomainError("APIが見つかりません", 404);
  if (path === "/local-predictions/baseline") {
    requireCondition(!sheets, "調査ベースラインはlocal保存専用です");
    return saveResearchBaseline(repo, input, now);
  }
  if (method === "POST" && path === "/local-predictions/official-results") {
    requireCondition(!sheets, "公式結果の振り返りはlocal保存専用です");
    const ids = input.race_ids;
    requireCondition(Array.isArray(ids) && ids.length <= 100 &&
      ids.every((id): id is string => typeof id === "string" && id.length > 0),
    "レースIDは100件以内です");
    return historicalOfficialResults(repo, ids as string[]);
  }
  if (path === "/local-predictions/entity-memory/save") {
    requireCondition(!sheets, "個体メモリはlocal保存専用です");
    return saveEntityMemory(repo, input, now);
  }
  if (path === "/local-predictions/run-records/csv") {
    requireCondition(!sheets, "過去走の保存はlocal保存専用です");
    return saveCsvRuns(repo, input, now);
  }
  if (path === "/local-predictions/run-records/stat-runs") {
    requireCondition(!sheets, "過去走の集計はlocal保存専用です");
    return statRuns(repo, input);
  }
  if (path === "/local-predictions/jockey-stats/save") {
    requireCondition(!sheets, "騎手統計はlocal保存専用です");
    return saveJockeyStats(repo, input, now);
  }
  if (path === "/maintenance/run-records/backfill") {
    requireCondition(!sheets, "過去走の移行はlocal保存専用です");
    return backfillRunRecords(repo, now);
  }
  if (path === "/local-predictions/trends") {
    requireCondition(!sheets, "傾向集計はlocal保存専用です");
    return raceTrends(repo, input, now);
  }
  if (path === "/local-predictions/entity-memory") {
    requireCondition(!sheets, "個体メモリはlocal保存専用です");
    return entityMemory(repo, input, now);
  }
  if (path.startsWith("/race-import/")) {
    requireCondition(
      !sheets,
      "取込ウィザードはlocal保存専用です。既存Sheetsには書き込みません",
    );
    if (path === "/race-import/identity-candidates")
      return reviewIdentityCandidates(repo, input);
    if (path === "/race-import/preview") return previewMaster(repo, input, now);
    if (path === "/race-import/confirm") return confirmMaster(repo, input, now);
    if (path === "/race-import/pack")
      return inputPack(repo, str(input, "snapshot_id"), now);
    if (path === "/race-import/convert") return convertAnswer(repo, input, now);
  }
  if (path === "/github-bridge/chat-review-register") {
    requireCondition(!sheets, "チャットレビューCore連携はlocal保存専用です");
    return importGitHubChatReview(repo, input, now);
  }
  if (path === "/github-bridge/official-result") {
    requireCondition(!sheets, "公式結果Bridgeはlocal保存専用です");
    return importOfficialResult(repo, input, now);
  }
  if (path === "/github-bridge/reference-register") {
    requireCondition(!sheets, "名前登録はlocal保存専用です");
    return withFormalStatus(repo, await importNameReference(repo, input, now));
  }
  if (path === "/github-bridge/reference-preview") {
    requireCondition(!sheets, "参考分析の照合はlocal保存専用です");
    return reconcileReference(repo, input, now);
  }
  if (path === "/github-bridge/convert") {
    requireCondition(!sheets, "GitHub Bridgeはlocal保存専用です");
    return bridgeConvert(repo, input, now);
  }
  if (path === "/data/import") return ingestMaster(repo, input, now);
  if (path === "/imports/validate") return preview(repo, input, now);
  if (path === "/imports") return saveImport(repo, input, now);
  if (path === "/pipeline/preview") return prepareRace(repo, input, now);
  if (path === "/pipeline/race") return runRace(repo, input, now);
  if (path === "/pipeline/batch") return runBatch(repo, input, now);
  const entriesRefresh = path.match(/^\/races\/([^/]+)\/refresh-entries$/);
  if (entriesRefresh)
    return refreshEntries(
      repo,
      decodeURIComponent(entriesRefresh[1]),
      input,
      now,
    );
  const revision = path.match(/^\/bets\/([^/]+)\/revise$/);
  if (revision)
    return reviseBet(repo, decodeURIComponent(revision[1]), input, now);
  if (path === "/bets") return confirmBet(repo, input, now);
  if (path === "/skip") return skipRace(repo, input, now);
  if (path === "/results") return saveResult(repo, input, now);
  if (path === "/reviews") return saveReview(repo, input, now);
  if (path === "/backtests") return backtest(repo, input);
  if (path === "/models/adopt") return adoptModel(repo, input, now);
  if (path === "/maintenance/enrich") {
    return enrichCoursesAndPerformances(repo, now);
  }
  if (path === "/maintenance/provisional-backfill") {
    requireCondition(!sheets, "暫定予想のバックフィルはlocal保存専用です");
    return backfillProvisional(repo, input, now);
  }
  if (path === "/restore") {
    await restoreEmpty(repo, input as unknown as Backup);
    return { status: "restored" };
  }
  if (path === "/sheets/provision") {
    requireCondition(sheets, "Sheets接続が未設定です", 503);
    await sheets.provision();
    return { status: "provisioned" };
  }
  if (path === "/sync") {
    requireCondition(sheets, "Sheets接続が未設定です", 503);
    return dailyRun(
      repo,
      await sheetsInbox(sheets),
      str(input, "operation_id"),
      now,
    );
  }
  const match = path.match(
    /^\/(predictions|races|bets|results)\/([^/]+)\/(lock|adopt|reanalysis-prompt|void|settle|simulate)$/,
  );
  if (match) {
    const [, entity, rawId, action] = match;
    const id = decodeURIComponent(rawId);
    if (entity === "predictions" && action === "lock") {
      const p = await lockPrediction(repo, id, now);
      await audit(
        repo,
        str(input, "operation_id"),
        "lock",
        "predictions",
        now,
        null,
        p,
      );
      return p;
    }
    if (entity === "races" && action === "adopt")
      return adopt(repo, id, str(input, "prediction_id"), now);
    if (entity === "races" && action === "reanalysis-prompt")
      return reanalysisPrompt(
        repo,
        id,
        str(input, "snapshot_id"),
        str(input, "model_version_id"),
        str(input, "information_cutoff_at"),
        now,
      );
    if (entity === "bets" && action === "void")
      return voidBet(repo, id, str(input, "operation_id"), now);
    if (entity === "results" && action === "settle")
      return settle(repo, id, now);
    if (entity === "predictions" && action === "simulate") {
      const prediction = await repo.get("predictions", id);
      requireCondition(prediction, "予想参照がありません", 404);
      const simulationInput = obj(input.input) as unknown as SimulationInput;
      requireCondition(
        simulationInput.cutoff_at === prediction.information_cutoff_at,
        "予想と数値入力の締切が不一致です",
      );
      const snapshot = await repo.get(
        "race_snapshots",
        str(prediction, "snapshot_id"),
      );
      requireCondition(snapshot, "snapshotがありません", 404);
      const entries = (await repo.list("race_entries")).filter(
        (e) => e.race_id === prediction.race_id && e.status === "active",
      );
      requireCondition(
        canonical(entries.map((e) => e.entry_id).sort()) ===
          canonical(simulationInput.runners.map((r) => r.entry_id).sort()),
        "数値入力は全有効出走馬が必要です",
      );
      requireCondition(
        simulationInput.runners.every((r) =>
          entries.some(
            (e) =>
              e.entry_id === r.entry_id && e.horse_number === r.horse_number,
          ),
        ),
        "数値入力の馬番が不一致です",
      );
      const model = await repo.get(
        "model_versions",
        str(prediction, "model_version_id"),
      );
      requireCondition(
        model?.engine_version === "segment-mc-v1",
        "モデルのエンジン版を固定してください",
      );
      requireCondition(
        typeof input.seed === "number" && typeof input.trial_count === "number",
        "seed・試行数は数値です",
      );
      const output = await simulate(
        simulationInput,
        Number(input.seed),
        Number(input.trial_count),
      );
      const cutoffOdds = [];
      for (const oid of (snapshot.odds_snapshot_ids_json ?? []) as string[]) {
        const o = await repo.get("odds_snapshots", oid);
        requireCondition(
          o && o.race_id === prediction.race_id,
          "オッズ参照不足",
        );
        cutoffOdds.push({
          ticket_type: str(o, "ticket_type"),
          selections: o.selections_json as number[],
          odds: Number(o.odds),
          source: o,
        });
      }
      const ev = expectedValues(output, cutoffOdds, simulationInput.cutoff_at);
      const simId = str(input, "simulation_id");
      const existing = await repo.get("simulation_runs", simId);
      const row: Row = {
        schema_version: "0.2",
        created_at: existing?.created_at ?? now,
        simulation_id: simId,
        prediction_id: id,
        mode: "numeric",
        status: "complete",
        scenarios_json: simulationInput.scenarios as unknown as Json,
        input_hash: output.input_hash,
        engine_version: output.engine_version,
        seed: output.seed,
        trial_count: output.trial_count,
        outputs_json: { ...output, input: simulationInput } as unknown as Json,
        evidence_json: { expected_values: ev },
        started_at: existing?.started_at ?? now,
        completed_at: existing?.completed_at ?? now,
      };
      requireCondition(
        !existing || canonical(existing) === canonical(row),
        "数値実行IDの競合",
        409,
      );
      await repo.put("simulation_runs", row);
      return row;
    }
  }
  throw new DomainError("APIが見つかりません", 404);
}
export class TurfCoordinator {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  private underlying(): Repository {
    return this.env.STORAGE_MODE === "sheets"
      ? new SheetsRepository(new GoogleSheetsClient(this.env))
      : new DurableRepository(this.state.storage);
  }
  /** The latest stats digest pushed by the local worker (null when none). */
  private async loadDigest(): Promise<StatsDigest | null> {
    const meta = await this.state.storage.get<Row>("stats-digest-meta");
    if (!meta) return null;
    const keys = Array.from({ length: Number(meta.chunks) }, (_, i) => `stats-digest-chunk:${i}`);
    const parts: string[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const got = await this.state.storage.get<string>(keys.slice(i, i + 100));
      for (const k of keys.slice(i, i + 100)) parts.push(got.get(k) ?? "");
    }
    try {
      return validateDigest(JSON.parse(parts.join("")));
    } catch {
      return null;
    }
  }
  async fetch(request: Request): Promise<Response> {
    const task = this.queue.then(async () => {
      if (!(await authenticated(request, this.env.API_TOKEN)))
        return response({ error: "本人用認証が必要です" }, 401);
      try {
        const bridgePath = new URL(request.url).pathname;
        if (bridgePath === "/api/local-predictions/status") {
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          if (request.method === "GET") {
            const status = await this.state.storage.get<Row>("local-predictions-status") ?? { status: "disabled" };
            const plans = await this.state.storage.get<Row>("local-prediction-bet-plans");
            const provisional = await this.state.storage.get<Row>("local-prediction-provisional");
            const external = await this.state.storage.get<Row>("local-prediction-external-forecasts");
            const reviews = await this.state.storage.get<Row>("local-prediction-reviews");
            const ledger = await this.state.storage.get<Row>("local-prediction-ledger");
            return response({
              ...status,
              ...plans,
              ...provisional,
              ...external,
              ...reviews,
              ...(ledger ? { ledger } : {}),
            });
          }
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const input = await readBody(request);
          requireCondition(["healthy", "failed", "running"].includes(String(input.status)), "状態が不正です");
          const {
            race_bet_plans,
            race_bet_plans_date,
            race_provisional_predictions,
            race_provisional_predictions_date,
            race_external_forecasts,
            race_external_forecasts_date,
            race_reviews,
            race_reviews_date,
            ledger,
            ...status
          } = input;
          await this.state.storage.put({
            "local-predictions-status": status,
            ...(input.status === "healthy" && Array.isArray(race_bet_plans) &&
              typeof race_bet_plans_date === "string" && {
              "local-prediction-bet-plans": { race_bet_plans, race_bet_plans_date },
            }),
            ...(input.status === "healthy" && Array.isArray(race_provisional_predictions) &&
              typeof race_provisional_predictions_date === "string" && {
              "local-prediction-provisional": {
                race_provisional_predictions,
                race_provisional_predictions_date,
              },
            }),
            ...(input.status === "healthy" && Array.isArray(race_external_forecasts) &&
              typeof race_external_forecasts_date === "string" && {
              "local-prediction-external-forecasts": {
                race_external_forecasts,
                race_external_forecasts_date,
              },
            }),
            ...(input.status === "healthy" && Array.isArray(race_reviews) &&
              typeof race_reviews_date === "string" && {
              "local-prediction-reviews": {
                race_reviews,
                race_reviews_date,
              },
            }),
            ...(ledger && typeof ledger === "object" && {
              "local-prediction-ledger": ledger as Row,
            }),
          });
          return response({ status: "saved" });
        }
        if (bridgePath === "/api/local-predictions/stats-digest") {
          if (request.method === "GET")
            return response({ digest: digestSummary(await this.loadDigest()) });
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const digest = validateDigest((await readBody(request)).digest);
          const current = await this.state.storage.get<Row>("stats-digest-meta");
          if (current && String(current.built_at) > digest.built_at)
            return response({ status: "older_ignored", built_at: current.built_at });
          const chunks = chunkJson(digest);
          const puts: Record<string, unknown> = {};
          chunks.forEach((c, i) => (puts[`stats-digest-chunk:${i}`] = c));
          const entries = Object.entries(puts);
          for (let i = 0; i < entries.length; i += 100)
            await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
          const stale: string[] = [];
          for (let i = chunks.length; i < Number(current?.chunks ?? 0); i++) stale.push(`stats-digest-chunk:${i}`);
          if (stale.length) await this.state.storage.delete(stale);
          await this.state.storage.put("stats-digest-meta", { built_at: digest.built_at, chunks: chunks.length });
          return response({ status: "saved", chunks: chunks.length, summary: digestSummary(digest) });
        }
        if (bridgePath === "/api/local-predictions/ledger") {
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const input = await readBody(request);
          const ledger = input.ledger;
          requireCondition(Boolean(ledger && typeof ledger === "object"), "台帳データが不正です");
          await this.state.storage.put("local-prediction-ledger", ledger as Row);
          return response({ status: "saved" });
        }
        if (bridgePath === "/api/local-predictions/nar-csv/upload") {
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const input = await readBody(request);
          const rawName = String(input.filename ?? "").split(/[/\\]/).pop() ?? "";
          const filename = rawName.replace(/[^\w.\-()\u3000-\u9FFF]/gu, "_");
          requireCondition(/\.(csv|zip)$/i.test(filename), "CSVまたはZIPファイルのみ対応しています");
          const b64 = String(input.content_base64 ?? "");
          requireCondition(b64.length > 0 && b64.length <= 16 * 1024 * 1024, "ファイルサイズが不正です");
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const chunkSize = 64 * 1024;
          const chunks = Math.ceil(b64.length / chunkSize);
          const puts: Record<string, unknown> = {};
          for (let i = 0; i < chunks; i++) {
            puts[`nar-csv-chunk:${id}:${i}`] = b64.slice(i * chunkSize, (i + 1) * chunkSize);
          }
          const pending = (await this.state.storage.get<Row[]>("nar-csv-pending")) ?? [];
          pending.push({
            id,
            filename,
            chunks,
            size_bytes: Math.floor((b64.length * 3) / 4),
            uploaded_at: new Date().toISOString(),
          });
          puts["nar-csv-pending"] = pending;
          await this.state.storage.put(puts);
          return response({ ok: true, id, filename, pending_count: pending.length });
        }
        if (bridgePath === "/api/local-predictions/nar-csv/pending") {
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          requireCondition(request.method === "GET", "GETが必要です", 405);
          const includeData = new URL(request.url).searchParams.get("include_data") === "1";
          const pending = (await this.state.storage.get<Row[]>("nar-csv-pending")) ?? [];
          if (!includeData) return response({ items: pending });
          const items: Row[] = [];
          for (const meta of pending) {
            const chunks = Number(meta.chunks ?? 0);
            let b64 = "";
            for (let i = 0; i < chunks; i++) {
              b64 += String((await this.state.storage.get<string>(`nar-csv-chunk:${meta.id}:${i}`)) ?? "");
            }
            items.push({ ...meta, content_base64: b64 });
          }
          return response({ items });
        }
        if (bridgePath === "/api/local-predictions/nar-csv/ack") {
          requireCondition(this.env.STORAGE_MODE === "local", "local保存専用です");
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const input = await readBody(request);
          const ackIds = new Set(Array.isArray(input.ids) ? input.ids.map(String) : []);
          const pending = (await this.state.storage.get<Row[]>("nar-csv-pending")) ?? [];
          const remain: Row[] = [];
          const keysToDelete: string[] = [];
          for (const meta of pending) {
            if (ackIds.has(String(meta.id))) {
              const chunks = Number(meta.chunks ?? 0);
              for (let i = 0; i < chunks; i++) keysToDelete.push(`nar-csv-chunk:${meta.id}:${i}`);
            } else {
              remain.push(meta);
            }
          }
          if (keysToDelete.length) await this.state.storage.delete(keysToDelete);
          await this.state.storage.put("nar-csv-pending", remain);
          return response({ ok: true, remaining: remain.length });
        }
        if (
          [
            "/api/github-bridge/status",
            "/api/github-bridge/control",
            "/api/github-bridge/sync",
            "/api/github-bridge/export",
            "/api/github-bridge/report",
            "/api/github-bridge/reference-report",
            "/api/github-bridge/reviews",
          ].includes(bridgePath)
        ) {
          requireCondition(
            this.env.STORAGE_MODE === "local",
            "GitHub Bridgeはlocal保存専用です",
          );
          const commands =
            (await this.state.storage.get<Row[]>("github-commands")) ?? [];
          const status = (await this.state.storage.get<Row>(
            "github-status",
          )) ?? { configured: false, records: [] };
          if (request.method === "GET" && bridgePath.endsWith("/status"))
            return response({ ...status, pending_commands: commands.length });
          if (request.method === "GET" && bridgePath.endsWith("/control"))
            return response({ commands });
          if (bridgePath.endsWith("/reference-report")) {
            // `github-reference` keeps the latest mirror (older clients);
            // `github-references` keeps the latest mirror of each producer.
            const latestMirror =
              await this.state.storage.get<Row>("github-reference");
            const byProducer =
              (await this.state.storage.get<Row>("github-references")) ?? {};
            const producerOf = (m: Row) =>
              String(m.producer ?? obj(m.document).producer ?? "chatgpt");
            if (latestMirror && !byProducer[producerOf(latestMirror)])
              byProducer[producerOf(latestMirror)] = latestMirror;
            if (request.method === "GET")
              return response(
                latestMirror
                  ? { ...latestMirror, by_producer: byProducer }
                  : { status: "empty" },
              );
            requireCondition(request.method === "POST", "POSTが必要です", 405);
            const incoming = validateReferenceMirror(
              await readBody(request),
              new Date().toISOString(),
            );
            const existing = byProducer[String(incoming.producer)] as
              | Row
              | undefined;
            if (existing?.path === incoming.path) {
              requireCondition(
                existing.sha === incoming.sha,
                "同日の参考JSONが変更されています。既存参照を保持します",
                409,
              );
              return response({ status: "already_saved", path: existing.path });
            }
            requireCondition(
              !existing ||
                String(incoming.date_jst) > String(existing.date_jst) ||
                (incoming.date_jst === existing.date_jst &&
                  Number(String(incoming.path).match(/-v(\d+)\.json$/)?.[1]) >
                    Number(String(existing.path).match(/-v(\d+)\.json$/)?.[1])),
              "過去の参考レポートで最新を置き換えられません",
              409,
            );
            byProducer[String(incoming.producer)] = incoming;
            await this.state.storage.put("github-references", byProducer);
            if (
              !latestMirror ||
              String(incoming.date_jst) >= String(latestMirror.date_jst)
            )
              await this.state.storage.put("github-reference", incoming);
            return response({ status: "saved", path: incoming.path });
          }
          if (bridgePath.endsWith("/reviews")) {
            const stored =
              (await this.state.storage.get<Record<string, Row>>("github-chat-reviews")) ?? {};
            if (request.method === "GET") {
              const url = new URL(request.url);
              const date = url.searchParams.get("date");
              const list = Object.values(stored);
              const filtered = date
                ? list.filter((r) => {
                    const doc = obj(r.document);
                    const docDate = String(doc.recorded_for_date_jst ?? r.date_jst ?? "");
                    const race = obj(doc.race ?? {});
                    const raceDate = String(race.scheduled_start_at_jst ??
                      race.scheduled_start_jst ?? "").slice(0, 10);
                    return docDate === date || raceDate === date;
                  })
                : list;
              return response({ reviews: filtered });
            }
            requireCondition(request.method === "POST", "POSTが必要です", 405);
            const incoming = await readBody(request);
            requireCondition(typeof incoming.path === "string", "pathが必要です");
            const prior = stored[String(incoming.path)];
            requireCondition(!prior || prior.sha === incoming.sha,
              "同じレビューJSONの内容変更は禁止です。新しい版を作成してください", 409);
            const link = obj(incoming.core_link ?? {});
            stored[String(incoming.path)] = {
              path: incoming.path,
              sha: incoming.sha,
              date_jst: incoming.date_jst ?? String(incoming.path).split("/")[1],
              document: incoming.document,
              core_link_status: link.status ?? "unmatched",
              core_race_id: link.race_id ?? null,
              core_review_id: link.review_id ?? null,
              updated_at: new Date().toISOString(),
            };
            await this.state.storage.put("github-chat-reviews", stored);
            return response({ status: "saved", path: incoming.path,
              core_link_status: link.status ?? "unmatched" });
          }
          requireCondition(request.method === "POST", "POSTが必要です", 405);
          const input = await readBody(request);
          if (bridgePath.endsWith("/report")) {
            const report = obj(input.status);
            requireCondition(
              Array.isArray(report.records) && report.records.length <= 100,
              "同期履歴は100件以内です",
            );
            await this.state.storage.put("github-status", report);
            const ack = Array.isArray(input.ack) ? input.ack : [];
            await this.state.storage.put(
              "github-commands",
              commands.filter((c) => !ack.includes(c.id!)),
            );
            return response({ status: "saved" });
          }
          const kind = bridgePath.endsWith("/export") ? "export" : "sync";
          const snapshot = kind === "export" ? str(input, "snapshot_id") : "";
          if (
            !commands.some((c) => c.kind === kind && c.snapshot_id === snapshot)
          ) {
            requireCondition(
              commands.length < 50,
              "同期要求が多すぎます。Workerを確認してください",
              409,
            );
            commands.push({
              id: crypto.randomUUID(),
              kind,
              snapshot_id: snapshot,
            });
            await this.state.storage.put("github-commands", commands);
          }
          return response({
            status: "queued",
            message: "同期Workerへ要求しました",
          });
        }
        if (
          request.method === "GET" &&
          new URL(request.url).pathname === "/api/pipeline/diagnostics"
        )
          return response({
            failure:
              (await this.state.storage.get("last-storage-failure")) ?? null,
            pending_journal: Boolean(
              await this.state.storage.get("pending-journal"),
            ),
          });
        const repo = this.underlying();
        const pending =
          await this.state.storage.get<Change[]>("pending-journal");
        if (pending) {
          await applyChanges(repo, pending);
          await this.state.storage.delete("pending-journal");
        }
        const staged = new StagedRepository(repo);
        // Pipeline stages commit through the same durable journal, then read the
        // underlying storage. A batch finishes each race before starting another.
        const pipelinePath = new URL(request.url).pathname;
        if (
          ["/api/pipeline/race", "/api/pipeline/batch"].includes(
            pipelinePath,
          ) &&
          request.method === "POST"
        ) {
          const input = await readBody(request);
          const commit = async (changes: Change[]) => {
            if (!changes.length) return;
            const unfinished =
              await this.state.storage.get<Change[]>("pending-journal");
            if (unfinished) {
              await applyChanges(repo, unfinished);
              await this.state.storage.delete("pending-journal");
            }
            await this.state.storage.put("pending-journal", changes);
            await applyChanges(repo, changes);
            await this.state.storage.delete("pending-journal");
          };
          return response(
            await (pipelinePath.endsWith("/batch") ? runBatch : runRace)(
              repo,
              input,
              new Date().toISOString(),
              commit,
              () => new Date().toISOString(),
            ),
          );
        }
        const result = await route(
          staged,
          request,
          new Date().toISOString(),
          repo instanceof SheetsRepository ? repo : undefined,
          bridgePath.startsWith("/api/race-stats") ? await this.loadDigest() : null,
        );
        if (staged.changes.size) {
          const changes = [...staged.changes.values()];
          await this.state.storage.put("pending-journal", changes);
          await applyChanges(repo, changes);
          await this.state.storage.delete("pending-journal");
        }
        return response(
          result ?? { error: "見つかりません" },
          result === undefined ? 404 : 200,
        );
      } catch (e) {
        const failure = safeFailure(
          e,
          "journal-or-route",
          new URL(request.url).pathname,
        );
        await this.state.storage.put("last-storage-failure", {
          ...failure,
          recorded_at: new Date().toISOString(),
        });
        return response(
          {
            error: String(failure.message),
            failure,
          },
          Number(failure.status),
        );
      }
    });
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!/^\/api(?:\/|$)/.test(url.pathname)) return env.ASSETS.fetch(request);
    const started = Date.now();
    const operation = url.pathname
      .replace(/^\/api/, "")
      .replace(/\/(races|bets|results|predictions)\/[^/]+/g, "/$1/:id");
    let status = 500;
    let authenticatedRequest = false;
    try {
      if (!(await authenticated(request, env.API_TOKEN))) {
        status = 401;
        return response({ error: "本人用認証が必要です" }, 401);
      }
      authenticatedRequest = true;
      const result = await env.COORDINATOR.get(
        env.COORDINATOR.idFromName("owner"),
      ).fetch(request);
      status = result.status;
      return result;
    } finally {
      emitOperationalEvent({
        event: "api.request.completed",
        component: "api",
        request_id: crypto.randomUUID(),
        method: request.method,
        operation,
        authenticated: authenticatedRequest,
        status,
        outcome: status >= 500 ? "error" : status >= 400 ? "rejected" : "success",
        duration_ms: Date.now() - started,
      });
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (env.AUTOMATION_ENABLED !== "true" || env.STORAGE_MODE !== "sheets")
      return;
    ctx.waitUntil(
      env.COORDINATOR.get(env.COORDINATOR.idFromName("owner"))
        .fetch(
          new Request("https://internal/api/sync", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              operation_id: `scheduled:${new Date().toISOString().slice(0, 16)}`,
            }),
          }),
        )
        .then((r) => {
          if (!r.ok) throw new Error("Sheets同期に失敗しました");
        }),
    );
  },
};
