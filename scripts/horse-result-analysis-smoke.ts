import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { type Row } from "../packages/shared/src/domain";
import { wizardDraft } from "../tests/wizard-fixture";

const port = 8792;
const origin = `http://127.0.0.1:${port}`;
const root = process.cwd();
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "turflab-hra-"));
const token = crypto.randomUUID() + crypto.randomUUID();
const configPath = path.join(home, "wrangler.json");
const config = {
  name: "turflab-hra-e2e",
  main: path.join(root, "workers/api/src/index.ts"),
  compatibility_date: "2026-10-01",
  assets: {
    directory: path.join(root, "dist"),
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api", "/api/*"],
  },
  durable_objects: {
    bindings: [{ name: "COORDINATOR", class_name: "TurfCoordinator" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["TurfCoordinator"] }],
  vars: {
    STORAGE_MODE: "local",
    AUTOMATION_ENABLED: "false",
    API_TOKEN: token,
  },
};
await writeFile(configPath, JSON.stringify(config));
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
});

let child: ChildProcess | undefined;
let browser: Browser | undefined;
let logs = "";

async function start() {
  child = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      configPath,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      path.join(home, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_SANITIZE: "true",
        CI: "true",
      },
    },
  );
  child.stdout?.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr?.on("data", (d) => {
    logs += d.toString();
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(`隔離Wrangler終了: ${logs.replaceAll(token, "[redacted]").slice(-1500)}`);
    }
    try {
      const r = await fetch(`${origin}/api/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) return;
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("隔離Wrangler起動タイムアウト");
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  await exited;
  child = undefined;
}

async function api(route: string, body?: unknown, expected = 200) {
  const response = await fetch(`${origin}/api${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as Row;
  if (response.status !== expected) {
    throw new Error(`${route}: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

try {
  await start();
  const startMs = Date.now() + 4000;
  const draftBaseIso = new Date(startMs - 240 * 60_000).toISOString();
  const draft = wizardDraft(draftBaseIso);
  // scheduled_start_at が約4秒後になるため、発走前確定 → 発走待機 → 結果・分析登録の順で実行する

  const operationId = `hra-e2e-${Date.now()}`;
  const preview = await api("/race-import/preview", { operation_id: operationId, draft });
  if (!preview.preview_hash) {
    throw new Error(`preview failed: ${JSON.stringify(preview)}`);
  }
  const confirmed = await api("/race-import/confirm", {
    operation_id: operationId,
    draft,
    confirmed: true,
    preview_hash: preview.preview_hash,
  });
  const raceId = String(
    confirmed.race_id ?? (confirmed.race as Row | undefined)?.race_id ?? (preview.race as Row).race_id,
  );
  const detailBefore = await api(`/races/${encodeURIComponent(raceId)}`);
  const entries = (detailBefore.entries as Row[]) ?? [];
  const e1 = entries.find((e) => e.horse_number === 1)!;
  const e2 = entries.find((e) => e.horse_number === 2)!;

  // 発走時刻経過まで待機
  const waitMs = Math.max(0, startMs - Date.now() + 500);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const analysisAt = new Date().toISOString();

  await api("/results", {
    result: {
      result_id: "hra-result-1",
      race_id: raceId,
      revision: 1,
      official_status: "official",
      published_at: analysisAt,
      retrieved_at: analysisAt,
      valid_as_of: analysisAt,
      available_at: analysisAt,
      source: "TEST_FIXTURE_NOT_REAL_DATA",
      source_url: "https://www.jra.go.jp/",
      finish_order_json: [[1], [2]],
      entry_status_json: { "1": "finished", "2": "finished", "3": "scratched" },
      supersedes_result_id: null,
    },
    payouts_complete: true,
    payouts: [
      {
        payout_id: "hra-payout-1",
        result_id: "hra-result-1",
        ticket_type: "win",
        selections_json: [1],
        payout_per_100_yen: 340,
        refund_rule_json: null,
      },
    ],
  });
  const resultId = "hra-result-1";

  await api("/horse-result-analysis", {
    race_id: raceId,
    entry_id: String(e1.entry_id),
    result_id: resultId,
    horse_id: String(e1.horse_id),
    actual_finish_position: 1,
    actual_time_s: 91.8,
    actual_last_3f_s: 33.2,
    outcome_categories: ["expected"],
    learning_flag: "normal",
    analysis_summary: "E2Eテスト: 想定範囲内の差し切り勝ち。",
    analyst: "playwright-e2e",
    evidence_sources_json: ["https://www.jra.go.jp/"],
    analysis_at: analysisAt,
  });

  await api("/horse-result-analysis", {
    race_id: raceId,
    entry_id: String(e2.entry_id),
    result_id: resultId,
    horse_id: String(e2.horse_id),
    actual_finish_position: 2,
    actual_time_s: 92.1,
    actual_last_3f_s: 33.9,
    outcome_categories: ["irregular"],
    irregular_factors: ["start_delay"],
    irregular_certainty: "speculative",
    learning_flag: "irregular_one_time",
    analysis_summary: "E2Eテスト: 発馬で後手を踏んだ可能性（推測）。",
    analyst: "playwright-e2e",
    evidence_sources_json: [],
    analysis_at: analysisAt,
  });

  const edge = [
    process.env.SMOKE_BROWSER_PATH,
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"]!, "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
  ].find((p) => p && existsSync(p));

  const errors: string[] = [];
  browser = await chromium.launch({ headless: true, ...(edge ? { executablePath: edge } : {}) });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(origin);
  await page.getByLabel("本人用接続キー").fill(token);
  await page.getByRole("button", { name: "接続する" }).click();
  await page.getByRole("heading", { name: "本日のレース" }).waitFor();

  await page.getByText("架空ウィザード1R").first().click();
  await page.locator("#rt-result").click();

  const panel = page.locator(".hra-panel");
  await panel.waitFor({ state: "visible" });
  const cards = panel.locator(".hra-card");
  if ((await cards.count()) !== 2) {
    throw new Error(`期待した分析カード数2に対し ${await cards.count()} 件`);
  }

  // 2枚目のカード（推測バッジ付き）をクリックして展開
  await cards.nth(1).locator("summary").click();
  await panel.getByText("E2Eテスト: 発馬で後手を踏んだ可能性（推測）。").waitFor({ state: "visible" });
  await panel.getByText("一時的イレギュラー").waitFor({ state: "visible" });

  await page.screenshot({ path: path.join(output, "hra-smoke-mobile.png"), fullPage: true });
  if (errors.length) {
    throw new Error(`ブラウザエラー検出: ${errors.join("; ")}`);
  }
  console.log(JSON.stringify({ status: "ok", race_id: raceId, cards: 2, screenshot: "test-results/hra-smoke-mobile.png" }));
} finally {
  await browser?.close();
  await stop();
}
