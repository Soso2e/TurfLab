import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { obj, str, type Row } from "../packages/shared/src/domain";

export function extractJson(text: string): Row {
  // 1. Try direct parse
  try {
    const raw = JSON.parse(text);
    if (typeof raw === "object" && raw !== null) {
      if (typeof raw.document === "string") {
        try {
          return obj(JSON.parse(raw.document));
        } catch {
          // not nested json string
        }
      }
      return obj(raw);
    }
  } catch {}

  // 2. Try markdown json block
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (blockMatch) {
    try {
      const raw = JSON.parse(blockMatch[1]);
      if (typeof raw === "object" && raw !== null) {
        if (typeof raw.document === "string") {
          try {
            return obj(JSON.parse(raw.document));
          } catch {}
        }
        return obj(raw);
      }
    } catch {}
  }

  // 3. Try finding outermost { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const raw = JSON.parse(text.slice(start, end + 1));
      if (typeof raw === "object" && raw !== null) {
        if (typeof raw.document === "string") {
          try {
            return obj(JSON.parse(raw.document));
          } catch {}
        }
        return obj(raw);
      }
    } catch {}
  }

  throw new Error("CLAUDE_OUTPUT_INVALID_JSON");
}

export async function predictWithClaude(
  directory: string,
  prompt: string,
): Promise<Row> {
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
  ])
    if (process.env[key]) env[key] = process.env[key];

  const claudePrompt =
    prompt +
    "\n\n【出力形式の絶対遵守】余計な説明文や挨拶は一切含めず、必ず要求されたスキーマに合致する有効なJSON形式（{\"document\": \"<エスケープされたJSON文字列>\"} または直接要求されたJSON）のみを出力してください。";

  const startedAt = new Date().toISOString();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json"],
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
      if (process.platform === "win32" && child.pid)
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      else child.kill("SIGKILL");
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
      reject(new Error("CLAUDE_START_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code !== 0)
        reject(new Error(stopped ? "CLAUDE_TIMEOUT" : "CLAUDE_EXIT_FAILED"));
      else resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(claudePrompt);
  });

  let rawResult = stdout;
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.result === "string") rawResult = parsed.result;
  } catch {}

  const document = extractJson(rawResult);
  await writeFile(
    output,
    JSON.stringify({ document: JSON.stringify(document) }),
  );
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify({
      provider: "claude",
      model: "claude-code",
      fallback_from: "codex",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
    }),
  );
  return document;
}

async function executeCodex(
  directory: string,
  prompt: string,
  model: string,
  webSearch = true,
  reasoningEffort = "low",
): Promise<Row> {
  await mkdir(directory, { recursive: true });
  const schema = path.join(directory, "schema.json");
  const output = path.join(directory, "answer.json");
  await writeFile(
    schema,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["document"],
      properties: {
        document: {
          type: "string",
          description: "Requested JSON document serialized as a string",
        },
      },
    }),
  );
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
  ])
    if (process.env[key]) env[key] = process.env[key];
  const startedAt = new Date().toISOString();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        "--disable",
        "shell_tool",
        "--disable",
        "multi_agent",
        "-c",
        webSearch ? 'web_search="live"' : 'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`,
        "--output-schema",
        schema,
        "--output-last-message",
        output,
        "--json",
        "-",
      ],
      {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let bytes = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (process.platform === "win32" && child.pid)
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 15 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8_000_000) stop();
    });
    child.stderr.on("data", () => {
      /* Diagnostics may contain credentials. Retain only exit status. */
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("CODEX_START_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code !== 0)
        reject(new Error(stopped ? "CODEX_TIMEOUT" : "CODEX_EXIT_FAILED"));
      else resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
  const raw = await readFile(output, "utf8");
  if (Buffer.byteLength(raw) > 262144)
    throw new Error("CODEX_OUTPUT_TOO_LARGE");
  const document = obj(JSON.parse(str(obj(JSON.parse(raw)), "document")));
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify({
      provider: "codex",
      model,
      reasoning_effort: reasoningEffort,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
    }),
  );
  return document;
}

// One isolated, read-only process. Automatically falls back to Claude Code on quota exhaustion or error.
export async function predictWithCodex(
  directory: string,
  prompt: string,
  model: string,
  webSearch = true,
  reasoningEffort = "low",
): Promise<Row> {
  try {
    return await executeCodex(directory, prompt, model, webSearch, reasoningEffort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[predictWithCodex] Codex failed (${message}), falling back to Claude Code...`);
    try {
      return await predictWithClaude(directory, prompt);
    } catch (fallbackError) {
      console.error("[predictWithCodex] Claude Code fallback failed:", fallbackError);
      throw error;
    }
  }
}
