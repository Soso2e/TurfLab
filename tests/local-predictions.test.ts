import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  immutableLocalFile,
  callBucket,
  claimLocalWorker,
  LocalPredictionWorker,
  MAX_AUTO_RACES,
} from "../scripts/local-prediction-worker";
import { localFiles } from "../scripts/github-bridge";
import { MemoryRepository } from "../packages/shared/src/repository";
import { obj, str, type Row } from "../packages/shared/src/domain";
import {
  confirmMaster,
  previewMaster,
  inputPack,
} from "../workers/api/src/race-wizard";
import { route } from "../workers/api/src/index";
import { wizardDraft, wizardRequest, wizardAnswer } from "./wizard-fixture";

afterEach(() => vi.useRealTimers());

it("retains old comparisons and uses Core result IDs after the race leaves daily state", async () => {
  const now = new Date("2026-11-13T13:00:00Z");
  const home = await mkdtemp(path.join(tmpdir(), "turflab-outcome-replay-"));
  const exchange = path.join(home, "exchange");
  const oldDate = "2026-11-10";
  const lab = {
    race_id: "older", race_date_jst: oldDate, saved_at: "2026-11-10T02:00:00Z",
    scheduled_start_at: "2026-11-10T03:00:00Z", ranking: [{ horse_number: 1 }],
  };
  const existing = JSON.stringify({
    lab_path: `lab/${oldDate}/first.json`, result_id: "core-result", result_revision: 1,
    race_id: "older", race_date_jst: oldDate,
  });
  await immutableLocalFile(exchange, `lab/${oldDate}/first.json`, JSON.stringify(lab));
  await immutableLocalFile(exchange, `lab/${oldDate}/second.json`, JSON.stringify(lab));
  await immutableLocalFile(exchange, `outcomes/${oldDate}/first-r1.json`, existing);
  await immutableLocalFile(exchange, `results/${oldDate}/older-official-v1.json`, JSON.stringify({
    result: { race_id: "older", revision: 1, official_status: "official" },
  }));
  const api = vi.fn(async (route: string): Promise<Row> => {
    if (route === "/local-predictions/official-results") return {
      results: [{
        race_id: "older", result_id: "core-result", revision: 1, official_status: "official",
        finish_order_json: [[1]], entry_status_json: { "1": "finished" }, payouts: [],
      }],
    };
    return { races: [] };
  });
  const infer = vi.fn(async () => ({}));
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await worker.init();
  await worker.tick(now);
  await worker.tick(now);
  expect(api).toHaveBeenCalledWith("/local-predictions/official-results", { race_ids: ["older"] });
  expect(await readFile(path.join(exchange, "outcomes", oldDate, "first-r1.json"), "utf8")).toBe(existing);
  const saved = JSON.parse(await readFile(path.join(exchange, "outcomes", oldDate, "second-r1.json"), "utf8"));
  expect(saved).toMatchObject({ result_id: "core-result", result_revision: 1, actual_winners: [1] });
  expect(infer).not.toHaveBeenCalled();
});

it.each([500, 401, 403])(
  "continues after a race fetch failure but stops on authentication failure (%s)",
  async (status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-11-09T13:00:00Z");
    vi.setSystemTime(now);
    const home = await mkdtemp(path.join(tmpdir(), "turflab-local-failure-"));
    const races = ["first", "second"].map((race_id) => ({
      race: {
        race_id,
        race_date_jst: "2026-11-09",
        scheduled_start_at: "2026-11-09T14:00:00Z",
      },
      predictions: [],
    }));
    const api = vi.fn(async (url: string): Promise<Row> => {
      if (url === "/daily-state") return { races };
      if (url === "/races/first") throw new Error(`CORE_HTTP_${status}`);
      if (url === "/races/second") return { snapshots: [] };
      return {};
    });
    const infer = vi.fn(async () => ({}));
    const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
    await worker.init();
    if (status === 500) {
      const report = await worker.tick(now);
      expect(report.blocked_jobs).toBe(1);
      expect(report.job_issues).toContainEqual({
        job: "first",
        reason: "CORE_HTTP_500",
      });
      expect(api).toHaveBeenCalledWith("/races/second");
      expect(api).toHaveBeenCalledWith("/analytics/ranks");
    } else {
      await expect(worker.tick(now)).rejects.toThrow(`CORE_HTTP_${status}`);
      expect(api).not.toHaveBeenCalledWith("/races/second");
    }
    expect(infer).not.toHaveBeenCalled();
  },
);

it("does not repeat an ambiguous CLI invocation after restart", async () => {
  const now = new Date("2026-11-09T01:00:00Z");
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-ambiguous-"));
  const infer = vi.fn(async () => {
    throw new Error("CODEX_TIMEOUT");
  });
  const api = async () => ({ races: [] });
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await worker.init();
  expect((await worker.tick(now)).blocked_jobs).toBe(1);
  const restarted = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await restarted.init();
  expect((await restarted.tick(now)).blocked_jobs).toBe(1);
  expect(infer).toHaveBeenCalledTimes(1);
});

it("keeps local evidence immutable and rejects another worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "turflab-local-test-"));
  const name = "daily/2026-11-09/morning-reference-v1.json";
  await immutableLocalFile(root, name, "{}");
  await immutableLocalFile(root, name, "{}");
  await expect(
    immutableLocalFile(root, name, '{"changed":true}'),
  ).rejects.toThrow("CONFLICT");
  await expect(
    immutableLocalFile(root, "../secret.json", "{}"),
  ).rejects.toThrow("PATH");
  expect(await localFiles(root)).toHaveLength(1);
  expect(await readFile(path.join(root, name), "utf8")).toBe("{}");
  const release = await claimLocalWorker(root);
  await expect(claimLocalWorker(root)).rejects.toThrow("ALREADY_RUNNING");
  await release();
});

it("runs a fixed pack through the existing Core and resumes without another AI call", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-11-09T01:00:00.000Z";
  vi.setSystemTime(now);
  const repo = new MemoryRepository();
  const input = wizardRequest(wizardDraft(now));
  const preview = await previewMaster(repo, input, now);
  const saved = await confirmMaster(
    repo,
    { ...input, preview_hash: preview.preview_hash, confirmed: true },
    now,
  );
  const pack = await inputPack(repo, str(saved, "snapshot_id"), now);
  const infer = vi.fn(async (_directory: string, prompt: string) =>
    prompt.includes("最大")
      ? {
          schema_version: "1",
          report_type: "chatgpt_daily_reference",
          date_jst: "2026-11-09",
          generated_at: now,
          core_importable: false,
          races: [],
        }
      : wizardAnswer(pack, now),
  );
  const api = async (url: string, body?: unknown) =>
    obj(
      await route(
        repo,
        new Request("http://local/api" + url, {
          method: body ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
        now,
      ),
    );
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-core-"));
  const worker = new LocalPredictionWorker(
    home,
    api,
    "53項目",
    "fixture",
    infer,
  );
  await worker.init();
  await worker.tick(new Date(now));
  expect(infer).toHaveBeenCalledTimes(2);
  expect(await repo.list("predictions")).toEqual([
    expect.objectContaining({ status: "locked" }),
  ]);
  expect(await repo.list("virtual_bets")).toHaveLength(0);
  const restarted = new LocalPredictionWorker(
    home,
    api,
    "53項目",
    "fixture",
    infer,
  );
  await restarted.init();
  await restarted.tick(new Date(now));
  expect(infer).toHaveBeenCalledTimes(2);
  expect(await repo.list("predictions")).toHaveLength(1);
});

it("keeps an incomplete analysis as an unadopted Lab record, not a Core prediction", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-11-09T01:00:00.000Z";
  vi.setSystemTime(now);
  const repo = new MemoryRepository();
  const input = wizardRequest(wizardDraft(now));
  const preview = await previewMaster(repo, input, now);
  await confirmMaster(
    repo,
    { ...input, preview_hash: preview.preview_hash, confirmed: true },
    now,
  );
  const infer = vi.fn(async (_directory: string, prompt: string): Promise<Row> =>
    prompt.includes("最大")
      ? { races: [], limitations: [] }
      : {
          blocked: true,
          reason: "枠の傾向資料なし",
          missing: [{ horse_number: null, component: "draw_weight", detail: "枠別集計なし" }],
          lab_evaluations: [{
            horse_number: 1, horse_name: "x",
            components: { ability: 60, course: 50, pace: 55, going: 50, draw_weight: null, horse_jockey_course: 40 },
            rationale: "研究用",
          }],
        },
  );
  const api = async (url: string, body?: unknown) =>
    obj(await route(repo, new Request("http://local/api" + url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }), now));
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-lab-"));
  const worker = new LocalPredictionWorker(home, api, "53項目", "fixture", infer);
  await worker.init();
  const report = await worker.tick(new Date(now));
  expect(report.job_issues).toContainEqual(expect.objectContaining({
    missing: [expect.objectContaining({ component: "draw_weight" })],
  }));
  expect(await repo.list("predictions")).toHaveLength(0);
  const labDir = path.join(home, "exchange", "lab", "2026-11-09");
  const lab = await readdir(labDir);
  expect(lab).toHaveLength(1);
  const record = JSON.parse(await readFile(path.join(labDir, lab[0]), "utf8"));
  expect(record).toMatchObject({ lane: "lab", adopted: false, saved_at: now });
  expect(record.evaluations[0].components.draw_weight).toBeNull();
});

it("keeps a separate CLI budget for official results", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2026-11-09T05:00:00Z");
  vi.setSystemTime(now);
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-budget-"));
  const races = [{
    race: { race_id: "done", race_date_jst: "2026-11-09", scheduled_start_at: "2026-11-09T03:00:00Z" },
    entries: [], predictions: [],
  }];
  const api = vi.fn(async (url: string): Promise<Row> =>
    url === "/daily-state" ? { races } : {});
  const infer = vi.fn(async () => ({ blocked: true, reason: "公表待ち" }));
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer, 0, undefined, 1);
  await worker.init();
  const report = await worker.tick(now);
  expect(infer).toHaveBeenCalledTimes(1);
  expect(String(infer.mock.calls[0])).toContain("公式結果");
  expect(report.job_issues).toContainEqual(expect.objectContaining({ reason: "本日のCLI呼出し上限に到達" }));
});

it("re-submits a stored complete result after Core rejected it, without another CLI call", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2026-11-10T08:30:00Z");
  vi.setSystemTime(now);
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-resubmit-"));
  const races = [{
    race: { race_id: "done", race_date_jst: "2026-11-10", scheduled_start_at: "2026-11-10T07:00:00Z" },
    entries: [], predictions: [],
  }];
  const answer = { bridge_version: "1", result: { race_id: "done" }, payouts: [] };
  let reject = true;
  const posted: Row[] = [];
  const api = vi.fn(async (url: string, body?: unknown): Promise<Row> => {
    if (url === "/daily-state") return { races };
    if (url === "/github-bridge/official-result") {
      posted.push(obj(body));
      if (reject) throw new Error("CORE_HTTP_400");
    }
    return {};
  });
  const infer = vi.fn(async () => answer);
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer, 0, undefined, 5);
  await worker.init();
  await worker.tick(now);
  expect(infer).toHaveBeenCalledTimes(1);
  reject = false;
  // Next 6-hour slot: a new job key, but the stored answer is reused.
  const later = new Date("2026-11-10T09:30:00Z");
  vi.setSystemTime(later);
  await worker.tick(later);
  expect(infer).toHaveBeenCalledTimes(1);
  expect(posted).toHaveLength(2);
  expect((await readdir(path.join(home, "jobs"))).filter((j) => j.includes("-result-"))).toHaveLength(1);
  expect(obj(posted[1].document)).toEqual(answer);
});

it("uses helperInfer for research/result/review tasks and infer for prediction tasks", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2026-11-09T05:00:00Z");
  vi.setSystemTime(now);
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-helper-"));
  const races = [{
    race: { race_id: "done", race_date_jst: "2026-11-09", scheduled_start_at: "2026-11-09T03:00:00Z" },
    entries: [], predictions: [],
  }];
  const api = vi.fn(async (url: string): Promise<Row> =>
    url === "/daily-state" ? { races } : {});
  const infer = vi.fn(async () => ({ blocked: true, reason: "prediction mock" }));
  const helperInfer = vi.fn(async () => ({ blocked: true, reason: "helper mock" }));
  const worker = new LocalPredictionWorker(
    home, api, "", "fixture-model", infer, 0, undefined, 1, helperInfer, "gemini-3.8-flash-medium",
  );
  await worker.init();
  await worker.tick(now);
  expect(helperInfer).toHaveBeenCalled();
  expect(infer).not.toHaveBeenCalled();
});


it("draws research, prediction and result jobs from separate daily budgets", () => {
  expect(callBucket("2026-11-11-research-3")).toBe("research");
  expect(callBucket("2026-11-11-history-abc")).toBe("research");
  expect(callBucket("2026-11-11-going-abc-5")).toBe("research");
  expect(callBucket("2026-11-11-prerace-abc")).toBe("research");
  expect(callBucket("2026-11-11-abc123-context-v3")).toBe("predict");
  expect(callBucket("2026-11-11-abc123-context-v1")).toBe("predict");
  expect(callBucket("2026-11-11-result-abc-2")).toBe("after");
  expect(callBucket("2026-11-11-review-abc")).toBe("after");
});

it("selects at most three races a day and reports per-race stages", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2026-11-11T01:00:00Z");
  vi.setSystemTime(now);
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-stages-"));
  const races = [{
    race: { race_id: "later", name: "特別", race_number: 9, race_date_jst: "2026-11-11",
      scheduled_start_at: "2026-11-11T06:00:00Z" },
    entries: [], predictions: [],
  }];
  const api = vi.fn(async (url: string): Promise<Row> =>
    url === "/daily-state" ? { races } : {});
  const prompts: string[] = [];
  const infer = vi.fn(async (_dir: string, prompt: string) => {
    prompts.push(prompt);
    return { races: [], limitations: ["fixture"] };
  });
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await worker.init();
  const report = await worker.tick(now);
  expect(MAX_AUTO_RACES).toBe(3);
  expect(prompts.find((p) => p.includes("最大"))).toContain(`最大${MAX_AUTO_RACES - 1}R`);
  expect(report.race_stages).toContainEqual(expect.objectContaining({
    race_id: "later", stage: 1, detail: "固定入力の作成待ち",
  }));
});

it("fills past runs from the owner's NAR CSV before any CLI call", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "turflab-csv-first-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(home, "nar-csv"), { recursive: true });
  await writeFile(path.join(home, "nar-csv", "results.csv"),
    "競馬場,競走年月日,レース番号,枠番,馬番,騎手名,着順,馬名\n名古屋,2026/10/20,5,3,3,騎手一,2,アルファ\n");
  const memory = (filled: boolean) => ({
    runs_complete: false,
    horses: [{ horse_number: 1, horse_id: "h1", horse_name: "アルファ", jockey_name: "騎手一", runs_missing: filled ? 2 : 3,
      saved_runs: filled ? [{ date_jst: "2026-10-20" }] : [], fields_missing: [], jockey_notes: [] }],
  });
  let saved = false;
  const posted: Row[] = [];
  const api = vi.fn(async (url: string, body?: unknown): Promise<Row> => {
    if (url === "/local-predictions/entity-memory") return memory(saved);
    if (url === "/local-predictions/run-records/csv") {
      posted.push(obj(body));
      saved = true;
      return { filled_fields: 6 };
    }
    return {};
  });
  const infer = vi.fn(async () => ({}));
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer, 0, undefined, 5);
  const pack = { snapshot_id: "s1", race: { jurisdiction: "NAR" } };
  const after = await (worker as unknown as { memoryWithCsv(p: Row, d: string): Promise<Row> }).memoryWithCsv(pack, "2026-11-13");
  expect(infer).not.toHaveBeenCalled();
  const record = (posted[0].records as Row[])[0];
  expect(record).toMatchObject({ horse_id: "h1", before_date: "2026-11-13", run: { date_jst: "2026-10-20", finish: 2, horse_number: 3, jockey: "騎手一", field_size: 1 } });
  expect(String(record.file_sha256)).toMatch(/^[0-9a-f]{64}$/);
  expect((after.horses as Row[])[0].runs_missing).toBe(2);
});
