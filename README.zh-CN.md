<a name="readme-top"></a>

<!-- readme-section:hero -->
<div align="center">

<img src="assets/banner.png" alt="AlphaCouncil Agent" width="100%" />

### 一套可以逐项复核的投资研究议会

**一个问题，展开为带来源的证据、多种方法视角、多空质询和投资组合经理裁决。**

[English](README.md) · **中文** · [日本語](README.ja.md)

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
</p>
<p>
  <img src="https://img.shields.io/badge/MCP-compatible-000000?style=for-the-badge" alt="兼容 MCP" />
  <img src="https://img.shields.io/badge/API_keys-none_required-2ea043?style=for-the-badge" alt="无需 API 密钥" />
  <img src="https://img.shields.io/badge/runtime_dependencies-zero-2ea043?style=for-the-badge" alt="零运行时依赖" />
</p>

[安装](#在-codex-中安装) · [先验数据层](#免费首次运行) · [查看调用展开方式](#运行前先选深度) · [阅读报告](docs/examples/final_report.SOX.zh.md)

</div>

<!-- readme-section:demo -->
<div align="center">

<img src="assets/demo-zh.gif" alt="AlphaCouncil 分析席收集证据、辩论并形成投资组合经理裁决" width="100%" />

**[观看 MP4](assets/demo.mp4)** · [查看静态图](assets/run-example.png) · [阅读完整 SOX 报告](docs/examples/final_report.SOX.zh.md)

</div>

<!-- readme-section:promise -->
## 一个问题，一套可复核的论证

AlphaCouncil 把证券问题变成可检查的研究流程：并行证据席从公开来源取证，所选投资方法席解读同一批带日期事实，多方与空方交叉质询，最后由投资组合经理记录结论及其失效条件。缺失输入会原样暴露，不会用猜测补齐。

同一仓库支持 **Codex、Claude Code、OpenCode、Grok Build**。研究前会先区分公司、ETF 和市场指数，避免把一篮子资产当作有自身营收的公司来分析。

<!-- readme-section:install -->
## 在 Codex 中安装

前提：Node.js 18 或更高版本。粘贴下面三行：

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
@alphacouncil-agent analyze AAPL
```

Claude Code、OpenCode、Grok Build、Windows、故障排查及可选 npm 全局命令，请看 **[完整安装指南](docs/INSTALL.md)**。

<!-- readme-section:first-run -->
## 免费首次运行

启动研究议会前，先检查免密钥公开数据层：

```text
# Codex
@alphacouncil-agent AAPL news

# Claude Code、OpenCode、Grok Build
/alpha AAPL news
```

这一步不启动议会工作单元，也不需要数据商密钥。Codex 的有界研究命令是 `@alphacouncil-agent AAPL quick`；另外三个斜杠命令宿主使用 `/alpha AAPL quick`。

<!-- readme-section:call-structure -->
## 运行前先选深度

AlphaCouncil 会先展示工作计划。完整研究把方法席、证据范围和深度分开询问，得到用户确认后才启动。三档完整研究的上限为 **15 / 30 / 60** 分钟，不提供没有实测凭据的 token 或金额估算。

| 运行方式 | 模型调用结构 | 时间上限 |
|---|---|---:|
| 数据检查 | 只调用免密钥工具；不启动议会工作单元，不增加模型扇出 | 不属于议会档位 |
| 快速研究 | 4 个证据席并行 → 1–4 个方法席并行 → Bull/Bear 并行 → PM | 10 分钟 |
| 完整—快速档 | 8 个核心或恰好 11 个全范围证据席同时启动；每个所选方法先确定性冻结立场，再由一个隔离工作单元解释；3 轮辩论 → PM | 15 分钟 |
| 完整—普通档 | 保留同一确认席位、冻结立场顺序、3 轮辩论和 PM，深度空间更大 | 30 分钟 |
| 完整—慢速档 | 保留同一确认席位与阶段，使用最大深度空间 | 60 分钟 |

只有“慢速档 + 全部方法 + 全部证据席”会启用附加验证路径；其他完整档位不声称做了这项额外检查。

<!-- readme-section:benefits -->
## 你真正得到什么

| 收益 | 改变在哪里 |
|---|---|
| **是议会，不是一段答案** | 证据专家、方法席、对立论证和 PM 会把共识从何而来展示出来。 |
| **先有立场，再写故事** | 完整研究中，每个所选方法先基于结构化输入冻结立场，再由隔离工作单元写解释。 |
| **每条重要主张可追溯** | 报告的重要主张必须指向来源 ID；缺失证据保留为明确缺口。 |
| **异议不会在总结中消失** | 三轮交叉质询以及持久化的少数/反方报告，让落败论点仍可复核。 |
| **按资产类型走正确路径** | 公司读发行人证据，ETF 做带日期持仓穿透，指数走聚合方法；首次数据检查无需密钥。 |

<!-- readme-section:comparison -->
## 架构上的区别

下表比较的是通用工作流形态，不针对任何具名产品；具体工具可能采用不同设计。

| 复核重点 | 单模型回答或常见共享上下文流程 | AlphaCouncil |
|---|---|---|
| 相关错误 | 同一上下文可能把早期错误传进后续所有步骤 | 证据席与相反路径运行在隔离工作单元中；它们仍可能使用同一提供商或模型，**并非独立模型** |
| 立场形成 | 立场可能与解释同时生成 | 结构化立场在解释性文字之前冻结 |
| 来源追溯 | 可追溯程度取决于提示词和宿主 | 每条重要主张都必须携带来源 ID |
| 少数意见 | 异议可能被折叠进最终摘要 | 少数意见和反方报告作为复核产物显式保留 |

<!-- readme-section:honesty -->
## 这些议席是什么，又不是什么

方法席公式是**由 AI 根据已出版方法形成的重构，尚待人工评审**。具名实践者没有审核或背书这些议席。它们不是人格模仿、独立模型或经过验证的复制品。立场只是需要对照输入和来源进行检查的结构化论证，不是已验证的投资模型。

<!-- readme-section:disclaimer -->
## 免责声明

AlphaCouncil **仅供教育和研究**，不构成投资建议、买卖推荐或要约。AI 分析可能不完整、过时或错误。做出投资决定前请自行核验，并咨询持牌专业人士。作者不对任何损失承担责任。

<!-- readme-section:reference-fold -->
## 深入了解

- [中文详细产品、用法、工具与架构参考](docs/reference/README.zh-CN.md)
- [四宿主完整安装指南](docs/INSTALL.md)
- [报告合同](docs/report-contract.md)与[完整示例报告](docs/examples/final_report.SOX.zh.md)
- [路线图](docs/roadmap.md)、[安全模型](SECURITY.md)、[署名说明](docs/attribution.md)与[更新日志](CHANGELOG.md)
- 本地界面：`npm run tui` 和 `npm run gui`

运行产物写在仓库之外的 `~/.alphacouncil-agent/runs/<run_id>/`。

<div align="center">

<img src="assets/logo.png" alt="AlphaCouncil" width="120" />

**证据优先，异议可见，结论可复核。**

<a href="#readme-top">↑ 回到顶部</a>

</div>
