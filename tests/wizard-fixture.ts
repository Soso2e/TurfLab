import { obj, rows, type Row } from "../packages/shared/src/domain";
// Deliberately synthetic, only for isolated repositories/DataHome.
export function wizardDraft(now = "2026-10-21T01:00:00.000Z"): Row {
  const time = (offset: number) =>
    new Date(Date.parse(now) + offset * 60000).toISOString();
  return {
    declared_entry_count: 3,
    source: "TEST_FIXTURE_NOT_REAL_DATA",
    source_url: "https://www.jra.go.jp/",
    permission: "official",
    valid_as_of: time(-30),
    available_at: time(-25),
    retrieved_at: time(-20),
    information_cutoff_at: time(-10),
    track: {
      external_id: "fixture-track",
      name: "架空ウィザード競馬場",
      jurisdiction: "JRA",
    },
    course: {
      external_id: "fixture-course",
      surface: "芝",
      distance_m: 1600,
      direction: "右",
      layout: "架空外回り",
    },
    race: {
      external_id: "fixture-wizard-race",
      race_date_jst: new Date(Date.parse(time(240)) + 9 * 3600000)
        .toISOString()
        .slice(0, 10),
      race_number: 1,
      name: "架空ウィザード1R",
      scheduled_start_at: time(240),
    },
    model: { model_identifier: "TEST_MODEL", prompt_version: "wizard-v1" },
    weather: null,
    going: null,
    entries: [1, 2, 3].map((no) => ({
      horse_external_id: `fixture-horse-${no}`,
      horse_name: `架空馬${no}`,
      jockey_external_id: `fixture-jockey-${no}`,
      jockey_name: `架空騎手${no}`,
      horse_number: no,
      draw_number: no,
      carried_weight_kg: 55,
      status: no === 3 ? "scratched" : "active",
    })),
  };
}
export function wizardAnswer(pack: Row, now = "2026-10-21T01:00:00.000Z"): Row {
  const active = rows(pack.entries).filter((e) => e.status === "active");
  return {
    pack_hash: pack.pack_hash,
    generated_at: now,
    rationale: "架空の未検証仮説",
    main_pace: "middle",
    main_pace_reason: "架空の隊列仮説",
    limitations: "架空データの隔離試験。実予想ではない",
    horse_evaluations: active.map((e) => ({
      horse_number: e.horse_number,
      horse_name: e.horse_name,
      components: {
        ability: 80,
        course: 90,
        pace: 80,
        going: 90,
        draw_weight: 80,
        horse_jockey_course: 90,
      },
      course_fit: "架空仮説",
      jockey_fit: "架空仮説",
      expected_position: "先行",
      rationale: "架空仮説・未検証",
    })),
    scenarios: ["slow", "middle", "high"].map((pace) => ({
      pace,
      analysis: "架空の隊列分析",
      lineup: active.map((e) => ({
        horse_number: e.horse_number,
        horse_name: e.horse_name,
        position: "前方",
        advantage: "未検証の仮説",
      })),
    })),
    recommendations: [
      {
        ticket_type: "win",
        selections: [active[0].horse_number],
        suggested_amount_yen: 100,
        reason: "架空参考Bet",
      },
    ],
  };
}
export const wizardRequest = (draft = wizardDraft()): Row => ({
  operation_id: "fixture-wizard",
  draft,
});
export function changeHorse(answer: Row, key: string, value: Row[string]) {
  rows(answer.horse_evaluations)[0][key] = value;
  return answer;
}
export function mainRace(draft: Row) {
  return obj(draft.race);
}
