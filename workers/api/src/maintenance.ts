import {
  canonical,
  instant,
  money,
  num,
  obj,
  requireCondition,
  rows,
  str,
  ticket,
  type Row,
} from "../../../packages/shared/src/domain";
import { get, type Repository } from "../../../packages/shared/src/repository";
import { detectJurisdiction, lookupCourseSpecs } from "../../../packages/shared/src/course-catalog";
import { adopt, lockPrediction, saveImport } from "./imports";
import { audit, confirmBet, reviseBet, settle } from "./betting";
import { prepareRace } from "./race-pipeline";

export async function enrichCoursesAndPerformances(
  repo: Repository,
  now: string,
): Promise<{
  updatedCourses: number;
  updatedTracks: number;
  updatedRaces: number;
  restoredPerformances: number;
  totalCourses: number;
  totalPerformances: number;
}> {
  const tracks = await repo.list("tracks");
  let updatedTracks = 0;
  for (const t of tracks) {
    if (t.jurisdiction === "unknown" || !t.jurisdiction) {
      const jur = detectJurisdiction(t.name);
      if (jur !== "unknown") {
        await repo.put("tracks", { ...t, jurisdiction: jur });
        updatedTracks++;
      }
    }
  }

  const freshTracks = await repo.list("tracks");
  const trackMap = new Map(freshTracks.map((t) => [String(t.track_id), t]));

  // 1. Enrich course_layouts with official specifications
  const courses = await repo.list("course_layouts");
  let updatedCourses = 0;
  const courseMap = new Map(courses.map((c) => [String(c.course_id), c]));
  for (const c of courses) {
    const track = trackMap.get(String(c.track_id));
    const trackName = track ? String(track.name) : "";
    const specs = lookupCourseSpecs(trackName, c.surface, c.distance_m);
    if (specs) {
      const needsUpdate =
        c.straight_length_m !== specs.straight_length_m ||
        c.start_to_first_turn_m !== specs.start_to_first_turn_m ||
        c.direction !== specs.direction ||
        c.layout !== specs.layout;

      if (needsUpdate) {
        const updated: Row = {
          ...c,
          direction: specs.direction,
          straight_length_m: specs.straight_length_m,
          start_to_first_turn_m: specs.start_to_first_turn_m,
          layout: specs.layout,
          course_width_m: specs.course_width_m ?? c.course_width_m ?? null,
          revision: Number(c.revision ?? 1) + 1,
        };
        await repo.put("course_layouts", updated);
        courseMap.set(String(c.course_id), updated);
        updatedCourses++;
      }
    }
  }

  // Enrich races jurisdiction if unknown
  const races = await repo.list("races");
  let updatedRaces = 0;
  for (const r of races) {
    if (r.jurisdiction === "unknown" || !r.jurisdiction) {
      const course = courseMap.get(String(r.course_id));
      const track = course ? trackMap.get(String(course.track_id)) : null;
      if (track && track.jurisdiction && track.jurisdiction !== "unknown") {
        await repo.put("races", { ...r, jurisdiction: track.jurisdiction });
        updatedRaces++;
      }
    }
  }

  // 2. Extract official performances from existing race_results
  const results = await repo.list("race_results");
  const entries = await repo.list("race_entries");
  const freshRaces = await repo.list("races");
  const raceMap = new Map(freshRaces.map((r) => [String(r.race_id), r]));
  let restoredPerformances = 0;

  for (const res of results) {
    const raceId = String(res.race_id);
    const race = raceMap.get(raceId);
    if (!race) continue;

    const raceEntries = entries.filter((e) => String(e.race_id) === raceId);
    const positionMap = new Map<number, number>();
    let ahead = 0;
    const finishOrder = Array.isArray(res.finish_order_json)
      ? res.finish_order_json
      : [];
    for (const group of finishOrder) {
      const tied = (Array.isArray(group) ? group : [group]).map(Number);
      for (const n of tied) positionMap.set(n, ahead + 1);
      ahead += tied.length;
    }

    const statuses = obj(res.entry_status_json ?? {});

    for (const entry of raceEntries) {
      const horseNum = Number(entry.horse_number);
      const perfId = `performance:auto:${raceId}:${horseNum}`;
      const existing = await repo.get("performances", perfId) ??
        (await repo.list("performances")).find((p) =>
          p.horse_id === entry.horse_id && (p.race_id === raceId || p.run_date_jst === race.race_date_jst));
      if (!existing) {
        const perf: Row = {
          schema_version: "0.2",
          created_at: now,
          valid_as_of: race.scheduled_start_at,
          source: "official_race_result",
          source_url: res.source_url ?? null,
          is_estimated: false,
          performance_id: perfId,
          horse_id: entry.horse_id,
          race_id: raceId,
          jockey_id: entry.jockey_id,
          finish_position: positionMap.get(horseNum) ?? null,
          finish_time_s: null,
          last_3f_s: null,
          corner_positions_json: [],
          draw_number: entry.draw_number ?? null,
          horse_number: horseNum,
          carried_weight_kg: entry.carried_weight_kg ?? null,
          body_weight_kg: null,
          body_weight_change_kg: null,
          going: null,
          margin: null,
          pace_observed: null,
          running_style_observed: null,
          trouble_notes: String(statuses[String(horseNum)] ?? "") === "scratched" ? "取消" : null,
        };
        await repo.put("performances", perf);
        restoredPerformances++;
      }
    }
  }

  const allCourses = await repo.list("course_layouts");
  const allPerformances = await repo.list("performances");

  return {
    updatedCourses,
    updatedTracks,
    updatedRaces,
    restoredPerformances,
    totalCourses: allCourses.length,
    totalPerformances: allPerformances.length,
  };
}

/**
 * 発走前に作成済みの暫定予想と買い目プランを、当時の時刻整合性を保ったままバックフィル取り込み・精算する。
 */
export async function backfillProvisional(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const items = rows(input.items);
  const results: Row[] = [];
  for (const item of items) {
    const pipeline = obj(item.pipeline);
    const predictionTime = str(item, "prediction_time");
    const p = obj(pipeline.prediction);
    const raceId = str(p, "race_id");
    const predictionId = str(p, "prediction_id");
    const race = await get(repo, "races", raceId);
    requireCondition(
      instant(predictionTime) < instant(race.scheduled_start_at),
      "予想時刻は発走前である必要があります",
    );
    let pred = await repo.get("predictions", predictionId);
    if (!pred) {
      const core = await prepareRace(repo, pipeline, predictionTime);
      await saveImport(repo, core, predictionTime);
      pred = await get(repo, "predictions", predictionId);
    }
    if (pred.status !== "locked") {
      const locked = await lockPrediction(repo, predictionId, predictionTime);
      await audit(
        repo,
        `backfill-lock:${predictionId}`,
        "lock",
        "predictions",
        predictionTime,
        null,
        locked,
      );
    }
    const existingAdopt = (await repo.list("prediction_adoptions")).find(
      (a) => a.race_id === raceId,
    );
    if (!existingAdopt) {
      await adopt(repo, raceId, predictionId, predictionTime);
    }
    const betInputs = rows(item.bets);
    const betResults: Row[] = [];
    for (const b of betInputs) {
      const op = str(b, "operation_id");
      const betTime = str(b, "fixed_at");
      requireCondition(
        instant(betTime) < instant(race.scheduled_start_at),
        "ベット時刻は発走前である必要があります",
      );
      const type = str(b, "ticket_type");
      const sel = ticket(type, b.selections);
      const amount = money(b.amount_yen);
      const priorOp = (await repo.list("virtual_bets")).find(
        (x) => x.operation_id === op,
      );
      if (priorOp) {
        betResults.push(priorOp);
        continue;
      }
      const existingSame = (await repo.list("virtual_bets")).find(
        (x) =>
          x.status === "confirmed" &&
          x.race_id === raceId &&
          x.ticket_type === type &&
          canonical(x.selections_json) === canonical(sel),
      );
      if (existingSame) {
        const revised = await reviseBet(
          repo,
          str(existingSame, "bet_id"),
          {
            operation_id: op,
            expected_bet: existingSame,
            ticket_type: type,
            selections: sel,
            amount_yen: num(existingSame, "amount_yen") + amount,
          },
          betTime,
        );
        betResults.push(revised);
      } else {
        const confirmed = await confirmBet(
          repo,
          {
            operation_id: op,
            race_id: raceId,
            prediction_id: predictionId,
            ticket_type: type,
            selections: sel,
            amount_yen: amount,
            recommendation_id: null,
          },
          betTime,
        );
        betResults.push(confirmed);
      }
    }
    const raceResults = (await repo.list("race_results"))
      .filter((r) => r.race_id === raceId)
      .sort((a, b) => num(b, "revision") - num(a, "revision"));
    const settled = raceResults[0]
      ? await settle(repo, str(raceResults[0], "result_id"), now)
      : [];
    results.push({
      race_id: raceId,
      prediction_id: predictionId,
      bets_count: betResults.length,
      settled_count: settled.length,
      stake_yen: settled.reduce((s, x) => s + num(x, "stake_yen"), 0),
      payout_yen: settled.reduce((s, x) => s + num(x, "payout_yen"), 0),
      refund_yen: settled.reduce((s, x) => s + num(x, "refund_yen"), 0),
      net_yen: settled.reduce((s, x) => s + num(x, "net_yen"), 0),
    });
  }
  return { items: results };
}
