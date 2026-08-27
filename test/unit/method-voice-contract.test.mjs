import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMasterVoice } from "../../mcp/lib/packets.mjs";
import {
  FIRST_PERSON_DISCLOSURE_ACK,
  FIRST_PERSON_VOICE_MODE,
  VOICE_DISCLOSURES,
  VOICE_FIELDS,
} from "../../mcp/lib/voice.mjs";

const master = "master_buffett";
const frozen = {
  master,
  stance: "cautious",
  confidence: "medium",
  source_ids: ["market_data:S1"],
  evidence_source_ids: ["market_data:S1"],
  method_source_ids: ["proxy:buffett-fixture"],
};
const runtimeRun = (language = "English") => ({
  symbol: "TEST",
  as_of: "2026-08-03",
  language,
  packets: [{ task: "market_data", sources: [{ id: "market_data:S1" }] }],
  grounding: {
    typed_fact_sources: [{
      source_id: "grounding:outside-bounded-voice",
      title: "Grounding source outside the bounded method voice fixture",
    }],
  },
  master_runtime_provenance: {
    [master]: {
      method_sources: [{
        source_id: "proxy:buffett-fixture",
        source_kind: "derived_proxy",
        title: "Fixture method definition",
        url: "https://example.com/method-definition",
      }],
    },
  },
});

const localeVoice = {
  English: {
    would_i_act: "I would keep this on my watch list.",
    what_i_see: "I see a bounded record with a material fact gap.",
    how_my_method_reads_it: "I first test my circle of competence and owner economics.",
    where_i_disagree: "I disagree with replacing cash evidence with a story.",
    what_changes_my_mind: "I would change my mind when the missing cash evidence arrives.",
  },
  中文: {
    would_i_act: "我会继续观察，不会现在动手。",
    what_i_see: "我看到这份记录仍有关键事实缺口。",
    how_my_method_reads_it: "我先检查能力圈和所有者收益。",
    where_i_disagree: "我不同意用故事替代现金证据。",
    what_changes_my_mind: "如果缺失的现金证据补齐，我会改变判断。",
  },
  日本語: {
    would_i_act: "私は今は動かず、監視を続けます。",
    what_i_see: "私は重要な事実が欠けた記録を見ています。",
    how_my_method_reads_it: "私はまず能力の輪とオーナー利益を確認します。",
    where_i_disagree: "私は物語で現金の証拠を置き換えることに反対します。",
    what_changes_my_mind: "不足する現金の証拠が揃えば、私は判断を変えます。",
  },
  한국어: {
    would_i_act: "저는 지금 행동하지 않고 계속 지켜보겠습니다.",
    what_i_see: "저는 핵심 사실이 빠진 기록을 보고 있습니다.",
    how_my_method_reads_it: "저는 먼저 제 능력 범위와 소유주 이익을 확인합니다.",
    where_i_disagree: "저는 이야기로 현금 증거를 대체하는 데 동의하지 않습니다.",
    what_changes_my_mind: "현금 증거가 갖춰지면 저는 판단을 바꾸겠습니다.",
  },
};

function packet(language = "English", over = {}) {
  return {
    master,
    acknowledged_stance: "cautious",
    voice_mode: FIRST_PERSON_VOICE_MODE,
    disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
    position_intent: "would_hold",
    voice: localeVoice[language],
    key_findings: [],
    disagreements: [],
    what_would_change_my_mind: [],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    ...over,
  };
}

test("all supported locales preserve the exact five-field strong first-person voice", () => {
  const keys = { English: "en", 中文: "zh", 日本語: "ja", 한국어: "ko" };
  for (const [language, key] of Object.entries(keys)) {
    const normalized = normalizeMasterVoice(packet(language), master, {
      ...runtimeRun(language),
    }, frozen);
    assert.deepEqual(Object.keys(normalized.voice), [...VOICE_FIELDS]);
    assert.equal(normalized.voice_mode, FIRST_PERSON_VOICE_MODE);
    assert.equal(normalized.disclosure_ack, FIRST_PERSON_DISCLOSURE_ACK);
    assert.equal(normalized.disclosure, VOICE_DISCLOSURES[key]);
    assert.equal(normalized.position_intent, "would_hold");
    assert.ok(normalized.statement.startsWith(`${language === "中文" ? "我会不会动手" : language === "日本語" ? "私なら動くか" : language === "한국어" ? "나라면 움직이는가" : "Would I act"}:`));
  }
});

test("flat, third-person, unacknowledged, or stance-widening method voices fail closed", () => {
  assert.throws(() => normalizeMasterVoice({
    ...packet(), voice: undefined, statement: "I would hold.",
  }, master, runtimeRun(), frozen), /voice fields/u);

  assert.throws(() => normalizeMasterVoice(packet("English", {
    voice: { ...localeVoice.English, what_i_see: "Buffett would inspect the record." },
  }), master, runtimeRun(), frozen), /non-first-person/u);

  assert.throws(() => normalizeMasterVoice(packet("English", {
    disclosure_ack: "removed",
  }), master, runtimeRun(), frozen), /identity disclosure/u);

  assert.throws(() => normalizeMasterVoice(packet("English", {
    position_intent: "would_buy",
  }), master, runtimeRun(), frozen), /outside the frozen stance/u);
});

test("an abstaining seat rejects directional voice tokens in every supported locale", () => {
  const examples = {
    English: [
      "I would buy after the missing fact arrives.",
      "I would not buy on these inputs.",
      "I recommend buying.",
      "I would add to the position.",
    ],
    中文: ["我会在资料补齐后买入。"],
    日本語: ["私は資料が揃えば買います。"],
    한국어: ["저는 자료가 오면 매수하겠습니다."],
  };
  for (const [language, directionalStatements] of Object.entries(examples)) {
    for (const directional of directionalStatements) {
      const voice = { ...localeVoice[language], where_i_disagree: directional };
      assert.throws(
        () => normalizeMasterVoice(packet(language, {
          acknowledged_stance: "out_of_scope",
          position_intent: "inputs_unavailable",
          voice,
        }), master, runtimeRun(language), { ...frozen, stance: "out_of_scope" }),
        (error) => error?.data?.reason === "METHOD_VOICE_DIRECTIONAL_ABSTENTION"
          && error.data.invalid_fields.includes("where_i_disagree"),
        `${language}: ${directional}`,
      );
    }
  }
});

test("the abstention gate accepts sentiment, third-party advice and research verbs without a first-person trade action", () => {
  const examples = {
    English: [
      "I am neither bullish nor bearish on this name because the payoff inputs are missing.",
      "I do not treat that as evidence: analysts recommend buying.",
      "I do not treat that as evidence: the sell-side is bullish.",
      "I short-list the missing filings rather than the thesis.",
      "I do not exit or enter this name; the seat stays silent until the filing lands.",
    ],
    中文: ["我不把它当证据：分析师建议买入。"],
    日本語: ["私は強気でも弱気でもありません。"],
    한국어: ["저는 강세도 약세도 아닙니다."],
  };
  for (const [language, safeStatements] of Object.entries(examples)) {
    for (const prose of safeStatements) {
      const voice = { ...localeVoice[language], how_my_method_reads_it: prose };
      const normalized = normalizeMasterVoice(packet(language, {
        acknowledged_stance: "out_of_scope",
        position_intent: "inputs_unavailable",
        voice,
      }), master, runtimeRun(language), { ...frozen, stance: "out_of_scope" });
      assert.equal(normalized.voice.how_my_method_reads_it, prose, `${language}: ${prose}`);
    }
  }
});

test("dedicated method voice source IDs must resolve to the run source manifest", () => {
  assert.throws(
    () => normalizeMasterVoice(packet("English", { source_ids: ["market_data:FORGED"] }), master, runtimeRun(), frozen),
    (error) => error?.data?.reason === "SOURCE_PROVENANCE_MISMATCH"
      && error.data.unknown_source_ids.includes("market_data:FORGED"),
  );
});

test("method provenance is auditable but cannot satisfy the investment-evidence gate", () => {
  assert.throws(
    () => normalizeMasterVoice(
      packet("English", { source_ids: ["proxy:buffett-fixture"] }),
      master,
      runtimeRun(),
      frozen,
    ),
    (error) => error?.data?.reason === "SOURCE_PROVENANCE_MISMATCH"
      && error.data.source_domain === "evidence"
      && error.data.unknown_source_ids.includes("proxy:buffett-fixture"),
  );
});

test("packet and typed-fact method-source spoofs cannot satisfy a method voice evidence citation", () => {
  const run = runtimeRun();
  run.packets[0].sources.push({
    id: "proxy:packet-spoof",
    source_kind: "market_snapshot",
  });
  run.grounding.typed_fact_sources.push({
    source_id: "grounding:method-definition-spoof",
    source_kind: "method_definition",
  });

  for (const spoofedId of ["proxy:packet-spoof", "grounding:method-definition-spoof"]) {
    assert.throws(
      () => normalizeMasterVoice(
        packet("English", { source_ids: [spoofedId] }),
        master,
        run,
        { ...frozen, source_ids: [spoofedId], evidence_source_ids: [spoofedId] },
      ),
      (error) => error?.data?.reason === "SOURCE_PROVENANCE_MISMATCH"
        && error.data.source_domain === "evidence"
        && error.data.unknown_source_ids.includes(spoofedId),
    );
  }
});

test("a manifest-known evidence ID still fails when it was outside the bounded voice context", () => {
  assert.throws(
    () => normalizeMasterVoice(
      packet("English", { source_ids: ["grounding:outside-bounded-voice"] }),
      master,
      runtimeRun(),
      frozen,
    ),
    (error) => error?.data?.reason === "METHOD_VOICE_SOURCE_SCOPE_MISMATCH"
      && error.data.unknown_source_ids.includes("grounding:outside-bounded-voice"),
  );
});
