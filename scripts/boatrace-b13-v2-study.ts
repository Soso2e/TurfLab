// B13v2（特徴量付き Plackett-Luce）の探索的研究レポート生成スクリプト（読取専用・オフライン再現可能）。
// 使い方: node scripts/run-tool.mjs tsx scripts/boatrace-b13-v2-study.ts <TurfLab-dataのパス> [--out file.json]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeBoatArchives } from "../packages/shared/src/boatrace-research";
import { evaluateB13V2, extractB13V2Features } from "../packages/shared/src/boatrace-b13-v2";
import { topThree } from "../packages/shared/src/boatrace-b13";
import { loadArchiveInputs } from "./boatrace-research-cli";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const dataRoot = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "../TurfLab-data");

const { archives, missingDays } = loadArchiveInputs(dataRoot);
const merged = mergeBoatArchives(archives, missingDays);
const evalReport = evaluateB13V2(merged.races);

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

console.log("=== B13v2 EXPANDING-WINDOW OVERALL COMPARISON ===");
console.log(
  `Missingness: total=${evalReport.missingness.totalRaces}, missingGrades=${evalReport.missingness.missingGrades}, missingEx=${evalReport.missingness.missingExhibition}, preCutoffEx=${evalReport.missingness.preCutoffExhibition}, postCutoffEx=${evalReport.missingness.postCutoffExhibition}`,
);
for (const [id, s] of Object.entries(evalReport.models)) {
  console.log(
    `${id.padEnd(9)} | applied=${String(s.applied).padStart(3)} settled=${String(s.settled).padStart(3)} hits=${String(s.hits).padStart(2)} (${pct(s.hitRate).padStart(5)}) | stake=${String(s.stake).padStart(5)} pay=${String(s.payout).padStart(5)} ref=${String(s.refund).padStart(4)} net=${String(s.net).padStart(6)} ROI=${pct(s.roi).padStart(6)} | LL=${s.logLoss !== null ? s.logLoss.toFixed(4) : "—"}`,
  );
}

console.log("\n=== DAILY BREAKDOWN (B13v2 vs B13v2Pre vs B13 vs FIXED123) ===");
for (const d of evalReport.days) {
  console.log(`\n[${d.date}] train=${d.trainingCount}R`);
  for (const id of ["B13v2", "B13v2Pre", "B13", "FIXED123", "B01", "B02", "B11"] as const) {
    const s = d.models[id];
    console.log(
      `  ${id.padEnd(9)} | settled=${String(s.settled).padStart(3)} hits=${String(s.hits).padStart(2)} (${pct(s.hitRate).padStart(5)}) | ROI=${pct(s.roi).padStart(6)} | LL=${s.logLoss !== null ? s.logLoss.toFixed(4) : "—"}`,
    );
  }
}

console.log("\n=== ESTIMATED COURSE-SPECIFIC & CONTEXTUAL WEIGHTS (EXPLORATORY FULL FIT) ===");
const fit = evalReport.frozenExploratoryModel;
if (fit) {
  console.log(`Training observations: ${fit.trainingCount}`);
  for (const [k, v] of Object.entries(fit.namedWeights)) {
    console.log(`  ${k.padEnd(22)}: ${v >= 0 ? "+" : ""}${v.toFixed(4)}`);
  }
}

console.log("\n=== CASE STUDY: MARUGAME 9R & WAKAMATSU 10R ===");
const cases = [];
for (const d of evalReport.days) {
  for (const row of d.rows) {
    if ((row.venueName === "丸亀" && row.number === 9) || (row.venueName === "若松" && row.number === 10)) {
      const race = merged.races.find((r) => r.id === row.raceId)!;
      const feat = extractB13V2Features(race, { preCutoffExhibitionOnly: false });
      const actual = topThree(race)?.join("-") ?? null;
      const payout = actual ? (race.result?.payouts?.[actual] ?? null) : null;
      const item = {
        raceId: row.raceId,
        venueName: row.venueName,
        number: row.number,
        status: row.status,
        actual,
        payout,
        grades: race.entries.map((e) => e.grade_original),
        innerDesc: feat.innerDesc,
        b1MinusOthers: feat.b1MinusOthers !== null ? Number(feat.b1MinusOthers.toFixed(2)) : null,
        exOrder: feat.exhibitionOrder,
        timeStd: feat.timeStd !== null ? Number(feat.timeStd.toFixed(4)) : null,
        stStd: feat.stStd !== null ? Number(feat.stStd.toFixed(4)) : null,
        timeZ: feat.timeZ.map((z) => (z !== null ? Number(z.toFixed(2)) : null)),
        exF: feat.exhibitionF,
        b13Tickets: row.tickets.B13,
        b13v2Tickets: row.tickets.B13v2,
        b13v2Top5: row.topProbs?.map((p) => `${p.combination}(${(p.probability * 100).toFixed(1)}%)`) ?? null,
      };
      cases.push(item);
      console.log(JSON.stringify(item));
    }
  }
}

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify({ summary: evalReport.models, missingness: evalReport.missingness, frozenExploratoryModel: fit, cases }, null, 2) + "\n",
    "utf8",
  );
}
