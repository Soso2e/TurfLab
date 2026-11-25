// Offline research only: reads the full private archive, never writes a purchase or modifies input.
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadArchiveInputs } from "./boatrace-research-cli";
import { mergeBoatArchives } from "../packages/shared/src/boatrace-research";
import { decideB11 } from "../packages/shared/src/boatrace-b11";
import { B12_DEFAULT, B12_VERSION, ordinaryOutcome, predictB12, trioKey } from "../packages/shared/src/boatrace-b12";
import type { BoatRecord } from "../packages/shared/src/boatrace";

export function backtestB12(races: readonly BoatRecord[], from = "0000", to = "9999") {
  const ordered = [...races].sort((a,b)=>a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const stats = { targets: 0, excludedResult: 0, unjudged: 0, insufficient: 0, estimated: 0,
    trifectaSignal: 0, trioSignal: 0, b12TrifectaHits: 0, b12TrioHits: 0,
    b08Hits: 0, b08TrioHits: 0, b11Applied: 0, b11Hits: 0, b11TrioHits: 0,
    b12PairedB11Hits: 0, b12PairedB11TrioHits: 0,
    logLoss: 0, priorLogLoss: 0, trioLogLoss: 0, priorTrioLogLoss: 0,
    brier: 0, priorBrier: 0, trioBrier: 0, priorTrioBrier: 0 };
  const records = [];
  const brier = (p: Record<string, number>, key: string) =>
    Object.entries(p).reduce((s,[k,v])=>s+(v-Number(k===key))**2,0);
  for (const race of ordered) {
    if (race.date < from || race.date > to) continue;
    stats.targets++;
    const actual = ordinaryOutcome(race);
    const cutoff = Date.parse(race.freeze?.cutoff ?? race.cutoff ?? "");
    if (!actual || !(Date.parse(race.result!.evidence.fetchedAt) >= cutoff)) { stats.excludedResult++; continue; }
    if (!Number.isFinite(cutoff)) { stats.unjudged++; continue; }
    const asOf = new Date(cutoff-1).toISOString();
    const p = predictB12(race, ordered, asOf);
    if (p.status === "unjudged") { stats.unjudged++; continue; }
    if (p.status === "insufficient") { stats.insufficient++; }
    const trio = trioKey(actual);
    const b08 = ["1-2-3","1-2-4"];
    const b11 = decideB11(p.grades);
    const hit = p.topTrifecta.some(t=>t.combination===actual);
    const trioHit = p.topTrio.some(t=>t.combination===trio);
    records.push({ raceId: race.id, date: race.date, asOf, actual, forecast: p,
      b08, b11, hit, trioHit });
    if (p.status !== "estimated") continue;
    stats.estimated++;
    stats.trifectaSignal += Number(p.trifectaSignal);
    stats.trioSignal += Number(p.trioSignal);
    stats.b12TrifectaHits += Number(hit);
    stats.b12TrioHits += Number(trioHit);
    stats.b08Hits += Number(b08.includes(actual));
    stats.b08TrioHits += Number(b08.map(trioKey).includes(trio));
    if (b11.status === "bet") {
      stats.b11Applied++;
      stats.b11Hits += Number(b11.tickets.includes(actual));
      stats.b11TrioHits += Number(b11.tickets.map(trioKey).includes(trio));
      stats.b12PairedB11Hits += Number(hit);
      stats.b12PairedB11TrioHits += Number(trioHit);
    }
    stats.logLoss -= Math.log(p.probabilities[actual]);
    stats.priorLogLoss -= Math.log(p.prior[actual]);
    stats.trioLogLoss -= Math.log(p.trio[trio]);
    stats.priorTrioLogLoss -= Math.log(p.priorTrio[trio]);
    stats.brier += brier(p.probabilities,actual);
    stats.priorBrier += brier(p.prior,actual);
    stats.trioBrier += brier(p.trio,trio);
    stats.priorTrioBrier += brier(p.priorTrio,trio);
  }
  const mean = (v: number) => stats.estimated ? v/stats.estimated : null;
  return { version: B12_VERSION, config: B12_DEFAULT, from, to,
    kind: "reconstructed-walk-forward", stats,
    scores: { logLoss: mean(stats.logLoss), priorLogLoss: mean(stats.priorLogLoss),
      trioLogLoss: mean(stats.trioLogLoss), priorTrioLogLoss: mean(stats.priorTrioLogLoss),
      brier: mean(stats.brier), priorBrier: mean(stats.priorBrier),
      trioBrier: mean(stats.trioBrier), priorTrioBrier: mean(stats.priorTrioBrier) },
    // Native archive only includes trifecta payouts. Do not infer trio payouts.
    roi: { trifecta: null, trio: null, reason: "probability research; matched settlement not implemented" },
    records };
}

if (process.argv[1]?.endsWith("boatrace-b12-cli.ts")) {
  const [command, root, arg1, arg2] = process.argv.slice(2);
  if (!root || !["predict","backtest"].includes(command)) throw new Error(
    "tsx scripts/boatrace-b12-cli.ts backtest <TurfLab-data> [from] [to] | predict <TurfLab-data> <raceId> <asOf ISO>");
  // No --from filter on training data: retain the entire historical archive.
  const { archives, inputFiles, missingDays } = loadArchiveInputs(resolve(root));
  const merged = mergeBoatArchives(archives, missingDays);
  let result: unknown;
  if (command === "predict") {
    const target = merged.races.find(r=>r.id===arg1);
    if (!target || !arg2) throw new Error("raceId and asOf required");
    result = predictB12(target, merged.races, arg2);
  } else result = backtestB12(merged.races,arg1,arg2);
  const payload = { inputs: inputFiles, duplicateRaces: merged.duplicateRaces, missingDays, result };
  console.log(JSON.stringify({ ...payload, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") },null,2));
}
