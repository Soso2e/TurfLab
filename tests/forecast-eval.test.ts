import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg, buildReport, dayBlockDifference, disagreementReport, emptyRegistry, fitTemperature, logPool,
  lockForecast, normalise, reasonCategoryDiscovery, recordFeatureTest, registerFeature, temper, verdict,
  walkForwardEnsemble, raceResultFromOfficial, type PairedRace,
} from "../scripts/forecast-eval";
import { validateForecast, type Forecast, type RaceResult } from "../packages/shared/src/forecast-contract";
import { makeForecast } from "./forecast-contract.test";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-12)));
const softmax = (z: number[]) => { const m = Math.max(...z); return normalise(z.map((v) => Math.exp(v - m))); };

/** Synthetic races. True strengths = a (known to M) + b (known to A only). */
function synth(n: number, opts: { mNoise: number; aNoise: number; aInfo: boolean; seed: number }): PairedRace[] {
  const r = rng(opts.seed);
  const races: PairedRace[] = [];
  for (let i = 0; i < n; i++) {
    const k = 10;
    const a = Array.from({ length: k }, () => (r() - 0.5) * 2.4);
    const b = Array.from({ length: k }, () => (r() - 0.5) * 2.4);
    const perf = a.map((x, j) => x + (opts.aInfo ? b[j] : 0) + gumbel(r));
    const w = perf.indexOf(Math.max(...perf));
    const pM = softmax(a.map((x) => x + (r() - 0.5) * opts.mNoise));
    const pA = softmax((opts.aInfo ? b : a.map(() => 0)).map((x, j) => x + (opts.aInfo ? 0 : (r() - 0.5) * 2) + (opts.aInfo ? 0 : 0) + (r() - 0.5) * opts.aNoise + 0 * j));
    races.push({ race_key: `r${i}`, date: `2026-07-${String(1 + Math.floor(i / 8)).padStart(2, "0")}`.replace(/-(\d)$/, "-0$1"), pM, pA, winners: [w], reasons: i % 2 ? ["form"] : ["pace_style"] });
  }
  return races;
}
// dates beyond 31 days are invalid strings but sort correctly lexicographically; make them valid anyway
function fixDates(rs: PairedRace[]): PairedRace[] {
  return rs.map((r, i) => ({ ...r, date: new Date(Date.UTC(2026, 6, 1 + Math.floor(i / 8))).toISOString().slice(0, 10) }));
}

describe("paired statistics", () => {
  it("day-block interval separates a real difference from noise and respects the claim ladder", () => {
    const days = Array.from({ length: 400 }, (_, i) => `d${Math.floor(i / 8)}`);
    const a = days.map(() => 1.9), b = days.map(() => 2.3);
    const d = dayBlockDifference(a, b, days);
    expect(d.mean).toBeCloseTo(-0.4, 5);
    expect(verdict(d)).toBe("superiority_candidate");
    expect(verdict(dayBlockDifference(a.slice(0, 20), b.slice(0, 20), days.slice(0, 20)))).toBe("insufficient_sample");
    const r = rng(2);
    const noise = days.map(() => 2.3 + (r() - 0.5));
    const same = dayBlockDifference(noise, noise.map((x, i) => x + (i % 2 ? 0.1 : -0.1)), days);
    expect(verdict(same)).toBe("no_difference_detected");
  });
  it("is deterministic", () => {
    const days = ["a", "a", "b", "b", "c"], a = [1, 2, 3, 2, 1], b = [2, 2, 2, 2, 2];
    expect(dayBlockDifference(a, b, days)).toEqual(dayBlockDifference(a, b, days));
  });
  it("Benjamini-Hochberg", () => expect(benjaminiHochberg([0.001, 0.5, 0.9], 0.1)).toEqual([true, false, false]));
});

describe("probability algebra", () => {
  it("log pool with weights (1,0) returns M; temperature flattens an overconfident forecast", () => {
    const m = [0.5, 0.3, 0.2], a = [0.9, 0.05, 0.05];
    expect(logPool(m, a, 1, 0).map((x) => +x.toFixed(6))).toEqual(m);
    expect(temper(a, 2)[0]).toBeLessThan(a[0]);
    expect(temper(a, 1).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });
  it("fits T>1 for an overconfident AI and T≈1 for a calibrated one", () => {
    const r = rng(9);
    const mk = (sharpen: number): PairedRace[] => fixDates(Array.from({ length: 300 }, (_, i) => {
      const z = Array.from({ length: 8 }, () => (r() - 0.5) * 2);
      const truth = softmax(z);
      let u = r(), w = 0; for (; w < 7 && u > truth[w]; w++) u -= truth[w];
      return { race_key: `t${i}`, date: "", pM: truth, pA: softmax(z.map((x) => x * sharpen)), winners: [w], reasons: [] };
    }));
    expect(fitTemperature(mk(2.5))).toBeGreaterThan(1.6);
    expect(fitTemperature(mk(1))).toBeGreaterThan(0.85);
    expect(fitTemperature(mk(1))).toBeLessThan(1.2);
  });
});

describe("walk-forward M vs A vs pool", () => {
  it("pooling helps only when A carries information M lacks", () => {
    const informative = walkForwardEnsemble(fixDates(synth(700, { mNoise: 0.3, aNoise: 0.3, aInfo: true, seed: 1 })));
    expect(informative.status).toBe("ok");
    expect(informative.paired!["E_vs_M"].mean!).toBeLessThan(-0.03);
    expect(verdict(informative.paired!["E_vs_M"])).toBe("superiority_candidate");
  });
  it("does not claim a pooling gain when A is noise", () => {
    const noise = walkForwardEnsemble(fixDates(synth(700, { mNoise: 0.3, aNoise: 3, aInfo: false, seed: 4 })));
    expect(verdict(noise.paired!["E_vs_M"])).not.toBe("superiority_candidate");
    expect(noise.final_weights!.wA).toBeLessThanOrEqual(0.6);
  });
  it("uses only earlier dates for fitting and reports insufficient data when there are none", () => {
    expect(walkForwardEnsemble(fixDates(synth(20, { mNoise: 0.3, aNoise: 0.3, aInfo: true, seed: 2 }))).status).toBe("insufficient_data");
  });
});

describe("discovery", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    race_key: `r${i}`, date: `d${Math.floor(i / 6)}`, reasons: i % 2 ? ["pace_style" as const] : ["form" as const], divergence: (i % 10) / 10,
    lossM: 2.3, lossA: 2.3, lossAcal: i % 2 ? 2.0 : 2.3, lossE: 2.2,
  }));
  it("flags a reason category where the AI beats M, with multiplicity control", () => {
    const f = reasonCategoryDiscovery(rows(240).map((r, i) => ({ ...r, lossAcal: r.lossAcal + ((i * 7919) % 13) * 0.01 })));
    const pace = f.find((x) => x.category === "pace_style")!;
    expect(pace.reading).toBe("ai_adds_value_candidate");
    expect(f.find((x) => x.category === "form")?.reading).not.toBe("ai_adds_value_candidate");
  });
  it("skips categories with too few races and splits disagreement strata", () => {
    expect(reasonCategoryDiscovery(rows(40)).every((x) => x.races >= 30)).toBe(true);
    const d = disagreementReport(rows(60));
    expect(d.strata.map((s) => s.name).sort()).toEqual(["high_disagreement", "low_disagreement"]);
    expect(disagreementReport(rows(5)).status).toBe("insufficient_data");
  });
});

describe("feature registry", () => {
  const base = { id: "f1", definition: "同コース同距離の前走上がり順位", available_at_rule: "前走の公式結果確定後", expected_sign: "negative" as const, source: "ai_hypothesis" as const, registered_at: "2026-11-22" };
  it("refuses undefined features, duplicates and odds/popularity", () => {
    let reg = registerFeature(emptyRegistry(), base);
    expect(() => registerFeature(reg, base)).toThrow();
    expect(() => registerFeature(reg, { ...base, id: "f2", available_at_rule: " " })).toThrow();
    expect(() => registerFeature(reg, { ...base, id: "f3", definition: "人気との乖離" })).toThrow();
    reg = recordFeatureTest(reg, "f1", { at: "t", races: 80, delta_log_loss: -0.05, ci95: [-0.1, -0.001] });
    expect(reg.features[0].status).toBe("testing"); // too few races to decide
  });
  it("adopts only with >=300 races, an interval below 0 and multiplicity-adjusted evidence; otherwise rejects", () => {
    let reg = registerFeature(emptyRegistry(), base);
    reg = recordFeatureTest(reg, "f1", { at: "t", races: 400, delta_log_loss: -0.03, ci95: [-0.045, -0.015] });
    expect(reg.features[0].status).toBe("adopted");
    let many = registerFeature(emptyRegistry(), base);
    many = { ...many, trials: 400 }; // many prior trials: the same result no longer survives
    many = recordFeatureTest(many, "f1", { at: "t", races: 400, delta_log_loss: -0.012, ci95: [-0.02, -0.0005] });
    expect(many.features[0].status).toBe("rejected");
  });
});

describe("ledger and pipeline", () => {
  const ok = (over: Record<string, unknown> = {}) => (validateForecast(makeForecast(over)) as { ok: true; forecast: Forecast }).forecast;
  it("locks a forecast write-once and refuses to overwrite a different one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-"));
    try {
      const f = ok();
      const first = await lockForecast(dir, f);
      expect(first.status).toBe("locked");
      expect((await lockForecast(dir, f)).status).toBe("already_locked_same");
      const changed = ok({}); changed.horses = [...changed.horses].reverse().map((h, i) => ({ ...h, win_probability: [0.1, 0.2, 0.3, 0.4][i] }));
      expect((await lockForecast(dir, changed)).status).toBe("conflict");
      expect(JSON.parse(await readFile(first.path, "utf8")).horses[0].win_probability).toBeCloseTo(0.4, 6);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("converts an official result and builds the report only from leak-free, paired races", () => {
    const official = { result: { finish_order_json: [[3], [1, 2]], entry_status_json: { "4": "dnf" } }, pace_observation: { corners: ["3角 3,1,(2,4)"] } };
    const res = raceResultFromOfficial(official, "2026-11-22|東京|11R", "2026-11-22")!;
    expect(res.winners).toEqual([3]);
    expect(res.finishers.find((f) => f.horse_number === 2)?.finish).toBe(2);
    expect(res.finishers.find((f) => f.horse_number === 4)?.finish).toBeNull();
    expect(res.corners?.["3"]).toEqual({ first: 1, last: 1 });
    const results: RaceResult[] = [];
    const forecasts: Forecast[] = [];
    const r = rng(5);
    for (let i = 0; i < 80; i++) {
      const date = new Date(Date.UTC(2026, 10, 1 + Math.floor(i / 4))).toISOString().slice(0, 10);
      const key = `${date}|東京|${(i % 4) + 1}R`;
      const w = Math.floor(r() * 4) + 1;
      results.push({ race_key_human: key, date_jst: date, winners: [w], finishers: [{ horse_number: w, finish: 1 }] });
      for (const [id, kind] of [["math-m1", "math"], ["ai-independent-v2", "ai"]] as const)
        forecasts.push(ok({ forecaster: { id, kind, model_version: "m", model_knowledge_cutoff: null }, race: { race_key_human: key, date_jst: date, track: "東京", race_no: (i % 4) + 1, scheduled_start_at_jst: `${date}T15:40:00+09:00`, distance_m: null, surface: null }, cutoff_at: `${date}T08:00:00+09:00`, generated_at: `${date}T09:00:00+09:00` }));
    }
    const report = buildReport(forecasts, results, 0, "math-m1", "ai-independent-v2");
    expect(report.counts.paired).toBe(80);
    expect(report.single["math-m1"].races).toBe(80);
    expect(report.claim).toMatch(/検出されていない|標本不足|悪い|傾向/);
    expect(JSON.stringify(report)).not.toMatch(/odds_used":true/);
  });
});
