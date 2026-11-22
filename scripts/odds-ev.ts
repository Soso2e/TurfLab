// Joins stored odds to fixed predictions without letting odds touch the
// evaluation. Probabilities come from a plan that was already fixed (its
// `lines[].probability`); this module only multiplies them by odds and says
// which phase the odds belong to.
import type { Row } from "../packages/shared/src/domain";
import { rows } from "../packages/shared/src/domain";
import type { OddsJurisdiction, OddsObservation } from "../packages/shared/src/odds-contract";
import { ticketKey } from "./order-probabilities";
import { OddsStore } from "./nar-odds-store";

export type RaceKey = { jurisdiction: OddsJurisdiction; date: string; track: string; race_no: number };

/** Pre-race snapshot in the shape evPlan/selectivePlan read. Never includes final odds. */
export async function preraceOddsRow(store: OddsStore, race: RaceKey, cutoff: string, activeNumbers: number[]): Promise<Row | null> {
  const found = await store.preraceAsOf(race, cutoff);
  if (!found.length) return null;
  const win = found.filter((o) => o.ticket_type === "win").sort((a, b) => a.selections[0] - b.selections[0]);
  const combo = found.filter((o) => ["wide", "quinella", "exacta", "trio", "trifecta"].includes(o.ticket_type));
  const checked = found.map((o) => o.as_of!).sort().at(-1)!;
  return {
    schema_version: "1", odds_phase: "prerace", checked_at: checked,
    win_odds: win.map((o) => ({ horse_number: o.selections[0], odds: o.odds })),
    odds_complete: activeNumbers.length > 0 && activeNumbers.every((n) => win.some((o) => o.selections[0] === n)),
    combo_odds: combo.map((o) => ({ ticket_type: o.ticket_type, selections_json: o.selections, odds: o.odds })),
    odds_source_url: found[0].source,
  };
}

const keyOf = (type: string, selections: number[]) => ticketKey(type, selections);
const round = (v: number) => Math.round(v * 1000) / 1000;

/** EV of an already-fixed plan's lines under the pre-race odds it was fixed with and the final odds. */
export function evReview(plan: Row | null, final: OddsObservation[]): Row | null {
  if (!plan) return null;
  const finalByTicket = new Map(final.map((o) => [keyOf(o.ticket_type, o.selections), o]));
  const lines = rows(plan.lines ?? []).flatMap((l) => {
    const type = String(l.ticket_type);
    const selections = (Array.isArray(l.selections_json) ? l.selections_json : []).map(Number);
    const probability = Number(l.probability);
    const planned = Number(l.odds);
    if (!Number.isFinite(probability) || !Number.isFinite(planned)) return [];
    const f = finalByTicket.get(keyOf(type, selections));
    return [{
      ticket_type: type, selections_json: selections, probability,
      prerace_odds: planned, prerace_ev: round(probability * planned),
      final_odds: f?.odds ?? null, final_ev: f ? round(probability * f.odds) : null,
    }];
  });
  if (!lines.length) return null;
  lines.sort((a, b) => b.prerace_ev - a.prerace_ev);
  return {
    probabilities_fixed_at: plan.fixed_at ?? null,
    prerace_odds_checked_at: plan.odds_checked_at ?? null,
    note: "確率は固定済み。確定オッズは発走後のため購入判断には使わない。",
    lines: lines.slice(0, 5),
  };
}

/** Compact, phone-sized odds view for one race. Win drift + EV review. */
export async function oddsView(store: OddsStore, race: RaceKey, plan: Row | null): Promise<Row | null> {
  const series = await store.preraceSeries(race);
  const final = await store.finalOdds(race);
  if (!series.length && !final.length) return null;
  const wins = new Map<number, OddsObservation[]>();
  for (const o of series) if (o.ticket_type === "win") wins.set(o.selections[0], [...(wins.get(o.selections[0]) ?? []), o]);
  const finalWin = new Map(final.filter((o) => o.ticket_type === "win").map((o) => [o.selections[0], o.odds]));
  const numbers = [...new Set([...wins.keys(), ...finalWin.keys()])].sort((a, b) => a - b);
  const last = series.map((o) => o.as_of!).sort().at(-1) ?? null;
  return {
    prerace_last_as_of: last,
    prerace_snapshots: new Set(series.map((o) => o.as_of)).size,
    final_available: final.length > 0,
    win: numbers.map((n) => {
      const list = wins.get(n) ?? [];
      const first = list[0]?.odds ?? null, latest = list.at(-1)?.odds ?? null;
      return { horse_number: n, first, latest, final: finalWin.get(n) ?? null };
    }),
    ev: evReview(plan, final),
  };
}
