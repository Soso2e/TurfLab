import { instant, jstDate, obj, requireCondition, str, type Row } from "../../../packages/shared/src/domain";

// Bounded, authenticated display mirror; not a Core prediction or an input pack.
export function validateReferenceMirror(input: Row, now: string): Row {
  const document = obj(input.document);
  requireCondition(document.schema_version === "1" &&
    document.report_type === "chatgpt_daily_reference" &&
    document.core_importable === false, "日次参考データ形式が不正です");
  const date = str(document, "date_jst");
  const path = str(input, "path");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(date) &&
    path === `daily/${date}/morning-reference-v1.json`,
    "参考レポートの日付/パスが不一致です");
  const sha = str(input, "sha");
  requireCondition(/^[a-f0-9]{40}$/.test(sha), "GitHub Blob SHAが不正です");
  requireCondition(jstDate(str(document, "generated_at")) === date &&
    instant(document.generated_at) <= instant(now),
    "生成日時が不正です");
  requireCondition(JSON.stringify(document).length <= 200000,
    "参考レポートが200KBを超えています");
  requireCondition(Array.isArray(document.races) &&
    document.races.length <= 5, "参考レース数が不正です");
  return {
    path, sha, date_jst: date, received_at: now, core_importable: false,
    document,
  };
}
