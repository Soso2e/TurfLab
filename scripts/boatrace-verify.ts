import assert from "node:assert/strict";
import {
  BoatOfficialSource, officialUrl, parseExhibition, parseExhibitionTimes, parseOdds, parseProgram, parseResult, parseVenues,
} from "../workers/api/src/boatrace-official";

const [date, venue, number] = process.argv.slice(2);
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !venue || !/^(0[1-9]|1\d|2[0-4])$/.test(venue) ||
  !number || !/^([1-9]|1[0-2])$/.test(number))
  throw new Error("npm run boatrace:verify -- YYYY-MM-DD 場コード レース番号");

const source = new BoatOfficialSource();
const venues = parseVenues(await source.page(officialUrl("index", date)));
const selected = venues.find(({ code }) => code === venue);
assert(selected, "指定場は公式開催一覧にありません");
const program = parseProgram(await source.page(officialUrl("raceindex", date, venue)), selected.name);
const race = program.find((item) => item.number === Number(number));
assert(race, "指定レースが開催番組にありません");
const load = (name: "odds2tf" | "odds3t" | "beforeinfo" | "raceresult") =>
  source.page(officialUrl(name, date, venue, Number(number)));
const exacta = parseOdds(await load("odds2tf"), "exacta");
const trifecta = parseOdds(await load("odds3t"), "trifecta");
const before = await load("beforeinfo");
const resultPage = await load("raceresult");
console.log(JSON.stringify({
  venueCount: venues.length, venueRaceCount: program.length, race, exacta, trifecta,
  exhibition: { evidence: before.evidence, entries: parseExhibition(before), times: parseExhibitionTimes(before) },
  result: parseResult(resultPage), resultSource: resultPage.evidence,
}, null, 2));
