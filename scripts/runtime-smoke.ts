import { readFile, writeFile } from "node:fs/promises";
import { fixture, NOW } from "../tests/fixtures";
import {
  obj,
  rows,
  snapshotContents,
  type Row,
} from "../packages/shared/src/domain";
import { chromium } from "@playwright/test";
const apiOrigin = "http://localhost:8787";
const vars = await readFile("workers/api/.dev.vars", "utf8");
const token = vars.match(/^API_TOKEN="(.+)"$/m)?.[1];
if (!token) throw new Error("ローカル検証用API_TOKENが未設定です");
async function call(path: string, body?: unknown) {
  const r = await fetch(apiOrigin + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json()) as Row;
  return { status: r.status, data };
}
const unauthorized = await fetch(apiOrigin + "/api/races");
if (unauthorized.status !== 401)
  throw new Error("未認証アクセスを拒否できません");
const connection = await call("/status");
if (connection.data.storage_mode !== "local")
  throw new Error("実Sheets接続では検証用データを作成できません");
const { input, prediction, data } = await fixture();
const current = new Date();
const generated = new Date(current.getTime() - 120000).toISOString();
const cutoff = new Date(current.getTime() - 180000).toISOString();
const start = new Date(current.getTime() + 6 * 3600000).toISOString();
const date = new Date(current.getTime() + 9 * 3600000)
  .toISOString()
  .slice(0, 10);
let coreStart = "",
  coreDate = "";
// Keep previous fixture data and choose an unused reference budget date.
for (let day = 0; day < 30; day++) {
  const candidate = new Date(current.getTime() + day * 86400000);
  coreDate = new Date(candidate.getTime() + 9 * 3600000)
    .toISOString()
    .slice(0, 10);
  const existing = await call("/races?date=" + coreDate);
  if (existing.status !== 200) throw new Error("検証日の予算を確認できません");
  if (existing.data.reference_budget_yen === 0) {
    coreStart = new Date(candidate.getTime() + 6 * 3600000).toISOString();
    break;
  }
}
if (!coreStart) throw new Error("未使用のローカル検証日がありません");
const runId = crypto.randomUUID().slice(0, 8);
const raceId = "runtime-smoke-race-" + runId;
const pid = "runtime-smoke-prediction-" + runId;
const master = structuredClone(data);
const mapping = new Map<string, string>();
for (const records of Object.values(master))
  for (const row of records!)
    for (const [k, v] of Object.entries(row))
      if (k.endsWith("_id") && typeof v === "string")
        mapping.set(v, v + "-" + runId);
function rewrite(value: unknown): unknown {
  if (typeof value === "string") return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
    );
  return value;
}
Object.assign(master, rewrite(master));
Object.assign(input, rewrite(input));
Object.assign(prediction, (input.predictions as Record<string, unknown>[])[0]);
(input.predictions as Record<string, unknown>[])[0] = prediction;

const sourceTime = new Date(current.getTime() - 3600000).toISOString();
for (const records of Object.values(master))
  for (const row of records!) {
    row.created_at = sourceTime;
    row.valid_as_of = sourceTime;
    row.available_at = sourceTime;
    row.retrieved_at = sourceTime;
  }
master.race_snapshots![0].captured_at = new Date(
  current.getTime() - 600000,
).toISOString();
for (const e of prediction.evidence as Record<string, unknown>[]) {
  e.valid_as_of = sourceTime;
  e.available_at = sourceTime;
  e.retrieved_at = sourceTime;
}
master.races![0] = {
  ...master.races![0],
  race_id: raceId,
  external_id: raceId,
  race_date_jst: date,
  scheduled_start_at: start,
  name: "架空レース · ローカル動作確認 " + runId,
};
for (const e of master.race_entries!) e.race_id = raceId;
master.race_snapshots![0].race_id = raceId;
const { hash } = await import("../packages/shared/src/domain");
prediction.snapshot_id = master.race_snapshots![0].snapshot_id;
prediction.model_version_id = master.model_versions![0].model_version_id;
const s = master.race_snapshots![0];
s.input_hash = await hash({
  race_id: s.race_id,
  captured_at: s.captured_at,
  entries_state_json: s.entries_state_json,
  scratch_status_json: s.scratch_status_json,
  odds_snapshot_ids_json: s.odds_snapshot_ids_json,
  weather: s.weather,
  going: s.going,
});
input.import_id = "runtime-smoke-import-" + runId;
input.generated_at = generated;
prediction.prediction_id = pid;
prediction.race_id = raceId;
prediction.information_cutoff_at = cutoff;
(prediction.simulation as Record<string, unknown>).simulation_id =
  "runtime-sim-" + runId;
async function ok(path: string, body: unknown) {
  const r = await call(path, body);
  if (r.status !== 200) throw new Error(path + ": " + JSON.stringify(r.data));
  return r.data;
}
await ok("/data/import", {
  operation_id: "runtime-smoke-master-" + runId,
  tables: master,
});
await ok("/imports/validate", input);
await ok("/imports", input);
await ok(`/predictions/${pid}/lock`, { operation_id: "runtime-lock-" + runId });
await ok(`/races/${raceId}/adopt`, { prediction_id: pid });
const concurrent = await Promise.all(
  [1, 2].map((i) =>
    call("/bets", {
      operation_id: `runtime-buy-${runId}-${i}`,
      race_id: raceId,
      prediction_id: pid,
      ticket_type: "win",
      selections: [1],
      amount_yen: 600,
    }),
  ),
);
if (
  concurrent
    .map((r) => r.status)
    .sort()
    .join(",") !== "200,409"
)
  throw new Error("同時購入の直列化に失敗: " + JSON.stringify(concurrent));
const d = await call("/races?date=" + date);
if (rows(d.data.races).find((r) => r.race_id === raceId)?.spent_yen !== 600)
  throw new Error("同時購入後の予算が不正です");
const successful = concurrent.find((r) => r.status === 200)!.data;
const retry = await ok("/bets", {
  operation_id: successful.operation_id,
  race_id: raceId,
  prediction_id: pid,
  ticket_type: "win",
  selections: [1],
  amount_yen: 600,
});
if (retry.bet_id !== successful.bet_id)
  throw new Error("購入再送の冪等性に失敗");
// Core uses a separate reference ledger and the same owner serialization.
const coreInputs: Row[] = [];
for (let n = 1; n <= 7; n++) {
  const coreRaceId = `runtime-core-${runId}-${n}`;
  const corePid = `runtime-core-prediction-${runId}-${n}`;
  const coreSnapshotId = `runtime-core-snapshot-${runId}-${n}`;
  const coreEntries = master.race_entries!.map((e) => ({
    ...e,
    entry_id: `${e.entry_id}:core:${n}`,
    race_id: coreRaceId,
    draw_number: e.horse_number,
    carried_weight_kg: 55,
  }));
  const coreSnapshot: Row = {
    ...master.race_snapshots![0],
    race_id: coreRaceId,
    snapshot_id: coreSnapshotId,
    entries_state_json: coreEntries,
  };
  coreSnapshot.input_hash = await hash(snapshotContents(coreSnapshot));
  await ok("/data/import", {
    operation_id: `runtime-core-master-${runId}-${n}`,
    tables: {
      races: [
        {
          ...master.races![0],
          race_id: coreRaceId,
          external_id: coreRaceId,
          race_number: n,
          name: `Core架空レース ${runId} ${n}`,
          race_date_jst: coreDate,
          scheduled_start_at: coreStart,
        },
      ],
      race_entries: coreEntries,
      race_snapshots: [coreSnapshot],
    },
  });
  const p = structuredClone(prediction);
  p.prediction_id = corePid;
  p.race_id = coreRaceId;
  p.snapshot_id = coreSnapshotId;
  p.horse_evaluations = rows(p.horse_evaluations).map((e, i) => ({
    ...e,
    entry_id: coreEntries[i].entry_id,
    score: 86.9,
    rank: 99,
    components: {
      ability: 80,
      course: 90,
      pace: 80,
      going: 90,
      draw_weight: 80,
      horse_jockey_course: 90,
    },
  }));
  const sim = obj(p.simulation);
  sim.simulation_id = `runtime-core-sim-${runId}-${n}`;
  sim.scenarios = rows(sim.scenarios).map((scenario) => ({
    ...scenario,
    lineup: coreEntries.map((e) => ({
      entry_id: e.entry_id,
      position: "先行の仮説",
      advantage: "架空の有利不利",
    })),
  }));
  p.recommendations =
    n === 7
      ? []
      : [
          {
            recommendation_id: `core-rec-${runId}-${n}`,
            ticket_type: "win",
            selections: [1],
            estimated_probability: 0.6,
            suggested_amount_yen: 1000,
            reason: "架空テスト専用",
          },
        ];
  if (n === 7) p.skip_reason = "架空の見送りテスト";
  coreInputs.push({
    pipeline_id: `runtime-core-run-${runId}-${n}`,
    generated_at: generated,
    prediction: p,
  });
}
for (const input of coreInputs.slice(0, 4)) {
  const run = await ok("/pipeline/race", input);
  if (run.stage !== "BET_LOCKED" || run.status !== "complete")
    throw new Error("Core確定失敗: " + JSON.stringify(run));
}
const coreConcurrent = await Promise.all(
  coreInputs.slice(4, 6).map((input) => ok("/pipeline/race", input)),
);
if (
  coreConcurrent.filter((r) => r.status === "complete").length !== 1 ||
  coreConcurrent.filter((r) => r.status === "failed").length !== 1
)
  throw new Error("Core同時予算制御失敗");
const coreReplay = await ok("/pipeline/race", coreInputs[0]);
if (coreReplay.attempt !== 1) throw new Error("Core再送が二重実行になりました");
const coreDetail = await call(
  "/races/" + String(obj(coreInputs[0].prediction).race_id),
);
if (
  rows(coreDetail.data.evaluations).some((e) => e.score !== 85) ||
  rows(coreDetail.data.bets).length
)
  throw new Error("Coreスコア・購入分離に失敗");
const coreDashboard = await call("/races?date=" + coreDate);
if (coreDashboard.data.reference_budget_yen !== 5000)
  throw new Error("Core参考予算が不正");
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5173");
await page.getByLabel("本人用接続キー").fill(token);
await page.getByRole("button", { name: "接続する" }).click();
await page.getByRole("heading", { name: "本日のレース" }).waitFor();
await page.locator('input[type="date"]').fill(date);
await page
  .getByRole("heading", { name: "架空レース · ローカル動作確認 " + runId })
  .waitFor();
await page.screenshot({
  path: "/workspace/scratch/turflab-desktop.png",
  fullPage: true,
});
await page
  .getByRole("button", {
    name: new RegExp("架空レース · ローカル動作確認 " + runId),
  })
  .click();
await page.getByRole("heading", { name: "推奨と本人の仮想購入" }).waitFor();
await page.getByRole("button", { name: "03成績と検証" }).click();
await page.getByRole("heading", { name: "本人購入の成績" }).waitFor();
await page.getByRole("heading", { name: "推奨買い目の参考収支" }).waitFor();
await page.getByRole("button", { name: "02データを取り込む" }).click();
await page.getByLabel("入力種別").selectOption("pipeline");
await page.getByLabel("取り込みJSON").fill(JSON.stringify(coreInputs[6]));
await page
  .getByRole("button", { name: "計算・検証して参考プランを確定" })
  .click();
await page.getByText("保存と読み返しを完了しました").waitFor();
await page.getByText('"SKIPPED"', { exact: false }).waitFor();
await page.getByLabel("入力種別").selectOption("prediction");
await page.getByLabel("取り込みJSON").fill("{");
await page.getByRole("button", { name: "検証・プレビュー" }).click();
await page.getByRole("alert").waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole("button", { name: /本日のレース/ }).click();
await page.getByRole("heading", { name: "本日のレース" }).waitFor();
await page.locator('input[type="date"]').fill(coreDate);
await page.getByText("参考プランの採用・予約額", { exact: false }).waitFor();
await page.screenshot({
  path: "/workspace/scratch/turflab-mobile.png",
  fullPage: true,
});
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth,
);
if (overflow) throw new Error("モバイルの横幅が画面を超えています");
if (errors.length) throw new Error("ブラウザエラー: " + errors.join(";"));
await browser.close();
await writeFile(
  "/workspace/scratch/turflab-runtime-report.json",
  JSON.stringify(
    {
      unauthenticated_status: unauthorized.status,
      core_concurrent_statuses: coreConcurrent.map((r) => r.status),
      reference_budget_yen: coreDashboard.data.reference_budget_yen,
      core_score: 85,
      core_ui_skip: "complete",
      concurrent_purchase_statuses: concurrent.map((r) => r.status),
      spent_yen: 600,
      duplicate_retry: "same-bet",
      browser_errors: errors,
      mobile_horizontal_overflow: overflow,
      checked_routes: [
        "dashboard",
        "detail",
        "stats",
        "import-error",
        "core-api",
        "core-ui-skip",
      ],
      fixture_only: true,
      reference_test_time: NOW,
      visible_races: rows(d.data.races).length,
    },
    null,
    2,
  ),
);
process.stdout.write(
  "Workers実行・未認証拒否・同時購入・再送・PC/スマホ操作: OK\n",
);
