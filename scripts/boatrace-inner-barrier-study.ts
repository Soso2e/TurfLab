// Offline study for #129. Do not use study outputs in the collector.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BOATS, GRADES, type BoatRecord, type BoatResult } from "../packages/shared/src/boatrace";
import { topThree } from "../packages/shared/src/boatrace-b13";
import {
  B13V2_FEATURE_NAMES, buildBoatFeatureMatrix, buildNoExFeatureMatrix, extractB13V2Features, fitB13V2,
  fitB13V2NoEx, type B13V2FittedModel, type B13V2RaceFeatures,
} from "../packages/shared/src/boatrace-b13-v2";
import { mergeBoatArchives, type BoatArchiveInput } from "../packages/shared/src/boatrace-research";
import { loadArchiveInputs, sha256Hex } from "./boatrace-research-cli";
import { addTerms, average, bootstrap, evaluateScores, fitOffsets, gradeBarrier, wilson, type Barrier } from "./boatrace-inner-barrier";

type Revision = NonNullable<BoatArchiveInput["revisions"]>[number];
type Frozen = { raceId: string; frozenAt: string; cutoff: string; hasPreCutoffExhibition: boolean;
  predictions: { B13v2Pre: { top5: { combination: string; probability: number }[] } } };
type Local = { records: BoatRecord[]; revisions: Revision[]; frozen: Frozen[] };
type Cohort = "pre" | "noex" | "reconstructed";
type Row = {
  race: BoatRecord; pre: B13V2RaceFeatures; full: B13V2RaceFeatures; programPre: boolean;
  order: number[] | null; revisions: BoatResult[]; inspiration: boolean;
};
type Candidate = {
  id: string; barrier?: Barrier; f?: "binary" | "depth" | "lane"; interaction?: boolean;
  unrestricted?: boolean; ridge?: number;
};
const baseline: Candidate = { id: "B13v2" };
const onTime = (a: string | null | undefined, b: string | null | undefined) =>
  Date.parse(a ?? "") < Date.parse(b ?? "");
const cutoff = (race: BoatRecord) => race.freeze?.cutoff ?? race.cutoff;
const cohortFeatures = (row: Row, cohort: Cohort) => cohort === "reconstructed" ? row.full : row.pre;
const names = ["live", "noex", "reconstructed"] as const;

function readLocal(path: string): Local {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    return {
      records: db.prepare("SELECT body FROM boat_races ORDER BY date, id").all()
        .map((row) => JSON.parse(String(row.body))),
      revisions: db.prepare("SELECT id, body FROM boat_result_revisions ORDER BY id, fetched_at").all()
        .map((row) => ({ raceId: String(row.id), result: JSON.parse(String(row.body)) })),
      frozen: db.prepare("SELECT body FROM boat_shadow_predictions ORDER BY date, race_id").all()
        .map((row) => JSON.parse(String(row.body))),
    };
  } finally {
    db.close();
  }
}

export function prepare(archives: BoatArchiveInput[], local: Local) {
  const localArchive = { file: "local-sqlite", date: "", records: local.records, revisions: local.revisions };
  const archivesWithLocal = [...archives, localArchive];
  const merged = mergeBoatArchives(archivesWithLocal);
  const versions = new Map<string, BoatRecord[]>();
  const outcomes = new Map<string, Map<string, BoatResult>>();
  function addResult(id: string, result: BoatResult) {
    const items = outcomes.get(id) ?? new Map();
    items.set(result.evidence.fetchedAt, result);
    outcomes.set(id, items);
  }

  for (const archive of archivesWithLocal) {
    for (const record of archive.records) {
      const items = versions.get(record.id) ?? [];
      items.push(record);
      versions.set(record.id, items);
      if (record.result) addResult(record.id, record.result);
    }
    for (const { raceId, result } of archive.revisions ?? []) addResult(raceId, result);
  }
  const rows = merged.races.map((race): Row => {
    const items = versions.get(race.id)!;
    const program = items.filter((x) => onTime(x.program.fetchedAt, cutoff(x)))
      .sort((a, b) => Date.parse(a.program.fetchedAt) - Date.parse(b.program.fetchedAt))[0];
    const input = program ? { ...race, program: program.program, entries: program.entries, cutoff: program.cutoff } : race;
    const revisions = [...(outcomes.get(race.id)?.values() ?? [])]
      .sort((a, b) => Date.parse(b.evidence.fetchedAt) - Date.parse(a.evidence.fetchedAt));
    // A later result revision must not change the label used for an earlier training day.
    const final = revisions[0] ? { ...input, result: revisions[0] } : input;
    return {
      race: final,
      pre: extractB13V2Features(input, { preCutoffExhibitionOnly: true }),
      full: extractB13V2Features(input),
      programPre: Boolean(program && onTime(input.program.fetchedAt, cutoff(input))),
      order: topThree(final),
      revisions,
      inspiration: race.date === "2026-11-27" && race.venue === "15" && race.number === 10,
    };
  });
  return { rows, duplicates: merged.duplicateRaces };
}

export function resultOrderBefore(row: Row, asOf: string) {
  return topThree({ ...row.race, result: row.revisions.find((version) => onTime(version.evidence.fetchedAt, asOf)) });
}

function coursesFor(features: B13V2RaceFeatures, cohort: Cohort): number[] {
  const order = cohort === "noex" ? null : features.exhibitionOrder;
  return order ? BOATS.map((boat) => order.indexOf(String(boat)) + 1) : [...BOATS];
}

function inputs(row: Row, cohort: Cohort, model: B13V2FittedModel, candidate: Candidate) {
  const features = cohortFeatures(row, cohort);
  const modelMatrix = model.kind === "full"
    ? buildBoatFeatureMatrix(features, model.norm) : buildNoExFeatureMatrix(features, model.norm);
  const base = modelMatrix.map((row) => row.reduce((sum, value, j) => sum + value * model.weights[j], 0));
  const matrix = BOATS.map((): number[] => []);
  if (candidate.barrier !== undefined) {
    const barriers = gradeBarrier(features.gradePoints as number[], coursesFor(features, cohort), candidate.barrier);
    barriers.forEach((values, i) => matrix[i].push(...values.map((h) => -h)));
  }
  if (candidate.f) {
    for (let i = 0; i < BOATS.length; i++) {
      const f = features.exhibitionF[i];
      if (f === null) throw new Error("Unknown exhibition F in complete exhibition cohort");
      // Replace the original six F terms, leaving all other offsets intact.
      const fColumn = B13V2_FEATURE_NAMES.indexOf("f_c1") + i;
      base[i] -= modelMatrix[i][fColumn] * model.weights[fColumn];
      if (candidate.f === "lane") matrix[i].push(...BOATS.map((b) => Number(f && b === i + 1)));
      else matrix[i].push(candidate.f === "depth" ? 10 * (features.exhibitionFDepth[i] ?? 0) : Number(f));
      if (candidate.interaction) matrix[i].push(matrix[i][0] * Number(f));
    }
  }
  return { base, matrix };
}

function variants(cohort: Cohort): Candidate[] {
  const h: Candidate[] = [0, 0.25, 0.5, 0.75, 1, "near", "max", "separate"].map((barrier) => ({
    id: `H-${barrier}`, barrier: barrier as Barrier,
  }));
  h.push({ id: "H-free", barrier: 0.5, unrestricted: true },
    { id: "H-separate-free", barrier: "separate", unrestricted: true },
    { id: "H-0.5-ridge-low", barrier: 0.5, ridge: 0.02 },
    { id: "H-0.5-ridge-high", barrier: 0.5, ridge: 0.5 });
  if (cohort === "noex") return [baseline, ...h];
  return [baseline, ...h,
    { id: "F-positive", f: "binary" }, { id: "F-free", f: "binary", unrestricted: true },
    { id: "F-depth-free", f: "depth", unrestricted: true },
    { id: "F-lane-positive", f: "lane" },
    ...[0.25, 0.5, 0.75, 1].map((barrier): Candidate => ({ id: `HF-${barrier}`, barrier, f: "binary" })),
    { id: "HF-free", barrier: 0.5, f: "binary", unrestricted: true },
    { id: "HF-interaction", barrier: 0.5, f: "binary", interaction: true },
  ];
}

function eligible(row: Row, cohort: Cohort) {
  const f = cohortFeatures(row, cohort);
  if (!f.hasAllGrades || row.inspiration) return false;
  if (cohort === "reconstructed") return f.hasCompleteExhibition;
  return row.programPre && (cohort === "noex" || f.hasCompleteExhibition);
}

type Prediction = { row: Row; scores: number[]; score: ReturnType<typeof evaluateScores> };
function summarize(predictions: Prediction[], cohort: Cohort, reference?: Prediction[]) {
  const metric = (key: "logLoss" | "brierScore" | "exact" | "winHit") =>
    average(predictions.flatMap(({ score }) => score[key] ?? []));
  const calibration = (key: "win" | "place") => {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, observed: 0 }));
    let brier = 0;
    for (const { row, score } of predictions) for (const b of BOATS) {
      const p = score[key][b - 1];
      const y = Number(key === "win" ? row.order![0] === b : row.order!.includes(b));
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.n++;
      bin.predicted += p;
      bin.observed += y;
      brier += (p - y) ** 2;
    }
    const n = 6 * predictions.length;
    return {
      ece: n ? bins.reduce((sum, b) => sum + Math.abs(b.predicted - b.observed), 0) / n : null,
      brier: n ? brier / n : null,
      bins: bins.map(({ n, predicted, observed }) => ({
        n, predicted: n ? predicted / n : null, observed: n ? observed / n : null,
      })),
    };
  };
  const result = {
    n: predictions.length, logLoss: metric("logLoss"), brier: metric("brierScore"),
    exact: metric("exact"), winner: metric("winHit"), calibration: { win: calibration("win"), place: calibration("place") },
  };
  if (!reference?.length || !predictions.length) return result;
  const ref = new Map(reference.map(({ row, score }) => [row.race.id, score]));
  const deltas = predictions.map(({ row, score }) => ({
    day: row.race.date, venue: row.race.venue,
    ll: score.logLoss! - ref.get(row.race.id)!.logLoss!,
    brier: score.brierScore - ref.get(row.race.id)!.brierScore,
    rank: BOATS.map((b) => ({
      course: coursesFor(cohortFeatures(row, cohort), cohort)[b - 1],
      grade: row.pre.gradePoints[b - 1],
      winBrier: (score.win[b - 1] - Number(row.order![0] === b)) ** 2 -
        (ref.get(row.race.id)!.win[b - 1] - Number(row.order![0] === b)) ** 2,
      placeBrier: (score.place[b - 1] - Number(row.order!.includes(b))) ** 2 -
        (ref.get(row.race.id)!.place[b - 1] - Number(row.order!.includes(b))) ** 2,
    })),
  }));
  const groups = [...groupBy(deltas, (d) => d.day).values()];
  return {
    ...result,
    delta: {
      logLoss: average(deltas.map((d) => d.ll)), logLossCI: bootstrap(groups, (d) => average(d.map((x) => x.ll))),
      brier: average(deltas.map((d) => d.brier)), brierCI: bootstrap(groups, (d) => average(d.map((x) => x.brier))),
      byVenue: Object.fromEntries([...groupBy(deltas, (d) => d.venue)]
        .map(([key, items]) => [key, { n: items.length, logLoss: average(items.map((x) => x.ll)) }])),
      byCourseGrade: Object.fromEntries([...groupBy(deltas.flatMap((d) => d.rank), (d) => `${d.course}:${GRADES[d.grade! - 1]}`)]
        .map(([key, items]) => [key, { n: items.length, winBrier: average(items.map((x) => x.winBrier)),
          placeBrier: average(items.map((x) => x.placeBrier)) }])),
    },
  };
}

type BoatOutcome = {
  course: number; grade: number; barrier: number; nearest: number; a1: boolean;
  gap: number; f: boolean | null; position: string; win: number; place: number;
};
type RaceOutcomes = { day: string; venue: string; boats: BoatOutcome[] };

function describe(rows: Row[], cohort: Cohort) {
  const races: RaceOutcomes[] = rows.filter((row) => row.order && !row.inspiration &&
    (cohort === "noex" ? row.full.hasAllGrades : eligible(row, cohort))).map((row) => {
    const f = cohortFeatures(row, cohort);
    const courses = coursesFor(f, cohort);
    const grades = f.gradePoints as number[];
    const barriers = gradeBarrier(grades, courses, 0.5);
    return {
      day: row.race.date, venue: row.race.venue,
      boats: BOATS.map((b, i) => {
        const higher = BOATS.map((_, j) => j).filter((j) => courses[j] < courses[i] && grades[j] > grades[i]);
        return {
          course: courses[i], grade: grades[i], barrier: barriers[i][0],
          nearest: higher.length ? Math.min(...higher.map((j) => courses[i] - courses[j])) : 0,
          gap: higher.length ? Math.max(...higher.map((j) => grades[j] - grades[i])) : 0,
          a1: higher.some((j) => grades[j] === 4),
          f: cohort === "noex" ? null : f.exhibitionF[i],
          position: row.race.result!.finishes.find((x) => x.boat === b)?.position ?? "missing",
          win: Number(row.order![0] === b), place: Number(row.order!.includes(b)),
        };
      }),
    };
  });

  const groups = [...groupBy(races, (r) => r.day).values()];
  function counts(items: BoatOutcome[]) {
    const n = items.length;
    const wins = items.reduce((s, b) => s + b.win, 0);
    const places = items.reduce((s, b) => s + b.place, 0);
    return { n, wins, winRate: n ? wins / n : null, winCI: wilson(wins, n),
      places, placeRate: n ? places / n : null, placeCI: wilson(places, n),
      positions: Object.fromEntries([...groupBy(items, (b) => b.position)].map(([k, v]) => [k, v.length])),
    };
  }
  const boats = races.flatMap((r) => r.boats);
  const table = (key: (b: BoatOutcome) => string) =>
    Object.fromEntries([...groupBy(boats, key)].map(([k, items]) => [k, counts(items)]));

  function contrast(group: (b: BoatOutcome) => number, controlVenue = false) {
    const keyed = races.map((r) => r.boats.flatMap((b) => {
      const side = group(b);
      if (!side) return [];
      return [{ key: `${b.course}:${b.grade}${controlVenue ? ":" + r.venue : ""}`, side: Number(side > 0), b }];
    }));
    function paired(sample: typeof keyed, details = false) {
      const strata = groupBy(sample.flat(), (x) => x.key);
      const cells = [...strata.values()].map((items) => {
        const left = items.filter((x) => x.side === 1).map((x) => x.b);
        const right = items.filter((x) => x.side === 0).map((x) => x.b);
        return { left, right, weight: left.length * right.length / items.length };
      }).filter((x) => x.weight > 0);
      const denom = cells.reduce((sum, x) => sum + x.weight, 0);
      const delta = (field: "win" | "place") => denom ? cells.reduce((sum, x) =>
        sum + x.weight * (average(x.left.map((b) => b[field]))! - average(x.right.map((b) => b[field]))!), 0) / denom : null;
      return {
        strata: cells.length, ...(details ? { left: counts(cells.flatMap((x) => x.left)), right: counts(cells.flatMap((x) => x.right)) } : {}),
        win: delta("win"), place: delta("place"),
      };
    }
    const result = paired(keyed, true);
    if (!result.strata) return result;
    const lookup = new Map(races.map((r, i) => [r, keyed[i]]));
    const blocks = groups.map((items) => items.map((r) => lookup.get(r)!));
    return { ...result, winCI: bootstrap(blocks, (sample) => paired(sample).win, 700),
      placeCI: bootstrap(blocks, (sample) => paired(sample).place, 700) };
  }

  const higher = (b: BoatOutcome) => b.nearest ? 1 : -1;
  const f = (b: BoatOutcome) => b.f === null ? 0 : b.f ? 1 : -1;
  return {
    races: races.length,
    byCourseGrade: table((b) => `${b.course}:${GRADES[b.grade - 1]}`),
    byNearest: table((b) => String(b.nearest)),
    byGap: table((b) => String(b.gap)),
    byH: table((b) => b.barrier === 0 ? "0" : b.barrier < 1 ? "0<H<1" : b.barrier < 2 ? "1<=H<2" : "H>=2"),
    byFandH: table((b) => `${b.f}:${b.nearest > 0}`),
    byCourseGradeDistanceF: table((b) => `${b.course}:${GRADES[b.grade - 1]}:${b.nearest}:${b.f}`),
    contrasts: {
      higher: contrast(higher), higherWithVenue: contrast(higher, true),
      adjacentVsFar: contrast((b) => b.nearest === 1 ? 1 : b.nearest > 1 ? -1 : 0),
      B1InnerA1: contrast((b) => b.grade === 2 ? b.a1 ? 1 : -1 : 0),
      A2InnerA1: contrast((b) => b.grade === 3 ? b.a1 ? 1 : -1 : 0),
      ...(cohort === "noex" ? {} : {
        F: contrast(f), FWithVenue: contrast(f, true),
        FinBarrier: contrast((b) => b.nearest ? f(b) : 0),
        FWithoutBarrier: contrast((b) => b.nearest ? 0 : f(b)),
      }),
    },
  };
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = result.get(id) ?? [];
    group.push(item);
    result.set(id, group);
  }
  return result;
}

const gitHead = (cwd: string) => execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function writeOnce(path: string, content: string) {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) throw new Error(`Existing file differs: ${path}`);
  } else {
    writeFileSync(path, content, { flag: "wx" });
  }
}

function main(args: string[]) {
  const [data, output, localMode, localPath, snapshotPath] = args;
  if (!data || !output || (localMode && !["--sqlite", "--snapshot"].includes(localMode)) ||
      (localMode && !localPath) || (snapshotPath && localMode !== "--sqlite") || args.length > 5) {
    throw new Error("Usage: boatrace-inner-barrier-study.ts DATA_ROOT OUTPUT [--sqlite DATABASE [SNAPSHOT_OUT] | --snapshot SNAPSHOT]");
  }
  const root = resolve(data);
  const dataSha = gitHead(root);
  const { archives, inputFiles, missingDays } = loadArchiveInputs(root);
  if (gitHead(root) !== dataSha) throw new Error("Archive checkout changed while reading inputs");
  const local: Local = localMode === "--sqlite" ? readLocal(localPath) : localMode === "--snapshot"
    ? JSON.parse(readFileSync(localPath, "utf8")) : { records: [], revisions: [], frozen: [] };
  const localJson = JSON.stringify(local) + "\n";
  if (snapshotPath) writeOnce(snapshotPath, localJson);
  const { rows, duplicates } = prepare(archives, local);
  const dates = [...new Set(rows.map(({ race }) => race.date))];
  const count = (filter: (row: Row) => boolean) => rows.filter(filter).length;
  const archiveIds = new Set(archives.flatMap((a) => a.records.map((r) => r.id)));
  const localIds = new Set(local.records.map((r) => r.id));
  const coverage = (items: Row[]) => ({
    races: items.length, official: items.filter((r) => r.race.result?.status === "official").length,
    void: items.filter((r) => r.race.result?.status === "void").length,
    noResult: items.filter((r) => !r.race.result).length, uniqueTop3: items.filter((r) => r.order).length,
    refunds: items.filter((r) => r.race.result?.refundBoats?.length).length,
    programPre: items.filter((r) => r.programPre).length,
    preEx: items.filter((r) => r.pre.exhibitionPreCutoff).length,
    preExComplete: items.filter((r) => r.pre.hasCompleteExhibition).length,
    completeAndProgramPre: items.filter((r) => r.programPre && r.pre.hasCompleteExhibition).length,
    postEx: items.filter((r) => r.full.exhibitionSource && !r.full.exhibitionPreCutoff).length,
    missingEx: items.filter((r) => !r.full.exhibitionSource).length,
    partialEx: items.filter((r) => r.full.exhibitionSource && !r.full.hasCompleteExhibition).length,
    completeEx: items.filter((r) => r.full.hasCompleteExhibition).length,
    missingGrades: items.filter((r) => !r.full.hasAllGrades).length,
    exhibitionNonStandard: items.filter((r) => r.full.exhibitionWakunari === false).length,
  });
  const rowsById = new Map(rows.map((r) => [r.race.id, r]));
  const frozen = local.frozen.flatMap((record) => {
    const row = rowsById.get(record.raceId);
    return row?.order && !row.inspiration && onTime(record.frozenAt, record.cutoff) ? [{
      complete: record.hasPreCutoffExhibition,
      exact: Number(record.predictions.B13v2Pre.top5[0]?.combination === row.order.join("-")),
      top5: Number(record.predictions.B13v2Pre.top5.some((p) => p.combination === row.order!.join("-"))),
    }] : [];
  });
  const report = {
    issue: 129, dataSha, baselineCode: "b13-context-pl-shadow-v2",
    studyFilesSha256: Object.fromEntries(["boatrace-inner-barrier-study.ts", "boatrace-inner-barrier.ts"]
      .map((file) => [file, sha256Hex(readFileSync(new URL(file, import.meta.url)))])),
    archiveManifestSha256: sha256Hex(JSON.stringify(inputFiles)), archiveFiles: inputFiles.length,
    localInputSha256: localMode ? sha256Hex(localJson) : null, missingDays,
    coverage: {
      ...coverage(rows), archiveUnique: archiveIds.size, localUnique: localIds.size,
      overlap: [...archiveIds].filter((id) => localIds.has(id)).length, duplicates,
      venues: new Set(rows.map((r) => r.race.venue)).size,
      inspirationRaces: count((r) => r.inspiration), frozenStored: local.frozen.length,
      byDate: Object.fromEntries([...groupBy(rows, (r) => r.race.date)].map(([k, v]) => [k, coverage(v)])),
      byVenue: Object.fromEntries([...groupBy(rows, (r) => r.race.venue)].map(([k, v]) => [k, coverage(v)])),
    },
    frozenBaseline: { n: frozen.length, complete: frozen.filter((r) => r.complete).length,
      exact: average(frozen.map((r) => r.exact)), top5: average(frozen.map((r) => r.top5)) },
    descriptive: Object.fromEntries((["noex", "pre", "reconstructed"] as const).map((c) => [c, describe(rows, c)])),
    models: Object.fromEntries(names.map((mode) => [mode, walkForward(rows, dates, mode)])),
  };
  writeOnce(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report.coverage, byVenue: undefined, report: output }));
}

function walkForward(rows: Row[], dates: string[], mode: typeof names[number]) {
  const cohort: Cohort = mode === "live" ? "pre" : mode;
  const candidates = variants(cohort);
  const all = new Map([...candidates.map((c) => c.id), "prior-fold-selection"].map((id) => [id, [] as Prediction[]]));
  const rejected = new Set(["H-free", "H-separate-free", "F-free", "F-depth-free", "HF-free"]);
  const folds = [];
  for (const date of dates) {
    const asOf = `${date}T00:00:00+09:00`;
    const training = rows.flatMap((row) => {
      if (row.inspiration || row.race.date >= date || !onTime(row.race.program.fetchedAt, asOf) ||
          (mode !== "reconstructed" && !row.programPre)) return [];
      const order = resultOrderBefore(row, asOf);
      return order ? [{ row, order }] : [];
    });
    const exhibitionKnown = (row: Row) => onTime(row.full.exhibitionFetchedAt, asOf);
    const asSamples = (c: Cohort) => training.map(({ row, order }) => ({
      features: c === "reconstructed" && !exhibitionKnown(row) ? row.pre : cohortFeatures(row, c), order,
    }));
    const primary = mode === "noex" ? fitB13V2NoEx(asSamples("noex")) : fitB13V2(asSamples(cohort));
    if (!primary) continue;
    const fallback = mode === "live" ? fitB13V2NoEx(asSamples("noex"))! : primary;
    const target = rows.filter((row) => row.race.date === date && row.order &&
      (eligible(row, cohort) || (mode === "live" && eligible(row, "noex"))));
    if (!target.length) continue;

    const priorScores = candidates.filter(({ id }) => !rejected.has(id)).map(({ id }) => ({
      id, loss: average(all.get(id)!.flatMap(({ row, scores }) => {
        const order = resultOrderBefore(row, asOf);
        return order ? evaluateScores(scores, order).logLoss! : [];
      })),
    }));
    const selected = priorScores.sort((a, b) => (a.loss ?? Infinity) - (b.loss ?? Infinity))[0].id;
    const fits = candidates.map((candidate) => {
      const train = training.filter(({ row }) => eligible(row, cohort) && (cohort !== "reconstructed" || exhibitionKnown(row)))
        .map(({ row, order }) => ({ ...inputs(row, cohort, primary, candidate), order }));
      const bounds = (train[0]?.matrix[0] ?? []).map((_, j) => !candidate.unrestricted && !(candidate.interaction && j === 2));
      const weights = fitOffsets(train, bounds, candidate.ridge ?? 0.1);
      const fallbackCandidate: Candidate = { id: candidate.id, barrier: candidate.barrier, unrestricted: candidate.unrestricted };
      const fallbackTrain = mode === "live" && candidate.barrier !== undefined
        ? training.filter(({ row }) => eligible(row, "noex"))
          .map(({ row, order }) => ({ ...inputs(row, "noex", fallback, fallbackCandidate), order }))
        : [];
      const fallbackBounds = (fallbackTrain[0]?.matrix[0] ?? []).map(() => !candidate.unrestricted);
      const fallbackWeights = fitOffsets(fallbackTrain, fallbackBounds, candidate.ridge ?? 0.1);
      const result = target.map((row): Prediction => {
        const usable = eligible(row, cohort);
        const effective = usable ? (train.length ? candidate : baseline) :
          (fallbackTrain.length ? fallbackCandidate : baseline);
        const { base, matrix } = inputs(row, usable ? cohort : "noex", usable ? primary : fallback, effective);
        const scores = addTerms(base, matrix, usable ? weights : fallbackWeights);
        return { row, scores, score: evaluateScores(scores, row.order!) };
      });
      all.get(candidate.id)!.push(...result);
      if (candidate.id === selected) all.get("prior-fold-selection")!.push(...result);
      return { id: candidate.id, weights, training: train.length, fallbackWeights, fallbackTraining: fallbackTrain.length,
        logLoss: average(result.map((p) => p.score.logLoss!)),
        completeLogLoss: average(result.filter(({ row }) => eligible(row, cohort)).map((p) => p.score.logLoss!)) };
    });
    folds.push({ date, training: training.length, test: target.length, complete: target.filter((row) => eligible(row, cohort)).length, selected, fits });
  }
  const reference = all.get(baseline.id)!;
  const complete = (p: Prediction[]) => p.filter(({ row }) => eligible(row, cohort));
  const beforeInspiration = (p: Prediction[]) => p.filter(({ row }) => row.race.date < "2026-11-27");
  return {
    folds,
    results: Object.fromEntries([...all].map(([id, predictions]) => [id, {
      all: summarize(predictions, cohort, id === baseline.id ? undefined : reference),
      ...(mode === "live" ? { complete: summarize(complete(predictions), cohort, id === baseline.id ? undefined : complete(reference)) } : {}),
      preInspirationDay: summarize(beforeInspiration(predictions), cohort,
        id === baseline.id ? undefined : beforeInspiration(reference)),
    }])),
  };
}

if (process.argv[1]?.endsWith("boatrace-inner-barrier-study.ts")) main(process.argv.slice(2));
