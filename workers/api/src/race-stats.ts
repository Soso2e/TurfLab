// Stats page API: gathers Core rows into the pure race sheet
// (packages/shared/src/stats/race-sheet.ts). Read-only except for the owner's
// manual track observations (含水率・クッション値・内外の印象).
import { hash, instant, jstDate, requireCondition, str, type Json, type Row } from "../../../packages/shared/src/domain";
import { normalizeTrackName } from "../../../packages/shared/src/course-catalog";
import type { Repository } from "../../../packages/shared/src/repository";
import { fromPerformance, mergeCorpus, normName, surfaceOf, type CorpusRunner } from "../../../packages/shared/src/stats/corpus";
import { buildRaceSheet, type SameDayRace, type SheetEntry, type WinOdds } from "../../../packages/shared/src/stats/race-sheet";
import { digestSummary, type StatsDigest } from "../../../packages/shared/src/stats/digest";

type RaceInfo = Row & { track: string; surface: string | null; distance_m: number | null };

async function raceInfos(repo: Repository): Promise<Map<string, RaceInfo>> {
  const tracks = new Map((await repo.list("tracks")).map((t) => [String(t.track_id), t]));
  const courses = new Map((await repo.list("course_layouts")).map((c) => [String(c.course_id), c]));
  const out = new Map<string, RaceInfo>();
  for (const r of await repo.list("races")) {
    const course = courses.get(String(r.course_id));
    const track = course ? tracks.get(String(course.track_id)) : undefined;
    out.set(String(r.race_id), {
      ...r,
      track: track?.name ? normalizeTrackName(track.name) : "",
      surface: course?.surface ? String(course.surface) : null,
      distance_m: typeof course?.distance_m === "number" ? course.distance_m : null,
    });
  }
  return out;
}

/** Every Core runner as corpus rows (results and run records, one per start). */
export async function coreCorpus(repo: Repository, infos?: Map<string, RaceInfo>): Promise<CorpusRunner[]> {
  const races = infos ?? (await raceInfos(repo));
  const out: CorpusRunner[] = [];
  for (const p of await repo.list("performances")) {
    const info = p.race_id ? races.get(String(p.race_id)) : undefined;
    const r = fromPerformance(p, info ? { ...info, race_date_jst: info.race_date_jst ?? null } : undefined);
    if (r) out.push(r);
  }
  return mergeCorpus(out);
}

function latestResult(results: Row[], raceId: string, cutoff: number): Row | null {
  return results
    .filter((r) => r.race_id === raceId && r.official_status === "official" &&
      typeof r.published_at === "string" && Date.parse(r.published_at) <= cutoff)
    .sort((a, b) => Number(b.revision ?? 0) - Number(a.revision ?? 0))[0] ?? null;
}

function trioYen(payouts: Row[], resultId: string): number | null {
  const p = payouts.find((x) => x.result_id === resultId && x.ticket_type === "trio");
  return typeof p?.payout_per_100_yen === "number" ? p.payout_per_100_yen : null;
}

export async function raceStatsSheet(repo: Repository, raceId: string, digest: StatsDigest | null, now: string): Promise<Row> {
  const infos = await raceInfos(repo);
  const race = infos.get(raceId);
  requireCondition(race, `races/${raceId}: 参照がありません`, 404);
  const date = str(race, "race_date_jst");
  const start = typeof race.scheduled_start_at === "string" ? Date.parse(race.scheduled_start_at) : NaN;
  const nowMs = instant(now);
  const cutoff = Number.isFinite(start) ? Math.min(start, nowMs) : nowMs;

  const entriesRaw = (await repo.list("race_entries"))
    .filter((e) => e.race_id === raceId && e.status === "active")
    .sort((a, b) => Number(a.horse_number) - Number(b.horse_number));
  const horses = new Map((await repo.list("horses")).map((h) => [String(h.horse_id), h]));
  const jockeys = new Map((await repo.list("jockeys")).map((j) => [String(j.jockey_id), j]));
  const snapshots = (await repo.list("race_snapshots"))
    .filter((s) => s.race_id === raceId && typeof s.captured_at === "string" && Date.parse(s.captured_at) <= nowMs)
    .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
  const snap = snapshots[0] ?? null;
  const snapEntries = new Map<number, Row>();
  if (snap && Array.isArray(snap.entries_state_json))
    for (const e of snap.entries_state_json)
      if (e && typeof e === "object" && !Array.isArray(e)) snapEntries.set(Number((e as Row).horse_number), e as Row);
  const entries: SheetEntry[] = entriesRaw.map((e) => {
    const s = snapEntries.get(Number(e.horse_number));
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      horse_number: Number(e.horse_number),
      draw: n(e.draw_number),
      horse_id: e.horse_id ? String(e.horse_id) : null,
      horse_name: (horses.get(String(e.horse_id))?.horse_name as string) ?? null,
      jockey_name: e.jockey_id ? ((jockeys.get(String(e.jockey_id))?.jockey_name as string) ?? null) : null,
      carried_weight_kg: n(e.carried_weight_kg),
      body_weight_kg: n(s?.body_weight_kg),
      body_weight_change_kg: n(s?.body_weight_change_kg),
    };
  });

  const corpus = await coreCorpus(repo, infos);
  const horseRuns = new Map<string, CorpusRunner[]>();
  for (const e of entries) {
    if (!e.horse_id) continue;
    const name = e.horse_name ? normName(e.horse_name) : null;
    horseRuns.set(
      e.horse_id,
      corpus
        .filter((r) => r.date < date && (r.horse_id === e.horse_id || (!r.horse_id && name && r.horse === name)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.race_no - a.race_no),
    );
  }

  // Same-day races at the track, finished and published before the cutoff.
  const results = await repo.list("race_results");
  const payouts = await repo.list("payouts");
  const sameDay: SameDayRace[] = [];
  for (const other of infos.values()) {
    if (other.race_id === raceId || other.race_date_jst !== date || other.track !== race.track) continue;
    if (typeof other.scheduled_start_at !== "string" || !(Date.parse(other.scheduled_start_at) < start)) continue;
    const res = latestResult(results, String(other.race_id), cutoff);
    if (!res) continue;
    const key = `${other.track}|${date}|${other.race_number}`;
    sameDay.push({
      race_id: String(other.race_id),
      race_no: Number(other.race_number),
      start_at: String(other.scheduled_start_at),
      published_at: String(res.published_at),
      surface: surfaceOf(other.surface),
      distance_m: other.distance_m,
      runners: corpus.filter((r) => r.race_key === key),
      trio_yen: trioYen(payouts, String(res.result_id)),
    });
  }
  sameDay.sort((a, b) => a.race_no - b.race_no);

  // Win odds observed before the cutoff.
  const odds = (await repo.list("odds_snapshots"))
    .filter((o) => o.race_id === raceId && o.ticket_type === "win" && typeof o.captured_at === "string" && Date.parse(o.captured_at) <= cutoff)
    .sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  const winOdds: WinOdds[] = entries.map((e) => {
    const list = odds.filter((o) => Array.isArray(o.selections_json) && Number(o.selections_json[0]) === e.horse_number && typeof o.odds === "number");
    return {
      horse_number: e.horse_number,
      first: list.length ? Number(list[0].odds) : null,
      latest: list.length ? Number(list[list.length - 1].odds) : null,
      latest_at: list.length ? String(list[list.length - 1].captured_at) : null,
      points: list.length,
    };
  });

  const observations = (await repo.list("track_observations"))
    .filter((o) => normalizeTrackName(o.track) === race.track && o.date_jst === date &&
      typeof o.observed_at === "string" && Date.parse(o.observed_at) <= nowMs)
    .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));

  // Latest AI six-factor components for comparison (never mixed into the data score).
  const aiScores = new Map<number, Row>();
  const preds = (await repo.list("predictions"))
    .filter((p) => p.race_id === raceId)
    .sort((a, b) => String(b.predicted_at ?? "").localeCompare(String(a.predicted_at ?? "")));
  if (preds.length) {
    const evals = (await repo.list("horse_evaluations")).filter((e) => e.prediction_id === preds[0].prediction_id);
    for (const ev of evals) {
      const entry = entriesRaw.find((e) => e.entry_id === ev.entry_id);
      if (entry && ev.abilities_json && typeof ev.abilities_json === "object")
        aiScores.set(Number(entry.horse_number), { ...(ev.abilities_json as Row), total: ev.score ?? null, prediction_id: preds[0].prediction_id! });
    }
  }

  const going = (observations.find((o) => o.going)?.going as string | undefined) ?? (snap?.going as string | undefined) ?? null;
  return buildRaceSheet({
    race: {
      race_id: raceId,
      date,
      track: race.track,
      race_no: Number(race.race_number),
      name: (race.name as string) ?? null,
      surface: surfaceOf(race.surface),
      distance_m: race.distance_m,
      start_at: (race.scheduled_start_at as string) ?? null,
      going,
      going_source: observations.find((o) => o.going) ? "手入力の馬場観察" : snap?.going ? "レースsnapshot" : null,
    },
    entries,
    horseRuns,
    coreRunners: corpus,
    sameDay,
    digest,
    winOdds,
    observations,
    aiScores,
    as_of: now,
  });
}

/** Races of one JST day for the page's race picker (default: today, else the latest day with races). */
export async function raceStatsDay(repo: Repository, date: string | null, now: string, digest: StatsDigest | null): Promise<Row> {
  const infos = await raceInfos(repo);
  const days = [...new Set([...infos.values()].map((r) => String(r.race_date_jst ?? "")).filter(Boolean))].sort();
  const today = jstDate(now);
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : days.includes(today) ? today : days.filter((d) => d <= today).at(-1) ?? days.at(-1) ?? today;
  const races = [...infos.values()]
    .filter((r) => r.race_date_jst === day)
    .sort((a, b) => a.track.localeCompare(b.track) || Number(a.race_number) - Number(b.race_number))
    .map((r) => ({
      race_id: r.race_id!,
      track: r.track,
      race_number: r.race_number ?? null,
      name: r.name ?? null,
      surface: r.surface,
      distance_m: r.distance_m,
      scheduled_start_at: r.scheduled_start_at ?? null,
    }));
  return { date: day, days: days.slice(-60) as Json, races: races as unknown as Json, digest: digestSummary(digest) };
}

const GOINGS = ["良", "稍重", "重", "不良"];
const LANE_NOTES = ["内有利", "外有利", "フラット", "不明"];
const pct = (v: unknown, max: number) => (v == null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : NaN);

/** POST /race-stats/track-observations — the owner's own observation of the
 * track (official moisture / cushion values and lane impressions). Append-only. */
export async function saveTrackObservation(repo: Repository, input: Row, now: string): Promise<Row> {
  const track = normalizeTrackName(str(input, "track"));
  requireCondition(track.length > 0 && track.length <= 12, "競馬場が不正です");
  const date = str(input, "date_jst");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(date), "日付が不正です");
  const surface = input.surface == null ? null : surfaceOf(input.surface);
  const values = {
    moisture_goal_pct: pct(input.moisture_goal_pct, 100),
    moisture_4c_pct: pct(input.moisture_4c_pct, 100),
    cushion_value: pct(input.cushion_value, 20),
  };
  for (const [k, v] of Object.entries(values)) requireCondition(!Number.isNaN(v), `${k}: 範囲外です`);
  const going = input.going == null || input.going === "" ? null : String(input.going);
  requireCondition(going == null || GOINGS.includes(going), "馬場状態が不正です");
  const lane = input.lane_note == null || input.lane_note === "" ? null : String(input.lane_note);
  requireCondition(lane == null || LANE_NOTES.includes(lane), "内外の印象が不正です");
  const note = input.note == null ? null : String(input.note).slice(0, 200);
  const sourceUrl = input.source_url == null || input.source_url === "" ? null : String(input.source_url);
  if (sourceUrl) {
    const u = new URL(sourceUrl);
    requireCondition(u.protocol === "https:", "出典URLはhttpsです");
  }
  requireCondition(
    going || lane || note || Object.values(values).some((v) => v != null),
    "記録する値がありません",
  );
  const body = { track, date, surface, going, lane, note, ...values, sourceUrl };
  const row: Row = {
    observation_id: `track-observation:${await hash([body, now])}`,
    schema_version: "0.2",
    created_at: now,
    source: sourceUrl ? "official_page_manual" : "owner_observation",
    source_url: sourceUrl,
    retrieved_at: now,
    valid_as_of: now,
    available_at: now,
    is_estimated: false,
    track,
    date_jst: date,
    surface,
    observed_at: now,
    going,
    moisture_goal_pct: values.moisture_goal_pct,
    moisture_4c_pct: values.moisture_4c_pct,
    cushion_value: values.cushion_value,
    lane_note: lane,
    note,
  };
  await repo.put("track_observations", row);
  return { status: "saved", observation: row };
}

