import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import { enrichCoursesAndPerformances } from "../workers/api/src/maintenance";
import { base } from "./fixtures";

describe("maintenance enrichCoursesAndPerformances", () => {
  it("enriches course_layouts and extracts performances from race_results", async () => {
    const repo = new MemoryRepository();
    const now = "2026-11-11T12:00:00.000Z";

    await repo.put("tracks", {
      ...base,
      track_id: "track:kawasaki",
      name: "川崎",
      jurisdiction: "NAR",
      location: "神奈川",
      timezone: "Asia/Tokyo",
    });

    await repo.put("course_layouts", {
      ...base,
      course_id: "course:kawasaki-1500",
      track_id: "track:kawasaki",
      surface: "ダート",
      distance_m: 1500,
      direction: "unknown",
      layout: "unknown",
      revision: 1,
    });

    await repo.put("races", {
      ...base,
      race_id: "race:kawasaki-1500-1",
      course_id: "course:kawasaki-1500",
      jurisdiction: "NAR",
      external_id: "ext:1",
      race_date_jst: "2026-11-11",
      race_number: 10,
      name: "時雨空特別",
      scheduled_start_at: "2026-11-11T10:30:00.000Z",
      status: "scheduled",
    });

    await repo.put("horses", {
      ...base,
      horse_id: "horse:1",
      horse_name: "テストホース",
    });

    await repo.put("jockeys", {
      ...base,
      jockey_id: "jockey:1",
      jockey_name: "山崎誠士",
      affiliation: "川崎",
    });

    await repo.put("race_entries", {
      ...base,
      entry_id: "entry:1",
      race_id: "race:kawasaki-1500-1",
      horse_id: "horse:1",
      jockey_id: "jockey:1",
      horse_number: 1,
      draw_number: 1,
      status: "active",
    });

    await repo.put("race_results", {
      ...base,
      result_id: "result:1",
      race_id: "race:kawasaki-1500-1",
      revision: 1,
      official_status: "official",
      published_at: now,
      finish_order_json: [[1]],
      entry_status_json: { "1": "finished" },
      supersedes_result_id: null,
    });

    const res = await enrichCoursesAndPerformances(repo, now);
    expect(res.updatedCourses).toBe(1);
    expect(res.restoredPerformances).toBe(1);

    const updatedCourse = await repo.get("course_layouts", "course:kawasaki-1500");
    expect(updatedCourse?.straight_length_m).toBe(300);
    expect(updatedCourse?.start_to_first_turn_m).toBe(400);
    expect(updatedCourse?.direction).toBe("left");

    const perfs = await repo.list("performances");
    expect(perfs.length).toBe(1);
    expect(perfs[0]?.horse_id).toBe("horse:1");
    expect(perfs[0]?.finish_position).toBe(1);
  });
});
