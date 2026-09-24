<p align="center">
  <img src="assets/logo.svg" width="96" alt="Verdict 标志">
</p>

<h1 align="center">Verdict</h1>

<p align="center">
  <b>随手可用的股票研究台 —— 终端、Claude Code、Codex 都能用。</b><br>
  几秒拿到实时数据 · 四位分析师并行研究 · 多空辩论 · 一个带价格区间的明确结论。
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#10-秒试用">试用</a> ·
  <a href="#全屏应用">全屏应用</a> ·
  <a href="#claude-code-与-codex">Claude Code 与 Codex</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="assets/app.svg" alt="Verdict 全屏应用（虚构公司示例）" width="100%">
</p>

## 你会得到什么

像问同事一样提问：`verdict NVDA`、`verdict "0700.HK 现在贵吗？"`、`verdict AMD 财报前值得拿着吗`。大约三分钟后，你会拿到：

- **结论**：买入 · 增持 · 持有 · 减持 · 卖出，附置信度，并直接回答你的问题。
- **估值区间**：悲观 / 基准 / 乐观的每股价值、推导方法，以及现价距离基准价值有多远。
- **价格条件**：什么价位回避、从哪里开始建仓、跌到哪里加仓，以及现价落在哪个区间。
- **多空双方的论证**：最强的做多理由和做空理由，以及最后谁胜出。
- **后续关注点**：带日期的催化剂、按严重程度排序的风险、仓位计划，以及什么情况说明判断错了。
- **可追溯的依据**：每条发现都能打开对应来源；缺失的数据会明确列出，绝不靠猜。
- **可分享的报告**：Markdown 版，外加一个带价格走势图的独立 HTML 页面。

## 工作方式

```
 快照 ─▶ 4 个研究台 ─▶ 多头 ┐
（代码，2 秒）  并行研究        ├─▶ 投资经理 ─▶ 结论 + 报告
               业务 · 预期     │   （边写边显示）
               新闻 · 风险 空头 ┘
```

1. **快照**：在任何模型运行之前，先由代码并行抓取价格、历史走势、SEC 财务与估值倍数、公告、期权、带日期的新闻，以及 8 个确定性的方法筛选。
2. **研究台**：四位分析师基于快照并行研究，每人大约做 5 次针对性搜索。研究侧重会跟着你的问题走：财报、估值、短线交易、长期持有，还是风险。
3. **辩论**：多头和空头基于研究记录，同时各自陈述。
4. **决策**：投资经理综合所有信息作出判断，结论会边写边显示在你眼前。
5. **报告**：由代码根据保存下来的结果拼装，任何内容都不会在总结时丢失。

`--fast` 只做一轮研究就直接给结论，大约一分钟。

## 安装

```bash
npm install -g github:Zhao73/verdict
verdict doctor            # 检查 Node、引擎和各个数据源
```

需要 Node 20 及以上版本，外加下面任意一个引擎：

| 引擎 | 何时使用 | |
|---|---|---|
| **api** | 设置了 `ANTHROPIC_API_KEY` | 最快。使用官方 Anthropic SDK，支持流式输出和服务端网页搜索。 |
| **claude** | 已安装并登录 Claude Code | 使用你的 Claude Code 订阅，每一步是一次无头 `claude -p` 调用。 |

默认自动选择，也可以用 `--engine api|claude` 指定。

## 10 秒试用

不需要 Key，也不需要联网，拿一家虚构公司完整跑一遍：

```bash
verdict demo           # 命令行模式
verdict demo --app     # 全屏应用
```

## 全屏应用

直接运行 `verdict`，不带任何参数。

<p align="center"><img src="assets/evidence.svg" alt="证据页：每条发现和它的来源" width="100%"></p>

- **命令栏**：输入股票代码或问题；也可以用 `/fast`、`/compare NVDA AMD AVGO`、`/watch`、`/track`、`/export`、`/lang zh-CN`、`/help`。
- **侧栏**：自选股（价格、当日涨跌、上次结论）和研究历史。
- **标签页**：*结论*卡片 · 完整*报告* · *证据*（选中一条发现后按回车查看来源） · *追问*（根据报告回答）。
- **按键**：`Tab` 切换焦点 · `← →` 或 `1-4` 切换标签 · `↑ ↓ PgUp PgDn` 或滚轮滚动 · `w` 加入自选 · `x` 导出 HTML · `?` 帮助 · `q` 退出。浏览其他内容时，研究会在后台继续进行。

## 单条命令

<p align="center"><img src="assets/live.svg" alt="命令行模式：实时进度和正在撰写的结论" width="100%"></p>

```bash
verdict NVDA                          # 深度研究：实时进度，然后给出结论卡片
verdict AAPL "现在贵吗？"             # 结论会直接回答你的问题
verdict 7203.T --fast --lang ja       # 快速结论，用日语输出
verdict compare NVDA AMD AVGO         # 分别研究后排名
verdict watch add NVDA AAPL           # 自选股提醒：价格进入某个区间、有新公告、结论已过时
verdict track                         # 历史结论之后的实际表现
verdict ask NVDA "如果加息呢？"
verdict history · verdict show NVDA · verdict export NVDA
verdict quote|snapshot|news|filings|options|lenses NVDA · verdict macro     # 只看数据，不调用模型
```

结论出来后可以当场继续追问。6 小时内再查同一只股票，会直接复用已有结论，加 `--fresh` 可以重新研究。`--json` 会输出完整结果，方便写脚本。

## Claude Code 与 Codex

**Claude Code**

```text
/plugin marketplace add Zhao73/verdict
/plugin install verdict@verdict
```

之后输入 `/verdict NVDA`、`/verdict AAPL 值得买吗`，或者直接说“研究一下 NVDA”。4 个 `desk` 子代理并行研究，2 个 `advocate` 子代理分别论证多空，最后由 Claude 做决策。插件自带的 MCP 服务器负责提供快照、每个任务的说明、结果校验和报告。如果不想每次都弹出权限确认，可以在 `/permissions` 里允许 `mcp__plugin_verdict_verdict__*`、`WebSearch` 和 `WebFetch`。

**Codex**

```bash
codex plugin marketplace add Zhao73/verdict
codex plugin add verdict@verdict
```

重启 Codex 后输入 `@verdict research NVDA`。

所有入口共用 `~/.verdict/` 目录：在 Claude Code 里得出的结论，也会出现在终端应用、自选股和历史战绩里。

## HTML 报告

<p align="center"><img src="assets/report.png" alt="带价格图、估值区间和价格条件的 HTML 报告" width="720"></p>

在全屏应用里按 `x`，或者运行 `verdict export NVDA`，就会把报告保存到当前目录。报告是单个文件，不含任何脚本，会跟随系统切换浅色或深色主题。

## 数据

全部来自无需 Key 的公开来源，并缓存在本地：Yahoo Finance（延迟行情、历史走势、代码搜索）、SEC EDGAR（XBRL → TTM 指标与估值倍数；公告）、Google News（带日期的新闻标题）、Cboe（延迟期权）、FRED（宏观数据）。ETF 通过持仓来研究，指数通过编制方法来研究，都不会当作一家公司来处理。某个来源取不到时，报告会点名列出这个缺口。建议设置 `VERDICT_SEC_CONTACT=你的邮箱`，因为 SEC 要求请求中带联系方式。

## 开发

```bash
git clone https://github.com/Zhao73/verdict && cd verdict && npm install
npm test          # 45 个测试，全部离线
npm run shots     # 用真实的渲染代码重新生成 README 截图
```

---

<sub>Verdict 由 AI 基于公开来源生成研究内容，不构成投资建议，也可能出错。行动之前请先核对来源。截图使用的是虚构公司。MIT 许可。</sub>
