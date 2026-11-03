import { instant, num, str, type Row } from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";

type Sample = {
  race_id: string;
  race_date_jst: string;
  prediction_id: string;
  model_version_id: string;
  jurisdiction: string;
  track: string;
  distance: string;
  going: string;
  predicted_top1: number;
  actual_winners: number[];
  top1_win: boolean;
  top1_top3: boolean;
  predicted_top3: number[];
  actual_top3: number[];
  overlap_top3: number;
  precision_top3: number;
};
const summarize = (items: Sample[]): Row => {
  const count = items.length;
  const sum = (f: (s: Sample) => number) => items.reduce((n, item) => n + f(item), 0);
  return {
    sample_races: count,
    top1_win_rate: count ? sum((s) => Number(s.top1_win)) / count : null,
    top1_top3_rate: count ? sum((s) => Number(s.top1_top3)) / count : null,
    mean_precision_at3: count ? sum((s) => s.precision_top3) / count : null,
    top3_correct_horses: sum((s) => s.overlap_top3),
    top3_predicted_horses: sum((s) => s.predicted_top3.length),
  };
};
/**
 * Ranking accuracy is calculated independently of calibrated probability
 * metrics (Brier/log loss). Use the adopted prediction, latest official
 * result and an exact horse_number -> entry_id mapping, never popularity.
 * Does not train or change any model.
 */
export async function rankPerformance(repo: Repository): Promise<Row> {
  const [raceList, courses, tracks, predictions, evaluations, entryList,
    results, referenceAdoptions, ownerAdoptions, snapshots] = await Promise.all([
    repo.list("races"), repo.list("course_layouts"), repo.list("tracks"),
    repo.list("predictions"), repo.list("horse_evaluations"), repo.list("race_entries"),
    repo.list("race_results"), repo.list("reference_adoptions"),
    repo.list("prediction_adoptions"), repo.list("race_snapshots"),
  ]);
  const adoptionMap = new Map<string, Row>();
  for (const a of [...ownerAdoptions, ...referenceAdoptions]) {
    const previous = adoptionMap.get(str(a, "race_id"));
    const t = a.adopted_at == null ? 0 : instant(a.adopted_at);
    if (!previous || (previous.adopted_at == null ? 0 : instant(previous.adopted_at)) <= t)
      adoptionMap.set(str(a, "race_id"), a);
  }
  const samples: Sample[] = [];
  const excluded: Row[] = [];
  for (const race of raceList) {
    const latest = results.filter((r) => r.race_id === race.race_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
    if (!latest || latest.official_status !== "official") {
      excluded.push({ race_id: race.race_id, reason: "公式確定結果なし/取消" });
      continue;
    }
    const adoption = adoptionMap.get(str(race, "race_id"));
    const prediction = adoption && predictions.find((p) =>
      p.prediction_id === adoption.prediction_id && p.race_id === race.race_id && p.status === "locked");
    if (!prediction) {
      excluded.push({ race_id: race.race_id, reason: "採用済みlocked予想なし" });
      continue;
    }
    const entries = entryList.filter((e) => e.race_id === race.race_id);
    const active = entries.filter((e) => e.status === "active");
    const byEntry = new Map(entries.map((e) => [e.entry_id, Number(e.horse_number)]));
    const evaluationsByRace = evaluations.filter((e) => e.prediction_id === prediction.prediction_id);
    if (evaluationsByRace.length !== active.length ||
      evaluationsByRace.some((e) => !byEntry.has(e.entry_id) ||
        typeof e.rank !== "number" || !Number.isInteger(e.rank))) {
      excluded.push({ race_id: race.race_id, reason: "全有効馬評価・順位が欠測" });
      continue;
    }
    const ordered = evaluationsByRace.slice().sort((a, b) =>
      Number(a.rank) - Number(b.rank) || Number(byEntry.get(a.entry_id)) - Number(byEntry.get(b.entry_id)));
    const picked = ordered.map((e) => byEntry.get(e.entry_id)!);
    const officialGroups = latest.finish_order_json;
    if (!Array.isArray(officialGroups) || !officialGroups.length ||
      !officialGroups.every((g) => Array.isArray(g) && g.length &&
        g.every((n) => typeof n === "number" && Number.isInteger(n)))) {
      excluded.push({ race_id: race.race_id, reason: "確定着順が不正/欠落" });
      continue;
    }
    const winners = officialGroups[0] as number[];
    const top3: number[] = [];
    for (const group of officialGroups as number[][]) {
      if (top3.length >= 3) break;
      top3.push(...group);
    }
    const topPredicted = picked.slice(0, 3);
    const overlap = topPredicted.filter((n) => top3.includes(n)).length;
    const course = courses.find((c) => c.course_id === race.course_id);
    const track = tracks.find((t) => t.track_id === course?.track_id);
    const snap = snapshots.find((s) => s.snapshot_id === prediction.snapshot_id);
    if (!course || !track || !snap) {
      excluded.push({ race_id: race.race_id, reason: "コース/馬場snapshot参照不足" });
      continue;
    }
    samples.push({
      race_id: str(race, "race_id"),
      race_date_jst: str(race, "race_date_jst"),
      prediction_id: str(prediction, "prediction_id"),
      model_version_id: str(prediction, "model_version_id"),
      jurisdiction: str(race, "jurisdiction"),
      track: str(track, "name"),
      distance: String(course.distance_m),
      going: String(snap.going ?? "欠測"),
      predicted_top1: picked[0],
      actual_winners: winners,
      top1_win: winners.includes(picked[0]),
      top1_top3: top3.includes(picked[0]),
      predicted_top3: topPredicted,
      actual_top3: top3,
      overlap_top3: overlap,
      precision_top3: overlap / topPredicted.length,
    });
  }
  const chronological = samples.sort((a, b) =>
    a.race_date_jst.localeCompare(b.race_date_jst) || a.race_id.localeCompare(b.race_id));
  const groups: Row[] = [];
  for (const key of ["jurisdiction", "track", "distance", "going", "model_version_id"] as const) {
    for (const value of new Set(chronological.map((s) => s[key]))) {
      groups.push({ dimension: key, value,
        ...summarize(chronological.filter((s) => s[key] === value)) });
    }
  }
  return {
    ...summarize(chronological),
    last30: summarize(chronological.slice(-30)),
    last90: summarize(chronological.slice(-90)),
    sample_period_start: chronological[0]?.race_date_jst ?? null,
    sample_period_end: chronological.at(-1)?.race_date_jst ?? null,
    groups,
    excluded,
    recent_races: chronological.slice(-10).map((s) => ({
      race_id: s.race_id, date: s.race_date_jst,
      prediction_id: s.prediction_id,
      predicted_top1: s.predicted_top1,
      actual_winners: s.actual_winners,
      top1_win: s.top1_win,
      precision_at3: s.precision_top3,
    })),
    model_change_authorized: false,
    min_holdout_races_for_candidate: 30,
    limitations: "採用版と最新公式結果の実測順位のみ。確率・人気・オッズ不使用。学習/再重み付けは未実施。モデル変更には未使用期間30R以上の検証と本人承認が必要。",
  };
}
