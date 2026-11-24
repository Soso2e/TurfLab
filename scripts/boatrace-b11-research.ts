// 研究用: TurfLab-data の boatrace 日別アーカイブ（追記のみ・読取専用）からB11×級別σを再構成して集計する。
// 使い方: tsx scripts/boatrace-b11-research.ts <TurfLab-dataのパス> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out file.json]
// 出力はこの再構成（reconstructed）のみ。発走前凍結(forward)ではない。原本は変更しない。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoatRecord } from "../packages/shared/src/boatrace";
import { reconstructB11, summarizeB11, type B11ResearchItem } from "../packages/shared/src/boatrace-b11";

type Archive = { date: string; records: BoatRecord[]; revisions: { raceId: string; result: NonNullable<BoatRecord["result"]> }[] };

export function loadArchives(root: string, from = "0000", to = "9999") {
  const base = join(root, "boatrace");
  const races = new Map<string, BoatRecord>();
  const sources: { file: string; records: number }[] = [];
  const duplicates: Record<string, number> = {};
  const missingDays: string[] = [];
  for (const day of readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= to).sort()) {
    const files = readdirSync(join(base, day)).filter((f) => /^archive-.*\.json$/.test(f)).sort();
    if (!files.length) missingDays.push(day);
    for (const file of files) {
      const archive = JSON.parse(readFileSync(join(base, day, file), "utf8")) as Archive;
      sources.push({ file: `${day}/${file}`, records: archive.records.length });
      const latest = new Map<string, NonNullable<BoatRecord["result"]>>();
      for (const rev of archive.revisions ?? []) {
        const prev = latest.get(rev.raceId);
        if (!prev || rev.result.evidence.fetchedAt >= prev.evidence.fetchedAt) latest.set(rev.raceId, rev.result);
      }
      for (const record of archive.records) {
        const result = latest.get(record.id) ?? record.result;
        const prev = races.get(record.id);
        if (prev) duplicates[record.id] = 1;
        // レースIDで重複除去。結果は取得時刻が新しいものを優先（訂正反映）、未取得の後続で消さない。
        const best = result && (!prev?.result || result.evidence.fetchedAt >= prev.result.evidence.fetchedAt)
          ? result : prev?.result;
        races.set(record.id, { ...record, result: best });
      }
    }
  }
  return { races: [...races.values()], sources, duplicateRaces: Object.keys(duplicates).length, missingDays };
}

export function runResearch(root: string, from?: string, to?: string) {
  const { races, sources, duplicateRaces, missingDays } = loadArchives(root, from, to);
  const items: B11ResearchItem[] = races.map((race) => ({
    record: reconstructB11(race), venueName: race.venueName, cutoff: race.freeze?.cutoff ?? race.cutoff, result: race.result,
  }));
  const missingGrades = items.filter((i) => i.record.evaluation.features.sigma === null).map((i) => i.record.raceId);
  const noResult = items.filter((i) => !i.result).length;
  const perDay: Record<string, number> = {};
  for (const item of items) perDay[item.record.date] = (perDay[item.record.date] ?? 0) + 1;
  return {
    kind: "reconstructed" as const, from, to, sources, duplicateRaces, missingDays,
    races: items.length, perDay, missingGradeCount: missingGrades.length, missingGrades, noResult,
    summary: summarizeB11(items, "reconstructed"),
  };
}

if (process.argv[1]?.endsWith("boatrace-b11-research.ts")) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!root) { console.error("使い方: boatrace-b11-research.ts <TurfLab-data> [--from] [--to] [--out]"); process.exit(2); }
  const report = runResearch(root, opt("--from"), opt("--to"));
  const pct = (v: number | null) => v === null ? "—" : (v * 100).toFixed(1) + "%";
  console.log(`再構成(reconstructed) ${report.races}R / 欠損級別 ${report.missingGradeCount}R / 結果なし ${report.noResult}R / 重複ID ${report.duplicateRaces}`);
  console.log("日別対象:", JSON.stringify(report.perDay), "アーカイブ無し:", report.missingDays.join(",") || "なし");
  for (const { key, stats: s } of report.summary.byCap)
    console.log(`${key.padEnd(8)} 対象${s.targets} 適用${s.applied} 見送り${s.modelSkip} 閾値外${s.outside} 未判定${s.unjudged} | 精算${s.settled} 未確定${s.pending} 除外${s.excluded} | 的中${s.hits} ${pct(s.hitRate)} 投入${s.stake} 払戻${s.payout} 返還${s.refund} 損益${s.net} 回収${pct(s.roi)} 最大連敗${s.maxLosingStreak}`);
  for (const { sigmaClass, stats: s } of report.summary.byClass)
    console.log(`class:${sigmaClass.padEnd(6)} 対象${s.targets} 適用${s.applied} 精算${s.settled} 的中${s.hits} 投入${s.stake} 払戻${s.payout} 返還${s.refund} 回収${pct(s.roi)}`);
  const out = opt("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 1), "utf8");
}
