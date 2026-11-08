import { instant, jstDate } from "./domain";

export type JobStatus =
  | "DISCOVERED"
  | "INPUT_READY"
  | "WAITING_AI"
  | "AI_SAVED"
  | "VALIDATING"
  | "CORE_LOCKED"
  | "WAITING_RESULT"
  | "RESULT_VERIFIED"
  | "REVIEWED"
  | "FAILED_RETRYABLE"
  | "BLOCKED"
  | "WAITING_LOCAL"
  | "EXPIRED";

export const gitSha = /^[a-f0-9]{40}$/;
export const contentHash = /^[a-f0-9]{64}$/;

type FixedPack = { hash: string; snapshotId: string; cutoff: string };
type GitHubReceipt = {
  branch: string;
  path: string;
  commit: string;
  sourceSha: string;
  contentHash: string;
  packHash: string;
  savedAt: string;
};
type Lease = {
  worker: string;
  runId: string;
  fence: number;
  claimedAt: string;
  heartbeat: string;
  expires: number;
};
type Failure =
  | "AUTH"
  | "INVALID"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "OFFLINE"
  | "PAST_START"
  | "AI_UNCONFIRMED"
  | "ATTEMPTS_EXHAUSTED";
export type C2Job = {
  key: string;
  day: string;
  raceKey: string;
  deadline: string;
  status: JobStatus;
  updatedAt: string;
  revision: number;
  attempt: number;
  lease?: Lease;
  pack?: FixedPack;
  aiAttemptAt?: string;
  ai?: GitHubReceipt;
  lockedReceipt?: string;
  resultReceipt?: string;
  reviewReceipt?: string;
  failure?: Failure;
  retryAt?: number;
};

export function createMorningJob(
  day: string,
  raceKey: string,
  deadline: string,
  at: string,
): C2Job {
  if (
    !/^[A-Za-z0-9_-]+$/.test(raceKey) ||
    instant(at) > instant(deadline) ||
    day !== jstDate(deadline)
  )
    throw new Error("対象日・レースキー・発走期限が不正です");
  return {
    key: `${day}/${raceKey}/morning`,
    day,
    raceKey,
    deadline,
    status: "DISCOVERED",
    updatedAt: at,
    revision: 0,
    attempt: 0,
  };
}

type Fenced = { worker: string; runId: string; fence: number };
type Event = { at: string; revision: number } & (
  | { type: "pack"; pack: FixedPack }
  | { type: "claim"; worker: string; runId: string; leaseMs: number }
  | ({ type: "heartbeat" } & Fenced)
  | ({ type: "ai-saved"; receipt: GitHubReceipt } & Fenced)
  | { type: "recover-ai"; receipt: GitHubReceipt }
  | { type: "confirm-ai-absent"; jitterMs: number }
  | ({
      type: "core-locked";
      receipt: string;
      sourceSha: string;
      packHash: string;
      lockedAt: string;
    } & Fenced)
  | ({
      type: "failed";
      code: Exclude<Failure, "AI_UNCONFIRMED" | "ATTEMPTS_EXHAUSTED">;
      jitterMs: number;
      confirmedNoAiSave?: boolean;
    } & Fenced)
  | { type: "local-offline" | "tick" | "wait-result" }
  | { type: "result" | "review"; receipt: string }
);

const maxAttempts = 5;
const maxLeaseMs = 120_000;
const validJitter = (ms: number) =>
  Number.isInteger(ms) && ms >= 0 && ms <= 5_000;

// The caller persists accepted transitions with a compare-and-swap on revision.
// Lease checks use authoritative receipt time supplied by that caller.
export function advanceJob(job: C2Job, event: Event): C2Job {
  const now = instant(event.at);
  const deadline = instant(job.deadline);
  if (event.revision !== job.revision || now < instant(job.updatedAt))
    return job;
  const update = (patch: Partial<C2Job>) => ({
    ...job,
    ...patch,
    revision: job.revision + 1,
    updatedAt: event.at,
  });
  const lease = job.lease;
  const retryAt = (jitterMs: number) =>
    now + 15_000 * 2 ** (job.attempt - 1) + jitterMs;
  const ownsLease =
    "fence" in event &&
    lease &&
    lease.expires > now &&
    lease.fence === event.fence &&
    lease.worker === event.worker &&
    lease.runId === event.runId;
  if (event.type === "tick") {
    if (
      !job.ai &&
      now >= deadline &&
      !lease &&
      ["DISCOVERED", "INPUT_READY", "FAILED_RETRYABLE"].includes(job.status)
    )
      return update({ status: "EXPIRED", lease: undefined });
    if (lease && lease.expires <= now) {
      if (!job.ai)
        return update({
          status: "BLOCKED",
          failure: "AI_UNCONFIRMED",
          lease: undefined,
        });
      return update({
        status: "WAITING_LOCAL",
        failure: "TIMEOUT",
        lease: undefined,
      });
    }
    return job;
  }
  switch (event.type) {
    case "pack":
      if (
        job.status !== "DISCOVERED" ||
        now >= deadline ||
        !contentHash.test(event.pack.hash) ||
        !event.pack.snapshotId ||
        instant(event.pack.cutoff) > now
      )
        return job;
      return update({ status: "INPUT_READY", pack: { ...event.pack } });
    case "claim": {
      if (
        ![
          "INPUT_READY",
          "AI_SAVED",
          "WAITING_LOCAL",
          "FAILED_RETRYABLE",
        ].includes(job.status) ||
        lease ||
        now < (job.retryAt ?? 0) ||
        (!job.ai && now >= deadline) ||
        !event.worker ||
        !event.runId ||
        !Number.isInteger(event.leaseMs) ||
        event.leaseMs <= 0 ||
        event.leaseMs > maxLeaseMs
      )
        return job;
      if (job.attempt >= maxAttempts)
        return update({ status: "BLOCKED", failure: "ATTEMPTS_EXHAUSTED" });
      const attempt = job.attempt + 1;
      return update({
        status: job.ai ? "VALIDATING" : "WAITING_AI",
        attempt,
        failure: undefined,
        retryAt: undefined,
        aiAttemptAt: job.ai ? job.aiAttemptAt : event.at,
        lease: {
          worker: event.worker,
          runId: event.runId,
          fence: job.revision + 1,
          claimedAt: event.at,
          heartbeat: event.at,
          expires: now + event.leaseMs,
        },
      });
    }
    case "heartbeat":
      if (!ownsLease || (!job.ai && now >= deadline)) return job;
      return update({
        lease: {
          ...lease,
          heartbeat: event.at,
          expires: now + lease.expires - instant(lease.heartbeat),
        },
      });
    case "ai-saved":
    case "recover-ai": {
      const authorized =
        event.type === "ai-saved"
          ? ownsLease && job.status === "WAITING_AI"
          : job.status === "BLOCKED" && job.failure === "AI_UNCONFIRMED";
      const receipt = event.receipt;
      const prefix = `predictions/${job.day}/${job.raceKey}-morning-v`;
      const saved = instant(receipt.savedAt);
      if (
        !authorized ||
        !job.aiAttemptAt ||
        saved > now ||
        saved >= deadline ||
        saved < instant(job.aiAttemptAt) ||
        !job.pack ||
        saved < instant(job.pack.cutoff) ||
        receipt.packHash !== job.pack?.hash ||
        !receipt.branch ||
        !receipt.path.startsWith(prefix) ||
        !/^[1-9]\d*\.json$/.test(receipt.path.slice(prefix.length)) ||
        !gitSha.test(receipt.commit) ||
        !gitSha.test(receipt.sourceSha) ||
        !contentHash.test(receipt.contentHash)
      )
        return job;
      return update({
        status: "AI_SAVED",
        ai: { ...receipt },
        lease: undefined,
        attempt: 0,
        failure: undefined,
      });
    }
    case "confirm-ai-absent":
      // Trusted reconciliation has checked GitHub and quiesced the old writer.
      if (
        job.status !== "BLOCKED" ||
        job.failure !== "AI_UNCONFIRMED" ||
        !validJitter(event.jitterMs)
      )
        return job;
      if (now >= deadline)
        return update({ status: "EXPIRED", failure: "PAST_START" });
      return update({
        status: "FAILED_RETRYABLE",
        failure: undefined,
        retryAt: retryAt(event.jitterMs),
      });
    case "core-locked": {
      const lockedAt = instant(event.lockedAt);
      if (
        !ownsLease ||
        job.status !== "VALIDATING" ||
        !event.receipt ||
        !job.ai ||
        lockedAt < instant(job.ai.savedAt) ||
        lockedAt >= deadline ||
        lockedAt > now ||
        event.sourceSha !== job.ai.sourceSha ||
        event.packHash !== job.pack?.hash
      )
        return job;
      return update({
        status: "CORE_LOCKED",
        lockedReceipt: event.receipt,
        lease: undefined,
      });
    }
    case "failed": {
      if (!ownsLease) return job;
      const failure = event.code;
      if (failure === "PAST_START" && job.ai)
        return update({ status: "EXPIRED", failure, lease: undefined });
      if (failure === "AUTH" || failure === "INVALID" || failure === "CONFLICT")
        return update({ status: "BLOCKED", failure, lease: undefined });
      if (!job.ai && !event.confirmedNoAiSave)
        return update({
          status: "BLOCKED",
          failure: "AI_UNCONFIRMED",
          lease: undefined,
        });
      if (!validJitter(event.jitterMs)) return job;
      return update({
        status:
          failure === "OFFLINE" && job.ai
            ? "WAITING_LOCAL"
            : "FAILED_RETRYABLE",
        failure,
        lease: undefined,
        retryAt: retryAt(event.jitterMs),
      });
    }
    case "local-offline":
      if (job.status !== "AI_SAVED") return job;
      return update({ status: "WAITING_LOCAL", failure: "OFFLINE" });
    case "wait-result":
      return job.status === "CORE_LOCKED"
        ? update({ status: "WAITING_RESULT" })
        : job;
    case "result":
      return (job.status === "CORE_LOCKED" ||
        job.status === "WAITING_RESULT") &&
        event.receipt
        ? update({ status: "RESULT_VERIFIED", resultReceipt: event.receipt })
        : job;
    case "review":
      return job.status === "RESULT_VERIFIED" && event.receipt
        ? update({ status: "REVIEWED", reviewReceipt: event.receipt })
        : job;
  }
}
