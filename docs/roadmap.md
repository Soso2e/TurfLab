# 開発ロードマップ v0.2

状態: 設計・Issue登録済み、全Phase実装未着手。親7件・子21件。GitHubのSub-issuesとして親子を登録し、本文にも相互参照を残します。

## Phase番号の整理

元の会話には複数の番号案がありました。今回の依頼に合わせ、次の対応を正式な順序とします。機能は削除せず、購入・結果を独立Phaseにしています。

| 今回 | 内容 | 元のv0.2案との対応 |
|---|---|---|
| Phase 1 | DB・データ取り込み基盤 | 1 |
| Phase 2 | Webポータル | 2 |
| Phase 3 | ChatGPT JSON連携 | 3 |
| Phase 4 | 仮想購入・結果・払戻管理 | 2/3に含まれていた操作・記録を独立 |
| Phase 5 | 数値シミュレーション | 4 |
| Phase 6 | 毎朝の自動化・翌朝レビュー | 5 |
| Phase 7 | 精度検証・バックテスト・改善 | 6/7を統合 |

Phase 1→2→3→4で手動MVP（予想→保存→確認→仮想購入→翌朝結果照合）を完成させます。Phase 5以前も全レースの文章シナリオ分析は必須で、数値実行とは区別します。その後に数値計算、自動化、検証改善を進めます。

## Issue一覧

### Phase 1: DB・データ取り込み基盤 — [#1](https://github.com/Soso2e/TurfLab/issues/1)

既存Sheetsを保護し、時点と出典を追跡できる保存基盤を作る。

- [ ] [#2 [Phase 1.1] Sheets現状調査・論理DBと列対応の確定](https://github.com/Soso2e/TurfLab/issues/2)
- [ ] [#3 [Phase 1.2] Workers API・認証・Sheets Repositoryの基盤](https://github.com/Soso2e/TurfLab/issues/3)
- [ ] [#4 [Phase 1.3] 出典・時点付き取り込みと冪等復旧](https://github.com/Soso2e/TurfLab/issues/4)

### Phase 2: Webポータル — [#5](https://github.com/Soso2e/TurfLab/issues/5)

スマホとPCで本日の状態と分析根拠を確認する画面を整える。

- [ ] [#6 [Phase 2.1] React・TypeScript・Vite基盤と本日の一覧](https://github.com/Soso2e/TurfLab/issues/6)
- [ ] [#7 [Phase 2.2] レース詳細・馬・騎手・コースの根拠表示](https://github.com/Soso2e/TurfLab/issues/7)
- [ ] [#8 [Phase 2.3] 予想取り込み・購入・結果の操作画面](https://github.com/Soso2e/TurfLab/issues/8)

### Phase 3: ChatGPT JSON連携 — [#9](https://github.com/Soso2e/TurfLab/issues/9)

予想と全レースの展開分析を検証し、変更不能な版として保存する。

- [ ] [#10 [Phase 3.1] JSON Schema・入力検証・プレビュー](https://github.com/Soso2e/TurfLab/issues/10)
- [ ] [#11 [Phase 3.2] 予想・シミュレーション・推奨の保存と確定](https://github.com/Soso2e/TurfLab/issues/11)
- [ ] [#12 [Phase 3.3] 再分析プロンプト・モデルと入力版管理](https://github.com/Soso2e/TurfLab/issues/12)

### Phase 4: 仮想購入・結果・払戻管理 — [#13](https://github.com/Soso2e/TurfLab/issues/13)

本人の仮想購入と公式結果を結び、予想精度と購入収支を分離する。

- [ ] [#14 [Phase 4.1] 仮想購入・見送りと予算の確定](https://github.com/Soso2e/TurfLab/issues/14)
- [ ] [#15 [Phase 4.2] 公式結果・払戻取り込みと冪等精算](https://github.com/Soso2e/TurfLab/issues/15)
- [ ] [#16 [Phase 4.3] 購入収支・全予想成績の分離集計](https://github.com/Soso2e/TurfLab/issues/16)

### Phase 5: 展開を考慮した数値シミュレーション — [#17](https://github.com/Soso2e/TurfLab/issues/17)

記録した能力とコースから実際の試行を再現可能にする。

- [ ] [#18 [Phase 5.1] 区間・ペース・能力推定のモデル設計](https://github.com/Soso2e/TurfLab/issues/18)
- [ ] [#19 [Phase 5.2] seed付きMonte Carloエンジンと実行記録](https://github.com/Soso2e/TurfLab/issues/19)
- [ ] [#20 [Phase 5.3] 着順分布・組合せ確率とオッズ期待値](https://github.com/Soso2e/TurfLab/issues/20)

### Phase 6: 毎朝の自動化・翌朝レビュー — [#21](https://github.com/Soso2e/TurfLab/issues/21)

前日精算から当日予想までをレース単位で復旧できるようにする。

- [ ] [#22 [Phase 6.1] 朝の定期処理と日次・レース別状態](https://github.com/Soso2e/TurfLab/issues/22)
- [ ] [#23 [Phase 6.2] AI API・データ取得の再試行と運用監視](https://github.com/Soso2e/TurfLab/issues/23)
- [ ] [#24 [Phase 6.3] 翌朝レビューの観測・仮説・検証分離](https://github.com/Soso2e/TurfLab/issues/24)

### Phase 7: 精度検証・バックテスト・改善 — [#25](https://github.com/Soso2e/TurfLab/issues/25)

十分な標本と未使用期間でモデル改善を判断する。

- [ ] [#26 [Phase 7.1] 確率校正・条件別・モデル別の評価](https://github.com/Soso2e/TurfLab/issues/26)
- [ ] [#27 [Phase 7.2] 時点再現バックテストと時間順検証](https://github.com/Soso2e/TurfLab/issues/27)
- [ ] [#28 [Phase 7.3] 改善仮説・新モデル採用とD1移行判断](https://github.com/Soso2e/TurfLab/issues/28)
