import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { obj, type Row } from "../packages/shared/src/domain";
import { extractJson, predictWithCodex } from "./local-codex";
import { emitOperationalEvent } from "../packages/shared/src/operational-event";

// agyのrun_command(シェル実行)は、Windowsで実行のたびに一瞬コンソールが出る。
// 調査は検索・URL読み込みで足りる想定なので、既定ではシェルを拒否する。
// 従来どおり許可するときは TURFLAB_GEMINI_ALLOW_SHELL=1。
export function geminiCliArgs(
  model: string,
  allowShell = process.env.TURFLAB_GEMINI_ALLOW_SHELL === "1",
): string[] {
  const args = [
    "--model",
    model,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
  ];
  if (!allowShell) {
    args.push("--settings", JSON.stringify({ permissions: { deny: ["command(*)"] } }));
  }
  return args;
}

export async function predictWithGemini(
  directory: string,
  prompt: string,
  model = "gemini-4-hydrogen-medium",
  webSearch = true,
): Promise<Row> {
  void webSearch;
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, "answer.json");
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  const geminiPrompt =
    prompt +
    "\n\n【出力形式の絶対遵守】余計な説明文や挨拶は一切含めず、必ず要求されたスキーマに合致する有効なJSON形式のみを出力してください。";

  const startedAt = new Date().toISOString();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "agy",
      geminiCliArgs(model),
      {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let bytes = 0;
    let stopped = false;
    let out = "";
    const decoder = new StringDecoder("utf8");
    const stop = () => {
      stopped = true;
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(stop, 15 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      out += decoder.write(chunk);
      if (bytes > 8_000_000) stop();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("GEMINI_START_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code !== 0) {
        reject(new Error(stopped ? "GEMINI_TIMEOUT" : "GEMINI_EXIT_FAILED"));
      } else {
        resolve(out + decoder.end());
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ event: "user", message: { content: geminiPrompt } }) + "\n");
  });

  let document: Row;
  try {
    let result: Row | undefined;
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const event = obj(JSON.parse(line));
      if (event.event === "result") result = obj(event.result);
    }
    if (!result || result.status !== "SUCCESS") throw new Error("GEMINI_RESULT_FAILED");
    const structured = result.structured_output;
    document = structured && typeof structured === "object" && !Array.isArray(structured)
      ? obj(structured)
      : extractJson(typeof result.response === "string" ? result.response : "");
  } catch (error) {
    // Keep the end of the stream so the final result is available for diagnosis.
    await writeFile(path.join(directory, "gemini-raw.txt"), stdout.slice(-20_000)).catch(() => {});
    if (error instanceof Error && error.message === "GEMINI_RESULT_FAILED") throw error;
    throw new Error("GEMINI_OUTPUT_INVALID");
  }
  await writeFile(
    output,
    JSON.stringify({ document: JSON.stringify(document) }),
  );
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify({
      provider: "gemini",
      model,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
    }),
  );
  return document;
}

export async function predictWithHelper(
  directory: string,
  prompt: string,
  model = "gemini-4-hydrogen-medium",
  webSearch = true,
  geminiRunner: (
    directory: string,
    prompt: string,
    model: string,
    webSearch?: boolean,
  ) => Promise<Row> = predictWithGemini,
  codexRunner: (
    directory: string,
    prompt: string,
    model: string,
    webSearch?: boolean,
  ) => Promise<Row> = predictWithCodex,
): Promise<Row> {
  try {
    return await geminiRunner(directory, prompt, model, webSearch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitOperationalEvent({
      event: "ai.fallback",
      component: "local-prediction-worker",
      run_id: path.basename(directory),
      model,
      from_provider: "gemini",
      to_provider: "codex-cli",
      error_code: /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : "AI_INVOKE_FAILED",
    });
    return await codexRunner(directory, prompt, "gpt-6.2-sol", webSearch);
  }
}
