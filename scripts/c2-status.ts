import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { jstDate, obj } from "../packages/shared/src/domain";
import { diagnoseC2 } from "./c2-diagnostics";
import { detectWindowsAi, type AiProvider } from "./c2-ai-provider";

async function readJson(file: string, label: string, optional: boolean) {
  try {
    return obj(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new Error(`${label} を読み取れません`);
  }
}

try {
  const { values } = parseArgs({
    options: {
      "data-home": { type: "string" },
      date: { type: "string" },
      snapshot: { type: "string" },
      providers: { type: "boolean" },
    },
  });
  const home =
    values["data-home"] ??
    (process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "TurfLab"));
  if (!home) throw new Error("--data-home を指定してください");
  const bridge = path.join(home, "github-bridge");
  const [state, health, snapshot] = await Promise.all([
    readJson(path.join(bridge, "state.json"), "Bridge state", true),
    readJson(path.join(bridge, "health.json"), "Worker health", true),
    values.snapshot
      ? readJson(values.snapshot, "Core日次スナップショット", false)
      : null,
  ]);
  const now = new Date().toISOString();
  const providers: AiProvider[] = [
    "codex",
    "claude",
    "antigravity",
    "chatgpt-github-receipt",
  ];
  console.log(
    JSON.stringify(
      {
        ...diagnoseC2(
          values.date ?? jstDate(now),
          now,
          state,
          health,
          snapshot,
        ),
        ...(values.providers
          ? {
              providers: await Promise.all(
                providers.map((provider) => detectWindowsAi(provider)),
              ),
            }
          : {}),
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Node's argument parsing errors can echo user-supplied values.
  console.error(
    error instanceof Error && !(error as NodeJS.ErrnoException).code
      ? error.message
      : "診断の引数を確認してください",
  );
  process.exitCode = 1;
}
