import { join } from "node:path";
import { isChineseLanguage, localized, resolveLanguage } from "./lang.mjs";
import { runPath } from "./run-store.mjs";
import { compactDebateContext, compactEvidence, compactMasterOpinions, compactQuickEvidence, methodVoiceAllowedSourceIds } from "./packets.mjs";
import { outputModeInstruction } from "./output-modes.mjs";
import { resolveSeatWeights, weightTableMarkdown } from "./weights.mjs";
import { groundingBlock } from "./grounding.mjs";
import { isFundOrIndex } from "./instruments.mjs";
import { personaPrompt, personaTitle, registry, selectRoster } from "./personas/registry.mjs";
import { intentsForStance } from "./voice.mjs";
import { companyDossierPacketAckTemplate, companyDossierPromptBlock, requiresOperatingCompanyDossier } from "./company-dossier.mjs";

/**
 * Prompt text lives in personas/, not here.
 *
 * It used to be two parallel blocks of string literals inside a 2000-line module -- one
 * Chinese, one English -- which had already drifted apart, and which neither a human
 * reviewer nor a host could see. These functions now only compose: preamble + persona
 * body + run-specific context.
 */

/** Fill {{placeholders}} in a persona body. Unknown keys are left alone, not blanked. */
function render(template, values) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (match, key) =>
    (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match));
}

function fundOrIndexTaskInstruction(task, instrument, language) {
  if (!isFundOrIndex(instrument)) return "";
  const type = instrument.asset_type || "fund_or_index";
  const details = {
    market_data: {
      en: "Establish the tracked index or calculation methodology, holdings/constituent as-of date, weights, top-ten and sector concentration, fee or index rules, AUM where applicable, liquidity/spread, premium-discount or tracking difference, and dated flows. Separate missing fields.",
      zh: "查清跟踪指数或计算方法、持仓/成分时点、权重、前十大和行业集中度、费率或指数规则、适用时的规模、流动性/点差、溢折价或跟踪差及带日期资金流；逐项列出缺失数据。",
      ja: "連動指数または算出方法、保有銘柄・構成銘柄の基準日とウェイト、上位10銘柄・業種集中度、経費率または指数ルール、該当する純資産、流動性・スプレッド、乖離・トラッキング差、日付付き資金フローを確認し、欠落項目を分けて示す。",
      ko: "추종 지수 또는 산출 방법, 보유·구성 종목 기준일과 비중, 상위 10개·섹터 집중도, 보수 또는 지수 규칙, 해당 시 AUM, 유동성·스프레드, 괴리율·추적 차이, 날짜가 있는 자금 흐름을 확인하고 누락 항목을 분리해 기록한다.",
    },
    earnings_deep_dive: {
      en: "Perform holdings-level earnings look-through. State the covered portfolio weight and one-date aggregation method; keep issuer results separate. Never report fund/index revenue, EPS, cash flow, or an earnings call as though the instrument were an operating company.",
      zh: "做持仓层盈利穿透，披露覆盖的组合权重与同日聚合方法，并分开记录各发行人结果。不得编造基金/指数自身营收、EPS、现金流或把成分公司电话会写成基金电话会。",
      ja: "保有銘柄レベルの利益ルックスルーを行い、カバーしたポートフォリオウェイトと同一基準日の集計方法を示し、発行体ごとの結果を分離する。ファンド・指数固有の売上高、EPS、CF、決算説明会を作らない。",
      ko: "보유 종목 수준 이익 룩스루를 수행하고 커버한 포트폴리오 비중과 동일 기준일 집계 방법을 밝히며 발행사 결과를 분리한다. 펀드·지수 자체 매출, EPS, 현금흐름 또는 실적 발표 콜을 만들지 않는다.",
    },
    forward_expectations: {
      en: "Use weighted constituent or provider-published aggregate expectations with one date and a coverage percentage. Analyse top-constituent, sector, factor and macro expectation changes; never label a few issuer estimates as the fund's own guidance.",
      zh: "只使用同一时点、披露覆盖权重的加权成分预期或指数提供方聚合预期；分析头部成分、行业、因子与宏观预期变化，不得把少数公司预测称为基金自身指引。",
      ja: "同一基準日とカバーウェイトを示す加重構成銘柄予想または提供者公表の集計予想を使い、上位銘柄・業種・ファクター・マクロ予想の変化を分析する。一部発行体予想をファンド固有ガイダンスと呼ばない。",
      ko: "동일 기준일과 커버 비중을 밝힌 가중 구성 종목 전망 또는 제공자 공개 집계 전망을 사용하고 상위 종목·섹터·팩터·거시 전망 변화를 분석한다. 일부 발행사 전망을 펀드 자체 가이던스로 부르지 않는다.",
    },
    quant_factor: {
      en: "Measure total and relative return, breadth, factor/sector exposure, volatility, correlation, drawdown, tracking behaviour, liquidity and flows where available. Distinguish the tradable fund from the cash index and from any derivative proxy.",
      zh: "衡量总收益与相对收益、市场广度、因子/行业暴露、波动、相关性、回撤、跟踪表现、流动性及可得的资金流；分开可交易基金、现金指数与衍生品代理。",
      ja: "トータル・相対リターン、ブレッドス、ファクター・業種エクスポージャー、ボラティリティ、相関、ドローダウン、トラッキング、流動性、利用可能な資金フローを測り、上場ファンド、現物指数、デリバティブ代理を分ける。",
      ko: "총수익·상대수익, 시장 폭, 팩터·섹터 노출, 변동성, 상관, 낙폭, 추적 성과, 유동성 및 가능한 자금 흐름을 측정하고 거래 펀드, 현물 지수, 파생상품 대용물을 구분한다.",
    },
    valuation_long_short: {
      en: "Use same-date aggregate P/E, P/B, cash-flow yield or other portfolio metrics only with the provider/methodology and covered weight. Compare concentration and factor exposures. Never add a handful of constituent financial statements into portfolio financials.",
      zh: "聚合 P/E、P/B、现金流收益率等组合指标必须同日、说明数据提供方/方法及覆盖权重，并比较集中度与因子暴露；不得把少数成分财报相加成组合财报。",
      ja: "集計P/E、P/B、CF利回り等は同一基準日、提供者・方法、カバーウェイトを示し、集中度とファクターを比較する。一部構成銘柄の財務諸表を足してポートフォリオ財務にしない。",
      ko: "집계 P/E, P/B, 현금흐름 수익률 등은 동일 기준일, 제공자·방법, 커버 비중을 밝히고 집중도와 팩터 노출을 비교한다. 일부 구성 종목 재무제표를 더해 포트폴리오 재무로 만들지 않는다.",
    },
    news_industry_management: {
      en: "Cover sponsor and index-provider changes, methodology/rebalance notices, regulation and market-structure news, plus material dated news from top holdings and dominant sectors. Do not invent fund management guidance.",
      zh: "覆盖基金管理人/指数提供方变化、方法与再平衡公告、监管和市场结构新闻，以及头部持仓和主导行业的重大带日期新闻；不得编造基金经营层指引。",
      ja: "運用会社・指数提供者の変更、方法・リバランス通知、規制・市場構造ニュース、上位保有銘柄と主要業種の重要な日付付きニュースを扱い、ファンド経営ガイダンスを作らない。",
      ko: "운용사·지수 제공자 변경, 방법론·리밸런싱 공지, 규제·시장 구조 뉴스와 상위 보유 종목·주요 섹터의 중요한 날짜가 있는 뉴스를 다루며 펀드 경영진 가이던스를 만들지 않는다.",
    },
    insider_sec: {
      en: "Review applicable fund/index filings, prospectus and methodology changes, holdings reports, lending/derivative disclosures and sponsor conflicts. Constituent Form 4 filings are issuer activity, not fund insider trading.",
      zh: "检查适用的基金/指数申报、招募说明书和方法变更、持仓报告、证券出借/衍生品披露及管理人冲突；成分股 Form 4 属于发行人活动，不是基金内部人交易。",
      ja: "適用するファンド・指数届出、目論見書・方法変更、保有報告、貸株・デリバティブ開示、運用会社の利益相反を確認する。構成銘柄のForm 4は発行体の活動であり、ファンドの内部者取引ではない。",
      ko: "적용 가능한 펀드·지수 신고, 투자설명서·방법론 변경, 보유 보고, 대차·파생상품 공시, 운용사 이해상충을 검토한다. 구성 종목 Form 4는 발행사 활동이지 펀드 내부자 거래가 아니다.",
    },
    ib_event_analysis: {
      en: "Treat reconstitution, rebalances, methodology/provider changes, fee or sponsor changes, closures/mergers/splits and capital-market plumbing as instrument events. Constituent M&A matters only through explicit weight, replacement and flow effects.",
      zh: "把指数重构/再平衡、方法或提供方变化、费率或管理人变化、清盘/合并/拆分及资本市场机制视为资产事件；成分股并购只通过明确的权重、替换与资金流影响纳入。",
      ja: "入替・リバランス、方法・提供者変更、経費率・運用会社変更、償還・合併・分割、資本市場の仕組みを銘柄イベントとして扱う。構成銘柄M&Aは明示したウェイト、置換、フロー効果だけで反映する。",
      ko: "지수 재구성·리밸런싱, 방법론·제공자 변경, 보수·운용사 변경, 청산·합병·분할 및 자본시장 구조를 종목 이벤트로 다룬다. 구성 종목 M&A는 명시한 비중·교체·자금 흐름 효과로만 반영한다.",
    },
  }[task];
  const generic = {
    en: "Use the fund/index research contract and record unavailable fields explicitly.",
    zh: "使用基金/指数研究合同，并逐项记录不可得数据。",
    ja: "ファンド・指数調査契約を使い、取得できない項目を明記する。",
    ko: "펀드·지수 조사 계약을 사용하고 확보하지 못한 항목을 명시한다.",
  };
  return localized(language, {
    en: `## ${type} task override\n${(details || generic).en}`,
    zh: `## ${type} 专用任务改写\n${(details || generic).zh}`,
    ja: `## ${type} 専用タスク\n${(details || generic).ja}`,
    ko: `## ${type} 전용 작업\n${(details || generic).ko}`,
  });
}

/**
 * Output shaping for a depth tier.
 *
 * A tier is a timeout, and a timeout is not a plan. Sending the identical prompt with a shorter
 * fuse does not buy a faster good packet -- it buys a packet the worker could not finish, which
 * arrives as `degraded` or not at all. For an LLM call the wall clock is dominated by the tokens
 * it generates, so the way to run faster without losing information is to ask for the same
 * information in less prose.
 *
 * The line every tier holds: claims, numbers, scoped source IDs, required report sections and
 * the decision itself are never what gets cut. What `fast` removes is restatement -- re-quoting
 * evidence the packet can cite by ID, recapping an opponent before answering, methodology
 * preambles. What `slow` buys back is room to write a derivation out in full.
 */
export function paceShapingInstruction(pace, role, chinese) {
  const tier = String(pace || "normal").toLowerCase();
  if (tier !== "fast" && tier !== "slow") return "";
  const isReport = role === "portfolio_manager";
  if (tier === "fast") {
    if (chinese) {
      return [
        "本轮按 fast 档运行。要压缩的是叙述，不是内容：",
        "- 每一条仍必须带具体数字和作用域来源 ID（`<task>:S<n>`）。少写一条论点比少写一个来源 ID 更可接受，凭记忆补数字则永远不可接受。",
        "- 不要复述证据原文——引用来源 ID 即可。不要在回答前复述对手立场。不要写方法论开场或结尾总结。",
        "- 每条论点压到一到两句，只保留「主张 + 数字 + 来源 + 它错在哪」。",
        isReport
          ? "- 报告的每一个必需章节仍必须齐备且非空：简洁只能来自散文，不能来自删章节。价位阶梯与失效条件不得压缩成一句话，它们是这份报告唯一可执行的部分。"
          : "- 论点条数上限 6 条，取信息量最高的 6 条，其余舍弃而不是缩写成半句。",
        "- 如果时间不足以完成，宁可交一份明确标注缺口的短包，也不要交一份看起来完整但数字来自记忆的包。",
      ].join("\n");
    }
    return [
      "This round runs at the fast tier. Compress the prose, not the content:",
      "- Every item still carries its figure and its scoped source ID (`<task>:S<n>`). Dropping one argument is acceptable; dropping a source ID is not, and filling a number from memory never is.",
      "- Do not re-quote evidence -- cite the source ID. Do not recap the opponent before answering. No methodology preamble and no closing summary.",
      "- One or two sentences per item: claim, figure, source, and what would break it.",
      isReport
        ? "- Every required report section must still be present and non-empty: terseness comes out of prose, never out of sections. Price levels and invalidation conditions may not be compressed to one line -- they are the only actionable part of the report."
        : "- At most 6 arguments. Keep the six highest-information ones and drop the rest rather than shortening every one into a fragment.",
      "- If there is not enough time to finish, hand in a short packet that names the gap rather than a complete-looking one built from memory.",
    ].join("\n");
  }
  if (chinese) {
    return [
      "本轮按 slow 档运行。这一档买到的是把推导写完整的空间：",
      "- 多步推算要逐步写出，把每一步的口径、假设与它对结论的敏感度都写明，而不是只给结果。",
      "- 逐条处置对手的论点：哪一条你接受、哪一条你反驳、反驳依据的是哪个来源 ID 与哪个数字。",
      "- 明确写出你自己的证伪条件：什么读数会让你放弃这条论点。",
      "- 更长不等于更好：每一段要么带来新的数字，要么带来新的反驳。重复已说过的内容仍然要删。",
    ].join("\n");
  }
  return [
    "This round runs at the slow tier. What that budget buys is room to write the derivation out:",
    "- Show multi-step arithmetic step by step, with the basis, the assumption and the sensitivity of the conclusion to each step, not just the result.",
    "- Handle the opponent's arguments one by one: which you accept, which you refute, and on which source ID and figure the refutation rests.",
    "- State your own falsification conditions explicitly: which reading would make you drop the argument.",
    "- Longer is not better. Every paragraph must add either a new figure or a new refutation; repetition of what you already said still gets cut.",
  ].join("\n");
}

export function taskPrompt(task, symbol, asOfDate, userPrompt = "", language = "auto", grounding = null, pace = null) {
  const resolvedLanguage = resolveLanguage({ language, prompt: userPrompt });
  const chinese = isChineseLanguage(resolvedLanguage);
  const reg = registry();

  const base = [
    render(personaPrompt(reg.get("_evidence_base"), resolvedLanguage), {
      symbol,
      as_of: asOfDate,
      language: resolvedLanguage,
    }),
    userPrompt ? (chinese ? `用户目标：${userPrompt}` : `User objective: ${userPrompt}`) : "",
  ].filter(Boolean).join("\n");

  const body = render(personaPrompt(reg.get(task), resolvedLanguage), { symbol, as_of: asOfDate, language: resolvedLanguage })
    || (chinese ? "收集与投资决策相关的证据。" : "Collect evidence relevant to the investment decision.");

  // Grounding goes AFTER the role brief: the analyst must know its job before it is told
  // which facts are already settled, or it reads them as the whole assignment.
  const instrumentOverride = fundOrIndexTaskInstruction(task, grounding?.instrument, resolvedLanguage);
  const grounded = groundingBlock(grounding, resolvedLanguage);
  return [
    `${base}\n\n${chinese ? "任务：" : "Task: "}${task}\n${body}`,
    instrumentOverride,
    grounded,
    // Last, so it is the final word on form after the role brief and the settled facts.
    paceShapingInstruction(pace, task, chinese),
  ].filter(Boolean).join("\n\n");
}

export function debatePrompt(role, run, context = {}) {
  const evidencePath = join(runPath(run.run_id), "evidence.json");
  const quick = run.council_mode === "quick";
  const evidenceJson = JSON.stringify(quick ? compactQuickEvidence(run) : compactEvidence(run));
  const language = run.language || "English";
  const chinese = isChineseLanguage(language);
  const reg = registry();

  const base = render(personaPrompt(reg.get("_debate_base"), language), {
    symbol: run.symbol,
    as_of: run.as_of,
    evidence_path: evidencePath,
    language,
    role,
  });

  const roleText = render(personaPrompt(reg.get(role), language), { symbol: run.symbol, as_of: run.as_of, language, role })
    || (chinese ? "产出投资组合辩论 memo。" : "Produce a portfolio debate memo.");

  const roundTwoInstruction = context.round === 2
    ? (chinese
        ? "本轮为交叉反驳轮：在完成反驳后，必须在 `questions` 数组里向对方提出恰好 3 个尖锐、可回答的问题；本轮 `questions_answered` 留空。"
        : "This is the cross-rebuttal round. After the rebuttal, ask exactly 3 sharp, answerable opponent questions in `questions`; leave `questions_answered` empty in this round.")
    : "";
  const roundThreeInstruction = context.round === 3
    ? (chinese
        ? "本轮为问答回答轮：把你在第 2 轮提出的 3 个问题原样复制到 `questions`。`questions_answered` 必须是恰好 3 个 `{question, answer}` 对象；每个 `question` 按数组位置逐字复制输入的对方问题，`answer` 给出对应回答。"
        : "This is the Q&A response round. Copy your 3 round 2 questions exactly into `questions`. `questions_answered` must contain exactly 3 `{question, answer}` objects; each `question` must copy the supplied opponent question verbatim at the same array index, and `answer` must answer it.")
    : "";
  const quickInstruction = quick
    ? role === "portfolio_manager"
      ? (chinese
          ? "这是 quick_v1 快速委员会，不是 full council。只发生了一次并行多空陈述，没有三轮交叉问答，也没有对抗核验。请写紧凑报告，必须有真实 Markdown 标题：结论、分析师工作记录（逐一写出 4 个计划席位及失败/缺口）、多空辩论记录、电话会管理层信号、近期公司与行业新闻、估值区间、价格条件、主要风险、仓位建议、数据缺口、置信度、来源表。不得声称 quick 等同 full。"
          : "This is a quick_v1 council, not a full council. It ran one parallel bull/bear statement, no three-round cross-exam, and no adversarial verification. Write a compact report with real Markdown headings for Conclusion, Analyst Work Log (name every planned seat and any failure/gap), Bull/Bear Debate Record, Earnings Call Management Signals, Recent Company and Industry News, Valuation Range, Price Levels, Major Risks, Position Recommendation, Data Gaps, Confidence, and Source Table. Never claim quick is equivalent to full.")
      : (chinese
          ? "这是快速委员会的唯一多空陈述轮。只给最有信息量的 4–6 条论点，使用已提供来源 ID，明确回应方法席分歧；不要生成第二/第三轮问题，也不要写长报告。"
          : "This is the quick council's only bull/bear statement round. Give only the 4-6 highest-information arguments, use supplied source IDs, and engage with method-seat disagreements. Do not create round-2/3 questions or a long report.")
    : "";
  const instrumentReportInstruction = role === "portfolio_manager" && isFundOrIndex(run?.grounding?.instrument)
    ? (chinese
        ? "这是ETF、基金或大盘指数研究。报告必须新增真实 Markdown 标题 `## 基金与指数结构`，明确资产类型、跟踪方法、持仓/成分权重时点、集中度、费用或指数规则、流动性/溢折价/跟踪差/资金流（适用时）、聚合盈利与估值口径，以及每项未取得的数据。不得写基金或指数自身营收/EPS，也不得把少数成分股相加成组合财报。"
        : "This is ETF, fund or broad-index research. Add a real Markdown heading `## Fund and Index Structure` covering asset type, tracking methodology, dated holdings/constituent weights, concentration, fee or index rules, liquidity/premium-discount/tracking difference/flows when applicable, aggregate earnings and valuation methodology, and every unavailable item. Do not invent fund/index revenue or EPS and never add a few constituents into portfolio financials.")
    : "";
  const structuredManagerDecisionInstruction = role === "portfolio_manager" && context.structuredDecisionOnly === true
    ? (chinese
        ? [
          "最终输出改用 HEADLESS_STRUCTURED_PM_DECISION_V1。只返回紧凑的结构化决策 JSON；不要返回 `report_markdown`，也不要在任何 JSON 字符串里嵌入 Markdown 报告。服务端会从已冻结的证据、三轮辩论和本决策确定性渲染完整 full_v2 报告。",
          "保留 debate packet 的必需字段：verdict、rating、winner、summary、long_thesis、short_thesis、valuation_range、catalysts、risks、position、invalidation、source_ids、confidence。每个来源 ID 必须来自提供的已冻结证据。",
          "另请返回：`price_levels`（3–8 项；每项含非空 label、range、lower_bound、upper_bound、currency、meaning、action、basis，以及至少一个 source_ids）。lower_bound/upper_bound 用数值，开放端用 null；全部档位按数值必须从下方开放端连续覆盖到上方开放端，不得留空档或重叠，因此像 120–160 没动作这样的区间会被拒绝。另含 `horizon_views`（short_term、medium_term、long_term 三个非空字符串）、`data_gaps`（至少一个非空字符串；若无关键缺口，明确写出未发现关键数据缺口）以及提示中要求的 `company_dossier_hash_ack`。",
          "这是本 prompt 对输出形式的最后约束；前文要求撰写长报告的说明由服务端渲染器履行。只输出一个 JSON 对象。",
        ].join("\n")
        : [
          "Final output uses HEADLESS_STRUCTURED_PM_DECISION_V1. Return only compact structured-decision JSON. Do not return `report_markdown`, and do not embed a Markdown report inside any JSON string. The server deterministically renders the complete full_v2 report from the frozen evidence, three debate rounds, and this decision.",
          "Keep the required debate-packet fields: verdict, rating, winner, summary, long_thesis, short_thesis, valuation_range, catalysts, risks, position, invalidation, source_ids, and confidence. Every source ID must come from the supplied frozen evidence.",
          "Also return `price_levels` (3-8 items, each with non-empty label, range, lower_bound, upper_bound, currency, meaning, action, basis, and at least one source_ids entry). Bounds are numbers with null only for an open end; the bands must continuously cover the price line from the open lower end to the open upper end with no gap or overlap, so an actionless interval such as 120-160 is rejected. Also return `horizon_views` (non-empty short_term, medium_term, and long_term strings), `data_gaps` (at least one non-empty string), and the prompt-required `company_dossier_hash_ack`.",
          "This is the final output-form instruction in the prompt; the server renderer satisfies earlier instructions to author a long report. Return exactly one JSON object.",
        ].join("\n"))
    : "";

  return [
    // The original spread the preamble's lines as separate array elements, so they are
    // separated by blank lines in the final prompt. Preserve that exactly.
    ...base.split("\n"),
    roleText,
    companyDossierPromptBlock(run),
    quickInstruction,
    instrumentReportInstruction,
    roundTwoInstruction,
    roundThreeInstruction,
    context.round ? `Debate round: ${context.round}` : "",
    context.brief ? `Brief length for round 1: ${context.brief}` : "",
    context.otherCaseR1 ? `Opponent prior-round case JSON: ${JSON.stringify(compactDebateContext(context.otherCaseR1))}` : "",
    context.questionsYouAsked ? `Your round 2 questions to preserve JSON: ${JSON.stringify(context.questionsYouAsked)}` : "",
    context.questionsForYou ? `Questions you must answer JSON: ${JSON.stringify(context.questionsForYou)}` : "",
    // The masters ran before the debate; the bull and bear must argue with their
    // disagreements rather than restate the evidence unopposed.
    (run.master_opinions || []).length
      ? `Master seat opinions JSON (read the disagreements; you must engage with them, not ignore them): ${JSON.stringify(compactMasterOpinions(run))}`
      : "",
    context.bull ? `Bull argument JSON: ${JSON.stringify(compactDebateContext(context.bull))}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(compactDebateContext(context.bear))}` : "",
    // The PM must reproduce the weighting rather than average the seats silently.
    role === "portfolio_manager"
      ? [
        chinese
          ? "各席位权重如下。你的最终裁决必须按这个权重加权，并且必须在报告里原样复现这张表（含核验调整原因）。权重为 0 的席位（自述超出判断范围）不计入。若你的结论与高权重席位相反，必须明确说明为什么。"
          : "Seat weights follow. Weight your verdict by them, and reproduce this table verbatim in the report, including the adjustment reasons. Seats at weight 0 declared themselves out of scope and do not count. If your conclusion opposes a high-weight seat, say explicitly why.",
        weightTableMarkdown(resolveSeatWeights(run, run.seat_weight_overrides || {}), language),
      ].filter(Boolean).join("\n\n")
      : "",
    role === "portfolio_manager" && !quick ? outputModeInstruction(context.outputMode || "chat", language) : "",
    // The tier's shaping is the final word on form. Quick has its own shaping already.
    quick ? "" : paceShapingInstruction(run.council_pace, role, chinese),
    `Evidence JSON: ${evidenceJson}`,
    // Headless full PMs return a small decision object. Keep this last so the shared persona's
    // legacy long-report-in-JSON contract cannot override it and recreate the truncation risk.
    structuredManagerDecisionInstruction,
  ].filter(Boolean).join("\n\n");
}

/**
 * A master seat reads the finished evidence through one philosophy.
 *
 * Masters deliberately run after the evidence stage and before the debate: they are a
 * judgment layer, not an evidence layer, and their disagreements are what the bull and
 * bear then have to argue with.
 */
export function masterPrompt(masterId, run) {
  const reg = registry();
  const persona = reg.get(masterId);
  if (!persona || persona.kind !== "master") throw new Error(`unknown master persona: ${masterId}`);
  const language = run.language || "English";
  const values = { symbol: run.symbol, as_of: run.as_of, language };

  const chinese = isChineseLanguage(language);
  // Masters see the same established facts the analysts saw, not only what the analysts
  // chose to report. A master's value is a different selection from the same facts --
  // Munger looking at incentives, Burry at the notes -- and reading only the analysts'
  // packets destroys exactly that. It also means one weak packet would bias all 21 seats
  // identically, which is the worst kind of error: large and perfectly correlated.
  const grounded = groundingBlock(run.grounding, language);
  const packetLabel = chinese
    ? "以下是分析师席位的证据包。这是**其他席位对同一批事实的解读**，不是事实本身。"
      + "你可以不同意他们的读法，但必须说明你依据的是上面哪一条原始事实。"
    : "Below are the analyst seats' evidence packets. These are **other seats' readings of the "
      + "same facts**, not the facts themselves. You may disagree with a reading, but say which "
      + "established fact above your disagreement rests on.";

  return [
    render(personaPrompt(reg.get("_master_base"), language), values),
    `Master: ${personaTitle(persona, language)} (${persona.id})`,
    render(personaPrompt(persona, language), values),
    `Walk-away conditions you must check explicitly: ${(persona.disqualifiers || []).join(" | ")}`,
    companyDossierPromptBlock(run),
    grounded,
    `${packetLabel}\nEvidence JSON: ${JSON.stringify(run.council_mode === "quick" ? compactQuickEvidence(run) : compactEvidence(run))}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * One isolated worker per selected physical v3 method, after its structured decision is
 * frozen. The worker may explain and challenge the evidence, but it cannot vote again.
 */
export function methodVoiceOutputContract(masterId, run, frozenOpinion) {
  const language = run.language || "English";
  const allowedSourceIds = methodVoiceAllowedSourceIds(run, frozenOpinion);
  const stance = frozenOpinion?.stance || "out_of_scope";
  const confidence = ["high", "medium", "low"].includes(frozenOpinion?.confidence)
    ? frozenOpinion.confidence
    : "low";
  const example = {
    master: masterId,
    acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: intentsForStance(stance)[0],
    voice: {
      would_i_act: `<first-person ${language} text; at least two complete sentences>`,
      what_i_see: `<first-person ${language} text; at least two complete sentences>`,
      how_my_method_reads_it: `<first-person ${language} text; at least two complete sentences>`,
      where_i_disagree: `<first-person ${language} text; at least two complete sentences>`,
      what_changes_my_mind: `<first-person ${language} text; at least two complete sentences>`,
    },
    key_findings: [],
    disagreements: [],
    what_would_change_my_mind: [],
    source_ids: allowedSourceIds.slice(0, 1),
    confidence,
    ...(requiresOperatingCompanyDossier(run)
      ? {
        company_dossier_hash_ack: run.company_dossier?.content_hash,
        evidence_packet_acks: companyDossierPacketAckTemplate(run),
      }
      : {}),
  };
  return [
    `Allowed investment-evidence source_ids JSON: ${JSON.stringify(allowedSourceIds)}`,
    requiresOperatingCompanyDossier(run)
      ? "`source_ids` MUST contain at least one ID from that exact allowed list, even for out_of_scope: cite the dossier evidence your method actually read. Never put `proxy:*` or method-definition provenance in `source_ids`; the system preserves those separately as `method_source_ids`."
      : "`source_ids` MUST contain only a subset of that exact allowed list. A directional stance requires at least one ID. Never put `proxy:*` or any method-definition provenance in `source_ids`; the system preserves those separately as `method_source_ids`.",
    "`key_findings`, `disagreements`, and `what_would_change_my_mind` MUST each be an array of plain strings. Never place objects or nested arrays inside them.",
    "`confidence` MUST be exactly one of: high | medium | low.",
    `Return ONLY one valid JSON object, no Markdown fence. Exact required shape (replace the angle-bracket voice text, preserve every key): ${JSON.stringify(example)}`,
  ].join("\n");
}

export function masterVoicePrompt(masterId, run, frozenOpinion) {
  const reg = registry();
  const persona = reg.get(masterId);
  if (!persona || persona.kind !== "master") throw new Error(`unknown master persona: ${masterId}`);
  const language = run.language || "English";
  const values = { symbol: run.symbol, as_of: run.as_of, language };
  const evidence = JSON.stringify(run.council_mode === "quick" ? compactQuickEvidence(run) : compactEvidence(run));
  return [
    `You are the dedicated, isolated method-seat explanation worker for ${personaTitle(persona, language)} (${masterId}) in the ${run.symbol} council.`,
    `Write every reader-facing field in ${language}. Keep stable IDs, tickers and source IDs unchanged.`,
    "This is a first-person simulation of a project-derived provisional public-method lens, not the named person's identity, current statement, endorsement, quotation, holding, or private information.",
    "The structured method decision below is already frozen. You MUST NOT change, soften, strengthen or reinterpret its stance. Explain why that frozen result follows, identify the highest-information facts or missing facts, state any disagreement with analyst interpretation, and say what evidence would change the method result. Do not browse or add facts.",
    `Frozen method result JSON: ${JSON.stringify({
      master: masterId,
      stance: frozenOpinion?.stance,
      verdict: frozenOpinion?.verdict,
      summary: frozenOpinion?.summary,
      disqualifiers_triggered: frozenOpinion?.disqualifiers_triggered || [],
      what_would_change_my_mind: frozenOpinion?.what_would_change_my_mind || [],
      evidence_source_ids: frozenOpinion?.evidence_source_ids || frozenOpinion?.source_ids || [],
      method_source_ids: frozenOpinion?.method_source_ids || [],
      deterministic_core_hash: frozenOpinion?.deterministic_core_hash || null,
      frozen_decision_hash: frozenOpinion?.frozen_decision_hash || null,
    })}`,
    `Method instructions (for explanation only):\n${render(personaPrompt(persona, language), values)}`,
    companyDossierPromptBlock(run),
    [
      "MANDATORY VOICE MODE: every one of the five `voice` fields must speak directly in the first person as the METHOD -- \"I look for X; I see Y; therefore I would Z\". A neutral third-person summary such as \"Buffett would...\" is invalid.",
      "Open with the action verdict, then reason in this method's characteristic order. Use its distinctive public-method questions, vocabulary, cadence, priorities, and failure mode from the Method instructions. A reader should hear this particular method reasoning, not a generic analyst or checklist.",
      "First person is the voice of the public-method simulation. Never write \"I am [named person]\", claim the person's biography, current belief, current holding, private reason, endorsement, or fabricate a quotation. The system renders a fixed disclosure outside your prose; acknowledge it with the exact contract token and do not replace or weaken it.",
      "The five voice fields are this worker's deliverable. Pace-tier compression applies to restatement and preamble, never to these fields: at any tier each stays at least two full sentences.",
      "Every figure you cite must already appear in the evidence or the frozen result, with its source ID. Cite the number, not an adjective about the number.",
      "`what_changes_my_mind` must name a threshold or an observation that would flip the reading, not a wish for more research.",
      "If the frozen stance is out_of_scope, do NOT stop at naming the missing input. Give the method's full first-person reading of the facts that DO exist for this instrument -- its classification, concentration, top holdings and weights, aggregate figures, price structure, whatever the evidence carries -- through the method's own stated priorities, the way its named published work approaches a basket it cannot fully underwrite. State plainly that this reading is observation, not a stance, because the named inputs are absent; a method that guesses without them stops being a method. End with the concrete condition that reopens the seat.",
    ].join(" "),
    `\`position_intent\` MUST be one of: ${intentsForStance(frozenOpinion?.stance).join(" | ")}. Those are the only intents the frozen stance admits; anything else is rejected without changing run state.`,
    methodVoiceOutputContract(masterId, run, frozenOpinion),
    paceShapingInstruction(run.council_pace, masterId, isChineseLanguage(language)),
    `Bounded shared evidence JSON: ${evidence}`,
  ].filter(Boolean).join("\n\n");
}

/** The master ids a run has selected, from an explicit list or a roster name. */
export function selectedMasters(run) {
  const reg = registry();
  if (Array.isArray(run.masters) && run.masters.length) {
    return selectRoster(reg, { ids: run.masters }).filter((p) => p.kind === "master").map((p) => p.id);
  }
  if (run.masters_roster) {
    return selectRoster(reg, { kind: "master", roster: run.masters_roster }).map((p) => p.id);
  }
  return [];
}
