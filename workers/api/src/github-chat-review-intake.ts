import {
  hash, obj, requireCondition, str, isNameReference, type Row,
} from "../../../packages/shared/src/domain";
import { parseReviewPath } from "../../../packages/shared/src/github-bridge";
import { immutablePut, type Repository } from "../../../packages/shared/src/repository";

// An archived conversation is evidence, not a Core prediction, official result
// or owner bet. Store it in the existing reviews table with nullable prediction
// and result references; these are NEVER manufactured from chat claims.
const normalize = (value: unknown) =>
  typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, "").replace(/競馬場$/u, "")
    : "";
const safeArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
        .slice(0, 30).map((item) => item.slice(0, 1000))
    : [];

export async function importGitHubChatReview(
  repo: Repository, input: Row, now: string,
): Promise<Row> {
  const path = str(input, "path");
  const sha = str(input, "sha");
  const parsed = parseReviewPath(path);
  requireCondition(parsed !== null, "チャットレビューのパスが不正です");
  requireCondition(/^[a-f0-9]{40}$/.test(sha), "GitHub blob SHAが不正です");
  requireCondition(input.date_jst === parsed.date, "レビューの日付が一致しません");
  const document = obj(input.document);
  requireCondition(document.schema_version === "1" && document.core_importable === false,
    "レビューはschema_version=1かつCore非予想である必要があります");
  // Aggregated coverage documents and other producers may be displayed but
  // must not be silently treated as individual race reviews.
  if (document.record_type !== "chatgpt_reference_race_review")
    return { status: "reference_only", reason: "レース単位のチャットレビューではありません" };

  const sourceRace = obj(document.race);
  const raceKey = String(sourceRace.race_key_human ?? sourceRace.key ?? "");
  const key = /^(\d{4}-\d{2}-\d{2})\|([^|]+)\|(\d{1,2})R$/.exec(raceKey);
  const sourceTrack = key?.[2] ?? sourceRace.track;
  const date = key?.[1] ?? parsed.date;
  const raceNo = key ? Number(key[3]) :
    Number(sourceRace.race_no ?? sourceRace.number ?? NaN);
  requireCondition(date === parsed.date &&
    (document.recorded_for_date_jst == null ||
      document.recorded_for_date_jst === date) &&
    normalize(sourceTrack).length > 0 &&
    Number.isInteger(raceNo) && raceNo >= 1 && raceNo <= 12,
    "レースの日付・場名・番号が不正です");

  const [races, courses, tracks] = await Promise.all([
    repo.list("races"), repo.list("course_layouts"), repo.list("tracks"),
  ]);
  const courseById = new Map(courses.map((c) => [c.course_id, c]));
  const trackById = new Map(tracks.map((t) => [t.track_id, t]));
  const candidates = races.filter((race) => {
    if (race.race_date_jst !== date || race.race_number !== raceNo) return false;
    const course = courseById.get(race.course_id);
    const track = course ? trackById.get(course.track_id) : undefined;
    if (normalize(track?.name) !== normalize(sourceTrack)) return false;
    if (sourceRace.distance_m != null && Number(sourceRace.distance_m) !== course?.distance_m) return false;
    if (sourceRace.surface != null && sourceRace.surface !== course?.surface) return false;
    return true;
  });
  // Prefer the strict identity if a name-only mirror also exists, but never
  // guess between multiple strict races or among several name-only records.
  const strict = candidates.filter((race) => !isNameReference(race));
  const matched = strict.length === 1 ? strict[0] :
    strict.length > 1 ? undefined :
    candidates.length === 1 ? candidates[0] : undefined;
  if (!matched) {
    return {
      status: "unmatched",
      reason: candidates.length > 1 ? "複数のCoreレース候補があります" : "対応するCoreレースがありません",
      race_key_human: raceKey || `${date}|${String(sourceTrack)}|${raceNo}R`,
    };
  }

  const known = (await repo.list("reviews")).filter((row) =>
    row.source === "github_chat_reference" &&
    obj(row.evidence_json ?? {}).git_path === path);
  requireCondition(known.every((row) =>
    obj(row.evidence_json ?? {}).git_blob_sha === sha),
    "同じレビューのGitHub内容が変更されました。別版で保存してください", 409);
  if (known.length) return {
    status: "linked", race_id: matched.race_id,
    review_id: known[0]!.review_id, already_saved: true,
  };

  const assessment = obj(document.retrospective_review ?? {});
  const rationale = safeArray(assessment.lessons);
  const factual = safeArray(assessment.new_facts ?? assessment.new_observations);
  const limitations = safeArray(document.limitations);
  const next = safeArray(assessment.next_actions);
  const id = `github-chat:${await hash({ path, sha })}`;
  const record: Row = {
    schema_version: "0.2",
    review_id: id,
    race_id: str(matched, "race_id"),
    prediction_id: null,
    result_id: null,
    model_version_id: null,
    source: "github_chat_reference",
    created_at: now,
    reviewed_at: now,
    observations_json: factual,
    hypotheses_json: rationale,
    unknowns_json: limitations,
    validation_plan_json: next,
    evidence_json: {
      git_path: path,
      git_blob_sha: sha,
      race_key_human: raceKey || `${date}|${String(sourceTrack)}|${raceNo}R`,
      source_generated_at: document.generated_at ?? null,
      pre_race_classification: obj(document.pre_race_evidence ?? document.chat_prediction ?? {}).classification ?? null,
      official_result_verified: document.official_result_verified === true,
      official_payout_verified: document.official_payout_verified === true,
      // Full immutable document remains in TurfLab-data; keep the source
      // reference here without claiming official Core settlement.
      core_prediction_imported: false,
      owner_bet_imported: false,
      official_result_imported: false,
      model_training_eligible: false,
    },
  };
  await immutablePut(repo, "reviews", record);
  return { status: "linked", race_id: matched.race_id, review_id: id };
}
