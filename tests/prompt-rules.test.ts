import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPACT_FACTORS_SUMMARY, loadCompactRules } from "../scripts/prompt-rules";

const RULES_DIR = path.join(process.cwd(), "prompts", "rules");

describe("compact prompt rules routing", () => {
  it("loads Kochi + betting + lessons rules for Kochi races without Tokyo rules", async () => {
    const text = await loadCompactRules(RULES_DIR, "高知競馬場");
    expect(text).toContain("高知競馬ルール");
    expect(text).toContain("買い目ルール");
    expect(text).toContain("汎用教訓");
    expect(text).not.toContain("東京競馬場ルール");
    expect(text.length + COMPACT_FACTORS_SUMMARY.length).toBeLessThan(2000);
  });

  it("loads Tokyo + betting + lessons rules for Tokyo races without Kochi rules", async () => {
    const text = await loadCompactRules(RULES_DIR, "東京");
    expect(text).toContain("東京競馬場ルール");
    expect(text).toContain("買い目ルール");
    expect(text).toContain("汎用教訓");
    expect(text).not.toContain("高知競馬ルール");
    expect(text.length + COMPACT_FACTORS_SUMMARY.length).toBeLessThan(2000);
  });
});
