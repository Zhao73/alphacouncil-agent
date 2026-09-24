<div align="center">

<img src="assets/logo-icon.png" width="72" alt="" />

# AlphaCouncil

**快速的 AI 股票研究 —— 终端、Claude Code、Codex 都能用。**

[English](README.md) · **中文**

</div>

```
$ alpha NVDA 现在值得买吗？

◆ NVDA  NVIDIA Corp · NASDAQ · equity
  价格 228.87 USD +1.2%   52w 131–240   12个月 +61% · P/E 46 · FCF 2.1%
  透镜 deep− quality+ garp~ growth+ trend+ …

研究台
  ✓ 业务与财报             1:31  mixed
  ✓ 预期与估值             1:24  bullish
  ✓ 新闻、行业与催化剂     1:04  mixed
  ✓ 持仓与风险             1:28  mixed
辩论
  ✓ 多头                   0:21
  ✓ 空头                   1:04
决策
  ✓ 投资经理               0:36  Overweight
⏱ 3:12 · $1.53

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NVDA  NVIDIA Corp                                     Overweight ▲  置信度 中
估值 170 / 285 / 380 USD · 基准较现价 +25%
结论  直接回答：值得买，但应分批、控制仓位……
多头  …   空头  …   裁决  多头胜 — …
价格条件  > 280 回避 · 205-235 建仓 · < 198 加仓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
继续追问（回车退出，/report 查看完整报告）
›
```

## 工作方式

1. **快照（几秒，不调用模型）**：价格、技术面、SEC 财务与估值倍数、公告、期权、带日期的新闻，以及 8 个确定性方法透镜，全部并行获取并缓存。
2. **研究台（并行）**：业务与财报 · 预期与估值 · 新闻、行业与催化剂 · 持仓与风险。每个研究台都从快照出发，做约 5 次针对性搜索，返回带来源的发现。
3. **多空辩论（并行）**：多空双方基于研究记录，各自给出最强、最诚实的论证。
4. **投资经理**：评级、悲观/基准/乐观估值、价格条件、催化剂、风险、仓位、分周期观点、失效条件。
5. **报告**：由代码根据保存的结果拼装，任何发现、引用或数据缺口都不会丢。每个输出都有 JSON Schema，代码还会检查每个引用都能对上来源。

`--fast` 只做一轮研究就直接决策（约 1-2 分钟）。实测深度研究：全程 3 分 12 秒，花费 $1.53（Claude Code 引擎）。

## 终端

```bash
npm install -g github:Zhao73/alphacouncil-agent
alpha NVDA                       # 深度研究（默认）
alpha AAPL 现在值得买吗？        # 附带问题，决策会直接回答
alpha 0700.HK --fast             # 快速结论
alpha                            # 交互模式
```

报告出来后可以直接继续追问：先根据报告作答，确有必要时才去搜索；输入 `/report` 可查看完整报告。另外还有 `alpha ask NVDA 如果加息呢？`、`alpha runs`、`alpha show NVDA`，以及不调用模型的数据命令 `alpha quote|snapshot|news|filings|options|lenses NVDA`、`alpha macro`、`alpha doctor`。

**引擎**（自动选择，可用 `--engine` 指定）：

| 引擎 | 何时使用 | 说明 |
|---|---|---|
| `api` | 设置了 `ANTHROPIC_API_KEY` | 官方 Anthropic SDK，流式输出，服务端网页搜索，速度最快。研究和辩论默认用 `claude-sonnet-5`，决策用 `claude-opus-5`（带服务端拒答回退）。 |
| `claude` | 已安装并登录 Claude Code | 每一步是一次无头 `claude -p` 调用，使用你的 Claude Code 订阅；结构化结果通过 `--json-schema` 返回。 |

选项：`--fast`、`--lang zh-CN|ja|en…`（默认使用你输入所用的语言）、`--model`、`--research-model`、`--debate-model`、`--decision-model`、`--fresh`（忽略 6 小时内的旧报告）、`--json`、`--plain`。环境变量：`ALPHA_HOME`（默认 `~/.alphacouncil`）、`ALPHA_SEC_CONTACT`（SEC 要求在 User-Agent 里提供联系方式）、`NO_COLOR`。

## Claude Code

```text
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil@alphacouncil
```

之后输入 `/alpha NVDA`、`/alpha AAPL 值得买吗`、`/alpha 0700.HK --fast`，或者直接说“研究一下 NVDA”。4 个 `analyst` 子代理并行研究，2 个 `advocate` 子代理分别论证多空，最后由 Claude 做决策。自带的 MCP 服务器负责提供快照、每个任务的说明、结果校验和报告。没有任何确认菜单。实测深度研究约 5 分半（子代理启动会多花一些时间，终端客户端更快）。

如果不想每次都弹出权限确认，可以在 `/permissions` 里允许 `mcp__plugin_alphacouncil_alphacouncil__*`、`WebSearch` 和 `WebFetch`。

## Codex

```bash
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil@alphacouncil
```

重启 Codex 后输入 `@alphacouncil research NVDA`。Codex 会用自己的网页搜索按顺序完成同样的任务，数据、任务说明和报告同样由这个 MCP 服务器提供。

## 数据

全部来自免密钥的公开来源，并缓存在磁盘上：Yahoo Finance（延迟行情、历史、搜索）、SEC EDGAR（XBRL → TTM 指标与估值倍数；公告）、Google News（带日期的标题）、Cboe（延迟期权）、FRED（宏观）。ETF 通过持仓来研究，指数通过编制方法来研究，都不会当作一家公司来处理。某个来源取不到时，报告里会点名列为数据缺口。

## 开发

```bash
npm install
npm test        # 32 个测试，无需联网
```

---

研究内容由 AI 基于公开来源生成，不构成投资建议。方法透镜是参照公开投资方法设计的确定性筛选，不代表任何真实人物的观点。MIT 许可。
