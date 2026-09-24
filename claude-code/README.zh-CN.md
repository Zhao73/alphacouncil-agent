# AlphaCouncil for Claude Code

[English](README.md) · **中文**

为股票、ETF 和指数打造的"投研委员会"，完全基于 Claude Code 原生能力重建。一次请求会变成：
并行的分析师子代理 → 确定性方法透镜 → 三轮多空交叉质询 → 投资经理决策，最终由代码汇编成带来源的报告。

同一个委员会，两种运行方式：

| | Claude Code 插件 | 终端客户端 |
|---|---|---|
| 启动 | 在 Claude Code 中输入 `/alpha NVDA` | 在任意终端输入 `alphacouncil NVDA` |
| 席位运行方式 | Claude Code 子代理（并行 `Agent` 调用） | 受监管的无头 `claude -p` 进程 |
| 编排者 | `/alpha` 技能按 MCP 状态机推进 | 客户端按同一状态机确定性推进 |
| 时间上限 | 建议性（子代理生命周期由 Claude Code 管理） | 强制：单席位上限 + 全局截止时间 |
| 共享部分 | `agents/*.md`、`lib/` 状态机、数据包校验、报告渲染、运行目录 `~/.alphacouncil/runs/` |

在一端开始的运行可以在另一端继续：`alphacouncil resume latest`。

## 一次运行如何进行

```
council_plan ──► 用户确认 ──► council_start（冻结价格、SEC 财务、技术面、期权；计算 8 个透镜）
      │
      ▼
council_next ──► 一波任务 ──► 每个席位研究后调用 council_record(packet)
      ▲                              │  （校验：结构、本地来源 ID、日期、引用；
      └──────────────────────────────┘    错误以"修复指令"返回）
  证据（8 个并行）→ 多空第 1 轮 → 第 2 轮（反驳 + 提问）→ 第 3 轮（回答）→ 投资经理
      │
      ▼
council_finalize ──► final_report.md · transcript.md · report_quality.json · user_response.md
```

- **证据席位（完整 8 个 / 快速 4 个）**：行情数据 · 财报深度 · 预期与修正 · 量化因子与持仓 · 估值与多空 ·
  新闻/行业/管理层 · 内部人与监管文件 · 投行事件。
- **方法透镜（8 个，不调用模型）**：深度价值 · 高质量复利 · GARP · 长期成长 · 趋势与动量 · 股东回报 ·
  资产负债表风险 · 逆向反转。它们在任何模型写字之前就由冻结的数据算出立场，立场无法被"说服"出来；
  数据不足则为 `out_of_scope`——这是数据缺口，永远不是反对票。
- **辩论**：每一轮内多空并行，轮与轮之间顺序执行；第 3 轮必须逐一回答对方第 2 轮提出的问题编号（强制校验）。
- **投资经理**：五档评级、熊/基准/牛三档估值、至少三档价格条件、催化剂、风险、仓位、三个周期观点、失效条件、数据缺口。
- **报告**：由代码根据已记录的数据包汇编，任何席位、引用或缺口都不会在模型总结时丢失；
  每个引用（`market_data:S3`、`grounding:quote`、`lens:garp`）都必须能在来源表中找到。
- **失败是显式的**：未提交的席位会被重新派发一次，然后标记失败。证据覆盖不足或辩论/决策席位失败
  → `incomplete`；带失败席位完成 → `degraded`。两者都绝不会被称为 complete。

## 安装插件

```bash
# 在 Claude Code 中
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil@alphacouncil
```

重启 Claude Code 后：

```text
/alpha                 查看所有模式
/alpha NVDA            完整委员会（先展示计划并请你确认）
/alpha 0700.HK quick   快速委员会
/alpha AAPL news       免密钥数据，不调用模型（还有 quote、filings、options、lenses、macro）
```

为避免子代理每次调用数据/委员会工具时都弹出权限确认，可一次性允许（`/permissions` 或 `.claude/settings.json`）：

```json
{ "permissions": { "allow": ["mcp__plugin_alphacouncil_alphacouncil__*", "WebSearch", "WebFetch"] } }
```

本地开发：`claude --plugin-dir ./claude-code`。

## 终端客户端

需要 Node ≥ 18 和 Claude Code（`npm i -g @anthropic-ai/claude-code`，已登录或设置 `ANTHROPIC_API_KEY`）。无其他依赖。

```bash
npm i -g ./claude-code          # 或：node claude-code/cli/alphacouncil.mjs …
alphacouncil                    # 交互式：代码 → 问题 → 模式 → 深度 → 语言 → 透镜 → 确认
alphacouncil NVDA --pace slow --lang zh-CN
alphacouncil 7203.T --quick --yes --plain     # 脚本化，逐行输出进度
alphacouncil runs | show latest | status latest | resume latest
alphacouncil quote|news|filings|options|lenses AAPL · alphacouncil macro
alphacouncil doctor --live
```

实时面板显示每个席位的状态、耗时、当前工具调用（搜索词、URL、数据工具）、花费、修复次数以及相对上限的运行时钟。
`Ctrl+C` 停止运行并汇编已记录的内容；`alphacouncil show latest` 在终端中渲染报告（表格按宽度自动换行，支持中日韩字符宽度）。

| 模式 | 工作进程 | 上限（终端） |
|---|---|---:|
| quick | 4 证据 → 1 轮多空 → PM | 10 分钟 |
| full · fast | 8 证据 → 3 轮 → PM，精简输出 | 15 分钟 |
| full · normal | 同上，标准深度 | 30 分钟 |
| full · slow | 同上，写出完整推导 | 60 分钟 |

上限是硬性截止，不是预期耗时。

## 数据

全部为免密钥公开来源，每个结果都带来源与获取日期：Yahoo Finance（延迟行情、日线）、SEC EDGAR（XBRL
财务 → TTM 指标与估值倍数；公告）、Google News RSS（仅限有日期的标题）、Cboe 延迟期权（看跌/看涨比、
ATM 隐含波动率期限结构、25-delta 偏斜）、FRED（利率、曲线、CPI、VIX、信用利差、美元）。ETF 走持仓穿透，
指数走整体方法论，绝不为一篮子资产拼凑"公司财报"。来源不可达时，报告会点名写出缺口。

`npm test` 运行测试（无需网络）。研究内容由 AI 基于公开来源生成，不构成投资建议。方法透镜是对公开筛选方法的
确定性重建，并非任何真实人物的观点。
