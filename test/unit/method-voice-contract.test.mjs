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
const frozen = { stance: "cautious", confidence: "medium" };
const runtimeRun = (language = "English") => ({
  symbol: "TEST",
  as_of: "2026-08-03",
  language,
  packets: [{ task: "market_data", sources: [{ id: "market_data:S1" }] }],
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

test("dedicated method voice source IDs must resolve to the run source manifest", () => {
  assert.throws(
    () => normalizeMasterVoice(packet("English", { source_ids: ["market_data:FORGED"] }), master, runtimeRun(), frozen),
    (error) => error?.data?.reason === "SOURCE_PROVENANCE_MISMATCH"
      && error.data.unknown_source_ids.includes("market_data:FORGED"),
  );
});
