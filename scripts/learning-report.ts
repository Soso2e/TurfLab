// Read-only: recomputes the learning report from the files a DataHome already
// holds, with the code in this checkout. Writes nothing and calls no API or AI,
// so it can be run while the Worker is running (or stopped) to check a change
// against real records before it is deployed.
//   npm run learning:report            (default DataHome)
//   npm run learning:report -- --data-home <dir> [--full]
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { obj, type Row } from "../packages/shared/src/domain";
import {
  compareStrategies, fitWeights, learningReport, MIN_TRAIN_RACES, outcomeSamples,
  planBreakdown, planOutcomeDetailed, PRIOR_WEIGHTS,
} from "./lab-learning";
import { SELECTIVE_DAILY_BUDGET_YEN, selectivePlan } from "./bet-plans";
import { evaluateTrackBias } from "./track-bias-evaluation";

export async function exchangeFiles(exchange: string, kind: string): Promise<Row[]> {
  const output: Row[] = [];
  const dir = path.join(exchange, kind);
  for (const day of await readdir(dir).catch(() => []))
    for (const file of await readdir(path.join(dir, day)).catch(() => []))
      if (file.endsWith(".json"))
        output.push(obj(JSON.parse(await readFile(path.join(dir, day, file), "utf8"))));
  return output;
}

/** Results come from the saved official-result receipts; a result that reached
 * Core by another route is not in this folder and its plans stay unsettled. */
export async function offlineLearningReport(exchange: string, now: string): Promise<Row> {
  const results = new Map<string, Row>();
  for (const saved of await exchangeFiles(exchange, "results")) {
    const result = obj(saved.result ?? {});
    if (result.official_status !== "official" || typeof result.race_id !== "string") continue;
    const prior = results.get(result.race_id);
    if (!prior || Number(prior.revision ?? 0) <= Number(result.revision ?? 0))
      results.set(result.race_id, { ...result, payouts: saved.payouts ?? [] });
  }
  const odds = new Map((await exchangeFiles(exchange, "prerace"))
    .filter((value) => value.odds_complete).map((value) => [String(value.race_id), value]));
  const plans: Row[] = (await exchangeFiles(exchange, "plans")).map((plan) => {
    const result = results.get(String(plan.race_id));
    return result ? { ...plan, settled: planOutcomeDetailed(plan, result) } : plan;
  });
  const outcomes = await exchangeFiles(exchange, "outcomes");
  const report = learningReport(outcomes, plans, odds, now);

  // Time-ordered virtual backtest of selectivePlan vs saved current plans (no hindsight).
  const latestLabs = new Map<string, Row>();
  for (const lab of await exchangeFiles(exchange, "lab")) {
    const rid = String(lab.race_id ?? "");
    if (!rid || !Array.isArray(lab.ranking)) continue;
    if (Date.parse(String(lab.saved_at)) >= Date.parse(String(lab.scheduled_start_at))) continue;
    const prior = latestLabs.get(rid);
    if (!prior || String(lab.saved_at).localeCompare(String(prior.saved_at)) >= 0) {
      latestLabs.set(rid, lab);
    }
  }
  const sortedLabs = [...latestLabs.values()].sort((a, b) =>
    String(a.race_date_jst).localeCompare(String(b.race_date_jst)) ||
    String(a.scheduled_start_at).localeCompare(String(b.scheduled_start_at)) ||
    String(a.race_id).localeCompare(String(b.race_id)),
  );
  const allSamples = outcomeSamples(outcomes, odds);
  const spentByDay = new Map<string, number>();
  const backtestPlans: Row[] = [];
  for (const lab of sortedLabs) {
    const rid = String(lab.race_id);
    const day = String(lab.race_date_jst ?? "");
    const result = results.get(rid);
    if (!result) continue;
    const earlier = allSamples.filter((s) => s.date < day);
    const calibrated = earlier.length >= MIN_TRAIN_RACES;
    const weights = calibrated ? fitWeights(earlier) : PRIOR_WEIGHTS;
    const spent = spentByDay.get(day) ?? 0;
    const sel = selectivePlan(lab, odds.get(rid) ?? null, weights, calibrated, now, {
      remainingDailyBudgetYen: Math.max(0, SELECTIVE_DAILY_BUDGET_YEN - spent),
    });
    const settled = planOutcomeDetailed(sel, result);
    spentByDay.set(day, spent + settled.stake);
    backtestPlans.push({ ...sel, settled });
  }
  const currentSaved = plans.filter((p) => p.plan_lane !== "selective" && p.plan_lane !== "evm");
  return {
    ...report,
    track_bias_evaluation: evaluateTrackBias(
      [...latestLabs.values()], [...results.values()],
    ),
    walk_forward_backtest: {
      note: "既存の保存済み予想(lab)と発走前オッズ(prerace)に対し、未来日を使わず時系列順に新方式(selective-plan-v1)を仮想適用した結果と現行方式の同一レース比較",
      comparison: compareStrategies([...currentSaved, ...backtestPlans]),
      selective_breakdown: planBreakdown(backtestPlans),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const { values } = parseArgs({ options: { "data-home": { type: "string" }, full: { type: "boolean" } } });
  const dataHome = path.resolve(values["data-home"] ?? path.join(process.env.LOCALAPPDATA ?? ".", "TurfLab"));
  const report = await offlineLearningReport(
    path.join(dataHome, "local-predictions", "exchange"), new Date().toISOString());
  if (!values.full) delete obj(report.learning).per_race;
  console.log(JSON.stringify(report, null, 2));
}
