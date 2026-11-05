import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { obj, rows, type Row } from "../packages/shared/src/domain";
import {
  backup,
  MemoryRepository,
  restoreEmpty,
} from "../packages/shared/src/repository";
import { readBody } from "../workers/api/src/index";
import { importNameReference } from "../workers/api/src/name-reference-intake";
import { checkpointCore, writeWorkerHealth } from "../scripts/worker-health";

const NOW = "2026-11-05T00:00:00.000Z";
const source = (): Row => ({
  path: "daily/2026-11-05/morning-reference-v1.json",
  sha: "b".repeat(40),
  repository: "fixture/private",
  document: {
    schema_version: "1",
    report_type: "chatgpt_daily_reference",
    core_importable: false,
    date_jst: "2026-11-05",
    generated_at: NOW,
    races: [
      {
        race_key_human: "2026-11-05|架空場|12R",
        track: "架空場",
        race_no: 12,
        scheduled_start_at_jst: "2026-11-05T20:00:00+09:00",
        horses: [1, 2].map((n) => ({
          horse_number: n,
          horse_name: `架空馬${n}`,
          jockey: `架空騎手${n}`,
          evaluations: null,
        })),
        evaluations_complete: false,
        main_pace: null,
        scenarios: [],
        limitations: ["x".repeat(270000)],
      },
    ],
  },
});

describe("production outage recovery contracts (fixtures)", () => {
  it("距離と6評価の欠測を保持し、カタログだけを保存する", async () => {
    const input = source();
    delete rows(obj(input.document).races)[0].limitations;
    const repo = new MemoryRepository();
    const receipt = await importNameReference(repo, input, NOW);
    expect(rows(receipt.races)[0]).toMatchObject({
      status: "catalog_only",
      matched_entries: 2,
    });
    expect(rows(receipt.races)[0].issues).toContain(
      "距離未観測。カタログのみ保存",
    );
    expect(await repo.list("horses")).toHaveLength(2);
    expect(await repo.list("jockeys")).toHaveLength(2);
    for (const table of [
      "race_snapshots",
      "predictions",
      "virtual_bets",
    ] as const)
      expect(await repo.list(table)).toHaveLength(0);
    expect(obj(receipt.reference_document)).toEqual(input.document);
  });
  it("256KiBを超える実用サイズの論理backupを復元し、通常入力の上限を保つ", async () => {
    const input = source();
    // Large accumulated source receipts are ordinary import_operations data.
    const repo = new MemoryRepository();
    await repo.put("import_operations", {
      schema_version: "0.2",
      created_at: NOW,
      import_id: "fixture",
      payload_hash: "fixture",
      expected_rows_json: input,
      status: "complete",
    });
    const b = await backup(repo);
    const request = (route: string) =>
      new Request(`http://local/api/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
    const body = await readBody(request("restore"));
    const restored = new MemoryRepository();
    await restoreEmpty(restored, body as unknown as typeof b);
    expect((await backup(restored)).hash).toBe(b.hash);
    await expect(
      readBody(request("github-bridge/reference-register")),
    ).rejects.toThrow("256KiB");
    await expect(restoreEmpty(restored, b)).rejects.toThrow("空");
  });
  it("復元も16MiBでストリームを打ち切る", async () => {
    await expect(
      readBody(
        new Request("http://local/api/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: "x".repeat(16 * 1024 * 1024) }),
        }),
      ),
    ).rejects.toThrow("16MiB");
  });
  it("API障害をDOとは別に記録し、復旧と検証済みcheckpointを読み返せる", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "turflab-health-"));
    await writeWorkerHealth(home, {
      status: "failed",
      checked_at: NOW,
      last_error: "API障害",
    });
    expect(
      JSON.parse(await readFile(path.join(home, "health.json"), "utf8")),
    ).toMatchObject({ status: "failed", last_error: "API障害" });
    const b = await backup(new MemoryRepository());
    await checkpointCore(home, async () => b as unknown as Row);
    expect(
      JSON.parse(
        await readFile(
          path.join(home, `checkpoints/core-${b.hash}.json`),
          "utf8",
        ),
      ),
    ).toEqual(b);
    await expect(
      checkpointCore(
        home,
        async () => ({ ...b, hash: "bad" }) as unknown as Row,
      ),
    ).rejects.toThrow("ハッシュ");
    expect(await readdir(path.join(home, "checkpoints"))).toHaveLength(1);
    await writeWorkerHealth(home, {
      status: "healthy",
      checked_at: NOW,
      last_error: null,
    });
    expect(
      JSON.parse(await readFile(path.join(home, "health.json"), "utf8"))
        .last_error,
    ).toBeNull();
  });
});
