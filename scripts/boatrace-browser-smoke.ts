import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { BoatOfficialSource, japanDate, officialUrl, parseVenues } from "../workers/api/src/boatrace-official";

export async function checkBoatMode(page: Page, origin: string, output: string, token: string) {
  const endpoint = origin + "/api/boatrace/";
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(endpoint + "races")).status, 401);
  const nav = () => page.getByRole("navigation", { name: "競技切替" });
  const choose = (name: string) => nav().getByRole("link", { name }).click();
  const boat = page.getByRole("heading", { name: "競艇ダッシュボード" });
  const horse = page.getByRole("heading", { name: "本日のレース" });

  await choose("競艇");
  await boat.waitFor();
  assert.equal(await nav().getByRole("link", { name: "競艇" }).getAttribute("aria-current"), "true");
  assert.equal(await horse.count(), 0);
  assert(await nav().getByRole("link", { name: "競艇" }).evaluate((e) => e.getBoundingClientRect().height) >= 44);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await nav().evaluate((element) => getComputedStyle(element, "::before").animationName), "switch-boat");
  await page.screenshot({ path: join(output, "boatrace-mobile.png"), animations: "disabled" });

  await page.getByRole("link", { name: "統計", exact: true }).click();
  const stats = page.getByRole("heading", { name: "競艇の統計" });
  await stats.waitFor();
  await page.reload();
  await stats.waitFor();
  await page.goBack();
  await boat.waitFor();
  await page.goForward();
  await stats.waitFor();
  assert(page.url().endsWith("/boatrace/stats"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await nav().evaluate((element) => getComputedStyle(element, "::before").animationName), "none");
  assert.equal(await page.locator(".boat-app main").evaluate((element) => getComputedStyle(element).animationName), "none");

  let releaseDelayed: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { releaseDelayed = resolve; });
  const waiting = page.waitForRequest((request) => request.url().includes("/api/boatrace/races?"));
  await page.route("**/api/boatrace/races?*", async (route) => {
    await delayed;
    await route.continue().catch(() => {});
  }, { times: 1 });
  await page.getByRole("link", { name: "レース", exact: true }).click();
  await waiting;
  await choose("競馬");
  await choose("競艇");
  await choose("競馬");
  releaseDelayed?.();
  await horse.waitFor();
  assert.equal(await boat.count(), 0);
  assert.equal(await page.getByRole("navigation", { name: "競艇メニュー" }).count(), 0);
  const afterSwitch = await fetch(endpoint + "status", { headers });
  assert(afterSwitch.ok);

  // The Windows CI smoke deliberately stays offline. This opt-in exercises the
  // same Worker, alarm and persisted API with today's real official program.
  if (process.env.TURFLAB_BOATRACE_LIVE_TEST === "1") {
    const day = japanDate();
    const source = new BoatOfficialSource();
    const venues = parseVenues(await source.page(officialUrl("index", day)));
    const start = await fetch(endpoint + "collect", { method: "POST", headers });
    assert(start.ok);
    try {
      const expires = Date.now() + 210_000;
      let races: { id: string; venueName: string; state: string }[] = [];
      let lastStatus: unknown;
      while (Date.now() < expires) {
        const status = await fetch(endpoint + "status", { headers });
        lastStatus = await status.json();
        const response = await fetch(endpoint + "races?date=" + day, { headers });
        assert(response.ok);
        races = (await response.json() as { races: typeof races }).races;
        if (new Set(races.map((race) => race.venueName)).size === venues.length) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      assert.equal(new Set(races.map((race) => race.venueName)).size, venues.length,
        `全場の公式番組が保存されませんでした ${JSON.stringify(lastStatus)}`);
      const selected = races.find((race) => race.state === "scheduled") ?? races[0];
      await page.goto(origin + "/boatrace/races/" + selected.id);
      await page.getByRole("heading", { name: "出走・スタート展示" }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      const detail = await fetch(endpoint + "races/" + selected.id, { headers });
      assert(detail.ok);
      const data = await detail.json() as { race: { entries: unknown[]; program: { url: string } } };
      assert.equal(data.race.entries.length, 6);
      assert(data.race.program.url.startsWith("https://www.boatrace.jp/"));
      await page.screenshot({ path: join(output, "boatrace-mobile-official.png"), animations: "disabled" });
      console.log(`競艇公式番組 ${races.length}R・${new Set(races.map((race) => race.venueName)).size}場、詳細 ${selected.id}`);
      await page.goto(origin);
      await horse.waitFor();
      return { id: selected.id, program: data.race.program, venues: venues.length, races: races.length };
    } finally {
      await fetch(endpoint + "collect", { method: "DELETE", headers });
    }
  }
}
