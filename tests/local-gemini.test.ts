import { describe, expect, it, vi } from "vitest";
import { predictWithGemini, predictWithHelper } from "../scripts/local-gemini";

describe("local-gemini and fallback", () => {
  it("exports predictWithGemini and predictWithHelper functions", () => {
    expect(typeof predictWithGemini).toBe("function");
    expect(typeof predictWithHelper).toBe("function");
  });

  it("predictWithHelper falls back to codexRunner when geminiRunner throws", async () => {
    const mockGemini = vi.fn(async () => {
      throw new Error("GEMINI_START_FAILED");
    });
    const mockCodex = vi.fn(async () => ({
      fallback: true,
      provider: "codex",
    }));

    const result = await predictWithHelper(
      "dummy-dir",
      "dummy-prompt",
      "gemini-3.8-flash-medium",
      true,
      mockGemini,
      mockCodex,
    );

    expect(mockGemini).toHaveBeenCalledWith(
      "dummy-dir",
      "dummy-prompt",
      "gemini-3.8-flash-medium",
      true,
    );
    expect(mockCodex).toHaveBeenCalledWith(
      "dummy-dir",
      "dummy-prompt",
      "gpt-6.1-sol",
      true,
    );
    expect(result).toEqual({ fallback: true, provider: "codex" });
  });

  it("predictWithHelper returns gemini result when successful", async () => {
    const mockGemini = vi.fn(async () => ({
      success: true,
      provider: "gemini",
    }));
    const mockCodex = vi.fn();

    const result = await predictWithHelper(
      "dummy-dir",
      "dummy-prompt",
      "gemini-3.8-flash-medium",
      true,
      mockGemini,
      mockCodex,
    );

    expect(mockGemini).toHaveBeenCalled();
    expect(mockCodex).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, provider: "gemini" });
  });
});
