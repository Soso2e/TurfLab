import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { obj, type Row } from "../packages/shared/src/domain";
import {
  claimLocalWorker,
  CoreRequestError,
  LocalPredictionWorker,
} from "./local-prediction-worker";

const { values } = parseArgs({
  options: {
    "data-home": { type: "string" },
    once: { type: "boolean" },
    model: { type: "string", default: "gpt-6.1-sol" },
    origin: { type: "string", default: "http://127.0.0.1:8787" },
    "race-url": { type: "string" },
  },
});
if (values["race-url"]) {
  const url = new URL(values["race-url"]);
  if (!values.once || url.protocol !== "https:" || url.username || url.password ||
      url.port || !["www.keiba.go.jp", "www.jra.go.jp", "app.jra.jp"].includes(url.hostname))
    throw new Error("OFFICIAL_RACE_URL_AND_ONCE_REQUIRED");
}
const dataHome = path.resolve(
  values["data-home"] ?? path.join(process.env.LOCALAPPDATA ?? ".", "TurfLab"),
);
const home = path.join(dataHome, "local-predictions");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(values.origin!))
  throw new Error("LOOPBACK_REQUIRED");
const vars = await readFile(path.join(dataHome, ".dev.vars"), "utf8");
const token = vars.match(
  /^API_TOKEN="([0-9]{8}|[A-Za-z0-9_-]{24,})"\r?$/m,
)?.[1];
if (!token) throw new Error("API_TOKEN_MISSING");
const api = async (route: string, body?: unknown) => {
  const response = await fetch(values.origin + "/api" + route, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = response.status === 422 ? await response.json().then(obj).catch(() => ({} as Row)) : {};
    const detail = typeof error.error === "string"
      ? error.error.replaceAll(token, "[認証情報]").slice(0, 300)
      : undefined;
    throw new CoreRequestError(response.status, detail);
  }
  return obj(await response.json());
};
const release = await claimLocalWorker(home);
try {
  let factors = await readFile(
    path.join(process.cwd(), "prompts/prediction-factors.md"),
    "utf8",
  );
  factors +=
    "\n" +
    (await readFile(
      path.join(process.cwd(), "prompts/prediction-method.md"),
      "utf8",
    ));
  const worker = new LocalPredictionWorker(
    home, api, factors, values.model!, undefined, undefined,
    (stage) => api("/local-predictions/status", {
      status: "running", stage, checked_at: new Date().toISOString(),
    }).catch(() => {}),
  );
  await worker.init();
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  do {
    let status;
    try {
      if ((await api("/status")).storage_mode !== "local")
        throw new Error("LOCAL_CORE_REQUIRED");
      status = { ...(await worker.tick(new Date(), values["race-url"])), status: "healthy" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      status = {
        status: "failed",
        checked_at: new Date().toISOString(),
        error: /^(CORE_HTTP_\d+|CODEX_[A-Z_]+|LOCAL_[A-Z_]+)$/.test(message)
          ? message
          : "LOCAL_WORKER_FAILED",
      };
      if (/CORE_HTTP_40[13]/.test(message)) stopping = true;
    }
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "status.json.tmp"), JSON.stringify(status));
    await rename(
      path.join(home, "status.json.tmp"),
      path.join(home, "status.json"),
    );
    await api("/local-predictions/status", status).catch(() => {});
    console.log(
      JSON.stringify({ status: status.status, at: status.checked_at }),
    );
    if (values.once || stopping) break;
    for (let i = 0; i < 60 && !stopping; i++)
      await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (!stopping);
} finally {
  await release();
}
