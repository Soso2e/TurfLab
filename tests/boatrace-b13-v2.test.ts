import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoatRecord, Grade } from "../packages/shared/src/boatrace";
import {
  B13V2_CONFIG,
  B13V2_FEATURE_NAMES,
  buildBoatFeatureMatrix,
  evaluateB13V2,
  extractB13V2Features,
  fitB13V2,
  fitB13V2NoEx,
  predictB13V2,
  scoreDistribution,
  VIRTUAL_BANKROLL_INITIAL_YEN,
} from "../packages/shared/src/boatrace-b13-v2";
import { BoatCollector } from "../workers/api/src/boatrace-collector";

function makeRace(
  id: string,
  date: string,
  order: number[] = [1, 2, 3],
  opts: {
    grades?: Grade[];
    exPreCutoff?: boolean;
    exCourse?: number[];
    exTimes?: number[];
    exSts?: string[];
    exFs?: boolean[];
    withEx?: boolean;
  } = {},
): BoatRecord {
  const grades = opts.grades ?? ["A1", "B1", "B1", "B1", "B1", "B2"];
  const withEx = opts.withEx ?? true;
  const exPre = opts.exPreCutoff ?? true;
  const exCourse = opts.exCourse ?? [1, 2, 3, 4, 5, 6];
  const exTimes = opts.exTimes ?? [6.70, 6.72, 6.75, 6.78, 6.77, 6.76];
  const exSts = opts.exSts ?? [".08", ".10", ".12", ".14", ".11", ".09"];
  const exFs = opts.exFs ?? [false, false, false, false, false, false];
  return {
    id,
    date,
    venue: "15",
    venueName: "丸亀",
    number: 9,
    cutoff: date + "T09:00:00+09:00",
    program: { url: "fixture", fetchedAt: date + "T08:00:00+09:00" },
    entries: [1, 2, 3, 4, 5, 6].map((boat, i) => ({ boat, name: `R${boat}`, grade_original: grades[i] })),
    exhibition: withEx
      ? {
          evidence: { url: "fixture", fetchedAt: exPre ? date + "T08:50:00+09:00" : date + "T09:10:00+09:00" },
          entries: [1, 2, 3, 4, 5, 6].map((boat, i) => ({
            boat,
            course: exCourse[i],
            st: exSts[i],
            flying: exFs[i],
          })),
          times: Object.fromEntries([1, 2, 3, 4, 5, 6].map((b, i) => [b, exTimes[i]])),
        }
      : undefined,
    result: {
      status: "official",
      evidence: { url: "fixture", fetchedAt: date + "T10:00:00+09:00" },
      finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
      payouts: { [order.join("-")]: 900 },
      refundBoats: [],
      courses: [],
    },
  };
}

describe("B13v2 contextual Plackett-Luce shadow", () => {
  it("extracts grade structure, exhibition time/ST sigma, per-boat F, and wakunari accurately", () => {
    const r = makeRace("r1", "2026-11-26", [1, 2, 3], {
      grades: ["A1", "A2", "B1", "B1", "B1", "B2"],
      exFs: [false, false, false, true, false, false],
      exSts: [".08", ".10", ".12", "F.03", ".11", ".09"],
    });
    const f = extractB13V2Features(r);
    expect(f.hasAllGrades).toBe(true);
    expect(f.innerDesc).toBe(true);
    expect(f.b1MinusOthers).toBeCloseTo(4 - (3 + 2 + 2 + 2 + 1) / 5, 10);
    expect(f.exhibitionWakunari).toBe(true);
    expect(f.exhibitionPreCutoff).toBe(true);
    expect(f.timeStd).toBeGreaterThan(0);
    expect(f.stStd).toBeGreaterThan(0);
    expect(f.exhibitionF).toEqual([false, false, false, true, false, false]);
    expect(f.exhibitionFDepth[3]).toBeCloseTo(0.03, 10);
  });

  it("drops post-cutoff exhibition when preCutoffExhibitionOnly is enabled", () => {
    const r = makeRace("r-post", "2026-11-26", [1, 2, 3], { exPreCutoff: false });
    const fFull = extractB13V2Features(r, { preCutoffExhibitionOnly: false });
    const fPre = extractB13V2Features(r, { preCutoffExhibitionOnly: true });
    expect(fFull.exhibitionPreCutoff).toBe(false);
    expect(fFull.timeStd).not.toBeNull();
    expect(fPre.timeStd).toBeNull();
    expect(fPre.stStd).toBeNull();
    expect(fPre.exhibitionWakunari).toBeNull();
    expect(fPre.exhibitionF.every((v) => v === null)).toBe(true);
  });

  it("fits deterministically and outputs normalized 120-permutation distribution", () => {
    const s1 = makeRace("a1", "2026-11-23", [1, 2, 3]);
    const s2 = makeRace("a2", "2026-11-23", [1, 3, 2], {
      grades: ["A1", "B1", "A1", "B1", "B1", "B2"],
      exTimes: [6.71, 6.79, 6.68, 6.76, 6.75, 6.78],
    });
    const model = fitB13V2([
      { features: extractB13V2Features(s1), order: [1, 2, 3] },
      { features: extractB13V2Features(s2), order: [1, 3, 2] },
    ])!;
    expect(model.weights).toHaveLength(B13V2_FEATURE_NAMES.length);
    const pred = predictB13V2(model, extractB13V2Features(s1));
    expect(pred.distribution).toHaveLength(120);
    expect(new Set(pred.distribution.map((x) => x.combination)).size).toBe(120);
    expect(pred.distribution.reduce((a, x) => a + x.probability, 0)).toBeCloseTo(1, 12);
    expect(pred.distribution[0].combination).toBe("1-2-3");
    // deterministic
    expect(predictB13V2(model, extractB13V2Features(s1))).toEqual(pred);
  });

  it("enforces expanding-window temporal split and compares B13v2, B13v2Pre, B13, and FIXED123", () => {
    const d1a = makeRace("d1a", "2026-11-23", [1, 2, 3]);
    const d1Late = makeRace("d1Late", "2026-11-23", [6, 5, 4]);
    d1Late.result!.evidence.fetchedAt = "2026-11-24T01:00:00+09:00"; // must not leak into 11-24
    const d2a = makeRace("d2a", "2026-11-24", [1, 2, 3]);
    const d2PostProg = makeRace("d2PostProg", "2026-11-24", [1, 2, 3]);
    d2PostProg.program.fetchedAt = d2PostProg.cutoff!;

    const report = evaluateB13V2([d2PostProg, d2a, d1Late, d1a]);
    expect(report.days[0].trainingCount).toBe(0);
    expect(report.days[1].trainingCount).toBe(1);
    expect(report.days[1].rows.find((x) => x.raceId === "d2PostProg")?.status).toBe("program-not-pre-cutoff");
    expect(report.days[1].models.B13v2).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 200, payout: 900 });
    expect(report.days[1].models.B13v2Pre).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 200, payout: 900 });
    expect(report.days[1].models.B13v2NoEx).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 200, payout: 900 });
    expect(report.days[1].models.FIXED123).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 200, payout: 1800 });
    expect(report.days[1].models.B13v2Pre.balanceEnd).toBe(VIRTUAL_BANKROLL_INITIAL_YEN + 700);
    expect(report.days[1].models.B13v2.logLoss).not.toBeNull();
    expect(report.days[1].models.B13v2.brierScore).not.toBeNull();
    expect(report).toEqual(evaluateB13V2([d1a, d1Late, d2a, d2PostProg]));
  });

  it("prevents race-level feature cancellation via zero-sum contrasts and supports NoEx fallback", () => {
    const sumSlope = B13V2_CONFIG.innerSlope.reduce((a, b) => a + b, 0);
    const sumB1 = B13V2_CONFIG.b1FocusContrast.reduce((a, b) => a + b, 0);
    expect(sumSlope).toBeCloseTo(0, 12);
    expect(sumB1).toBeCloseTo(0, 12);

    const s1 = makeRace("z1", "2026-11-23", [1, 2, 3], { exTimes: [6.70, 6.71, 6.72, 6.73, 6.74, 6.75] });
    const s2 = makeRace("z2", "2026-11-23", [4, 5, 6], {
      grades: ["B1", "B1", "B1", "A1", "A1", "A1"],
      exCourse: [2, 1, 3, 4, 5, 6],
      exTimes: [6.85, 6.84, 6.80, 6.65, 6.66, 6.67],
    });
    const full = fitB13V2([
      { features: extractB13V2Features(s1), order: [1, 2, 3] },
      { features: extractB13V2Features(s2), order: [4, 5, 6] },
    ])!;
    const noEx = fitB13V2NoEx([
      { features: extractB13V2Features(s1), order: [1, 2, 3] },
      { features: extractB13V2Features(s2), order: [4, 5, 6] },
    ])!;

    const fWaku = extractB13V2Features(makeRace("w1", "2026-11-24", [1, 2, 3], { exCourse: [1, 2, 3, 4, 5, 6] }));
    const fChanged = extractB13V2Features(makeRace("w2", "2026-11-24", [1, 2, 3], { exCourse: [2, 1, 3, 4, 5, 6] }));
    const m1 = buildBoatFeatureMatrix(fWaku, full.norm);
    const m2 = buildBoatFeatureMatrix(fChanged, full.norm);
    // Race-level wakunari feature differs across boats (non-constant shift)
    expect(m1.map((r) => r[23])).not.toEqual(m2.map((r) => r[23]));
    expect(predictB13V2(full, fWaku).distribution).not.toEqual(predictB13V2(full, fChanged).distribution);

    const pNoEx = predictB13V2(noEx, extractB13V2Features(makeRace("nx", "2026-11-24", [1, 2, 3], { withEx: false })));
    expect(pNoEx.distribution).toHaveLength(120);
    const metrics = scoreDistribution(pNoEx.distribution, "1-2-3");
    expect(metrics.brierScore).toBeGreaterThanOrEqual(0);
    expect(metrics.brierScore).toBeLessThanOrEqual(2);
  });

  afterEach(() => vi.useRealTimers());

  it("captures pre-cutoff exhibition for all races and freezes shadow predictions when shadowExhibition is enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = new DatabaseSync(":memory:");
    const kv = new Map<string, unknown>();
    const state = {
      storage: {
        sql: {
          exec: (sql: string, ...bind: (string | number)[]) => {
            const stmt = db.prepare(sql);
            const read = sql.trimStart().startsWith("SELECT") || sql.trimStart().startsWith("PRAGMA");
            if (!read) stmt.run(...bind);
            const rows = read ? stmt.all(...bind) : [];
            return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
          },
        },
        transactionSync: (fn: () => void) => {
          db.exec("BEGIN");
          try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
        },
        get: async (k: string) => structuredClone(kv.get(k)),
        put: async (k: string | Record<string, unknown>, v?: unknown) => {
          for (const [kk, vv] of Object.entries(typeof k === "string" ? { [k]: v } : k)) kv.set(kk, structuredClone(vv));
        },
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    } as unknown as DurableObjectState;

    const d1 = "2026-11-23";
    const d2 = "2026-11-24";
    const priorRace = makeRace(`${d1}-12-1`, d1, [1, 2, 3]);
    const progRow = (n: number, time: string) =>
      `<tr><td><a href="/owpc/pc/race/racelist?hd=20261124&jcd=12&rno=${n}">${n}R</a></td><td>${time}</td><td>発売前</td>` +
      [1, 2, 3, 4, 5, 6].map((b) => `<td><a>R${b}</a><div class="is-fs12">${b === 1 ? "A1" : "B1"}</div></td>`).join("") +
      "</tr>";
    const beforeHtml =
      [1, 2, 3, 4, 5, 6].map((b) => `<div class="table1_boatImage1"><span class="table1_boatImage1Number">${b}</span><span class="table1_boatImage1Time">.1${b}</span></div>`).join("") +
      `<table><thead><tr><th>枠</th><th>選手</th><th>展示タイム</th></tr></thead>${[1, 2, 3, 4, 5, 6].map((b) => `<tbody><tr><td>${b}</td><td>R${b}</td><td>6.7${b}</td></tr></tbody>`).join("")}</table>`;
    const oddsHtml = '<p class="tab4_refreshText">オッズ更新時間 15:24</p><table><tr><td>締切予定時刻</td><td>15:27</td></tr></table>';

    const source = {
      page: vi.fn(async (url: string) => {
        const p = new URL(url).pathname.split("/").at(-1)!;
        const html =
          p === "index" ? '<table><tbody><tr><td><img src="/text_place1_12.png" alt="住之江"></td><td><a href="/owpc/pc/race/raceindex?hd=20261124&jcd=12">開催</a></td></tr></tbody></table>'
          : p === "raceindex" ? `<table><tbody>${progRow(1, "15:27")}${progRow(2, "15:28")}</tbody></table>`
          : p === "beforeinfo" ? beforeHtml
          : p === "odds2tf" || p === "odds3t" ? oddsHtml
          : "";
        return { html, evidence: { url, fetchedAt: new Date().toISOString() } };
      }),
    };

    try {
      const collector = new BoatCollector(state, source);
      await collector.route(new Request("https://example.test/api/boatrace/collect?shadow=1", { method: "POST" }));
      db.prepare("INSERT INTO boat_races (id, date, body, cutoff, capture_next, result_next) VALUES (?, ?, ?, ?, 0, 0)")
        .run(priorRace.id, d1, JSON.stringify(priorRace), Date.parse(priorRace.cutoff!));

      vi.setSystemTime(new Date(`${d2}T15:10:00+09:00`));
      await collector.alarm(); // program sync + initial shadow prediction (NoEx)

      vi.setSystemTime(new Date(`${d2}T15:22:00+09:00`));
      await collector.alarm(); // 6 min before cutoff -> captures beforeinfo for BOTH 1R & 2R independently of 30m bet limit!

      const frozen = db.prepare("SELECT race_id, body FROM boat_shadow_predictions ORDER BY race_id").all() as { race_id: string; body: string }[];
      expect(frozen).toHaveLength(2);
      expect(JSON.parse(frozen[0].body)).toMatchObject({ mainModel: "B13v2Pre", hasPreCutoffExhibition: true, preUsedNoEx: false });
      expect(JSON.parse(frozen[1].body)).toMatchObject({ mainModel: "B13v2Pre", hasPreCutoffExhibition: true, preUsedNoEx: false });

      const shadowRes = await (await collector.route(new Request(`https://example.test/api/boatrace/shadow?from=${d1}`))).json() as {
        mainModel: string; frozenCount: number; frozenPreExhibitionCount: number;
      };
      expect(shadowRes).toMatchObject({ mainModel: "B13v2Pre", frozenCount: 2, frozenPreExhibitionCount: 2 });
    } finally {
      db.close();
    }
  });
});
