-- 正本切替前の移行検証用。運用先へ自動適用しない。
PRAGMA foreign_keys = ON;
CREATE TABLE tracks (
  track_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.track_id') = track_id)
);

CREATE TABLE course_layouts (
  course_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  track_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.track_id')) STORED,
  CHECK(json_extract(data_json, '$.course_id') = course_id),
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horses (
  horse_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.horse_id') = horse_id)
);

CREATE TABLE jockeys (
  jockey_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.jockey_id') = jockey_id)
);

CREATE TABLE races (
  race_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  course_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.course_id')) STORED,
  CHECK(json_extract(data_json, '$.race_id') = race_id),
  FOREIGN KEY (course_id) REFERENCES course_layouts(course_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE race_entries (
  entry_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  horse_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.horse_id')) STORED,
  jockey_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.jockey_id')) STORED,
  CHECK(json_extract(data_json, '$.entry_id') = entry_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (horse_id) REFERENCES horses(horse_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (jockey_id) REFERENCES jockeys(jockey_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE performances (
  performance_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  horse_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.horse_id')) STORED,
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  jockey_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.jockey_id')) STORED,
  CHECK(json_extract(data_json, '$.performance_id') = performance_id),
  FOREIGN KEY (horse_id) REFERENCES horses(horse_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (jockey_id) REFERENCES jockeys(jockey_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE race_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  CHECK(json_extract(data_json, '$.snapshot_id') = snapshot_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE model_versions (
  model_version_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.model_version_id') = model_version_id)
);

CREATE TABLE predictions (
  prediction_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  snapshot_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.snapshot_id')) STORED,
  model_version_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.model_version_id')) STORED,
  supersedes_prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.supersedes_prediction_id')) STORED,
  CHECK(json_extract(data_json, '$.prediction_id') = prediction_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (snapshot_id) REFERENCES race_snapshots(snapshot_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (supersedes_prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horse_evaluations (
  evaluation_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  entry_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.entry_id')) STORED,
  CHECK(json_extract(data_json, '$.evaluation_id') = evaluation_id),
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (entry_id) REFERENCES race_entries(entry_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE simulation_runs (
  simulation_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  CHECK(json_extract(data_json, '$.simulation_id') = simulation_id),
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE recommendations (
  recommendation_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  simulation_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.simulation_id')) STORED,
  odds_snapshot_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.odds_snapshot_id')) STORED,
  CHECK(json_extract(data_json, '$.recommendation_id') = recommendation_id),
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (simulation_id) REFERENCES simulation_runs(simulation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (odds_snapshot_id) REFERENCES odds_snapshots(odds_snapshot_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE virtual_bets (
  bet_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  recommendation_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.recommendation_id')) STORED,
  CHECK(json_extract(data_json, '$.bet_id') = bet_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE race_results (
  result_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  supersedes_result_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.supersedes_result_id')) STORED,
  CHECK(json_extract(data_json, '$.result_id') = result_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (supersedes_result_id) REFERENCES race_results(result_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE payouts (
  payout_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  result_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.result_id')) STORED,
  CHECK(json_extract(data_json, '$.payout_id') = payout_id),
  FOREIGN KEY (result_id) REFERENCES race_results(result_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE settlements (
  settlement_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  bet_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.bet_id')) STORED,
  result_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.result_id')) STORED,
  supersedes_settlement_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.supersedes_settlement_id')) STORED,
  CHECK(json_extract(data_json, '$.settlement_id') = settlement_id),
  FOREIGN KEY (bet_id) REFERENCES virtual_bets(bet_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_id) REFERENCES race_results(result_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (supersedes_settlement_id) REFERENCES settlements(settlement_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  result_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.result_id')) STORED,
  model_version_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.model_version_id')) STORED,
  CHECK(json_extract(data_json, '$.review_id') = review_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_id) REFERENCES race_results(result_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE daily_runs (
  daily_run_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.daily_run_id') = daily_run_id)
);

CREATE TABLE run_logs (
  log_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  daily_run_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.daily_run_id')) STORED,
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  CHECK(json_extract(data_json, '$.log_id') = log_id),
  FOREIGN KEY (daily_run_id) REFERENCES daily_runs(daily_run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE course_segments (
  segment_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  course_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.course_id')) STORED,
  CHECK(json_extract(data_json, '$.segment_id') = segment_id),
  FOREIGN KEY (course_id) REFERENCES course_layouts(course_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE entity_features (
  feature_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  horse_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.horse_id')) STORED,
  jockey_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.jockey_id')) STORED,
  CHECK(json_extract(data_json, '$.feature_id') = feature_id),
  FOREIGN KEY (horse_id) REFERENCES horses(horse_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (jockey_id) REFERENCES jockeys(jockey_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE odds_snapshots (
  odds_snapshot_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  CHECK(json_extract(data_json, '$.odds_snapshot_id') = odds_snapshot_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE prediction_adoptions (
  adoption_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  race_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.race_id')) STORED,
  prediction_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.prediction_id')) STORED,
  CHECK(json_extract(data_json, '$.adoption_id') = adoption_id),
  FOREIGN KEY (race_id) REFERENCES races(race_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (prediction_id) REFERENCES predictions(prediction_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE import_operations (
  import_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.import_id') = import_id)
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  CHECK(json_extract(data_json, '$.event_id') = event_id)
);

CREATE UNIQUE INDEX entry_number ON race_entries(race_id, json_extract(data_json, '$.horse_number'));
CREATE UNIQUE INDEX race_external ON races(json_extract(data_json, '$.source'), json_extract(data_json, '$.external_id'));
CREATE UNIQUE INDEX adoption_race ON prediction_adoptions(race_id);
CREATE UNIQUE INDEX settlement_result ON settlements(bet_id, result_id);
CREATE UNIQUE INDEX bet_operation ON virtual_bets(json_extract(data_json, '$.operation_id'));
