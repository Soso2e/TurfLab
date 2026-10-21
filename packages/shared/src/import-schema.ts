const text = { type: "string", minLength: 1 };
const optionalProbability = {
  type: ["number", "null"],
  minimum: 0,
  maximum: 1,
};
const nullableText = { type: ["string", "null"] };
const time = { type: "string", format: "date-time" };
const strings = { type: "array", items: text };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
export const importSchema = object(
  {
    schema_version: { const: "0.2" },
    example_only: { type: "boolean" },
    import_id: text,
    generated_at: time,
    predictions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: object(
        {
          prediction_id: text,
          race_id: text,
          model_version_id: text,
          snapshot_id: text,
          kind: { enum: ["morning", "final", "reanalysis", "backtest"] },
          information_cutoff_at: time,
          supersedes_prediction_id: nullableText,
          feature_ids: strings,
          rationale: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            items: object(
              {
                evidence_id: text,
                source: text,
                source_url: { type: "string", format: "uri" },
                valid_as_of: time,
                available_at: { type: ["string", "null"], format: "date-time" },
                retrieved_at: time,
                classification: { enum: ["fact", "estimate"] },
                note: { type: "string" },
                confirmed: { type: "boolean" },
              },
              [
                "evidence_id",
                "source",
                "source_url",
                "valid_as_of",
                "retrieved_at",
                "classification",
              ],
            ),
          },
          horse_evaluations: {
            type: "array",
            minItems: 1,
            items: object(
              {
                entry_id: text,
                rank: { type: "integer", minimum: 1 },
                score: { type: ["number", "null"] },
                win_probability: optionalProbability,
                top3_probability: optionalProbability,
                abilities: {
                  type: "object",
                  additionalProperties: { type: ["number", "null"] },
                },
                course_fit: text,
                jockey_fit: text,
                expected_position: text,
                classification: { enum: ["fact", "estimate"] },
                confidence: {
                  type: ["number", "null"],
                  minimum: 0,
                  maximum: 1,
                },
                evidence_ids: strings,
                rationale: text,
              },
              [
                "entry_id",
                "rank",
                "win_probability",
                "top3_probability",
                "abilities",
                "course_fit",
                "jockey_fit",
                "expected_position",
                "classification",
                "evidence_ids",
                "rationale",
              ],
            ),
          },
          simulation: object(
            {
              simulation_id: text,
              mode: { enum: ["narrative", "numeric"] },
              engine_version: nullableText,
              seed: { type: ["integer", "null"] },
              trial_count: { type: ["integer", "null"] },
              input_hash: nullableText,
              scenarios: {
                type: "array",
                minItems: 1,
                items: object(
                  {
                    pace: { enum: ["slow", "middle", "high"] },
                    weight: optionalProbability,
                    analysis: text,
                    lineup: {
                      type: "array",
                      items: object(
                        { entry_id: text, position: text, advantage: text },
                        ["entry_id", "position", "advantage"],
                      ),
                    },
                  },
                  ["pace", "weight", "analysis"],
                ),
              },
              evidence_ids: strings,
              limitations: text,
            },
            [
              "simulation_id",
              "mode",
              "engine_version",
              "seed",
              "trial_count",
              "scenarios",
              "evidence_ids",
              "limitations",
            ],
          ),
          recommendations: {
            type: "array",
            items: object(
              {
                recommendation_id: text,
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
                selections: {
                  type: "array",
                  items: { type: "integer", minimum: 1 },
                },
                estimated_probability: optionalProbability,
                odds_snapshot_id: nullableText,
                estimated_ev: { type: ["number", "null"] },
                suggested_amount_yen: {
                  type: "integer",
                  minimum: 0,
                  multipleOf: 100,
                },
                reason: text,
              },
              [
                "recommendation_id",
                "ticket_type",
                "selections",
                "estimated_probability",
                "suggested_amount_yen",
                "reason",
              ],
            ),
          },
          skip_reason: { type: "string" },
        },
        [
          "prediction_id",
          "race_id",
          "model_version_id",
          "snapshot_id",
          "kind",
          "information_cutoff_at",
          "evidence",
          "horse_evaluations",
          "simulation",
          "recommendations",
        ],
      ),
    },
  },
  ["schema_version", "import_id", "generated_at", "predictions"],
);
