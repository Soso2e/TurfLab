import { BOATS, GRADES, type BoatRecord, type Grade } from "./boatrace";

export const B12_VERSION = "b12-similar-race-v1" as const;
export const B12_DEFAULT = { maxDistance: 2, decay: 0.5, alpha: 10, minEffective: 30, minWeight: 10, minLift: 1.2 } as const;
export interface B12Config {
  maxDistance: number; decay: number; alpha: number;
  minEffective: number; minWeight: number; minLift: number;
}
export const TRIFECTAS = BOATS.flatMap(a => BOATS.filter(b => b !== a).flatMap(b =>
  BOATS.filter(c => c !== a && c !== b).map(c => `${a}-${b}-${c}`)));
export const TRIOS = [...new Set(TRIFECTAS.map(trioKey))].sort();
export function trioKey(key: string): string { return key.split("-").sort().join("-"); }

function time(value: string | null | undefined): number { return Date.parse(value ?? ""); }
function complete(grades: readonly (Grade | null)[]): grades is readonly Grade[] {
  return grades.length === 6 && grades.every(g => g !== null && GRADES.includes(g));
}
export function gradeDistance(a: readonly Grade[], b: readonly Grade[]): number {
  if (!complete(a) || !complete(b)) throw new Error("six original grades required");
  return a.reduce((sum, g, i) => sum + Math.abs(GRADES.indexOf(g) - GRADES.indexOf(b[i])), 0);
}
/** Only a pre-cutoff program snapshot is admissible. Never use adjusted grades or results. */
function inputAt(race: BoatRecord, asOf: number): Grade[] | null {
  const cutoff = time(race.freeze?.cutoff ?? race.cutoff);
  const program = race.freeze?.program ?? race.program;
  const entries = race.freeze?.entries ?? race.entries;
  const fetched = time(program.fetchedAt);
  if (!Number.isFinite(cutoff) || !Number.isFinite(fetched) || fetched >= cutoff || fetched > asOf ||
      (race.freeze && !(time(race.freeze.frozenAt) <= asOf && time(race.freeze.frozenAt) < cutoff))) return null;
  if (entries.length !== 6 || new Set(entries.map(e => e.boat)).size !== 6) return null;
  const grades = BOATS.map(b => entries.find(e => e.boat === b)?.grade_original ?? null);
  return complete(grades) ? [...grades] : null;
}
/** Ordinary unique top-three only; void, refund, dead heat and special payouts excluded explicitly. */
export function ordinaryOutcome(race: BoatRecord): string | null {
  const r = race.result;
  if (!r || r.status !== "official" || r.special || r.refundBoats.length || Object.keys(r.payouts).length !== 1) return null;
  const key = Object.keys(r.payouts)[0];
  if (!TRIFECTAS.includes(key) || !(Number.isFinite(r.payouts[key]) && r.payouts[key] > 0)) return null;
  const first = ["1","2","3"].map(pos => r.finishes.filter(f => f.position === pos));
  if (first.some(f => f.length !== 1) || first.map(f => f[0].boat).join("-") !== key) return null;
  return key;
}
type Distribution = Record<string, number>;
function zero(keys: readonly string[]): Distribution { return Object.fromEntries(keys.map(k => [k, 0])); }
function trioDistribution(p: Distribution): Distribution {
  const out = zero(TRIOS);
  for (const k of TRIFECTAS) out[trioKey(k)] += p[k];
  return out;
}
function ranked(p: Distribution) {
  return Object.entries(p).map(([combination, probability]) => ({ combination, probability }))
    .sort((a,b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
}
export function predictB12(target: BoatRecord, history: readonly BoatRecord[], asOf: string, config: B12Config = B12_DEFAULT) {
  if (!Number.isInteger(config.maxDistance) || config.maxDistance < 0 || config.maxDistance > 18 ||
      !Number.isFinite(config.decay) || config.decay <= 0 || config.decay > 1 ||
      !Number.isFinite(config.alpha) || config.alpha <= 0 ||
      !Number.isFinite(config.minEffective) || config.minEffective < 1 ||
      !Number.isFinite(config.minWeight) || config.minWeight < 0 ||
      !Number.isFinite(config.minLift) || config.minLift < 1) throw new Error("invalid B12 configuration");
  const at = time(asOf), cutoff = time(target.freeze?.cutoff ?? target.cutoff);
  const grades = inputAt(target, at);
  if (!grades || !Number.isFinite(at) || !(at < cutoff)) return { status: "unjudged" as const, reason: "target-program-not-pre-cutoff" };
  const priorCounts = zero(TRIFECTAS), weighted = zero(TRIFECTAS);
  const neighbors: { raceId: string; distance: number; weight: number; outcome: string }[] = [];
  const distanceCounts: Record<number, number> = {};
  let priorN = 0, weight = 0, weightSquared = 0;
  const seen = new Set<string>();
  // The canonical archive merger must resolve duplicate IDs before calling this function.
  for (const race of history) {
    if (seen.has(race.id)) throw new Error("duplicate history race: " + race.id);
    seen.add(race.id);
    const c = time(race.freeze?.cutoff ?? race.cutoff), available = time(race.result?.evidence.fetchedAt);
    if (race.id === target.id || !(c < at && available >= c && available < at)) continue;
    const g = inputAt(race, c), outcome = ordinaryOutcome(race);
    if (!g || !outcome) continue;
    priorN++; priorCounts[outcome]++;
    const d = gradeDistance(grades, g);
    distanceCounts[d] = (distanceCounts[d] ?? 0) + 1;
    if (d > config.maxDistance) continue;
    const w = config.decay ** d;
    weight += w; weightSquared += w*w; weighted[outcome] += w;
    neighbors.push({ raceId: race.id, distance: d, weight: w, outcome });
  }
  const prior = zero(TRIFECTAS), probabilities = zero(TRIFECTAS);
  for (const k of TRIFECTAS) {
    prior[k] = (priorCounts[k] + 1/TRIFECTAS.length)/(priorN+1);
    probabilities[k] = (weighted[k] + config.alpha * prior[k])/(weight + config.alpha);
  }
  const trio = trioDistribution(probabilities), priorTrio = trioDistribution(prior);
  const topTrifecta = ranked(probabilities).slice(0,2), topTrio = ranked(trio).slice(0,2);
  const effectiveN = weightSquared ? weight*weight/weightSquared : 0;
  const enough = effectiveN >= config.minEffective && weight >= config.minWeight;
  const lift = (top: typeof topTrifecta, p: Distribution) => top.reduce((s,t)=>s+t.probability,0) /
    top.reduce((s,t)=>s+p[t.combination],0);
  const trifectaLift = lift(topTrifecta, prior), trioLift = lift(topTrio, priorTrio);
  const first = zero(BOATS.map(String)), top3 = zero(BOATS.map(String));
  for (const k of TRIFECTAS) {
    const b = k.split("-");
    first[b[0]] += probabilities[k];
    for (const i of b) top3[i] += probabilities[k];
  }
  neighbors.sort((a,b)=>a.distance-b.distance || a.raceId.localeCompare(b.raceId));
  return {
    status: enough ? "estimated" as const : "insufficient" as const, modelVersion: B12_VERSION,
    raceId: target.id, asOf, grades, config: {...config}, priorN, distanceCounts, neighbors, weight, effectiveN,
    probabilities, trio, prior, priorTrio, first, top3, topTrifecta, topTrio, trifectaLift, trioLift,
    trifectaSignal: enough && trifectaLift >= config.minLift,
    trioSignal: enough && trioLift >= config.minLift,
  };
}
