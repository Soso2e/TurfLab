// Real private GitHub transport, synthetic data ONLY on a dedicated acceptance branch/DataHome.
import {
  spawn,
  spawnSync,
  execFile,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "@playwright/test";
import { githubIO } from "./github-bridge";
import { obj, rows, str } from "../packages/shared/src/domain";
import { raceKey } from "../packages/shared/src/github-bridge";
import { wizardAnswer, wizardDraft } from "../tests/wizard-fixture";

if (process.env.TURFLAB_BRIDGE_REMOTE_ACK !== "private-acceptance-branch-only")
  throw new Error(
    "実GitHub試験にはTURFLAB_BRIDGE_REMOTE_ACK=private-acceptance-branch-onlyが必要です",
  );
const run = promisify(execFile);
async function runWindowsScript(file: string, home: string, env = process.env) {
  await new Promise<void>((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
        "-DataHome",
        home,
      ],
      { windowsHide: true, stdio: "ignore", env },
    );
    ps.once("error", reject);
    ps.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Windows同期Workerスクリプト失敗")),
    );
  });
}
const root = process.cwd();
const home = await mkdtemp(path.join(tmpdir(), "turflab-github-acceptance-"));
const out = path.join(root, "test-results");
await mkdir(out, { recursive: true });
const token = crypto.randomUUID() + crypto.randomUUID();
const port = 8792,
  origin = `http://127.0.0.1:${port}`;
const branch = `bridge-acceptance-${Date.now()}`;
const repository = "Soso2e/TurfLab-data";
const gh = githubIO({ repository, branch });
await gh.verify();
const head = JSON.parse(
  (
    await run("gh", ["api", `repos/${repository}/git/ref/heads/main`], {
      windowsHide: true,
    })
  ).stdout,
).object.sha;
await run(
  "gh",
  [
    "api",
    `repos/${repository}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${head}`,
  ],
  { windowsHide: true },
);
const bridgeHome = path.join(home, "github-bridge");
await mkdir(bridgeHome, { recursive: true });
await writeFile(
  path.join(bridgeHome, "config.json"),
  JSON.stringify({ repository, branch }),
);
await writeFile(path.join(home, ".dev.vars"), `API_TOKEN="${token}"\n`);
const configPath = path.join(home, "wrangler.json");
await writeFile(
  configPath,
  JSON.stringify({
    name: "turflab-bridge-test",
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
  }),
);
let child: ChildProcess | undefined, browser: Browser | undefined;
let logs = "";
async function api(p: string, b?: unknown) {
  const r = await fetch(origin + "/api" + p, {
    method: b ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!r.ok) throw new Error(`隔離API ${p}: HTTP ${r.status}`);
  return obj(await r.json());
}
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
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        X_LOCAL_EXPLORER: "false",
        X_LOCAL_OBSERVABILITY: "false",
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
    try {
      await api("/status");
      return;
    } catch {
      /* readiness */
    }
    if (child.exitCode !== null) throw new Error("隔離API終了");
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("隔離API起動タイムアウト");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise<void>((r) => child!.once("exit", () => r()));
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
  await done;
  child = undefined;
}
async function once(invalidAuth = false) {
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(root, "scripts/github-sync.ts"),
      "--data-home",
      home,
      "--once",
    ],
    {
      windowsHide: true,
      timeout: 180000,
      env: {
        ...process.env,
        TURFLAB_BRIDGE_API_ORIGIN: origin,
        ...(invalidAuth ? { GH_TOKEN: "invalid-acceptance-token" } : {}),
      },
      maxBuffer: 1024 * 1024,
    },
  );
}
try {
  await start();
  for (const p of ["status", "control"]) {
    if ((await fetch(origin + "/api/github-bridge/" + p)).status !== 401)
      throw new Error("未認証拒否失敗");
  }
  const now = new Date().toISOString(),
    request = {
      operation_id: "isolated-github-master",
      draft: wizardDraft(now),
    };
  const preview = await api("/race-import/preview", request);
  const saved = await api("/race-import/confirm", {
    ...request,
    preview_hash: preview.preview_hash,
    confirmed: true,
  });
  await api("/github-bridge/export", { snapshot_id: saved.snapshot_id });
  await once();
  const files = await gh.list();
  const remotePack = JSON.parse(
    await gh.read(files.find((f) => f.path.startsWith("packs/"))!),
  );
  const pack = obj(remotePack.pack);
  const predictionDocument = {
    ...obj(remotePack.prediction_template),
    answer: wizardAnswer(pack, new Date().toISOString()),
  };
  const predictionPath = String(remotePack.prediction_path);
  await gh.put(predictionPath, JSON.stringify(predictionDocument));
  await api("/github-bridge/sync", {});
  await once();
  if (process.platform === "win32") {
    const launch = path.join(root, "scripts/windows/Start-GitHubSync.ps1");
    const stopWorker = path.join(root, "scripts/windows/Stop-GitHubSync.ps1");
    try {
      await runWindowsScript(launch, home, {
        ...process.env,
        TURFLAB_BRIDGE_API_ORIGIN: origin,
      });
      await api("/github-bridge/sync", {});
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if ((await api("/github-bridge/status")).pending_commands === 0) break;
      }
      if ((await api("/github-bridge/status")).pending_commands !== 0)
        throw new Error("Windows Worker launcher要求処理失敗");
      await runWindowsScript(stopWorker, home);
      // Forced Windows stop leaves a stale lock; the next worker must recover it.
      await api("/github-bridge/sync", {});
      await once();
    } finally {
      await runWindowsScript(stopWorker, home);
    }
  }
  const status = await api("/github-bridge/status");
  if (status.success !== 1)
    throw new Error(
      `同期成功数不一致: ${String(status.last_error)} ${JSON.stringify(status.records)}`,
    );
  const raceId = str(obj(pack.race), "race_id");
  const detail = await api(`/races/${encodeURIComponent(raceId)}`);
  if (
    rows(detail.predictions).length !== 1 ||
    rows(detail.predictions)[0].status !== "locked" ||
    rows(detail.bets).length
  )
    throw new Error("Core保存/Bet分離失敗");
  const before = await api("/backup");
  await stop();
  await start();
  await api("/github-bridge/sync", {});
  await once();
  if ((await api("/backup")).hash !== before.hash)
    throw new Error("再起動/重複受信で過去データ変更");
  // A live GitHub authentication failure must surface without changing saved predictions.
  await api("/github-bridge/sync", {});
  await once(true);
  if (!(await api("/github-bridge/status")).last_error)
    throw new Error("認証失敗が表示されません");
  await api("/github-bridge/sync", {});
  await once();
  const edge = [
    process.env.SMOKE_BROWSER_PATH,
    path.join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Microsoft/Edge/Application/msedge.exe",
    ),
    path.join(
      process.env.ProgramFiles ?? "",
      "Microsoft/Edge/Application/msedge.exe",
    ),
  ].find((p) => p && existsSync(p));
  browser = await chromium.launch({
    headless: true,
    ...(edge ? { executablePath: edge } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("本人用接続キー").fill(token);
  await page.getByRole("button", { name: "接続する" }).click();
  await page.getByRole("heading", { name: "ChatGPT同期状態" }).waitFor();
  await page.getByText("GitHub同期Worker稼働中", { exact: true }).waitFor();
  await page.getByRole("button", { name: "今すぐ同期", exact: true }).click();
  await page
    .getByText("同期を要求しました。Workerの処理結果をお待ちください", {
      exact: true,
    })
    .waitFor();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("同期画面390px横はみ出し");
  await page.screenshot({
    path: path.join(out, "github-bridge-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: /架空ウィザード1R/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "当日の採用版として固定", exact: true })
    .waitFor();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("予想詳細390px横はみ出し");
  await page.screenshot({
    path: path.join(out, "github-bridge-detail-mobile.png"),
    fullPage: true,
  });
  if (errors.length) throw new Error("ブラウザJSエラー");
  const stateText = await readFile(path.join(bridgeHome, "state.json"), "utf8");
  if (stateText.includes(token) || /gho_|github_pat_/.test(stateText + logs))
    throw new Error("秘密情報検出");
  await writeFile(
    path.join(out, "github-bridge-report.json"),
    JSON.stringify(
      {
        fixture_only: true,
        private_repository: repository,
        acceptance_branch: branch,
        data_home: home,
        real_github_roundtrip: true,
        core_readback: true,
        restart_hash_match: true,
        no_automatic_bet: true,
        auth_failure_recovery: true,
        mobile_width: 390,
        js_errors: errors.length,
        real_race: "unverified",
        iphone: "unverified",
        scheduled_chatgpt_write: "unverified",
        prediction_key: raceKey(raceId),
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    "PASS: private GitHub → isolated Windows Worker → Core/readback, restart, auth recovery, 390px.\n",
  );
} finally {
  await browser?.close();
  await stop();
}
