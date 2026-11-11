import { expect, it, vi } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { MemoryRepository } from "../packages/shared/src/repository";

const pack: Row = {
  pack_hash: "h1", snapshot_id: "s1", information_cutoff_at: "2026-11-11T00:00:00.000Z",
  race: { race_id: "r1", race_date_jst: "2026-11-11", scheduled_start_at: "2026-11-11T06:00:00.000Z" },
  track: { track_id: "t1", name: "川崎" },
  course: { track_id: "t1", distance_m: 1400 },
  entries: [
    { horse_number: 1, horse_id: "h-a", jockey_id: "j-a", horse_name: "A", jockey_name: "J", status: "active" },
    { horse_number: 2, horse_id: "h-b", jockey_id: "j-b", horse_name: "B", jockey_name: "K", status: "active" },
  ],
  research: {
    history_version: "official-history-v1", history_checked_at: "2026-11-11T00:00:00.000Z", going: "良",
    horses: [
      { horse_number: 1, jockey_notes: [{ source_url: "https://www.keiba.go.jp/r", note: "川崎 30騎乗" }], recent_runs: [
        { date_jst: "2026-10-20", track: "川崎", distance_m: 1400, finish: 1, field_size: 10, corners: [1, 1], going: "良", source_url: "https://www.keiba.go.jp/a1" },
        { date_jst: "2026-10-01", track: "大井", distance_m: 1000, finish: 5, field_size: 10, corners: [3, 3], source_url: "https://www.keiba.go.jp/a2" },
        { date_jst: "2026-09-10", track: "川崎", distance_m: 1500, finish: 2, field_size: 10, corners: [2, 2], source_url: "https://www.keiba.go.jp/a3" },
        { date_jst: "2026-11-11", track: "川崎", distance_m: 1400, finish: 1, source_url: "https://www.keiba.go.jp/today" },
      ] },
      { horse_number: 2, recent_runs: [{ date_jst: "2026-10-05", track: "川崎", distance_m: 1400, finish: 3, field_size: 8 }] },
    ],
  },
};
vi.mock("../workers/api/src/race-wizard", () => ({ inputPack: vi.fn(async () => pack) }));
const { entityMemory, saveEntityMemory } = await import("../workers/api/src/entity-memory");
const { raceTrends } = await import("../workers/api/src/race-trends");

async function repo() {
  const r = new MemoryRepository();
  for (const [id, name] of [["h-a", "A"], ["h-b", "B"]])
    await r.put("horses", { schema_version: "0.2", horse_id: id, horse_name: name });
  for (const [id, name] of [["j-a", "J"], ["j-b", "K"]])
    await r.put("jockeys", { schema_version: "0.2", jockey_id: id, jockey_name: name });
  return r;
}

it("stores sourced past runs once per horse and reuses them", async () => {
  const r = await repo();
  const now = "2026-11-11T01:00:00.000Z";
  expect(await saveEntityMemory(r, { snapshot_id: "s1", pack_hash: "h1" }, now))
    .toMatchObject({ saved_runs: 3, saved_jockey_notes: 1 });
  // Idempotent: the same observations are not stored twice.
  expect(await saveEntityMemory(r, { snapshot_id: "s1", pack_hash: "h1" }, now))
    .toMatchObject({ saved_runs: 0, saved_jockey_notes: 0 });
  const memory = await entityMemory(r, { snapshot_id: "s1" }, now);
  const [a, b] = memory.horses as Row[];
  expect(a).toMatchObject({ runs_missing: 0 });
  expect((a.saved_runs as Row[]).map((x) => x.date_jst)).toEqual(["2026-10-20", "2026-10-01", "2026-09-10"]);
  expect(a.jockey_notes).toHaveLength(1);
  // Unsourced runs never enter the store, so horse 2 still needs a search.
  expect(b).toMatchObject({ runs_missing: 3, jockey_notes: [] });
  expect(memory.complete).toBe(false);
});

it("rejects a pack that does not match", async () => {
  await expect(saveEntityMemory(await repo(), { snapshot_id: "s1", pack_hash: "other" }, "2026-11-11T01:00:00.000Z"))
    .rejects.toThrow();
});

it("aggregates horse tendencies from stored runs with sample sizes", async () => {
  const r = await repo();
  const now = "2026-11-11T01:00:00.000Z";
  await saveEntityMemory(r, { snapshot_id: "s1", pack_hash: "h1" }, now);
  const trends = await raceTrends(r, { snapshot_id: "s1" }, now);
  const a = (trends.horses as Row[])[0];
  expect(a).toMatchObject({ runs: 3, early_position: "前方" });
  expect((a.near_distance as Row).runs).toBe(2);
  expect((a.same_going as Row).runs).toBe(1);
  expect(trends.same_day).toMatchObject({ races: 0 });
});
