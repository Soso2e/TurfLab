# ChatGPT JSON受け渡し仕様 v0.2

非公開GitHubを使う固定パック出力・予想受信は [GitHub Prediction Bridge](github-prediction-bridge.md) を参照。既存answer_schemaの外側にID・版・入力hashを含むWrapperを付け、既存変換/Coreを使用する。受信による本人Betの自動生成はしない。

## 公式出馬表ウィザード（Issue #36）

local運用は「データを取り込む」先頭のウィザードを使用する。内部IDやハッシュをChatGPTに作らせない。

1. 公式または利用許諾済みの出馬表を手動でJSONへ入力する。画面の空テンプレートを使い、`source/source_url/permission`（`official` または `licensed`、後者は `permission_note`）、`valid_as_of/available_at/retrieved_at/information_cutoff_at`を実際の値で埋める。日時はタイムゾーン付きISO形式。出馬表の日時はサーバーでUTCへ正規化する。
2. `track`は`external_id/name/jurisdiction`（JRA/NAR）、`course`は`external_id/surface/distance_m/direction/layout`、`race`は`external_id/race_date_jst/race_number/name/scheduled_start_at`、`model`は本人が使用する`model_identifier/prompt_version`。コース外部IDは距離・内外回り等の版を一意に特定する値を使う。
3. `entries`は取消馬も含む全頭。各行に`horse_external_id/horse_name/jockey_external_id/jockey_name/horse_number/draw_number/carried_weight_kg/status`（active/scratched/cancelled）が必要。馬・騎手の安定した公式外部IDが不明ならdraftで止める。馬名だけでは統合しない。CSVファイルはこの8列でentriesだけを置換し、出典等はJSON側に残す。draftはダウンロードして再開できる。
4. `weather/going`の未確認はnull。過去走や馬場バイアスを架空補完しない。表示された全頭・取消・出典・時点を本人が照合し、チェック後に基礎データとsnapshotを確定する。手動確認を記録する方式であり、URLのネットワーク上の実在や公式の利用条件を自動判定する機能はない。自動スクレイピングは行わない。
5. 入力パックをコピー/ダウンロードしてChatGPTへ渡す。パックは登録済みID、固定全出走馬、入力ハッシュ、モデル版、情報締切、出典/時刻、未確認情報、6配点、`answer_schema`を含む。レース詳細の「このsnapshotで入力パック」、または保存したsnapshot IDから再開できる。
6. ChatGPTは`pack_hash/generated_at/rationale/main_pace/main_pace_reason/horse_evaluations/scenarios/recommendations/limitations`を返す。`generated_at`はUTCのISO日時。馬は馬番と馬名で指定する。各評価は`components`の6項目（ability/course/pace/going/draw_weight/horse_jockey_course）、コース適性、騎手適性、位置、根拠が必要。各スロー/平均/ハイに全有効馬の位置と有利不利を含める。JSONの正確なキーはパック内Schemaを参照する。見送りは空のrecommendationsとskip_reasonを返す。
7. 変換プレビューで総合点・順位・全馬・3展開・主想定根拠・参考額を確認し、チェック後に1RずつCore確定・実読返しする。本人の仮想Betは別操作。レース詳細で「当日の採用版として固定」後、券種・馬番・100円単位の金額を本人が登録する。

6採点の配点は能力25・コース15・展開15・馬場15・枠斤量10・馬×騎手×コース20。総合点は既存Coreが計算し、オッズは含めない。参考Betと本人Betの予算はそれぞれ既存Core/購入の検証を使用し、1R1,000円/JST日5,000円以内とする。

この橋渡しはnarrative専用で、勝率・複勝圏確率・推奨的中確率・展開重み・MC実行証跡はnull。確率集計は欠測として除外する。既存の数値入力は数値検証を維持し、nullを0へ変換しない。旧方式のnarrativeに明示済み数値がある場合は既存互換を維持する。UIの「—」は未算出であり、確率が0という意味ではない。

### API・競合・再開

出馬表JSONの`declared_entry_count`は、公式に掲載された取消を含む全登録頭数。entries行数と一致しなければdraftで止める。公式側との最終照合は本人が行う。

- `POST /api/race-import/preview`: `{operation_id, draft}`。ready + preview_hash、またはdraft + 日本語エラー。保存しない。
- `POST /api/race-import/confirm`: 同じ入力に`preview_hash, confirmed:true`を追加。既存ingestMaster/refreshEntries、DO直列化・永続ジャーナルと実ストレージ読返しを使う。snapshotには取消も固定し、既存snapshotContents/hashでinput_hashを生成する。
- `POST /api/race-import/pack`: `{snapshot_id}`。現行出走情報・snapshotハッシュを照合する。
- `POST /api/race-import/convert`: `{snapshot_id, operation_id, answer}`。ready + 正規Core JSON + 既存`/pipeline/race`用入力を返す。保存しない。
- Core確定は既存`POST /api/pipeline/race`。同じ入力/操作IDは再送でき、異内容は409。一時障害は同一入力で3回まで段階再開。恒久エラーを修正したら画面の「修正回答を新しい操作として開始」を押す。画面更新前に入力パック・回答・draftを保存しておく。ページ再読込後も同一Core操作で再送したい場合は、変換結果のpipeline JSONを保存し既存Core入力欄から再送する（画面の操作IDはメモリ内）。

新規Morning確定はサーバーの現在時刻で発走前に限定する。2026-10-20/21等の旧準備JSONを遡ってMorning化しない。過去日のデータは既存Backtest専用。固定済みMorningの採点・買い目・locked_atは変更しない。出走更新でパックが古くなれば、新snapshotと新しい回答が必要。既存レースの外部ID/内部IDの対応が曖昧な場合は重複を拒否し、手動照合が必要。

ウィザードAPIはSheetsモードでは拒否する。既存Sheets/Notion、ChatGPT実スケジュール、Sheets受信タブは変更しない。実データ1R、iPhone実機、Sheets自動受信の受入はそれぞれ別。

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
4. 全有効出走馬を評価する。算出済み数値は0〜1の有限確率、勝率合計約1、シナリオ重み合計約1を検証。複勝圏確率は勝率以上、合計min(3,頭数)。narrativeの未算出は全馬の勝率・複勝率をnull、展開重みも全てnullにできる。混在は拒否する。
5. 買い目の馬番・券種・並び順・重複を検証。順不同券はソートし、着順付き券は順序保持。推奨額は0以上の100円単位でレース合計1,000円以内。日合計5,000円は本人購入時に別検証。
6. `narrative`はseed/試行数/engine_versionをnullにする。`numeric`はサーバーの実行台帳・ハッシュと照合し、ChatGPTの自己申告だけでは数値実行済みにしない。
7. import_idと正規化payload_hashを照合。同ID・同内容は既存結果を返す。同ID・異内容は競合。予想→評価→シミュレーション→推奨をチェックポイント付きで保存。
8. 期待件数・参照・ハッシュを読み返し、一致した操作だけcompleteとする。予想確定は別操作でlockedにする。

エラーは配列位置と項目名で提示し、時点違反・参照不足・確率不整合を黙って修正しません。1バッチ内のレースは独立して検証・復旧し、日次画面で成功・失敗件数を明示します。

## 実装API（`/api`配下）

`GET /races?date=`、`GET /races/:id`、`POST /imports/validate`、`POST /imports`、`GET /imports/:id`、`POST /predictions/:id/lock`、`POST /races/:id/reanalysis-prompt`。仮想購入・結果・精算・数値計算も既存APIを利用します。すべてのAPIは本人認証を要求し、ブラウザからSheetsへ直接書きません。
