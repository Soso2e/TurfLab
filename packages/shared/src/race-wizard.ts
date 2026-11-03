// Only user supplied facts belong in this form. Empty fields remain draft.
export const raceDraftTemplate = {
  declared_entry_count: 0,
  source: "",
  source_url: "",
  permission: "official",
  retrieved_at: "",
  available_at: "",
  valid_as_of: "",
  information_cutoff_at: "",
  track: { external_id: "", name: "", jurisdiction: "" },
  course: {
    external_id: "",
    surface: "",
    distance_m: 0,
    direction: "",
    layout: "",
  },
  race: {
    external_id: "",
    race_date_jst: "",
    race_number: 0,
    name: "",
    scheduled_start_at: "",
  },
  model: { model_identifier: "", prompt_version: "" },
  weather: null,
  going: null,
  entries: [
    {
      horse_external_id: "",
      horse_name: "",
      jockey_external_id: "",
      jockey_name: "",
      horse_number: 0,
      draw_number: 0,
      carried_weight_kg: 0,
      status: "active",
    },
  ],
};

// RFC4180 quoting, CRLF and BOM; metadata stays in the separate JSON form.
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? "\n";
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === "," || ch === "\n" || ch === "\r") {
      record.push(cell);
      cell = "";
      closed = false;
      if (ch !== ",") {
        if (record.some((x) => x.length)) records.push(record);
        record = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed || ch === '"') throw new Error("CSVの引用符が不正です");
      cell += ch;
    }
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません");
  return records;
}

export function parseEntriesCSV(
  text: string,
): Record<string, string | number>[] {
  const records = csvRecords(text);
  const headers = records.shift();
  const expected = Object.keys(raceDraftTemplate.entries[0]);
  if (
    !headers ||
    headers.length !== expected.length ||
    new Set(headers).size !== headers.length ||
    !expected.every((k) => headers.includes(k))
  )
    throw new Error(`CSV列は ${expected.join(",")} です`);
  return records.map((r) => {
    if (r.length !== headers.length) throw new Error("CSVの列数が一致しません");
    return Object.fromEntries(
      headers.map((k, i) => [
        k,
        ["horse_number", "draw_number", "carried_weight_kg"].includes(k)
          ? r[i].trim()
            ? Number(r[i])
            : NaN
          : r[i],
      ]),
    );
  });
}

// NAR horselist files contain multiple races and no stable horse/jockey IDs.
// This is a draft only: the operator must independently verify identities and status.
export function parseNarEntriesCSV(
  text: string,
  race: { date: string; track: string; number: number },
): Record<string, string | number>[] {
  const records = csvRecords(text);
  const headers = records.shift();
  const required = [
    "競馬場",
    "競走年月日",
    "レース番号",
    "枠番",
    "馬番",
    "馬名",
    "騎手名",
    "負担重量",
  ];
  if (
    !headers ||
    new Set(headers).size !== headers.length ||
    !required.every((key) => headers.includes(key))
  )
    throw new Error("NAR出馬表CSVの必要な列がありません");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(race.date) ||
    !race.track.trim() ||
    !Number.isInteger(race.number) ||
    race.number < 1
  )
    throw new Error("draftの開催日・競馬場・レース番号を先に入力してください");
  const get = (row: string[], key: string) => row[headers.indexOf(key)].trim();
  const selected = records.filter((row) => {
    if (row.length !== headers.length)
      throw new Error("CSVの列数が一致しません");
    return (
      get(row, "競走年月日") === race.date.replaceAll("-", "") &&
      get(row, "競馬場").normalize("NFKC") ===
        race.track.trim().normalize("NFKC") &&
      get(row, "レース番号") === String(race.number)
    );
  });
  if (!selected.length) throw new Error("指定レースの出馬表がありません");
  return selected.map((row) => ({
    horse_external_id: "",
    horse_name: get(row, "馬名"),
    jockey_external_id: "",
    jockey_name: get(row, "騎手名"),
    horse_number: Number(get(row, "馬番")),
    draw_number: Number(get(row, "枠番")),
    carried_weight_kg: Number(get(row, "負担重量")),
    status: "",
  }));
}

export const aiAnswerSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "pack_hash",
    "generated_at",
    "rationale",
    "main_pace",
    "main_pace_reason",
    "horse_evaluations",
    "scenarios",
    "recommendations",
    "limitations",
  ],
  properties: {
    pack_hash: { type: "string" },
    generated_at: { type: "string", format: "date-time" },
    rationale: { type: "string", minLength: 1 },
    main_pace: { enum: ["slow", "middle", "high"] },
    main_pace_reason: { type: "string", minLength: 1 },
    limitations: { type: "string", minLength: 1 },
    skip_reason: { type: "string" },
    horse_evaluations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "horse_number",
          "horse_name",
          "components",
          "course_fit",
          "jockey_fit",
          "expected_position",
          "rationale",
        ],
        properties: {
          horse_number: { type: "integer", minimum: 1 },
          horse_name: { type: "string", minLength: 1 },
          components: {
            type: "object",
            additionalProperties: false,
            required: [
              "ability",
              "course",
              "pace",
              "going",
              "draw_weight",
              "horse_jockey_course",
            ],
            properties: Object.fromEntries(
              [
                "ability",
                "course",
                "pace",
                "going",
                "draw_weight",
                "horse_jockey_course",
              ].map((k) => [k, { type: "number", minimum: 0, maximum: 100 }]),
            ),
          },
          course_fit: { type: "string", minLength: 1 },
          jockey_fit: { type: "string", minLength: 1 },
          expected_position: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    scenarios: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pace", "analysis", "lineup"],
        properties: {
          pace: { enum: ["slow", "middle", "high"] },
          analysis: { type: "string", minLength: 1 },
          lineup: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["horse_number", "horse_name", "position", "advantage"],
              properties: {
                horse_number: { type: "integer", minimum: 1 },
                horse_name: { type: "string", minLength: 1 },
                position: { type: "string", minLength: 1 },
                advantage: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ticket_type",
          "selections",
          "suggested_amount_yen",
          "reason",
        ],
        properties: {
          ticket_type: {
            enum: [
              "win",
              "place",
              "quinella",
              "wide",
              "exacta",
              "trio",
              "trifecta",
            ],
          },
          selections: { type: "array", items: { type: "integer", minimum: 1 } },
          suggested_amount_yen: {
            type: "integer",
            minimum: 0,
            maximum: 1000,
            multipleOf: 100,
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
};
