import { describe, expect, it } from "vitest";
import {
  advanceJob,
  createMorningJob,
  type C2Job,
} from "../packages/shared/src/c2-job";
import {
  detectWindowsAi,
  disabledWindowsAiAdapter,
  mockAiAdapter,
} from "../scripts/c2-ai-provider";
import { diagnoseC2 } from "../scripts/c2-diagnostics";

const day = "2026-11-08";
const at = (seconds: number) =>
  new Date(Date.parse("2026-11-07T15:00:00Z") + seconds * 1000).toISOString();
const packHash = "a".repeat(64);
const sha = "b".repeat(40);
const ai = {
  branch: "acceptance",
  path: `predictions/${day}/race-1-morning-v1.json`,
  commit: "c".repeat(40),
  sourceSha: sha,
  contentHash: "d".repeat(64),
  packHash,
  savedAt: at(12),
};
type Action = Parameters<typeof advanceJob>[1];
type Payload<T> = T extends Action ? Omit<T, "at" | "revision"> : never;
function send(job: C2Job, seconds: number, event: Payload<Action>) {
  return advanceJob(job, { ...event, at: at(seconds), revision: job.revision });
}
function ready() {
  const job = createMorningJob(day, "race-1", at(100), at(0));
  return send(job, 5, {
    type: "pack",
    pack: { hash: packHash, snapshotId: "s1", cutoff: at(4) },
  });
}
const claim = {
  type: "claim",
  worker: "worker1",
  runId: "run1",
  leaseMs: 20_000,
} as const;
const owner = (job: C2Job) => ({
  fence: job.lease!.fence,
  worker: job.lease!.worker,
  runId: job.lease!.runId,
});
function aiSaved() {
  const leased = send(ready(), 10, claim);
  return send(leased, 13, { type: "ai-saved", receipt: ai, ...owner(leased) });
}

describe("C2 job", () => {
  it("uses the JST day and rejects late Morning and edits to a fixed pack", () => {
    expect(() =>
      createMorningJob("2026-11-07", "race-1", at(100), at(-1)),
    ).toThrow();
    const job = ready();
    expect(job.key).toBe(`${day}/race-1/morning`);
    expect(
      send(job, 6, {
        type: "pack",
        pack: { ...job.pack!, hash: "0".repeat(64) },
      }),
    ).toBe(job);
    expect(send(job, 100, claim)).toBe(job);
    expect(send(job, 100, { type: "tick" }).status).toBe("EXPIRED");
  });

  it("fences competing workers, duplicate events and out-of-order observations", () => {
    const job = ready();
    const event = { ...claim, at: at(10), revision: job.revision };
    const leased = advanceJob(job, event);
    expect(advanceJob(leased, event)).toBe(leased);
    expect(send(leased, 11, { ...claim, worker: "worker2" })).toBe(leased);
    expect(send(leased, 9, { type: "heartbeat", ...owner(leased) })).toBe(
      leased,
    );
    expect(
      send(leased, 11, { type: "heartbeat", ...owner(leased), runId: "old" }),
    ).toBe(leased);
    const heartbeat = send(leased, 25, { type: "heartbeat", ...owner(leased) });
    expect(heartbeat.lease?.expires).toBe(Date.parse(at(45)));
    expect(
      send(heartbeat, 26, {
        type: "ai-saved",
        ...owner(heartbeat),
        receipt: { ...ai, packHash: "0".repeat(64) },
      }),
    ).toBe(heartbeat);
  });

  it("blocks ambiguous AI timeouts and reconciles a proven pre-start save without another AI run", () => {
    const leased = send(ready(), 10, claim);
    const blocked = send(leased, 30, { type: "tick" });
    expect(blocked).toMatchObject({
      status: "BLOCKED",
      failure: "AI_UNCONFIRMED",
    });
    expect(send(blocked, 31, claim)).toBe(blocked);
    const confirmed = send(blocked, 31, {
      type: "confirm-ai-absent",
      jitterMs: 0,
    });
    expect(confirmed).toMatchObject({
      status: "FAILED_RETRYABLE",
      retryAt: Date.parse(at(46)),
    });
    expect(
      send(blocked, 102, { type: "confirm-ai-absent", jitterMs: 0 }).status,
    ).toBe("EXPIRED");
    expect(
      send(blocked, 102, {
        type: "recover-ai",
        receipt: { ...ai, savedAt: at(100) },
      }),
    ).toBe(blocked);
    const recovered = send(blocked, 102, { type: "recover-ai", receipt: ai });
    expect(send(recovered, 103, claim)).toMatchObject({
      status: "VALIDATING",
      ai,
    });
  });

  it("resumes the same SHA after PC restart and accepts a late readback only for a pre-start lock", () => {
    const saved = aiSaved();
    const offline = send(saved, 14, { type: "local-offline" });
    expect(offline.status).toBe("WAITING_LOCAL");
    const original = send(offline, 15, claim);
    const expired = send(original, 105, { type: "tick" });
    const restored: C2Job = JSON.parse(JSON.stringify(expired));
    const next = send(restored, 106, {
      ...claim,
      worker: "worker2",
      runId: "run2",
    });
    const lock = {
      type: "core-locked",
      receipt: "prediction-1",
      sourceSha: sha,
      packHash,
      lockedAt: at(80),
    } as const;
    expect(send(next, 107, { ...lock, ...owner(original) })).toBe(next);
    expect(
      send(next, 107, { ...lock, ...owner(next), lockedAt: at(105) }),
    ).toBe(next);
    expect(
      send(next, 107, { ...lock, ...owner(next), sourceSha: "e".repeat(40) }),
    ).toBe(next);
    const locked = send(next, 107, { ...lock, ...owner(next) });
    expect(locked).toMatchObject({ status: "CORE_LOCKED", ai });
    expect(send(locked, 108, claim)).toBe(locked);
    expect(send(locked, 108, { type: "review", receipt: "review-1" })).toBe(
      locked,
    );
    const waiting = send(locked, 108, { type: "wait-result" });
    const result = send(waiting, 109, { type: "result", receipt: "result-1" });
    expect(
      send(result, 110, { type: "review", receipt: "review-1" }).status,
    ).toBe("REVIEWED");
  });

  it("stops on 403 and backs off on 429 only when no AI save has been verified", () => {
    const leased = send(ready(), 10, claim);
    const fail = { type: "failed", jitterMs: 1000, ...owner(leased) } as const;
    expect(send(leased, 11, { ...fail, code: "AUTH" })).toMatchObject({
      status: "BLOCKED",
      failure: "AUTH",
    });
    expect(send(leased, 11, { ...fail, code: "RATE_LIMIT" })).toMatchObject({
      status: "BLOCKED",
      failure: "AI_UNCONFIRMED",
    });
    const retry = send(leased, 11, {
      ...fail,
      code: "RATE_LIMIT",
      confirmedNoAiSave: true,
    });
    expect(retry).toMatchObject({
      status: "FAILED_RETRYABLE",
      retryAt: Date.parse(at(27)),
    });
    expect(send(retry, 26, claim)).toBe(retry);
    expect(send(retry, 27, claim).attempt).toBe(2);
  });
});

describe("read-only diagnostics", () => {
  it("projects a partial 5R day, preserves the earlier locked receipt and separates snapshot reviews", () => {
    const seen = { sha, received_at: at(50), content_hash: ai.contentHash };
    const state = {
      version: 1,
      last_error: "403 secret-not-for-output",
      files: {
        [ai.path]: {
          ...seen,
          status: "success",
          prediction_id: "prediction-1",
          conflict_sha: ai.commit,
        },
        [`predictions/${day}/race-2-morning-v1.json`]: {
          ...seen,
          status: "waiting",
          pipeline: {},
        },
        [`predictions/${day}/race-3-morning-v1.json`]: {
          ...seen,
          status: "failed",
          reason: "invalid private text",
        },
        "predictions/2026-11-07/other-morning-v1.json": {
          ...seen,
          status: "success",
          prediction_id: "other",
        },
      },
      exports: { [`packs/${day}/race-4-${packHash}.json`]: packHash },
      reference_files: {
        [`daily/${day}/morning-reference-v1.json`]: {
          sha,
          checked_at: at(40),
          status: "complete",
          races: [{ race_key_human: "東京 5R", status: "past_start" }],
        },
      },
      official_results: {
        [`results/${day}/race-1-official-v1.json`]: {
          sha,
          checked_at: at(220),
          status: "complete",
          result_id: "result-1",
        },
      },
    };
    const snapshot = {
      report_type: "turfLab_daily_state",
      origin: "authenticated_turflab_core_read_only",
      schema_version: "1",
      included_dates_jst: [day],
      generated_at: at(55),
      races: [
        { race: { race_date_jst: day, race_id: "race-2" }, reviews: [{}] },
      ],
    };
    const report = diagnoseC2(
      day,
      at(230),
      state,
      { checked_at: at(60), status: "healthy" },
      snapshot,
    );
    expect(report.counts).toEqual({
      reference_races: 1,
      fixed_input_races: 1,
      ai_saved_races: 3,
      core_locked_races: 1,
      official_result_races: 1,
    });
    expect(report.races.map((r) => r.status)).toEqual([
      "RESULT_VERIFIED",
      "WAITING_LOCAL",
      "BLOCKED",
      "INPUT_READY",
      "EXPIRED",
    ]);
    expect(report.races[0].failure).toBe("SOURCE_CHANGED");
    expect(report.worker.status).toBe("STALE");
    expect(report.last_failure).toBe("AUTH_OR_TRANSPORT");
    expect(report.last_evidence?.at).toBe(at(220));
    expect(report.review_snapshot).toEqual({
      as_of: at(55),
      reviewed_races: 1,
      race_keys: ["race-2"],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /secret-not-for-output|invalid private text/,
    );
  });

  it("reports unknown counts and Worker status when there are no local files", () => {
    const report = diagnoseC2(day, at(1), null, null, null);
    expect(report.counts.core_locked_races).toBeNull();
    expect(report.worker.status).toBe("UNKNOWN");
    expect(report.review_snapshot).toBeNull();
  });
});

it("detects Windows PATH presence without executing a CLI, with explicit errors and a cloneable mock", async () => {
  const probe = async (file: string) => file.endsWith("agy.exe");
  expect(
    await detectWindowsAi("antigravity", "C:\\fixture", probe),
  ).toMatchObject({ presence: "FOUND", error: "NON_INTERACTIVE_UNVERIFIED" });
  expect(await detectWindowsAi("claude", "C:\\fixture", probe)).toMatchObject({
    presence: "NOT_FOUND_ON_PATH",
    error: "CLI_NOT_ON_PATH",
  });
  const request = { jobKey: "test", runId: "test", packHash, model: null };
  await expect(
    disabledWindowsAiAdapter("chatgpt-github-receipt").observe(request),
  ).rejects.toMatchObject({ code: "RECEIPT_ONLY" });
  const observation = {
    kind: "cli",
    provider: "codex",
    model: null,
    startedAt: at(1),
    finishedAt: at(2),
    exitCode: 0,
    stdoutJson: {},
    stderrDiagnostic: "none",
  } as const;
  expect(await mockAiAdapter(observation).observe(request)).toEqual(
    observation,
  );
});
