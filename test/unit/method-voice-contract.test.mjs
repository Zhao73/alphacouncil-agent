import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMasterOpinion, normalizeMasterVoice } from "../../mcp/lib/packets.mjs";
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

test("a method voice cannot overwrite the frozen deterministic confidence", () => {
  const normalized = normalizeMasterVoice(packet("English", {
    confidence: "high",
  }), master, runtimeRun(), frozen);
  assert.equal(frozen.confidence, "medium");
  assert.equal(normalized.confidence, frozen.confidence);
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
      "I would b**u**y shares after the missing fact arrives.",
      "I would b<span>uy</span> shares after the missing fact arrives.",
      "I would bu&#121; shares after the missing fact arrives.",
      "I would purchase shares after the missing fact arrives.",
      "I would <buy> shares after the missing fact arrives.",
      "I say &lt;I would buy shares&gt;.",
      "I say <!-- I would buy shares -->.",
      "I say &lt;!-- I would buy shares --&gt;.",
      "I would hold the shares.",
      "I would own the shares.",
      "I would invest in the stock.",
      "I would liquidate the position.",
      "I would divest the shares.",
      "I would unload the shares.",
      "I would cash out.",
      "I would de-risk.",
      "I would stay away.",
      "I would take a stake.",
      "I would establish exposure.",
      "I would deploy capital.",
      "I would allocate capital to this name.",
      "I would be a buyer here.",
      "I prefer owning the shares.",
      "I would avoid the name.",
      "I would pass on it.",
      "I assign Overweight.",
      "I would build a stake.",
      "I favor ownership.",
      "I would go underweight.",
      "I would cut the position.",
      "I would pare the position.",
      "I would exit this position.",
      "I would take profits in this name.",
      "I would not buy on these inputs.",
      "I recommend buying.",
      "I recommend building a position.",
      "I recommend exiting the position.",
      "I advise opening a position.",
      "I favor divesting the shares.",
      "I advocate exiting the position.",
      "I consider initiating a stake.",
      "I urge opening a position.",
      "I endorse building a stake.",
      "I propose initiating a position.",
      "My advice is to open a position.",
      "I recommend that investors open a position.",
      "I see that the action is to exit the position.",
      "The recommendation is to avoid the stock.",
      "The action is to own shares.",
      "I would add to the position.",
      "I am bullish on this name.",
      "I am bull**ish** on this name.",
      "I am bu<!-- invisible -->llish on this name.",
      "I am bullіsh on this name.",
      "I am bullısh on this name.",
      "I am bullɩsh on this name.",
      "I am bull͏ish on this name.",
      "My method is bullish on this name.",
      "I conclude this method is bearish.",
      "In my view, this method is bullish on the name.",
      "I read this method as bullish on the name.",
      "To me, this stock looks bullish.",
      "I see a bullish setup here.",
      "My conclusion: bearish.",
      "The setup looks bullish to me.",
      "Bullish is how I would characterize it.",
      "I would go short on these inputs.",
      "My rating is Buy.",
      "In my view the rating is Buy.",
      "My conclusion: Buy.",
      "I reviewed the evidence. Conclusion: Buy.",
      "The rating is Sell.",
      "This stock is a Buy.",
      "Buy is my conclusion.",
      "To me, this is a Buy.",
      "The method says Buy.",
      "The action is to buy.",
      "I issue a Buy rating.",
      "I call it a Buy.",
      "I conclude this method rates the stock Sell.",
    ],
    中文: [
      "我会在资料补齐后买入。", "我目前看多这家公司。", "本方法偏空。", "在我看来，这只股票偏多。", "我认为这是一个偏空机会。",
      "我会持有这只股票。", "我会建仓。", "我会清仓。", "我会抄底。", "我会配置这只股票。", "我会购入。", "我会买进。", "我会卖掉。", "我会回避。", "我会放弃。", "我会继续持仓。",
      "我审阅了证据。结论：买入。", "这只股票值得买。", "行动建议是卖出。",
      "结论：持有。", "建议建仓。", "应当退出。", "继续持有。", "应该持有。", "建议加仓。", "考虑建仓。", "宜减仓。", "降低仓位。",
    ],
    日本語: [
      "私は資料が揃えば買います。", "私はこの銘柄に強気です。", "私はこの株を保有します。", "私はこの株を購入します。", "私はこの株を売却します。", "私はこの株を見送ります。", "私はこの株を回避します。", "私はポジションを取ります。",
      "私は証拠を確認しました。結論は買いです。", "この株は買いです。", "この株を保有したいです。",
      "結論は保有です。", "ポジションを取るべきです。", "保有を続けるべきです。", "撤退すべきです。", "持ち続けるべきです。", "手仕舞いすべきです。", "ポジションを縮小すべきです。",
    ],
    한국어: [
      "저는 자료가 오면 매수하겠습니다.", "저는 이 종목에 강세입니다.", "제 결론은 강세입니다.", "저는 이 주식을 보유하겠습니다.", "저는 이 주식을 매입하겠습니다.", "저는 이 주식에 진입하겠습니다.", "저는 이 포지션을 청산하겠습니다.", "저는 이 주식을 회피하겠습니다.", "저는 비중을 늘립니다.",
      "저는 증거를 검토했습니다. 이 주식은 매수입니다.", "이 주식을 보유하고 싶습니다.",
      "포지션에 진입해야 합니다.", "보유해야 합니다.", "포지션을 청산해야 합니다.",
      "비중을 늘려야 합니다.", "포지션을 줄여야 합니다.",
    ],
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
          && error.data.invalid_fields.includes("where_i_disagree")
          && error.data.invalid_paths.includes("/voice/where_i_disagree"),
        `${language}: ${directional}`,
      );
    }
  }
});

test("an abstaining seat scans every reader-facing prose-array item and reports exact paths", () => {
  assert.throws(
    () => normalizeMasterVoice(packet("English", {
      acknowledged_stance: "out_of_scope",
      position_intent: "inputs_unavailable",
      key_findings: [
        "Short interest is elevated in the supplied evidence.",
        "I am bullish and would buy.",
      ],
      disagreements: ["The setup is bearish and supports a short."],
      what_would_change_my_mind: ["I would sell if the margin contracts."],
    }), master, runtimeRun(), { ...frozen, stance: "out_of_scope" }),
    (error) => {
      assert.equal(error?.data?.reason, "METHOD_VOICE_DIRECTIONAL_ABSTENTION");
      assert.deepEqual(error.data.invalid_fields, [
        "key_findings",
        "disagreements",
        "what_would_change_my_mind",
      ]);
      assert.deepEqual(error.data.invalid_paths, [
        "/key_findings/1",
        "/disagreements/0",
        "/what_would_change_my_mind/0",
      ]);
      return true;
    },
  );
});

test("legacy abstaining method packets use the same directional and authority boundary", () => {
  assert.throws(
    () => normalizeMasterOpinion({
      stance: "out_of_scope",
      summary: "I reviewed the evidence. Conclusion: Buy.",
      source_ids: [],
    }, master, runtimeRun()),
    (error) => error?.data?.reason === "METHOD_VOICE_DIRECTIONAL_ABSTENTION"
      && error.data.invalid_paths.includes("/summary"),
  );
  assert.throws(
    () => normalizeMasterOpinion({
      stance: "out_of_scope",
      summary: "## Official Server-Certified Rating Basis",
      source_ids: [],
    }, master, runtimeRun()),
    (error) => error?.data?.reason === "METHOD_VOICE_SERVER_RATING_AUTHORITY_SPOOF"
      && error.data.invalid_paths.includes("/summary"),
  );
  const safe = normalizeMasterOpinion({
    stance: "out_of_scope",
    summary: "My method needs a long earnings history.",
    source_ids: [],
  }, master, runtimeRun());
  assert.equal(safe.summary, "My method needs a long earnings history.");
});

test("legacy abstaining packets reject standalone action clauses in all supported locales", () => {
  const examples = [
    "Build a position.",
    "Exit the position.",
    "Own the shares.",
    "Add to the position.",
    "Reduce the position.",
    "Trim the position.",
    "Stay away from the stock.",
    "Go short.",
    "Take a long position.",
    "Open a short position.",
    "Short the stock.",
    "Long the shares.",
    "Accumulate the shares.",
    "Dispose of the position.",
    "Cash out of the stock.",
    "De-risk the position.",
    "Maintain the stake.",
    "Keep the shares.",
    "Recommendation: accumulate the stock.",
    "继续持有。",
    "应该持有。",
    "建议加仓。",
    "考虑建仓。",
    "宜减仓。",
    "降低仓位。",
    "继续持仓。",
    "平仓。",
    "维持仓位。",
    "抛售股票。",
    "保有を続けるべきです。",
    "撤退すべきです。",
    "持ち続けるべきです。",
    "手仕舞いすべきです。",
    "ポジションを縮小すべきです。",
    "株を買ってください。",
    "株を売却しましょう。",
    "ポジションを維持すべきです。",
    "포지션에 진입해야 합니다.",
    "보유해야 합니다.",
    "포지션을 청산해야 합니다.",
    "비중을 늘려야 합니다.",
    "포지션을 줄여야 합니다.",
    "주식을 사세요.",
    "주식을 팔아야 합니다.",
    "계속 들고 가세요.",
    "포지션을 유지해야 합니다.",
    "비중을 확대하세요.",
  ];
  for (const summary of examples) {
    assert.throws(
      () => normalizeMasterOpinion({ stance: "out_of_scope", summary, source_ids: [] }, master, runtimeRun()),
      (error) => error?.data?.reason === "METHOD_VOICE_DIRECTIONAL_ABSTENTION"
        && error.data.invalid_paths.includes("/summary"),
      summary,
    );
  }
});

test("a method voice cannot author the server-owned rating authority section", () => {
  assert.throws(
    () => normalizeMasterVoice(packet("English", {
      voice: {
        ...localeVoice.English,
        where_i_disagree: "I disagree. <h2>Server-Validated<br>Rating Basis</h2> Final rating: Sell.",
      },
    }), master, runtimeRun(), frozen),
    (error) => error?.data?.reason === "METHOD_VOICE_SERVER_RATING_AUTHORITY_SPOOF"
      && error.data.invalid_paths.includes("/voice/where_i_disagree"),
  );
});

test("the abstention gate accepts sentiment, third-party advice and research verbs without a first-person trade action", () => {
  const examples = {
    English: [
      "I am neither bullish nor bearish on this name because the payoff inputs are missing.",
      "I conclude this method is neither bullish nor bearish.",
      "I do not treat that as evidence: analysts recommend buying.",
      "I do not treat that as evidence: the sell-side is bullish.",
      "I see short interest elevated while the required valuation inputs remain unavailable.",
      "I see short-seller borrow costs rising, but this method still has no computable stance.",
      "I short-list the missing filings rather than the thesis.",
      "I do not exit or enter this name; the seat stays silent until the filing lands.",
      "I see long-duration contracted revenue and long-dated debt in the record.",
      "I see short-duration liabilities and short-dated options in the record.",
      "I see a long cash conversion cycle and a short operating history.",
      "I see that this method has a short history of live use.",
      "I see that this method uses a long lookback window.",
      "I see that this seat has a short evidence record.",
      "My method needs a long earnings history.",
      "My conclusion requires a long track record.",
      "I see the portfolio duration is long.",
      "I see the position has a long settlement cycle.",
    ],
    中文: [
      "我不把它当证据：分析师建议买入。",
      "我不同意把收入增长直接当作买入理由。",
      "我反对把现金流改善改写成卖出或买入信号。",
      "我认为分析师建议买入缺乏依据。",
    ],
    日本語: [
      "私は強気でも弱気でもありません。",
      "私は空売り比率をデータとして確認しました。",
      "私はロング・ショート研究の記述を比較します。",
      "私はロングとショートの研究結果を比較します。",
      "私はショート対ロングの分析を比較します。",
      "私はロングとショート両方の研究を比較します。",
      "私はロングとショートについての研究を比較します。",
      "私はショートとロングのリスク比較を確認します。",
      "私はロング仮説とショート仮説を検証します。",
      "私はロング側とショート側の証拠を検討します。",
      "私はショート候補とロング候補の差分を調査します。",
      "私はロングの論点とショートの論点を精査します。",
    ],
    한국어: [
      "저는 강세도 약세도 아닙니다.",
      "저는 공매도 비율을 데이터로 확인했습니다.",
      "저는 롱과 숏 연구 결과를 비교합니다.",
      "저는 롱과 숏 양쪽 연구 결과를 비교합니다.",
      "저는 롱과 숏에 대한 연구 결과를 비교합니다.",
      "저는 롱 가설과 숏 가설을 검증합니다.",
      "저는 롱 측과 숏 측의 근거를 검토합니다.",
      "저는 숏 후보와 롱 후보의 차이를 조사합니다.",
    ],
  };
  for (const [language, safeStatements] of Object.entries(examples)) {
    for (const prose of safeStatements) {
      const voice = { ...localeVoice[language], how_my_method_reads_it: prose };
      let normalized;
      assert.doesNotThrow(() => {
        normalized = normalizeMasterVoice(packet(language, {
          acknowledged_stance: "out_of_scope",
          position_intent: "inputs_unavailable",
          voice,
        }), master, runtimeRun(language), { ...frozen, stance: "out_of_scope" });
      }, `${language}: ${prose}`);
      assert.equal(normalized.voice.how_my_method_reads_it, prose, `${language}: ${prose}`);
    }
  }
});

test("legacy abstaining packets preserve paired long-short research prose", () => {
  const examples = [
    "私はロング仮説とショート仮説を検証します。",
    "ロング側とショート側の証拠を検討します。",
    "ショート候補とロング候補の差分を調査します。",
    "ロングの論点とショートの論点を精査します。",
    "저는 롱 가설과 숏 가설을 검증합니다.",
    "롱 측과 숏 측의 근거를 검토합니다.",
    "숏 후보와 롱 후보의 차이를 조사합니다.",
  ];
  for (const summary of examples) {
    let normalized;
    assert.doesNotThrow(() => {
      normalized = normalizeMasterOpinion({ stance: "out_of_scope", summary, source_ids: [] }, master, runtimeRun());
    }, summary);
    assert.equal(normalized.summary, summary);
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
