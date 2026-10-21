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
export function parseEntriesCSV(
  text: string,
): Record<string, string | number>[] {
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
