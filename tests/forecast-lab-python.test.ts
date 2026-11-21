import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateForecast } from "../packages/shared/src/forecast-contract";
import { lockForecast } from "../scripts/forecast-eval";

const run = promisify(execFile);
const python = process.env.TURFLAB_PYTHON_BIN ?? "python";

describe("forecast lab (Python M) → forecast-v1 → TS ledger", () => {
  it("emits a record the TS contract accepts, then locks it write-once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fl-"));
    try {
      await run(python, ["scripts/python/forecast_lab/cli.py", "demo", "--out-dir", dir], { timeout: 120_000 });
      const raw = JSON.parse(await readFile(path.join(dir, "forecast.json"), "utf8"));
      const checked = validateForecast(raw, raw.horses.map((h: { horse_number: number }) => h.horse_number));
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      expect(checked.forecast.forecaster.kind).toBe("math");
      expect(checked.forecast.inputs_attestation.odds_used).toBe(false);
      expect((await lockForecast(dir, checked.forecast)).status).toBe("locked");
      const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
      expect(report.data.odds_used).toBe(false);
      expect(report.paired_log_loss.M1_vs_uniform.mean).toBeLessThan(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 150_000);
  it("python unit tests (leakage, one-shot holdout, no false claims) pass", async () => {
    const { stderr } = await run(python, ["-m", "unittest", "forecast_lab.tests.test_forecast_lab"], { cwd: "scripts/python", timeout: 180_000 });
    expect(stderr).toMatch(/OK/);
  }, 200_000);
});
