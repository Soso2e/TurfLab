import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { obj, type Row } from "../packages/shared/src/domain";
import { extractJson, predictWithCodex } from "./local-codex";

export async function predictWithGemini(
  directory: string,
  prompt: string,
  model = "gemini-3.8-flash-medium",
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
      [
        "-p",
        "-",
        "--model",
        model,
        "--output-format",
        "json",
        "--disable-slash-commands",
      ],
      {
        cwd: directory,
        env,
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let bytes = 0;
    let stopped = false;
    let out = "";
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
      out += chunk.toString("utf8");
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
        resolve(out);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(geminiPrompt);
  });

  let rawResult = stdout;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      if (parsed.structured_output && typeof parsed.structured_output === "object") {
        const document = obj(parsed.structured_output);
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
      if (typeof parsed.response === "string") {
        rawResult = parsed.response;
      }
    }
  } catch {
    // fall through to extractJson
  }

  const document = extractJson(rawResult);
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
  model = "gemini-3.8-flash-medium",
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
    console.warn(
      `[predictWithHelper] Gemini failed (${message}), falling back to Codex / Claude...`,
    );
    return await codexRunner(directory, prompt, "gpt-6.1-sol", webSearch);
  }
}
