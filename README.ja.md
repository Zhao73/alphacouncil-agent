<div align="center">

<img src="assets/logo.png" alt="AlphaCouncil Agent" width="120" />

# AlphaCouncil Agent

**ターミナルの中の、マルチエージェント投資委員会。**

アナリスト・エージェントの評議会を招集 → 出典付きの根拠を収集 → 強気/弱気のディベート → ポートフォリオマネージャーの判定:**買い · オーバーウェイト · 中立 · アンダーウェイト · 売り**。

[English](README.md) · [中文](README.zh-CN.md) · **日本語**

[![check](https://github.com/Zhao73/alphacouncil-agent/actions/workflows/check.yml/badge.svg)](https://github.com/Zhao73/alphacouncil-agent/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![works with](https://img.shields.io/badge/works%20with-Codex%20%26%20Claude%20Code-black)

</div>

---

AlphaCouncil Agent は、**上場株式のリサーチ**向けの Codex / Claude Code プラグインです。複数のアナリスト・サブエージェントを統括し、出典付きの根拠を集め、強気/弱気のディベートを行い、ポートフォリオマネージャー視点の最終レポートを生成します。

このリポジトリはアップロード用のソースコピーです。実行成果物はリポジトリの外、`~/.alphacouncil-agent/runs/<run_id>/` に書き出されます。

## ⚠️ 免責事項

本ソフトウェアは**教育・研究目的のみ**を対象としており、**投資助言ではありません**。いかなる証券の売買の推奨・勧誘でもありません。AI が生成する分析は不完全・古い・誤っている可能性があります。投資判断の前に、必ずご自身で調査し、有資格の専門家にご相談ください。作者はいかなる損失についても責任を負いません。

## インストール

Codex と Claude Code の完全なセットアップ手順は **[docs/INSTALL.md](docs/INSTALL.md)** を参照してください。

**前提条件:** Node.js ≥ 18。headless でリサーチを実走させるには、**インストール済みかつ認証済みの Codex CLI** も必要です(各アナリスト worker は `codex exec` として起動します)。Codex が無い場合は、インストールガイドの **visible ワークフロー**を使ってください。

```text
# Codex
codex plugin marketplace add Zhao73/alphacouncil-agent
# その後 codex → /plugins でインストール → /reload-plugins

# Claude Code
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil-agent@alphacouncil
/reload-plugins
```

## 使い方

エージェントにそのまま話しかけるだけ。@ でエージェントを呼び、ティッカーや質問を添えます:

```text
@alphacouncil-agent NVDA をロング/ショートのピッチとして分析して
@alphacouncil-agent 現在の水準で AAPL は買い?
@alphacouncil-agent 12か月の視点で TSLA と RIVN を比較して
@alphacouncil-agent トヨタ(7203)を分析して
@alphacouncil-agent 帮我看看 700.HK 现在能不能买
```

チャット上でそのまま読める 1 本のレポートが返ってきます:

```text
判定:オーバーウェイト  (確信度:中)
├─ アナリスト作業ログ .... 11 の根拠エージェント、出典付き主張 38 件
├─ 強気シナリオ .......... 需要の転換点、マージン拡大、自社株買い
├─ 弱気シナリオ .......... バリュエーション、顧客集中、サイクルリスク
├─ 短期 / 中期 / 長期 .... 1〜4週 · 3〜6か月 · 12か月の見通し
├─ カタリストとリスク .... 決算、ガイダンス、規制
├─ データの欠落 .......... 明示的に列挙し、決して隠さない
└─ 出典テーブル .......... すべての主張を <task>:<source_id> に対応付け
```

完全なレポートは `~/.alphacouncil-agent/runs/<run_id>/final_report.md` にも書き出されます。

## 何ができるか

デフォルトの個別銘柄分析は、要約版ではなく**フルラン**です:

- 株価データと値動き
- 決算のディープダイブ
- 将来予想と、織り込まれた beat/miss の閾値
- セルサイドのレーティング・目標株価の改定
- 決算電話会議における経営陣のシグナル
- クオンツ・ファクター視点:モメンタム、トレンド、ボラティリティ、出来高/流動性、相対的強さ、空売り残高、貸株、(取得可能な場合)オプションの IV/スキュー/予想変動幅
- バリュエーションとロング/ショートのピッチ
- ニュース、業界背景、CEO/経営陣および公開された業界人の発言
- SEC 提出書類、Form 4(インサイダー取引)、自社株買い、希薄化、負債、資本配分
- M&A・増資・負債・自社株買い・戦略的取引に関する投資銀行イベント分析
- ブル・リサーチャー、ベア・リサーチャー、ポートフォリオマネージャーによる統合

最終レポートはチャット上でそのまま読み切れることが要件で、アナリスト作業ログ、データ/ニュース/書類の要約、強気/弱気ディベート、PM の結論、短期/中期/長期の見解、データの欠落、確信度、出典テーブルを含みます。

## アーキテクチャ

```text
@alphacouncil-agent リクエスト
  -> skills/alphacouncil-agent/SKILL.md のスキル指示
  -> ホストにマルチエージェント機能がある場合、可視の Codex サブエージェントを起動
  -> 保存型 / headless 成果物ラン向けの MCP server
  -> 根拠パケット(evidence packets)
  -> source_manifest.json
  -> 強気/弱気ディベート
  -> manager_synthesis.json + final_report.md
```

主要ファイル:

- `.codex-plugin/plugin.json` —— Codex プラグインのメタデータ
- `.claude-plugin/plugin.json` —— Claude Code プラグインのマニフェスト
- `.mcp.json` —— MCP server の配線
- `skills/alphacouncil-agent/SKILL.md` —— 実行時の指示
- `mcp/server.mjs` —— JSON-RPC MCP server とワークフロー実装
- `scripts/selfcheck.mjs` —— 最小限の回帰セルフチェック

## データ契約

根拠サブエージェントは JSON パケットを返します:

```json
{
  "task": "market_data",
  "symbol": "NVDA",
  "as_of": "YYYY-MM-DD",
  "summary": "string",
  "claims": [
    { "claim": "string", "evidence": "string", "confidence": "high|medium|low", "source_ids": ["market_data:S1"] }
  ],
  "metrics": {},
  "sources": [
    { "id": "market_data:S1", "title": "string", "url": "https://example.com", "published_at": "YYYY-MM-DD or unknown", "retrieved_at": "YYYY-MM-DD" }
  ],
  "open_questions": ["missing data item"],
  "confidence": "high|medium|low"
}
```

すべての source ID は `<task>:<source_id>` のグローバルスコープです。欠落データは `open_questions` に記載し、最終レポートのデータ欠落セクションにも反映する必要があります。

## ローカル実行

```bash
npm run check
```

セルフチェックの検証内容:MCP server の構文、ツール schema の公開、source ID のスコープ、デフォルトの実走挙動、可視ランの記録、`events.jsonl`/`status.json`/`all_agents.md`/`source_manifest.json`、および最終レポートにアナリスト作業ログ・強気/弱気ディベート記録・データ欠落が含まれているか。

## 備考

これは独立したプラグイン実装で、マルチエージェントの投資委員会ワークフロー(アナリストチーム、根拠の共有、強気/弱気ディベート、ポートフォリオマネージャーによる統合)を採用しています。

API キー、証券口座の認証情報、非公開書類、生成された実行成果物は決してコミットしないでください。
