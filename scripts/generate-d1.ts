import { mkdir, writeFile } from "node:fs/promises";
import {
  references,
  tableDefinitions,
  tables,
} from "../packages/shared/src/domain";
const definitions = tables.map((table) => {
  const pk = tableDefinitions[table][0];
  const refs = Object.entries(references[table] ?? {});
  const fields = [
    `${pk} TEXT PRIMARY KEY NOT NULL`,
    "data_json TEXT NOT NULL CHECK(json_valid(data_json))",
    ...refs.map(
      ([key]) =>
        `${key} TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.${key}')) STORED`,
    ),
    `CHECK(json_extract(data_json, '$.${pk}') = ${pk})`,
    ...refs.map(
      ([key, target]) =>
        `FOREIGN KEY (${key}) REFERENCES ${target}(${tableDefinitions[target][0]}) DEFERRABLE INITIALLY DEFERRED`,
    ),
  ];
  return `CREATE TABLE ${table} (\n  ${fields.join(",\n  ")}\n);`;
});
const sql =
  "-- 正本切替前の移行検証用。運用先へ自動適用しない。\nPRAGMA foreign_keys = ON;\n" +
  definitions.join("\n\n") +
  `\n\nCREATE UNIQUE INDEX entry_number ON race_entries(race_id, json_extract(data_json, '$.horse_number'));
CREATE UNIQUE INDEX race_external ON races(json_extract(data_json, '$.source'), json_extract(data_json, '$.external_id'));
CREATE UNIQUE INDEX adoption_race ON prediction_adoptions(race_id);
CREATE UNIQUE INDEX settlement_result ON settlements(bet_id, result_id);
CREATE UNIQUE INDEX bet_operation ON virtual_bets(json_extract(data_json, '$.operation_id'));
`;
await mkdir("database/d1", { recursive: true });
await writeFile("database/d1/001-records.sql", sql);
