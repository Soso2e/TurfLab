import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  immutableLocalFile,
  localFiles,
  claimLocalWorker,
  LocalPredictionWorker,
} from "../scripts/local-prediction-worker";
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
