# 予測精度の検証設計（forecast-v1 / forecast-lab-v1）

更新: 2026-11-21。状態: 実装済み（合成データ・単体/結合テストで動作確認）。**実データでの精度はまだ測っていない。**

目的は機能を増やすことではなく、「数式モデルとAIが独立に予測し、同じ物差しで未使用の時系列データを採点して、改善が本物かを確かめる」ことです。オッズ・人気は、能力評価・展開予測・特徴量のいずれにも使いません（契約で機械的に拒否）。

## 構成

```
as-of特徴量（発走前フィールドのみ）──→ 予想者M（数式）──┐
                                                         ├─ forecast-v1（全頭勝率・3着内・角順位・ペース）
出走表・調査パック ────────────────→ 予想者A（AI, Mを見ない）┘        │ write-onceで凍結
                                                                       ▼
                      公式結果 ──→ 同一レース対比較（日ブロック・ブートストラップ）──→ 統合E・不一致分析・特徴量レジストリ
```

| 部品 | 場所 | 役割 |
|---|---|---|
| 共通予測契約 | `packages/shared/src/forecast-contract.ts` | 検証・正規化・採点。オッズ/人気/市場キー拒否、`cutoff ≤ generated ≤ 発走`、全頭・順列・合計の検査。`comparePaceReview` を採点に配線 |
| 予想者M | `scripts/python/forecast_lab/` | as-of特徴（7群）、条件付きロジット（M0r/M1）、展開モデルP v0、ウォークフォワード、ablation |
| 評価・統合・発見 | `scripts/forecast-eval.ts` | M/A/統合Eの対比較、AIの温度補正、不一致層別、理由カテゴリ別の追加価値（BH補正）、特徴量レジストリ、write-once台帳 |
| AI出力 | `scripts/independent-ai-assessment.ts` | プロンプトに `forecast` ブロック（確率・数値順位・理由カテゴリ）を必須化。欠測/不正は印・買い目を壊さず「採点対象外」と記録 |
| ワーカー配線 | `scripts/local-prediction-worker.ts` | AI予想の保存時に `exchange/forecasts/<日>/<レース>/ai-independent-v2.json` を凍結。`forecast_status` をlabレコードに記録 |

## 使い方

```
# 数式M: 過去のNAR CSVでバックテスト（devは最新20%を触らない）
npm run forecast:backtest -- --csv-dir <nar-archive> --out report.json --state-dir <state> [--ablate]
# 最終ホールドアウトは一度だけ（2回目は拒否）
npm run forecast:backtest -- --csv-dir ... --state-dir <state> --mode final
# 発走前: Mの予想を生成して凍結
npm run forecast:predict -- --csv-dir <nar-archive> --pack pack.json --out forecast.json --cutoff-at <ISO>
npm run forecast:lock   -- --root <exchange> --file forecast.json
# 結果後: 公式結果を評価用に変換し、M/A/Eを比較
npm run forecast:result -- --root <exchange> --official <results/...-official-v1.json> --race-key "YYYY-MM-DD|場|NR"
npm run forecast:report -- --root <exchange> --out forecast-report.json
```

## 検証ルール

- **分割**: 日単位のウォークフォワード。特徴量は常に `date < 対象日`。最新20%は最終ホールドアウトで、`holdout_used.json` により一度しか使えない。試行は `trial_log.jsonl` に全件記録（多重比較の母数）。
- **指標**: 勝馬のlog loss（主）、Brier、3着内Brier、校正表、層別（欠測率・頭数）。**市場との比較は含めない**（別の期待値検討）。
- **主張ラダー**（標本が許す範囲のみ）: 30R未満=判定不能 / 30R以上で区間上限<0=「改善傾向（主張水準未満）」 / 300R以上かつ区間上限<0=「優位候補」。いずれも前向き運用で再確認。回収率は別ゲート（既存の300R）。
- **不一致駆動の発見**: Mと温度補正後Aの発散度で層別し、Aが挙げた理由カテゴリごとに「Aが追加の情報を持つか」をBH補正で検定。候補は **M側に再実装して再検証**してから採用する（AIの文章を鵜呑みにしない）。
- **特徴量レジストリ**: 定義と取得可能時刻を登録してから検定。採用は300R以上・区間上限<0・試行数で補正したp<0.05。それ以外は「rejected」として残す。オッズ/人気系は登録不可。

## 未来情報・欠測・過学習への対策（テストで固定）

- 対象レースの結果列は `strip_prerace` で物理的に落とす。特徴を書き換えても出力が変わらないこと、cutoff以降の行を除いても同一であること、わざと未来を覗く実装は `LeakageError` で検出されることをテスト。
- 欠測は補完せず指示子（`has_hist`/`has_l3f`/`has_corner`）を持たせ、欠測率別に採点。履歴の少ない馬・騎手は経験ベイズで縮小。
- 純粋ノイズのデータで「優位」と出さないこと、ablationが冗長な群に「根拠なし」と返すことをテスト。

## 現時点の限界（正直な記載）

1. **実データ未検証**: 合成データ（人工的な信号を埋めたもの）で仕組みの正しさを確認しただけで、実NARデータでの精度・展開予測の当たり具合は未測定。NAR月次CSVは本番Windows側にあり、このコンテナにはない。最初の実作業は `forecast:backtest` の実行（段階0の監査: レース数・列・通過順/上りの充足率）。
2. **Pは記述的**: NAR CSVに200mラップがないため、観測ペースは「勝ち馬の前半平均 − 後半3F」を同コース・同距離の as-of 基準に対するzで分類したもの。ラップが揃うJRA側は4レースしか公式ラップがなく、まだ使えない。
3. **馬の同一性は馬名のみ**: 同名馬の混同があり得る。除外競走・中止は着順を最下位扱い、同着1着のレースと小頭数は集計から除外（件数をレポートに記載）。
4. **JRAには未適用**: 学習データはNAR中心。JRAレース（11/22の4レース）にはMを適用できる履歴がない。JRA-VAN等の導入判断は別途。
5. **AIのreplay（過去レース再実行）は未実装**: 前向きの凍結ログだけで開始。replayを行う場合は `mode: "replay"` と知識カットオフ日が必須で、カットオフ以前のレースは評価から除外される。
6. **標本**: AI側は費用上、数百Rが上限。AI単独の優位は長く「判定不能」の可能性が高い。AIの価値は「Mの残差への追加情報」で測る。
7. 本番の重み・正式予想・Betは変更しない。モデルの自動昇格はしない（採用は本人承認）。
