<a name="readme-top"></a>

<!-- readme-section:hero -->
<div align="center">

<img src="assets/banner.png" alt="AlphaCouncil Agent" width="100%" />

### An investment-research council you can inspect

**One request becomes sourced evidence, competing method views, a bull/bear challenge, and a portfolio-manager verdict.**

**English** · [中文](README.zh-CN.md) · [日本語](README.ja.md)

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
  <img src="https://img.shields.io/badge/MCP-compatible-000000?style=for-the-badge" alt="MCP compatible" />
  <img src="https://img.shields.io/badge/data_check-no_vendor_key-2ea043?style=for-the-badge" alt="Core data check needs no vendor key" />
  <img src="https://img.shields.io/badge/runtime_dependencies-zero-2ea043?style=for-the-badge" alt="Zero runtime dependencies" />
</p>

[Install](#install-in-codex) · [Try the data layer](#free-first-run) · [See how calls expand](#choose-the-depth-before-it-runs) · [Read a report](docs/examples/final_report.SOX.zh.md)

</div>

<!-- readme-section:demo -->
<div align="center">

**Question → sourced evidence → frozen method stances → Bull/Bear challenge → PM decision + saved audit**

[Historical UI recording (MP4)](assets/demo.mp4) · [Historical report artifact (SOX, Chinese)](docs/examples/final_report.SOX.zh.md)

<sub>The recording predates the current 26-seat candidate. It demonstrates an earlier interface only—not current timing, method fidelity, data accuracy, or four-host end-to-end validation.</sub>

</div>

<!-- readme-section:promise -->
## One question. An inspectable case.

AlphaCouncil turns a ticker question into a reviewable research process. Parallel evidence workers gather public sources, selected investment-method seats interpret the same dated facts, bull and bear challenge the case, and a portfolio manager records the decision and its invalidation conditions. Missing inputs stay visible instead of being filled with guesses.

The same repository supports **Codex, Claude Code, OpenCode, and Grok Build**. It classifies companies, ETFs, and market indices before research so a basket is not analyzed as if it were an operating company.

<!-- readme-section:install -->
## Install in Codex

Prerequisite: Node.js 18 or newer. Install with these two shell commands:

```bash
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

Plugins load when Codex starts. Fully quit and restart Codex, open a new session, then enter this in the Codex composer:

```text
@alphacouncil-agent analyze AAPL
```

For Claude Code, OpenCode, Grok Build, Windows, troubleshooting, and the optional global npm command, use the **[complete install guide](docs/INSTALL.md)**.

<!-- readme-section:first-run -->
## Free first run

Check the keyless public-data layer before starting a council:

```text
# Codex
@alphacouncil-agent AAPL news

# Claude Code, OpenCode, or Grok Build
/alpha AAPL news
```

This check starts no council workers and requires no data-vendor key. For bounded research in Codex, use `@alphacouncil-agent AAPL quick`; on the three slash-command hosts, use `/alpha AAPL quick`.

<!-- readme-section:call-structure -->
## Choose the depth before it runs

AlphaCouncil shows the work plan first. Full research asks separately for method seats, evidence breadth, and depth; the user confirms them before workers start. Full tiers use **15 / 30 / 60** minute ceilings—never a hidden token or currency estimate.

| Run | Model-call structure | Time ceiling |
|---|---|---:|
| Data check | Keyless tools only; no council workers and no additional model fan-out | Outside the council tiers |
| Quick research | 4 evidence workers in parallel → 1–4 method seats in parallel → Bull and Bear in parallel → PM | 10 minutes |
| Full — fast | 8 core or exactly 11 all-scope evidence workers start together; each selected method stance is frozen deterministically before one isolated explanation worker; 3 debate rounds → PM | 15 minutes |
| Full — normal | Same confirmed roster, frozen-stance sequence, 3 debate rounds, and PM, with a larger depth envelope | 30 minutes |
| Full — slow | Same confirmed roster and stages with the largest depth envelope | 60 minutes |

These are queue-to-terminal persistence ceilings, not measured completion times. They guarantee
an explicit terminal record even when work is incomplete; a successful live fast run within 15
minutes has not yet been demonstrated across the four hosts.

When an instrument classification and typed-fact coverage are already available, the selector also
shows an eight-family **advisory method match** derived from all 26 physical pack manifests. It is
only a prefill: every pack remains selectable, no run starts without explicit confirmation, and a
missing classification produces no guessed default. The output represents AI-generated method
simulations—not human experts, independent models, or a promise of profit. See
[method-panel recommendation and seat evidence](docs/reference/method-panel-evidence.md).

Only the slow run with all methods and all evidence workers enables the additional verification path; the other full tiers do not claim that extra check.

<!-- readme-section:benefits -->
## What you gain

| Benefit | What it changes |
|---|---|
| **A council, not one answer** | Evidence specialists, method seats, opposing cases, and a PM expose where agreement comes from. |
| **A stance before the story** | Each selected full-run method stance is fixed from structured inputs before its isolated explanation is written. |
| **Claims you can trace** | Material report claims must point to source IDs; missing evidence remains a stated gap. |
| **Disagreement that survives synthesis** | Three cross-examination rounds and persisted minority or opposing reports keep the losing case available for review. |
| **The right research path for the asset** | Companies use issuer evidence; ETFs use dated holdings look-through; indices use aggregate methodology. The first data check is keyless. |

<!-- readme-section:comparison -->
## How the architecture differs

This compares workflow shapes, not named products. A particular tool may implement a different design.

| Review concern | Single-model reply or common shared-context flow | AlphaCouncil |
|---|---|---|
| Correlated errors | One shared context can carry an early mistake into every later step | Evidence seats and opposing paths run in isolated workers; they may still use the same provider or model and are **not independent models** |
| Position formation | The position can be composed together with its explanation | A structured stance is frozen before explanatory prose |
| Source trace | Traceability depends on the prompt and host | Every material claim is required to carry a source ID |
| Minority view | Dissent can be folded into the final summary | Minority and opposing reports remain surfaced as review artifacts |

<!-- readme-section:honesty -->
## What the seats are—and are not

The method-seat formulas are **AI-authored reconstructions of published methods, pending human review**. The named practitioners have not reviewed or endorsed these seats. They are not impersonations, independent models, or validated replicas. A stance is a structured argument to check against its inputs and sources—not a validated investment model.

Current source evidence boundary: 26 provisional method seats, 0 validated method models, 0/8
registered-and-completed canonical evaluation runs, and 0/4 live-host end-to-end runs. Passing source tests
does not change those zeros.

<!-- readme-section:disclaimer -->
## Disclaimer

AlphaCouncil is for **education and research only**. It is not investment advice, a recommendation, or a solicitation. AI-generated analysis can be incomplete, outdated, or wrong. Verify the evidence yourself and consult a licensed professional before making an investment decision. The authors accept no liability for losses.

<!-- readme-section:reference-fold -->
## Go deeper

- [Detailed English product, usage, tools, and architecture reference](docs/reference/README.en.md)
- [Complete four-host installation guide](docs/INSTALL.md)
- [Report contract](docs/report-contract.md) and [complete example report](docs/examples/final_report.SOX.zh.md)
- [Roadmap](docs/roadmap.md), [security model](SECURITY.md), [attribution](docs/attribution.md), and [changelog](CHANGELOG.md)
- Local interfaces: `npm run tui` and `npm run gui`

Runtime outputs are written outside the repository under `~/.alphacouncil-agent/runs/<run_id>/`.

<div align="center">

<img src="assets/logo.png" alt="AlphaCouncil" width="120" />

**Evidence first. Disagreement visible. Decisions reviewable.**

<a href="#readme-top">↑ Back to top</a>

</div>
