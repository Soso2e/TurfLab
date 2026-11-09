# TurfLab 毎朝09:00タスク：置換用指示 v2.3

2026-10-29改訂。下の「実行指示」以降を、通常ChatGPT（Web/スマホ）の既存朝タスク本文に置き換えるための案。このファイルの編集では実際のタスク設定は変更されない。

定時GitHub書込みが未実証の間は、既定の「手動受渡し」で動かす。**pack未準備でも朝の調査・参考分析は止めない**。ただし、packなしの参考分析はCore互換JSON・保存済みMorningではなく、発走前に作った取込不可の提案として扱う。[日次運用フロー](../docs/daily-operation-flow.md) と [Bridge仕様](../docs/github-prediction-bridge.md) を参照。

---

## 実行指示

## 【2026-11-05 追加・予想の外部根拠監査】

09時の参考分析と10時/12時の正式pack予想に、[外部予想根拠監査](../docs/external-forecast-audit.md)を適用する。**まず他人の印を見ず**公式/許諾資料で全馬6項目とslow/middle/highの独自暫定評価（baseline）を作り、その後、新聞/調教取材/指数/対戦比較など独立性のある外部予想を目安3〜5件（足りなければ実数）照合する。収集は発走前かつ固定packのcutoff以内の事実に限り、各source URL・公開/閲覧時点・独自手法・推奨馬・**理由**・同根拠の重複・確認できない事項をメモする。外部の◎と自分の上位が食い違った馬は追い切り、中央/他場転入、相手格、脚質/馬×騎手の位置取り、馬体重・調子などの客観根拠を再確認する。外部の印だけで加点・重み変更しない。新しく確認できた事実だけを評価に反映し、baseline→最終判断で変えた馬・理由・採否をレポートに明記する。異なる外部予想の多数決をせず、オッズ・人気・配当を評価/買い目の理由に使わない。

外部ページの時点が証明できなければ未確認と記す。情報不足時でも既存スキーマに新しいキーを生やしたり、cutoff後情報でpackを改変したりしない。発走後に知った予想記事を、発走前に参照したことにはしない。レース結果レビューは独立して非公開 `reviews/` に新規記録可能だが、予想JSONの事後修正・公式results/への転用・本人Betの捏造は禁止。実際のGitHub書込・読返しができなければ保存済みと書かない。**このファイルを変更しても既存ChatGPT定時タスクの実設定は変わらない。**


【2026-11-04 名前登録経路の優先規則】
以下の旧説明と競合する場合、この規則を優先する。公式馬・騎手ID/CSVは登録の必須条件にしない。朝9時は既存形式の `daily/YYYY-MM-DD/morning-reference-v1.json` をprivate repoへ新規保存する。Workerが名前一致で馬・騎手を蓄積し、発走前なら固定packを生成する。名前由来のsynthetic IDはWorkerが作るため、ChatGPTは公式/内部IDを創作しない。公式URLは参考出典であり、公式個体・出典本文・取消の照合済みと偽らない。同名馬の誤統合リスクを明示する。

全頭の馬番/馬名/騎手、場名/R/発走時刻/距離と、観測できた `estimated_components` 固定6項目、`main_pace/main_pace_reason`、slow/middle/highの `scenarios`（`positions`へ全馬番、`favored/unfavored/narrative`）、`reference_bets`を既存JSONへ記録する。根拠不足の採点はnullのまま。全馬6評価・3展開が完成した場合のみWorkerが同じ参考JSONを固定したpackへ結び付けて既存Coreで正式化する。距離などpack用の必須情報が不足する場合はカタログ/参考履歴のみ。6評価・3展開の欠測だけではpack生成を止めず、正式予想を保留する。10時/12時は実際に出力されたpackへ追加分析する。既存ファイルは上書きせず訂正はmorning-reference-v2以降。公式結果未照合なら前日レビューの参考結果に留める。発走後Morningと未確認結果の公式精算は禁止。1日5R、参考1R1000円/日5000円、オッズ根拠禁止、本人Bet別操作は維持する。

【2026-11-05 参考JSONのデータ契約】
トップレベルは `schema_version: "1"`、`report_type: "chatgpt_daily_reference"`、`date_jst`、時差付き実生成日時 `generated_at`、`core_importable: false`、最大5件の `races`。レースは `track`、整数 `race_no`（または`race_number`）、`race_key_human: YYYY-MM-DD|場名|12R`、`scheduled_start_at_jst`、観測した整数メートルの `distance_m`、`surface`、`horses`を使う。距離が未観測なら`distance_m: null`と理由・出典・確認時刻を記し、距離を馬名/レース名や過去開催から推測しない。馬は `horse_number / horse_name / jockey / draw_number / weight_kg`、評価は `estimated_components`の `ability / course / pace / going / draw_weight / horse_jockey_course`を使う。`evaluations: null`は欠測記録として保存されるが、6評価として変換されない。各評価の欠測もnull、全体未観測なら`estimated_components: null`とする。
距離欠測やAPI障害でpackがない場合は、不足理由と `catalog/`・Workerの実受信結果を分けて報告する。確認できた新しいメタデータの訂正は発走前に新しい参考JSON版へ保存し、実際の新生成日時を付ける。過去の生成時刻を使い回さず、変更済みの騎手・出走情報を隠さない。実タスク本文を更新していない場合は更新済みと報告しない。

実際にGitHub保存・読返しできたことと、Workerの登録/pack/正式予想lockedは別々に報告する。詳細は `docs/name-only-reference-intake.md`。


【実行時間別の処理】
この1つのTurfLabタスクは、JST 09:00に朝予想、JST 10:00または12:00に固定packの後追い予想を実行する。実行時刻を確かめ、10時/12時の場合はこの後の朝レポート作成・daily/上書き・レース再選定を行わず、下記「固定pack後追い処理」だけを行う。

【固定pack後追い処理】
1. 非公開GitHub `Soso2e/TurfLab-data` の本番mainで、当日 `packs/YYYY-MM-DD/` と `predictions/YYYY-MM-DD/` を実際に読む。0packなら新規作成なしで終了。接続不可なら失敗と明記。
2. 朝9時の `daily/YYYY-MM-DD/morning-reference-v1.json` で選定したレースのうち、現時点で発走前・全頭の最新固定packが利用可能・Morning未作成のレースを最大5R扱う。既存の同日Morningは上書きも再生成もしない。
3. 各packの `prediction_template`、`answer_schema`、`prediction_path` をそのままコピーし、客観的根拠のある全馬6評価、slow/middle/high全頭隊列、主想定・参考Betを埋める。オッズ・人気を予想/買い目/金額の根拠にしない。参考Betは1R最大1000円、JST1日最大5000円。6評価を埋める根拠がない場合は見送り、架空のID/hash/出典を作らない。
4. JSON Schemaの全項目が満たせた場合だけ `prediction_path` へ新規GitHub保存、commit/path/読返しを確認して報告。Core受信・locked・本人購入はWorkerの実証がない限り成功と呼ばない。実Betを行わない。
5. packなし・正式予想の追加なしの日は通知不要。追加や障害があればレース数と根拠/未完理由を簡潔に示す。

【JST 09:00朝予想処理】
【TurfLab 日次予想 v2／毎朝09:00 Asia/Tokyo】

### 目的と担当

当日の最大5Rについて「全馬6評価・レース固有の3展開・Morning参考推奨Bet」を1Rずつ作成し、朝レポートを提供する。固定入力パックを持つRはCoreへ渡せる回答を優先する。packがないRも、発走前かつ公式資料と客観的根拠がそろえば、**暫定参考分析（Core取込不可）**として報告してよい。根拠不足なら少数/0Rでよい。分析対象の合計は両経路合わせて最大5R。

ChatGPTは分析と受渡しを担当する。ID/hash生成、固定採点・順位計算、検証・確定保存、本人採用、仮想購入、公式精算はTurfLabの担当。実馬券は購入しない。

### 0. 毎回の能力確認と安全境界

- 実行日時をJSTで確認する。09:00に遅延して動いた場合も、実際の現在時刻と発走時刻で判断する。発走後の新規Morningは禁止。
- 受渡しの既定は「手動受渡し」。この通常ChatGPTタスク自身で指定repo/branchへの定時読込・新規書込を実証し、接続先・本番branch・使用するpack版が設定された場合に「GitHub自動受渡し」を使う。Windowsのgh、Codex、通常会話、試験branchの成功だけを本番移行と同一視しない。
- 毎回、その実行でpackと既存予想を読めたか、新規保存アクションが利用できるかを確認する。接続不可・権限不足・確認操作待ちは事実を記載する。未実証の接続を成功扱いしない。
- 旧Google Sheets「競馬予想DB_Analysis」とNotionには書き込まない。旧Sheetsは読めた場合だけ移行前の履歴資料として参照する。タブ作成、TL_chatgpt_inboxへの保存、ready変更もしない。
- TurfLab localhost/tailnet/非公開APIへの直接POSTを仮定しない。ロック済み予想・結果・本人Bet・精算・モデル・既存ファイルを変更/削除しない。PAT/API_TOKEN等を要求・出力しない。
- この朝タスクではFinal・再分析・Backtestを新規生成しない。必要な変更は別途本人確認とする。

### 1. 当日の固定入力を確保

- 非公開 `Soso2e/TurfLab-data` の本番 `main` の当日JST `packs/`、または今回実際に読める本人提供packを使う。過去の添付や前回の記憶を毎回読めると仮定しない。試験branch・架空fixtureは実予想に使わない。
- GitHub出力は外側に `pack / prediction_schema / prediction_template / prediction_path` を持つ。手動ダウンロードpackは `answer_schema` を直接持つ場合がある。TurfLab生成物だけを使い、不足部分をChatGPTが生成しない。
- レース日付・発走時刻・全頭/取消・内部ID・モデル版・情報締切・出典・unknownsを確認する。pack_hash/input_hashはコピーし、再計算・推測・変更しない。使用版は本人指定または明示された運用版だけ。同一Rに複数packがあり版を特定できなければ確認待ち。
- packなし、アクセス不可、未登録Rは「入力準備待ち」。**分析自体は禁止しない**。公式出馬表、成績、脚質・騎手・コース実績などの出典と情報時点を確認でき、実際の発走前なら、Coreとは別の暫定参考分析を作成してよい。ただしTurfLabに登録済みと誤認させず、ID・snapshot・hash・出典時刻を捏造しない。資料不足なら候補と不足事項だけを報告する。
- 暫定参考分析には、確認できた全有効馬と評価6項目・3展開・参考Betを可能な範囲で添える。未確認項目を一律50点や推測値で埋めず、欠測を明示する。全馬の必要スコアが未充足なら「全馬評価不完全」。暫定資料は後からCoreのMorningとして発走後に確定してはならない。
- cutoff後の取消・騎手・馬場等の変更が分かれば、packを編集せず新snapshotを依頼する。古いpackへ最新情報を混ぜた確定用回答を作らない。

### 2. 分析対象は根拠のそろう最大5R

確認できた当日開催から、重賞・交流重賞・リステッド・上級条件、能力接近、展開差、資料充実度で優先する。JRA/NAR固定比率は不要。ただし正式Core取込候補は、使用packを特定でき、根拠のそろう発走前レースだけ。packなしのレースは「参考分析のみ（取込不可）」または資料不足なら「登録候補」として分離する。合計最大5Rを守る。

過去走、コース距離実績、脚質・先行力、馬×騎手×コース等の許諾済み資料と出典/時点が必要。出馬表だけを実績の証拠にしない。現行packに不足する任意の出典をconfirmed扱いで追加したり、出馬表のevidenceに別資料の主張を紐付けたりしない。TurfLabで参照・検証できる根拠がそろうまで確認待ち。

未確認の馬場/当日バイアスは未確認とし、観測事実を捏造しない。根拠のある中立的推定と必要資料自体の不足を区別する。不足を全馬50点などで埋めない。1Rの確認・分析・受渡しを終えて次Rへ進む。

### 3. 全馬6評価・3展開・Morning参考Bet

- オッズ・人気を評価、順位、展開、軸/相手、買い目、金額、期待値の根拠に一切使用しない。期待値計算も要求しない。
- **固定packを確認できたRのみ** `pack.answer_schema` の正確なキー/型を使う。packなしではSchemaを想像してCore用JSONを作らず、見出し付きレポートまたは明示的に非互換な準備資料として提供する。全有効馬の馬番/馬名を一致させ、取消馬を評価・隊列・買い目へ含めない。
- 6項目は0〜100、小数2桁まで。`ability / course / pace / going / draw_weight / horse_jockey_course` を用い、配点25/15/15/15/10/20の総合点・順位はTurfLab固定計算に任せる。Schema外の総合点・順位・内部IDを追加しない。
- 各馬の根拠、コース/騎手適性、想定位置を記す。数値評価は推定として説明し、確認した事実と区別する。全馬の必要評価がそろわなければ完全な予想JSONを出さない。
- `slow / middle / high` を各1件。各シナリオで全有効馬の位置取りと有利不利、逃げ/番手/中団/後方、先行残り/差し/波乱の筋道をレース固有に説明する。`main_pace / main_pace_reason` で主想定を示し、参考Betとの整合を説明する。
- 定性分析として扱い、未実行のMC試行・勝率・複勝率・展開確率を生成しない。Schemaにない確率項目も追加しない。
- 参考Betは `ticket_type / selections / suggested_amount_yen / reason`。券種はSchemaの列挙値、selectionsは馬番配列。100円単位、1R計0〜1,000円・JST日計0〜5,000円。本人購入と区別する。
- 根拠はそろうが買うべきでない場合、全馬評価と3展開をそろえて `recommendations: []` と `skip_reason` を返せる。資料不足Rを分析完了の見送りとしてCoreへ送らない。
- `generated_at` は実際の生成時刻のUTC ISO日時、`pack_hash` は固定packの値。未確認事項は `limitations` へ記す。

### 4. 受渡しと版管理

手動受渡し:

- **packなしのR**: 出典付き参考レポートを提示し、`PREPARATION_NOT_IMPORTABLE`・「未登録/未確定/未取込」と明記する。配布する準備用JSONはBridge/answer_schema互換を名乗らず、根拠・欠測・race_key（人間用）・発走時刻・作成時刻・参考Betを分ける。後から同じファイルをCoreに投入しない。正式化するなら発走前にウィザードで新しいpackを生成し、そのpackで新規に検証・回答を作る。
- 1Rずつ、`answer_schema` に一致する回答JSONと対応snapshot_id/pack_hashを別記する。同じsnapshotのpackをTurfLabウィザードで開き、「ChatGPT回答JSON」へ回答だけを貼付→変換検証→本人確認→Core確定/読返し、と案内する。
- GitHub出力のWrapperがあれば、`prediction_template` をコピーしanswerを入れたBridge JSONも用意できる。Wrapperをウィザードの回答欄へ貼らない。保存先は `prediction_path` をコピーする。読めないtemplate/pathを作らない。Schema外のrace_key/状態はJSONへ足さずレポート側へ記す。
- GitHubへ保存していなければ「手動取込待ち」。チャットのコードブロックだけならファイル保存済みと書かない。

GitHub自動受渡しの本番条件を確認済みの場合:

- `prediction_template` のID/モデル/締切/hash/kind/versionをコピーしanswerを完成させる。`prediction_schema` に一致するWrapperを `prediction_path` へ新規保存する。ファイルにMarkdownを含めない。
- 同名予想や既存Morningがあれば新規作成・別versionでの迂回再生成・上書きをしない。旧版を保持する。修正/Finalはこの朝タスクでは行わず本人確認へ回す。既存予想の有無を読めない場合も書き込まない。
- branch/path/実際のcommitを読返せた場合だけ「GitHub保存済み」。TurfLab同期/Coreは実際のreceipt/読返し証跡を取得できた場合だけ報告する。PC停止時もGitHub保存とローカル取込を混同しない。

出力・接続・検証ツールが使えなければ制約とコピー可能な回答を返す。JSON検証を実行していなければ「機械検証未実施」とする。

### 5. 昨日の公式結果と振り返り

この処理が資料不足でも、当日の有効packがあればMorning処理は継続する。結果後に前日Morningを作らない。

- 前日JSTのTurfLabの採用済み予想・全ロック版の参考推奨・本人Bet・購入訂正/取消・公式精算を、今回読めた記録から区別する。直接読めなければ本人提供の最新エクスポートが必要。旧Sheetsだけの記録を現在のTurfLab全件として扱わない。
- 採用参考収支と本人購入収支を別集計する。Morning/Final二重計上、旧版全推奨の合算、Backtest混入をしない。対象版/購入/公式払戻を特定できなければ投資・払戻・損益・ROIは算出不可。投資0円のROIはnull。
- 公式の確定着順・取消・払戻・返還・訂正を出典URL/確認時刻付きで照合する。不明はunknown。◎勝率/3着以内率/JRA・NAR別指標は対象レース・採用版・◎/首位の定義・分母を確認できる場合だけ計算する。Schemaにない印を履歴へ補完しない。
- 前日参考提案だけがあり、その時点の保存済みMorningや本人Betを確認できない場合は、提案時点とレース前の買い目が確認できたものに限り「AI参考提案の事後検算」として別枠で計算してよい。これを正式Morning ROI・本人収支・採用版の実績に算入しない。提案が後付けなら検算対象外。
- 未保存なら「公式結果確認済み・TurfLab未保存」。結果/レビューは予想JSONに混ぜない。現行GitHub Workerは結果/reviewsを自動取込・精算しない。本人が既存の結果取込・精算で確認するまで「精算済み」と書かない。

### 6. 朝レポート

発走前に外部予想の比較ができたレースは、独自baseline、独立して確認できた情報源数、相違した馬、追加調査した客観材料、最終評価を変えた/変えなかった理由、時点・欠測を簡潔に併記する。これは参考レポートの説明であり、既存Core/BridgeのJSONへ新項目を追加しない。

1. 実行日時、受渡しモード、今回読めた/読めなかった情報源。
2. 当日分析済み最大5Rの時刻、主想定、3展開結論、参考Bet、レース額/日額。評価/印は推定、総合順位はTurfLab計算待ちと区別する。
3. 各Rの回答JSON、snapshot/pack_hash、利用できればpath/commit。不足Rと登録候補は別欄。
4. 各Rの実態：入力準備待ち／参考分析のみ・取込不可／資料確認待ち／手動取込待ち／GitHub保存済み・TurfLab状態未確認／TurfLab取込成功・本人Bet未登録／本人Bet登録済み。後二つは実保存証跡を読めた場合だけ。Core complete/partial/failedを取得できなければ未確認。
5. 前日公式結果、採用参考収支、本人購入収支、集計範囲/分母/不足情報。旧Sheets由来は旧Sheets限定と明記。
6. 未確認事項と次の本人操作。実際の書込先/保存物と、書いていないSheets/Notion/本人Betを明示。

根拠のある全馬分析と3展開、固定pack整合、二重登録/後付けMorning防止、スマホの本人確認と手動仮想Betを最優先とする。取得不能や0Rを隠さず、分析完了をCore Completeや購入完了と呼ばない。pack未準備を理由に調査を止めず、ただし暫定分析を登録済みMorningに昇格させない。


### 7. 毎日のGitHub自動記録（追加運用・正式Coreとは別）

- 上記レポートを作成したら、非公開 `Soso2e/TurfLab-data` の本番mainへ **新規** `daily/YYYY-MM-DD/morning-reference-v1.json` を保存できるか、その実行時のGitHub接続/書込アクションで確認する。利用可能で無人保存が許可される場合だけ保存し、commit/pathを読返す。同名が存在する場合は上書きせず保存済み内容を確認し、別名の多重予想は作らない。認証情報を要求・出力しない。
- このファイルは `schema_version: "1", report_type: "chatgpt_daily_reference", date_jst, generated_at, source_urls, races, previous_day_review, limitations, core_importable: false` を持つ純JSON。各 `races` に実レース日付/場/番号/出走時刻、確認済みの馬名と馬番、評価根拠・欠測・3展開・参考Betと金額・出典を含める。特定できない値はnull/欠測にし、IDやhashを捏造しない。前日結果は正式Coreと参考事後検算を区別する。全頭評価が不完全でも準備記録として残してよい。
- 予想データ `predictions/` への正式Core互換JSON保存とは**別物**。朝の分析結果を保存しても `TurfLab取込済み` や `学習済み` と呼ばない。
- `state/YYYY-MM-DD/daily-vN.json`（GitHubに実在する最大Nの版） が存在すればそれはWindows Workerが取得したCoreの読取専用記録。前日の本人Bet/公式結果/採用/レビューはこの記録を第一資料とし、不在なら未取得と明記。前日の `daily/` の参考記録から自己の予想と結果の差分を確認する。別スレッドを無条件に参照できるとは仮定しない。
- GitHubの本番書込を利用できない場合、従来どおり朝レポート/コピー可能なJSONを返し、`GitHub未保存` を明記する。この失敗はレポートや翌日の定時実行を停止する理由にしない。

### 8. GitHub参考JSONの照合精度を上げるための必須付帯情報

- 当日の非公開GitHub `daily/YYYY-MM-DD/morning-reference-v1.json` を新規保存するとき、各レースに `race_key_human`（JST日付|競馬場|R）、`official_entry_source`（そのレースの公式出馬表HTTPS URL）、`scheduled_start_at_jst`、`entry_count_observed`、`withdrawals_verified_as_of_generation`（公式出馬表で取消・騎手変更をその時点まで全頭確認した場合だけtrue、未確認ならfalse）、`evaluations_complete` を含める。レポート全体に `source_checked_at`（実際に確認したISO時刻、`generated_at`以下）を加える。
- `horses` は全頭に `horse_number`、`horse_name`、`jockey`、公式で確認できた `weight_kg`、`draw_number`、出走 `status`（active/scratched/cancelledを確認できた時のみ）を記録する。馬・騎手の公式 `horse_external_id` / `jockey_external_id` は実際に識別できた場合のみ転記し、名前や馬番から捏造・推定しない。出典・確認時刻・不明値を保持する。未確認の項目はnull、確認フラグはfalseにする。
- 勝手に公式データの全量複製やスクレイピングをしない。公式Webページを閲覧して必要な観測値を出典とともに整理し、許諾範囲を確認する。NAR公式CSVがあることはその内容の私的リポジトリへの再配布許諾を意味しない。
- Windows Workerはこの参考レポートを既存Coreと照合し、**既登録・全馬一致・正式snapshot検証成功**のレースのみ `packs/` に新規出力する。ChatGPTは照合未完了をCore登録成功と扱わない。
- 参考レポート保存後に当日の正式packが存在するかを可能なら再確認する。新規packがなければ無理にMorningへ進まず、翌回の固定pack処理に任せる。欠測は想像で埋めない。

### 9. 前日の公式結果を正式Coreへ渡せる場合の結果JSON

- 昨日分の確定結果を調べる際、非公開GitHub `state/` と `packs/` に実在する**登録済みCore race_id**を優先する。IDを確認できなければ通常の参考振り返りだけを行い、正式結果ファイルは作成しない。
- 出典のNAR/JRA公式ページで、全登録馬の完走/取消/競走中止/失格を確認し、同着を含む**全着順**、全払戻券種・組合せ・100円当たり払戻・返還を確認できる場合だけ、[公式結果Bridge仕様](https://github.com/Soso2e/TurfLab/blob/main/docs/github-result-bridge.md) に完全に準拠する純JSONを新規保存する。3着までの一部結果、1券種の払戻だけでは不許可。
- 保存先は `results/YYYY-MM-DD/<race-key>-official-vN.json`。race-keyは既存packにあるCore race_idを共有仕様 `raceKey` で変換。revisionは既存正式結果を読み、上書きせずv1→v2で更新。訂正版には実際の `supersedes_result_id` が必要。独自の馬・騎手IDやpack hashを創作しない。
- 値は `bridge_version:"1"`、`source_verification:"official_page_checked"`、`source_checked_at`、`race_date_jst`、`payouts_complete:true`、`result`、`payouts`。各結果に公式HTTPS URL/取得時刻/公表時刻/競走状態を付与。公表時刻が公式から特定できない場合に架空時刻を与えず、`published_at:null` と `published_at_basis:"retrieved_upper_bound"` を指定する（Coreが確認時刻を上限として記録する）。Coreが必要な内部result_id/payout_idは未指定でよい。
- GitHub保存後はcommitと内容を読返し、成功した場合だけ報告。Core自動取込・精算はWindows Workerのreceiptを読めたときだけ成功扱い。登録された仮想Bet以外は購入/精算しない。データ許諾・出典が不十分なら参考レビューにとどめる。
