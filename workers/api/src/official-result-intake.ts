import {
  instant, num, obj, requireCondition, rows, str, type Row,
} from "../../../packages/shared/src/domain";
import { get, type Repository } from "../../../packages/shared/src/repository";
import { raceKey } from "../../../packages/shared/src/github-bridge";
import { saveResult, settle } from "./betting";

// The private GitHub file is user-controlled input, not independent proof of the
// linked official page. Strict structural validation is followed by Core's
// complete-entry, payout and revision checks before atomic durable commit.
export async function importOfficialResult(
  repo: Repository, input: Row, now: string,
): Promise<Row> {
  const doc = obj(input.document);
  requireCondition(doc.bridge_version === "1" &&
    doc.source_verification === "official_page_checked" &&
    doc.payouts_complete === true,
    "結果は公式公表/全払戻を照合した完全な入力が必要です");
  const result = obj(doc.result);
  const race = await get(repo, "races", str(result, "race_id"));
  const date = str(race, "race_date_jst");
  requireCondition(doc.race_date_jst === date &&
    input.path === `results/${date}/${raceKey(str(race, "race_id"))}-official-v${num(result, "revision")}.json`,
    "公式結果のレース参照・日付・版・保存パスが不一致です");
  requireCondition(
    ["official", "cancelled"].includes(str(result, "official_status")),
    "確定していない結果は自動登録しません");
  requireCondition(instant(now) >= instant(race.scheduled_start_at),
    "発走前の結果を登録できません");
  const sourceUrl = str(result, "source_url");
  const checked = str(doc, "source_checked_at");
  const url = new URL(sourceUrl);
  requireCondition(url.protocol === "https:" && !url.username && !url.password,
    "公式結果には正しいHTTPS URLが必要です");
  const hosts = race.jurisdiction === "JRA"
    ? ["jra.go.jp", "www.jra.go.jp"]
    : ["keiba.go.jp", "www.keiba.go.jp"];
  requireCondition(hosts.includes(url.hostname),
    "公式結果URLと競馬管轄が一致しません");
  requireCondition(instant(checked) <= instant(now) &&
    instant(checked) >= instant(result.published_at),
    "結果公表前または未来の取得時刻は使えません");
  requireCondition(result.retrieved_at === checked && result.source_url === sourceUrl,
    "結果出典と取得時刻が不一致です");
  requireCondition(Array.isArray(doc.payouts) &&
    (doc.payouts.length > 0 || result.official_status === "cancelled"),
    "公式の全払戻データを確認してください");
  // Core verifies every registered entry's finish status, all ties, ticket
  // selections, full payout flag, sequential result revisions and idempotency.
  const saved = await saveResult(repo, {
    result, payouts: rows(doc.payouts), payouts_complete: true,
  }, now);
  const entries = await settle(repo, str(saved, "result_id"), now);
  return {
    status: "complete",
    race_id: race.race_id,
    result_id: saved.result_id,
    revision: saved.revision,
    virtual_bets_settled: entries.length,
    source_url: sourceUrl,
    source_checked_at: checked,
    source_independently_fetched_by_core: false,
    note: "GitHub内の公式確認記録とCoreの完全性検証で保存。出典ページの本文はCoreから独立取得していません。",
  };
}
