# ChatGPT用・1R Core出力

公式/許諾済み出典を確認した固定snapshotと情報締切を使用し、1レースだけ分析してください。欠測を捏造せず、不足時は推奨なし＋skip_reasonで見送ってください。能力評価にオッズを入れないでください。

返却形式はdocs/core-pipeline.mdとdocs/examples/core-race-v1.jsonを参照してください。サンプルの架空出典・ID・時刻を実データとして流用しないでください。

全有効馬のcomponents（ability/course/pace/going/draw_weight/horse_jockey_course）を0〜100、小数2桁以内で返し、rationaleとevidence_idsに各評価根拠を記してください。総合点・順位はTurfLabが計算するので自己申告不要です。確率は推定として記述し、数値MCを未実行ならmode=narrative、engine_version/seed/trial_count=nullとしてください。

slow/middle/highの3展開と重み合計1、それぞれのanalysisと全有効馬のlineup（position/advantage）を返してください。買い目は100円単位で1R最大1,000円、見送り・少額を許可します。これは本人購入ではなく参考プランです。

Finalは発走前の取消・騎手・馬体重・馬場/バイアス・近走/状態に実変更がある場合だけ、独立IDと直前採用版の参照、final_changesの理由/出典を付けてください。オッズ変動だけでFinalを作らないでください。次の1Rは、この1Rの確定保存/読み返しの結果を確認してから扱ってください。
