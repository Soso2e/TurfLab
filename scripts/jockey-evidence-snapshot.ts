import { obj, rows, type Row } from "../packages/shared/src/domain";

/**
 * Immutable race-time jockey evidence snapshot for Lab records.
 * Uses the pre-race statistics already attached to the official-data pack;
 * does not calculate skill scores from unsupported observations.
 */
export function jockeyEvidenceSnapshot(pack: Row): Row {
  const research = obj(pack.research ?? {});
  const rawStats = obj(research.jockey_stats ?? {});
  const indexed = new Map(rows(rawStats.jockeys ?? []).map(j => [Number(j.horse_number), j]));
  const horses = rows(research.horses ?? []);
  const entries = rows(pack.entries).filter(e => e.status === "active");
  return {
    version: "jockey-evidence-snapshot-v1",
    source_version: rawStats.version ?? null,
    cutoff_rule: rawStats.cutoff_rule ?? "前走データのみ。現在の出走結果は除外",
    period: rawStats.period ?? null,
    min_samples: rawStats.min_samples ?? null,
    limitations: rawStats.limitations ?? [],
    jockeys: entries.map(e => {
      const number = Number(e.horse_number);
      const stat = indexed.get(number) ?? {};
      const observed = horses.find(h => Number(h.horse_number) === number);
      return {
        horse_number: number,
        jockey_name: e.jockey_name ?? stat.jockey ?? null,
        statistics_available: indexed.has(number),
        period: stat.period ?? null,
        overall: stat.overall ?? null,
        at_track: stat.at_track ?? null,
        at_course: stat.at_course ?? null,
        positions_at_track: stat.positions_at_track ?? null,
        by_distance_band_at_track: stat.by_distance_band_at_track ?? null,
        by_going_at_track: stat.by_going_at_track ?? null,
        combo: stat.combo ?? null,
        jockey_notes: rows(observed?.jockey_notes ?? []).slice(0, 4),
      };
    }),
  };
}
