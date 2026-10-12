import {
  canonical,
  DomainError,
  hash,
  obj,
  str,
  requireCondition,
  type Json,
  type Row,
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
import { prepareRace, runBatch, runRace, safeFailure } from "./race-pipeline";
import {
  audit,
  confirmBet,
  purchaseStats,
  recommendationStats,
  saveResult,
  settle,
  skipRace,
  voidBet,
} from "./betting";
import { adoptModel, analytics, backtest, saveReview } from "./analytics";
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
  if (!token || token.length < 24) return false;
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
  const limit = 262144;
  const reader = request.body?.getReader();
  requireCondition(reader, "本文が必要です", 400);
  let length = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new DomainError("入力は256KiB以内です", 413);
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
): Promise<unknown> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;
  const input = method === "POST" ? await readBody(request) : null;
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
  if (method === "GET" && /^\/races\/[^/]+$/.test(path))
    return detail(repo, decodeURIComponent(path.split("/")[2]));
  if (method === "GET" && path === "/stats")
    return {
      purchases: await purchaseStats(repo),
      predictions: await analytics(repo),
      recommendations: await recommendationStats(repo),
      adopted_reference: await recommendationStats(repo, true),
    };
  if (method === "GET" && path === "/backup") return backup(repo);
  if (method === "GET" && path === "/integrity") return integrityReport(repo);
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
  if (path === "/bets") return confirmBet(repo, input, now);
  if (path === "/skip") return skipRace(repo, input, now);
  if (path === "/results") return saveResult(repo, input, now);
  if (path === "/reviews") return saveReview(repo, input, now);
  if (path === "/backtests") return backtest(repo, input);
  if (path === "/models/adopt") return adoptModel(repo, input, now);
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
  async fetch(request: Request): Promise<Response> {
    const task = this.queue.then(async () => {
      if (!(await authenticated(request, this.env.API_TOKEN)))
        return response({ error: "本人用認証が必要です" }, 401);
      try {
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
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!(await authenticated(request, env.API_TOKEN)))
      return response({ error: "本人用認証が必要です" }, 401);
    return env.COORDINATOR.get(env.COORDINATOR.idFromName("owner")).fetch(
      request,
    );
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
