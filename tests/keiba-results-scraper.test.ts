import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fetchNarOfficialResultDocument,
  parseNarRaceList,
  parseNarRaceMarkRunners,
  parseNarVenues,
  saveNarAllResults,
  scrapeAllNarResultsForDate,
} from "../scripts/keiba-results-scraper";

const topHtml = `
  <a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F11%2F24&amp;k_babaCode=11">水沢</a>
  <a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F11%2F24&amp;k_babaCode=24">名古屋</a>
  <a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F11%2F23&amp;k_babaCode=20">大井</a>
`;

const raceListHtml = `
<table>
  <tr class="data">
    <td>1R</td><td>11:40</td><td></td><td>C2</td>
    <td><a href="/KeibaWeb/TodayRaceInfo/DebaTable?k_raceDate=2026%2F11%2F24&amp;k_babaCode=11&amp;k_raceNo=1">テスト1R</a></td>
    <td>ダート1300m</td><td>晴</td><td>良</td><td>10</td>
    <td><a href="/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=2026%2F11%2F24&amp;k_babaCode=11&amp;k_raceNo=1">成績</a></td>
  </tr>
  <tr class="data">
    <td>2R</td><td>12:15</td><td></td><td>C2</td>
    <td><a href="/KeibaWeb/TodayRaceInfo/DebaTable?k_raceDate=2026%2F11%2F24&amp;k_babaCode=11&amp;k_raceNo=2">テスト2R</a></td>
    <td>ダート1400m</td><td>晴</td><td>良</td><td>10</td>
    <td>発売中</td>
  </tr>
</table>
`;

const markHtml = `
<table>
  <tr class="tBorder">
    <td class="a">1</td><td>1</td><td class="c">3</td>
    <td><a href="/HorseMarkInfo?id=1">サンプルワン</a></td><td>牡3</td>
    <td><a href="/RiderMarkInfo?id=1">騎手A</a></td><td>56.0</td><td>1:23.4</td>
    <td></td><td>39.0</td><td>1</td><td>1.8</td>
  </tr>
  <tr class="tBorder">
    <td class="a">2</td><td>2</td><td class="c">5</td>
    <td><a href="/HorseMarkInfo?id=2">サンプルツー</a></td><td>牝3</td>
    <td><a href="/RiderMarkInfo?id=2">騎手B</a></td><td>54.0</td><td>1:23.9</td>
    <td></td><td>39.5</td><td>2</td><td>4.5</td>
  </tr>
</table>
<table>
  <tr><td class="title">単勝</td><td class="a">3</td><td class="refundMoney">180円</td></tr>
  <tr><td class="title">馬複</td><td class="a">3 - 5</td><td class="refundMoney">420円</td></tr>
</table>
`;

describe("NAR全レース結果スクレイパー", () => {
  it("開催一覧・レース一覧・出走馬成績をパースする", () => {
    const venues = parseNarVenues(topHtml, "2026-11-24");
    expect(venues).toEqual([
      { babaCode: "11", dateSlash: "2026/11/24", dateIso: "2026-11-24", trackName: "水沢" },
      { babaCode: "24", dateSlash: "2026/11/24", dateIso: "2026-11-24", trackName: "名古屋" },
    ]);

    const races = parseNarRaceList(raceListHtml, "11", "2026-11-24");
    expect(races).toHaveLength(2);
    expect(races[0]).toMatchObject({
      race_no: 1,
      race_name: "テスト1R",
      race_class: "C2",
      scheduled_start_at_jst: "2026-11-24T11:40:00+09:00",
      has_result: true,
    });
    expect(races[1].has_result).toBe(false);

    const runners = parseNarRaceMarkRunners(markHtml);
    expect(runners).toHaveLength(2);
    expect(runners[0]).toMatchObject({
      position: "1",
      bracket: 1,
      horse_number: 3,
      horse_name: "サンプルワン",
      jockey: "騎手A",
      weight_kg: 56,
      time: "1:23.4",
      popularity: 1,
      win_odds: 1.8,
    });
  });

  it("全レースの結果を取得し、購入買い目を紐付けて保存する", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "turflab-keiba-"));
    try {
      const plansDir = path.join(tmp, "plans", "2026-11-24");
      await mkdir(plansDir, { recursive: true });
      await writeFile(path.join(plansDir, "11-1-hit.json"), JSON.stringify({
        track: "水沢",
        race_number: 1,
        plan_type: "hit",
        tickets: [{ ticket_type: "wide", selections: [3, 5], stake_yen: 200 }],
      }));

      const fakeFetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("TodayRaceInfoTop")) return new Response(topHtml, { status: 200 });
        if (url.includes("RaceList") && url.includes("k_babaCode=11")) return new Response(raceListHtml, { status: 200 });
        if (url.includes("RaceList")) return new Response("<table></table>", { status: 200 });
        if (url.includes("RaceMarkTable")) return new Response(markHtml, { status: 200 });
        return new Response("", { status: 404 });
      }) as typeof fetch;

      const doc = await fetchNarOfficialResultDocument("race-1", "11", "2026-11-24", 1, [3, 5], fakeFetch);
      expect(doc).toMatchObject({
        bridge_version: "1",
        race_date_jst: "2026-11-24",
        result: { finish_order_json: [[3], [5]] },
      });

      const archive = await scrapeAllNarResultsForDate("2026-11-24", {
        fetchFn: fakeFetch,
        exchangeDir: tmp,
        delayMs: 0,
      });
      expect(archive.races).toHaveLength(2);
      expect(archive.races[0].official_result?.finish_order_json).toEqual([[3], [5]]);
      expect(archive.races[0].bought_bets).toEqual([
        { lane: "hit", ticket_type: "wide", selections: [3, 5], stake_yen: 200 },
      ]);
      expect(archive.races[1].official_result).toBeNull();

      const saved = await saveNarAllResults(tmp, "2026-11-24", archive);
      expect(saved).toContain("nar-all-results-v1.json");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
