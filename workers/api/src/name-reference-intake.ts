import {
  canonical,
  hash,
  instant,
  isNameReference,
  jstDate,
  obj,
  requireCondition,
  rows,
  snapshotContents,
  str,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import {
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
import {
  scoreWeights,
  SCORE_VERSION,
} from "../../../packages/shared/src/scoring";
import { StagedRepository } from "./storage";
import { inputPack } from "./race-wizard";
import { validateReferenceMirror } from "./reference-report";
import {
  LEGACY_REFERENCE_PRODUCER,
  referenceProducerLabel,
} from "../../../packages/shared/src/github-bridge";
import { officialResearchUrl, sourcedCsvRun, validatePastRunSource } from "../../../packages/shared/src/race-research";
import { lookupCourseSpecs } from "../../../packages/shared/src/course-catalog";

export const normalizeName = (v: unknown) =>
  typeof v === "string" ? v.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const identityRisk =
  "名前一致のみ。同名馬・同名騎手を誤統合する可能性あり。公式個体照合未実施";
const synthetic = async (kind: string, key: unknown) =>
  `name-only:${kind}:${await hash(key)}`;
const utc = (v: unknown) => {
  requireCondition(
    typeof v === "string" &&
      /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
      Number.isFinite(Date.parse(v)),
    "時差付き日時が必要です",
  );
  return new Date(v).toISOString();
};

/** Owner CSV aggregates and aggregates of TurfLab's own stored official results
 * (scripts/core-result-stats.ts) are both accepted; only earlier days may count. */
const LOCAL_STATS_VERSIONS = new Set(["nar-csv-stats-v1", "core-results-stats-v1"]);
export function validLocalStats(value: unknown, jurisdiction: unknown, day: string): boolean {
  const stats = obj(value);
  const to = obj(obj(stats.draw ?? {}).period ?? {}).to;
  return jurisdiction === "NAR" &&
    LOCAL_STATS_VERSIONS.has(String(stats.version)) &&
    JSON.stringify(stats).length <= 30_000 &&
    (to == null || (typeof to === "string" && to < day));
}

function validateResearch(reference: Row, horses: Row[], day: string, number: number, captured: string): Row {
  const research = obj(reference.research);
  const source = new URL(str(research, "source_url"));
  const hosts = reference.jurisdiction === "JRA"
    ? ["www.jra.go.jp", "jra.go.jp", "app.jra.jp"]
    : reference.jurisdiction === "NAR" ? ["www.keiba.go.jp", "keiba.go.jp"] : [];
  requireCondition(
    source.protocol === "https:" && !source.username && !source.password &&
      !source.port && hosts.includes(source.hostname),
    "管轄に対応する公式出馬表URLが必要です",
  );
  if (reference.jurisdiction === "NAR")
    requireCondition(
      source.pathname === "/KeibaWeb/TodayRaceInfo/DebaTable" &&
        source.searchParams.get("k_raceDate")?.replaceAll("/", "-") === day &&
        source.searchParams.get("k_raceNo") === String(number) &&
        /^\d{1,2}$/.test(source.searchParams.get("k_babaCode") ?? ""),
      "出馬表URLの日付・レース番号が不一致です",
    );
  requireCondition(research.headcount === horses.length && horses.length >= 2,
    "全頭の出馬表が必要です");
  for (const horse of horses) {
    const recent = rows(horse.recent_runs);
    requireCondition(recent.length <= 5, "近走は各馬5件以内です");
    for (const run of recent) {
      requireCondition(typeof run.date_jst === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(run.date_jst) && run.date_jst < day &&
        typeof run.distance_m === "number" && run.distance_m > 0 &&
        (run.finish == null || (Number.isInteger(run.finish) && Number(run.finish) > 0)) &&
        Array.isArray(run.corners) && run.corners.length <= 4 &&
        run.corners.every((position) => Number.isInteger(position) && Number(position) > 0),
      "近走の開催日・距離・着順・通過順が不正です");
      if (run.source_url != null) validatePastRunSource(run, day, captured);
    }
  }
  if (research.history_version != null) {
    requireCondition(research.history_version === "official-history-v1" &&
      research.history_checked_at === captured, "追加調査の版または時刻が不正です");
    for (const note of [...rows(research.track_notes ?? []),
      ...horses.flatMap((h) => rows(h.jockey_notes ?? []))])
      requireCondition(officialResearchUrl(note.source_url) &&
        typeof note.note === "string" && note.note.length <= 400 &&
        note.source_checked_at === captured, "追加調査の出典または時刻が不正です");
  }
  if (research.local_stats != null)
    requireCondition(
      validLocalStats(research.local_stats, reference.jurisdiction, day),
      "ローカル集計の版・管轄・期間が不正です",
    );
  if (research.jockey_stats != null) {
    const stats = obj(research.jockey_stats);
    requireCondition(
      stats.version === "jockey-stats-v1" &&
        obj(stats.computed_for ?? {}).date === day &&
        JSON.stringify(stats).length <= 60_000 &&
        (obj(stats.period ?? {}).to == null || String(obj(stats.period).to) < day),
      "騎手統計の版・対象日・期間が不正です",
    );
  }
  for (const horse of horses)
    for (const run of rows(horse.recent_runs))
      if (run.source_url == null && run.field_sources != null)
        requireCondition(sourcedCsvRun(run, day), "CSV由来の近走の出典（ファイルハッシュ）が不正です");
  return {
    ...research,
    horses: horses.map((horse) => ({
      horse_number: horse.horse_number!,
      recent_runs: horse.recent_runs!,
      jockey_observation: horse.jockey_observation ?? null,
      ...(horse.jockey_notes ? { jockey_notes: horse.jockey_notes } : {}),
    })),
  };
}

/** Separate opt-in policy implemented by the daily Worker, never by strict Wizard.
 * Immutable source receipts also let a crash before GitHub export retry exactly.
 */
export async function importNameReference(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const mirror = validateReferenceMirror(input, now);
  const document = obj(mirror.document),
    day = str(mirror, "date_jst");
  const sourceSha = str(mirror, "sha"),
    generated = utc(document.generated_at);
  const operation = `name-reference:${await hash([input.path, sourceSha])}`;
  const prior = await repo.get("import_operations", operation);
  if (prior) {
    requireCondition(
      prior.payload_hash === (await hash(document)),
      "同SHA・異内容です",
      409,
    );
    return obj(obj(prior.expected_rows_json).receipt);
  }
  for (const saved of await repo.list("import_operations")) {
    const receipt = obj(saved.expected_rows_json ?? {}).receipt;
    if (receipt && typeof receipt === "object" && !Array.isArray(receipt))
      requireCondition(
        receipt.input_path !== input.path || receipt.source_sha === sourceSha,
        "参考JSONの同名変更を拒否します。新しい版を追加してください",
        409,
      );
  }
  const staged = new StagedRepository(repo);
  const localCli = input.repository === "local/codex";
  const producer = str(mirror, "producer");
  const aiGithub = !localCli && producer !== LEGACY_REFERENCE_PRODUCER;
  const provenance: Row = {
    identity_confidence: "name_only",
    official_identity_verified: false,
    id_origin: "synthetic_name",
    external_id: null,
    identity_risk: identityRisk,
    source_sha: sourceSha,
    source_provider: localCli ? "codex_cli" : `${producer}_github`,
    source_producer: localCli ? "codex_cli" : producer,
    source_model: typeof document.model === "string" ? document.model : null,
    source_path: input.path!,
    source_created_at: generated,
    official_source_verified: false,
    entry_status_verified: false,
    roster_complete_verified: false,
  };
  const base: Row = {
    schema_version: "0.2",
    created_at: generated,
    source: localCli
      ? "codex_cli_reference"
      : aiGithub
        ? "ai_reference"
        : "chatgpt_reference",
    source_url: localCli ? `urn:turflab:local:blob:${sourceSha}` : `https://api.github.com/repos/${str(input, "repository")}/git/blobs/${sourceSha}`,
    retrieved_at: generated,
    available_at: generated,
    valid_as_of: generated,
    is_estimated: true,
    evidence_json: provenance,
  };
  requireCondition(
    /^[\w.-]+\/[\w.-]+$/.test(str(input, "repository")),
    "データrepo名が不正です",
  );
  const content: Partial<Record<Table, Row[]>> = {};
  const remember = (table: Table, row: Row) => {
    const all = (content[table] ??= []);
    if (!all.some((x) => canonical(x) === canonical(row))) all.push(row);
  };
  async function entity(table: Table, kind: string, key: unknown, values: Row) {
    const id = await synthetic(kind, key),
      idKey = `${kind}_id`;
    const existing = await staged.get(table, id);
    const row = existing ?? { ...base, ...values, [idKey]: id };
    if (!existing) await immutablePut(staged, table, row);
    remember(table, row);
    return row;
  }
  const reports: Row[] = [],
    keys = new Set<string>();
  for (const reference of rows(document.races)) {
    const trackName = normalizeName(reference.track);
    const reportedNumber = reference.race_number ?? reference.race_no;
    const number =
      typeof reportedNumber === "string" &&
      /^(?:[1-9]|1[0-2])R?$/.test(reportedNumber)
        ? Number(reportedNumber.replace(/R$/, ""))
        : reportedNumber;
    const key = `${day}|${trackName}|${number}`;
    requireCondition(
      trackName &&
        Number.isInteger(number) &&
        Number(number) >= 1 &&
        Number(number) <= 12 &&
        normalizeName(reference.race_key_human).replace(/R$/, "") === key &&
        !keys.has(key),
      "レースキーの不一致・重複です",
    );
    keys.add(key);
    const issues = [
      identityRisk,
      "出走取消・騎手変更・全頭完全性はChatGPT参照値。公式未照合",
    ];
    const given = rows(reference.horses ?? []),
      seen = new Set<number>();
    requireCondition(given.length <= 18, "出走馬は最大18頭です");
    const resolved: Row[] = [];
    // Catalog survives missing roster metadata and missing jockeys.
    for (const h of given) {
      const horseName = normalizeName(h.horse_name),
        jockeyName = normalizeName(h.jockey);
      requireCondition(horseName, "馬名が必要です");
      const horse = await entity("horses", "horse", horseName, {
        horse_name: horseName,
        sex: null,
        birth_date: null,
        pedigree_json: null,
      });
      const jockey = jockeyName
        ? await entity("jockeys", "jockey", jockeyName, {
            jockey_name: jockeyName,
            affiliation: "unknown",
          })
        : null;
      const n = h.horse_number;
      if (
        !Number.isInteger(n) ||
        Number(n) < 1 ||
        Number(n) > 18 ||
        seen.has(Number(n)) ||
        !jockey
      ) {
        issues.push(
          `馬番${n ?? "unknown"}: 馬番重複/欠測または騎手欠測。カタログのみ保存`,
        );
        continue;
      }
      seen.add(Number(n));
      resolved.push({
        horse_id: horse.horse_id,
        jockey_id: jockey.jockey_id,
        horse_number: n!,
        draw_number: h.draw_number ?? null,
        carried_weight_kg: h.weight_kg ?? null,
        // "active" is a reference inclusion, explicitly not verified race status.
        status: ["scratched", "cancelled"].includes(String(h.status))
          ? h.status!
          : "active",
      });
    }
    let result: Row = {
      race_key_human: key,
      source_race_key_human: reference.race_key_human ?? key,
      status: "catalog_only",
      issues,
      observed_entries: given.length,
      matched_entries: resolved.length,
    };
    try {
      const start = utc(reference.scheduled_start_at_jst);
      const research = localCli && document.workflow_version === "research-v1"
        ? validateResearch(reference, given, day, Number(number), generated)
        : null;
      requireCondition(
        jstDate(start) === day && instant(generated) < instant(start),
        "発走日時/生成日時が不正です",
      );
      const raceRepo = new StagedRepository(staged);
      const track = await entity("tracks", "track", trackName, {
        name: trackName,
        jurisdiction: reference.jurisdiction ?? "unknown",
        timezone: "Asia/Tokyo",
      });
      const existingRace = (await staged.list("races")).find(
        (r) =>
          r.race_date_jst === day &&
          r.race_number === number &&
          obj(r.evidence_json ?? {}).race_key === key,
      );
      requireCondition(
        !existingRace || isNameReference(existingRace),
        "既存の厳密照合レースは変更しません",
        409,
      );
      // Also protect strict records whose legacy evidence lacks race_key.
      for (const r of await staged.list("races")) {
        if (r.race_date_jst !== day || r.race_number !== number) continue;
        const c = await staged.get("course_layouts", str(r, "course_id"));
        const t = c && (await staged.get("tracks", str(c, "track_id")));
        requireCondition(
          normalizeName(t?.name) !== trackName ||
            isNameReference(r),
          "既存の厳密照合レースと衝突しています",
          409,
        );
      }
      requireCondition(
        resolved.length > 0 &&
          resolved.length === given.length &&
          new Set(resolved.map((e) => e.horse_id)).size === resolved.length,
        "出走馬の対応が不足/重複しています。カタログのみ保存",
      );
      requireCondition(
        typeof reference.distance_m === "number" && reference.distance_m > 0,
        "距離未観測。カタログのみ保存",
      );
      const specs = lookupCourseSpecs(trackName, reference.surface ?? "ダート", reference.distance_m);
      const course = await entity("course_layouts", "course", key, {
        track_id: track.track_id,
        surface: reference.surface ?? "unknown",
        distance_m: reference.distance_m,
        direction: specs?.direction ?? "unknown",
        layout: specs?.layout ?? "unknown",
        straight_length_m: specs?.straight_length_m ?? null,
        start_to_first_turn_m: specs?.start_to_first_turn_m ?? null,
        course_width_m: specs?.course_width_m ?? null,
        revision: 1,
      });
      const raceId = await synthetic("race", key);
      const proposed: Row = {
        ...base,
        race_id: raceId,
        course_id: course.course_id,
        jurisdiction: reference.jurisdiction ?? "unknown",
        external_id: raceId,
        race_date_jst: day,
        race_number: number!,
        name: reference.race_name ?? `${trackName}${number}R`,
        scheduled_start_at: start,
        status: "scheduled",
        evidence_json: {
          ...provenance,
          race_key: key,
          external_id: null,
          id_origin: "synthetic_date_track_race",
        },
      };
      const oldRace = await staged.get("races", raceId);
      requireCondition(
        !oldRace || oldRace.scheduled_start_at === start,
        "既存レースの発走時刻変更は確認待ちです",
        409,
      );
      const race = oldRace ?? proposed;
      await immutablePut(raceRepo, "races", race);
      const fixed: Row[] = [];
      for (const e of resolved) {
        const entryId = await synthetic("entry", [key, e.horse_number]);
        const proposedEntry: Row = {
          ...base,
          ...e,
          entry_id: entryId,
          race_id: raceId,
        };
        const old = await staged.get("race_entries", entryId);
        requireCondition(
          !old ||
            [
              "horse_id",
              "jockey_id",
              "status",
              "draw_number",
              "carried_weight_kg",
            ].every(
              (k) =>
                canonical(old[k] ?? null) ===
                canonical(proposedEntry[k] ?? null),
            ),
          `馬番${e.horse_number}: 名前・騎手・出走情報が変わりました。既存を保持して確認待ち`,
          409,
        );
        const entry = old ?? proposedEntry;
        await immutablePut(raceRepo, "race_entries", entry);
        fixed.push(entry);
      }
      for (const c of raceRepo.changes.values()) {
        await staged.put(c.table, c.after);
        remember(c.table, c.after);
      }
      if (instant(start) <= instant(now)) {
        result = {
          ...result,
          race_id: raceId,
          status: "past_start",
          issues: [
            ...issues,
            "発走後：カタログ/参考履歴のみ。snapshot・pack・Morningは生成しません",
          ],
        };
      } else {
        const model = await entity(
          "model_versions",
          "model_version",
          research
            ? ["codex-research-v1", document.model]
            : aiGithub
              ? ["ai-name-v1", producer]
              : "chatgpt-name-v1",
          {
            provider: research
              ? "Codex CLI"
              : referenceProducerLabel(producer),
            model_identifier: research
              ? str(document, "model")
              : aiGithub
                ? `${producer}_reference`
                : "chatgpt_reference",
            prompt_version: research ? "research-v1" : "name-only-v1",
            feature_version: SCORE_VERSION,
            weights_json: scoreWeights,
            parameters_json: {
              mode: "narrative",
              identity_confidence: "name_only",
            },
            status: "candidate",
          },
        );
        const snapshot: Row = {
          ...base,
          snapshot_id: await synthetic("snapshot", [key, sourceSha]),
          race_id: raceId,
          captured_at: generated,
          weather: research?.weather ?? null,
          going: research?.going ?? null,
          entries_state_json: fixed,
          scratch_status_json: fixed
            .filter((e) => e.status !== "active")
            .map((e) => e.entry_id),
          odds_snapshot_ids_json: [],
          input_hash: "pending",
          evidence_json: {
            ...provenance,
            ...(research ? { research } : {}),
            model_version_id: model.model_version_id,
            race_key: key,
            unknowns: [
              identityRisk,
              "公式出典・取消・全頭完全性未照合",
              "枠/天候/馬場/過去走は未観測ならunknown",
            ],
          },
        };
        snapshot.input_hash = await hash(snapshotContents(snapshot));
        await immutablePut(staged, "race_snapshots", snapshot);
        remember("race_snapshots", snapshot);
        const pack = await inputPack(staged, str(snapshot, "snapshot_id"), now);
        result = {
          ...result,
          status: "pack_ready",
          race_id: raceId,
          snapshot_id: snapshot.snapshot_id,
          pack_hash: pack.pack_hash,
        };
      }
    } catch (e) {
      issues.push(
        e instanceof Error ? e.message : "カタログ保存後のpack準備失敗",
      );
    }
    reports.push(result);
  }
  const receipt: Row = {
    report_date_jst: day,
    input_path: input.path!,
    source_sha: sourceSha,
    checked_at: now,
    races: reports,
    provenance,
    catalog: content as Row,
    reference_document: document,
    core_mutated: staged.changes.size > 0,
  };
  await immutablePut(staged, "import_operations", {
    schema_version: "0.2",
    created_at: now,
    import_id: operation,
    idempotency_key: operation,
    payload_hash: await hash(document),
    expected_rows_json: { receipt },
    stage_checkpoint_json: { catalog: "complete" },
    status: "complete",
    completed_at: now,
  });
  for (const c of staged.changes.values()) await repo.put(c.table, c.after);
  return receipt;
}

/** First complete prediction wins: once a race has an adopted prediction (from
 * any AI), later references stay catalog/reference history only. Computed per
 * call, never stored, so a replayed receipt still reflects the current Core. */
export async function withFormalStatus(
  repo: Repository,
  receipt: Row,
): Promise<Row> {
  const adoptions = await repo.list("reference_adoptions");
  return {
    ...receipt,
    races: rows(receipt.races).map((race) => {
      const adopted = race.race_id
        ? adoptions.find((a) => a.race_id === race.race_id)
        : undefined;
      return adopted
        ? { ...race, formal_prediction_id: adopted.prediction_id }
        : race;
    }),
  };
}
