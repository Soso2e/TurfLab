import { describe, expect, it } from "vitest";
import { lookupCourseSpecs, normalizeTrackName } from "../packages/shared/src/course-catalog";

describe("course-catalog", () => {
  it("normalizes track names", () => {
    expect(normalizeTrackName("川崎競馬場")).toBe("川崎");
    expect(normalizeTrackName("門別")).toBe("門別");
    expect(normalizeTrackName(" 金沢 ")).toBe("金沢");
  });

  it("finds exact course specs for Kawasaki 1500m", () => {
    const spec = lookupCourseSpecs("川崎", "ダート", 1500);
    expect(spec).not.toBeNull();
    expect(spec?.straight_length_m).toBe(300);
    expect(spec?.start_to_first_turn_m).toBe(400);
    expect(spec?.direction).toBe("left");
  });

  it("finds exact course specs for Monbetsu 1000m (inner) vs 1200m (outer)", () => {
    const inner = lookupCourseSpecs("門別", "ダート", 1000);
    expect(inner?.straight_length_m).toBe(218);
    expect(inner?.start_to_first_turn_m).toBe(330);
    expect(inner?.direction).toBe("right");

    const outer = lookupCourseSpecs("門別", "ダート", 1200);
    expect(outer?.straight_length_m).toBe(330);
    expect(outer?.start_to_first_turn_m).toBe(270);
  });

  it("falls back to track general defaults for unlisted distance", () => {
    const spec = lookupCourseSpecs("川崎競馬場", "ダート", 1750);
    expect(spec).not.toBeNull();
    expect(spec?.straight_length_m).toBe(300);
    expect(spec?.direction).toBe("left");
  });

  it("returns null for unknown tracks", () => {
    expect(lookupCourseSpecs("火星競馬場", "ダート", 1500)).toBeNull();
  });
});
