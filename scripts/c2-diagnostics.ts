import { jstDate, obj, rows, type Row } from "../packages/shared/src/domain";
import { raceKey } from "../packages/shared/src/github-bridge";
import {
  contentHash,
  gitSha,
  type JobStatus,
} from "../packages/shared/src/c2-job";

const iso = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const safeId = (value: unknown) =>
  typeof value === "string" && /^[\p{L}\p{N}_ .:-]{1,160}$/u.test(value)
    ? value
    : null;
const hash = (value: unknown, format: RegExp) =>
  typeof value === "string" && format.test(value) ? value : null;

type Receipt = { path: string; source_sha: string; at: string };
type Race = {
  key: string;
  reference: Receipt | null;
  input_issue: string | null;
  pack_hashes: string[];
  morning: (Receipt & { prediction_id: string | null }) | null;
  core_locked: (Receipt & { prediction_id: string }) | null;
  official_result: (Receipt & { result_id: string }) | null;
  failure: string | null;
  validating: boolean;
  blocked: boolean;
};

function classifyFailure(value: unknown) {
  const reason = String(value ?? "");
  if (!reason) return null;
  if (/401|403|認証|権限/.test(reason)) return "AUTH_OR_TRANSPORT";
  if (/429|rate.limit/i.test(reason)) return "RATE_LIMIT";
  if (/timeout|タイムアウト/i.test(reason)) return "TIMEOUT";
  if (/発走後/.test(reason)) return "PAST_START_OR_REANALYSIS_REQUIRED";
  return "CHECK_BRIDGE_LOG";
}

function receipt(
  path: string,
  data: Row,
  timeKey: string,
  now: string,
): Receipt | null {
  const sha = hash(data.sha, gitSha);
  const at = iso(data[timeKey]);
  return sha && at && at <= now ? { path, source_sha: sha, at } : null;
}

// Bridge state is the local worker's observation. GitHub files the worker has
// not seen, direct Core writes, and the current remote branch are out of scope.
export function diagnoseC2(
  day: string,
  now: string,
  state: Row | null,
  health: Row | null,
  snapshot: Row | null,
) {
  const observedAt = iso(now);
  if (
    !observedAt ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    iso(day)?.slice(0, 10) !== day
  )
    throw new Error("診断日を YYYY-MM-DD で指定してください");
  if (state && (state.version !== 1 || !state.files || !state.exports))
    throw new Error("Bridge state の形式を確認してください");
  const heartbeat = iso(health?.checked_at);
  const healthStatus =
    heartbeat &&
    heartbeat <= observedAt &&
    ["healthy", "failed"].includes(String(health?.status))
      ? Date.parse(now) - Date.parse(heartbeat) > 120_000
        ? "STALE"
        : health!.status === "failed"
          ? "FAILED"
          : "HEALTHY"
      : "UNKNOWN";
  const races = new Map<string, Race>();
  function race(key: string) {
    const known = races.get(key);
    if (known) return known;
    const discovered: Race = {
      key,
      reference: null,
      input_issue: null,
      pack_hashes: [],
      morning: null,
      core_locked: null,
      official_result: null,
      failure: null,
      validating: false,
      blocked: false,
    };
    races.set(key, discovered);
    return discovered;
  }
  const records = (value: unknown, prefix: string, pattern: RegExp) =>
    Object.entries(obj(value ?? {}))
      .flatMap(([path, data]) => {
        if (!path.startsWith(`${prefix}/${day}/`)) return [];
        const match = pattern.exec(path.split("/").at(-1) ?? "");
        return match && path.split("/").length === 3
          ? [{ path, match, data }]
          : [];
      })
      .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  const referenceIssues = [];
  const evidence: Receipt[] = [];
  for (const { path, data: raw } of records(
    state?.reference_files,
    "daily",
    /^morning-reference-v[1-9]\d*\.json$/,
  )) {
    const data = obj(raw);
    const seen = receipt(path, data, "checked_at", observedAt);
    if (!seen) continue;
    evidence.push(seen);
    if (data.conflict_sha || data.status !== "complete")
      referenceIssues.push({
        ...seen,
        reason: data.conflict_sha
          ? "SOURCE_CHANGED"
          : (classifyFailure(data.reason) ?? "REFERENCE_PENDING"),
      });
    for (const record of rows(data.races)) {
      const id = safeId(record.race_id);
      const label = safeId(record.race_key_human);
      if (!id && !label) continue;
      // Keep unknown identity separate. Join only when the same source report
      // provides the real Core race_id.
      const item = race(id ? raceKey(id) : `reference:${label}`);
      item.reference = seen;
      item.input_issue = [
        "catalog_only",
        "needs_snapshot",
        "needs_registration",
        "needs_entry_review",
        "past_start",
      ].includes(String(record.status))
        ? String(record.status)
        : null;
      if (data.conflict_sha) item.failure = "SOURCE_CHANGED";
    }
  }
  for (const { match, data } of records(
    state?.exports,
    "packs",
    /^([A-Za-z0-9_-]+)-([a-f0-9]{64})\.json$/,
  )) {
    if (data === match[2]) race(match[1]).pack_hashes.push(match[2]);
  }
  for (const { path, match, data: raw } of records(
    state?.files,
    "predictions",
    /^([A-Za-z0-9_-]+)-morning-v[1-9]\d*\.json$/,
  )) {
    const data = obj(raw);
    const seen = receipt(path, data, "received_at", observedAt);
    if (!seen) continue;
    evidence.push(seen);
    const item = race(match[1]);
    const prediction_id = safeId(data.prediction_id);
    if (hash(data.content_hash, contentHash))
      item.morning = { ...seen, prediction_id };
    if (
      data.status === "success" &&
      prediction_id &&
      hash(data.content_hash, contentHash)
    )
      item.core_locked = { ...seen, prediction_id };
    item.validating =
      data.status === "waiting" && data.pipeline != null && !data.conflict_sha;
    item.blocked = data.status === "failed";
    if (data.status !== "success" || data.conflict_sha)
      item.failure = data.conflict_sha
        ? "SOURCE_CHANGED"
        : classifyFailure(data.reason);
  }
  for (const { path, match, data: raw } of records(
    state?.official_results,
    "results",
    /^([A-Za-z0-9_-]+)-official-v[1-9]\d*\.json$/,
  )) {
    const data = obj(raw);
    const seen = receipt(path, data, "checked_at", observedAt);
    if (!seen) continue;
    evidence.push(seen);
    const item = race(match[1]);
    const result_id = safeId(data.result_id);
    // A later conflicting overwrite retains the original successful result_id.
    if (result_id && (data.status === "complete" || data.conflict_sha))
      item.official_result = { ...seen, result_id };
    if (data.status !== "complete" || data.conflict_sha)
      item.failure = data.conflict_sha
        ? "SOURCE_CHANGED"
        : (classifyFailure(data.reason) ?? item.failure);
  }
  const asOf = iso(snapshot?.generated_at);
  const reviews = new Set<string>();
  const hasSnapshot =
    snapshot?.report_type === "turfLab_daily_state" &&
    snapshot.schema_version === "1" &&
    snapshot.origin === "authenticated_turflab_core_read_only" &&
    Array.isArray(snapshot.included_dates_jst) &&
    snapshot.included_dates_jst.includes(day) &&
    Array.isArray(snapshot.races) &&
    asOf &&
    asOf <= observedAt;
  if (hasSnapshot)
    for (const entry of rows(snapshot.races)) {
      const info = obj(entry.race);
      const id = safeId(info.race_id);
      if (id && info.race_date_jst === day && rows(entry.reviews).length)
        reviews.add(raceKey(id));
    }
  const items = [...races.values()]
    .map((item) => {
      const status: JobStatus = item.official_result
        ? "RESULT_VERIFIED"
        : item.core_locked
          ? "CORE_LOCKED"
          : item.blocked || item.failure === "SOURCE_CHANGED"
            ? "BLOCKED"
            : item.input_issue === "past_start" && !item.morning
              ? "EXPIRED"
              : item.morning &&
                  day === jstDate(now) &&
                  ["FAILED", "STALE"].includes(healthStatus)
                ? "WAITING_LOCAL"
                : item.validating
                  ? "VALIDATING"
                  : item.morning
                    ? "AI_SAVED"
                    : item.pack_hashes.length
                      ? "INPUT_READY"
                      : "DISCOVERED";
      return {
        key: item.key,
        status,
        reference: item.reference,
        input_issue: item.input_issue,
        pack_hashes: item.pack_hashes,
        morning: item.morning,
        core_locked: item.core_locked,
        official_result: item.official_result,
        failure: item.failure,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key, "ja", { numeric: true }));
  const lastEvidence =
    evidence.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  return {
    day_jst: day,
    observed_at: observedAt,
    source: "local_bridge_receipts",
    state_available: state !== null,
    worker: { heartbeat, status: healthStatus },
    last_sync: iso(state?.last_sync),
    next_attempt: iso(state?.next_attempt),
    last_failure: classifyFailure(state?.last_error ?? health?.last_error),
    counts: {
      reference_races: state ? items.filter((r) => r.reference).length : null,
      fixed_input_races: state
        ? items.filter((r) => r.pack_hashes.length).length
        : null,
      ai_saved_races: state ? items.filter((r) => r.morning).length : null,
      core_locked_races: state
        ? items.filter((r) => r.core_locked).length
        : null,
      official_result_races: state
        ? items.filter((r) => r.official_result).length
        : null,
    },
    review_snapshot: hasSnapshot
      ? {
          as_of: asOf,
          reviewed_races: reviews.size,
          race_keys: [...reviews].sort(),
        }
      : null,
    last_evidence: lastEvidence,
    reference_issues: referenceIssues,
    races: items,
  };
}
