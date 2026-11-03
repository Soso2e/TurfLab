import {
  instant, jstDate, num, obj, requireCondition, rows, str, type Row,
} from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";
import { inputPack } from "./race-wizard";

const label = (s: unknown) => typeof s === "string" ? s.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
const knownOfficialHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password &&
      ["www.keiba.go.jp", "keiba.go.jp", "www.jra.go.jp", "jra.go.jp"].includes(u.hostname);
  } catch { return false; }
};
type Status = "needs_registration" | "needs_entry_review" | "needs_snapshot" | "pack_ready" | "past_start";
const finding = (key: string, status: Status, issues: string[], extra: Row = {}): Row => ({
  race_key_human: key, status, issues, ...extra,
});

/**
 * Never creates a Core identity from a name or an AI assertion.
 * A reference-only ChatGPT JSON may be matched against *already registered*
 * race/horse/jockey/entry identities; verified locked snapshot stays authoritative.
 * This is the preflight phase of automatic pack export, not automatic registration.
 */
export async function reconcileReference(repo: Repository, input: Row, now: string): Promise<Row> {
  const document = obj(input.document);
  requireCondition(document.schema_version === "1" && document.report_type === "chatgpt_daily_reference",
    "ChatGPT日次参考JSONの形式が不正です");
  const day = str(document, "date_jst");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(day), "開催日形式が不正です");
  requireCondition(
    input.path === `daily/${day}/morning-reference-v1.json`,
    "日次参考JSONの保存パス/日付が不一致です",
  );
  requireCondition(jstDate(str(document, "generated_at")) === day &&
    instant(document.generated_at) <= instant(now), "参考JSON作成時刻が不正です");
  requireCondition(document.core_importable === false,
    "参考JSONをCore確定済みと偽装することはできません");
  const reported = rows(document.races);
  requireCondition(reported.length <= 5, "分析対象は最大5Rです");
  const [races, tracks, courses, entries, horses, jockeys, snapshots] = await Promise.all([
    repo.list("races"), repo.list("tracks"), repo.list("course_layouts"),
    repo.list("race_entries"), repo.list("horses"), repo.list("jockeys"),
    repo.list("race_snapshots"),
  ]);
  const used = new Set<string>();
  const reports: Row[] = [];
  for (const reference of reported) {
    const key = str(reference, "race_key_human");
    const expected = `${day}|${label(reference.track)}|${num(reference, "race_number")}`;
    requireCondition(label(key) === expected && !used.has(key), "重複または不一致のレースキーです");
    used.add(key);
    const official = str(reference, "official_entry_source");
    const start = str(reference, "scheduled_start_at_jst");
    requireCondition(jstDate(start) === day && Number.isFinite(instant(start)),
      "開催日/発走日時が不一致です");
    const given = rows(reference.horses);
    requireCondition(given.length > 0 && given.length <= 18 &&
      reference.entry_count_observed === given.length, "全出走馬の件数が不正です");
    const byNumber = new Map<number, Row>();
    for (const h of given) {
      const number = num(h, "horse_number");
      requireCondition(Number.isInteger(number) && number > 0 && number <= 18 &&
        !byNumber.has(number), "馬番の重複または不正値");
      requireCondition(label(h.horse_name).length > 0 && label(h.jockey).length > 0,
        "馬名/騎手名の欠落");
      byNumber.set(number, h);
    }
    const issues: string[] = [];
    if (!knownOfficialHost(official)) issues.push("公式出馬表のHTTPS URL未確認");
    if (reference.withdrawals_verified_as_of_generation !== true)
      issues.push("最新の出走取消・騎手変更の照合未完了");
    if (instant(start) <= instant(now))
      issues.push("発走後：新規Morningを作成できません");
    if (reference.evaluations_complete !== true)
      issues.push("6評価が未完了：正式予想は別途必要");
    if (document.source_checked_at == null || instant(document.source_checked_at) > instant(document.generated_at))
      issues.push("公式出典の確認時刻が欠落または不正");
    const matches = races.filter((race) =>
      race.race_date_jst === day && race.race_number === reference.race_number &&
      courses.some((c) => c.course_id === race.course_id &&
        tracks.some((t) => t.track_id === c.track_id && label(t.name) === label(reference.track))));
    if (matches.length !== 1) {
      reports.push(finding(key, instant(start) <= instant(now) ? "past_start" : "needs_registration",
        [...issues, matches.length === 0
          ? "Core未登録。公式の馬・騎手・コース外部ID、枠、出典時点を確認してウィザードへ"
          : "同日・同場・同番号のCoreレースが複数あり確認が必要"],
        { observed_entries: given.length, matched_entries: 0 }));
      continue;
    }
    const race = matches[0];
    const current = entries.filter((e) => e.race_id === race.race_id);
    const matched: Row[] = [];
    for (const e of current) {
      const h = byNumber.get(Number(e.horse_number));
      const horse = horses.find((x) => x.horse_id === e.horse_id);
      const jockey = jockeys.find((x) => x.jockey_id === e.jockey_id);
      if (!h || label(h.horse_name) !== label(horse?.horse_name) ||
        label(h.jockey) !== label(jockey?.jockey_name) ||
        (typeof h.weight_kg === "number" && h.weight_kg !== e.carried_weight_kg) ||
        (typeof h.draw_number === "number" && h.draw_number !== e.draw_number)) {
        issues.push(`馬番${e.horse_number}: Core登録との不一致・欠落`);
        continue;
      }
      matched.push({ horse_number: e.horse_number, entry_id: e.entry_id });
    }
    if (current.length !== byNumber.size || matched.length !== byNumber.size)
      issues.push("全出走馬を既存の安定IDで照合できません");
    if (instant(start) !== instant(race.scheduled_start_at))
      issues.push("発走時刻が既存登録と不一致です");
    // Source evidence is distinct from a name match. The owner previously
    // confirmed each Core entry; a new report cannot silently supersede it.
    if (!knownOfficialHost(official) || race.source_url !== official)
      issues.push("参考JSONの公式出典と登録済み出典が一致しません");
    if (instant(start) <= instant(now)) {
      reports.push(finding(key, "past_start", issues, { race_id: race.race_id, matched_entries: matched.length }));
      continue;
    }
    if (current.length !== byNumber.size || matched.length !== byNumber.size ||
      instant(start) !== instant(race.scheduled_start_at) ||
      !knownOfficialHost(official) || race.source_url !== official ||
      reference.withdrawals_verified_as_of_generation !== true ||
      document.source_checked_at == null || instant(document.source_checked_at) > instant(document.generated_at)) {
      reports.push(finding(key, "needs_entry_review", issues, {
        race_id: race.race_id, observed_entries: given.length, matched_entries: matched.length,
      }));
      continue;
    }
    const available = snapshots.filter((s) => s.race_id === race.race_id)
      .sort((a, b) => instant(b.captured_at) - instant(a.captured_at));
    let ready: Row | null = null;
    for (const s of available) {
      try {
        const pack = await inputPack(repo, str(s, "snapshot_id"), now);
        ready = { snapshot_id: pack.snapshot_id, pack_hash: pack.pack_hash };
        break;
      } catch { /* Different/expired snapshot; try another, never alter saved data. */ }
    }
    if (!ready) issues.push("検証可能な発走前の最新snapshot/packがありません");
    reports.push(finding(key, ready ? "pack_ready" : "needs_snapshot", issues, {
      race_id: race.race_id, matched_entries: matched.length, ...(ready ?? {}),
    }));
  }
  return {
    report_date_jst: day,
    input_path: input.path,
    checked_at: now,
    races: reports,
    counts: {
      total: reports.length,
      ready: reports.filter((r) => r.status === "pack_ready").length,
      needs_registration: reports.filter((r) => r.status === "needs_registration").length,
      needs_review: reports.filter((r) => r.status === "needs_entry_review" || r.status === "needs_snapshot").length,
      past_start: reports.filter((r) => r.status === "past_start").length,
    },
    core_mutated: false,
  };
}
