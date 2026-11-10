import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { importNarCsvInbox, zipTar } from "../scripts/nar-csv-import";
import { loadNarCsvDir, mergeRuns, narStats } from "../scripts/nar-csv-stats";

const horses = [
  "競馬場,競走年月日,レース番号,枠番,馬番,騎手名,着順",
  "川崎,2026/10/01,1,1,1,高橋優,1",
  "川崎,2026/10/01,1,2,2,J2,2",
  "川崎,2026/11/11,1,1,1,高橋優,1", // same day as the target: must not count
].join("\n");
const races = ["競馬場,競走年月日,レース番号,芝ダート区分,距離,馬場", "川崎,2026/10/01,1,ダート,1500,良", "川崎,2026/11/11,1,ダート,1500,良"].join("\n");

it("imports owner CSVs once, with provenance, and rejects unknown tables", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "turflab-csv-"));
  const inbox = path.join(home, "nar-csv-inbox");
  await mkdir(inbox);
  await writeFile(path.join(inbox, "a.csv"), horses);
  await writeFile(path.join(inbox, "b.csv"), races);
  await writeFile(path.join(inbox, "other.csv"), "x,y\n1,2");
  const now = new Date("2026-11-11T00:00:00Z");
  expect(await importNarCsvInbox(home, now)).toEqual({ imported: 2, duplicate: 0, rejected: 1 });
  const manifest = JSON.parse(await readFile(path.join(home, "nar-csv/manifest.json"), "utf8"));
  expect(manifest).toEqual(expect.arrayContaining([expect.objectContaining({
    original_name: "a.csv", kind: "horse_results", rows: 3, imported_at: now.toISOString(),
    period: { from: "2026-10-01", to: "2026-11-11" },
  })]));
  expect(await readdir(path.join(inbox, "rejected"))).toHaveLength(1);
  // The same file again is a duplicate, never a second copy.
  await writeFile(path.join(inbox, "a-again.csv"), horses);
  expect(await importNarCsvInbox(home, now)).toEqual({ imported: 0, duplicate: 1, rejected: 0 });
  expect((await readdir(path.join(home, "nar-csv"))).filter((f) => f.endsWith(".csv"))).toHaveLength(2);

  const loaded = (await loadNarCsvDir(path.join(home, "nar-csv")))!;
  const stats = narStats(loaded.runs, {
    track: "川崎", date: "2026-11-11", surface: "ダート", distance_m: 1500, going: "良", jockeys: ["高橋優"],
  }, loaded.files)!;
  expect((stats.draw as { races: number }).races).toBe(1);
  expect((stats.jockeys as { at_track: { starts: number } }[])[0].at_track.starts).toBe(1);
});

it.runIf(process.platform === "win32")("extracts CSVs from the official ZIP", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "turflab-zip-"));
  const src = path.join(home, "src");
  await mkdir(src);
  await mkdir(path.join(home, "nar-csv-inbox"));
  await writeFile(path.join(src, "h.csv"), horses);
  execFileSync(zipTar(), ["-a", "-cf", path.join(home, "nar-csv-inbox", "nar.zip"), "-C", src, "h.csv"]);
  expect(await importNarCsvInbox(home)).toMatchObject({ imported: 1 });
});

it("counts one start once when CSVs and stored results overlap", () => {
  const run = { track: "川崎", date: "2026-10-01", race_no: 1, surface: "dirt" as const, distance_m: 1500, going: "良", draw: 1, horse_number: 1, jockey: "高橋優", finish: 1 };
  expect(mergeRuns([run], [{ ...run }, { ...run, horse_number: 2 }])).toHaveLength(2);
});
