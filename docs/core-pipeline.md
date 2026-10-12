# 1レースずつのCore実行（Issue #30）

追加AI APIを使わず、ChatGPTが作った全馬評価・3展開・推奨を手動で渡す。TurfLabが総合点・順位・予算・参照を検証し、予想と参考プランをロックする。本人購入を自動生成しない。

## 前提

既存の本人用API_TOKENとRepositoryを使用する。実Sheetsを利用する場合は、バックアップと列確認の後、既存の `/api/sheets/provision` で追加の `TL_race_pipeline_runs` / `TL_reference_plans` / `TL_reference_adoptions` を作成する。旧タブは変更しない。新しいタブがないまま更新すると、一覧/成績取得も列不足で停止する。ローカルモードは自動的に新テーブルを利用できる。Core追加前のv0.2バックアップは原ハッシュを検証し、新テーブルを空として復元できる。

レース・馬・騎手・コース・出典・モデル版を既存の基礎データ取込で先に保存する。固定snapshotの `entries_state_json` には、取消馬も含む全馬について `entry_id`, `horse_id`, `jockey_id`, `horse_number`, `draw_number`, `carried_weight_kg`, `status` が必要。現在の出走馬と一致し、情報締切以前の出典時刻であること。snapshotのinput_hashは `snapshotContents` を `hash` で計算し、基礎データ取込で照合する。

## 入力

[架空のCore入力](examples/core-race-v1.json) は `example_only: true` なので確定不可。実運用の予想を表すJSONとして使用しない。

1R入力は `{ pipeline_id, generated_at, example_only?, prediction, numeric?, final_changes? }`。predictionは既存v0.2 JSONの1予想と同じだが、各 `horse_evaluations` に次の `components` を与える。AIからの `score`, `rank`, `abilities` はコード計算で置き換える。数値MCなしの確率はAIによる推定として扱う。

| 項目           | キー                | 重み |
| -------------- | ------------------- | ---- |
| 能力           | ability             | 25%  |
| コース         | course              | 15%  |
| 展開           | pace                | 15%  |
| 馬場           | going               | 15%  |
| 枠・斤量       | draw_weight         | 10%  |
| 馬×騎手×コース | horse_jockey_course | 20%  |

各値は有限な0〜100、小数2桁まで。小数を百分の一へ変換して整数で加重し、総合点は小数2桁に四捨五入。同点は馬番の小さい順。オッズは評価6項目に含めない。各馬のrationale/evidence_idsに評価根拠を記す。

`simulation.scenarios` はslow/middle/highを1件ずつ、重み合計1、各analysisと全有効馬の `lineup: [{entry_id, position, advantage}]` が必須。隊列/有利不利は仮説として記述する。

数値実行時は `simulation.mode: numeric` に加え、`numeric: {input, seed, trial_count}` を指定する。inputは既存MC入力。エンジン/モデル版、全有効馬/馬番、情報締切、3展開の重みを照合し、コードで実行した証跡だけ保存する。実行結果の勝率/複勝圏を評価へ反映する。買い目生成と資金配分は入力の推奨を検証する方式であり、自動最適化はしない。

## 操作と再開

Web「データを取り込む」で「Core：1Rの計算・参考プラン確定」を選びJSONを貼り付ける。APIは `POST /api/pipeline/race`。`POST /api/pipeline/preview` は総合点/順位/3展開を正規化し既存形式へ変換する読み取り操作（ロック/全業務検証の保証ではない）。

最大5Rは「Core：最大5Rを順番に確定」、APIは `POST /api/pipeline/batch` に `{races: [1R入力, ...]}` を送る。同Rの重複は禁止。各レースを完了してから次へ進み、個別失敗は他Rを巻き戻さない。空配列は正常なskipped。

進捗はSELECTED → DATA_READY → SIMULATED → VALIDATED → BET_LOCKED、見送りはSKIPPED。statusがcompleteのときだけ確定完了。各ステージの入力/出力ハッシュと時刻、試行数、operation/key・機密を除いた原因・retry可否を保存する。未確認出典・架空例・発走後・取消・Backtestは拒否する。

一時障害は同じJSONを再送（最大3試行）。完了済み同入力は重複せず、発走後の再読込/再送でも過去の完了を返す。異内容は409、恒久エラーは入力修正と新しいpipeline_id/prediction_id/各行IDで実行する。同Rに一時障害の再開待ちがあると別処理を拒否する。

保存先自体が使えず失敗台帳も書けない場合は、owner Durable Objectにサニタイズ済み診断とpending-journalを保持する。`GET /api/pipeline/diagnostics` で確認できる。journalは次の本人認証リクエストで再適用し、未完了journalを上書きしない。無期限に再送せず、接続/権限/競合を調べる。

## Finalと参考収支

既存の採用版を `supersedes_prediction_id` に指定し、新しいIDでFinalを作る。`final_changes: [{type, reason, evidence_id}]` にscratch/jockey/body_weight/going/track_bias/recent_form/conditionの実変更を記録する。対応する固定入力または特徴量IDが変更され、出典参照が必要。取消・騎手変更は `POST /api/races/{race_id}/refresh-entries` に `{operation_id, entries: 全出走馬行}` を送って現在情報を監査付きで更新し、別IDの新snapshotを基礎データ取込で保存する。馬・馬番・レースのID変更、発走後の更新、時点の巻戻しを拒否する。オッズ変動だけはFinal理由として受け付けない。Morningと本人購入履歴は変更しない。

参考採用版は1R1版。成績画面の「採用Morning / Finalの参考収支」が採用版だけの収支、「推奨買い目の参考収支」が旧仕様の全ロック版の参考値、「本人購入の成績」が手動確定購入。公式結果/払戻/返還/訂正は既存APIから取り込み、暫定結果は収支へ含めない。投資0円は回収率null。精度評価はCoreの参考採用を優先し、Core未採用レースは既存本人採用を使用する。

## 未実装・未確認

公式/許諾済みデータの自動取得、AIの自動呼出し・最大5R選定、本番Sheets疎通/保護、Notion非同期キュー、JST09:00のカットオーバーは未完了。旧ChatGPTタスクとCronを変更していない。これらを確定済み・移行済みとして案内しない。[判断と監査](adr/0001-race-core-pipeline.md) を参照。
