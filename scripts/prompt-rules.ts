import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTrackName } from "../packages/shared/src/course-catalog";

/** Compact 6-factor definitions replacing the verbose 53-item checklist in free-mode prompts. */
export const COMPACT_FACTORS_SUMMARY =
  "6評価（0〜100の相対評価・確率ではない・根拠なしはnull）: " +
  "ability=近走の走破内容・相手・上がり / " +
  "course=競馬場・左右回り・直線・距離適性 / " +
  "pace=脚質・先行頭数・展開適合 / " +
  "going=当日馬場・天候適性 / " +
  "draw_weight=枠順の距離損益・斤量 / " +
  "horse_jockey_course=騎手の同場実績・戦術と馬の相性。";

const TRACK_RULE_FILES: Record<string, string> = {
  高知: "kochi.md",
  東京: "tokyo.md",
};

/**
 * Loads only the modular rule files relevant to the target race track,
 * keeping the AI prompt compact while preserving track-specific guidance.
 */
export async function loadCompactRules(
  rulesDir: string,
  trackRaw: unknown,
): Promise<string> {
  const track = normalizeTrackName(trackRaw);
  const trackFile = TRACK_RULE_FILES[track];
  const files = [...(trackFile ? [trackFile] : []), "betting.md", "lessons.md"];
  const parts: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(rulesDir, file), "utf8").catch(() => "");
    const trimmed = text.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join("\n\n");
}
