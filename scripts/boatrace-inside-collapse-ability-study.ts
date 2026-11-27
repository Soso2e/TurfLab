import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BOATS, GRADES } from "../packages/shared/src/boatrace";
import { topThree } from "../packages/shared/src/boatrace-b13";
import type { BackfillDayFile, BackfillRaceRecord } from "./boatrace-backfill";
import {
  bootstrap,
  brier,
  factor,
  fitFactor,
  groups,
  loss,
  mean,
  metrics,
  outLoss,
  settings,
  sigmoid,
  wilson,
  type Probabilities,
} from "./boatrace-inside-collapse-stats";

type OutcomeLabel = "clean" | "nonstandard" | "void" | "missing";

interface PreparedRace {
  race: BackfillRaceRecord;
  label: OutcomeLabel;
  order: readonly number[] | null;
  y: number | null;
  cluster: string;
  grades: number[];
  winRates: number[];
  localWinRates: number[];
  motor2Rates: number[];
  avgSts: number[];
  exTimes: number[] | null;
  exSts: number[] | null;
  exFlying: boolean[];
  exCourse1: number | null;
  hasCompleteRacelist: boolean;
  hasCompleteExhibition: boolean;
  hasCompleteSt: boolean;
}

function classifyOutcome(race: BackfillRaceRecord): {
  label: OutcomeLabel;
  order: readonly number[] | null;
} {
  const result = race.result;
  if (!result) return { label: "missing", order: null };
  if (result.status === "void") return { label: "void", order: null };
  const order = topThree({
    id: race.id,
    date: race.date,
    venue: race.venue,
    venueName: race.venueName,
    number: race.number,
    cutoff: race.cutoff,
    program: result.evidence,
    entries: race.racelist.map((e) => ({ boat: e.boat, name: e.name, grade_original: e.grade })),
    result,
  });
  if (!order) return { label: "nonstandard", order: null };
  const boats = result.finishes.map((f) => f.boat).sort().join("");
  const positions = result.finishes.map((f) => f.position).sort().join("");
  const clean = boats === "123456" && positions === "123456" && result.refundBoats.length === 0;
  return { label: clean ? "clean" : "nonstandard", order };
}

function outcomeClass(order: readonly number[]): number {
  return order[0] === 1 ? 0 : order.includes(1) ? 1 : 2;
}

export function loadBackfillDays(dataRoot: string): BackfillDayFile[] {
  const dir = join(resolve(dataRoot), "boatrace-research", "backfill");
  if (!existsSync(dir)) throw new Error(`Backfill directory not found: ${dir}`);
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BackfillDayFile);
}

export function prepareBackfill(days: BackfillDayFile[]): PreparedRace[] {
  const rows: PreparedRace[] = [];
  for (const day of days) {
    for (const race of day.races) {
      const { label, order } = classifyOutcome(race);
      const byBoat = new Map(race.racelist.map((e) => [e.boat, e]));
      const hasAll6 = BOATS.every((b) => byBoat.has(b));
      const grades = BOATS.map((b) => {
        const g = byBoat.get(b)?.grade;
        return g ? GRADES.indexOf(g) : -1;
      });
      const winRates = BOATS.map((b) => byBoat.get(b)?.nationalWinRate ?? NaN);
      const localWinRates = BOATS.map((b) => byBoat.get(b)?.localWinRate ?? NaN);
      const motor2Rates = BOATS.map((b) => byBoat.get(b)?.motor2Rate ?? NaN);
      const avgSts = BOATS.map((b) => byBoat.get(b)?.avgSt ?? NaN);
      const hasCompleteRacelist =
        hasAll6 &&
        grades.every((g) => g >= 0) &&
        winRates.every(Number.isFinite) &&
        motor2Rates.every(Number.isFinite);

      const bf = race.beforeinfo;
      const exTimesRaw = bf ? BOATS.map((b) => bf.times[b] ?? NaN) : [];
      const hasTimes = exTimesRaw.length === 6 && exTimesRaw.every(Number.isFinite);
      const exEntries = bf ? new Map(bf.entries.map((e) => [e.boat, e])) : new Map();
      const hasCourses =
        exEntries.size === 6 &&
        new Set([...exEntries.values()].map((e) => e.course)).size === 6;
      const hasCompleteExhibition = hasTimes && hasCourses;
      const exFlying = BOATS.map((b) => exEntries.get(b)?.flying === true);
      const exStsRaw = BOATS.map((b) => {
        const e = exEntries.get(b);
        if (!e || e.flying !== false) return NaN;
        const raw = e.st.trim();
        return /^(?:0?\.\d+)$/.test(raw) ? Number(raw) : NaN;
      });
      const hasCompleteSt = hasCompleteExhibition && exStsRaw.every(Number.isFinite);
      const exCourse1 = hasCourses ? (exEntries.get(1)?.course ?? null) : null;

      rows.push({
        race,
        label,
        order,
        y: order ? outcomeClass(order) : null,
        cluster: `${race.date}/${race.venue}`,
        grades,
        winRates,
        localWinRates,
        motor2Rates,
        avgSts,
        exTimes: hasTimes ? exTimesRaw : null,
        exSts: hasCompleteSt ? exStsRaw : null,
        exFlying,
        exCourse1,
        hasCompleteRacelist,
        hasCompleteExhibition,
        hasCompleteSt,
      });
    }
  }
  return rows;
}

function classRates(rows: PreparedRace[]) {
  const valid = rows.filter((r) => r.y !== null);
  const classes = [0, 1, 2].map((y) => valid.filter((r) => r.y === y).length);
  return {
    n: valid.length,
    classes,
    rates: classes.map((c) => (valid.length ? +(c / valid.length).toFixed(4) : null)),
    outWilson95: wilson(classes[2], valid.length),
    conditionalOut95: wilson(classes[2], classes[1] + classes[2]),
  };
}

function tabulate(rows: PreparedRace[], keyFn: (r: PreparedRace) => string | null) {
  const filtered = rows.filter((r) => r.y !== null && keyFn(r) !== null);
  return Object.fromEntries(
    [...groups(filtered, (r) => keyFn(r)!)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, subset]) => [k, classRates(subset)]),
  );
}

const pos = (x: number) => Math.max(0, x);
const pairKey = (d2: number, d3: number) => `${Number(d2 > 0)}${Number(d3 > 0)}`;

function describeAbility(rows: PreparedRace[]) {
  const pool = rows.filter((r) => r.label === "clean" && r.hasCompleteRacelist);
  const exPool = pool.filter((r) => r.hasCompleteExhibition);
  const stPool = pool.filter((r) => r.hasCompleteSt);

  return {
    totalCleanWithRacelist: pool.length,
    totalCleanWithExhibition: exPool.length,
    totalCleanWithSt: stPool.length,
    overall: classRates(pool),
    byGradePair: tabulate(pool, (r) => pairKey(r.grades[1] - r.grades[0], r.grades[2] - r.grades[0])),
    byWinRatePair: tabulate(pool, (r) => pairKey(r.winRates[1] - r.winRates[0], r.winRates[2] - r.winRates[0])),
    byWinRateDiffBand: tabulate(pool, (r) => {
      const max23 = Math.max(r.winRates[1], r.winRates[2]) - r.winRates[0];
      if (max23 <= -1.0) return "1_dominant(<= -1.0)";
      if (max23 <= 0.0) return "2_edge(-1.0..0.0)";
      if (max23 <= 1.0) return "3_23_slightly_higher(0.0..1.0)";
      return "4_23_clearly_higher(> 1.0)";
    }),
    byMotor2Pair: tabulate(pool, (r) => pairKey(r.motor2Rates[1] - r.motor2Rates[0], r.motor2Rates[2] - r.motor2Rates[0])),
    byMotor2DiffBand: tabulate(pool, (r) => {
      const max23 = Math.max(r.motor2Rates[1], r.motor2Rates[2]) - r.motor2Rates[0];
      if (max23 <= -10) return "1_motor_1_dominant(<= -10)";
      if (max23 <= 0) return "2_motor_1_edge(-10..0)";
      if (max23 <= 10) return "3_motor_23_edge(0..10)";
      return "4_motor_23_strong(> 10)";
    }),
    byAvgStPair: tabulate(
      pool.filter((r) => Number.isFinite(r.avgSts[0]) && Number.isFinite(r.avgSts[1]) && Number.isFinite(r.avgSts[2])),
      (r) => pairKey(r.avgSts[0] - r.avgSts[1], r.avgSts[0] - r.avgSts[2]),
    ),
    byExTimePair: tabulate(exPool, (r) => pairKey(r.exTimes![0] - r.exTimes![1], r.exTimes![0] - r.exTimes![2])),
    byExStPair: tabulate(stPool, (r) => pairKey(r.exSts![0] - r.exSts![1], r.exSts![0] - r.exSts![2])),
    byExCourse1: tabulate(exPool, (r) => (r.exCourse1 === 1 ? "course1" : `moved_to_${r.exCourse1}`)),
    byCombined23AdvantageCount: tabulate(exPool, (r) => {
      // 2・3号艇のどちらかが全国勝率・モーター・展示タイムの3指標それぞれで1号艇を上回る数
      const winAdv = Number(Math.max(r.winRates[1], r.winRates[2]) > r.winRates[0]);
      const motAdv = Number(Math.max(r.motor2Rates[1], r.motor2Rates[2]) > r.motor2Rates[0]);
      const timeAdv = Number(Math.min(r.exTimes![1], r.exTimes![2]) < r.exTimes![0]);
      return `adv_${winAdv + motAdv + timeAdv}_of_3`;
    }),
  };
}

function venuePrior(training: PreparedRace[], venue: string): Probabilities {
  const local = training.filter((r) => r.race.venue === venue);
  const prior = [0, 1, 2].map(
    (y) => (training.filter((r) => r.y === y).length + 0.5) / (training.length + 1.5),
  );
  return [0, 1, 2].map(
    (y) => (local.filter((r) => r.y === y).length + settings.priorRaces * prior[y]) / (local.length + settings.priorRaces),
  ) as Probabilities;
}

function globalPrior(training: PreparedRace[]): Probabilities {
  return [0, 1, 2].map(
    (y) => (training.filter((r) => r.y === y).length + 0.5) / (training.length + 1.5),
  ) as Probabilities;
}

function logitsFromProb(p: Probabilities) {
  const lo = (x: number) => Math.log(Math.max(1e-12, x) / Math.max(1e-12, 1 - x));
  return [lo(p[1] + p[2]), lo(p[2] / (p[1] + p[2]))] as const;
}

function fitOffsetBinary(examples: readonly { offset: number; x: number[]; y: number }[]) {
  if (!examples.length) return null;
  const center = examples[0].x.map((_, j) => mean(examples.map((e) => e.x[j])));
  const scale = center.map((v, j) => Math.sqrt(mean(examples.map((e) => (e.x[j] - v) ** 2))) || 1);
  const transform = (x: number[]) => [
    1,
    ...x.map((v, j) => Math.max(-5, Math.min(5, (v - center[j]) / scale[j]))),
  ];
  const training = examples.map((e) => ({ offset: e.offset, x: transform(e.x), y: e.y }));
  const weights = [0, ...center.map(() => 0)];
  for (let i = 0; i < settings.iterations; i++) {
    const gradient = weights.map((w) => settings.ridge * w);
    gradient[0] = 0;
    for (const { offset, x, y } of training) {
      const z = offset + x.reduce((s, v, j) => s + v * weights[j], 0);
      const residual = (sigmoid(z) - y) / training.length;
      x.forEach((v, j) => {
        gradient[j] += residual * v;
      });
    }
    let movement = 0;
    weights.forEach((w, j) => {
      const change = settings.step * gradient[j];
      weights[j] = w - change;
      movement = Math.max(movement, Math.abs(change));
    });
    if (movement < 1e-8) break;
  }
  return {
    predict: (offset: number, x: number[]) => {
      const tx = transform(x);
      return sigmoid(offset + tx.reduce((s, v, j) => s + v * weights[j], 0));
    },
  };
}

function fitOffsetFactor(examples: readonly { offset: [number, number]; x: number[]; y: number }[]) {
  const q = fitOffsetBinary(examples.map((e) => ({ offset: e.offset[0], x: e.x, y: Number(e.y !== 0) })));
  const r = fitOffsetBinary(
    examples.filter((e) => e.y !== 0).map((e) => ({ offset: e.offset[1], x: e.x, y: Number(e.y === 2) })),
  );
  return q && r
    ? { predict: (offset: [number, number], x: number[]) => factor(q.predict(offset[0], x), r.predict(offset[1], x)) }
    : null;
}

function buildVectors(r: PreparedRace): Record<string, number[]> {
  const [g1, g2, g3, g4, g5, g6] = r.grades;
  const gOuterMean = mean([g4, g5, g6]);
  const gCompact = Number(Math.max(...r.grades) - Math.min(...r.grades) <= 1);
  const gradeMain = [g1, gOuterMean - g1, g2 - g1, g3 - g1, gCompact];

  const [w1, w2, w3, w4, w5, w6] = r.winRates;
  const wOuterMax = Math.max(w4, w5, w6);
  const wOuterMean = mean([w4, w5, w6]);
  const dw2 = w2 - w1;
  const dw3 = w3 - w1;

  const [m1, m2, m3, m4, m5, m6] = r.motor2Rates;
  const dm2 = m2 - m1;
  const dm3 = m3 - m1;
  const mOuterMax = Math.max(m4, m5, m6);

  const avgSt1 = Number.isFinite(r.avgSts[0]) ? r.avgSts[0] : 0.17;
  const avgSt2 = Number.isFinite(r.avgSts[1]) ? r.avgSts[1] : 0.17;
  const avgSt3 = Number.isFinite(r.avgSts[2]) ? r.avgSts[2] : 0.17;

  const abilityProgramCompact = [
    w1,
    dw2,
    dw3,
    wOuterMax - w1,
    wOuterMean - w1,
    m1,
    dm2,
    dm3,
    mOuterMax - m1,
  ];
  const abilityProgramFull = [
    ...abilityProgramCompact,
    g1,
    g2 - g1,
    g3 - g1,
    avgSt1,
    avgSt1 - avgSt2,
    avgSt1 - avgSt3,
  ];
  const abilityProgramSynergy = [
    ...abilityProgramCompact,
    pos(dw2) * pos(dw3),
    pos(dm2) * pos(dm3),
  ];

  const vectors: Record<string, number[]> = {
    "grade-main": gradeMain,
    "grade-synergy": [...gradeMain, pos(g2 - g1) * pos(g3 - g1)],
    "ability-program-compact": abilityProgramCompact,
    "ability-program-full": abilityProgramFull,
    "ability-program-synergy": abilityProgramSynergy,
  };

  if (r.hasCompleteExhibition) {
    const [t1, t2, t3, t4, t5, t6] = r.exTimes!;
    const dt2 = t1 - t2; // positive = boat 2 faster
    const dt3 = t1 - t3;
    const dtOuterBest = t1 - Math.min(t4, t5, t6);
    const movedCourse1 = Number(r.exCourse1 !== 1);
    const exF = r.exFlying.slice(0, 3).map(Number);

    const abilityEx = [
      ...abilityProgramCompact,
      dt2,
      dt3,
      dtOuterBest,
      movedCourse1,
      ...exF,
    ];
    vectors["ability-ex"] = abilityEx;
    vectors["ability-ex-synergy"] = [...abilityEx, pos(dw2) * pos(dw3), pos(dt2) * pos(dt3)];

    if (r.hasCompleteSt) {
      const [s1, s2, s3] = r.exSts!;
      const ds2 = s1 - s2; // positive = boat 2 faster ST
      const ds3 = s1 - s3;
      vectors["ability-full"] = [...abilityEx, ds2, ds3];
      vectors["ability-full-synergy"] = [...abilityEx, ds2, ds3, pos(ds2) * pos(ds3)];
    }
  }

  return vectors;
}

type Scored = { row: PreparedRace; y: number; models: Record<string, Probabilities> };

function difference(scored: Scored[], model: string, comparator: string) {
  const measures = {
    multiclass: (y: number, p: Probabilities) => loss(p[y]),
    outLogLoss: outLoss,
    outBrier: brier,
  };
  return Object.fromEntries(
    Object.entries(measures).map(([name, measure]) => {
      const blocks = [...groups(scored, (e) => e.row.cluster).values()].map((block) => [
        block.reduce((sum, e) => sum + measure(e.y, e.models[model]) - measure(e.y, e.models[comparator]), 0),
        block.length,
      ]);
      const stat = (sample: number[][]) =>
        sample.reduce((sum, b) => sum + b[0], 0) / sample.reduce((n, b) => n + b[1], 0);
      return [
        name,
        {
          delta: blocks.length ? stat(blocks) : null,
          interval95: bootstrap(blocks, stat),
          clusters: blocks.length,
        },
      ];
    }),
  );
}

const CORE_MODELS = [
  "venue",
  "global",
  "grade-main",
  "grade-synergy",
  "ability-program-compact",
  "ability-program-full",
  "ability-program-synergy",
  "venue-plus-ability-compact",
  "venue-plus-ability-ex",
] as const;

function walkForward(rows: PreparedRace[], includeNonstandard = false) {
  const usable = rows.filter(
    (r) =>
      r.hasCompleteRacelist &&
      r.y !== null &&
      (r.label === "clean" || (includeNonstandard && r.label === "nonstandard")),
  );
  const days = [...new Set(usable.map((r) => r.race.date))].sort();
  const vectors = new Map(usable.map((r) => [r, buildVectors(r)]));
  const scored: Scored[] = [];
  const folds = [];

  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    const train = usable.filter((r) => r.race.date < day);
    const targets = usable.filter((r) => r.race.date === day);

    const modelIds = [
      "grade-main",
      "grade-synergy",
      "ability-program-compact",
      "ability-program-full",
      "ability-program-synergy",
      "ability-ex",
      "ability-ex-synergy",
      "ability-full",
      "ability-full-synergy",
    ];
    const fits = new Map(
      modelIds.map((id) => [
        id,
        fitFactor(
          train.flatMap((r) => {
            const x = vectors.get(r)![id];
            return x ? [{ x, y: r.y! }] : [];
          }),
        ),
      ]),
    );

    const venueOffsetCompact = fitOffsetFactor(
      train.map((r) => ({
        offset: logitsFromProb(venuePrior(train, r.race.venue)) as [number, number],
        x: vectors.get(r)!["ability-program-compact"],
        y: r.y!,
      })),
    );
    const venueOffsetEx = fitOffsetFactor(
      train.flatMap((r) => {
        const x = vectors.get(r)!["ability-ex"];
        return x
          ? [{ offset: logitsFromProb(venuePrior(train, r.race.venue)) as [number, number], x, y: r.y! }]
          : [];
      }),
    );

    const dayScored: Scored[] = [];
    for (const row of targets) {
      const v = vectors.get(row)!;
      const vp = venuePrior(train, row.race.venue);
      const vo = logitsFromProb(vp) as [number, number];
      const models: Record<string, Probabilities> = {
        venue: vp,
        global: globalPrior(train),
      };
      for (const id of modelIds) {
        const fit = fits.get(id);
        if (fit && v[id]) models[id] = fit.predict(v[id]);
      }
      if (venueOffsetCompact) models["venue-plus-ability-compact"] = venueOffsetCompact.predict(vo, v["ability-program-compact"]);
      if (venueOffsetEx && v["ability-ex"]) models["venue-plus-ability-ex"] = venueOffsetEx.predict(vo, v["ability-ex"]);
      dayScored.push({ row, y: row.y!, models });
    }
    scored.push(...dayScored);
    folds.push({
      day,
      train: train.length,
      scored: dayScored.length,
      outs: dayScored.filter((s) => s.y === 2).length,
    });
  }

  const summarize = (subset: Scored[], ids: readonly string[]) => {
    const valid = subset.filter((s) => ids.every((id) => s.models[id]));
    return {
      n: valid.length,
      models: Object.fromEntries(ids.map((id) => [id, metrics(valid.map((s) => ({ y: s.y, p: s.models[id] })))] )),
      vsVenue: Object.fromEntries(ids.filter((id) => id !== "venue").map((id) => [id, difference(valid, id, "venue")])),
    };
  };

  const exIds = [...CORE_MODELS, "ability-ex", "ability-ex-synergy"] as const;
  const stIds = ["venue", "grade-main", "ability-program-compact", "ability-ex", "ability-full", "ability-full-synergy"] as const;

  return {
    folds,
    allScored: summarize(scored, CORE_MODELS),
    exhibitionScored: summarize(scored, exIds),
    stScored: summarize(scored, stIds),
    period1123to1127: summarize(
      scored.filter((s) => s.row.race.date >= "2026-11-23"),
      CORE_MODELS,
    ),
    period1123to1127Ex: summarize(
      scored.filter((s) => s.row.race.date >= "2026-11-23"),
      exIds,
    ),
  };
}

function main() {
  const [dataRoot, outputPath] = process.argv.slice(2);
  if (!dataRoot || !outputPath) {
    throw new Error("Usage: tsx scripts/boatrace-inside-collapse-ability-study.ts <TurfLab-data> <output.json>");
  }
  const git = (root: string, args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const days = loadBackfillDays(dataRoot);
  const prepared = prepareBackfill(days);
  const primary = walkForward(prepared, false);
  const sensitivity = walkForward(prepared, true);

  const report = {
    schema: "inside-collapse-ability-v1",
    provenance: {
      codeSha: git(".", ["rev-parse", "HEAD"]),
      dataSha: git(dataRoot, ["rev-parse", "HEAD"]),
      backfillDays: days.map((d) => d.date),
      node: process.version,
    },
    audit: {
      totalRaces: prepared.length,
      byOutcome: {
        clean: prepared.filter((r) => r.label === "clean").length,
        nonstandard: prepared.filter((r) => r.label === "nonstandard").length,
        void: prepared.filter((r) => r.label === "void").length,
        missing: prepared.filter((r) => r.label === "missing").length,
      },
      completeRacelist: prepared.filter((r) => r.hasCompleteRacelist).length,
      completeExhibition: prepared.filter((r) => r.hasCompleteExhibition).length,
      completeSt: prepared.filter((r) => r.hasCompleteSt).length,
    },
    descriptive: describeAbility(prepared),
    primary,
    sensitivityIncludingNonstandard: sensitivity.allScored,
  };

  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ audit: report.audit, allScored: report.primary.allScored.models }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
