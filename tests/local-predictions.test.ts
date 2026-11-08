import { mkdtemp, readFile } from "node:fs/promises";
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
import { obj, str } from "../packages/shared/src/domain";
import {
  confirmMaster,
  previewMaster,
  inputPack,
} from "../workers/api/src/race-wizard";
import { route } from "../workers/api/src/index";
import { wizardDraft, wizardRequest, wizardAnswer } from "./wizard-fixture";

afterEach(() => vi.useRealTimers());

it("does not repeat an ambiguous CLI invocation after restart", async () => {
  const now = new Date("2026-11-09T01:00:00Z");
  const home = await mkdtemp(path.join(tmpdir(), "turflab-local-ambiguous-"));
  const infer = vi.fn(async () => {
    throw new Error("CODEX_TIMEOUT");
  });
  const api = async () => ({ races: [] });
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await worker.init();
  await expect(worker.tick(now)).rejects.toThrow("CODEX_TIMEOUT");
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
