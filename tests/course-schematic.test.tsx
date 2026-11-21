import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseSchematic } from "../apps/web/src/CourseSchematic";

describe("course schematic", () => {
  it("renders a labeled turf oval from stored course attributes", () => {
    const html = renderToStaticMarkup(CourseSchematic({
      course: { surface: "芝", distance_m: 1600, direction: "right", layout: "外回り", straight_length_m: 404, start_to_first_turn_m: 350 },
    }));
    expect(html).toContain("<svg");
    expect(html).toContain("芝 1600m");
    expect(html).toContain("右回り");
    expect(html).toContain("直線 404m");
    expect(html).toContain("模式図");
  });
  it("does not turn missing course metrics into invented zeroes", () => {
    const html = renderToStaticMarkup(CourseSchematic({ course: { direction: "unknown", surface: "ダート", distance_m: null, straight_length_m: null } }));
    expect(html).toContain("距離未取得");
    expect(html).toContain("直線距離未取得");
  });
});
