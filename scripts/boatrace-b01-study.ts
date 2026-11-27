// B01モデル（三連単 1-2-3 / 1-3-2 各100円、1R=200円）の収益性・再現性徹底検証スクリプト（読取専用・オフライン再現可能）。
// 使い方:
//   node scripts/run-tool.mjs tsx scripts/boatrace-b01-study.ts <TurfLab-data> [--out-dir <dir>] [--split-date=2026-11-13] [--sqlite <sqlitePath>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOATS, type BoatRecord, type BoatResult } from "../packages/shared/src/boatrace";
import { mergeBoatArchives } from "../packages/shared/src/boatrace-research";
import {
  B01_STUDY_VERSION,
  compareHitVsMissFeatures,
  compareModelsSameRaces,
  computeBlockAnalysis,
  computePerformanceMetrics,
  evaluateB01Race,
  evaluateHypothesesSplit,
  groupPerformance,
  outcomeToSimpleRow,
  type B01RaceInput,
  type B01RaceOutcome,
  type GroupPerformanceRow,
} from "../packages/shared/src/boatrace-b01-study";
import type { BackfillDayFile } from "./boatrace-backfill";
import { loadArchiveInputs } from "./boatrace-research-cli";

function loadBackfill(dataRoot: string): BackfillDayFile[] {
  const dir = join(resolve(dataRoot), "boatrace-research", "backfill");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BackfillDayFile);
}

function loadSqliteRaces(sqlitePath: string): BoatRecord[] {
  if (!existsSync(sqlitePath)) return [];
  const py = [
    "import sqlite3, json, sys",
    "con = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)",
    "rows = con.execute('SELECT body FROM boat_races').fetchall()",
    "revs = con.execute('SELECT id, body FROM boat_result_revisions').fetchall()",
    "con.close()",
    "print(json.dumps({'races': [json.loads(r[0]) for r in rows], 'revs': [{'raceId': r[0], 'result': json.loads(r[1])} for r in revs]}))",
  ].join("\n");
  const stdout = execFileSync("python", ["-c", py, sqlitePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { races: BoatRecord[]; revs: { raceId: string; result: BoatResult }[] };
  const merged = mergeBoatArchives([
    { file: "sqlite", date: "all", records: parsed.races, revisions: parsed.revs },
  ]);
  return merged.races;
}

function mergeSources(
  backfillDays: BackfillDayFile[],
  archiveRaces: BoatRecord[],
  sqliteRaces: BoatRecord[],
) {
  const byId = new Map<string, B01RaceInput>();
  const audit = {
    backfillRaces: 0,
    archiveRaces: archiveRaces.length,
    sqliteRaces: sqliteRaces.length,
    archiveOnlyRaces: 0,
    sqliteOnlyRaces: 0,
    resultMismatches: [] as { raceId: string; backfillTop3: string | null; otherTop3: string | null; source: string }[],
  };

  // 1. Backfill (base with full racelist & beforeinfo)
  for (const day of backfillDays) {
    for (const r of day.races) {
      audit.backfillRaces++;
      byId.set(r.id, {
        id: r.id,
        date: r.date,
        venue: r.venue,
        venueName: r.venueName,
        number: r.number,
        cutoff: r.cutoff,
        entries: r.racelist.map((e) => ({
          boat: e.boat,
          name: e.name,
          grade: e.grade,
          nationalWinRate: e.nationalWinRate,
          localWinRate: e.localWinRate,
          motor2Rate: e.motor2Rate,
          avgSt: e.avgSt,
        })),
        exhibition: r.beforeinfo
          ? {
              entries: r.beforeinfo.entries.map((e) => ({
                boat: e.boat,
                course: e.course,
                st: e.st,
                flying: e.flying,
              })),
              times: r.beforeinfo.times,
              fetchedAt: null,
              preCutoff: null,
            }
          : null,
        result: r.result,
        sources: ["backfill"],
      });
    }
  }

  const top3Key = (res: BoatResult | null | undefined) => {
    if (!res || res.status !== "official") return null;
    const ranks = ["1", "2", "3"].map((p) => res.finishes.find((f) => f.position === p)?.boat);
    return ranks.every((b) => typeof b === "number") ? ranks.join("-") : null;
  };

  const attachBoatRecords = (list: BoatRecord[], sourceLabel: "archive" | "sqlite") => {
    for (const rec of list) {
      const existing = byId.get(rec.id);
      if (existing) {
        if (!existing.sources.includes(sourceLabel)) existing.sources.push(sourceLabel);
        if (!existing.boatRecord || sourceLabel === "archive") {
          existing.boatRecord = rec;
        }
        if (!existing.result && rec.result) {
          existing.result = rec.result;
        } else if (existing.result && rec.result) {
          const a = top3Key(existing.result);
          const b = top3Key(rec.result);
          if (a && b && a !== b) {
            audit.resultMismatches.push({ raceId: rec.id, backfillTop3: a, otherTop3: b, source: sourceLabel });
          }
        }
        if (existing.exhibition && rec.exhibition?.evidence?.fetchedAt) {
          existing.exhibition.fetchedAt = rec.exhibition.evidence.fetchedAt;
          existing.exhibition.preCutoff =
            Boolean(existing.cutoff) && Date.parse(rec.exhibition.evidence.fetchedAt) < Date.parse(existing.cutoff!);
        }
      } else {
        if (sourceLabel === "archive") audit.archiveOnlyRaces++;
        else audit.sqliteOnlyRaces++;
        byId.set(rec.id, {
          id: rec.id,
          date: rec.date,
          venue: rec.venue,
          venueName: rec.venueName,
          number: rec.number,
          cutoff: rec.freeze?.cutoff ?? rec.cutoff,
          entries: BOATS.map((b) => {
            const e = rec.entries.find((x) => x.boat === b);
            return {
              boat: b,
              name: e?.name ?? "",
              grade: e?.grade_original ?? null,
              nationalWinRate: null,
              localWinRate: null,
              motor2Rate: null,
              avgSt: null,
            };
          }),
          exhibition: rec.exhibition
            ? {
                entries: rec.exhibition.entries.map((e) => ({
                  boat: e.boat,
                  course: e.course,
                  st: e.st,
                  flying: e.flying,
                })),
                times: rec.exhibition.times ?? {},
                fetchedAt: rec.exhibition.evidence?.fetchedAt ?? null,
                preCutoff:
                  Boolean(rec.cutoff && rec.exhibition.evidence?.fetchedAt) &&
                  Date.parse(rec.exhibition.evidence!.fetchedAt) < Date.parse(rec.cutoff!),
              }
            : null,
          result: rec.result ?? null,
          sources: [sourceLabel],
          boatRecord: rec,
        });
      }
    }
  };

  attachBoatRecords(archiveRaces, "archive");
  attachBoatRecords(sqliteRaces, "sqlite");

  const races = [...byId.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.cutoff ?? "").localeCompare(b.cutoff ?? "") || a.venue.localeCompare(b.venue) || a.number - b.number,
  );
  return { races, audit };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(2)}%`;
}

function num(v: number | null, digits = 3): string {
  return v === null ? "—" : v.toFixed(digits);
}

function band(v: number | null, cuts: { label: string; max: number }[]): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  for (const c of cuts) {
    if (v <= c.max) return c.label;
  }
  return cuts[cuts.length - 1].label;
}

function buildFeatureBreakdowns(outcomes: readonly B01RaceOutcome[]): Record<string, GroupPerformanceRow[]> {
  const opts = { bootstrapReps: 1000 };
  const innerPatternCounts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.state === "settled" && o.features.gradeInnerPattern) {
      innerPatternCounts.set(o.features.gradeInnerPattern, (innerPatternCounts.get(o.features.gradeInnerPattern) ?? 0) + 1);
    }
  }
  const majorPatterns = new Set([...innerPatternCounts.entries()].filter(([, c]) => c >= 60).map(([k]) => k));

  return {
    grade1: groupPerformance(outcomes, (o) => o.features.grade1, opts),
    gradeSigmaClass: groupPerformance(outcomes, (o) => o.features.gradeSigmaClass, opts),
    gradeInnerDesc: groupPerformance(outcomes, (o) => (o.features.gradeInnerDesc === null ? null : o.features.gradeInnerDesc ? "1>=2>=3" : "other"), opts),
    gradeGate1Ge3: groupPerformance(outcomes, (o) => (o.features.gradeGate1Ge3 === null ? null : o.features.gradeGate1Ge3 ? "1>=3" : "1<3"), opts),
    gradeB1MinusOthers: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.gradeB1MinusOthers, [
          { label: "1_le_-0.5", max: -0.5 },
          { label: "2_-0.5..0.0", max: 0.0 },
          { label: "3_0.0..+0.5", max: 0.5 },
          { label: "4_gt_+0.5", max: Infinity },
        ]),
      opts,
    ),
    gradeInnerPatternMajor: groupPerformance(
      outcomes,
      (o) => (o.features.gradeInnerPattern && majorPatterns.has(o.features.gradeInnerPattern) ? o.features.gradeInnerPattern : null),
      { ...opts, sortBy: "roi" },
    ),
    winRateDiffMax23: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.winRateDiffMax23, [
          { label: "1_b1_much_lower(<-1.0)", max: -1.0 },
          { label: "2_b1_lower(-1.0..0.0)", max: 0.0 },
          { label: "3_b1_edge(0.0..+1.0)", max: 1.0 },
          { label: "4_b1_dominant(>+1.0)", max: Infinity },
        ]),
      opts,
    ),
    winRatePair23: groupPerformance(outcomes, (o) => o.features.winRatePair23, opts),
    avgStDiffMin23: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.avgStDiffMin23, [
          { label: "1_b1_faster(<=-0.02)", max: -0.02 },
          { label: "2_even(-0.02..+0.02)", max: 0.02 },
          { label: "3_b1_slower(>+0.02)", max: Infinity },
        ]),
      opts,
    ),
    motor2_1: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.motor2_1, [
          { label: "1_low(<=30%)", max: 30 },
          { label: "2_mid(30..40%)", max: 40 },
          { label: "3_high(>40%)", max: Infinity },
        ]),
      opts,
    ),
    motor2DiffMax23: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.motor2DiffMax23, [
          { label: "1_b1_weaker(<-10)", max: -10 },
          { label: "2_b1_slightly_weaker(-10..0)", max: 0 },
          { label: "3_b1_slightly_stronger(0..+10)", max: 10 },
          { label: "4_b1_stronger(>+10)", max: Infinity },
        ]),
      opts,
    ),
    exTimeStd: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.exTimeStd, [
          { label: "1_tight(<=0.035)", max: 0.035 },
          { label: "2_mid(0.035..0.055)", max: 0.055 },
          { label: "3_wide(>0.055)", max: Infinity },
        ]),
      opts,
    ),
    exTimeZ1: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.exTimeZ1, [
          { label: "1_fast(<=-0.5)", max: -0.5 },
          { label: "2_normal(-0.5..+0.5)", max: 0.5 },
          { label: "3_slow(>+0.5)", max: Infinity },
        ]),
      opts,
    ),
    exStStdSigned: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.exStStdSigned, [
          { label: "1_tight(<=0.045)", max: 0.045 },
          { label: "2_mid(0.045..0.075)", max: 0.075 },
          { label: "3_wide(>0.075)", max: Infinity },
        ]),
      opts,
    ),
    exStStdNoF: groupPerformance(
      outcomes,
      (o) =>
        band(o.features.exStStdNoF, [
          { label: "1_tight(<=0.035)", max: 0.035 },
          { label: "2_mid(0.035..0.055)", max: 0.055 },
          { label: "3_wide(>0.055)", max: Infinity },
        ]),
      opts,
    ),
    exFlyingCount: groupPerformance(
      outcomes,
      (o) =>
        o.features.exFlyingCount === null
          ? null
          : o.features.exFlyingCount === 0
            ? "0_none"
            : o.features.exFlyingCount === 1
              ? "1_one"
              : "2_two_or_more",
      opts,
    ),
    exFlying1: groupPerformance(outcomes, (o) => (o.features.exFlying1 === null ? null : o.features.exFlying1 ? "F" : "noF"), opts),
    exFlying2: groupPerformance(outcomes, (o) => (o.features.exFlying2 === null ? null : o.features.exFlying2 ? "F" : "noF"), opts),
    exFlying3: groupPerformance(outcomes, (o) => (o.features.exFlying3 === null ? null : o.features.exFlying3 ? "F" : "noF"), opts),
    exFlyingOuter: groupPerformance(outcomes, (o) => (o.features.exFlyingOuter === null ? null : o.features.exFlyingOuter ? "outerF" : "noOuterF"), opts),
    exWakunari: groupPerformance(outcomes, (o) => (o.features.exWakunari === null ? null : o.features.exWakunari ? "123456" : "changed"), opts),
    exInnerWakunari: groupPerformance(outcomes, (o) => (o.features.exInnerWakunari === null ? null : o.features.exInnerWakunari ? "123xxx" : "inner_changed"), opts),
    exCourse1: groupPerformance(outcomes, (o) => (o.features.exCourse1 === null ? null : o.features.exCourse1 === 1 ? "course1" : "moved_out"), opts),
    actualWakunariPostHoc: groupPerformance(outcomes, (o) => (o.features.actualWakunari === null ? null : o.features.actualWakunari ? "123456" : "changed"), opts),
  };
}

function main() {
  const args = process.argv.slice(2);
  const dataRoot = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "../TurfLab-data");
  const outDirArg = args.find((a) => a.startsWith("--out-dir="))?.split("=")[1]
    ?? (args.indexOf("--out-dir") >= 0 ? args[args.indexOf("--out-dir") + 1] : undefined);
  const splitDate = args.find((a) => a.startsWith("--split-date="))?.split("=")[1] ?? "2026-11-13";
  const sqliteArg = args.find((a) => a.startsWith("--sqlite="))?.split("=")[1]
    ?? (args.indexOf("--sqlite") >= 0 ? args[args.indexOf("--sqlite") + 1] : undefined);
  const outDir = outDirArg ? resolve(outDirArg) : join(dataRoot, "research", "b01-profitability-v1");

  const backfillDays = loadBackfill(dataRoot);
  const { archives, missingDays } = loadArchiveInputs(dataRoot);
  const mergedArchive = mergeBoatArchives(archives, missingDays);
  const sqliteRaces = sqliteArg ? loadSqliteRaces(sqliteArg) : [];

  const { races, audit } = mergeSources(backfillDays, mergedArchive.races, sqliteRaces);
  const outcomes = races.map(evaluateB01Race);
  const settled = outcomes.filter((o) => o.state === "settled");
  const pending = outcomes.filter((o) => o.state === "pending");
  const excluded = outcomes.filter((o) => o.state === "excluded");
  const voidRaces = settled.filter((o) => o.isVoid);
  const settledSimple = settled.map(outcomeToSimpleRow);

  // 1. Overall & block analysis (100 / 500 / 1000 / 3000)
  const overall = computePerformanceMetrics(settledSimple, { bootstrapReps: 2000, seed: 20261128 });
  const blocks = computeBlockAnalysis(settledSimple, [100, 500, 1000, 3000], { bootstrapReps: 1000 });

  // 2. Venue / Daily / TimeSlot / RaceNo breakdowns
  const byVenue = groupPerformance(outcomes, (o) => o.race.venueName, { bootstrapReps: 1000, sortBy: "roi" });
  const byDate = groupPerformance(outcomes, (o) => o.race.date, { bootstrapReps: 500, sortBy: "key" });
  const byTimeSlot = groupPerformance(outcomes, (o) => o.features.timeSlot, { bootstrapReps: 1500, sortBy: "key" });
  const byRaceNumber = groupPerformance(outcomes, (o) => String(o.race.number).padStart(2, "0") + "R", { bootstrapReps: 1000, sortBy: "key" });

  // 3. Feature breakdowns
  const byFeature = buildFeatureBreakdowns(outcomes);

  // 4. Hit vs Miss comparison
  const hitVsMiss = compareHitVsMissFeatures(outcomes);

  // 5. Model comparison (B01, B02, B13, B13v2Pre, B13v2NoEx, FIXED123)
  // (a) Full period reconstructed (using backfill)
  const modelComparisonFull = compareModelsSameRaces(races, {
    mode: "full-backfill-reconstructed",
    bootstrapReps: 2000,
  });
  // (b) Strict archive/sqlite pre-cutoff comparison (2026-11-23..2026-11-27)
  const archiveOnlyInputs = races.filter((r) => r.boatRecord !== undefined);
  const modelComparisonStrictArchive = compareModelsSameRaces(archiveOnlyInputs, {
    mode: "strict-archive",
    bootstrapReps: 2000,
  });

  // 6. Time-split hypothesis validation (Discovery < splitDate vs Holdout >= splitDate)
  const splitHypotheses = evaluateHypothesesSplit(outcomes, splitDate, { bootstrapReps: 1500 });

  // Also compute holdout-only model comparison for clean out-of-sample comparison
  const modelComparisonHoldout = compareModelsSameRaces(races, {
    mode: "full-backfill-reconstructed",
    evalFromDate: splitDate,
    bootstrapReps: 2000,
  });

  const report = {
    schemaVersion: B01_STUDY_VERSION,
    generatedAt: new Date().toISOString(),
    dataAudit: {
      ...audit,
      totalUniqueRaces: races.length,
      settledRaces: settled.length,
      voidRacesInSettled: voidRaces.length,
      pendingRaces: pending.length,
      excludedRaces: excluded.length,
      dateRange: races.length ? [races[0].date, races[races.length - 1].date] : null,
      settledDateRange: settled.length ? [settled[0].race.date, settled[settled.length - 1].race.date] : null,
      daysCount: new Set(settled.map((o) => o.race.date)).size,
      featureCoverage: {
        allGrades: settled.filter((o) => o.features.hasAllGrades).length,
        winRates: settled.filter((o) => o.features.winRateDiffMax23 !== null).length,
        motor2Rates: settled.filter((o) => o.features.motor2DiffMax23 !== null).length,
        avgSt: settled.filter((o) => o.features.avgStDiffMin23 !== null).length,
        exTime: settled.filter((o) => o.features.hasCompleteExTime).length,
        exCourse: settled.filter((o) => o.features.hasCompleteExCourse).length,
        exStSigned: settled.filter((o) => o.features.exStStdSigned !== null).length,
        exStNoF: settled.filter((o) => o.features.exStStdNoF !== null).length,
      },
    },
    overall,
    blocks,
    byVenue,
    byDate,
    byTimeSlot,
    byRaceNumber,
    byFeature,
    hitVsMiss,
    modelComparisonFull,
    modelComparisonHoldout,
    modelComparisonStrictArchive,
    splitHypotheses,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  // CSV exports
  const blockRows: unknown[][] = [];
  for (const bs of Object.values(blocks)) {
    for (const b of bs.blocks) {
      blockRows.push([
        bs.blockSize,
        b.index,
        b.fromDate,
        b.toDate,
        b.metrics.settled,
        b.metrics.hits,
        num(b.metrics.hitRate, 4),
        b.metrics.stake,
        b.metrics.payout,
        b.metrics.refund,
        b.metrics.net,
        num(b.metrics.roi, 4),
        num(b.metrics.roiCi95Bootstrap[0], 4),
        num(b.metrics.roiCi95Bootstrap[1], 4),
        b.metrics.maxDrawdown,
        b.metrics.maxLosingStreak,
        num(b.metrics.trimmedRoi.exclTop3, 4),
      ]);
    }
  }
  writeFileSync(
    join(outDir, "blocks.csv"),
    toCsv(
      ["block_size", "block_index", "from_date", "to_date", "settled", "hits", "hit_rate", "stake", "payout", "refund", "net", "roi", "ci95_low", "ci95_high", "max_dd", "max_losing_streak", "roi_excl_top3"],
      blockRows,
    ),
    "utf8",
  );

  writeFileSync(
    join(outDir, "venues.csv"),
    toCsv(
      ["venue", "settled", "hits", "hit_rate", "stake", "net", "roi", "ci95_low", "ci95_high", "max_dd", "max_losing_streak", "roi_excl_top3", "p_vs_rest", "bh_fdr_q"],
      byVenue.map((g) => [
        g.group, g.metrics.settled, g.metrics.hits, num(g.metrics.hitRate, 4), g.metrics.stake, g.metrics.net,
        num(g.metrics.roi, 4), num(g.metrics.roiCi95Bootstrap[0], 4), num(g.metrics.roiCi95Bootstrap[1], 4),
        g.metrics.maxDrawdown, g.metrics.maxLosingStreak, num(g.metrics.trimmedRoi.exclTop3, 4),
        num(g.vsRestPValue, 4), num(g.bhFdrQ, 4),
      ]),
    ),
    "utf8",
  );

  writeFileSync(
    join(outDir, "daily.csv"),
    toCsv(
      ["date", "settled", "hits", "hit_rate", "stake", "payout", "refund", "net", "roi", "max_dd", "max_losing_streak"],
      byDate.map((g) => [
        g.group, g.metrics.settled, g.metrics.hits, num(g.metrics.hitRate, 4), g.metrics.stake, g.metrics.payout,
        g.metrics.refund, g.metrics.net, num(g.metrics.roi, 4), g.metrics.maxDrawdown, g.metrics.maxLosingStreak,
      ]),
    ),
    "utf8",
  );

  const modelCsvRows: unknown[][] = [];
  for (const [label, comp] of [
    ["full_reconstructed", modelComparisonFull],
    ["holdout_reconstructed", modelComparisonHoldout],
    ["strict_archive", modelComparisonStrictArchive],
  ] as const) {
    for (const [id, m] of Object.entries(comp.models)) {
      modelCsvRows.push([
        label, id, m.settled, m.hits, num(m.hitRate, 4), m.stake, m.net, m.balanceEnd,
        num(m.roi, 4), num(m.roiCi95Bootstrap[0], 4), num(m.roiCi95Bootstrap[1], 4),
        m.maxDrawdown, m.maxLosingStreak, num(m.trimmedRoi.exclTop5, 4),
        num(m.logLoss, 4), num(m.brierScore, 5), num(m.sameTicketsAsB01Rate, 4),
      ]);
    }
  }
  writeFileSync(
    join(outDir, "models.csv"),
    toCsv(
      ["scope", "model", "settled", "hits", "hit_rate", "stake", "net", "balance_end", "roi", "ci95_low", "ci95_high", "max_dd", "max_losing_streak", "roi_excl_top5", "log_loss", "brier", "same_as_b01_rate"],
      modelCsvRows,
    ),
    "utf8",
  );

  writeFileSync(
    join(outDir, "hypotheses.csv"),
    toCsv(
      ["id", "name", "kind", "disc_n", "disc_rate", "disc_roi", "disc_net", "hold_n", "hold_rate", "hold_roi", "hold_ci95_low", "hold_ci95_high", "hold_net", "hold_dd", "hold_p_vs_b01", "verdict"],
      splitHypotheses.results.map((h) => [
        h.id, h.name, h.kind,
        h.discovery.selectedCount, num(h.discovery.selectionRate, 4), num(h.discovery.metrics.roi, 4), h.discovery.metrics.net,
        h.holdout.selectedCount, num(h.holdout.selectionRate, 4), num(h.holdout.metrics.roi, 4),
        num(h.holdout.metrics.roiCi95Bootstrap[0], 4), num(h.holdout.metrics.roiCi95Bootstrap[1], 4),
        h.holdout.metrics.net, h.holdout.metrics.maxDrawdown, num(h.holdout.vsBaselinePValue, 4), h.verdict,
      ]),
    ),
    "utf8",
  );

  // Console summary
  console.log("=== B01 PROFITABILITY & REPRODUCIBILITY STUDY ===");
  console.log(`Data: unique=${races.length}, settled=${settled.length} (void=${voidRaces.length}), pending=${pending.length}, excluded=${excluded.length}, days=${report.dataAudit.daysCount}, range=${report.dataAudit.settledDateRange?.join("..")}`);
  console.log(`Mismatches across sources: ${audit.resultMismatches.length}`);
  console.log(
    `OVERALL B01: settled=${overall.settled}, hits=${overall.hits} (${pct(overall.hitRate)}), stake=${overall.stake}, net=${overall.net}, ROI=${pct(overall.roi)} [Boot95: ${pct(overall.roiCi95Bootstrap[0])}..${pct(overall.roiCi95Bootstrap[1])}, Cluster95: ${pct(overall.roiCi95Cluster[0])}..${pct(overall.roiCi95Cluster[1])}]`,
  );
  console.log(
    `RISK & OUTLIERS: maxDD=${overall.maxDrawdown}, maxStreak=${overall.maxLosingStreak} (exclRefund=${overall.maxLosingStreakExclRefund}), trimmedROI(exclTop1/3/5/10)=${pct(overall.trimmedRoi.exclTop1)}/${pct(overall.trimmedRoi.exclTop3)}/${pct(overall.trimmedRoi.exclTop5)}/${pct(overall.trimmedRoi.exclTop10)}`,
  );
  for (const [k, bs] of Object.entries(blocks)) {
    console.log(
      `  ${k}: fullBlocks=${bs.fullBlockCount} (rem=${bs.remainderCount}), ROI>=100%=${bs.profitableBlocks}/${bs.fullBlockCount} (${pct(bs.profitableRate)}), median=${pct(bs.roiMedian)}, min=${pct(bs.roiMin)}, max=${pct(bs.roiMax)}, maxDDmax=${bs.maxDrawdownMax}`,
    );
  }
  console.log("\n=== MODEL COMPARISON (FULL RECONSTRUCTED) ===");
  for (const [id, m] of Object.entries(modelComparisonFull.models)) {
    console.log(
      `  ${id.padEnd(10)} | n=${m.settled} hits=${m.hits} (${pct(m.hitRate)}) | net=${m.net} ROI=${pct(m.roi)} [${pct(m.roiCi95Bootstrap[0])}..${pct(m.roiCi95Bootstrap[1])}] | DD=${m.maxDrawdown} | exclTop5=${pct(m.trimmedRoi.exclTop5)} | LL=${num(m.logLoss, 4)}`,
    );
  }
  console.log("\n=== SPLIT HYPOTHESIS VALIDATION ===");
  console.log(`Split=${splitDate} (discovery=${splitHypotheses.discoveryCount}R, holdout=${splitHypotheses.holdoutCount}R)`);
  for (const h of splitHypotheses.results) {
    console.log(
      `  ${h.id.padEnd(22)} | disc=${h.discovery.selectedCount}R ROI=${pct(h.discovery.metrics.roi)} | hold=${h.holdout.selectedCount}R ROI=${pct(h.holdout.metrics.roi)} [${pct(h.holdout.metrics.roiCi95Bootstrap[0])}..${pct(h.holdout.metrics.roiCi95Bootstrap[1])}] | ${h.verdict}`,
    );
  }
  console.log(`\nSaved outputs to: ${outDir}`);
}

main();
