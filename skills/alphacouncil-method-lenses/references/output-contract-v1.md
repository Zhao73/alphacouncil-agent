# Method lens output v1

Return one object per selected method:

```json
{
  "schema_version": 1,
  "method_id": "master_buffett",
  "reference_status": "method_reference_provisional",
  "language": "zh",
  "voice_mode": "first_person_public_method_simulation_v1",
  "disclosure_ack": "alphacouncil.first_person_public_method_simulation.v1",
  "disclosure": "AI 公开方法模拟，非本人原话。",
  "decision_authority": "deterministic_executor|llm_method_application",
  "stance_status": "frozen|advisory|out_of_scope",
  "acknowledged_input_hash": "sha256:...",
  "applicability": { "status": "in_scope|partial|out_of_scope", "reasons": [] },
  "native_state": "method-native state or null",
  "common_stance": "constructive|cautious|opposed|out_of_scope",
  "critical_facts_read": [],
  "tool_results": [],
  "decisive_rule_ids": [],
  "contract_findings": [],
  "claims": [
    { "type": "input_fact|method_rule|inference", "text": "...", "source_ids": [] }
  ],
  "counterevidence": [],
  "missing_fact_ids": [],
  "what_changes_the_reading": [],
  "position_intent": "would_buy|would_add|would_hold|would_watch|would_pass|would_avoid|not_in_my_circle",
  "voice": {
    "would_i_act": "我会……",
    "what_i_see": "我看到……",
    "how_my_method_reads_it": "我先……",
    "where_i_disagree": "我不同意……",
    "what_changes_my_mind": "如果……我会改变判断。"
  },
  "confidence": "high|medium|low"
}
```

Rules:

- When a frozen result exists, `acknowledged_input_hash`, `native_state`, `common_stance`, and `decisive_rule_ids` must match exactly.
- A method rule cites the reference rule ID; an input-fact claim cites source IDs; an inference cites all load-bearing source IDs.
- `voice_mode` and `disclosure_ack` are exact constants. `disclosure` must byte-match the localized system text in `first-person-voice-contract-v1.md`.
- Every `voice` field is required and must contain an explicit first-person marker for `language`. `would_i_act` is rendered first. A third-person summary is invalid.
- The voice must follow the selected reference's distinctive question order and vocabulary. It must not claim real identity, biography, quotation, current holding/view, private information, or endorsement.
- Never emit an unsupported number, invalid source ID, or fabricated quotation.
- Missing critical inputs force `out_of_scope`; partial optional coverage lowers confidence and must appear in `missing_fact_ids`.
- A provisional contract finding must appear in `contract_findings`; an affected comparison cannot support a directional method claim before adjudication.
- A selected method must always produce either a complete object or an explicit error object. Aggregation must not hide failed or abstaining methods.
