# DB・Google Sheets論理設計 v0.2

Google Sheetsを初期正本とし、1論理テーブルを原則1タブにします。行番号をIDとして使わず、文字列の安定IDを保持します。この文書は論理設計であり、SQLマイグレーション・接続済みSheetsではありません。

## 共通規約

- 主キー: 内部UUID等。外部の競走ID・馬IDとの対応は `source` と `external_id` で保持し、名前一致のみで統合しない。
- 共通列: `schema_version`, `created_at`, `source`, `source_url`, `retrieved_at`, `valid_as_of`, `available_at`, `is_estimated`, `confidence`, `sample_size`。無関係な列はnull。
- `valid_as_of`: 観測の基準時刻。`available_at`: 外部で情報が利用可能になった時刻。`retrieved_at`: 本システムが取得した時刻。予想では三つとも締切以前であることを原則に検証する。不明な利用可能時刻は取得時刻を保守的に使い、その扱いを記録する。
- 事実と推定が混在するレコードはフィールド別に `evidence_json` を持ち、各値の種別・出典・時刻を記録。信頼度はモデルの自己評価か検証済みかも区別。
- 日時はISO 8601 UTC、日付集計は日本時間。距離m、時間秒、重量kg、確率0〜1、金額は円相当の整数。nullは欠測、0は観測値。
- 配列・オブジェクトは規定のJSON文字列で保持。入力ハッシュはキー順等を正規化した内容から生成し、改行やキー順だけの差を重複扱いする。
- 一意性、必須列、型、外部参照はAPIで検証。Sheetsには外部キーや一意制約がないため、定期監査でも確認する。

## 中核20テーブル

`PK`は主キー、`FK`は参照先です。共通列は下表では省略します。

| テーブル | PK / FK | 主要プロパティ・制約 |
|---|---|---|
| tracks | track_id | name, jurisdiction（JRA/local）, location, timezone |
| course_layouts | course_id / track_id | surface, distance_m, direction, layout, rail_setting, straight_length_m, elevation_profile_json, turn_geometry_json, start_to_first_turn_m, course_width_m, revision。形状変更は新しい版 |
| horses | horse_id | horse_name, sex, birth_date, pedigree_json, trainer_external_id。推定適性はfeatures履歴へ |
| jockeys | jockey_id | jockey_name, affiliation。成績・戦術はfeatures履歴へ |
| races | race_id / course_id | jurisdiction, external_id, race_date_jst, race_number, name, scheduled_start_at, status。source+external_idは一意 |
| race_entries | entry_id / race_id, horse_id, jockey_id | horse_number, draw_number, carried_weight_kg, status。race_id+horse_numberは一意。馬体重等の時変値はsnapshot内 |
| performances | performance_id / horse_id, race_id, jockey_id | finish_position, finish_time_s, last_3f_s, corner_positions_json, draw_number, horse_number, carried_weight_kg, body_weight_kg, body_weight_change_kg, going, margin, pace_observed, running_style_observed, trouble_notes。訂正は版を追加 |
| race_snapshots | snapshot_id / race_id | captured_at, weather, going, temperature_c, wind_json, track_bias_json, bias_sample_size, expected_pace, entries_state_json, scratch_status_json, odds_snapshot_ids_json, input_hash。更新は追記 |
| model_versions | model_version_id | provider, model_identifier, prompt_version, prompt_hash, feature_version, weights_json, engine_version, parameters_json, training_cutoff_at, status。公開済み設定は固定 |
| predictions | prediction_id / race_id, model_version_id, snapshot_id | revision, kind（morning/final/reanalysis/backtest）, status, predicted_at, information_cutoff_at, locked_at, supersedes_prediction_id, input_hash, feature_ids_json, rationale, import_id |
| horse_evaluations | evaluation_id / prediction_id, entry_id | rank, score, win_probability, top3_probability, abilities_json, course_fit, jockey_fit, expected_position, evidence_json。prediction_id+entry_idは一意 |
| simulation_runs | simulation_id / prediction_id | mode（narrative/numeric）, status, scenarios_json, engine_version, input_hash, seed, trial_count, outputs_json, started_at, completed_at。文章分析のtrial_countはnull |
| recommendations | recommendation_id / prediction_id, simulation_id | ticket_type, selections_json, estimated_probability, odds_snapshot_id, estimated_ev, suggested_amount_yen, reason。自動的に購入しない |
| virtual_bets | bet_id / race_id, prediction_id, recommendation_id（任意） | ticket_type, selections_json, amount_yen, confirmed_at, budget_date_jst, status, operation_id。手動買い目も可 |
| race_results | result_id / race_id | revision, official_status, published_at, finish_order_json, entry_status_json, supersedes_result_id。同着・取消・中止を保持 |
| payouts | payout_id / result_id | ticket_type, selections_json, payout_per_100_yen, refund_rule_json。result_id+券種+正規化買い目は一意 |
| settlements | settlement_id / bet_id, result_id | revision, stake_yen, payout_yen, refund_yen, net_yen, status, settled_at, supersedes_settlement_id。bet_id+result_idは一意 |
| reviews | review_id / race_id, prediction_id, result_id, model_version_id | observations_json, hypotheses_json, unknowns_json, validation_plan_json, reviewed_at。原因の推測を事実に昇格しない |
| daily_runs | daily_run_id | run_date_jst, run_kind, operation_id, status, race_ids_json, expected_counts_json, completed_counts_json, started_at, completed_at。同日でもレビュー/予想を区別 |
| run_logs | log_id / daily_run_id, race_id（任意） | operation_id, stage, attempt, status, error_code, safe_message, expected_hash, actual_hash, created_at。秘密情報を記録しない |

## 履歴・復旧の補助テーブル

元案の20テーブルに、履歴を上書きせず時点再現するための補助構造を追加します。Phase 1で列を確定します。

| テーブル | PK / 参照 | 用途 |
|---|---|---|
| course_segments | segment_id / course_id | 版別の区間順、開始/終了位置、勾配、曲率。Phase 5で数値利用 |
| entity_features | feature_id / horse_idまたはjockey_id | feature_version, evaluation_at, cutoff_at, sample_size, confidence, features_json, performance_ids_json。騎手条件別成績・脚質分布・コンビ成績、馬の能力・適性を時点保存 |
| odds_snapshots | odds_snapshot_id / race_id | captured_at, ticket_type, selections_json, odds, available_at, retrieved_at。予想時点と最終値を分離 |
| prediction_adoptions | adoption_id / race_id, prediction_id | adopted_at, selection_rule_version。当日採用は発走前固定、後から最善版を選ばない |
| import_operations | import_id | idempotency_key, payload_hash, expected_rows_json, stage_checkpoint_json, status, completed_at。再送・復旧台帳 |
| audit_events | event_id / operation_id | actor, action, entity_type, entity_id, before_hash, after_hash, event_at。訂正と購入操作の履歴 |

## 参照のつながり

track → course → race → entries → horse/jockey。race → snapshot → prediction → evaluations/simulations/recommendations。race → virtual_bets。race → results → payouts。bet+result → settlement。prediction+result → review。モデル・特徴量・入力スナップショットは予想から固定参照します。

結果は予想入力とは分離して保存します。過去レースの結果を能力推定に使えるのは、その結果の公表・取得が対象予想の締切前の場合のみです。最新マスターの派生成績から過去の特徴量を再生成しません。

## Sheets運用・移行

ヘッダーとschema_versionを検証し、未知の列や既存データを削除しません。既存Sheetsのコピーを検査し、旧17テーブルの `horse_predictions`→`horse_evaluations`、`simulations`→`simulation_runs`、`bets`→`virtual_bets` 等の対応を確認して移行表を作ります。旧列の意味が違う場合は名前だけで移行しません。

APIの一括書き込み、永続的な直列化、操作台帳、読み返し照合を組み合わせます。部分保存の予想は公開しません。ロックが切れた後の再開・同時購入・Sheets直接編集をPhase 1の検証対象にします。D1向けSQLは列と移行方針を確定後に作成し、件数・参照・ハッシュ・集計照合とロールバックを含めて検証します。
