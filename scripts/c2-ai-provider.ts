import { stat } from "node:fs/promises";
import path from "node:path";

const windowsCommands = {
  codex: ["codex.exe", "codex.cmd"],
  claude: ["claude.exe", "claude.cmd"],
  antigravity: ["agy.exe", "agy.cmd", "antigravity.exe", "antigravity.cmd"],
} as const;

export type AiProvider =
  keyof typeof windowsCommands | "chatgpt-github-receipt";
export type AiRequest = {
  jobKey: string;
  runId: string;
  packHash: string;
  model: string | null;
};
export type AiObservation =
  | {
      kind: "cli";
      provider: Exclude<AiProvider, "chatgpt-github-receipt">;
      model: string | null;
      startedAt: string;
      finishedAt: string;
      exitCode: number;
      stdoutJson: unknown;
      stderrDiagnostic: "none" | "redacted";
    }
  | {
      kind: "github-receipt";
      provider: "chatgpt-github-receipt";
      model: string | null;
      observedAt: string;
      branch: string;
      path: string;
      commit: string;
      sourceSha: string;
      contentHash: string;
    };

export interface AiAdapter {
  readonly provider: AiProvider;
  observe(request: AiRequest): Promise<AiObservation>;
}

type CapabilityError =
  "CLI_NOT_ON_PATH" | "NON_INTERACTIVE_UNVERIFIED" | "RECEIPT_ONLY";
export class AiCapabilityError extends Error {
  constructor(readonly code: CapabilityError) {
    super(code);
  }
}

export async function detectWindowsAi(
  provider: AiProvider,
  searchPath = process.env.PATH ?? "",
  isFile = async (file: string) =>
    (await stat(file).catch(() => null))?.isFile() ?? false,
) {
  if (provider === "chatgpt-github-receipt")
    return {
      provider,
      presence: "NOT_APPLICABLE",
      nonInteractive: "NOT_APPLICABLE",
      error: "RECEIPT_ONLY",
    } as const;
  for (const dir of searchPath.split(";")) {
    const root = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!path.win32.isAbsolute(root)) continue;
    for (const command of windowsCommands[provider]) {
      if (await isFile(path.win32.join(root, command)))
        return {
          provider,
          presence: "FOUND",
          nonInteractive: "UNVERIFIED",
          error: "NON_INTERACTIVE_UNVERIFIED",
        } as const;
    }
  }
  return {
    provider,
    presence: "NOT_FOUND_ON_PATH",
    nonInteractive: "UNVERIFIED",
    error: "CLI_NOT_ON_PATH",
  } as const;
}

export function disabledWindowsAiAdapter(provider: AiProvider): AiAdapter {
  return {
    provider,
    async observe() {
      throw new AiCapabilityError((await detectWindowsAi(provider)).error);
    },
  };
}

export function mockAiAdapter(observation: AiObservation): AiAdapter {
  return {
    provider: observation.provider,
    async observe() {
      return structuredClone(observation);
    },
  };
}
