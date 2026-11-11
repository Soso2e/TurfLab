// race-flow-v2 stage 2: tendencies computed by code from stored records only
// (no Web access, no odds). Sample sizes are always reported with the numbers.
import { obj, rows, str, type Row } from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";
import { entityMemory } from "./entity-memory";
import { inputPack } from "./race-wizard";

const mean = (values: number[]) =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : null;
/** 0 = winner, 1 = last; null when the run cannot be placed. */
const relative = (finish: unknown, size: unknown) =>
  typeof finish === "number" && typeof size === "number" && size > 1 && finish >= 1 && finish <= size
    ? (finish - 1) / (size - 1) : null;

export async function raceTrends(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  const race = obj(pack.race);
  const distance = Number(obj(pack.course).distance_m);
  const going = obj(pack.research ?? {}).going ?? null;
  const memory = await entityMemory(repo, input, now);

  const horses = rows(memory.horses).map((h) => {
    const runs = rows(h.saved_runs);
    const all = runs.map((r) => relative(r.finish, r.field_size)).filter((v): v is number => v != null);
    const near = runs.filter((r) => Math.abs(Number(r.distance_m) - distance) <= 200)
      .map((r) => relative(r.finish, r.field_size)).filter((v): v is number => v != null);
    const sameGoing = going == null ? [] : runs.filter((r) => r.going === going)
      .map((r) => relative(r.finish, r.field_size)).filter((v): v is number => v != null);
    const early = runs.map((r) => relative(Array.isArray(r.corners) ? r.corners[0] : null, r.field_size))
      .filter((v): v is number => v != null);
    const position = mean(early);
    return {
      horse_number: h.horse_number!,
      runs: all.length,
      finish_relative_mean: mean(all),
      near_distance: { runs: near.length, finish_relative_mean: mean(near) },
      same_going: { going, runs: sameGoing.length, finish_relative_mean: mean(sameGoing) },
      early_position: early.length < 2 || position == null ? "不明"
        : position <= 1 / 3 ? "前方" : position <= 2 / 3 ? "中団" : "後方",
    };
  });

  // Same track and day, officially finished before this race starts.
  const start = Date.parse(str(race, "scheduled_start_at"));
  const sameCourse = new Set((await repo.list("course_layouts"))
    .filter((c) => c.track_id === obj(pack.course).track_id).map((c) => c.course_id));
  const earlier = (await repo.list("races")).filter((r) =>
    r.race_id !== race.race_id && r.race_date_jst === race.race_date_jst &&
    sameCourse.has(r.course_id) && Date.parse(String(r.scheduled_start_at)) < start);
  const results = await repo.list("race_results");
  const entries = await repo.list("race_entries");
  let inner = 0, placed = 0, winnersInner = 0, settled = 0;
  for (const r of earlier) {
    const latest = results.filter((x) => x.race_id === r.race_id && x.official_status === "official" &&
      Date.parse(String(x.published_at ?? x.created_at)) <= Date.parse(now))
      .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    if (!latest) continue;
    const field = entries.filter((e) => e.race_id === r.race_id && e.status === "active");
    const draws = field.map((e) => Number(e.draw_number)).filter((d) => d > 0);
    if (!draws.length) continue;
    const half = Math.max(...draws) / 2;
    const order = (latest.finish_order_json ?? []) as number[][];
    const top3 = order.flat().slice(0, 3);
    const drawOf = (n: number) => Number(field.find((e) => e.horse_number === n)?.draw_number);
    settled++;
    for (const [i, n] of top3.entries()) {
      const d = drawOf(n);
      if (!(d > 0)) continue;
      placed++;
      if (d <= half) { inner++; if (i === 0) winnersInner++; }
    }
  }
  return {
    trends_version: "race-trends-v1",
    race_id: race.race_id!,
    computed_at: now,
    horses,
    same_day: {
      races: settled,
      top3_inner_draw_share: placed ? Math.round((inner / placed) * 1000) / 1000 : null,
      winners_inner_draw: winnersInner,
      note: settled ? "同日・同場の確定済みレースの3着内の枠（内=最大枠の半分以下）" : "同日の確定済みレースなし",
    },
  };
}
