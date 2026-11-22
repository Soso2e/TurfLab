import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import { importGitHubChatReview } from "../workers/api/src/github-chat-review-intake";

const NOW = "2026-11-22T08:00:00Z";
const FILE = "reviews/2026-11-22/tokyo-11-chat-review-v2.json";
const original = {
  path: FILE, sha: "a".repeat(40), date_jst: "2026-11-22",
  document: {
    schema_version: "1",
    record_type: "chatgpt_reference_race_review",
    core_importable: false,
    recorded_for_date_jst: "2026-11-22",
    official_result_verified: true,
    official_payout_verified: false,
    race: {
      race_key_human: "2026-11-22|東京|11R", track: "東京",
      race_no: 11, distance_m: 1400, surface: "ダート",
    },
    retrospective_review: {
      lessons: ["9番が勝利した理由は再検証が必要"],
      new_facts: ["9-5-6"],
    },
    limitations: ["これは発走後のレビューである"],
  },
};

async function setup() {
  const repo = new MemoryRepository();
  await repo.put("tracks", {
    schema_version: "0.2", track_id: "tokyo", name: "東京",
    jurisdiction: "JRA", created_at: NOW,
  });
  await repo.put("course_layouts", {
    schema_version: "0.2", course_id: "tokyo-d1400",
    track_id: "tokyo", surface: "ダート", distance_m: 1400,
    revision: 1, created_at: NOW,
  });
  await repo.put("races", {
    schema_version: "0.2", race_id: "strict-11",
    course_id: "tokyo-d1400", jurisdiction: "JRA",
    race_date_jst: "2026-11-22", race_number: 11,
    scheduled_start_at: "2026-11-22T06:20:00Z",
    external_id: "jra-11", source: "official", status: "official",
    created_at: NOW,
  });
  return repo;
}

describe("GitHub chat reviews are Core-linked evidence, not predictions or results", () => {
  it("links uniquely matched official race and records post-race provenance", async () => {
    const repo = await setup();
    const receipt = await importGitHubChatReview(repo, original, NOW);
    expect(receipt.status).toBe("linked");
    expect(receipt.race_id).toBe("strict-11");
    const records = await repo.list("reviews");
    expect(records).toHaveLength(1);
    expect(records[0].race_id).toBe("strict-11");
    expect(records[0].prediction_id).toBeNull();
    expect(records[0].result_id).toBeNull();
    expect(records[0].model_version_id).toBeNull();
    expect(records[0].source).toBe("github_chat_reference");
    expect(records[0].observations_json).toEqual(["9-5-6"]);
    expect((records[0].evidence_json as Record<string, unknown>).model_training_eligible).toBe(false);
    expect(await repo.list("predictions")).toHaveLength(0);
    expect(await repo.list("race_results")).toHaveLength(0);
    expect(await repo.list("settlements")).toHaveLength(0);
  });
  it("is idempotent for the same source and immutable against replaced path", async () => {
    const repo = await setup();
    await importGitHubChatReview(repo, original, NOW);
    const replay = await importGitHubChatReview(repo, original, "2026-11-22T08:05:00Z");
    expect(replay.already_saved).toBe(true);
    expect(await repo.list("reviews")).toHaveLength(1);
    await expect(importGitHubChatReview(repo, { ...original, sha: "b".repeat(40) }, NOW))
      .rejects.toThrow("内容が変更");
  });
  it("does not guess identity where no race or multiple strict candidates exist", async () => {
    const repo = await setup();
    const noMatch = { ...original, document: { ...original.document, race: {
      ...original.document.race, race_key_human: "2026-11-22|京都|11R", track: "京都",
    } } };
    expect((await importGitHubChatReview(repo, noMatch, NOW)).status).toBe("unmatched");
    await repo.put("races", {
      schema_version: "0.2", race_id: "strict-duplicate",
      course_id: "tokyo-d1400", jurisdiction: "JRA",
      race_date_jst: "2026-11-22", race_number: 11,
      scheduled_start_at: "2026-11-22T06:20:00Z",
      external_id: "jra-11-dupe", source: "official", status: "official",
      created_at: NOW,
    });
    expect((await importGitHubChatReview(repo, original, NOW)).status).toBe("unmatched");
    expect(await repo.list("reviews")).toHaveLength(0);
  });
  it("keeps day indexes out of per-race Core review table", async () => {
    const repo = await setup();
    const coverage = { ...original, path: "reviews/2026-11-22/today-prediction-coverage-v3.json",
      document: { schema_version: "1", record_type: "retrospective_prediction_and_result_coverage",
        core_importable: false } };
    expect((await importGitHubChatReview(repo, coverage, NOW)).status).toBe("reference_only");
    expect(await repo.list("reviews")).toHaveLength(0);
  });
  it("rejects date mismatches and invalid SHA", async () => {
    const repo = await setup();
    await expect(importGitHubChatReview(repo, { ...original, date_jst: "2026-11-21" }, NOW))
      .rejects.toThrow("日付");
    await expect(importGitHubChatReview(repo, { ...original, sha: "invalid" }, NOW))
      .rejects.toThrow("SHA");
  });
});
