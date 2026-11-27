import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BOATS, GRADES } from "../packages/shared/src/boatrace";
import { b13Distribution, fitB13, topThree } from "../packages/shared/src/boatrace-b13";
import { fitB13V2, fitB13V2NoEx, predictB13V2 } from "../packages/shared/src/boatrace-b13-v2";
import { loadArchiveInputs, sha256Hex } from "./boatrace-research-cli";
import { before, emptyLocal, exhibitionSt, inspiration, outcome, outcomeClass, prepare, readLocal, resultBefore, type Local, type Row } from "./boatrace-inside-collapse-input";
import { bootstrap, brier, calibrate, fitBinary, fitFactor, groups, loss, marginalize, mean, metrics, outLoss, settings, wilson, type Probabilities } from "./boatrace-inside-collapse-stats";

const cluster = (row: Row) => `${row.race.date}/${row.race.venue}`;
const midnight = (day: string) => `${day}T00:00:00+09:00`;
const isUsable = (row: Row) => !inspiration(row.race) && row.programPre && row.pre.hasAllGrades;
const availableAt = (row: Row, day: string) => row.race.date < day ? resultBefore(row, midnight(day)) : undefined;
const positive = (x: number) => Math.max(0, x);
const pair = (a: number, b: number) => `${Number(a > 0)}${Number(b > 0)}`;
const clean = (row: Row) => row.label === "clean" && !inspiration(row.race);
const KEY = {
  main: "grade-main", signed: "grade-signed", positive: "grade-positive",
  tight: "grade-tight-interaction", day: "grade-meeting", outer: "grade-third-threat",
  ex: "exhibition-time-f", exPair: "exhibition-time-pair", st: "exhibition-time-f-st", stPair: "exhibition-st-pair",
} as const;

function gradePoints(row: Row) {
  return BOATS.map(boat => GRADES.indexOf(row.inputs.entries.find(e => e.boat === boat)?.grade_original as typeof GRADES[number]));
}

function latestTraining(rows: Row[], day: string) {
  return rows.flatMap(row => {
    const result = availableAt(row, day);
    const order = topThree({ ...row.race, result });
    return order ? [{ row, order, y: outcomeClass(order), label: outcome(row.race, result) }] : [];
  });
}

function venuePrior(training: { row: Row; y: number }[], venue: string): Probabilities {
  const local = training.filter(e => e.row.race.venue === venue);
  const prior = BOATS.slice(0, 3).map((_, y) =>
    (training.filter(e => e.y === y).length + 0.5) / (training.length + 1.5));
  return [0, 1, 2].map(y =>
    (local.filter(e => e.y === y).length + settings.priorRaces * prior[y]) / (local.length + settings.priorRaces)) as Probabilities;
}

export function meetingSignal(row: Row, meeting: Row[], priorWin: number) {
  const earlier = meeting.flatMap(other => {
    if (other.race.number >= row.race.number || cluster(other) !== cluster(row)) return [];
    const result = resultBefore(other, row.inputs.cutoff);
    const order = topThree({ ...other.race, result });
    return order ? [Number(order[0] === 1)] : [];
  });
  const wins = earlier.reduce((sum, x) => sum + x, 0);
  const deviation = priorWin - (wins + settings.priorRaces * priorWin) / (earlier.length + settings.priorRaces);
  return { n: earlier.length, wins, deviation };
}

function featureVectors(row: Row, signal: ReturnType<typeof meetingSignal>) {
  const [g1, g2, g3, ...outer] = gradePoints(row);
  const d2 = g2 - g1;
  const d3 = g3 - g1;
  const grades = [g1, g2, g3, ...outer];
  const compact = Number(Math.max(...grades) - Math.min(...grades) <= 1);
  const third = [g2, g3, ...outer].sort((a, b) => b - a)[2] - g1;
  const main = [g1, mean(outer) - g1, d2, d3, compact];
  const vectors: Record<string, number[]> = {
    [KEY.main]: main,
    [KEY.signed]: [...main, d2 * d3],
    [KEY.positive]: [...main, positive(d2) * positive(d3)],
    [KEY.tight]: [...main, d2 * compact, d3 * compact],
    [KEY.day]: [...main, signal.deviation, signal.n],
    [KEY.outer]: [...main, third],
  };
  if (row.pre.hasCompleteExhibition) {
    const [t1, t2, t3] = row.pre.timeZ as number[];
    const courseOne = row.pre.exhibitionOrder!.indexOf("1") + 1;
    const ex = [...main, t1 - t2, t1 - t3, courseOne - 1, ...row.pre.exhibitionF.slice(0, 3).map(Number)];
    vectors[KEY.ex] = ex;
    vectors[KEY.exPair] = [...ex, positive(t1 - t2) * positive(t1 - t3)];
    const st = exhibitionSt(row);
    if (st?.slice(0, 3).every(s => s !== null)) {
      const [s1, s2, s3] = st as number[];
      vectors[KEY.st] = [...ex, s1 - s2, s1 - s3];
      vectors[KEY.stPair] = [...vectors[KEY.st], positive(s1 - s2) * positive(s1 - s3)];
    }
  }
  return vectors;
}

type Scored = { row: Row; y: number; models: Record<string, Probabilities> };
const BASE = "B13v2Pre";
const CALIBRATED = "B13v2Pre-calibrated";
const EX_ST_CONTROL = "exhibition-time-st-sample";
const CORE = ["venue", "B13", "B13v2NoEx", BASE, CALIBRATED, KEY.main, KEY.signed, KEY.positive, KEY.tight, KEY.day, KEY.outer];

function scoreSummary(scored: Scored[], ids: string[]) {
  return Object.fromEntries(ids.map(id => [id, metrics(scored.map(r => ({ y: r.y, p: r.models[id] })))]));
}

function difference(scored: Scored[], model: string, comparator: string) {
  const measures = {
    multiclass: (y: number, p: Probabilities) => loss(p[y]),
    outLogLoss: outLoss,
    outBrier: brier,
  };
  return Object.fromEntries(Object.entries(measures).map(([name, measure]) => {
    const blocks = [...groups(scored, e => cluster(e.row)).values()].map(block =>
      [block.reduce((sum, e) => sum + measure(e.y, e.models[model]) - measure(e.y, e.models[comparator]), 0), block.length]);
    const stat = (sample: number[][]) => sample.reduce((sum, b) => sum + b[0], 0) / sample.reduce((n, b) => n + b[1], 0);
    return [name, { delta: blocks.length ? stat(blocks) : null, interval95: bootstrap(blocks, stat), clusters: blocks.length }];
  }));
}

function comparison(scored: Scored[], ids: string[]) {
  return {
    models: scoreSummary(scored, ids),
    vsB13v2Pre: Object.fromEntries(ids.filter(id => id !== BASE).map(id => [id, difference(scored, id, BASE)])),
    vsVenue: Object.fromEntries(ids.filter(id => id !== "venue").map(id => [id, difference(scored, id, "venue")])),
    vsGradeMain: Object.fromEntries(ids.filter(id => id.startsWith("grade-") && id !== KEY.main)
      .map(id => [id, difference(scored, id, KEY.main)])),
  };
}

function classRates(rows: Row[]) {
  const classes = [0, 1, 2].map(y => rows.filter(r => outcomeClass(r.order!) === y).length);
  return { n: rows.length, classes, intervals95: classes.map(n => wilson(n, rows.length)),
    conditionalOut95: wilson(classes[2], classes[1] + classes[2]) };
}

function describe(rows: Row[], signals: Map<Row, ReturnType<typeof meetingSignal>>) {
  const pool = rows.filter(clean).filter(r => r.pre.hasAllGrades);
  const full = pool.filter(r => r.programPre && r.pre.hasCompleteExhibition);
  const tabulate = (sample: Row[], key: (row: Row) => string) =>
    Object.fromEntries([...groups(sample, key)].sort(([a], [b]) => a.localeCompare(b)).map(([k, subset]) => [k, classRates(subset)]));
  const gradePair = (r: Row) => {
    const [g1, g2, g3] = gradePoints(r);
    return pair(g2 - g1, g3 - g1);
  };
  const table = (sample: Row[]) => ({
    byPair: tabulate(sample, gradePair),
    byVenue: tabulate(sample, r => r.race.venue),
    byGradeArray: tabulate(sample, r => gradePoints(r).map(g => GRADES[g]).join("-")),
    byFirstGradeAndPair: tabulate(sample, r => `${GRADES[gradePoints(r)[0]]}/${gradePair(r)}`),
    byVenueFirstGradeAndPair: tabulate(sample, r => `${r.race.venue}/${GRADES[gradePoints(r)[0]]}/${gradePair(r)}`),
  });
  type Cell = { n: number; outs: number };
  const blocks = [...groups(pool.filter(isUsable), cluster).values()].map(block =>
    new Map([...groups(block, r => `${r.race.venue}/${gradePoints(r)[0]}/${gradePair(r)}`)]
      .map(([key, rows]) => [key, { n: rows.length, outs: rows.filter(r => outcomeClass(r.order!) === 2).length }])));
  function interaction(sample: Map<string, Cell>[]) {
    const cells = new Map<string, Cell>();
    for (const block of sample) for (const [key, value] of block) {
      const old = cells.get(key) ?? { n: 0, outs: 0 };
      cells.set(key, { n: old.n + value.n, outs: old.outs + value.outs });
    }
    const strata = groups([...cells.entries()], ([key]) => key.slice(0, -3));
    const effects = [...strata.values()].flatMap(items => {
      const sorted = items.sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
      if (sorted.length !== 4) return [];
      const rates = sorted.map(c => c.outs / c.n);
      return [{ weight: 4 / sorted.reduce((sum, c) => sum + 1 / c.n, 0),
        contrast: rates[3] - rates[2] - rates[1] + rates[0], n: sorted.reduce((sum, c) => sum + c.n, 0) }];
    });
    return { strata: effects.length, n: effects.reduce((sum, e) => sum + e.n, 0), delta: effects.length
      ? effects.reduce((sum, e) => sum + e.weight * e.contrast, 0) / effects.reduce((sum, e) => sum + e.weight, 0) : null };
  }
  const stAvailable = full.filter(r => exhibitionSt(r)?.slice(0, 3).every(s => s !== null));
  return {
    clean: classRates(pool),
    allSavedGrades: table(pool),
    preGrades: table(pool.filter(isUsable)),
    matchedRiskInteraction: { ...interaction(blocks), clusters: blocks.length,
      interval95: bootstrap(blocks, sample => interaction(sample).delta) },
    byCompact: tabulate(pool.filter(isUsable), r => {
      const g = gradePoints(r);
      return `${Math.max(...g) - Math.min(...g) <= 1 ? "narrow" : "wide"}/${g.every(v => v >= 2) ? "allA" : "mixed"}/${gradePair(r)}`;
    }),
    bySTPair: tabulate(stAvailable, r => {
      const [s1, s2, s3] = exhibitionSt(r) as number[];
      return pair(s1 - s2, s1 - s3);
    }),
    byTimePair: tabulate(full, r => {
      const [t1, t2, t3] = r.pre.timeZ as number[];
      return pair(t1 - t2, t1 - t3);
    }),
    byExhibitionF: tabulate(full, r => r.pre.exhibitionF.slice(0, 3).map(Number).join("")),
    byExhibitionCourse: tabulate(full, r => String(r.pre.exhibitionOrder!.indexOf("1") + 1)),
    byMeetingSignal: tabulate(pool.filter(isUsable), r => {
      const { n, deviation } = signals.get(r)!;
      return n === 0 ? "none" : `${n >= 4 ? "4+" : "1-3"}/${deviation > 0 ? "below-prior" : "at-or-above-prior"}`;
    }),
  };
}

function replayFrozen(rows: Row[], local: Local, replayed: Scored[]) {
  const byId = new Map(rows.map(r => [r.race.id, r]));
  let top5Verified = 0, top5Mismatch = 0, missingWeights = 0;
  const scored = local.frozen.flatMap(frozen => {
    const row = byId.get(frozen.raceId);
    if (!row || !before(frozen.frozenAt, frozen.cutoff)) return [];
    const cached = local.models.find(m => m.date === frozen.date);
    const model = frozen.preUsedNoEx ? cached?.modelNoEx : cached?.modelPre;
    if (!model) { missingWeights++; return []; }
    const { distribution } = predictB13V2(model, frozen.inputs);
    const original = frozen.predictions.B13v2Pre.top5;
    if (original.length !== 5 || !original.every((e, i) =>
      e.combination === distribution[i].combination && Math.abs(e.probability - distribution[i].probability) < 1e-10)) {
      top5Mismatch++;
      return [];
    }
    top5Verified++;
    return clean(row) ? [{ row, y: outcomeClass(row.order!), p: marginalize(distribution) }] : [];
  });
  const comparisonById = new Map(replayed.map(e => [e.row.race.id, e.models]));
  const paired = scored.flatMap(e => {
    const models = comparisonById.get(e.row.race.id);
    return models ? [{ row: e.row, y: e.y, models: { ...models, frozen: e.p } }] : [];
  });
  const ids = ["frozen", BASE, "venue", KEY.main, CALIBRATED];
  return { saved: local.frozen.length, top5Verified, top5Mismatch, missingWeights, cleanMetrics: metrics(scored),
    paired: scoreSummary(paired, ids),
    vsFrozen: Object.fromEntries(ids.slice(1).map(id => [id, difference(paired, id, "frozen")])) };
}

function walkForward(rows: Row[], includeNonstandard = false) {
  const usable = rows.filter(isUsable);
  const meetings = groups(rows.filter(r => !inspiration(r.race)), cluster);
  const days = [...new Set(usable.map(r => r.race.date))].sort();
  const trainingByDay = new Map(days.map(day => [day, latestTraining(usable, day)]));
  const signals = new Map(usable.map(row => {
    const prior = venuePrior(trainingByDay.get(row.race.date)!, row.race.venue);
    return [row, meetingSignal(row, meetings.get(cluster(row))!, prior[0])];
  }));
  const vectors = new Map(usable.map(row => [row, featureVectors(row, signals.get(row)!)]));
  const scored: Scored[] = [];
  const pastForecasts: { row: Row; p: Probabilities }[] = [];
  const folds = days.map(day => {
    const train = trainingByDay.get(day)!;
    const candidateTrain = train.filter(e => e.label === "clean" || includeNonstandard);
    const scores = train.map(e => ({ features: e.row.pre, order: e.order }));
    const b13 = fitB13(train.map(e => e.order));
    const pre = fitB13V2(scores);
    const noex = fitB13V2NoEx(scores);
    const calibration = calibrate(pastForecasts.flatMap(({ row, p }) => {
      const result = availableAt(row, day);
      if (!result) return [];
      const label = outcome(row.race, result);
      if (label !== "clean" && !(includeNonstandard && label === "nonstandard")) return [];
      return [{ p, y: outcomeClass(topThree({ ...row.race, result })!) }];
    }));
    const forecasts = new Map(Object.values(KEY).map(id => [String(id), fitFactor(candidateTrain.flatMap(e => {
      const x = vectors.get(e.row)![id];
      return x ? [{ x, y: e.y }] : [];
    }))]));
    forecasts.set(EX_ST_CONTROL, fitFactor(candidateTrain.flatMap(e => {
      const v = vectors.get(e.row)!;
      return v[KEY.st] ? [{ x: v[KEY.ex], y: e.y }] : [];
    })));
    const targets = usable.filter(r => r.race.date === day);
    const eligible = new Set(targets.filter(r => r.label === "clean" || (includeNonstandard && r.label === "nonstandard")));
    const dayScored: Scored[] = [];
    if (b13 && noex && forecasts.get(KEY.main)) {
      for (const row of targets) {
        const v = vectors.get(row)!;
        const noExProb = marginalize(predictB13V2(noex, row.pre).distribution);
        const baseline = pre && row.pre.hasCompleteExhibition ? marginalize(predictB13V2(pre, row.pre).distribution) : noExProb;
        pastForecasts.push({ row, p: baseline });
        if (!eligible.has(row)) continue;
        const models: Record<string, Probabilities> = {
          venue: venuePrior(candidateTrain, row.race.venue),
          B13: marginalize(b13Distribution(b13)),
          B13v2NoEx: noExProb,
          [BASE]: baseline,
          [CALIBRATED]: calibration.n ? calibration.predict(baseline) : baseline,
        };
        for (const id of Object.values(KEY)) {
          const model = forecasts.get(id);
          if (v[id] && model) models[id] = model.predict(v[id]);
        }
        const stControl = forecasts.get(EX_ST_CONTROL);
        if (v[KEY.st] && stControl) models[EX_ST_CONTROL] = stControl.predict(v[KEY.ex]);
        dayScored.push({ row, y: outcomeClass(row.order!), models });
      }
    }
    scored.push(...dayScored);
    const serialize = (model: NonNullable<ReturnType<typeof fitFactor>>["q"]) =>
      ({ n: model.n, weights: model.weights, center: model.center, scale: model.scale });
    return { day, train: train.length, candidateTrain: candidateTrain.length, eligible: eligible.size, scored: dayScored.length,
      completeExhibitionTrain: train.filter(e => e.row.pre.hasCompleteExhibition).length,
      calibration: { n: calibration.n, q: calibration.interceptQ, r: calibration.interceptR },
      dailyMain: scoreSummary(dayScored, CORE),
      fits: Object.fromEntries([...forecasts].map(([id, f]) => [id, f ? { q: serialize(f.q), r: serialize(f.r) } : null])),
    };
  });
  const exhibition = scored.filter(e => e.models[KEY.ex] && e.models[KEY.exPair]);
  const st = scored.filter(e => e.models[KEY.st] && e.models[KEY.stPair] && e.models[EX_ST_CONTROL]);
  const early = scored.filter(e => e.row.race.date < "2026-11-27");
  const lastDay = days.at(-1);
  const finalTrain = lastDay ? trainingByDay.get(lastDay)!.filter(e => e.label === "clean") : [];
  const coefficients = includeNonstandard ? null : Object.fromEntries([KEY.signed, KEY.positive].map(id => [id,
    Object.fromEntries((["q", "r"] as const).map(stage => {
      const training = finalTrain.filter(e => stage === "q" || e.y !== 0);
      const blocks = [...groups(training, e => cluster(e.row)).values()];
      const fit = (sample: typeof training) => fitBinary(sample.map(e => ({
        x: vectors.get(e.row)![id], y: Number(stage === "q" ? e.y !== 0 : e.y === 2),
      })))?.weights.at(-1) ?? null;
      return [stage, { estimate: fit(training), n: training.length, clusters: blocks.length,
        interval95: bootstrap(blocks, sample => fit(sample.flat()), settings.coefficientBootstrap) }];
    }))]));
  return { folds, signals, scored, summary: {
    allPaired: comparison(scored, CORE),
    preExhibition: { ...comparison(exhibition, [...CORE, KEY.ex, KEY.exPair]),
      timeInteractionAdded: difference(exhibition, KEY.exPair, KEY.ex) },
    noCompleteExhibition: comparison(scored.filter(e => !e.row.pre.hasCompleteExhibition), CORE),
    exhibitionST: {
      models: scoreSummary(st, [...CORE, EX_ST_CONTROL, KEY.st, KEY.stPair]),
      stAdded: difference(st, KEY.st, EX_ST_CONTROL),
      stInteractionAdded: difference(st, KEY.stPair, KEY.st),
    },
    beforeInspirationDay: comparison(early, CORE),
    afterCalibrationWarmup: comparison(scored.filter(e => folds.some(f => f.day === e.row.race.date && f.calibration.n > 0)), CORE),
    lastFoldInteractionCoefficients: { day: lastDay, coefficients },
    byExhibitionCourse: Object.fromEntries([...groups(exhibition, e => String(e.row.pre.exhibitionOrder!.indexOf("1") + 1))]
      .map(([course, block]) => [course, scoreSummary(block, [BASE, KEY.main, KEY.ex])])),
  } };
}

function audit(data: ReturnType<typeof loadArchiveInputs>, local: Local, prepared: ReturnType<typeof prepare>) {
  const { rows } = prepared;
  const archiveIds = new Set(data.archives.flatMap(a => a.records.map(r => r.id)));
  const localIds = new Set(local.records.map(r => r.id));
  const archiveOnly = prepare(data.archives, emptyLocal);
  const count = (filter: (r: Row) => boolean) => rows.filter(filter).length;
  const inputs = (r: Row, keys: string[], source: "entries" | "exhibition") => {
    const value = source === "entries" ? r.inputs.entries : r.race.exhibition?.entries ?? [];
    return value.length === 6 && value.every(entry => keys.some(key => {
      const field = (entry as unknown as Record<string, unknown>)[key];
      return typeof field === "number" && Number.isFinite(field);
    }));
  };
  return {
    unique: rows.length, archiveRaces: archiveIds.size, localRaces: localIds.size,
    archiveOnly: [...archiveIds].filter(id => !localIds.has(id)).length,
    localOnly: [...localIds].filter(id => !archiveIds.has(id)).length,
    archiveTopThree: archiveOnly.rows.filter(r => r.order).length, combinedTopThree: count(r => r.order !== null),
    raceIdsRepeated: prepared.duplicateRaces, resultTimestampConflicts: prepared.resultTimestampConflicts,
    venues: [...new Set(rows.map(r => r.race.venue))].sort(),
    byDay: Object.fromEntries([...groups(rows, r => r.race.date)].map(([day, block]) =>
      [day, { races: block.length, clean: block.filter(r => r.label === "clean").length,
        programPre: block.filter(r => r.programPre).length, completePre: block.filter(r => r.pre.hasCompleteExhibition).length }])),
    outcomes: Object.fromEntries([...groups(rows, r => r.label)].map(([label, block]) => [label, block.length])),
    inspiration: count(r => inspiration(r.race)),
    programPre: count(r => r.programPre), gradesComplete: count(r => r.pre.hasAllGrades),
    resultRevised: count(r => r.revisions.length > 1),
    exhibitionNone: count(r => !r.hasAnyExhibition),
    exhibitionLateOrUntimed: count(r => r.hasAnyExhibition && !r.hasTimelyExhibition),
    exhibitionTimelyIncomplete: count(r => r.hasTimelyExhibition && !r.pre.hasCompleteExhibition),
    exhibitionTimelyComplete: count(r => r.pre.hasCompleteExhibition),
    featuresComplete: {
      nationalWinRate: count(r => inputs(r, ["nationalWinRate"], "entries")),
      motor2Rate: count(r => inputs(r, ["motorRate2", "motor2Rate"], "entries")),
      lap: count(r => inputs(r, ["lap", "lapTime"], "exhibition")),
      turn: count(r => inputs(r, ["turn", "turnTime"], "exhibition")),
      straight: count(r => inputs(r, ["straight", "straightTime"], "exhibition")),
    },
  };
}

function main(args: string[]) {
  const [dataRoot, output, mode, input, snapshot] = args;
  if (!dataRoot || !output || (args.length !== 2 &&
    !(mode === "--sqlite" && input && snapshot && args.length === 5) &&
    !(mode === "--snapshot" && input && args.length === 4))) {
    throw new Error("Usage: boatrace-inside-collapse-study DATA_ROOT REPORT [--sqlite DB SNAPSHOT | --snapshot SNAPSHOT]");
  }
  const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const dataSha = git(dataRoot, ["rev-parse", "HEAD"]);
  const data = loadArchiveInputs(dataRoot);
  if (!data.archives.length) throw new Error("No boat archives");
  const localRaw = mode === "--sqlite" ? JSON.stringify(readLocal(input)) : mode === "--snapshot" ? readFileSync(input, "utf8") : null;
  if (mode === "--sqlite") writeFileSync(snapshot, localRaw!, { flag: "wx" });
  const local = localRaw ? JSON.parse(localRaw) as Local : emptyLocal;
  const prepared = prepare(data.archives, local);
  const primary = walkForward(prepared.rows);
  const sensitivity = walkForward(prepared.rows, true);
  const report = {
    schema: "inside-collapse-v1",
    provenance: {
      codeSha: git(".", ["rev-parse", "HEAD"]), dataSha, archiveFiles: data.inputFiles.length,
      archiveManifestSha256: sha256Hex(JSON.stringify(data.inputFiles)), missingDays: data.missingDays,
      localSnapshotSha256: localRaw ? sha256Hex(localRaw) : null, node: process.version,
    },
    settings,
    modelFeatures: {
      [KEY.main]: ["grade1", "outerMeanMinus1", "d2", "d3", "compact"],
      [KEY.signed]: ["main", "d2*d3"], [KEY.positive]: ["main", "positive(d2)*positive(d3)"],
      [KEY.tight]: ["main", "d2*compact", "d3*compact"],
      [KEY.day]: ["main", "priorMinusShrunk1WinRate", "priorResultsKnown"],
      [KEY.outer]: ["main", "thirdBestOpponentMinus1"],
      [KEY.ex]: ["main", "timeZ1-timeZ2", "timeZ1-timeZ3", "exhibitionCourse1-1", "F1", "F2", "F3"],
      [KEY.exPair]: ["exhibition", "positive(timeZ1-timeZ2)*positive(timeZ1-timeZ3)"],
      [KEY.st]: ["exhibition", "ST1-ST2", "ST1-ST3"],
      [KEY.stPair]: ["ST", "positive(ST1-ST2)*positive(ST1-ST3)"],
    },
    audit: audit(data, local, prepared),
    descriptive: describe(prepared.rows, primary.signals),
    primary: { folds: primary.folds, ...primary.summary },
    sensitivityIncludingNonstandard: sensitivity.summary.allPaired,
    frozenB13v2Pre: replayFrozen(prepared.rows, local, primary.scored),
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ provenance: report.provenance, audit: report.audit }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
