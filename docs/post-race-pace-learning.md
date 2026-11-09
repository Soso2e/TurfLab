# TurfLab：レース後の展開観測と継続検証 v1

更新: 2026-11-09。Issue [#62](https://github.com/Soso2e/TurfLab/issues/62) の段階実装。関連: [#24](https://github.com/Soso2e/TurfLab/issues/24) / [#61](https://github.com/Soso2e/TurfLab/issues/61)。

> **このPRで実装するのは「発走前に予測された数値通過順位」と「発走後の観測通過順位」の純粋比較関数のみ。** 公式情報の自動取得、結果の保存/精算、日次レビュー書込、特徴量の自動更新、Web表示、モデルの自動学習は未実装。現行Coreの予想、モデル重み、保存・認証経路は変更しない。

## 1. 目的

発走前に固定した評価・展開仮説（locked prediction / cutoff / model version）と、発走後に独立確認した観測値を**別の版・別の時点**で保持し、後から「何を予測し、何が実際に起きたか」を定量的・定性的に検証する。

成果は勝率向上の保証ではない。観測率と欠測、予想誤差、結果の照合・訂正状態、未使用レースでの改善を区別する。

## 2. 既存DBとの対応

| 領域 | 使う既存正本 | 用途 |
| --- | --- | --- |
| 発走前予想 | `predictions`, `simulation_runs.scenarios_json`, `horse_evaluations` | 朝の採用済みlocked予想・slow/middle/high 3展開と想定位置取り |
| 公式結果 | `race_results`, `payouts` | 公式着順/取消/同着、結果訂正、既存`saveResult`と`settle`を利用 |
| 実測戦績 | `performances` | `corner_positions_json`, `last_3f_s`, `finish_time_s`, `pace_observed`等 |
| レビュー | `reviews` | `observations_json`（確認済み事実）、`hypotheses_json`（可能性）、`unknowns_json`（欠測）、`validation_plan_json`（次回検証） |
| 次回特徴量 | `entity_features` | 馬・騎手・コンビの条件別履歴と標本数。予測時点に利用できたデータだけ参照 |
| GitHub隔離記録 | 非公開TurfLab-data の新規ファイル（将来） | 機械受信前の来歴付き観測ステージ。正式Core/公式結果ではない |

先に結果版・馬のID・馬番/出走状態の対応を確認する。同名馬だけで同一性を決定しない。既存の公開GitHubリポジトリに個人用認証情報や規約上転載禁止の原文/映像を保存しない。

## 3. 観測入力（将来の手動/許諾済み取得アダプター）

単一レース・単一結果版に紐づける。

- `race_id`, `result_id`, `result_revision`, `source_url`, `published_at`/ `available_at`, `retrieved_at`, `verification_status`, `source_sha`
- `corner_labels`: 競馬場・距離・主催者の実データにあるコーナーのみ、たとえば `["3角", "4角"]`。4コーナー固定とはしない。
- `entry_id`, コーナーごとの通過順位（欠測`null`）、上がり3F（秒、欠測`null`）、走破タイム、着差、馬場、ハロンラップ。公表されていない項目を推測補完しない。
- ペース`slow/middle/high`は、計測ラップと**同場・同距離・同条件の時点整合した基準**に基づく場合のみ入力する。基準不明なら`null`、単に速い勝ちタイムでハイペースとは断定しない。
- 出走取消、競走中止、同着、結果訂正を損失なく保つ。公式結果の一部が取得できても、それをもって観測全体を確定扱いしない。

### データ権利

[NAR公式利用規約](https://www.keiba.go.jp/terms.html) と [公式FAQ](https://www.keiba.go.jp/qa.html) は転載・複製や商用二次利用等に制限を明示。**公開ページで見られることは機械収集・DB複製・再配信の包括的な許諾ではない**。

無断スクレイピング/大量転載/レース映像の保存を前提にしない。現段階は許諾済み入力、本人の適法な記録、手動の短い観測メモを優先し、データ提供元の利用条件が確認できた後に自動アダプターを個別追加する。競馬結果速報など第三者サイトの回顧は参考所見であり、独立した公式数値データの代わりにはしない。

## 4. このPRの比較関数

`packages/shared/src/post-race-pace-review.ts` に `comparePaceReview` を追加。

- `corner_labels`と各`entry_id`の**明示された数値順位**を比較し、コーナーごとの絶対順位誤差と馬別平均・全体平均、最初→最後の観測順位変化を返す。
- 前日の「先行と仮定」「差しが届く」といった**文章だけの位置取りは数値順位に変換しない**。未予測・未観測は`null`として残し、分母に入れない。
- ペース一致は、両方に独立した`slow/middle/high`分類が存在する場合だけ`true/false`。どちらか欠測なら`null`。分類そのものの自動推定はここでは行わない。
- 欠測・重複ID・不正順位・コーナー誤指定を検証。出走馬の集合が異なる場合は差を「予測/観測欠落」として見せ、勝手に対応づけない。
- 走破タイム・上がり順位の正規化、脚質の派生値、ペース基準の生成は別実装。

入力例（架空）：

```ts
const report = comparePaceReview({
  corner_labels: ["3角", "4角"],
  predicted: {
    pace: null, // 根拠のある数値ペース予測がなければnull
    runners: [{ entry_id: "entry-1", corner_ranks: { "3角": null, "4角": 3 } }],
  },
  observed: {
    pace: null, // コース/クラス基準が不足していればnull
    runners: [{ entry_id: "entry-1", corner_ranks: { "3角": 5, "4角": 2 }, last_3f_s: 38.5 }],
  },
});
// position_comparisons: 1, mean_absolute_corner_rank_error: 1
// pace_match: null, first→lastの観測順位変化: +3
```

## 5. 次の実装・受入順

1. **実1R手動取込**：許諾と時点を確認し、発走後に観測の`preview`、`race_id/entry_id/result_id`照合、保存/読返しを受入。今日の川崎11Rが一例（終了前に結果登録しない）。
2. **訂正と日次連携**：確認済み観測を既存`performances`・`reviews`へ追記、訂正はv2、再送は冪等・相違SHAは409、旧予想は不変。Issue #61 の翌朝CLI処理に差分を渡す。
3. **差分可視化**：レース詳細に予測/観測のコーナー順位・欠測・ペース一致（分類済みのみ）と回顧・根拠・映像URLを表示。
4. **再利用**：レビュー累積から次走の条件付き特徴量を更新。標本数・取得可能時刻・同クラス比較・交絡を明記し、当該レースで学習した重みを当該レースの予想成績に使わない。
5. **モデル改善判定**：発走前基準モデルと候補を、未使用の後続レース最低30Rを含む時間順の別期間で比較。本人承認なしに重み/モデル版を自動採用しない。

## 6. 検証と制約

テスト: `tests/post-race-pace-review.test.ts` で予測と実測の一致、一部欠測、記述予想のみ、未予測馬、無効ID/順位を確認。

このファイルを追加しただけでは`npm run check`や実レース受入が成功したことを意味しない。CIで型/lint/test/buildを確認してからマージを判断する。運用上は現行の日次スケジュール・予想数・予算・本人購入・公式結果/精算の挙動に変更なし。
