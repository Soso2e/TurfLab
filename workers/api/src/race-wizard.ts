import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  asOf,
  canonical,
  hash,
  idOf,
  instant,
  jstDate,
  num,
  obj,
  requireCondition,
  rows,
  snapshotContents,
  str,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import { get, type Repository } from "../../../packages/shared/src/repository";
import { aiAnswerSchema } from "../../../packages/shared/src/race-wizard";
import {
  scoreWeights,
  SCORE_VERSION,
} from "../../../packages/shared/src/scoring";
import { ingestMaster, refreshEntries } from "./workflow";
import { StagedRepository } from "./storage";
import { prepareRace } from "./race-pipeline";
import { validatePrediction } from "./imports";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateAnswer = ajv.compile(aiAnswerSchema);
const stableId = async (kind: string, value: unknown) =>
  `${kind}:${await hash(value)}`;
const normalized = (s: unknown) => String(s).normalize("NFKC").trim();
const prestart = (race: Row, now: string) =>
  requireCondition(
    race.status === "scheduled" &&
      instant(now) < instant(race.scheduled_start_at),
    "発走後・取消のMorning新規確定は禁止です。過去データはBacktest専用です",
  );

async function buildMaster(repo: Repository, draft: Row, now: string) {
  draft = structuredClone(draft);
  const required: [Row, string[], string][] = [
    [
      draft,
      [
        "source",
        "source_url",
        "permission",
        "information_cutoff_at",
        "retrieved_at",
        "available_at",
        "valid_as_of",
      ],
      "出典",
    ],
    [obj(draft.track), ["external_id", "name", "jurisdiction"], "競馬場"],
    [
      obj(draft.course),
      ["external_id", "surface", "direction", "layout"],
      "コース",
    ],
    [
      obj(draft.race),
      ["external_id", "race_date_jst", "name", "scheduled_start_at"],
      "レース",
    ],
    [obj(draft.model), ["model_identifier", "prompt_version"], "モデル"],
    ...rows(draft.entries).map((e, i): [Row, string[], string] => [
      e,
      [
        "horse_external_id",
        "horse_name",
        "jockey_external_id",
        "jockey_name",
        "status",
      ],
      `出走馬${i + 1}`,
    ]),
  ];
  const missing = required.flatMap(([row, keys, label]) =>
    keys
      .filter((k) => typeof row[k] !== "string" || !String(row[k]).trim())
      .map((k) => `${label}.${k}`),
  );
  requireCondition(
    !missing.length,
    `必須項目が不足しています: ${missing.join(" / ")}`,
  );
  const toUTC = (row: Row, key: string) => {
    requireCondition(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
        str(row, key),
      ) && Number.isFinite(Date.parse(str(row, key))),
      `${key}: タイムゾーン付きISO日時が必要です`,
    );
    row[key] = new Date(str(row, key)).toISOString();
  };
  for (const key of [
    "information_cutoff_at",
    "retrieved_at",
    "available_at",
    "valid_as_of",
  ])
    toUTC(draft, key);
  toUTC(obj(draft.race), "scheduled_start_at");
  const source = str(draft, "source").trim();
  const url = new URL(str(draft, "source_url"));
  requireCondition(
    url.protocol === "https:" &&
      !url.hostname.endsWith(".invalid") &&
      !url.username &&
      !url.password,
    "実在する公式・利用許諾済みのHTTPS出典URLを入力してください",
  );
  requireCondition(
    ["official", "licensed"].includes(str(draft, "permission")),
    "公式または利用許諾済みの手動入力だけを使用できます",
  );
  if (draft.permission === "licensed") str(draft, "permission_note");
  const cutoff = str(draft, "information_cutoff_at");
  requireCondition(instant(cutoff) <= instant(now), "情報締切が未来です");
  for (const k of ["valid_as_of", "available_at", "retrieved_at"]) {
    requireCondition(
      instant(draft[k]) <= instant(cutoff),
      `${k}: 情報締切以前の時刻が必要です`,
    );
  }
  requireCondition(
    instant(draft.available_at) <= instant(draft.retrieved_at),
    "公表時刻が取得時刻より後です",
  );
  const base: Row = {
    schema_version: "0.2",
    created_at: draft.retrieved_at,
    source,
    source_url: url.href,
    retrieved_at: draft.retrieved_at,
    available_at: draft.available_at,
    valid_as_of: draft.valid_as_of,
    is_estimated: false,
  };
  const content: Partial<Record<Table, Row[]>> = {};
  // External identity is scoped by source. A name alone is never a match.
  async function entity(
    table: Table,
    kind: string,
    external: string,
    values: Row,
  ) {
    requireCondition(
      external.trim().length > 0,
      `${kind}: 公式の外部IDが必要です。同名だけでは照合しません`,
    );
    const evidence: Row = {
      external_id: external,
      source,
      permission: draft.permission,
      permission_note: draft.permission_note ?? null,
    };
    const candidates = [...(await repo.list(table)), ...(content[table] ?? [])]
      .filter(
        (r, i, all) =>
          all.findIndex((x) => idOf(table, x) === idOf(table, r)) === i,
      )
      .filter(
        (r) =>
          r.source === source &&
          r.evidence_json &&
          obj(r.evidence_json).external_id === external,
      );
    requireCondition(candidates.length <= 1, `${kind}: 外部IDが曖昧です`, 409);
    const id = candidates[0]
      ? idOf(table, candidates[0])
      : await stableId(kind, [source, external]);
    const proposed: Row = {
      ...base,
      ...values,
      [idOfKey(table)]: id,
      evidence_json: evidence,
    };
    const before = candidates[0] ?? (await repo.get(table, id));
    if (before)
      for (const [k, v] of Object.entries(values))
        requireCondition(
          canonical(before[k]) === canonical(v),
          `${kind}.${k}: 同一外部IDの内容が不一致です。元データを確認してください`,
          409,
        );
    const row = before ?? proposed;
    content[table] = [
      ...(content[table] ?? []).filter((r) => idOf(table, r) !== id),
      row,
    ];
    return row;
  }
  const t = obj(draft.track),
    c = obj(draft.course),
    r = obj(draft.race),
    m = obj(draft.model);
  const track = await entity("tracks", "track", str(t, "external_id"), {
    name: str(t, "name"),
    jurisdiction: str(t, "jurisdiction"),
    timezone: "Asia/Tokyo",
  });
  requireCondition(
    ["JRA", "NAR"].includes(str(t, "jurisdiction")),
    "管轄はJRA/NARです",
  );
  requireCondition(
    Number.isInteger(c.distance_m) && num(c, "distance_m") > 0,
    "距離は正の整数です",
  );
  const course = await entity(
    "course_layouts",
    "course",
    str(c, "external_id"),
    {
      track_id: track.track_id,
      surface: str(c, "surface"),
      distance_m: c.distance_m,
      direction: str(c, "direction"),
      layout: str(c, "layout"),
      revision: 1,
    },
  );
  requireCondition(
    Number.isInteger(r.race_number) &&
      num(r, "race_number") >= 1 &&
      num(r, "race_number") <= 12,
    "Rは1〜12です",
  );
  requireCondition(
    str(r, "race_date_jst") === jstDate(str(r, "scheduled_start_at")),
    "開催日と発走時刻のJST日付が一致しません",
  );
  const raceKey = `${str(r, "race_date_jst")}|${normalized(track.name)}|${r.race_number}`;
  const raceId = await stableId("race", [source, str(r, "external_id")]);
  for (const before of await repo.list("races")) {
    const beforeCourse = await get(
      repo,
      "course_layouts",
      str(before, "course_id"),
    );
    const beforeTrack = await get(
      repo,
      "tracks",
      str(beforeCourse, "track_id"),
    );
    if (
      before.race_date_jst === r.race_date_jst &&
      before.race_number === r.race_number &&
      normalized(beforeTrack.name) === normalized(track.name)
    )
      requireCondition(
        before.race_id === raceId,
        "同日・競馬場・Rのレースが既にあります。既存race_idと外部IDを確認してください",
        409,
      );
    if (before.source === source && before.external_id === r.external_id)
      requireCondition(
        before.race_id === raceId,
        "既存の外部レースIDがあります。既存レースを使用してください",
        409,
      );
  }
  const race: Row = {
    ...base,
    ...r,
    race_id: raceId,
    course_id: course.course_id,
    jurisdiction: t.jurisdiction,
    status: "scheduled",
    evidence_json: {
      race_key: raceKey,
      external_id: r.external_id,
      permission: draft.permission,
    },
  };
  for (const key of Object.keys(r))
    requireCondition(
      [
        "external_id",
        "race_date_jst",
        "race_number",
        "name",
        "scheduled_start_at",
      ].includes(key),
      `race.${key}: 未知の項目です`,
    );
  const oldRace = await repo.get("races", raceId);
  if (oldRace)
    for (const key of [
      "course_id",
      "external_id",
      "race_date_jst",
      "race_number",
      "name",
      "scheduled_start_at",
      "status",
    ])
      requireCondition(
        canonical(oldRace[key]) === canonical(race[key]),
        `レースの${key}が既存登録と不一致です`,
        409,
      );
  content.races = [oldRace ?? race];
  prestart(content.races[0], now);
  const inputEntries = rows(draft.entries);
  requireCondition(
    Number.isInteger(draft.declared_entry_count) &&
      draft.declared_entry_count === inputEntries.length,
    "declared_entry_count: 公式出馬表の取消を含む登録頭数と入力行数を一致させてください",
  );
  requireCondition(
    inputEntries.length >= 1 && inputEntries.length <= 18,
    "取消を含む全出走馬（1〜18頭）が必要です",
  );
  const seen = new Set<number>(),
    horses = new Set<string>();
  const entries: Row[] = [];
  for (const e of inputEntries) {
    const no = num(e, "horse_number");
    requireCondition(
      Number.isInteger(no) && no >= 1 && no <= 18 && !seen.has(no),
      "馬番が不正または重複しています",
    );
    seen.add(no);
    requireCondition(
      Number.isInteger(e.draw_number) &&
        num(e, "draw_number") >= 1 &&
        num(e, "draw_number") <= 8,
      `馬番${no}: 枠は1〜8です`,
    );
    requireCondition(
      num(e, "carried_weight_kg") > 0 && num(e, "carried_weight_kg") <= 100,
      `馬番${no}: 斤量が不正です`,
    );
    requireCondition(
      ["active", "scratched", "cancelled"].includes(str(e, "status")),
      `馬番${no}: 出走/取消状態が不正です`,
    );
    const horse = await entity("horses", "horse", str(e, "horse_external_id"), {
      horse_name: str(e, "horse_name"),
    });
    const jockey = await entity(
      "jockeys",
      "jockey",
      str(e, "jockey_external_id"),
      { jockey_name: str(e, "jockey_name") },
    );
    requireCondition(
      !horses.has(str(horse, "horse_id")),
      "同一馬が複数の馬番に登録されています",
    );
    horses.add(str(horse, "horse_id"));
    entries.push({
      ...base,
      entry_id: await stableId("entry", [raceId, no]),
      race_id: raceId,
      horse_id: horse.horse_id,
      jockey_id: jockey.jockey_id,
      horse_number: no,
      draw_number: e.draw_number,
      carried_weight_kg: e.carried_weight_kg,
      status: e.status,
    });
  }
  entries.sort((a, b) => num(a, "horse_number") - num(b, "horse_number"));
  requireCondition(
    entries.some((e) => e.status === "active"),
    "有効な出走馬がありません",
  );
  const priorEntries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === raceId,
  );
  let refresh: Row | null = null;
  if (priorEntries.length) {
    requireCondition(
      canonical(priorEntries.map((e) => e.entry_id).sort()) ===
        canonical(entries.map((e) => e.entry_id).sort()),
      "全出走馬の馬番が既存登録と不一致です。欠落・追加を確認してください",
      409,
    );
    for (const e of entries) {
      const before = priorEntries.find((x) => x.entry_id === e.entry_id)!;
      requireCondition(
        before.horse_id === e.horse_id,
        "馬番と馬の外部IDが既存登録と不一致です",
        409,
      );
    }
    const changed =
      canonical(
        priorEntries
          .slice()
          .sort((a, b) => num(a, "horse_number") - num(b, "horse_number")),
      ) !== canonical(entries);
    if (changed)
      refresh = {
        operation_id: await stableId("wizard-refresh", entries),
        entries,
      };
    else content.race_entries = priorEntries;
  } else content.race_entries = entries;
  const prompt = {
    version: str(m, "prompt_version"),
    scoring: SCORE_VERSION,
    weights: scoreWeights,
    answer_schema: aiAnswerSchema,
  };
  const modelId = await stableId("model", [str(m, "model_identifier"), prompt]);
  const oldModel = await repo.get("model_versions", modelId);
  content.model_versions = [
    oldModel ?? {
      ...base,
      model_version_id: modelId,
      provider: "ChatGPT manual",
      model_identifier: m.model_identifier,
      prompt_version: m.prompt_version,
      prompt_hash: await hash(prompt),
      feature_version: SCORE_VERSION,
      weights_json: scoreWeights,
      engine_version: null,
      status: "candidate",
      parameters_json: { mode: "narrative" },
    },
  ];
  const snapshot: Row = {
    ...base,
    snapshot_id: "pending",
    race_id: raceId,
    captured_at: cutoff,
    weather: draft.weather ?? null,
    going: draft.going ?? null,
    entries_state_json: entries,
    scratch_status_json: entries
      .filter((e) => e.status !== "active")
      .map((e) => e.entry_id),
    odds_snapshot_ids_json: [],
    input_hash: "pending",
    evidence_json: {
      model_version_id: modelId,
      race_key: raceKey,
      unknowns: [
        "過去走は未登録",
        ...(draft.going == null ? ["馬場未確認"] : []),
        ...(draft.weather == null ? ["天候未確認"] : []),
      ],
    },
  };
  snapshot.input_hash = await hash(snapshotContents(snapshot));
  snapshot.snapshot_id = await stableId("snapshot", [
    snapshot.input_hash,
    modelId,
    base,
  ]);
  content.race_snapshots = [snapshot];
  return { content, refresh, race, snapshot, modelId, raceKey };
}
function idOfKey(table: Table) {
  const keys: Partial<Record<Table, string>> = {
    tracks: "track_id",
    course_layouts: "course_id",
    horses: "horse_id",
    jockeys: "jockey_id",
  };
  return keys[table]!;
}

async function preflight(repo: Repository, input: Row, now: string) {
  const draft = obj(input.draft);
  const built = await buildMaster(repo, draft, now);
  const master: Row = {
    operation_id: `wizard:${str(input, "operation_id")}`,
    tables: built.content as Row,
  };
  const staged = new StagedRepository(repo);
  // References are checked by the existing master importer, without writes.
  if (built.refresh) {
    const prerequisites = { ...built.content };
    delete prerequisites.race_snapshots;
    await ingestMaster(
      staged,
      {
        operation_id: `${master.operation_id}:entities`,
        tables: prerequisites as Row,
      },
      now,
    );
    await refreshEntries(
      staged,
      str(built.race, "race_id"),
      built.refresh,
      now,
    );
  }
  await ingestMaster(staged, master, now);
  return { ...built, master, changes: staged.changes };
}

export async function previewMaster(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  try {
    const b = await preflight(repo, input, now);
    return {
      status: "ready",
      preview_hash: await hash(input),
      race_key: b.raceKey,
      race: b.race,
      entries: b.snapshot.entries_state_json,
      snapshot: b.snapshot,
      model_version_id: b.modelId,
      warnings: [
        "出典の実在・利用条件・全頭/取消・公表/取得時刻を本人が照合してください",
        ...(b.refresh
          ? [
              "既存出走情報をrefreshEntriesで更新します。既存の確定予想は書き換えません",
            ]
          : []),
      ],
    };
  } catch (error) {
    return {
      status: "draft",
      errors: [error instanceof Error ? error.message : "入力不足です"],
      repair:
        "出馬表JSONの該当項目を公式出馬表と照合して修正し、再プレビューしてください。内部ID・確率・過去走を補完しないでください。",
    };
  }
}

export async function confirmMaster(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  requireCondition(
    input.confirmed === true,
    "全頭・取消・出典の本人確認が必要です",
  );
  const request = { operation_id: input.operation_id, draft: input.draft };
  requireCondition(
    input.preview_hash === (await hash(request)),
    "プレビュー後に入力が変わりました。再検証してください",
    409,
  );
  const operationId = `master:wizard:${str(input, "operation_id")}`;
  const prior = await repo.get("import_operations", operationId);
  const requestHash = await hash(request);
  if (prior) {
    requireCondition(
      obj(prior.expected_rows_json).request_hash === requestHash,
      "同操作ID・異内容です",
      409,
    );
    if (prior.status === "complete")
      return {
        status: "complete",
        snapshot_id: obj(prior.expected_rows_json).snapshot_id,
        race_id: obj(prior.expected_rows_json).race_id,
      };
  }
  const b = await preflight(repo, request, now);
  for (const change of b.changes.values())
    await repo.put(change.table, change.after);
  const saved = await get(repo, "import_operations", operationId);
  await repo.put("import_operations", {
    ...saved,
    expected_rows_json: {
      ...obj(saved.expected_rows_json),
      request_hash: requestHash,
      snapshot_id: b.snapshot.snapshot_id,
      race_id: b.race.race_id,
    },
  });
  return {
    status: "complete",
    race_id: b.race.race_id,
    snapshot_id: b.snapshot.snapshot_id,
  };
}

export async function inputPack(
  repo: Repository,
  snapshotId: string,
  now: string,
): Promise<Row> {
  const snapshot = await get(repo, "race_snapshots", snapshotId);
  const race = await get(repo, "races", str(snapshot, "race_id"));
  prestart(race, now);
  requireCondition(
    snapshot.input_hash === (await hash(snapshotContents(snapshot))),
    "snapshotハッシュ不一致",
  );
  const model = await get(
    repo,
    "model_versions",
    str(obj(snapshot.evidence_json), "model_version_id"),
  );
  const course = await get(repo, "course_layouts", str(race, "course_id"));
  const track = await get(repo, "tracks", str(course, "track_id"));
  const cutoff = str(snapshot, "captured_at");
  for (const row of [snapshot, race, course, track, model]) asOf(row, cutoff);
  const entries: Row[] = [];
  const current = (await repo.list("race_entries")).filter(
    (e) => e.race_id === race.race_id,
  );
  requireCondition(
    canonical(current.map((e) => e.entry_id).sort()) ===
      canonical(
        rows(snapshot.entries_state_json)
          .map((e) => e.entry_id)
          .sort(),
      ),
    "snapshotの全出走馬と現行登録が不一致です",
  );
  for (const e of rows(snapshot.entries_state_json)) {
    const saved = current.find((x) => x.entry_id === e.entry_id)!;
    for (const key of [
      "horse_id",
      "jockey_id",
      "horse_number",
      "draw_number",
      "carried_weight_kg",
      "status",
    ])
      requireCondition(
        e[key] === saved[key],
        `出走情報の${key}が変わりました。最新snapshotを作成してください`,
      );
    const horse = await get(repo, "horses", str(e, "horse_id")),
      jockey = await get(repo, "jockeys", str(e, "jockey_id"));
    for (const row of [e, horse, jockey]) asOf(row, cutoff);
    entries.push({
      ...e,
      horse_name: horse.horse_name,
      jockey_name: jockey.jockey_name,
    });
  }
  const body: Row = {
    pack_version: "1",
    race,
    track,
    course,
    entries,
    snapshot_id: snapshotId,
    input_hash: snapshot.input_hash,
    model_version_id: model.model_version_id,
    model,
    information_cutoff_at: cutoff,
    evidence: [
      {
        evidence_id: await stableId("evidence", [
          snapshotId,
          snapshot.source_url,
        ]),
        source: snapshot.source!,
        source_url: snapshot.source_url!,
        valid_as_of: snapshot.valid_as_of!,
        available_at: snapshot.available_at!,
        retrieved_at: snapshot.retrieved_at!,
        classification: "fact",
        confirmed: true,
        note: "本人が公式・利用許諾済み出馬表と照合。過去走の根拠ではありません",
      },
    ],
    unknowns: obj(snapshot.evidence_json).unknowns!,
    score_weights: scoreWeights,
    answer_schema: aiAnswerSchema as unknown as Row,
    instruction:
      "このpack_hashをそのまま返す。全有効馬の6採点、3展開の全馬隊列と有利不利、主想定と根拠、参考Bet（100円単位・1R1000円以内）をanswer_schemaどおりJSONで返す。オッズを採点に入れない。内部ID・総合点・確率・MC実行・出典・過去走を推測で作らない。資料不足なら回答を確定せず追加根拠を依頼する。",
  };
  return { ...body, pack_hash: await hash(body) };
}

export async function convertAnswer(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  const answer = obj(input.answer);
  if (!validateAnswer(answer)) {
    const labels: Record<string, string> = {
      main_pace_reason: "主想定の根拠",
      main_pace: "主想定",
      horse_evaluations: "全馬採点",
      components: "6採点",
      scenarios: "3展開",
      recommendations: "参考Bet",
      rationale: "根拠",
      limitations: "未確認・制限",
      horse_name: "馬名",
      horse_number: "馬番",
      ability: "能力",
      course: "コース",
      pace: "展開",
      going: "馬場",
      draw_weight: "枠斤量",
      horse_jockey_course: "馬×騎手×コース",
      pack_hash: "入力パックのハッシュ",
      generated_at: "回答生成時刻",
      lineup: "全馬の隊列",
      position: "位置取り",
      advantage: "有利不利",
    };
    const errors = (validateAnswer.errors ?? []).map((e) => {
      const field = String(
        e.params.missingProperty ?? e.params.additionalProperty ?? "",
      );
      return `${e.instancePath || "回答"}: ${labels[field] ?? field} ${e.keyword === "required" ? "が不足しています" : e.keyword === "additionalProperties" ? "は許可されていない項目です" : "の型・値・範囲が不正です"}`;
    });
    requireCondition(
      false,
      `ChatGPT回答の不足・不正: ${errors.join(" / ")}。入力パックのanswer_schemaで修正してください`,
    );
  }
  requireCondition(
    answer.pack_hash === pack.pack_hash,
    "入力パックが不一致です。最新パックをChatGPTへ渡して再回答してください",
    409,
  );
  const entries = rows(pack.entries).filter((e) => e.status === "active");
  const match = (e: Row) => {
    const fixed = entries.find((x) => x.horse_number === e.horse_number);
    requireCondition(
      fixed && fixed.horse_name === e.horse_name,
      `馬番${e.horse_number}: 馬名・取消・未知の馬番が不一致です`,
    );
    return str(fixed, "entry_id");
  };
  const operationId = str(input, "operation_id");
  const predictionId = await stableId("prediction", [
    pack.pack_hash,
    operationId,
  ]);
  const evidence = rows(pack.evidence),
    evidenceIds = evidence.map((e) => e.evidence_id);
  const prediction: Row = {
    prediction_id: predictionId,
    race_id: obj(pack.race).race_id,
    model_version_id: pack.model_version_id,
    snapshot_id: pack.snapshot_id,
    kind: "morning",
    information_cutoff_at: pack.information_cutoff_at,
    evidence,
    rationale: `${answer.rationale}\n主想定: ${answer.main_pace} / ${answer.main_pace_reason}`,
    horse_evaluations: rows(answer.horse_evaluations).map((e) => ({
      entry_id: match(e),
      rank: 1,
      components: e.components,
      win_probability: null,
      top3_probability: null,
      course_fit: e.course_fit,
      jockey_fit: e.jockey_fit,
      expected_position: e.expected_position,
      classification: "estimate",
      evidence_ids: evidenceIds,
      rationale: e.rationale,
    })),
    simulation: {
      simulation_id: `simulation:${predictionId}`,
      mode: "narrative",
      engine_version: null,
      seed: null,
      trial_count: null,
      input_hash: null,
      scenarios: rows(answer.scenarios).map((s) => ({
        pace: s.pace,
        weight: null,
        analysis: s.analysis,
        lineup: rows(s.lineup).map((e) => ({
          entry_id: match(e),
          position: e.position,
          advantage: e.advantage,
        })),
      })),
      evidence_ids: evidenceIds,
      limitations: answer.limitations,
    },
    recommendations: rows(answer.recommendations).map((r, i) => ({
      ...r,
      recommendation_id: `recommendation:${predictionId}:${i}`,
      estimated_probability: null,
      estimated_ev: null,
      odds_snapshot_id: null,
    })),
    skip_reason: answer.skip_reason ?? "",
  };
  const pipeline: Row = {
    pipeline_id: `wizard-core:${operationId}`,
    generated_at: answer.generated_at,
    prediction,
  };
  const core = await prepareRace(repo, pipeline, now);
  const warnings = await validatePrediction(
    repo,
    rows(core.predictions)[0],
    now,
  );
  requireCondition(!warnings.length, warnings.join(" / "));
  return {
    status: "ready",
    pipeline,
    core,
    pack_hash: pack.pack_hash,
    warnings: [
      "参考Betだけを確定します。本人の仮想Betはレース画面で別途登録してください",
      "文章分析の確率・展開重み・MC実行は未算出です。確率集計の対象外です",
    ],
  };
}
