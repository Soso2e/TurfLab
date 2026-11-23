import { spawn } from "node:child_process";
import path from "node:path";
import { obj, type Row } from "../packages/shared/src/domain";

export type PythonLedgerOptions = {
  exchangeDir: string;
  targetDate: string;
  initialCapitalYen?: number;
  /** The user's own bets (from Core): open stake and net of settled bets. */
  userOpenStakeYen?: number;
  userSettledNetYen?: number;
  scriptPath?: string;
  pythonBin?: string;
  timeoutMs?: number;
};

/**
 * Runs scripts/python/ledger.py deterministically over saved bet plans and
 * official result files, returning the computed capital and P&L ledger.
 * Returns null safely if Python is unavailable or the run fails.
 */
export async function runPythonLedger(
  options: PythonLedgerOptions,
): Promise<Row | null> {
  const payload = {
    exchange_dir: options.exchangeDir,
    target_date: options.targetDate,
    user_open_stake_yen: options.userOpenStakeYen ?? 0,
    user_settled_net_yen: options.userSettledNetYen ?? 0,
    ...(typeof options.initialCapitalYen === "number" &&
    options.initialCapitalYen > 0
      ? { initial_capital_yen: options.initialCapitalYen }
      : {}),
  };

  const scriptPath =
    options.scriptPath ??
    path.join(process.cwd(), "scripts", "python", "ledger.py");
  const pythonBin =
    options.pythonBin ?? process.env.TURFLAB_PYTHON_BIN ?? "python";
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: Row | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(pythonBin, [scriptPath, "--input", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) return finish(null);
      try {
        const parsed = JSON.parse(stdout);
        finish(parsed && typeof parsed === "object" ? obj(parsed) : null);
      } catch {
        finish(null);
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(payload), "utf8");
    child.stdin.end();
  });
}
