// Odds observation contract (JRA-ready): one append-only record per
// (race, ticket, combination, phase, value). No network, no files.
//
// Phases are never mixed:
//   prerace = odds seen before the start (as_of < scheduled start). The only
//             phase that may feed expected value when a plan is fixed.
//   final   = official confirmed odds from a post-race CSV (確定オッズ). They
//             exist only after the race, so they serve settlement, backtests
//             and drift display, never a pre-race decision.
import { createHash } from "node:crypto";

export const ODDS_SCHEMA_VERSION = "1";
export const ODDS_TICKETS = ["win", "place", "bracket", "quinella", "wide", "exacta", "trio", "trifecta"] as const;
export type OddsTicket = (typeof ODDS_TICKETS)[number];
export type OddsPhase = "prerace" | "final";
export type OddsJurisdiction = "NAR" | "JRA";

export type OddsObservation = {
  schema_version: typeof ODDS_SCHEMA_VERSION;
  obs_id: string;
  jurisdiction: OddsJurisdiction;
  race_date: string;
  track: string;
  race_no: number;
  /** TurfLab race id when the observation came from a tracked race. */
  race_id: string | null;
  ticket_type: OddsTicket;
  selections: number[];
  /** Win/odds value; for place and wide, the lower bound. */
  odds: number;
  /** Upper bound for place and wide; null otherwise. */
  odds_high: number | null;
  phase: OddsPhase;
  /** Market time of a pre-race observation. null for final (= at close). */
  as_of: string | null;
  retrieved_at: string;
  source: string;
  source_sha256: string | null;
};

const JA_TICKET: Record<string, OddsTicket> = {
  単勝: "win", 複勝: "place", 枠連: "bracket", 枠番連勝複式: "bracket", 馬連: "quinella", 馬番連勝複式: "quinella",
  ワイド: "wide", 馬単: "exacta", 馬番連勝単式: "exacta", 三連複: "trio", "3連複": "trio",
  三連単: "trifecta", "3連単": "trifecta",
};
const UNORDERED = new Set<OddsTicket>(["bracket", "quinella", "wide", "trio"]);
const SIZE: Record<OddsTicket, number> = { win: 1, place: 1, bracket: 2, quinella: 2, wide: 2, exacta: 2, trio: 3, trifecta: 3 };

export function ticketFromText(value: unknown): OddsTicket | null {
  const text = String(value ?? "").normalize("NFKC").replace(/\s/gu, "");
  if ((ODDS_TICKETS as readonly string[]).includes(text)) return text as OddsTicket;
  return JA_TICKET[text] ?? null;
}

/** Canonical selection order: unordered tickets ascending, ordered ones as given. */
export function normalizeSelections(type: OddsTicket, values: unknown[]): number[] | null {
  const n = values.map((v) => Number(v));
  if (n.length !== SIZE[type] || n.some((v) => !Number.isInteger(v) || v < 1 || v > 18)) return null;
  if (type !== "bracket" && new Set(n).size !== n.length) return null;
  if (type === "bracket" && n.some((v) => v > 8)) return null;
  return UNORDERED.has(type) ? [...n].sort((a, b) => a - b) : n;
}

export const comboKey = (o: Pick<OddsObservation, "jurisdiction" | "race_date" | "track" | "race_no" | "ticket_type" | "selections">) =>
  `${o.jurisdiction}|${o.race_date}|${o.track}|${o.race_no}|${o.ticket_type}|${o.selections.join("-")}`;

export const raceKeyOf = (o: Pick<OddsObservation, "jurisdiction" | "race_date" | "track" | "race_no">) =>
  `${o.jurisdiction}|${o.race_date}|${o.track}|${o.race_no}`;

export function observationId(o: Omit<OddsObservation, "obs_id">): string {
  const text = [comboKey(o), o.phase, o.odds, o.odds_high ?? "", o.as_of ?? "", o.source_sha256 ?? o.source].join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export type Rejection = "bad_odds" | "bad_selection" | "bad_race" | "future_race" | "post_start" | "no_start_for_prerace";

/** Validates one candidate. `startAt` is the scheduled start (prerace guard). */
export function checkObservation(
  o: Omit<OddsObservation, "obs_id">,
  context: { startAt?: string | null } = {},
): Rejection | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(o.race_date) || !o.track || !Number.isInteger(o.race_no) || o.race_no < 1 || o.race_no > 20) return "bad_race";
  if (!normalizeSelections(o.ticket_type, o.selections) ||
      o.selections.join() !== normalizeSelections(o.ticket_type, o.selections)!.join()) return "bad_selection";
  const ok = (v: number) => Number.isFinite(v) && v >= 1 && v <= 99999.9;
  if (!ok(o.odds)) return "bad_odds";
  if (o.odds_high !== null && (!ok(o.odds_high) || o.odds_high < o.odds)) return "bad_odds";
  if (o.phase === "final" && o.as_of !== null) return "bad_odds";
  // A race that has not been run on the retrieval day cannot have confirmed odds.
  if (o.phase === "final" && o.race_date > jstDay(o.retrieved_at)) return "future_race";
  if (o.phase === "prerace") {
    if (!o.as_of || !Number.isFinite(Date.parse(o.as_of))) return "no_start_for_prerace";
    if (!context.startAt || !Number.isFinite(Date.parse(context.startAt))) return "no_start_for_prerace";
    if (Date.parse(o.as_of) >= Date.parse(context.startAt)) return "post_start";
  }
  return null;
}

export const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

export function withId(o: Omit<OddsObservation, "obs_id">): OddsObservation {
  return { ...o, obs_id: observationId(o) };
}

/** Combination counts a complete card must have for `n` horses with a win quote. */
export function expectedCombos(type: OddsTicket, n: number): number {
  if (n < 1) return 0;
  switch (type) {
    case "win": case "place": return n;
    case "quinella": case "wide": return (n * (n - 1)) / 2;
    case "exacta": return n * (n - 1);
    case "trio": return (n * (n - 1) * (n - 2)) / 6;
    case "trifecta": return n * (n - 1) * (n - 2);
    case "bracket": return 0; // depends on bracket layout; not checked
  }
}
