# 既存の毎朝9時タスクへ追記する場合の入力契約

このファイルはプロンプト案です。既存の予定は変更していません。AI APIは使いません。

## TurfLab localでの1R手動受渡し（優先）

TurfLabの「公式出馬表 → ChatGPT → 1R確定」で本人が確認済みのAI入力パックを渡します。パックがなければPREPARATION_NOT_IMPORTABLEの旧JSONをMorning確定用として出さず、公式出馬表の登録とパックを依頼してください。ID・ハッシュ・発走時刻・出典・過去走を推測で生成しないでください。

パック内の`answer_schema`だけに従って1R分のJSONを返してください。`pack_hash`はそのままコピーし、`generated_at`は回答生成時刻のUTC ISO日時です。全有効馬の馬番/馬名を一致させ、取消馬を採点や買い目へ入れないでください。全馬6採点は0〜100・小数2桁まで。能力25/コース15/展開15/馬場15/枠斤量10/馬×騎手×コース20の総合点・順位はTurfLabが計算するため出力しません。オッズを採点へ含めません。

スロー/平均/ハイの各展開で全有効馬の位置取り・有利不利と展開根拠を返し、`main_pace/main_pace_reason`で主想定を明示してください。定性的分析の勝率/複勝率/展開確率/MC試行を作らず、Schemaにない確率フィールドは返しません。未確認はlimitationsに記載し、過去走等の事実が必要なら公式・許諾資料の追加を依頼します。出馬表だけを過去走や能力の事実の根拠にしないでください。

参考Betはticket_type（win/place/quinella/wide/exacta/trio/trifecta）、馬番配列selections、100円単位のsuggested_amount_yen、reasonを返し、1R計1,000円まで。見送りは空配列とskip_reason。本人の購入とは区別し、購入・Sheets・Notionへの書込みは行いません。発走後の旧回答をMorningへ遡及確定しません。

以下は既存JSONを直接扱う場合の従来契約です。localウィザードの回答では上記answer_schemaを優先します。

前日の結果確認・解析と当日の原則5レースの予想を行ってください。開催なし・十分な情報なしの場合は少なくて構いません。仮想購入は本人の判断なので、推奨を購入済みとして保存しないでください。

- 事実・推定・欠測を分け、公式出典URL、情報基準時刻、利用可能時刻、取得時刻をUTCで記録する。取得していない値・確率・全着順・払戻を補完しない。
- 固定入力に登録済みのrace_id / entry_id / course_id / snapshot_id / model_version_idを使う。名前だけでIDを新規統合しない。新しい予想には新prediction_id・simulation_idを使う。
- 全有効出走馬を評価する。数値が実際に算出されている場合だけ勝率合計1、複勝圏確率合計min(3,頭数)、展開重み合計1を確認する。narrativeで未算出なら全馬の勝率・複勝率と推奨確率・展開重みはnullとし、架空補完しない。
- 全レースの文章による展開分析をnarrativeで記録する。engine_version / seed / trial_countはnull。ChatGPTが数値試行を実行したと自己申告しない。
- 本人確認がない出典にはconfirmed:trueを付けない。本人の確認待ちの出力も保存前検証できるが、予想確定はできない。
- 前日結果は公式確定後に全着順・取消・返還・同着・全券種の払戻を別の結果JSONへ記録する。payouts_completeは実際に全件確認したときのみtrue。
- レビューはobservations_json / hypotheses_json / unknowns_json / validation_plan_jsonへ分ける。予想・購入収支を別に参照する。原因仮説を観測事実へ昇格させない。
- 既存Sheetsの元タブへ保存する現行運用は維持できる。新形式へ移行するときはTL_chatgpt_inboxへ operation_id / kind / payload_json / ready=false で保存し、本人が確認してready=trueへ変更する。
- virtual_bets / settlementsは出力・直接書き込みしない。JSON Schemaにある領域だけ返す。同じ内容の再送ではimport_id/operation_idを維持する。
