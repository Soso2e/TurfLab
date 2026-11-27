import { DatabaseSync } from "node:sqlite";
import { BOATS, type BoatRecord, type BoatResult } from "../packages/shared/src/boatrace";
import { topThree } from "../packages/shared/src/boatrace-b13";
import { extractB13V2Features, type B13V2FittedModel, type B13V2RaceFeatures } from "../packages/shared/src/boatrace-b13-v2";
import { mergeBoatArchives, type BoatArchiveInput } from "../packages/shared/src/boatrace-research";

type Revision = NonNullable<BoatArchiveInput["revisions"]>[number];
export type Frozen = {
  raceId: string;
  date: string;
  cutoff: string;
  frozenAt: string;
  preUsedNoEx: boolean;
  inputs: B13V2RaceFeatures;
  predictions: { B13v2Pre: { top5: { combination: string; probability: number }[] } };
};
export type Local = {
  records: BoatRecord[];
  revisions: Revision[];
  frozen: Frozen[];
  models: { date: string; modelPre: B13V2FittedModel | null; modelNoEx: B13V2FittedModel | null }[];
};
export const emptyLocal: Local = { records: [], revisions: [], frozen: [], models: [] };

export function readLocal(path: string): Local {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has("boat_races")) throw new Error("SQLite に boat_races がありません");
    function read(table: string, order: string) {
      return tables.has(table) ? db.prepare(`SELECT body FROM ${table} ORDER BY ${order}`).all()
        .map(row => JSON.parse(String(row.body))) : [];
    }
    return {
      records: read("boat_races", "date, id"),
      revisions: tables.has("boat_result_revisions")
        ? db.prepare("SELECT id, body FROM boat_result_revisions ORDER BY id, fetched_at").all()
          .map(row => ({ raceId: String(row.id), result: JSON.parse(String(row.body)) }))
        : [],
      frozen: read("boat_shadow_predictions", "date, race_id"),
      models: read("boat_shadow_models", "date"),
    };
  } finally {
    db.close();
  }
}

export const before = (a: string | null | undefined, b: string | null | undefined) =>
  Date.parse(a ?? "") < Date.parse(b ?? "");
const cutoff = (race: BoatRecord) => race.freeze?.cutoff ?? race.cutoff;
export const inspiration = (race: BoatRecord) => race.date === "2026-11-27" && race.venue === "15" && race.number === 12;

export function outcome(race: BoatRecord, result = race.result) {
  const order = topThree({ ...race, result });
  if (!result) return "missing" as const;
  if (result.status === "void") return "void" as const;
  if (!order) return "ambiguousTopThree" as const;
  const boats = result.finishes.map(f => f.boat).sort().join("");
  const positions = result.finishes.map(f => f.position).sort().join("");
  if (boats === "123456" && positions === "123456" && !result.refundBoats.length) return "clean" as const;
  return "nonstandard" as const;
}

export function outcomeClass(order: readonly number[]) {
  return order[0] === 1 ? 0 : order.includes(1) ? 1 : 2;
}

export function prepare(archives: BoatArchiveInput[], local: Local) {
  const all = [...archives, { file: "local-sqlite", date: "", records: local.records, revisions: local.revisions }];
  const merged = mergeBoatArchives(all);
  const programs = new Map<string, BoatRecord>();
  const versions = new Map<string, Map<string, BoatResult>>();
  const exhibitions = new Map<string, BoatRecord[]>();
  const seenExhibitions = new Set<string>();
  const conflictingLabels = new Set<string>();
  const labelFields = (r: BoatResult) => JSON.stringify([
    r.status, [...r.refundBoats].sort(), r.finishes.map(f => [f.boat, f.position]).sort(),
  ]);

  function observe(id: string, result: BoatResult) {
    const revisions = versions.get(id) ?? new Map();
    const rawTime = result.evidence.fetchedAt;
    const time = Number.isFinite(Date.parse(rawTime)) ? new Date(rawTime).toISOString() : "";
    const old = revisions.get(time);
    if (old && labelFields(old) !== labelFields(result)) conflictingLabels.add(`${id}/${time}`);
    revisions.set(time, result);
    versions.set(id, revisions);
  }
  for (const archive of all) {
    for (const race of archive.records) {
      if (race.result) observe(race.id, race.result);
      const old = programs.get(race.id);
      if (before(race.program.fetchedAt, cutoff(race)) && (!old || !before(race.program.fetchedAt, old.program.fetchedAt))) {
        programs.set(race.id, race);
      }
      // Evaluate both saved exhibition sources independently. A late freeze cannot mask an earlier valid snapshot.
      const candidates = [
        { ...race, exhibition: undefined },
        { ...race, freeze: undefined, cutoff: cutoff(race) },
      ];
      for (const candidate of candidates) {
        const payload = candidate.freeze ? [candidate.freeze.evidence.exhibition,
          candidate.freeze.entries.map(e => [e.boat, e.exhibitionCourse, e.exhibitionST, e.exhibitionF, e.exhibitionSeconds])]
          : candidate.exhibition;
        if (!payload) continue;
        const key = JSON.stringify([candidate.id, payload]);
        if (seenExhibitions.has(key)) continue;
        seenExhibitions.add(key);
        const list = exhibitions.get(race.id) ?? [];
        list.push(candidate);
        exhibitions.set(race.id, list);
      }
    }
    for (const { raceId, result } of archive.revisions ?? []) observe(raceId, result);
  }
  const rows = merged.races.map(race => {
    const program = programs.get(race.id);
    const inputs = { ...race, ...(program ? { program: program.program, entries: program.entries } : {}),
      freeze: undefined, exhibition: undefined, cutoff: cutoff(program ?? race), result: undefined };
    const ex = (exhibitions.get(race.id) ?? []).map(source => {
      const candidate = { ...inputs, exhibition: source.exhibition, freeze: source.freeze };
      // The selected program cutoff also bounds the accepted exhibition.
      const features = extractB13V2Features(candidate, { preCutoffExhibitionOnly: true });
      return { candidate, features };
    }).filter(e => e.features.exhibitionSource !== null);
    const early = ex.filter(e => e.features.hasCompleteExhibition && before(e.features.exhibitionFetchedAt, inputs.cutoff))
      .sort((a, b) => Date.parse(a.features.exhibitionFetchedAt!) - Date.parse(b.features.exhibitionFetchedAt!));
    const selected = early[0];
    const revisions = [...(versions.get(race.id)?.entries() ?? [])]
      .sort(([a], [b]) => b.localeCompare(a)).map(([, result]) => result);
    const final = { ...race, result: revisions[0] };
    return {
      race: final, inputs, revisions, programPre: Boolean(program),
      pre: selected?.features ?? extractB13V2Features(inputs),
      exhibition: selected?.candidate,
      hasAnyExhibition: ex.length > 0,
      hasTimelyExhibition: ex.some(e => before(e.features.exhibitionFetchedAt, inputs.cutoff)),
      label: outcome(final),
      order: topThree(final),
    };
  });
  return { rows, duplicateRaces: merged.duplicateRaces, resultTimestampConflicts: conflictingLabels.size };
}

export type Row = ReturnType<typeof prepare>["rows"][number];

export function resultBefore(row: Row, asOf: string | null) {
  return row.revisions.find(result => before(result.evidence.fetchedAt, asOf));
}

export function exhibitionSt(row: Row) {
  if (!row.exhibition) return null;
  const raw = row.exhibition.freeze
    ? row.exhibition.freeze.entries.map(e => ({ boat: e.boat, st: e.exhibitionST }))
    : row.exhibition.exhibition!.entries;
  return BOATS.map(boat => {
    const st = raw.find(e => e.boat === boat)?.st?.trim();
    const flying = row.pre.exhibitionF[boat - 1];
    if (!st || flying === null || !/^(?:F)?(?:0?\.\d+)$/.test(st)) return null;
    return flying ? null : Number(st);
  });
}
