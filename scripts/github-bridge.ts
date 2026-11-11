import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonical,
  obj,
  rows,
  str,
  type Row,
} from "../packages/shared/src/domain";
import {
  bridgeSchema,
  parseReferencePath,
  parseReviewPath,
  raceKey,
} from "../packages/shared/src/github-bridge";

import { referenceAnswer } from "../packages/shared/src/reference-answer";

const exec = promisify(execFile);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const jst = (d: Date) =>
  new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export interface BridgeConfig {
  repository: string;
  branch: string;
  interval_seconds?: number;
}
export interface FileRef {
  path: string;
  sha: string;
}
export interface BridgeIO {
  api: (route: string, body?: unknown) => Promise<Row>;
  list: () => Promise<FileRef[]>;
  read: (file: FileRef) => Promise<string>;
  put: (name: string, content: string) => Promise<void>;
  now: () => Date;
}
interface Receipt {
  sha: string;
  conflict_sha?: string;
  content_hash?: string;
  race_id?: string;
  received_at: string;
  status: "success" | "failed" | "waiting";
  reason: string;
  pipeline?: Row;
  prediction_id?: string;
}
interface ReferenceReceipt {
  sha: string;
  checked_at: string;
  status: "waiting" | "complete" | "failed";
  reason: string;
  races: Row[];
  conflict_sha?: string;
  intake_mode?: "name_only";
  producer?: unknown;
}
interface ResultReceipt {
  sha: string;
  status: "complete" | "waiting" | "failed";
  checked_at: string;
  reason: string;
  result_id?: string;
  conflict_sha?: string;
}
interface State {
  version: 1;
  repository: string;
  branch: string;
  files: Record<string, Receipt>;
  exports: Record<string, string>;
  daily_exports?: Record<string, string>;
  daily_export_hashes?: Record<string, string>;
  daily_export_versions?: Record<string, number>;
  daily_export_next_attempt?: string;
  last_daily_export?: Row;
  daily_inventory?: Row;
  last_export?: Row;
  reference_files?: Record<string, ReferenceReceipt>;
  last_reference_sync?: string;
  last_reference?: Row;
  official_results?: Record<string, ResultReceipt>;
  last_result_sync?: string;
  last_result?: Row;
  chat_reviews?: Record<string, { sha: string; checked_at: string }>;
  last_review_sync?: string;
  last_sync: string | null;
  last_error: string | null;
  failures: number;
  next_attempt: string | null;
}
export class BridgeError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
const filePattern =
  /^predictions\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+-(morning|final|reanalysis)-v[1-9]\d*\.json$/;

export class PredictionBridge {
  private state!: State;
  private busy = false;
  constructor(
    private home: string,
    private config: BridgeConfig,
    private io: BridgeIO,
  ) {}
  /** The local CLI worker reuses this bridge over a local folder, not GitHub. */
  private get local() {
    return this.config.repository.startsWith("local/");
  }
  private get destination() {
    return this.local ? "ローカル交換フォルダ" : "GitHub";
  }
  async init() {
    await mkdir(path.join(this.home, "inbox"), { recursive: true });
    try {
      this.state = JSON.parse(
        await readFile(path.join(this.home, "state.json"), "utf8"),
      );
      if (
        this.state.version !== 1 ||
        this.state.repository !== this.config.repository ||
        this.state.branch !== this.config.branch ||
        !this.state.files ||
        !this.state.exports
      )
        throw new BridgeError(
          "同期状態とリポジトリ設定が不一致です。状態ファイルを保全して確認してください",
        );
      this.state.daily_exports ??= {};
      this.state.daily_export_hashes ??= {};
      this.state.daily_export_versions ??= {};
      this.state.reference_files ??= {};
      this.state.official_results ??= {};
      this.state.chat_reviews ??= {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.state = {
        version: 1,
        repository: this.config.repository,
        branch: this.config.branch,
        files: {},
        exports: {},
        daily_exports: {},
        daily_export_hashes: {},
        daily_export_versions: {},
        reference_files: {},
        official_results: {},
        chat_reviews: {},
        last_sync: null,
        last_error: null,
        failures: 0,
        next_attempt: null,
      };
      await this.save();
    }
  }
  private async save() {
    const target = path.join(this.home, "state.json");
    await writeFile(target + ".tmp", JSON.stringify(this.state, null, 2));
    await rename(target + ".tmp", target);
  }
  status(): Row {
    const all = Object.entries(this.state.files).map(([name, r]) => ({
      path: name,
      sha: r.sha,
      race_id: r.race_id ?? null,
      received_at: r.received_at,
      status: r.conflict_sha ? "failed" : r.status,
      reason: r.reason,
      prediction_id: r.prediction_id ?? null,
    }));
    const today = all.filter(
      (r) => jst(new Date(r.received_at)) === jst(this.io.now()),
    );
    return {
      configured: true,
      transport: this.local ? "local" : "github",
      last_export: this.state.last_export ?? null,
      last_daily_export: this.state.last_daily_export ?? null,
      last_reference: this.state.last_reference ?? null,
      last_result: this.state.last_result ?? null,
      results_waiting: Object.values(this.state.official_results ?? {}).filter(
        (r) => r.status === "waiting",
      ).length,
      results_complete: Object.values(this.state.official_results ?? {}).filter(
        (r) => r.status === "complete",
      ).length,
      reference_records: Object.entries(this.state.reference_files ?? {})
        .map(([path, r]) => ({
          path,
          status: r.conflict_sha ? "failed" : r.status,
          reason: r.reason,
          checked_at: r.checked_at,
          races: r.races,
        }))
        .slice(-12),
      daily_inventory: this.state.daily_inventory ?? null,
      repository: this.config.repository,
      last_sync: this.state.last_sync,
      last_error: this.state.last_error,
      next_attempt: this.state.next_attempt,
      today_races: new Set(today.map((r) => r.race_id).filter(Boolean)).size,
      success: all.filter((r) => r.status === "success").length,
      failed: all.filter((r) => r.status === "failed").length,
      waiting: all.filter((r) => r.status === "waiting").length,
      last_prediction:
        all.sort((a, b) => b.received_at.localeCompare(a.received_at))[0] ??
        null,
      records: all
        .sort((a, b) => b.received_at.localeCompare(a.received_at))
        .slice(0, 100),
      worker_seen_at: this.io.now().toISOString(),
    };
  }
  // Reconcile against the highest immutable state version in GitHub.
  // A result/settlement committed after 08:00 JST must not disappear from the
  // next scheduled ChatGPT run just because the v1 snapshot already existed.
  async exportDailyStateIfDue() {
    const current = this.io.now();
    const day = jst(current);
    if (new Date(current.getTime() + 9 * 3600000).getUTCHours() < 8) return;
    this.state.daily_exports ??= {};
    this.state.daily_export_hashes ??= {};
    this.state.daily_export_versions ??= {};
    if (
      this.state.daily_export_next_attempt &&
      Date.parse(this.state.daily_export_next_attempt) > current.getTime()
    )
      return;
    try {
      const files = await this.io.list(); // Caller re-verifies private repo on every list.
      const prefix = `state/${day}/daily-v`;
      const remote = files
        .flatMap((f) => {
          if (!f.path.startsWith(prefix)) return [];
          const match =
            /^state\/\d{4}-\d{2}-\d{2}\/daily-v([1-9]\d*)\.json$/.exec(f.path);
          return match ? [{ file: f, version: Number(match[1]) }] : [];
        })
        .sort((a, b) => b.version - a.version)[0];
      const localVersion = this.state.daily_export_versions[day] ?? 0;
      if (
        remote &&
        (remote.version > localVersion || !this.state.daily_export_hashes[day])
      ) {
        const content = await this.io.read(remote.file);
        if (Buffer.byteLength(content) > 262144)
          throw new BridgeError("既存GitHub日次状態が256KiB超過です");
        const saved = obj(JSON.parse(content));
        if (
          saved.report_type !== "turfLab_daily_state" ||
          saved.report_date_jst !== day
        )
          throw new BridgeError("既存日次状態の形式/日付が不正です");
        this.state.daily_exports[day] = remote.file.path;
        this.state.daily_export_hashes[day] = digest(
          canonical({
            ...saved,
            generated_at: null,
          }),
        );
        this.state.daily_export_versions[day] = remote.version;
        await this.save();
      }
      if (remote && remote.version < localVersion)
        throw new BridgeError(
          "ローカル日次版よりGitHubが古いです。状態を確認してください",
        );
      const snapshot = await this.io.api("/daily-state");
      if (
        snapshot.report_type !== "turfLab_daily_state" ||
        snapshot.report_date_jst !== day
      )
        throw new BridgeError("日次状態の日付/形式が一致しません");
      const hashValue = digest(canonical({ ...snapshot, generated_at: null }));
      if (hashValue === this.state.daily_export_hashes[day]) {
        this.state.daily_export_next_attempt = new Date(
          current.getTime() + 15 * 60000,
        ).toISOString();
        await this.save();
        return;
      }
      const version = (this.state.daily_export_versions[day] ?? 0) + 1;
      if (version > 24)
        throw new BridgeError(
          "日次状態の版数が24を超えました。保存先とデータ変化を確認してください",
        );
      const content = JSON.stringify(snapshot, null, 2);
      if (Buffer.byteLength(content) > 262144)
        throw new BridgeError(
          "日次状態が256KiBを超えています。安全のため出力しません",
        );
      const filename = `state/${day}/daily-v${version}.json`;
      await this.io.put(filename, content);
      this.state.daily_exports[day] = filename;
      this.state.daily_export_hashes[day] = hashValue;
      this.state.daily_export_versions[day] = version;
      this.state.daily_export_next_attempt = new Date(
        current.getTime() + 15 * 60000,
      ).toISOString();
      this.state.last_daily_export = {
        path: filename,
        at: current.toISOString(),
        version,
        status: "success",
        reason:
          `変更されたCore日次状態を${this.destination}に追加保存しました（旧版は保持）`,
      };
    } catch (e) {
      this.state.daily_export_next_attempt = new Date(
        current.getTime() + 30 * 60000,
      ).toISOString();
      this.state.last_daily_export = {
        at: current.toISOString(),
        status: "failed",
        reason:
          e instanceof BridgeError ? e.message : "日次状態出力に失敗しました",
      };
      await this.save();
      throw e;
    }
    await this.save();
  }
  // Register name-only catalogs; strict/official reconciliation stays available separately.
  async syncReferences(force = false) {
    const now = this.io.now();
    if (
      !force &&
      this.state.last_reference_sync &&
      now.getTime() - Date.parse(this.state.last_reference_sync) <
        (this.config.interval_seconds ?? 300) * 1000
    )
      return;
    const files = await this.io.list();
    this.state.reference_files ??= {};
    for (const file of files
      .filter((f) => parseReferencePath(f.path))
      .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }))) {
      const prior = this.state.reference_files[file.path];
      if (prior && prior.sha !== file.sha) {
        prior.conflict_sha = file.sha;
        prior.reason =
          "参考分析の同名ファイルが変更されました。別名の版管理が必要です";
        await this.save();
        continue;
      }
      if (
        prior?.intake_mode === "name_only" &&
        (prior.status === "complete" || prior.status === "failed")
      )
        continue;
      const report: ReferenceReceipt = prior ?? {
        sha: file.sha,
        checked_at: now.toISOString(),
        status: "waiting",
        reason: "DB照合待ち",
        races: [],
      };
      try {
        const content = await this.io.read(file);
        if (Buffer.byteLength(content) > 262144)
          throw new BridgeError("参考JSONは256KiB以内です");
        const document = obj(JSON.parse(content));
        const response = await this.io.api(
          "/github-bridge/reference-register",
          {
            path: file.path,
            sha: file.sha,
            repository: this.config.repository,
            document,
          },
        );
        report.intake_mode = "name_only";
        report.producer = response.provenance
          ? obj(response.provenance).source_producer
          : undefined;
        // The catalog is the immutable first receipt for this blob SHA. A retry
        // after the race has started yields a different receipt; keep the first.
        const catalog = `catalog/${file.path.split("/")[1]}/name-only-${file.sha}.json`;
        if (!files.some((f) => f.path === catalog))
          await this.io.put(catalog, JSON.stringify(response, null, 2));
        // UI can display all reference races even when Core has zero matches.
        // This mirror never creates Core predictions or owner bets.
        if (file.path.split("/")[1] === jst(now))
          await this.io.api("/github-bridge/reference-report", {
            path: file.path,
            sha: file.sha,
            document,
          });
        report.races = rows(response.races);
        // Freeze/export first. Only a complete supplied answer can enter the existing Core.
        for (const race of report.races.filter(
          (r) => r.status === "pack_ready",
        )) {
          if (race.formal_prediction_id) {
            // Another (earlier) prediction is already official for this race.
            race.answer_status = "formal_exists";
            continue;
          }
          try {
            const output = await this.exportPack(str(race, "snapshot_id"));
            const source = rows(document.races).find(
              (r) => r.race_key_human === (race.source_race_key_human ?? race.race_key_human),
            );
            const answer =
              source &&
              referenceAnswer(
                source,
                obj(output.pack),
                str(document, "generated_at"),
              );
            race.answer_status = answer ? "validating" : "reference_only";
            if (answer) {
              try {
                const formal = {
                  ...obj(output.prediction_template),
                  answer: {
                    ...answer,
                    pack_hash: answer.pack_hash ?? obj(output.pack).pack_hash,
                  },
                };
                // Incomplete answers and stale hashes never become formal predictions.
                await this.io.api("/github-bridge/convert", {
                  path: output.prediction_path,
                  document: formal,
                });
                await this.io.put(
                  str(output, "prediction_path"),
                  JSON.stringify(formal, null, 2),
                );
                race.answer_status = "submitted";
              } catch (e) {
                race.answer_status = "waiting";
                race.issues = [
                  ...(Array.isArray(race.issues) ? race.issues : []),
                  e instanceof Error ? e.message : "完全な正式answer待ち",
                ];
              }
            }
          } catch {
            race.status = "needs_snapshot";
            race.issues = [`固定packの${this.destination}出力に失敗。次回再試行します`];
          }
        }
        report.status = report.races.every(
          (r) =>
            (r.status === "pack_ready" && r.answer_status !== "waiting") ||
            r.status === "past_start" ||
            r.status === "catalog_only",
        )
          ? "complete"
          : "waiting";
        report.reason = `名前登録${report.races.length}R（公式未照合）、pack出力可能${report.races.filter((r) => r.status === "pack_ready").length}R、未登録・確認待ち${report.races.filter((r) => r.status !== "pack_ready" && r.status !== "past_start").length}R`;
      } catch (e) {
        report.reason =
          e instanceof Error ? e.message.slice(0, 300) : "参考JSONの解析に失敗";
        report.status = e instanceof SyntaxError ? "failed" : "waiting";
      }
      report.checked_at = now.toISOString();
      this.state.reference_files[file.path] = report;
      this.state.last_reference = {
        path: file.path,
        status: report.status,
        reason: report.reason,
        checked_at: report.checked_at,
        races: report.races,
      };
      await this.save();
    }
    this.state.last_reference_sync = now.toISOString();
    await this.save();
  }
  // Chat reviews from conversations are reference-only post-race documents.
  // They are never imported into Core formal predictions or model weights.
  async syncChatReviews(force = false) {
    const now = this.io.now();
    if (
      !force &&
      this.state.last_review_sync &&
      now.getTime() - Date.parse(this.state.last_review_sync) <
        (this.config.interval_seconds ?? 300) * 1000
    )
      return;
    const files = await this.io.list();
    this.state.chat_reviews ??= {};
    const reviewFiles = files.filter((f) => parseReviewPath(f.path));
    for (const file of reviewFiles) {
      const prior = this.state.chat_reviews[file.path];
      if (prior && prior.sha === file.sha) continue;
      try {
        const text = await this.io.read(file);
        const document = JSON.parse(text);
        await this.io.api("/github-bridge/reviews", {
          path: file.path,
          sha: file.sha,
          date_jst: file.path.split("/")[1],
          document,
        });
        this.state.chat_reviews[file.path] = {
          sha: file.sha,
          checked_at: now.toISOString(),
        };
      } catch {
        // Chat review failure must not block prediction flow.
      }
    }
    this.state.last_review_sync = now.toISOString();
    await this.save();
  }
  // Official results are separate immutable files. They never trigger a new
  // Morning or a real bet; Core settles only already-confirmed virtual bets.
  async syncOfficialResults(force = false) {
    const now = this.io.now();
    if (
      !force &&
      this.state.last_result_sync &&
      now.getTime() - Date.parse(this.state.last_result_sync) <
        (this.config.interval_seconds ?? 300) * 1000
    )
      return;
    this.state.official_results ??= {};
    const files = await this.io.list();
    const pattern =
      /^results\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+-official-v[1-9]\d*\.json$/;
    const candidates = files
      .filter((f) => pattern.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    let processed = 0;
    for (const file of candidates) {
      let record = this.state.official_results[file.path];
      if (record?.sha && record.sha !== file.sha) {
        record.conflict_sha = file.sha;
        record.reason = "同じ結果JSONの上書きを拒否。訂正は別版へ";
        record.status = "failed";
        await this.save();
        continue;
      }
      if (record?.status === "complete" || record?.status === "failed")
        continue;
      if (++processed > 40) break;
      record ??= {
        sha: file.sha,
        status: "waiting",
        checked_at: now.toISOString(),
        reason: "Core検証待ち",
      };
      try {
        const content = await this.io.read(file);
        if (Buffer.byteLength(content) > 262144)
          throw new BridgeError("公式結果JSONは256KiB以内です");
        const document = obj(JSON.parse(content));
        const result = await this.io.api("/github-bridge/official-result", {
          path: file.path,
          document,
        });
        const detail = await this.io.api(
          `/races/${encodeURIComponent(str(result, "race_id"))}`,
        );
        if (!rows(detail.results).some((r) => r.result_id === result.result_id))
          throw new BridgeError("公式結果のCore読返し不一致", true);
        record.status = "complete";
        record.reason = "最新公式結果をCoreに保存し、既存の本人仮想Betを精算";
        record.result_id = str(result, "result_id");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "公式結果検証に失敗";
        record.status =
          /参照がありません|未登録|一時|接続できません|not found/i.test(msg)
            ? "waiting"
            : "failed";
        record.reason = msg.slice(0, 300);
      }
      record.checked_at = now.toISOString();
      this.state.official_results[file.path] = record;
      this.state.last_result = {
        path: file.path,
        status: record.status,
        reason: record.reason,
        checked_at: record.checked_at,
        result_id: record.result_id ?? null,
      };
      await this.save();
    }
    this.state.last_result_sync = now.toISOString();
    await this.save();
  }
  async exportPack(snapshot: string) {
    const pack = await this.io.api("/race-import/pack", {
      snapshot_id: snapshot,
    });
    const race = obj(pack.race);
    const name = `packs/${race.race_date_jst}/${raceKey(str(race, "race_id"))}-${pack.pack_hash}.json`;
    // Schema and wrapper template travel with the verified input, outside pack_hash.
    const output = {
      pack,
      prediction_path: `predictions/${race.race_date_jst}/${raceKey(str(race, "race_id"))}-morning-v1.json`,
      prediction_schema: bridgeSchema,
      prediction_template: {
        bridge_version: "1",
        race_id: race.race_id,
        snapshot_id: pack.snapshot_id,
        input_hash: pack.input_hash,
        model_version_id: pack.model_version_id,
        information_cutoff_at: pack.information_cutoff_at,
        kind: "morning",
        version: 1,
        answer: { pack_hash: pack.pack_hash },
      },
      instruction:
        "answerをpack.answer_schemaどおりに埋め、predictions/日付/レースキー-morning-v1.jsonへ新規保存する。オッズ・人気を評価・予想・買い目の根拠に使用しない。既存ファイルを変更しない。資料不足は確定せず確認待ちとする。",
    };
    await this.io.put(name, JSON.stringify(output, null, 2));
    this.state.exports[name] = str(pack, "pack_hash");
    this.state.last_export = {
      path: name,
      status: "success",
      reason: `固定パックを${this.destination}へ出力しました`,
      at: this.io.now().toISOString(),
    };
    await this.save();
    return output;
  }
  async exportFailure(snapshot: string, reason: string) {
    this.state.last_export = {
      snapshot_id: snapshot,
      status: "failed",
      reason,
      at: this.io.now().toISOString(),
    };
    await this.save();
  }
  async sync(force = false) {
    if (this.busy) return;
    if (
      !force &&
      this.state.next_attempt &&
      Date.parse(this.state.next_attempt) > this.io.now().getTime()
    )
      return;
    this.busy = true;
    try {
      const files = await this.io.list();
      const day = jst(this.io.now());
      this.state.daily_inventory = {
        date_jst: day,
        checked_at: this.io.now().toISOString(),
        packs: files.filter(
          (f) => f.path.startsWith(`packs/${day}/`) && f.path.endsWith(".json"),
        ).length,
        predictions: files.filter(
          (f) =>
            f.path.startsWith(`predictions/${day}/`) &&
            f.path.endsWith(".json"),
        ).length,
        reference: files.some((f) => parseReferencePath(f.path)?.date === day),
      };
      let transportError = false;
      for (const file of files
        .filter(
          (f) => f.path.startsWith("predictions/") && f.path.endsWith(".json"),
        )
        .sort((a, b) => a.path.localeCompare(b.path))) {
        if (!filePattern.test(file.path)) {
          this.state.files[file.path] ??= {
            sha: file.sha,
            received_at: this.io.now().toISOString(),
            status: "failed",
            reason:
              "ファイル名・日付・版の規則が不正です。正しい新規ファイルで再送してください",
          };
          await this.save();
          continue;
        }
        const old = this.state.files[file.path];
        if (old && old.sha !== file.sha) {
          old.conflict_sha = file.sha;
          old.reason =
            "確定/受信済みファイルの変更を拒否しました。新しい版を追加してください";
          // Keep the original immutable receipt and saved Core result.
          this.state.last_error = old.reason;
          await this.save();
          continue;
        }
        if (old?.status === "success") continue;
        if (old?.status === "failed") continue;
        let receipt = old;
        if (!receipt) {
          let text: string;
          try {
            text = await this.io.read(file);
          } catch {
            transportError = true;
            this.state.last_error =
              "一部JSONの取得に失敗しました。バックオフ後に再試行します";
            continue;
          }
          if (Buffer.byteLength(text) > 262144) {
            this.state.files[file.path] = {
              sha: file.sha,
              received_at: this.io.now().toISOString(),
              status: "failed",
              reason: "JSONは256KiB以内です",
            };
            await this.save();
            continue;
          }
          const contentHash = digest(text);
          const cache = path.join(this.home, "inbox", contentHash + ".json");
          await writeFile(cache + ".tmp", text);
          await rename(cache + ".tmp", cache);
          receipt = {
            sha: file.sha,
            content_hash: contentHash,
            received_at: this.io.now().toISOString(),
            status: "waiting",
            reason: "検証待ち",
          };
          this.state.files[file.path] = receipt;
          await this.save();
        }
        try {
          if (!receipt.pipeline) {
            let document: Row;
            try {
              const cached = await readFile(
                path.join(this.home, "inbox", receipt.content_hash + ".json"),
                "utf8",
              );
              if (digest(cached) !== receipt.content_hash)
                throw new Error("cache hash mismatch");
              document = obj(JSON.parse(cached));
            } catch {
              throw new BridgeError(
                "JSONが破損しています。新しい版で再送してください",
              );
            }
            receipt.race_id =
              typeof document.race_id === "string"
                ? document.race_id
                : undefined;
            const day = file.path.split("/")[1];
            const races = new Set(
              Object.entries(this.state.files)
                .filter(
                  ([p, r]) => p.split("/")[1] === day && r.status === "success",
                )
                .map(([, r]) => r.race_id),
            );
            if (!races.has(receipt.race_id) && races.size >= 5)
              throw new BridgeError(
                "日次最大5Rを超えています。対象レースを確認してください",
              );
            const converted = await this.io.api("/github-bridge/convert", {
              path: file.path,
              document,
            });
            receipt.pipeline = obj(converted.pipeline);
            // Persist BEFORE Core call: retry the identical pipeline after a crash/post-start.
            await this.save();
          }
          const result = await this.io.api("/pipeline/race", receipt.pipeline);
          if (result.status !== "complete") {
            const failure = result.error_json ? obj(result.error_json) : {};
            throw new BridgeError(
              String(
                failure.message ??
                  "Core確定が未完了です。同期履歴とCore診断を確認してください",
              ),
              failure.retryable === true,
            );
          }
          const prediction = obj(receipt.pipeline.prediction);
          const detail = await this.io.api(
            `/races/${encodeURIComponent(str(prediction, "race_id"))}`,
          );
          if (
            !rows(detail.predictions).some(
              (p) =>
                p.prediction_id === prediction.prediction_id &&
                p.status === "locked",
            )
          )
            throw new BridgeError("Core保存後の読み返しが一致しません", true);
          receipt.status = "success";
          receipt.reason = "Core確定・読み返し済み。本人Betは別操作です";
          receipt.prediction_id = str(prediction, "prediction_id");
        } catch (e) {
          receipt.status =
            e instanceof BridgeError &&
            !e.retryable &&
            !/見つか|がありません|未登録|不足|発走後|再分析|日次最大|最新snapshot|確認待ち/.test(
              e.message,
            )
              ? "failed"
              : "waiting";
          receipt.reason =
            e instanceof BridgeError
              ? e.message
              : "検証または保存に失敗しました。入力とCore診断を確認してください";
        }
        await this.save();
      }
      if (transportError)
        throw new BridgeError(
          "一部JSONの取得に失敗しました。他レースは処理済みです。接続を確認してください",
          true,
        );
      this.state.last_sync = this.io.now().toISOString();
      this.state.failures = 0;
      // Conflict remains visible until the next clean scan of the original files.
      if (
        !files.some(
          (f) =>
            this.state.files[f.path] && this.state.files[f.path].sha !== f.sha,
        )
      )
        this.state.last_error = null;
      this.state.next_attempt = new Date(
        this.io.now().getTime() + (this.config.interval_seconds ?? 300) * 1000,
      ).toISOString();
    } catch (e) {
      this.state.failures++;
      this.state.last_error =
        e instanceof BridgeError
          ? e.message
          : "GitHub通信/認証に失敗しました。gh auth statusと接続を確認してください";
      this.state.next_attempt = new Date(
        this.io.now().getTime() +
          Math.min(3600000, 300000 * 2 ** Math.min(this.state.failures - 1, 4)),
      ).toISOString();
    } finally {
      await this.save();
      this.busy = false;
    }
  }
}

export function githubIO(config: BridgeConfig) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
    !/^[A-Za-z0-9_./-]+$/.test(config.branch) ||
    config.branch.startsWith("-")
  )
    throw new BridgeError("GitHub設定が不正です");
  async function gh(route: string): Promise<Row> {
    try {
      const { stdout } = await exec(
        "gh",
        ["api", `repos/${config.repository}${route ? "/" + route : ""}`],
        { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      );
      return obj(JSON.parse(stdout));
    } catch {
      throw new BridgeError(
        "GitHub通信/認証に失敗しました。gh auth statusと非公開リポジトリ権限を確認してください",
        true,
      );
    }
  }
  // execFile input uses stdin explicitly; secrets never appear in argv, output or state.
  async function put(name: string, content: string) {
    const branch = await gh(`branches/${encodeURIComponent(config.branch)}`);
    const tree = await gh(
      `git/trees/${str(obj(branch.commit), "sha")}?recursive=1`,
    );
    if (tree.truncated)
      throw new BridgeError(
        "GitHub treeが省略されています。データリポジトリを分割してください",
      );
    const existing = rows(tree.tree).find((f) => f.path === name);
    if (existing) {
      const blob = await gh(`git/blobs/${existing.sha}`);
      if (
        Buffer.from(str(blob, "content"), "base64").toString("utf8") !== content
      )
        throw new BridgeError("既存パックの上書きを拒否しました");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "gh",
        [
          "api",
          `repos/${config.repository}/contents/${name}`,
          "--method",
          "PUT",
          "--input",
          "-",
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
        (error) =>
          error
            ? reject(
                new BridgeError(
                  "GitHubパック保存に失敗しました。権限・競合を確認してください",
                  true,
                ),
              )
            : resolve(),
      );
      child.stdin?.end(
        JSON.stringify({
          message: "固定入力パックを追加",
          branch: config.branch,
          content: Buffer.from(content).toString("base64"),
        }),
      );
    });
  }
  return {
    async verify() {
      const info = await gh("");
      if (info.private !== true)
        throw new BridgeError(
          "データ受渡しには非公開GitHubリポジトリが必要です",
        );
    },
    async list(): Promise<FileRef[]> {
      // Resolve a commit, then traverse and download blobs from that immutable snapshot.
      const branch = await gh(`branches/${encodeURIComponent(config.branch)}`);
      const tree = await gh(
        `git/trees/${str(obj(branch.commit), "sha")}?recursive=1`,
      );
      if (tree.truncated)
        throw new BridgeError(
          "GitHub treeが省略されています。同期を停止します",
        );
      return rows(tree.tree)
        .filter((f) => f.type === "blob")
        .map((f) => ({ path: str(f, "path"), sha: str(f, "sha") }));
    },
    async read(file: FileRef) {
      const blob = await gh(`git/blobs/${file.sha}`);
      if (Number(blob.size) > 262144) return " ".repeat(262145);
      if (blob.encoding !== "base64")
        throw new BridgeError("GitHub blob形式が不正です");
      return Buffer.from(str(blob, "content"), "base64").toString("utf8");
    },
    put,
  };
}
