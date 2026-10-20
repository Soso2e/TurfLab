# ChatGPT JSON受け渡し仕様 v0.2

既存インポーターとJSON Schemaは実装済み。この文書と[サンプル](examples/chatgpt-import-v0.2.json)は入力契約を示します。レース・出走馬・モデル・入力スナップショットを先に登録してください。全馬6項目の固定スコア・3展開・参考プラン確定は [1R Core](core-pipeline.md)、Windowsでの手動受渡しは [クイックスタート](windows-tailscale-quickstart.md) を参照してください。実データ1RとSheets本番受入は別です。

## 受け渡し

本人がポータルから固定済み入力と必要なJSON形式をコピー → ChatGPTで分析 → JSONを貼付/ファイル指定 → 検証・プレビュー → 本人が保存 → 読み返し確認。初期版では会話画面からの自動同期や自動購入を前提にしません。

再分析プロンプトにはレース、コース版、全出走馬、締切以前の戦績・特徴量・馬場・オッズ、出典、不足情報、モデル版を含めます。回答では事実と推定、観測と仮説を分け、未確認を補完しないよう指定します。プロンプト版とハッシュも記録します。

## 必須構造

| フィールド                                               | 型・意味                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| schema_version                                           | 固定文字列 `0.2`                                                     |
| import_id                                                | 本取り込みの安定ID。同じ内容の再送で変更しない                       |
| generated_at                                             | ISO 8601日時                                                         |
| predictions                                              | レース単位の予想配列                                                 |
| prediction_id / race_id / model_version_id / snapshot_id | 登録済みデータへのID参照（予想IDは新規）                             |
| kind / information_cutoff_at                             | morning/final/reanalysis/backtestと情報締切                          |
| evidence                                                 | ID付き出典一覧。URL・情報基準/公開/取得時刻、fact/estimateを保持     |
| horse_evaluations                                        | 全有効出走馬の評価。entry_id、確率、根拠ID、推定能力・適性・位置取り |
| simulation                                               | mode、シナリオ重み、根拠、実行証跡                                   |
| recommendations                                          | 券種・馬番配列・推奨額・根拠。0件と見送り理由も可                    |

サンプルは説明用に2頭のみの架空レースです。example.invalidは実出典ではなく、実データとして採用しません。生成JSONに virtual_bets や settlements を含めることは禁止します。

## 検証順と保存

1. 本人認証、入力サイズ、JSON構文、対応schema_version、必須型・未知の書き込み領域を検証。
2. レース・モデル・スナップショット・entry IDの存在と同一レースへの参照を検証。発走済みの新規morning/final確定は拒否。
3. 締切と出典の利用可能/取得時刻、特徴量のcutoff、snapshotの固定入力を照合。未確認出典は確認待ちとして確定不可。
4. 全有効出走馬の評価、0〜1の有限確率、勝率合計約1、シナリオ重み合計約1を検証。許容誤差は実装契約で固定。複勝圏確率は各馬の勝率以上、合計はmin(3,頭数)を基本とする。
5. 買い目の馬番・券種・並び順・重複を検証。順不同券はソートし、着順付き券は順序保持。推奨額は0以上の100円単位でレース合計1,000円以内。日合計5,000円は本人購入時に別検証。
6. `narrative`はseed/試行数/engine_versionをnullにする。`numeric`はサーバーの実行台帳・ハッシュと照合し、ChatGPTの自己申告だけでは数値実行済みにしない。
7. import_idと正規化payload_hashを照合。同ID・同内容は既存結果を返す。同ID・異内容は競合。予想→評価→シミュレーション→推奨をチェックポイント付きで保存。
8. 期待件数・参照・ハッシュを読み返し、一致した操作だけcompleteとする。予想確定は別操作でlockedにする。

エラーは配列位置と項目名で提示し、時点違反・参照不足・確率不整合を黙って修正しません。1バッチ内のレースは独立して検証・復旧し、日次画面で成功・失敗件数を明示します。

## 実装API（`/api`配下）

`GET /races?date=`、`GET /races/:id`、`POST /imports/validate`、`POST /imports`、`GET /imports/:id`、`POST /predictions/:id/lock`、`POST /races/:id/reanalysis-prompt`。仮想購入・結果・精算・数値計算も既存APIを利用します。すべてのAPIは本人認証を要求し、ブラウザからSheetsへ直接書きません。
