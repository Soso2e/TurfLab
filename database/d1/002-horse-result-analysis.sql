-- 馬別レース後結果分析テーブル。001-records.sql 適用後に実行する。
PRAGMA foreign_keys = ON;

CREATE TABLE horse_result_analyses (
  analysis_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id    TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id'))    STORED,
  entry_id   TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.entry_id'))   STORED,
  result_id  TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.result_id'))  STORED,
  horse_id   TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.horse_id'))   STORED,
  CHECK(json_extract(data_json, '$.analysis_id') = analysis_id),
  FOREIGN KEY (race_id)   REFERENCES races(race_id)             DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (entry_id)  REFERENCES race_entries(entry_id)     DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_id) REFERENCES race_results(result_id)    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (horse_id)  REFERENCES horses(horse_id)           DEFERRABLE INITIALLY DEFERRED
);

-- 1レース結果につき1頭1分析（再実行時は上書きではなく新版で supersedes を使う）
CREATE UNIQUE INDEX analysis_entry_result ON horse_result_analyses(entry_id, result_id);
