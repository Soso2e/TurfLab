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
import { learningReport, planOutcome } from "./lab-learning";

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
  const plans = (await exchangeFiles(exchange, "plans")).map((plan) => {
    const result = results.get(String(plan.race_id));
    return result ? { ...plan, settled: planOutcome(plan, result) } : plan;
  });
  return learningReport(await exchangeFiles(exchange, "outcomes"), plans, odds, now);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const { values } = parseArgs({ options: { "data-home": { type: "string" }, full: { type: "boolean" } } });
  const dataHome = path.resolve(values["data-home"] ?? path.join(process.env.LOCALAPPDATA ?? ".", "TurfLab"));
  const report = await offlineLearningReport(
    path.join(dataHome, "local-predictions", "exchange"), new Date().toISOString());
  if (!values.full) delete obj(report.learning).per_race;
  console.log(JSON.stringify(report, null, 2));
}
