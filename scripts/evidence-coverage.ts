// Decides from the fixed pack alone which of the six factors have evidence, so
// the formal/provisional split does not depend on what the LLM chooses to say.
import { CORE_MIN_DRAW_RACES, CORE_MIN_JOCKEY_STARTS, CORE_STATS_VERSION } from "./core-result-stats";
import { obj, rows, str, type Row } from "../packages/shared/src/domain";
import { normName } from "./nar-csv-stats";

export type FactorStatus = "observed" | "weak" | "missing";
export const FACTORS = ["ability", "course", "pace", "going", "draw_weight", "horse_jockey_course"] as const;
type Factor = (typeof FACTORS)[number];
type Evidence = { status: FactorStatus; detail: string };

const trackName = (value: unknown) => normName(value).replace(/競馬場$/u, "");
const weightsOf = (pack: Row): Record<Factor, number> => {
  const given = obj(pack.score_weights ?? {});
  return Object.fromEntries(FACTORS.map((f) =>
    [f, typeof given[f] === "number" ? (given[f] as number) : 1])) as Record<Factor, number>;
};

function horseEvidence(pack: Row, entry: Row): Record<Factor, Evidence> {
  const research = obj(pack.research);
  const track = trackName(str(obj(pack.track), "name"));
  const distance = obj(pack.course).distance_m;
  const horse = rows(research.horses).find((h) => h.horse_number === entry.horse_number);
  const runs = rows(horse?.recent_runs ?? []);
  const atTrack = runs.filter((r) => trackName(r.track) === track);
  const atCourse = atTrack.filter((r) => r.distance_m === distance);
  const stats = obj(research.local_stats ?? {});
  // Aggregates of TurfLab's own stored results start tiny; below the minimum
  // sample they are shown but count only as weak (never as observed).
  const core = stats.version === CORE_STATS_VERSION;
  const drawRaces = Number(obj(stats.draw ?? {}).races ?? 0);
  const drawEnough = drawRaces >= (core ? CORE_MIN_DRAW_RACES : 1);
  const drawNote = rows(research.track_notes ?? []).some((n) => /枠|馬番/u.test(String(n.note)));
  const jockey = rows(stats.jockeys ?? []).find((j) => normName(j.jockey) === normName(entry.jockey_name));
  const jockeyStarts = Number(obj(jockey?.at_track ?? {}).starts ?? 0);
  const jockeyEnough = jockeyStarts >= (core ? CORE_MIN_JOCKEY_STARTS : 1);
  const label = core ? "保存済み公式結果" : "CSV";
  const notes = rows(horse?.jockey_notes ?? []);
  const local = notes.some((n) => !/全国|代用/u.test(String(n.note)));
  return {
    ability: runs.some((r) => r.finish != null)
      ? { status: "observed", detail: `着順のある近走 ${runs.filter((r) => r.finish != null).length}走` }
      : { status: "missing", detail: "着順のある近走なし" },
    course: atCourse.length
      ? { status: "observed", detail: `同場同距離 ${atCourse.length}走` }
      : atTrack.length
        ? { status: "weak", detail: `同場別距離 ${atTrack.length}走のみ` }
        : runs.length
          ? { status: "weak", detail: `確認できた${runs.length}走に同場なし（経験なしとは断定しない）` }
          : { status: "missing", detail: "近走なし" },
    pace: runs.some((r) => Array.isArray(r.corners) && r.corners.length)
      ? { status: "observed", detail: "通過順あり" }
      : { status: "missing", detail: "通過順なし" },
    going: research.going != null
      ? { status: "observed", detail: `公式表示 ${String(research.going)}` }
      : { status: "missing", detail: "馬場の公式表示なし（発表待ちを含む）" },
    draw_weight: drawEnough || drawNote
      ? { status: "observed", detail: drawEnough ? `${label}集計 ${drawRaces}R` : "出典付き資料" }
      : drawRaces > 0
        ? { status: "weak", detail: `${label}集計 ${drawRaces}R（${CORE_MIN_DRAW_RACES}R未満）` }
      : entry.carried_weight_kg != null
        ? { status: "weak", detail: "斤量のみ。枠傾向の資料なし" }
        : { status: "missing", detail: "枠傾向・斤量なし" },
    horse_jockey_course: jockeyEnough || local
      ? { status: "observed", detail: jockeyEnough ? `騎手の同場${label}集計 ${jockeyStarts}騎乗` : "騎手の同場成績資料" }
      : jockeyStarts > 0
        ? { status: "weak", detail: `騎手の同場${label}集計 ${jockeyStarts}騎乗（${CORE_MIN_JOCKEY_STARTS}騎乗未満）` }
      : notes.length
        ? { status: "weak", detail: "騎手は全国成績の代用のみ" }
        : atTrack.length
          ? { status: "weak", detail: "騎手の同場成績なし。馬の同場近走のみ" }
          : { status: "missing", detail: "騎手の同場成績・馬の同場近走ともになし" },
  };
}

/** Formal needs every factor observed. A course "weak" is allowed because a
 * horse new to the track is a fact about the horse, not a gap in the data. */
export function evidenceCoverage(pack: Row): Row {
  const weights = weightsOf(pack);
  const total = FACTORS.reduce((sum, f) => sum + weights[f], 0);
  let formal = true;
  const missing: Row[] = [];
  const horses = rows(pack.entries).filter((e) => e.status === "active").map((entry) => {
    const factors = horseEvidence(pack, entry);
    let earned = 0;
    for (const f of FACTORS) {
      const { status, detail } = factors[f];
      earned += weights[f] * (status === "observed" ? 1 : status === "weak" ? 0.5 : 0);
      if (status === "missing" || (status === "weak" && f !== "course")) formal = false;
      if (status !== "observed")
        missing.push({ horse_number: entry.horse_number!, component: f, status, detail });
    }
    return {
      horse_number: entry.horse_number!,
      confidence: Math.round((earned / total) * 100) / 100,
      factors,
    };
  });
  return {
    version: "evidence-coverage-v1",
    formal_allowed: formal && horses.length > 0,
    confidence: horses.length
      ? Math.round((horses.reduce((s, h) => s + h.confidence, 0) / horses.length) * 100) / 100
      : 0,
    missing,
    horses,
  };
}

/** Why a race is not formal, computed from the coverage alone: which factors
 * block it, for how many horses, and how far the stored-result samples are from
 * the minimum. Thresholds are reported, never lowered. */
export function formalBlockers(pack: Row, coverage: Row): Row {
  const blocking = new Map<string, { horses: Set<number>; reasons: Set<string> }>();
  for (const m of rows(coverage.missing)) {
    if (m.status === "weak" && m.component === "course") continue;
    const entry = blocking.get(String(m.component)) ?? { horses: new Set(), reasons: new Set() };
    entry.horses.add(Number(m.horse_number));
    entry.reasons.add(String(m.detail).replace(/\d+/gu, "N"));
    blocking.set(String(m.component), entry);
  }
  const stats = obj(obj(pack.research).local_stats ?? {});
  const core = stats.version === CORE_STATS_VERSION;
  const active = rows(pack.entries).filter((e) => e.status === "active");
  const starts = active.map((e) => Number(obj(rows(stats.jockeys ?? [])
    .find((j) => normName(j.jockey) === normName(e.jockey_name))?.at_track ?? {}).starts ?? 0));
  return {
    formal_allowed: coverage.formal_allowed === true,
    blocking: [...blocking].map(([factor, v]) => ({
      factor, horses: v.horses.size, reasons: [...v.reasons].slice(0, 4),
    })),
    progress: {
      source: core ? "core-results" : stats.version ? String(stats.version) : "none",
      draw_races: Number(obj(stats.draw ?? {}).races ?? 0),
      draw_races_needed: core ? CORE_MIN_DRAW_RACES : 1,
      jockeys_below_min: starts.filter((s) => s < (core ? CORE_MIN_JOCKEY_STARTS : 1)).length,
      jockey_starts_needed: core ? CORE_MIN_JOCKEY_STARTS : 1,
      fewest_jockey_starts: starts.length ? Math.min(...starts) : 0,
    },
  };
}

/** Removes scores for factors with no evidence, and ranks on what remains while
 * reporting how much of the score weight that remainder actually covers. */
export function provisionalRanking(pack: Row, coverage: Row, evaluations: Row[]) {
  const weights = weightsOf(pack);
  const total = FACTORS.reduce((sum, f) => sum + weights[f], 0);
  const cleaned = evaluations.map((evaluation) => {
    const factors = obj(rows(coverage.horses).find((h) => h.horse_number === evaluation.horse_number)?.factors ?? {});
    const given = obj(evaluation.components ?? {});
    const components = Object.fromEntries(FACTORS.map((f) => {
      const value = given[f];
      return [f, typeof value === "number" && obj(factors[f] ?? {}).status !== "missing" ? value : null];
    }));
    return { ...evaluation, components } as Row & { components: Record<string, number | null> };
  });
  const ranking = cleaned.map((evaluation) => {
    const scored = FACTORS.filter((f) => evaluation.components[f] != null);
    const covered = scored.reduce((sum, f) => sum + weights[f], 0);
    return {
      horse_number: evaluation.horse_number!,
      horse_name: evaluation.horse_name ?? null,
      score: covered
        ? Math.round((scored.reduce((sum, f) => sum + weights[f] * Number(evaluation.components[f]), 0) / covered) * 10) / 10
        : null,
      covered_weight: Math.round((covered / total) * 100) / 100,
    };
  }).sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1));
  return { evaluations: cleaned, ranking };
}
