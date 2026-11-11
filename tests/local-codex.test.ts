import { describe, expect, it } from "vitest";
import { extractJson, predictWithCodex } from "../scripts/local-codex";

describe("local-codex and fallback", () => {
  it("exports predictWithCodex function", () => {
    expect(typeof predictWithCodex).toBe("function");
  });

  describe("extractJson", () => {
    it("extracts nested document string", () => {
      const input = JSON.stringify({ document: JSON.stringify({ race: "ダービー", score: 90 }) });
      expect(extractJson(input)).toEqual({ race: "ダービー", score: 90 });
    });

    it("extracts direct JSON object", () => {
      const input = JSON.stringify({ race: "有馬記念", status: "ok" });
      expect(extractJson(input)).toEqual({ race: "有馬記念", status: "ok" });
    });

    it("extracts JSON from markdown code block", () => {
      const input = 'Here is the result:\n```json\n{\n  "race": "天皇賞",\n  "horses": [1, 2]\n}\n```\nHope it helps!';
      expect(extractJson(input)).toEqual({ race: "天皇賞", horses: [1, 2] });
    });

    it("extracts JSON with surrounding conversational text", () => {
      const input = '確認しました。結果は {"race": "皐月賞", "winner": 5} です。';
      expect(extractJson(input)).toEqual({ race: "皐月賞", winner: 5 });
    });

    it("throws on invalid JSON", () => {
      expect(() => extractJson("no json here at all")).toThrow("CLAUDE_OUTPUT_INVALID_JSON");
    });
  });
});
