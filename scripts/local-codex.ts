import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { obj, str, type Row } from "../packages/shared/src/domain";

// One isolated, read-only process. Only public web search is available to the model.
export async function predictWithCodex(
  directory: string,
  prompt: string,
  model: string,
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
        'web_search="live"',
        "-c",
        "project_doc_max_bytes=0",
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
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
    }),
  );
  return document;
}
