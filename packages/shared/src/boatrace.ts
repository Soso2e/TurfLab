export const BOATS = [1, 2, 3, 4, 5, 6] as const;
export const GRADES = ["B2", "B1", "A2", "A1"] as const;
export const BOAT_STRATEGY = "trifecta-two-v1";
export const BOAT_STAKE = 100;
export const CAPTURE_WINDOW_MS = 3 * 60_000;
export type Grade = (typeof GRADES)[number];
export type Lane = "adjusted" | "control";

export interface BoatRace {
  id: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  program: Evidence;
  entries: { boat: number; name: string; grade_original: Grade | null }[];
}

export interface Evidence {
  url: string;
  fetchedAt: string;
}

export interface Exhibition {
  boat: number;
  course: number;
  st: string;
  flying: boolean | null;
}

export interface BoatOdds {
  phase: "open" | "closed" | "missing";
  updatedAt: string | null;
  cutoff: string | null;
  evidence: Evidence;
  prices: Record<string, number>;
}

export interface BoatExhibition {
  evidence: Evidence | null;
  entries: Exhibition[];
  times?: Partial<Record<number, number>>;
}

export interface BoatCapture {
  exacta: BoatOdds;
  trifecta: BoatOdds;
  exhibition: BoatExhibition;
}

export interface Ticket {
  combination: string;
  odds: number;
}

export interface BoatPlan {
  second: number;
  candidates: Ticket[];
  tickets: Ticket[];
}

export interface BoatFreeze {
  version: typeof BOAT_STRATEGY;
  frozenAt: string;
  cutoff: string;
  program: Evidence;
  stakePerTicket: typeof BOAT_STAKE;
  entries: (BoatRace["entries"][number] & {
    grade_adjusted: Grade | null;
    exhibitionF: boolean | null;
    exhibitionST: string | null;
    exhibitionCourse: number | null;
    exhibitionSeconds: number | null;
  })[];
  evidence: { exacta: Evidence; trifecta: Evidence; exhibition: Evidence | null };
  updatedAt: { exacta: string; trifecta: string };
  exacta: Ticket[];
  plans: Record<Lane, BoatPlan>;
}

export interface BoatResult {
  evidence: Evidence;
  status: "official" | "void";
  payouts: Record<string, number>;
  /** Official result popularity by winning trifecta combination; absent for legacy/missing data. */
  popularity?: Record<string, number>;
  special?: { per100: number; winning: string[] };
  refundBoats: number[];
  courses: Exhibition[];
  finishes: { boat: number; position: string }[];
}

export interface BoatRecord extends BoatRace {
  freeze?: BoatFreeze;
  exhibition?: BoatExhibition;
  result?: BoatResult;
  issue?: string;
}

export class BoatDataMissing extends Error {}

function requireData(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BoatDataMissing(message);
}

const oddsOrder = (a: Ticket, b: Ticket) =>
  a.odds - b.odds || a.combination.localeCompare(b.combination);

function oddsTicket(prices: Record<string, number>, combination: string): Ticket {
  const odds = prices[combination];
  requireData(Number.isFinite(odds) && odds >= 1, `${combination} のオッズが未取得`);
  return { combination, odds };
}

function adjustedGrade(grade: Grade | null, flying: boolean | null): Grade | null {
  if (!grade || flying !== true || grade === "A1") return grade;
  return GRADES[Math.min(GRADES.indexOf(grade) + 1, 2)];
}

export function freezeBoatRace(race: BoatRace, capture: BoatCapture, now: Date): BoatFreeze {
  const { exacta, trifecta, exhibition } = capture;
  const at = now.getTime();
  const cutoff = Math.min(
    Date.parse(race.cutoff ?? ""),
    Date.parse(exacta.cutoff ?? ""),
    Date.parse(trifecta.cutoff ?? ""),
  );
  requireData(at >= cutoff - CAPTURE_WINDOW_MS && at < cutoff, "締切前の取得時間帯を外れています");
  const isBeforeFreeze = (iso: string) =>
    Date.parse(iso) >= cutoff - CAPTURE_WINDOW_MS && Date.parse(iso) <= at;
  const isLive = (odds: BoatOdds) => odds.phase === "open" && odds.updatedAt !== null &&
    isBeforeFreeze(odds.updatedAt) && isBeforeFreeze(odds.evidence.fetchedAt) &&
    Date.parse(odds.updatedAt) <= Date.parse(odds.evidence.fetchedAt);
  requireData(isLive(exacta) && isLive(trifecta), "締切前の更新時刻付きオッズが未取得");
  const programAt = Date.parse(race.program.fetchedAt);
  requireData(Number.isFinite(programAt) && programAt <= at, "出走表の取得時刻が不正");
  requireData(!exhibition.evidence || isBeforeFreeze(exhibition.evidence.fetchedAt), "展示の取得時刻が不正");
  const entries = BOATS.map((boat) => {
    const entry = race.entries.find((item) => item.boat === boat);
    requireData(entry?.grade_original, `${boat}号艇の公式級別が未取得`);
    const shown = exhibition.evidence ? exhibition.entries.find((item) => item.boat === boat) : undefined;
    return {
      ...entry,
      grade_adjusted: adjustedGrade(entry.grade_original, shown?.flying ?? null),
      exhibitionF: shown?.flying ?? null,
      exhibitionST: shown?.st ?? null,
      exhibitionCourse: shown?.course ?? null,
      exhibitionSeconds: exhibition.evidence ? exhibition.times?.[boat] ?? null : null,
    };
  });
  const exactaCandidates = BOATS.slice(1).map((boat) => oddsTicket(exacta.prices, `1-${boat}`));
  const shortlist = [...exactaCandidates].sort(oddsOrder).slice(0, 2)
    .map((ticket) => ({ ticket, entry: entries[Number(ticket.combination[2]) - 1] }));
  function plan(gradeKey: "grade_adjusted" | "grade_original"): BoatPlan {
    const ranked = [...shortlist].sort((a, b) =>
      GRADES.indexOf(b.entry[gradeKey]!) - GRADES.indexOf(a.entry[gradeKey]!) ||
      oddsOrder(a.ticket, b.ticket));
    const second = ranked[0].entry.boat;
    const candidates = BOATS.filter((boat) => boat !== 1 && boat !== second)
      .map((boat) => oddsTicket(trifecta.prices, `1-${second}-${boat}`)).sort(oddsOrder);
    return { second, candidates, tickets: candidates.slice(0, 2) };
  }
  return {
    version: BOAT_STRATEGY, stakePerTicket: BOAT_STAKE,
    cutoff: new Date(cutoff).toISOString(), frozenAt: now.toISOString(), program: race.program, entries,
    evidence: { exacta: exacta.evidence, trifecta: trifecta.evidence, exhibition: exhibition.evidence },
    updatedAt: { exacta: exacta.updatedAt!, trifecta: trifecta.updatedAt! },
    exacta: exactaCandidates, plans: { adjusted: plan("grade_adjusted"), control: plan("grade_original") },
  };
}

export function settleBoatRace(record: BoatRecord, lane: Lane) {
  const { freeze, result } = record;
  if (!freeze || !result) return null;
  const tickets = freeze.plans[lane].tickets;
  if (tickets.length !== 2 || tickets.some((ticket) => !Number.isFinite(ticket.odds) || ticket.odds < 1)) return null;
  if (result.status === "official" && !Object.keys(result.payouts).length && !result.special) return null;
  const lines = tickets.map((ticket) => {
    const refunded = result.status === "void" || ticket.combination.split("-")
      .some((boat) => result.refundBoats.includes(Number(boat)));
    return {
      combination: ticket.combination,
      refund: refunded ? freeze.stakePerTicket : 0,
      payout: refunded ? 0 : result.payouts[ticket.combination] ?? 0,
      special: !refunded && result.special && !result.special.winning.includes(ticket.combination)
        ? result.special.per100 : 0,
    };
  });
  const stake = tickets.length * freeze.stakePerTicket;
  const refund = lines.reduce((sum, line) => sum + line.refund, 0);
  const payout = lines.reduce((sum, line) => sum + line.payout + line.special, 0);
  const special = lines.reduce((sum, line) => sum + line.special, 0);
  return { stake, refund, payout, special, net: refund + payout - stake, hit: payout > special, lines };
}

export function summarizeBoatRaces(records: Iterable<BoatRecord>) {
  type Outcome = NonNullable<ReturnType<typeof settleBoatRace>>;
  type Paired = { id: string; date: string; venue: string; cutoff: string; adjusted: Outcome; control: Outcome };
  const paired: Paired[] = [];
  const observedFirstBoat = { races: 0, wins: 0 };
  let scheduled = 0, purchased = 0;
  for (const race of records) {
    scheduled++;
    if (race.freeze) purchased++;
    if (race.result?.status === "official") {
      const first = race.result.finishes.filter((finish) => finish.position === "1");
      observedFirstBoat.races += Number(first.length > 0);
      observedFirstBoat.wins += Number(first.some((finish) => finish.boat === 1));
    }
    const adjusted = settleBoatRace(race, "adjusted");
    const control = settleBoatRace(race, "control");
    if (adjusted && control && race.freeze) paired.push({
      id: race.id, date: race.date, venue: race.venueName, cutoff: race.freeze.cutoff, adjusted, control,
    });
  }
  paired.sort((a, b) => a.cutoff.localeCompare(b.cutoff) || a.id.localeCompare(b.id));
  function summarize(races: Paired[], lane: Lane) {
    let stake = 0, refund = 0, payout = 0, hits = 0, eligible = 0, peak = 0, drawdown = 0;
    for (const race of races) {
      const settled = race[lane];
      stake += settled.stake;
      refund += settled.refund;
      payout += settled.payout;
      hits += Number(settled.hit);
      eligible += Number(settled.refund < settled.stake);
      const net = payout + refund - stake;
      peak = Math.max(peak, net);
      drawdown = Math.max(drawdown, peak - net);
    }
    return {
      count: races.length, stake, refund, payout, net: payout + refund - stake, hits, eligible, drawdown,
      roi: stake ? (refund + payout) / stake : null, hitRate: eligible ? hits / eligible : null,
    };
  }
  const compare = (rows: Paired[]) => ({ adjusted: summarize(rows, "adjusted"), control: summarize(rows, "control") });
  const group = (key: (r: Paired) => string) => {
    const groups = new Map<string, Paired[]>();
    for (const record of paired) {
      const label = key(record);
      const rows = groups.get(label) ?? [];
      rows.push(record);
      groups.set(label, rows);
    }
    return [...groups].map(([label, rows]) => ({ label, ...compare(rows) }));
  };
  return {
    scheduled, purchased, settled: paired.length, observedFirstBoat,
    totals: compare(paired),
    milestones: [100, 500, 1000].map((target) => ({
      target, count: Math.min(target, paired.length), totals: paired.length >= target ? compare(paired.slice(0, target)) : null,
    })),
    venues: group((r) => r.venue),
    days: group((r) => r.date),
  };
}
