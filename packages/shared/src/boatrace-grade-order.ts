import { BOATS, GRADES, type BoatRecord } from "./boatrace";

export const GRADE_ORDER_VERSION = "grade-order-consistency-v1" as const;

type PairScore = {
  concordant: number;
  inverted: number;
  sameGrade: number;
  comparable: number;
  rate: number | null;
};

type GradeOrderStatus = "ok" | "missing-grades" | "missing-result" | "void" | "refund" | "invalid-result" | "missing-top3";

function scorePairs(grades: Map<number, number>, ordered: number[], remaining: number[]): PairScore {
  let concordant = 0, inverted = 0, sameGrade = 0;
  for (const [i, boat] of ordered.entries()) {
    for (const other of [...ordered.slice(i + 1), ...remaining]) {
      const diff = grades.get(boat)! - grades.get(other)!;
      if (diff > 0) concordant++;
      else if (diff < 0) inverted++;
      else sameGrade++;
    }
  }
  const comparable = concordant + inverted;
  return { concordant, inverted, sameGrade, comparable, rate: comparable ? concordant / comparable : null };
}

/** Post-result research only. No lane bonus, adjusted grade, odds or prediction input. */
export function evaluateGradeOrder(race: BoatRecord) {
  const grades = new Map<number, number>();
  for (const e of race.entries) {
    if (!BOATS.some(b => b === e.boat) || grades.has(e.boat) || e.grade_original === null) continue;
    const value = GRADES.indexOf(e.grade_original);
    if (value >= 0) grades.set(e.boat, value);
  }
  const completeGrades = race.entries.length === 6 && grades.size === 6;
  const composition = completeGrades ? [...grades.values()].sort((a, b) => b - a).map(g => GRADES[g]).join("-") : null;
  const lanePattern = completeGrades ? BOATS.map(b => GRADES[grades.get(b)!]).join("-") : null;
  const identity = { raceId: race.id, date: race.date, venue: race.venue, venueName: race.venueName, composition, lanePattern };
  const missing = (status: GradeOrderStatus) => ({
    ...identity, status, top3: null, full6: null, exactTop3: null, unorderedTop3: null,
    winnerBoat: null, allSameGrade: completeGrades ? new Set(grades.values()).size === 1 : null,
  });
  if (!completeGrades) return missing("missing-grades");
  const result = race.result;
  if (!result) return missing("missing-result");
  if (result.status !== "official") return missing("void");
  // Refunded boats can be absent from the actual field: exclude rather than invent a finish.
  if (result.refundBoats.length) return missing("refund");
  const positions = new Map<number, number>();
  const seen = new Set<number>();
  for (const f of result.finishes) {
    if (!BOATS.some(b => b === f.boat) || seen.has(f.boat)) return missing("invalid-result");
    seen.add(f.boat);
    // Non-numeric finish codes (F, L, disqualification etc.) are not ranks.
    if (!/^[1-6]$/.test(f.position)) {
      if (/^\d+$/.test(f.position)) return missing("invalid-result");
      continue;
    }
    const pos = Number(f.position);
    if (positions.has(pos)) return missing("invalid-result"); // ties/dead heats not ordered
    positions.set(pos, f.boat);
  }
  const top = [1, 2, 3].map(p => positions.get(p));
  if (top.some(b => b === undefined)) return missing("missing-top3");
  const ordered = top as number[];
  const remaining = BOATS.filter(b => !ordered.includes(b));
  const actual = ordered.map(b => grades.get(b)!);
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 3);
  const full = positions.size === 6 ? [1, 2, 3, 4, 5, 6].map(p => positions.get(p)!) : null;
  return {
    ...identity, status: "ok" as GradeOrderStatus,
    top3: scorePairs(grades, ordered, remaining),
    full6: full ? scorePairs(grades, full, []) : null,
    exactTop3: actual.every((g, i) => g === ideal[i]),
    unorderedTop3: [...actual].sort((a, b) => b - a).every((g, i) => g === ideal[i]),
    winnerBoat: ordered[0], allSameGrade: new Set(grades.values()).size === 1,
  };
}

type RaceScore = ReturnType<typeof evaluateGradeOrder>;

function aggregate(rows: RaceScore[]) {
  function pool(scope: "top3" | "full6") {
    const scores = rows.flatMap(r => r[scope] ? [r[scope]] : []);
    const concordant = scores.reduce((sum, s) => sum + s.concordant, 0);
    const inverted = scores.reduce((sum, s) => sum + s.inverted, 0);
    const sameGrade = scores.reduce((sum, s) => sum + s.sameGrade, 0);
    const comparable = concordant + inverted;
    return { races: scores.length, informativeRaces: scores.filter(s => s.comparable > 0).length,
      concordant, inverted, sameGrade, comparable, rate: comparable ? concordant / comparable : null };
  }
  const eligible = rows.filter(r => r.status === "ok");
  const statuses: Partial<Record<GradeOrderStatus, number>> = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return {
    total: rows.length, eligible: eligible.length, statuses,
    allSameGrade: eligible.filter(r => r.allSameGrade).length,
    exactTop3: eligible.filter(r => r.exactTop3).length,
    unorderedTop3: eligible.filter(r => r.unorderedTop3).length,
    top3: pool("top3"), full6: pool("full6"),
  };
}

export function summarizeGradeOrder(races: BoatRecord[]) {
  // The research CLI supplies archive-merged (race-ID deduplicated) records.
  const rows = races.map(evaluateGradeOrder);
  const group = (key: (r: RaceScore) => string | null) => {
    const buckets = new Map<string, RaceScore[]>();
    for (const row of rows) {
      const label = key(row);
      if (label === null) continue;
      const items = buckets.get(label) ?? [];
      items.push(row);
      buckets.set(label, items);
    }
    return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({ key, ...aggregate(items) }));
  };
  return {
    schemaVersion: GRADE_ORDER_VERSION,
    overall: aggregate(rows),
    boat1Lost: aggregate(rows.filter(r => r.winnerBoat !== null && r.winnerBoat !== 1)),
    boat1Won: aggregate(rows.filter(r => r.winnerBoat === 1)),
    byDate: group(r => r.date),
    byVenue: group(r => r.venue),
    byComposition: group(r => r.composition),
    byLanePattern: group(r => r.lanePattern),
    races: rows,
  };
}
