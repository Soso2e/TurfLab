// Odds-free forecast ledger tools.
//   npm run forecast:lock   -- --root <exchange> --file <forecast.json>      (validate + write-once lock)
//   npm run forecast:result -- --root <exchange> --official <result.json> --race-key "YYYY-MM-DD|場|11R"
//   npm run forecast:report -- --root <exchange> [--math math-m1] [--ai ai-independent-v2] [--out report.json]
// Reads/writes only <root>/forecasts and <root>/forecast-results. No API, no AI, no network.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateForecast } from "../packages/shared/src/forecast-contract";
import { buildReport, loadForecasts, loadResults, lockForecast, raceResultFromOfficial, safeKey } from "./forecast-eval";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { root: { type: "string" }, file: { type: "string" }, official: { type: "string" }, "race-key": { type: "string" },
      math: { type: "string", default: "math-m1" }, ai: { type: "string", default: "ai-independent-v2" }, out: { type: "string" } },
  });
  if (!values.root) throw new Error("--root <exchange dir> is required");
  if (command === "lock") {
    const checked = validateForecast(JSON.parse(await readFile(values.file!, "utf8")));
    if (!checked.ok) { console.error(JSON.stringify({ status: "rejected", errors: checked.errors }, null, 1)); process.exit(2); }
    console.log(JSON.stringify(await lockForecast(values.root, checked.forecast)));
  } else if (command === "result") {
    const key = values["race-key"]!;
    const result = raceResultFromOfficial(JSON.parse(await readFile(values.official!, "utf8")), key, key.split("|")[0]);
    if (!result) throw new Error("official document has no finish order");
    const file = path.join(values.root, "forecast-results", result.date_jst, `${safeKey(key)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result, null, 1), { flag: "wx" }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    console.log(JSON.stringify({ status: "ok", file }));
  } else if (command === "report") {
    const { forecasts, rejected } = await loadForecasts(values.root);
    const report = buildReport(forecasts, await loadResults(values.root), rejected.length, values.math!, values.ai!);
    const text = JSON.stringify({ ...report, rejected_files: rejected }, null, 1);
    if (values.out) await writeFile(values.out, text);
    console.log(text);
  } else throw new Error("usage: forecast-eval-cli <lock|result|report> --root <dir> ...");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
