# PersonaPack v3 deterministic policy DSL 1.1

PersonaPack v3 的方法决策不是提示词表演。物理包声明时点一致的 typed facts、纯数据工具图和纯数据决策政策；运行时匿名执行、冻结并哈希结构化结论。语言模型不能选择立场，也不能在缺数据时补数或回退到旧 prompt lens。

权威 schema：

- `schemas/persona-v3.schema.json`
- `schemas/persona-v3-decision-policy-v1.schema.json`
- `schemas/persona-v3-tool-graph-v1.schema.json`

加载器还执行 JSON Schema 无法完整表达的语义门禁：required/optional 事实集合不得重叠且并集非空、引用闭包、工具拓扑、精确分数和、工具 schema hash、来源锚点、native state 完整映射，以及 manifest/policy DSL 版本一致性。

## 决策层与缺失数据

`capability.required_fact_types` 是临界事实。缺少任一项时不运行政策，直接使用 `fact_gate.on_missing_critical` 冻结 `out_of_scope` 结论。

`capability.optional_fact_types` 可缺失，但缺失行为必须逐处明示：

- 工具：`on_missing: "fail" | "skip"`；
- 资格条件：`on_false` 和 `on_uncomputable`；
- 硬否决：`on_trigger` 和 `on_uncomputable.action: "trigger" | "abstain"`；
- native 输出：`on_missing: "fail" | "omit" | "null"`；
- 评分：每条规则返回 `computable`，不足 `min_coverage` 时不发布分数。

`native_decision.state` 是方法专属状态，例如 `leverage_ruin_reject` 或 `insufficient_tail_grounding`。它不得使用四个公共立场名称。只有 `common_projection.stance` 使用 `constructive | cautious | opposed | out_of_scope`。所有可能路径的 native state 必须在 `native_states` 声明，且不得声明永远不可达的状态。

## 决策政策示例

```json
{
  "schema_version": 1,
  "dsl_version": "1.1",
  "native_decision_schema": "owner_earnings_native_v1",
  "native_states": [
    "critical_facts_missing",
    "business_not_explainable",
    "business_evidence_missing",
    "leverage_ruin_reject",
    "leverage_evidence_missing",
    "insufficient_owner_evidence",
    "owner_candidate",
    "owner_watch",
    "owner_reject"
  ],
  "abstention_policy": "fail_closed",
  "fact_gate": {
    "on_missing_critical": {
      "native_state": "critical_facts_missing",
      "common_stance": "out_of_scope"
    }
  },
  "eligibility": {
    "all": [{
      "condition_id": "business.explainable",
      "condition": {
        "op": "eq",
        "left": { "fact_id": "business.explainable" },
        "right": { "literal": true }
      },
      "source_ids": ["source:primary:1"],
      "on_false": { "native_state": "business_not_explainable", "common_stance": "out_of_scope" },
      "on_uncomputable": { "native_state": "business_evidence_missing", "common_stance": "out_of_scope" }
    }]
  },
  "hard_vetoes": [{
    "veto_id": "leverage.ruin",
    "condition": {
      "op": "gt",
      "left": { "fact_id": "finance.debt_ratio" },
      "right": { "literal": 2 }
    },
    "source_ids": ["source:primary:1"],
    "on_trigger": { "native_state": "leverage_ruin_reject", "common_stance": "opposed" },
    "on_uncomputable": {
      "action": "abstain",
      "decision": { "native_state": "leverage_evidence_missing", "common_stance": "out_of_scope" }
    }
  }],
  "scoring": {
    "max_score": 5,
    "min_coverage": 0.5,
    "on_insufficient_coverage": {
      "native_state": "insufficient_owner_evidence",
      "common_stance": "out_of_scope"
    },
    "rules": [{
      "rule_id": "cash.owner_earnings_positive",
      "condition": {
        "op": "gt",
        "left": { "output_id": "cash.owner_earnings" },
        "right": { "literal": 0 }
      },
      "points": 5,
      "coverage_weight": 1,
      "source_ids": ["source:primary:1"]
    }]
  },
  "score_bands": [
    { "min_ratio": 0.7, "decision": { "native_state": "owner_candidate", "common_stance": "constructive" } },
    { "min_ratio": 0.4, "decision": { "native_state": "owner_watch", "common_stance": "cautious" } },
    { "min_ratio": 0, "decision": { "native_state": "owner_reject", "common_stance": "opposed" } }
  ],
  "native_output_fields": [{
    "field": "owner_earnings",
    "value": { "output_id": "cash.owner_earnings" },
    "on_missing": "fail"
  }]
}
```

覆盖率与得分比率是两个独立量：

- `coverage = 可计算规则的 coverage_weight / 全部规则的 coverage_weight`；
- 覆盖率低于 `min_coverage` 时，`score.status = insufficient_coverage`、`score.score = null`、`ratio = null`，结论必须是 `out_of_scope`；
- 覆盖率达标后，`ratio = 命中规则 points / 可计算规则 points`，再匹配 `score_bands`。

例如尾部风险包四条可选规则只算出一条：覆盖率 `1/4 = 0.25`，若门槛为 `0.5`，系统冻结 `insufficient_tail_grounding / out_of_scope`，不会把这一条规则当成完整模型评分。

## 工具图

```json
[
  {
    "schema_version": 1,
    "dsl_version": "1.1",
    "id": "cash.owner_earnings",
    "version": "1.0.0",
    "kind": "recomputation",
    "operation": "subtract",
    "on_missing": "fail",
    "inputs": [
      { "output_id": "cash.pre_maintenance" },
      { "fact_id": "finance.maintenance_capex" }
    ],
    "input_contracts": [
      {
        "value_kind": "monetary",
        "unit": "currency_units",
        "period": { "basis": "duration", "window": "P1Y", "alignment": "same_period" },
        "on_missing": "fail"
      },
      {
        "value_kind": "monetary",
        "unit": "currency_units",
        "period": { "basis": "duration", "window": "P1Y", "alignment": "same_period" },
        "on_missing": "fail"
      }
    ],
    "output_id": "cash.owner_earnings",
    "value_kind": "monetary",
    "unit": "currency_units",
    "output_period": { "basis": "duration", "window": "P1Y", "alignment": "same_period" },
    "input_schema_hash": "sha256:...",
    "output_schema_hash": "sha256:...",
    "source_ids": ["source:primary:1"],
    "formula_spec_id": "cash.owner_earnings.prototype_v1.formula_spec_v1",
    "formula_spec_hash": "sha256:...",
    "formula_review_subject_hash": "sha256:...",
    "approval_bundle_hash": "sha256:..."
  }
]
```

支持的纯算术操作：`identity`, `add`, `subtract`, `multiply`, `divide`, `sum`, `mean`, `min`, `max`, `abs`, `negate`, `clamp`。支持的条件：`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `date_gt`, `date_gte`, `date_lt`, `date_lte`, `exists`, `all`, `any`, `not`。

工具 hash 必须调用 `deterministicToolSchemaHashes(tool)` 生成。输入 hash 绑定 DSL 版本、工具 ID/版本、操作、缺失策略、操作数以及每个输入的值类型、单位、周期与缺失合同；输出 hash 绑定 DSL 版本、工具 ID/版本、输出 ID、值类型、单位和周期。两个 hash 都同时绑定来源 ID、完整 formula spec hash、review subject hash 与双签 approval bundle hash，因而工具不能脱离审核证据单独改写；审核主体 ID 保留在 release evidence 中，不进入匿名执行合同。执行前会把事实的 `value_kind`、`unit`、`period_start`、`period_end`、`fiscal_year` 与 `as_of` 对照这些合同；不一致直接失败。下游工具引用上游输出时，输入合同也必须与上游输出合同完全一致。

执行器不提供 `eval`、回调、属性路径、模板、正则、时钟、随机数、文件系统、网络或模型调用。未知字段/操作、前向引用、环、除零、非有限值、类型错误和 hash 篡改均阻断物理 v3 席位；该席位不会回退到同名旧提示词。
