import { expect, it } from "vitest";
import { exportBoatArchives } from "../scripts/boatrace-github-export";
import { blobSha, type BridgeIO } from "../scripts/github-bridge";

it("exports JST boat archives once, keeps revisions, and rejects wrong dates", async () => {
  const files = new Map<string, string>();
  let changed = false;
  let invalid = false;
  const io: BridgeIO = {
    now: () => new Date("2026-11-23T16:00:00Z"),
    api: async (route) => {
      const date = route.split("=")[1];
      return { version: "boatrace-archive-v1", date: invalid ? "wrong" : date,
        records: date === "2026-11-24" ? [{ date, id: "test", result: changed ? "official" : null }] : [],
        autoBets: [], revisions: [] };
    },
    list: async () => [...files].map(([path, content]) => ({ path, sha: blobSha(content) })),
    read: async (file) => files.get(file.path)!,
    put: async (path, content) => { files.set(path, content); },
  };
  await exportBoatArchives(io);
  await exportBoatArchives(io);
  expect(files.size).toBe(1);
  expect([...files.keys()][0]).toMatch(/^boatrace\/2026-11-24\/archive-/);
  changed = true;
  await exportBoatArchives(io);
  expect(files.size).toBe(2);
  invalid = true;
  await expect(exportBoatArchives(io)).rejects.toThrow();
  expect(files.size).toBe(2);
});

it("exports older backfills when the historical observation revision changes", async () => {
  const files = new Map<string, string>();
  const historical = new Map<string, string>();
  const oldDate = "2026-11-01";
  let count = 1;
  let archivedOld = 0;
  const io: BridgeIO = {
    now: () => new Date("2026-11-27T13:00:00Z"),
    api: async (route) => {
      if (route.endsWith("/collection/dates")) return {
        dates: [{ date: oldDate, count, latest: "2026-11-27T13:00:00Z" }],
      };
      const date = route.split("=")[1];
      if (date === oldDate) archivedOld++;
      return { version: "boatrace-archive-v1", date, autoBets: [], revisions: [],
        records: date === oldDate ? [{ date, id: "old", observations: count }] : [] };
    },
    list: async () => [...files].map(([path, content]) => ({ path, sha: blobSha(content) })),
    read: async (file) => files.get(file.path)!,
    put: async (path, content) => { files.set(path, content); },
  };
  await exportBoatArchives(io, historical);
  await exportBoatArchives(io, historical);
  expect(archivedOld).toBe(1);
  count++;
  await exportBoatArchives(io, historical);
  expect(archivedOld).toBe(2);
  expect(files.size).toBe(2);
});
