<a name="readme-top"></a>

<div align="center">

<img src="assets/banner.png" alt="AlphaCouncil Agent" width="100%" />

### 装进终端里的多智能体投资委员会

召集一组分析师代理 → 收集带来源的证据 → 多空辩论 → 投资组合经理拍板:**买入 · 增持 · 持有 · 减持 · 卖出**

[English](README.md) · **中文** · [日本語](README.ja.md)

<p>
  <img src="https://img.shields.io/github/actions/workflow/status/Zhao73/alphacouncil-agent/check.yml?style=for-the-badge&label=build&logo=githubactions&logoColor=white&color=1a7a6a" alt="build" />
  <img src="https://img.shields.io/badge/License-MIT-c9a227?style=for-the-badge" alt="MIT" />
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="node" />
  <img src="https://img.shields.io/github/stars/Zhao73/alphacouncil-agent?style=for-the-badge&logo=github&color=0d4d4d" alt="stars" />
</p>
<p>
  <img src="https://img.shields.io/badge/OpenAI_Codex-412991?style=for-the-badge&logo=openai&logoColor=white" alt="codex" />
  <img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="claude code" />
  <img src="https://img.shields.io/badge/MCP-compatible-000000?style=for-the-badge" alt="mcp" />
</p>

<p>
  <a href="#-用法"><b>用法</b></a> ·
  <a href="docs/INSTALL.md"><b>安装</b></a> ·
  <a href="#-架构"><b>架构</b></a> ·
  <a href="#-免责声明"><b>免责声明</b></a>
</p>

</div>

---

<div align="center">

<img src="assets/demo.gif" alt="AlphaCouncil Agent 演示" width="100%" />

<sub><i>一句命令 → 一组分析师代理 → 多空辩论 → 投资组合经理给出结论。</i></sub>

</div>

AlphaCouncil Agent 是一个面向**上市股票研究**的 Codex / Claude Code 插件。它会协调多个分析师子代理、收集带来源的证据、进行多空辩论,并产出投资组合经理风格的最终报告。

### ✨ 为什么用 AlphaCouncil

| | |
|---|---|
| 🏛️ **是委员会,不是一家之言** | 11 个专项分析师代理(行情、财报、估值、量化、内部人/SEC、投行事件……)并行工作。 |
| 🐂🐻 **天生对抗式** | 结构化的多头 vs 空头辩论,由投资组合经理代理裁决并给出实际评级。 |
| 🔍 **可审计,不瞎编** | 每条结论都映射到 source ID;缺失数据写进「数据缺口」章节,绝不隐藏。 |
| ⏱️ **多周期结论** | 买入/持有/卖出,外加独立的 1-4 周、3-6 月、12 月判断。 |
| 🔑 **不依赖金融 API,无需任何密钥** | 不需要金融数据 API、行情源或券商账号。分析师通过代理自带的联网搜索实时取证(**Codex 网页搜索** / **Claude Code 的 WebSearch + WebFetch**),只消耗你已有的 Codex / Claude Code 订阅额度。MIT 开源。 |
| 📚 **内置研究方法论** | 股票研究与投行事件分析的方法论以**本地 skill** 形式打包(`skills/public-equity-investing`、`skills/investment-banking`)——不依赖 Codex 专属远程工作流,Claude Code 也能获得同等研究深度。 |
| 📈 **真实行情兜底,免 key** | 内置 `get_quote` 通过 Yahoo + Stooq 拉延迟(~15分钟)的指数 / 股指期货(含夜盘)/ 汇率 / 利率 / 波动率 / 商品 / 个股点位——不用 API key,分析师引用真实数字而非猜测。 |

本仓库是可上传的源代码副本。运行产物写在仓库之外的 `~/.alphacouncil-agent/runs/<run_id>/` 下。

## 📜 免责声明

本软件**仅供教育与研究**,**不构成投资建议**,不构成任何证券买卖推荐或要约。AI 生成的分析可能不完整、过时或错误。投资决策前请自行核实并咨询持牌专业人士。作者不对任何损失承担责任。

## 安装

完整的 Codex 与 Claude Code 安装说明见 **[docs/INSTALL.md](docs/INSTALL.md)**。**Windows 用户**见 [Windows 小节](docs/INSTALL.md#windows)。

**前置条件:** Node.js ≥ 18。headless 真跑研究还需要**已安装并登录的 Codex CLI**(每个分析师 worker 都以 `codex exec` 运行);没有 codex 时,改用安装文档里的 visible 工作流。

```text
# Codex
codex plugin marketplace add Zhao73/alphacouncil-agent
# 再 codex → /plugins 安装 → /reload-plugins

# Claude Code
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil-agent@alphacouncil
/reload-plugins
```

## 🚀 用法

直接对它说话,@ 一下代理,带上代码或问题:

```text
@alphacouncil-agent 把 0700.HK 当成多空 pitch 来分析
@alphacouncil-agent 现在这个价位 AAPL 能不能买?
@alphacouncil-agent 以 12 个月维度对比 TSLA 和 RIVN
@alphacouncil-agent 帮我看看 700.HK 现在能不能买
@alphacouncil-agent トヨタ(7203)を分析して
```

返回的是一份可直接在聊天里读完的报告:

```text
结论:增持  (置信度:中)
├─ 分析师工作记录 ...... 11 个证据代理,38 条带来源主张
├─ 多头论点 ............ 需求拐点、利润率扩张、回购
├─ 空头论点 ............ 估值、客户集中度、周期风险
├─ 短 / 中 / 长期 ...... 1-4周 · 3-6月 · 12月 判断
├─ 催化剂与风险 ........ 财报、指引、监管
├─ 数据缺口 ............ 明确列出,从不隐藏
└─ 来源表 .............. 每条主张映射到 <task>:<source_id>
```

简洁交付摘要写入 `~/.alphacouncil-agent/runs/<run_id>/user_response.md`。
完整报告写入 `~/.alphacouncil-agent/runs/<run_id>/final_report.md`。
同一目录还会写入每个分析师的 Markdown 文件和 `artifact_index.md` 文件索引。

## 它能做什么

默认是完整运行，不是精简摘要：

- 行情与价格行为
- 财报深度分析，含财报电话会
- 前瞻预期、隐含的超预期/不及预期门槛、卖方评级与目标价修正
- 量化因子：动能、趋势、波动率、流动性、相对强弱、拥挤度
- 估值与多空论点，给价格区间而非单一目标价
- 新闻、行业背景、产业链，以及管理层言行核对
- SEC 申报、Form 4 内部人交易、回购、稀释、债务与资本配置
- 并购、股权与债务融资、回购等事件分析
- 21 位投资大师视角**独立**读同一批事实
- 多头、空头与 PM 裁决

最终报告可直接在对话中阅读，包含分析师工作记录、数据与申报摘要、多空辩论记录、PM 裁决、入场价格区间、短中长期观点、数据缺口、置信度和来源表。

## 🔧 工具 —— 27 个，全部免 key

以下没有一项需要 API key、账号或配置文件。装完直接跑。

| 领域 | 工具 | 数据源 |
|---|---|---|
| **申报** | `screen_ticker` `screen_candidates` `list_us_universe` `compose_research_brief` | SEC EDGAR XBRL |
| **非美申报** | `market_financials` `market_coverage` | 台交所免 key；DART/EDINET 需免费 key；港股/A股仅文档 |
| **行情** | `get_quote` `get_macro_snapshot` | Yahoo / Stooq，21 条宏观序列 + 5 项派生 |
| **期权** | `get_options_chain` | CBOE 延迟报价 —— 隐含波动率期限结构、25Δ 偏斜、未平仓量、Greeks |
| **新闻** | `get_news` `get_market_narrative` | Yahoo、Google News、SEC Atom、美联储、WSJ、CNBC |
| **社交** | `get_social_pulse` `verify_x_post` | Reddit、Hacker News、Bluesky |
| **行业** | `industry_brief` `industry_peers` `industry_coverage` `list_industries` | 全美股 SIC 分类 + 精选产业地图 |
| **流程** | `analyze_symbol` `plan_visible_run` `collect_evidence` `read_run` 等 9 个 | — |

**它刻意不做什么。** 以下每一条都写在工具输出本身里，不只写在文档里 —— 因为被下游引用的是 payload：

- **隐含波动率分位算不出来。** 期权链是快照无历史，任何「波动率相对自身历史偏高/偏低」的论断都报为待解问题。
- **X / Twitter 没有免费发现通道**（截至 2026-07）。Nitter 搜索已死、X API 按条计费、xAI 按次计费。**专业 FinTwit 未被覆盖，Reddit 不是它的替代品。**
- **缺输入的筛选规则报 `skipped`，绝不当作通过。**
- **无可解析时间戳的新闻条目被剔除**，不会被展示为「最新」。
- **报 `iv = 0` 的合约被丢弃** —— CBOE 对已过期和深度实值合约返回 0，而 0 混进均值不像缺失值，像一只很平静的股票。

## 🏛️ 大师议席 —— 21 位

这是对公开方法论的重构，**不是本人的任何表述**。每一位都写明自己怎么思考、最先注意什么、典型追问是什么，以及**自己的失败模式** —— 说不出自己怎么错的席位，出错时不会举手。

| 名册 | 席位 |
|---|---|
| 价值 | 巴菲特 · 芒格 · 段永平 · 李录 |
| 经典价值 | 格雷厄姆 · 费雪 · 林奇 · 马克斯 · 克拉曼 |
| 对抗 | 索罗斯 · 德鲁肯米勒 · 达利欧 · 伯里 · 做空视角 |
| 量化 | 西蒙斯 · Asness · 索普 |
| 期权 | 塔勒布 · 纳坦伯格 · 辛克莱 |
| 现代 | Aschenbrenner |

大师读到的是**和分析师同一份已确立事实**（申报、行情、财务、宏观），分析师的证据包单独给出并标注为「其他席位的解读」而非事实。这个分离是关键：芒格看激励结构的地方分析师看的是毛利率，只有让他们各自取舍，这个议席才有存在意义。详见 [docs/attribution.md](docs/attribution.md)。

## 🧩 架构

```mermaid
flowchart TD
    U["@alphacouncil-agent"] --> G[("Established facts<br/>filings · quotes · macro · options")]
    G --> AG{{"Analyst council"}}
    G --> MS{{"Master bench<br/>21 lenses"}}
    AG --> A1["Market data"]
    AG --> A2["Earnings"]
    AG --> A3["Valuation"]
    AG --> A4["Quant factors"]
    AG --> A5["Insider / SEC"]
    AG --> A6["News / narrative"]
    A1 --> EV[("Evidence base")]
    A2 --> EV
    A3 --> EV
    A4 --> EV
    A5 --> EV
    A6 --> EV
    EV -.->|"interpretation,<br/>not fact"| MS
    EV --> VF{{"Verifiers"}}
    VF -->|"failed checks<br/>down-weight the seat"| PM
    MS --> BULL["Bull"]
    MS --> BEAR["Bear"]
    EV --> BULL
    EV --> BEAR
    BULL --> PM{{"Portfolio manager"}}
    BEAR --> PM
    PM --> R[["final_report.md"]]
```

大师从事实分叉，而非从分析师的证据包分叉。让 21 位大师共用一位分析师对「什么重要」的取舍，会给他们同一个盲区 —— 一个又大又完全相关的误差 —— 也就取消了设立议席的理由。

关键文件:

- `.codex-plugin/plugin.json` —— Codex 插件元数据
- `.claude-plugin/plugin.json` —— Claude Code 插件清单
- `.mcp.json` —— MCP server 接线
- `skills/alphacouncil-agent/SKILL.md` —— 运行时指令
- `mcp/server.mjs` —— JSON-RPC MCP server 与工作流实现
- `scripts/selfcheck.mjs` —— 最小回归自检

## 🆚 Codex 版 vs Claude Code 版

两个版本共享同一套工作流、JSON 包契约、审计产物、无需 API key 的联网取证模式和同样的免责声明。Claude Code 版只改变「**怎么跑**」这个委员会。

| | Codex 版 | Claude Code 版 |
|---|---|---|
| 委员会执行 | `codex exec` worker,有并发上限 | 11 个分析师作为并行 `Task` 子代理,一次性展开 |
| 每个分析师上下文 | 独立进程 | 独立子代理,各自完整独立上下文窗口 |
| 取证 | `codex exec --search` | 每个分析师在自己上下文里用 `WebSearch` + `WebFetch` |
| 证据 → 辩论 | 串行 | 基于运行相位机的硬性 barrier 门控 |
| 辩论深度 | 3 轮(立论/反驳/问答),server 执行 | 3 轮,每轮多空并行 |
| claim 验证 | 缺失来源门禁(运行被标记 + 报告横幅) | + 逐条对抗式验证:重抓引用 URL + 独立复核 + 反驳 *(宿主驱动)* |
| 完整度强制 | 残缺运行标 `incomplete`(server 门禁) | 同门禁,外加辩论前硬 barrier |
| 模型与成本 | 单一模型 | **按角色选** —— 取证用 Sonnet,辩论/裁决用 Opus 4.8(也可全 Opus / 全 Sonnet) |
| 语言 | 用户语言 | 每个子代理 + 实时 workflow 全程用户语言 |

**诚实边界:** 同模型家族、同提示词、同审计契约 —— 优势在于上下文隔离、始终并行展开、确定性门禁,**不是**更聪明的模型。自 **v0.3.0** 起,共享 server 会执行 3 轮辩论,强制执行「缺失来源 / 完整流程 / 报告质量」门禁,写出简洁交付摘要、完整报告和文件索引,并支持 Windows 原生 Codex CLI 启动。自 **v0.3.1** 起,插件内置 `agent-skills-governance`,提供 `addyosmani/agent-skills` 风格的防偷懒停止门禁和完成标准。Claude Code 版额外提供每轮并行执行和宿主驱动的逐条 claim 验证。联网数据的时效性与付费墙对两版限制相同。

## 数据契约

证据子代理返回 JSON 包:

```json
{
  "task": "market_data",
  "symbol": "0700.HK",
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

所有 source ID 都按 `<task>:<source_id>` 全局作用域。缺失数据必须写进 `open_questions`,并体现在最终报告的数据缺口章节。

## 本地运行

```bash
npm run check
```

自检会校验:MCP server 语法、工具 schema 暴露、source ID 作用域、默认真跑行为、可见运行录入、`events.jsonl`/`status.json`/`all_agents.md`/`source_manifest.json`,以及 `final_report.md`、`user_response.md`、`artifact_index.md`、`report_quality.json`、分析师 Markdown 文件和最终报告章节完整性。

## 说明

这是一个独立的插件实现,采用多代理投资委员会工作流:分析师团队、证据共享、多空辩论、投资组合经理综合。

请勿提交任何 API key、券商凭证、非公开文件或生成的运行产物。

## ⭐ Star 趋势

<div align="center">

<a href="https://star-history.com/#Zhao73/alphacouncil-agent&Date">
  <img src="https://api.star-history.com/svg?repos=Zhao73/alphacouncil-agent&type=Date" width="640" alt="Star History Chart" />
</a>

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
  <img src="assets/logo.png" alt="AlphaCouncil" width="120" />
</picture>

如果 AlphaCouncil 帮你省了时间,点个 ⭐ 是最大的支持。

<a href="#readme-top">↑ 回到顶部</a>

</div>
