import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BridgeError,
  githubIO,
  PredictionBridge,
  type BridgeConfig,
} from "./github-bridge";
import { obj, rows, str, type Row } from "../packages/shared/src/domain";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--data-home"))
  throw new Error("--data-homeが必要です");
const home = path.resolve(arg("--data-home"));
const bridgeHome = path.join(home, "github-bridge");
const config: BridgeConfig = JSON.parse(
  await readFile(path.join(bridgeHome, "config.json"), "utf8"),
);
if (
  config.interval_seconds !== undefined &&
  (!Number.isInteger(config.interval_seconds) ||
    config.interval_seconds < 60 ||
    config.interval_seconds > 3600)
)
  throw new Error("interval_secondsは60〜3600です");
const vars = await readFile(path.join(home, ".dev.vars"), "utf8");
const token = vars.match(/^API_TOKEN="([A-Za-z0-9_-]{24,})"\r?$/m)?.[1];
if (!token) throw new Error("DataHomeのAPI認証設定を確認してください");
const origin = process.env.TURFLAB_BRIDGE_API_ORIGIN ?? "http://127.0.0.1:8787";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("APIはloopback専用です");
async function api(route: string, body?: unknown): Promise<Row> {
  try {
    const r = await fetch(origin + "/api" + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const result = obj(await r.json());
    if (!r.ok) {
      // Server already sanitizes DomainError messages; do not echo response payloads.
      const message = String(result.error ?? "API検証エラー")
        .replace(
          /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)/g,
          "[redacted]",
        )
        .replaceAll(token!, "[redacted]")
        .slice(0, 400);
      throw new BridgeError(message, r.status >= 500 || r.status === 429);
    }
    return result;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError("ローカルAPIへ接続できません", true);
  }
}
await mkdir(bridgeHome, { recursive: true });
const lockPath = path.join(bridgeHome, "worker.lock");
try {
  const old = Number(await readFile(lockPath, "utf8"));
  if (!Number.isInteger(old) || old <= 0)
    throw new Error("Worker lockを確認してください");
  try {
    process.kill(old, 0);
    throw new Error("同期Workerは既に稼働しています");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  await unlink(lockPath);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const lock = await open(lockPath, "wx");
await lock.writeFile(String(process.pid));
await lock.close();
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
try {
  const gh = githubIO(config);
  const bridge = new PredictionBridge(bridgeHome, config, {
    ...gh,
    api,
    now: () => new Date(),
    list: async () => {
      await gh.verify();
      return gh.list();
    },
  });
  await bridge.init();
  do {
    const ack: string[] = [];
    let commandError: string | null = null;
    try {
      const control = await api("/github-bridge/control");
      for (const c of rows(control.commands)) {
        try {
          if (c.kind === "export") {
            await gh.verify();
            await bridge.exportPack(str(c, "snapshot_id"));
          } else await bridge.sync(true);
          ack.push(str(c, "id"));
        } catch (e) {
          commandError =
            e instanceof BridgeError
              ? e.message
              : "パック出力に失敗しました。設定を確認して再要求してください";
          if (c.kind === "export")
            await bridge.exportFailure(str(c, "snapshot_id"), commandError);
          ack.push(str(c, "id"));
        }
      }
      await bridge.sync();
      await api("/github-bridge/report", {
        status: {
          ...bridge.status(),
          ...(commandError ? { last_error: commandError } : {}),
        },
        ack,
      });
    } catch {
      /* API down: local receipts survive, next heartbeat retries. No secrets logged. */
    }
    if (process.argv.includes("--once")) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (!stopping);
} finally {
  await unlink(lockPath);
}
