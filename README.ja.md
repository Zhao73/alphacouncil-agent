<a name="readme-top"></a>

<!-- readme-section:hero -->
<div align="center">

<img src="assets/banner.png" alt="AlphaCouncil Agent" width="100%" />

### 一つずつ検証できる投資リサーチ評議会

**一つの質問を、出典付きの根拠、複数の手法視点、強気・弱気の反論、PM の判定へ展開します。**

[English](README.md) · [中文](README.zh-CN.md) · **日本語**

<p>
  <img src="https://img.shields.io/github/actions/workflow/status/Zhao73/alphacouncil-agent/check.yml?style=for-the-badge&label=build&logo=githubactions&logoColor=white&color=1a7a6a" alt="build" />
  <img src="https://img.shields.io/badge/License-MIT-c9a227?style=for-the-badge" alt="MIT" />
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="node" />
  <img src="https://img.shields.io/github/stars/Zhao73/alphacouncil-agent?style=for-the-badge&logo=github&color=0d4d4d" alt="stars" />
</p>
<p>
  <img src="https://img.shields.io/badge/OpenAI_Codex-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI Codex" />
  <img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code" />
  <img src="https://img.shields.io/badge/OpenCode-1a7a6a?style=for-the-badge" alt="OpenCode" />
  <img src="https://img.shields.io/badge/Grok_Build-000000?style=for-the-badge&logo=x&logoColor=white" alt="Grok Build" />
  <img src="https://img.shields.io/badge/ChatGPT_Work-dev_mode-412991?style=for-the-badge&logo=openai&logoColor=white" alt="ChatGPT Work developer mode" />
</p>
<p>
  <img src="https://img.shields.io/badge/MCP-compatible-000000?style=for-the-badge" alt="MCP 対応" />
  <img src="https://img.shields.io/badge/data_check-no_vendor_key-2ea043?style=for-the-badge" alt="コアのデータ確認はベンダーキー不要" />
  <img src="https://img.shields.io/badge/runtime_dependencies-zero-2ea043?style=for-the-badge" alt="ランタイム依存ゼロ" />
</p>

[インストール](#codex-にインストール) · [まずデータ層を試す](#無料の初回実行) · [呼び出し構造を見る](#実行前に深さを選ぶ) · [レポートを読む](docs/examples/final_report.SOX.zh.md)

</div>

<!-- readme-section:demo -->
<div align="center">

**質問 → 出典付き根拠 → 固定した手法スタンス → 強気・弱気の反論 → PM 判断 + 保存可能な監査記録**

[過去版 UI の録画（MP4）](assets/demo.mp4) · [過去版レポート成果物（SOX、中国語）](docs/examples/final_report.SOX.zh.md)

<sub>録画は現在の 26 席候補より前の UI です。現在の所要時間、手法忠実度、データ精度、4 つのコードホスト、ChatGPT Work の E2E を証明するものではありません。</sub>

</div>

<!-- readme-section:promise -->
## 一つの質問から、検証できる論証へ

AlphaCouncil は銘柄の質問を検証可能な調査工程へ変えます。並列の根拠ワーカーが公開情報を収集し、選んだ投資手法席が同じ日付付き事実を解釈し、強気と弱気が互いの論拠を問い、最後にポートフォリオマネージャーが判断と無効化条件を記録します。足りない入力を推測で埋めず、欠落として残します。

同じリポジトリが **Codex、Claude Code、OpenCode、Grok Build** に対応し、ツール専用の **ChatGPT Work 開発者モードゲートウェイ** も提供します。調査前に企業、ETF、市場指数を分類するため、バスケットを自社売上のある事業会社として扱いません。

<!-- readme-section:install -->
## Codex にインストール

前提条件は Node.js 18 以降です。まずターミナルで次の 2 コマンドを実行します。

```bash
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

プラグインは Codex の起動時に読み込まれます。Codex を完全に終了して再起動し、新しいセッションを開いてから Codex の入力欄に次を入力します。

```text
@alphacouncil-agent analyze AAPL
```

ChatGPT Work 開発者モード、Claude Code、OpenCode、Grok Build、Windows、トラブル対応、任意の npm グローバルコマンドは **[完全なインストールガイド](docs/INSTALL.md)** を参照してください。

<!-- readme-section:first-run -->
## 無料の初回実行

評議会を始める前に、キー不要の公開データ層を確認します。

```text
# Codex
@alphacouncil-agent AAPL news

# Claude Code、OpenCode、Grok Build
/alpha AAPL news
```

この確認は評議会ワーカーを起動せず、データベンダーのキーも不要です。Codex で範囲を限定した調査を行う場合は `@alphacouncil-agent AAPL quick`、ほかの 3 つのスラッシュコマンド対応ホストでは `/alpha AAPL quick` を使います。

<!-- readme-section:call-structure -->
## 実行前に深さを選ぶ

AlphaCouncil は最初に作業計画を表示します。完全調査では手法席、根拠範囲、深さを別々に尋ね、ユーザーの確認後にワーカーを開始します。3 段階の上限は **15 / 30 / 60** 分で、実測根拠のない token 数や金額は示しません。

| 実行方法 | モデル呼び出し構造 | 時間上限 |
|---|---|---:|
| データ確認 | キー不要ツールのみ。評議会ワーカーも追加のモデル展開もなし | 評議会の時間枠外 |
| クイック調査 | 4 根拠席を並列 → 1〜4 手法席を並列 → Bull/Bear を並列 → PM | 10 分 |
| 完全—fast | core 8 席または all 11 席を同時開始。選択した各手法は決定論的にスタンスを固定してから、隔離された 1 ワーカーが説明。3 ラウンド討論 → PM | 15 分 |
| 完全—normal | 確認済みの席、スタンス固定順序、3 ラウンド討論、PM を保ち、深さの余裕を拡大 | 30 分 |
| 完全—slow | 同じ確認済みの席と段階を保ち、最大の深さを使用 | 60 分 |

これらはキュー投入から終端状態を永続化するまでの上限であり、実測完了時間ではありません。
未完了でも明示的な終端記録を残すための上限です。実ホスト上の完全な fast 実行が 15 分以内に
成功することは、4 ホストではまだ検証されていません。

追加検証経路が有効になるのは「slow + 全手法 + 全根拠席」だけです。それ以外の完全調査は、この追加確認を実施したとは主張しません。

<!-- readme-section:benefits -->
## 得られるもの

| 利点 | 何が変わるか |
|---|---|
| **一つの回答ではなく評議会** | 根拠専門席、手法席、対立する論証、PM によって、合意の理由が見えるようになります。 |
| **物語より先にスタンス** | 完全調査では、各手法が構造化入力からスタンスを固定した後、隔離ワーカーが説明を書きます。 |
| **追跡できる主張** | 重要な主張には source ID が必須で、根拠不足は明示的な欠落として残ります。 |
| **統合後も異論が残る** | 3 ラウンドの反対尋問と保存された少数・反対レポートにより、採用されなかった論点も確認できます。 |
| **資産に合った調査経路** | 企業は発行体情報、ETF は日付付き保有銘柄のルックスルー、指数は集計手法を使います。初回データ確認はキー不要です。 |

<!-- readme-section:comparison -->
## アーキテクチャ上の違い

次の表は一般的なワークフロー形状の比較であり、特定製品についての主張ではありません。個々のツールは別の設計を採用している場合があります。

| 確認点 | 単一モデル回答または一般的な共有コンテキスト型フロー | AlphaCouncil |
|---|---|---|
| 相関した誤り | 一つの共有コンテキストが初期の誤りを後段へ運ぶことがある | 根拠席と反対経路は隔離ワーカーで動く。ただし同じ提供元やモデルを使う場合があり、**独立モデルではありません** |
| 立場の形成 | 立場と説明が同時に作られることがある | 構造化スタンスを説明文より先に固定 |
| 出典追跡 | 追跡性はプロンプトとホストに依存 | すべての重要な主張に source ID が必要 |
| 少数意見 | 異論が最終要約へ折り畳まれることがある | 少数意見と反対レポートを確認用成果物として明示的に保存 |

<!-- readme-section:honesty -->
## 手法席であるもの、ないもの

手法席の数式は、**公開済みの手法を AI が再構成したもので、人間のレビュー待ち**です。実名の実践者はこれらを審査も推奨もしていません。人格の模倣、独立モデル、検証済みの複製ではありません。スタンスは入力と出典を照合して確認すべき構造化論証であり、検証済み投資モデルではありません。

現在のソース証拠境界は、暫定メソッド席 26、検証済みメソッドモデル 0、登録・完了済み標準評価
0/8、実ホスト E2E 0/4 です。ソーステストの合格によって、これらのゼロが変わることはありません。

<!-- readme-section:disclaimer -->
## 免責事項

AlphaCouncil は**教育・研究目的のみ**のソフトウェアです。投資助言、売買の推奨、勧誘ではありません。AI の分析は不完全、古い、または誤っている場合があります。投資判断前に根拠をご自身で確認し、有資格の専門家へ相談してください。作者は損失について責任を負いません。

<!-- readme-section:reference-fold -->
## 詳細

- [日本語の詳細な製品・使い方・ツール・アーキテクチャ資料](docs/reference/README.ja.md)
- [4 ホスト対応の完全なインストールガイド](docs/INSTALL.md)
- [レポート契約](docs/report-contract.md)と[完全なレポート例](docs/examples/final_report.SOX.zh.md)
- [ロードマップ](docs/roadmap.md)、[セキュリティモデル](SECURITY.md)、[帰属情報](docs/attribution.md)、[変更履歴](CHANGELOG.md)
- ローカル UI：`npm run tui` と `npm run gui`

実行成果物はリポジトリ外の `~/.alphacouncil-agent/runs/<run_id>/` に保存されます。

<div align="center">

<img src="assets/logo.png" alt="AlphaCouncil" width="120" />

**根拠を先に。異論を見える形に。判断を検証可能に。**

<a href="#readme-top">↑ トップに戻る</a>

</div>
