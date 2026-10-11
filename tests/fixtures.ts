import sample from "../docs/examples/chatgpt-import-v0.2.json";
import { hash, obj, type Row, type Table } from "../packages/shared/src/domain";
import { MemoryRepository } from "../packages/shared/src/repository";
export const NOW = "2026-10-12T00:00:00Z";
export const START = "2026-10-12T06:00:00Z";
export const CUTOFF = "2026-10-11T23:00:00Z";
export const SOURCE = {
  source: "TEST_FIXTURE_NOT_REAL_DATA",
  source_url: "https://www.jra.go.jp/",
  valid_as_of: "2026-10-11T20:00:00Z",
  available_at: "2026-10-11T20:01:00Z",
  retrieved_at: "2026-10-11T20:02:00Z",
};
export const base = {
  schema_version: "0.2",
  created_at: "2026-10-11T20:00:00Z",
  ...SOURCE,
};
export async function fixture(repo = new MemoryRepository()) {
  const data: Partial<Record<Table, Row[]>> = {
    tracks: [
      { ...base, track_id: "track", name: "テスト競馬場", jurisdiction: "JRA" },
    ],
    course_layouts: [
      {
        ...base,
        course_id: "course",
        track_id: "track",
        surface: "芝",
        distance_m: 1600,
        revision: 1,
      },
    ],
    horses: [1, 2].map((i) => ({
      ...base,
      horse_id: `horse${i}`,
      horse_name: `架空馬${i}`,
    })),
    jockeys: [1, 2].map((i) => ({
      ...base,
      jockey_id: `jockey${i}`,
      jockey_name: `架空騎手${i}`,
    })),
    races: [
      {
        ...base,
        race_id: "example-race-01",
        course_id: "course",
        jurisdiction: "JRA",
        external_id: "test-race",
        race_date_jst: "2026-10-12",
        race_number: 1,
        name: "架空テストレース",
        scheduled_start_at: START,
        status: "scheduled",
      },
    ],
    race_entries: [1, 2].map((i) => ({
      ...base,
      entry_id: `example-entry-0${i}`,
      race_id: "example-race-01",
      horse_id: `horse${i}`,
      jockey_id: `jockey${i}`,
      horse_number: i,
      status: "active",
    })),
    model_versions: [
      {
        ...base,
        model_version_id: "example-model-v0",
        provider: "manual-chatgpt",
        model_identifier: "test-only",
        feature_version: "feature-v1",
        engine_version: "segment-mc-v1",
        status: "draft",
        training_cutoff_at: null,
      },
    ],
    race_snapshots: [
      {
        ...base,
        snapshot_id: "example-snapshot-01",
        race_id: "example-race-01",
        captured_at: "2026-10-11T22:00:00Z",
        weather: "晴",
        going: "良",
        entries_state_json: [1, 2].map((i) => ({
          entry_id: `example-entry-0${i}`,
          status: "active",
        })),
        scratch_status_json: [],
        odds_snapshot_ids_json: [],
        input_hash: "",
      },
    ],
  };
  const snap = data.race_snapshots![0];
  snap.input_hash = await hash({
    race_id: snap.race_id,
    captured_at: snap.captured_at,
    entries_state_json: snap.entries_state_json,
    scratch_status_json: snap.scratch_status_json,
    odds_snapshot_ids_json: snap.odds_snapshot_ids_json,
    weather: snap.weather,
    going: snap.going,
  });
  for (const [t, rs] of Object.entries(data))
    for (const r of rs) await repo.put(t as Table, r);
  const input = obj(structuredClone(sample));
  input.example_only = false;
  const prediction = obj((input.predictions as Row[])[0]);
  const evidence = (prediction.evidence as Row[])[0];
  evidence.source_url = SOURCE.source_url;
  evidence.source = SOURCE.source;
  evidence.confirmed = true;
  prediction.model_version_id = "example-model-v0";
  prediction.generated_at = undefined as never;
  delete prediction.generated_at;
  return { repo, input, prediction, data };
}
export const resultPayload = (revision = 1, payout = 300): Row => ({
  payouts_complete: true,
  result: {
    ...base,
    result_id: `result-${revision}`,
    race_id: "example-race-01",
    revision,
    official_status: "official",
    published_at: "2026-10-12T06:05:00Z",
    finish_order_json: [[1], [2]],
    entry_status_json: { "1": "finished", "2": "finished" },
    supersedes_result_id: revision > 1 ? `result-${revision - 1}` : null,
  },
  payouts: [
    {
      payout_id: `payout-${revision}`,
      ticket_type: "win",
      selections_json: [1],
      payout_per_100_yen: payout,
      refund_rule_json: null,
    },
  ],
});
