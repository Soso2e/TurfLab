import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { obj, rows, str, type Row } from "../packages/shared/src/domain";
import { bridgeSchema, raceKey } from "../packages/shared/src/github-bridge";

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
interface State {
  version: 1;
  repository: string;
  branch: string;
  files: Record<string, Receipt>;
  exports: Record<string, string>;
  last_export?: Row;
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.state = {
        version: 1,
        repository: this.config.repository,
        branch: this.config.branch,
        files: {},
        exports: {},
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
      last_export: this.state.last_export ?? null,
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
      reason: "固定パックをGitHubへ出力しました",
      at: this.io.now().toISOString(),
    };
    await this.save();
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
