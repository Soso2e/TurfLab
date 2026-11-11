import { instant, jstDate, obj, requireCondition, str, type Row } from "../../../packages/shared/src/domain";
import {
  parseReferencePath,
  REFERENCE_REPORT_TYPES,
  referenceProducer,
} from "../../../packages/shared/src/github-bridge";

// Bounded, authenticated display mirror; not a Core prediction or an input pack.
export function validateReferenceMirror(input: Row, now: string): Row {
  const document = obj(input.document);
  requireCondition(document.schema_version === "1" &&
    REFERENCE_REPORT_TYPES.includes(String(document.report_type)) &&
    document.core_importable === false, "日次参考データ形式が不正です");
  const date = str(document, "date_jst");
  const path = str(input, "path");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(date) &&
    parseReferencePath(path)?.date === date,
    "参考レポートの日付/パスが不一致です");
  let producer = "";
  try {
    producer = referenceProducer(path, document);
  } catch (e) {
    requireCondition(false, e instanceof Error ? e.message : "producerが不正です");
  }
  requireCondition(document.model == null ||
    (typeof document.model === "string" && document.model.length <= 100),
    "modelは100文字以内の文字列です");
  const sha = str(input, "sha");
  requireCondition(/^[a-f0-9]{40}$/.test(sha), "GitHub Blob SHAが不正です");
  // Producers may write any explicit offset (e.g. +09:00); compare as UTC.
  const generatedAt = document.generated_at;
  const generated =
    typeof generatedAt === "string" &&
    /T.*(?:Z|[+-]\d\d:\d\d)$/.test(generatedAt) &&
    Number.isFinite(Date.parse(generatedAt))
      ? new Date(generatedAt).toISOString()
      : "";
  requireCondition(generated && jstDate(generated) === date &&
    instant(generated) <= instant(now),
    "生成日時が不正です");
  requireCondition(JSON.stringify(document).length <= 200000,
    "参考レポートが200KBを超えています");
  requireCondition(Array.isArray(document.races) &&
    document.races.length <= 5, "参考レース数が不正です");
  return {
    path, sha, date_jst: date, received_at: now, core_importable: false,
    producer, document,
  };
}
