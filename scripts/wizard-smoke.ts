import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { obj, rows, type Row } from "../packages/shared/src/domain";
import { wizardDraft, wizardAnswer } from "../tests/wizard-fixture";

// Own process, separate port, separate empty DO storage. Never stop 8787.
const port = 8791,
  origin = `http://127.0.0.1:${port}`;
const root = process.cwd(),
  output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "turflab-wizard-"));
const token = crypto.randomUUID() + crypto.randomUUID();
const configPath = path.join(home, "wrangler.json");
const config = {
  name: "turflab-wizard-acceptance",
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
let child: ChildProcess | undefined, browser: Browser | undefined;
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
    if (child.exitCode !== null)
      throw new Error(
        `隔離Wranglerが終了しました: ${logs.replaceAll(token, "[redacted]").slice(-1800)}`,
      );
    try {
      const r = await fetch(origin + "/api/status", {
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
  const exited = new Promise<void>((resolve) =>
    child!.once("exit", () => resolve()),
  );
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
  await exited;
  child = undefined;
}
async function api(route: string, body?: unknown, expected = 200) {
  const response = await fetch(origin + "/api" + route, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as Row;
  if (response.status !== expected)
    throw new Error(`${route}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
try {
  await start();
  if (
    (
      await fetch(origin + "/api/race-import/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status !== 401
  )
    throw new Error("wizard未認証拒否失敗");
  const now = new Date().toISOString(),
    draft = wizardDraft(now);
  const errors: string[] = [];
  const edge = [
    process.env.SMOKE_BROWSER_PATH,
    process.env["ProgramFiles(x86)"] &&
      path.join(
        process.env["ProgramFiles(x86)"]!,
        "Microsoft/Edge/Application/msedge.exe",
      ),
    process.env.ProgramFiles &&
      path.join(
        process.env.ProgramFiles,
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("本人用接続キー").fill(token);
  await page.getByRole("button", { name: "接続する" }).click();
  await page.getByRole("heading", { name: "本日のレース" }).waitFor();
  await page.getByRole("button", { name: /データを取り込む/ }).click();
  await page
    .getByLabel("公式出馬表JSON", { exact: true })
    .fill(JSON.stringify(draft));
  await page
    .getByRole("button", { name: "出馬表をプレビュー", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "2. 全頭と時点を照合して確定" })
    .waitFor();
  await page
    .getByLabel("公式・利用条件・全頭・取消・外部ID・日時を照合しました")
    .check();
  await page
    .getByRole("button", {
      name: "基礎データ・snapshotを確定して読返す",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "入力パックをダウンロード", exact: true })
    .waitFor();
  const snapshotId = await page
    .getByLabel("入力パックsnapshot ID", { exact: true })
    .inputValue();
  const pack = await api("/race-import/pack", { snapshot_id: snapshotId });
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "入力パックをダウンロード", exact: true })
    .click();
  const downloaded = await downloadEvent;
  const downloadedPath = await downloaded.path();
  if (
    !downloadedPath ||
    JSON.parse(await readFile(downloadedPath, "utf8")).pack_hash !==
      pack.pack_hash
  )
    throw new Error("ダウンロードパック不一致");
  const answer = wizardAnswer(pack, new Date().toISOString());
  await page
    .getByLabel("ChatGPT回答JSON", { exact: true })
    .fill(JSON.stringify(answer));
  await page
    .getByRole("button", { name: "全馬・3展開・参考Betを検証", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "5. 1Rの予想を確認して確定" })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "wizard-mobile-preview.png"),
    fullPage: true,
  });
  const assertWidth = async () => {
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error("390px画面で横はみ出し");
  };
  await assertWidth();
  await page
    .getByLabel("全馬採点・3展開・根拠・参考額を確認し、この1Rを確定します")
    .check();
  await page
    .getByRole("button", { name: "Coreで1R確定・保存後に読返す", exact: true })
    .click();
  await page
    .getByText("保存・ロック・実読返し完了。", { exact: false })
    .waitFor();
  const raceId = String(obj(pack.race).race_id);
  const beforeBet = await api(`/races/${raceId}`);
  if (rows(beforeBet.bets).length)
    throw new Error("予想保存で本人Betが発生しました");
  if (rows(beforeBet.evaluations).some((e) => e.win_probability !== null))
    throw new Error("未算出確率が数値化されました");
  await page
    .getByRole("button", {
      name: "レースを開いて本人の仮想Betを登録",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "当日の採用版として固定", exact: true })
    .click();
  await page.getByText("採用版を固定しました", { exact: true }).waitFor();
  await page.getByLabel("馬番（ハイフン区切り）", { exact: true }).fill("1");
  await page.getByLabel("本人購入額", { exact: true }).fill("100");
  await page
    .getByLabel("買い目・金額・採用版を確認しました（仮想購入）")
    .check();
  await page
    .getByRole("button", { name: "仮想購入を確定", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "wizard-mobile-before-bet.png"),
    fullPage: true,
  });
  await assertWidth();
  await page
    .getByRole("button", { name: "仮想購入を確定", exact: true })
    .click();
  await page
    .getByText("本人の仮想購入を保存しました", { exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "wizard-mobile-bet.png"),
    fullPage: true,
  });
  await assertWidth();
  const afterBet = await api(`/races/${raceId}`);
  if (
    rows(afterBet.bets).filter(
      (b) => b.status === "confirmed" && b.amount_yen === 100,
    ).length !== 1
  )
    throw new Error("本人Bet読返し不一致");
  const before = await api("/backup");
  await browser.close();
  browser = undefined;
  await stop();
  await start();
  const after = await api("/backup");
  if (before.hash !== after.hash) throw new Error("再起動後ハッシュ不一致");
  const restoredPack = await api("/race-import/pack", {
    snapshot_id: snapshotId,
  });
  if (pack.pack_hash !== restoredPack.pack_hash)
    throw new Error("再起動後pack不一致");
  if (errors.length) throw new Error(errors.join(" / "));
  await writeFile(
    path.join(output, "wizard-runtime-report.json"),
    JSON.stringify(
      {
        fixture_only: true,
        width: 390,
        browser: edge ? "Edge/Chromium" : "Chromium",
        iphone: "unverified",
        real_race: "unverified",
        steps: [
          "official-form-preview",
          "master-confirm-readback",
          "input-pack-download",
          "chatgpt-conversion",
          "core-lock-readback",
          "personal-adoption",
          "personal-bet-readback",
          "restart-backup-hash-match",
          "restart-pack-match",
        ],
        browser_errors: errors,
        horizontal_overflow: false,
        counts: after.counts,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    "PASS: isolated race wizard, 390px, Core/readback, personal Bet and restart. Real race/iPhone unverified.\n",
  );
} finally {
  await browser?.close();
  await stop();
}
