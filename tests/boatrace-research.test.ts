import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoatRecord, Grade } from "../packages/shared/src/boatrace";
import {
  evaluateB11,
  evaluateCourseGate,
  freezeB11,
  reconstructB11,
  summarizeB11,
  type B11ResearchItem,
} from "../packages/shared/src/boatrace-b11";
import { extractBoatFeatures, normalizeBoatRace } from "../packages/shared/src/boatrace-research";
import { runResearchPipeline } from "../scripts/boatrace-research-cli";

const date = "2026-11-25";
const cutoff = `${date}T09:43:00+09:00`;

function makeRace(id: string, grades: Grade[], extra: Partial<BoatRecord> = {}): BoatRecord {
  return {
    id,
    date,
    venue: "10",
    venueName: "三国",
    number: 3,
    cutoff,
    program: { url: "https://www.boatrace.jp/program", fetchedAt: `${date}T07:00:00+09:00` },
    entries: grades.map((grade_original, i) => ({ boat: i + 1, name: `選手${i + 1}`, grade_original })),
    ...extra,
  };
}

function makeExhibition(order: number[], fetchedAt = `${date}T09:30:00+09:00`) {
  return {
    evidence: { url: "https://www.boatrace.jp/beforeinfo", fetchedAt },
    entries: order.map((boat, idx) => ({ boat, course: idx + 1, st: ".10", flying: false })),
  };
}

function makeOfficialResult(
  payouts: Record<string, number>,
  courseOrder: number[] = [1, 2, 3, 4, 5, 6],
  refundBoats: number[] = [],
  fetchedAt = `${date}T10:00:00+09:00`,
): NonNullable<BoatRecord["result"]> {
  return {
    evidence: { url: "https://www.boatrace.jp/raceresult", fetchedAt },
    status: "official",
    payouts,
    refundBoats,
    courses: courseOrder.map((boat, idx) => ({ boat, course: idx + 1, st: ".12", flying: false })),
    finishes: [
      { boat: 1, position: "1" },
      { boat: 2, position: "2" },
      { boat: 3, position: "3" },
    ],
  };
}

describe("進入順ゲートと時点管理", () => {
  it("展示123456のみ対象、進入変更は見送り、欠損・不正は保留にする", () => {
    const baseGrades: Grade[] = ["B1", "B1", "B1", "B1", "B1", "B1"];

    const allowedRace = makeRace("r-123456", baseGrades, {
      exhibition: makeExhibition([1, 2, 3, 4, 5, 6]),
    });
    expect(evaluateCourseGate(allowedRace)).toMatchObject({
      status: "allowed",
      reason: "exhibition-123456",
      exhibitionOrder: "123456",
      exhibitionSource: "exhibition",
      timing: "pre-cutoff",
    });

    const changedRace = makeRace("r-changed", baseGrades, {
      exhibition: makeExhibition([1, 6, 2, 3, 5, 4]),
    });
    const gateChanged = evaluateCourseGate(changedRace);
    expect(gateChanged).toMatchObject({
      status: "skip",
      reason: "course-changed",
      exhibitionOrder: "162354",
      timing: "pre-cutoff",
    });
    expect(evaluateB11(baseGrades, gateChanged).thresholdsWithGate?.every((t) => t.status === "gate-skip")).toBe(true);

    const missingRace = makeRace("r-missing", baseGrades);
    expect(evaluateCourseGate(missingRace)).toMatchObject({
      status: "pending",
      reason: "missing",
      exhibitionOrder: null,
    });

    const invalidRace = makeRace("r-invalid", baseGrades, {
      exhibition: {
        evidence: { url: "u", fetchedAt: `${date}T09:30:00+09:00` },
        entries: [
          { boat: 1, course: 1, st: ".10", flying: false },
          { boat: 2, course: 1, st: ".10", flying: false }, // 重複コース
          { boat: 3, course: 3, st: ".10", flying: false },
          { boat: 4, course: 4, st: ".10", flying: false },
          { boat: 5, course: 5, st: ".10", flying: false },
          { boat: 6, course: 6, st: ".10", flying: false },
        ],
      },
    });
    expect(evaluateCourseGate(invalidRace)).toMatchObject({
      status: "pending",
      reason: "invalid",
      exhibitionOrder: null,
    });
  });

  it("締切後取得と事前凍結を区別し、freezeB11では未来の展示・結果を漏洩させない", () => {
    const grades: Grade[] = ["A1", "A2", "B1", "B1", "B1", "B1"];
    const race = makeRace("r-leak", grades, {
      exhibition: makeExhibition([1, 2, 3, 4, 5, 6], `${date}T09:50:00+09:00`),
      result: makeOfficialResult({ "1-2-3": 800 }, [1, 2, 3, 4, 6, 5]),
    });
    // 事後再構成では post-cutoff として記録され、本番進入も入る
    const rebuilt = reconstructB11(race);
    expect(rebuilt.evaluation.courseGate).toMatchObject({
      status: "allowed",
      timing: "post-cutoff",
      actualOrder: "123465",
      actualChanged: true,
    });

    // 締切前(09:00)の凍結では、09:50取得の展示や結果を参照しない
    const frozen = freezeB11(race, new Date(`${date}T09:00:00+09:00`));
    expect(frozen).not.toBeNull();
    expect(frozen!.evaluation.courseGate).toMatchObject({
      status: "pending",
      reason: "missing",
      exhibitionOrder: null,
      actualOrder: null,
      actualChanged: null,
    });
  });

  it("展示123456で本番進入が変化しても事後に通常収支から除外せず、対照比較できる", () => {
    const grades: Grade[] = ["B1", "B1", "B1", "B1", "B1", "B1"]; // default 123/124
    const r1 = makeRace("r1", grades, {
      exhibition: makeExhibition([1, 2, 3, 4, 5, 6]),
      result: makeOfficialResult({ "1-2-3": 1000 }, [1, 2, 3, 4, 6, 5]), // 本番進入変化
    });
    const r2 = makeRace("r2", grades, {
      exhibition: makeExhibition([1, 6, 2, 3, 5, 4]),
      result: makeOfficialResult({ "2-1-3": 1500 }, [1, 2, 3, 6, 5, 4]), // 展示変更 → ゲート見送り
    });
    const items: B11ResearchItem[] = [r1, r2].map((r) => ({
      record: reconstructB11(r),
      venueName: r.venueName,
      cutoff: r.cutoff,
      result: r.result,
    }));
    const summary = summarizeB11(items, "reconstructed");
    const noGate = summary.byCap.find((c) => c.key === "control")!.stats;
    const withGate = summary.withCourseGate.byCap.find((c) => c.key === "control")!.stats;

    expect(noGate).toMatchObject({ applied: 2, settled: 2, hits: 1, stake: 400, payout: 1000, net: 600 });
    expect(withGate).toMatchObject({
      applied: 1, gateSkip: 1, actualChangedInApplied: 1, settled: 1, hits: 1, stake: 200, payout: 1000, net: 800,
    });
  });

  it("原級別と補正級別を混同せず、未取得のモーター2連率等はnot_collected(null)のまま保持する", () => {
    const race = makeRace("r-norm", ["A1", "A2", "B1", "B1", "B2", "B2"]);
    const norm = normalizeBoatRace(race);
    expect(norm.entries[0]).toMatchObject({
      gradeOriginal: "A1",
      gradeOriginalReason: "ok",
      gradeAdjusted: null,
      gradeAdjustedReason: "not_frozen",
      motorRate2: null,
      extraMetricsReason: "not_collected",
    });
    const feat = extractBoatFeatures(race);
    expect(feat.adjustedGradeFeatures).toBeNull();
    expect(feat.gradeFeatures.sigma).not.toBeNull();
  });
});

describe("オフライン再現パイプライン (GitHub-only reproducibility)", () => {
  it("固定fixtureからネットなし・Driveなしで決定論的に永続化でき、再実行は冪等になる", () => {
    const work = mkdtempSync(join(tmpdir(), "turflab-research-test-"));
    try {
      const dayDir = join(work, "boatrace", date);
      mkdirSync(dayDir, { recursive: true });
      const grades: Grade[] = ["B1", "B1", "B1", "B1", "B1", "B1"];
      const r1 = makeRace("2026-11-25-10-1", grades, {
        number: 1,
        exhibition: makeExhibition([1, 6, 2, 3, 5, 4], `${date}T09:50:00+09:00`),
        result: makeOfficialResult({ "1-2-3": 900 }, [1, 2, 3, 6, 5, 4]),
      });
      const r2 = makeRace("2026-11-25-10-3", grades, {
        number: 3,
        exhibition: makeExhibition([1, 2, 3, 4, 5, 6], `${date}T09:55:00+09:00`),
        result: makeOfficialResult({ "1-2-3": 700 }, [1, 2, 3, 4, 6, 5]),
      });
      const archive1 = {
        version: "boatrace-archive-v1",
        date,
        records: [r1, { ...r2, result: undefined }],
        autoBets: [],
        revisions: [],
      };
      // 重複スナップショット（r2 の公式結果を追記）
      const archive2 = {
        version: "boatrace-archive-v1",
        date,
        records: [{ ...r1, result: undefined }, r2],
        autoBets: [],
        revisions: [],
      };
      writeFileSync(join(dayDir, "archive-aaaa.json"), JSON.stringify(archive1));
      writeFileSync(join(dayDir, "archive-bbbb.json"), JSON.stringify(archive2));

      const outDir = join(work, "boatrace-research");
      const first = runResearchPipeline({
        command: "run",
        dataRoot: work,
        outDir,
        from: date,
        to: date,
        generatedAt: "2026-11-25T12:00:00+09:00",
        dataSha: "data-sha-fixture",
        codeSha: "code-sha-fixture",
        write: true,
      });
      expect(first.report.audit).toMatchObject({
        archiveFiles: 2,
        uniqueRaces: 2,
        duplicateRaces: 2,
        exhibition123456Count: 1,
        exhibitionChangedCount: 1,
        actualChangedWhenEx123456Count: 1,
      });
      expect(first.outputs.every((o) => o.status === "written")).toBe(true);
      expect(first.b13.totalRaces).toBe(2);
      expect(first.outputs.some(o => o.layer === "evaluations" && o.path.startsWith("evaluations/b13-"))).toBe(true);

      // 時刻と環境を変えて再実行しても deterministicHash が完全一致し、出力はすべて skipped（冪等）
      const second = runResearchPipeline({
        command: "run",
        dataRoot: work,
        outDir,
        from: date,
        to: date,
        generatedAt: "2026-11-26T00:00:00+09:00",
        dataSha: "data-sha-fixture",
        codeSha: "code-sha-fixture",
        write: true,
      });
      expect(second.manifest.deterministicHash).toBe(first.manifest.deterministicHash);
      expect(second.outputs.every((o) => o.status === "skipped")).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
