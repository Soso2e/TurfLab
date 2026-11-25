import { BOATS, type BoatRecord, type BoatResult, type Grade } from "./boatrace";
import {
  B11_VERSION,
  evaluateB11,
  evaluateCourseGate,
  gradeFeatures,
  gradesOf,
  SIGMA_CLASSES,
  summarizeB11,
  type B11Decision,
  type B11ResearchItem,
  type B11ResearchRecord,
  type B11Summary,
  type CourseGateEvaluation,
  type CourseGateReason,
  type CourseGateStatus,
  type CourseTiming,
  type GradeFeatures,
  type SigmaClass,
  type ThresholdJudgement,
} from "./boatrace-b11";

export const RESEARCH_SCHEMA_VERSION = "boatrace-research-v1" as const;
export const NORMALIZED_SCHEMA_VERSION = "boatrace-normalized-v1" as const;
export const FEATURES_SCHEMA_VERSION = "boatrace-features-v1" as const;
export const FORECASTS_SCHEMA_VERSION = "boatrace-forecasts-v1" as const;
export const EVALUATIONS_SCHEMA_VERSION = "boatrace-evaluations-v1" as const;
export const MANIFEST_SCHEMA_VERSION = "boatrace-manifest-v1" as const;
export const EVALUATOR_VERSION = "b11-eval-v2" as const;

export type MissingReason = "ok" | "missing" | "invalid" | "not_collected" | "late" | "not_frozen";

export interface BoatArchiveInput {
  file: string;
  date: string;
  records: BoatRecord[];
  research?: B11ResearchRecord[];
  revisions?: { raceId: string; result: BoatResult }[];
}

export interface MergedArchiveResult {
  races: BoatRecord[];
  forwardResearch: Map<string, B11ResearchRecord>;
  sources: { file: string; records: number; research: number }[];
  duplicateRaces: number;
  missingDays: string[];
}

export function mergeBoatArchives(archives: BoatArchiveInput[], missingDays: string[] = []): MergedArchiveResult {
  const races = new Map<string, BoatRecord>();
  const forwardResearch = new Map<string, B11ResearchRecord>();
  const sources: { file: string; records: number; research: number }[] = [];
  const duplicates = new Set<string>();

  for (const archive of archives) {
    sources.push({ file: archive.file, records: archive.records.length, research: archive.research?.length ?? 0 });
    for (const rec of archive.research ?? []) {
      if (rec.kind !== "forward") continue;
      const prev = forwardResearch.get(rec.raceId);
      if (!prev || (prev.evaluation.b11.status === "unjudged" && rec.evaluation.b11.status !== "unjudged")) {
        forwardResearch.set(rec.raceId, rec);
      }
    }
    const latestRev = new Map<string, BoatResult>();
    for (const rev of archive.revisions ?? []) {
      const prev = latestRev.get(rev.raceId);
      if (!prev || rev.result.evidence.fetchedAt >= prev.evidence.fetchedAt) {
        latestRev.set(rev.raceId, rev.result);
      }
    }
    for (const record of archive.records) {
      const revResult = latestRev.get(record.id) ?? record.result;
      const prev = races.get(record.id);
      if (prev) duplicates.add(record.id);
      const bestResult = revResult && (!prev?.result || revResult.evidence.fetchedAt >= prev.result.evidence.fetchedAt)
        ? revResult
        : prev?.result;
      const bestFreeze = prev?.freeze ?? record.freeze;
      const bestExhibition = prev?.exhibition?.evidence
        ? (record.exhibition?.evidence && record.exhibition.evidence.fetchedAt < prev.exhibition.evidence.fetchedAt
          ? record.exhibition : prev.exhibition)
        : (record.exhibition ?? prev?.exhibition);
      races.set(record.id, {
        ...record,
        ...(bestFreeze ? { freeze: bestFreeze } : {}),
        ...(bestExhibition ? { exhibition: bestExhibition } : {}),
        ...(bestResult ? { result: bestResult } : {}),
      });
    }
  }

  const ordered = [...races.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.cutoff ?? "").localeCompare(b.cutoff ?? "") || a.id.localeCompare(b.id));
  return { races: ordered, forwardResearch, sources, duplicateRaces: duplicates.size, missingDays };
}

export interface NormalizedEntry {
  boat: number;
  name: string;
  gradeOriginal: Grade | null;
  gradeOriginalReason: MissingReason;
  gradeAdjusted: Grade | null;
  gradeAdjustedReason: MissingReason;
  exhibitionCourse: number | null;
  exhibitionST: string | null;
  exhibitionFlying: boolean | null;
  exhibitionSeconds: number | null;
  actualCourse: number | null;
  actualST: string | null;
  actualFlying: boolean | null;
  finishPosition: string | null;
  /** 探索候補（取得元未対応時は null + not_collected。0等で補完しない） */
  motorNumber: number | null;
  motorRate2: number | null;
  nationalWinRate: number | null;
  avgST: number | null;
  extraMetricsReason: MissingReason;
}

export interface NormalizedBoatRace {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  raceId: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  program: { url: string; fetchedAt: string };
  entries: NormalizedEntry[];
  exhibition: {
    source: "freeze" | "exhibition" | null;
    fetchedAt: string | null;
    timing: CourseTiming;
    order: string | null;
    missingReason: MissingReason;
  };
  odds: {
    frozenAt: string | null;
    exactaUpdatedAt: string | null;
    trifectaUpdatedAt: string | null;
    exactaCount: number;
    trifectaCount: number;
    missingReason: MissingReason;
  };
  result: {
    status: "official" | "void" | null;
    fetchedAt: string | null;
    timing: CourseTiming;
    coursesOrder: string | null;
    payouts: Record<string, number>;
    special?: { per100: number; winning: string[] };
    refundBoats: number[];
    missingReason: MissingReason;
  };
}

function timingAgainstCutoff(fetchedAt: string | null, cutoff: string | null): CourseTiming {
  if (!fetchedAt || !cutoff) return "unknown";
  const f = Date.parse(fetchedAt);
  const c = Date.parse(cutoff);
  if (!Number.isFinite(f) || !Number.isFinite(c)) return "unknown";
  return f < c ? "pre-cutoff" : "post-cutoff";
}

export function normalizeBoatRace(race: BoatRecord): NormalizedBoatRace {
  const gate = evaluateCourseGate(race, { includeResult: true });
  const cutoff = race.freeze?.cutoff ?? race.cutoff;
  const entries: NormalizedEntry[] = BOATS.map((boat) => {
    const rawEntry = race.entries.find((e) => e.boat === boat);
    const frozen = race.freeze?.entries.find((e) => e.boat === boat);
    const shown = race.exhibition?.entries.find((e) => e.boat === boat);
    const actual = race.result?.courses.find((c) => c.boat === boat);
    const finish = race.result?.finishes.find((f) => f.boat === boat);

    const gradeOriginal = rawEntry?.grade_original ?? null;
    const gradeOriginalReason: MissingReason = gradeOriginal ? "ok" : rawEntry ? "missing" : "invalid";
    const gradeAdjusted = frozen?.grade_adjusted ?? null;
    const gradeAdjustedReason: MissingReason = !race.freeze
      ? "not_frozen"
      : gradeAdjusted ? "ok" : frozen?.exhibitionF === null ? "missing" : "invalid";

    return {
      boat,
      name: rawEntry?.name ?? "",
      gradeOriginal,
      gradeOriginalReason,
      gradeAdjusted,
      gradeAdjustedReason,
      exhibitionCourse: frozen?.exhibitionCourse ?? shown?.course ?? null,
      exhibitionST: frozen?.exhibitionST ?? shown?.st ?? null,
      exhibitionFlying: frozen?.exhibitionF ?? shown?.flying ?? null,
      exhibitionSeconds: frozen?.exhibitionSeconds ?? race.exhibition?.times?.[boat] ?? null,
      actualCourse: actual?.course ?? null,
      actualST: actual?.st ?? null,
      actualFlying: actual?.flying ?? null,
      finishPosition: finish?.position ?? null,
      motorNumber: null,
      motorRate2: null,
      nationalWinRate: null,
      avgST: null,
      extraMetricsReason: "not_collected",
    };
  });

  const exMissingReason: MissingReason = gate.exhibitionOrder !== null
    ? (gate.timing === "post-cutoff" ? "late" : "ok")
    : gate.reason === "invalid" ? "invalid" : "missing";

  const resultFetchedAt = race.result?.evidence.fetchedAt ?? null;
  const resultMissingReason: MissingReason = !race.result
    ? "missing"
    : race.result.status === "official" && !Object.keys(race.result.payouts).length && !race.result.special
      ? "invalid"
      : "ok";

  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    raceId: race.id,
    date: race.date,
    venue: race.venue,
    venueName: race.venueName,
    number: race.number,
    cutoff,
    program: race.program,
    entries,
    exhibition: {
      source: gate.exhibitionSource,
      fetchedAt: gate.exhibitionFetchedAt,
      timing: gate.timing,
      order: gate.exhibitionOrder,
      missingReason: exMissingReason,
    },
    odds: race.freeze
      ? {
          frozenAt: race.freeze.frozenAt,
          exactaUpdatedAt: race.freeze.updatedAt.exacta,
          trifectaUpdatedAt: race.freeze.updatedAt.trifecta,
          exactaCount: race.freeze.exacta.length,
          trifectaCount: Object.keys(race.freeze.plans.adjusted.candidates).length,
          missingReason: "ok",
        }
      : {
          frozenAt: null,
          exactaUpdatedAt: null,
          trifectaUpdatedAt: null,
          exactaCount: 0,
          trifectaCount: 0,
          missingReason: "not_frozen",
        },
    result: {
      status: race.result?.status ?? null,
      fetchedAt: resultFetchedAt,
      timing: timingAgainstCutoff(resultFetchedAt, cutoff),
      coursesOrder: gate.actualOrder,
      payouts: race.result?.payouts ?? {},
      ...(race.result?.special ? { special: race.result.special } : {}),
      refundBoats: race.result?.refundBoats ?? [],
      missingReason: resultMissingReason,
    },
  };
}

export interface BoatResearchFeatureRecord {
  schemaVersion: typeof FEATURES_SCHEMA_VERSION;
  raceId: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  gradeVersion: typeof B11_VERSION;
  gradeFeatures: GradeFeatures;
  sigmaClass: SigmaClass | null;
  /** 補正級別の特徴量（原級別とは混同しない） */
  adjustedGradeFeatures: GradeFeatures | null;
  courseGate: CourseGateEvaluation;
  timingEligibility: {
    programPreCutoff: boolean;
    exhibitionPreCutoff: boolean;
    forwardResearchFrozen: boolean;
    forwardEligible: boolean;
    reason: string;
  };
  modelInputEligible: boolean;
}

export function extractBoatFeatures(race: BoatRecord, forwardRecord?: B11ResearchRecord): BoatResearchFeatureRecord {
  const originalFeatures = gradeFeatures(gradesOf(race));
  const adjustedFeatures = race.freeze
    ? gradeFeatures(BOATS.map((b) => race.freeze!.entries.find((e) => e.boat === b)?.grade_adjusted ?? null))
    : null;
  const courseGate = evaluateCourseGate(race, { includeResult: true });
  const cutoff = race.freeze?.cutoff ?? race.cutoff;
  const programPreCutoff = timingAgainstCutoff(race.program.fetchedAt, cutoff) === "pre-cutoff";
  const exhibitionPreCutoff = courseGate.timing === "pre-cutoff";
  const forwardResearchFrozen = Boolean(forwardRecord && forwardRecord.kind === "forward");
  const forwardEligible = programPreCutoff && forwardResearchFrozen;
  const reason = !programPreCutoff
    ? "program-not-pre-cutoff"
    : !forwardResearchFrozen
      ? "no-forward-freeze-record"
      : exhibitionPreCutoff ? "ok" : "program-only-pre-cutoff";

  return {
    schemaVersion: FEATURES_SCHEMA_VERSION,
    raceId: race.id,
    date: race.date,
    venue: race.venue,
    venueName: race.venueName,
    number: race.number,
    cutoff,
    gradeVersion: B11_VERSION,
    gradeFeatures: originalFeatures,
    sigmaClass: evaluateB11(gradesOf(race)).sigmaClass,
    adjustedGradeFeatures: adjustedFeatures,
    courseGate,
    timingEligibility: {
      programPreCutoff,
      exhibitionPreCutoff,
      forwardResearchFrozen,
      forwardEligible,
      reason,
    },
    modelInputEligible: originalFeatures.sigma !== null,
  };
}

export interface BoatResearchForecastRecord {
  schemaVersion: typeof FORECASTS_SCHEMA_VERSION;
  modelId: string;
  modelVersion: typeof B11_VERSION;
  raceId: string;
  date: string;
  kind: "forward" | "reconstructed";
  cutoff: string | null;
  frozenAt: string | null;
  b11: B11Decision;
  thresholds: ThresholdJudgement[];
  thresholdsWithGate: ThresholdJudgement[];
  courseGateStatus: CourseGateStatus;
  courseGateReason: CourseGateReason;
}

export function buildForecastRecord(race: BoatRecord, forwardRecord?: B11ResearchRecord): BoatResearchForecastRecord {
  const courseGate = evaluateCourseGate(race, { includeResult: true });
  const evalResult = forwardRecord
    ? evaluateB11(gradesOf(race), { ...courseGate, actualOrder: null, actualChanged: null, exhibitionToActualChanged: null })
    : evaluateB11(gradesOf(race), courseGate);

  return {
    schemaVersion: FORECASTS_SCHEMA_VERSION,
    modelId: "b11-sigma-research",
    modelVersion: B11_VERSION,
    raceId: race.id,
    date: race.date,
    kind: forwardRecord ? "forward" : "reconstructed",
    cutoff: race.freeze?.cutoff ?? race.cutoff,
    frozenAt: forwardRecord?.frozenAt ?? null,
    b11: evalResult.b11,
    thresholds: evalResult.thresholds,
    thresholdsWithGate: evalResult.thresholdsWithGate ?? [],
    courseGateStatus: courseGate.status,
    courseGateReason: courseGate.reason,
  };
}

export interface NotableCourseCase {
  raceId: string;
  date: string;
  venueName: string;
  number: number;
  exhibitionOrder: string | null;
  exhibitionSource: "freeze" | "exhibition" | null;
  exhibitionTiming: CourseTiming;
  actualOrder: string | null;
  gateStatus: CourseGateStatus;
  gateReason: CourseGateReason;
  b11Status: B11Decision["status"];
  sigma: number | null;
}

export interface SigmaClassAuditRow {
  sigmaClass: SigmaClass | "missing";
  total: number;
  appliedNoGate: number;
  appliedWithGate: number;
  modelSkip: number;
  gateSkip: number;
  gatePending: number;
  settledResultCount: number;
  boat1WinCount: number;
  boat1WinRate: number | null;
}

export interface BoatResearchEvaluationReport {
  schemaVersion: typeof EVALUATIONS_SCHEMA_VERSION;
  evaluatorVersion: typeof EVALUATOR_VERSION;
  period: { from: string | null; to: string | null };
  audit: {
    archiveFiles: number;
    uniqueRaces: number;
    duplicateRaces: number;
    missingDays: string[];
    perDay: Record<string, number>;
    missingGradeCount: number;
    noResultCount: number;
    preCutoffFreezeCount: number;
    preCutoffExhibitionCount: number;
    postCutoffExhibitionCount: number;
    missingExhibitionCount: number;
    exhibition123456Count: number;
    exhibitionChangedCount: number;
    actualChangedCount: number;
    actualChangedWhenEx123456Count: number;
  };
  forward: B11Summary;
  reconstructed: B11Summary;
  bySigmaClassAudit: SigmaClassAuditRow[];
  notableCourseCases: NotableCourseCase[];
}

export function buildEvaluationReport(
  merged: MergedArchiveResult,
  period: { from: string | null; to: string | null },
): BoatResearchEvaluationReport {
  const reconstructedItems: B11ResearchItem[] = [];
  const forwardItems: B11ResearchItem[] = [];
  const perDay: Record<string, number> = {};

  let missingGradeCount = 0;
  let noResultCount = 0;
  let preCutoffFreezeCount = 0;
  let preCutoffExhibitionCount = 0;
  let postCutoffExhibitionCount = 0;
  let missingExhibitionCount = 0;
  let exhibition123456Count = 0;
  let exhibitionChangedCount = 0;
  let actualChangedCount = 0;
  let actualChangedWhenEx123456Count = 0;

  const notableCourseCases: NotableCourseCase[] = [];
  const classBuckets = new Map<SigmaClass | "missing", SigmaClassAuditRow>();
  for (const key of [...SIGMA_CLASSES, "missing"] as const) {
    classBuckets.set(key, {
      sigmaClass: key, total: 0, appliedNoGate: 0, appliedWithGate: 0, modelSkip: 0,
      gateSkip: 0, gatePending: 0, settledResultCount: 0, boat1WinCount: 0, boat1WinRate: null,
    });
  }

  for (const race of merged.races) {
    perDay[race.date] = (perDay[race.date] ?? 0) + 1;
    if (race.freeze) preCutoffFreezeCount++;
    if (!race.result) noResultCount++;

    const courseGate = evaluateCourseGate(race, { includeResult: true });
    const evalRebuilt = evaluateB11(gradesOf(race), courseGate);
    if (evalRebuilt.features.sigma === null) missingGradeCount++;

    if (courseGate.exhibitionOrder === null) missingExhibitionCount++;
    else {
      if (courseGate.timing === "pre-cutoff") preCutoffExhibitionCount++;
      else if (courseGate.timing === "post-cutoff") postCutoffExhibitionCount++;
      if (courseGate.exhibitionOrder === "123456") exhibition123456Count++;
      else exhibitionChangedCount++;
    }
    if (courseGate.actualChanged === true) {
      actualChangedCount++;
      if (courseGate.exhibitionOrder === "123456") actualChangedWhenEx123456Count++;
    }

    if (courseGate.status === "skip" || (courseGate.exhibitionOrder === "123456" && courseGate.actualChanged === true)) {
      notableCourseCases.push({
        raceId: race.id,
        date: race.date,
        venueName: race.venueName,
        number: race.number,
        exhibitionOrder: courseGate.exhibitionOrder,
        exhibitionSource: courseGate.exhibitionSource,
        exhibitionTiming: courseGate.timing,
        actualOrder: courseGate.actualOrder,
        gateStatus: courseGate.status,
        gateReason: courseGate.reason,
        b11Status: evalRebuilt.b11.status,
        sigma: evalRebuilt.features.sigma,
      });
    }

    const bucketKey = evalRebuilt.sigmaClass ?? "missing";
    const bucket = classBuckets.get(bucketKey)!;
    bucket.total++;
    if (evalRebuilt.b11.status === "bet") bucket.appliedNoGate++;
    else if (evalRebuilt.b11.status === "skip") bucket.modelSkip++;

    if (courseGate.status === "skip") bucket.gateSkip++;
    else if (courseGate.status === "pending") bucket.gatePending++;
    else if (evalRebuilt.b11.status === "bet") bucket.appliedWithGate++;

    if (race.result?.status === "official" && race.result.finishes.length) {
      const winner = race.result.finishes.find((f) => f.position === "1");
      if (winner) {
        bucket.settledResultCount++;
        if (winner.boat === 1) bucket.boat1WinCount++;
      }
    }

    const cutoff = race.freeze?.cutoff ?? race.cutoff;
    reconstructedItems.push({
      record: {
        raceId: race.id, date: race.date, kind: "reconstructed", frozenAt: null,
        cutoff, source: race.program, evaluation: evalRebuilt,
      },
      venueName: race.venueName,
      cutoff,
      result: race.result,
    });

    const fwd = merged.forwardResearch.get(race.id);
    if (fwd) {
      // 前向きレコードにも事前展示ゲートを統合（事後resultは入れない）
      const fwdGate = evaluateCourseGate(race, { includeResult: false });
      const fwdEval = fwd.evaluation.courseGate
        ? fwd.evaluation
        : evaluateB11(gradesOf(race), fwdGate.timing === "pre-cutoff" ? fwdGate : { ...fwdGate, status: "pending", reason: "missing", exhibitionOrder: null });
      forwardItems.push({
        record: { ...fwd, evaluation: fwdEval },
        venueName: race.venueName,
        cutoff,
        result: race.result,
      });
    }
  }

  for (const bucket of classBuckets.values()) {
    bucket.boat1WinRate = bucket.settledResultCount ? bucket.boat1WinCount / bucket.settledResultCount : null;
  }

  return {
    schemaVersion: EVALUATIONS_SCHEMA_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    period,
    audit: {
      archiveFiles: merged.sources.length,
      uniqueRaces: merged.races.length,
      duplicateRaces: merged.duplicateRaces,
      missingDays: merged.missingDays,
      perDay,
      missingGradeCount,
      noResultCount,
      preCutoffFreezeCount,
      preCutoffExhibitionCount,
      postCutoffExhibitionCount,
      missingExhibitionCount,
      exhibition123456Count,
      exhibitionChangedCount,
      actualChangedCount,
      actualChangedWhenEx123456Count,
    },
    forward: summarizeB11(forwardItems, "forward"),
    reconstructed: summarizeB11(reconstructedItems, "reconstructed"),
    bySigmaClassAudit: [...classBuckets.values()],
    notableCourseCases,
  };
}
