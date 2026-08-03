import { languageKey } from "./lang.mjs";
import { resolveSeatWeights, weightTableMarkdown } from "./weights.mjs";

/**
 * Render the long full_v2 report inside the trusted process instead of asking a worker to
 * JSON-escape twenty-plus Markdown sections. The model still owns the investment decision;
 * this module owns only layout and faithful presentation of already-recorded fields.
 */

function inline(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replaceAll("|", "\\|")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string").map(inline).filter(Boolean))];
}

function bullets(values, fallback) {
  const rows = uniqueStrings(values);
  return rows.length ? rows.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function codeIds(values) {
  return uniqueStrings(values).map((id) => `\`${id.replaceAll("`", "")}\``).join(", ");
}

function sourceSuffix(values, copy) {
  const ids = codeIds(values);
  return ids ? ` (${copy.sourceIds}: ${ids})` : "";
}

const COPY = Object.freeze({
  en: Object.freeze({
    title: "Investment Committee Report",
    conclusion: "Conclusion",
    analystLog: "Analyst Work Log",
    debate: "Bull/Bear Debate Record",
    weights: "Resolved Seat-Weight Audit",
    long: "Long Thesis",
    short: "Short Thesis",
    market: "Market Expectations and Implied Thresholds",
    analystRating: "Analyst Rating and Target-Price Revisions",
    earnings: "Earnings Call Management Signals",
    quant: "Quant Factor / Technical Risk View",
    news: "News and Company / Industry Voice Signals",
    shortInterest: "Short Interest / Borrow / Options Information",
    strategic: "Strategic Transaction or Banking Event",
    valuation: "Valuation Range",
    price: "Price Levels",
    catalysts: "Key Catalysts",
    risks: "Major Risks",
    position: "Position Recommendation",
    shortTerm: "Short-Term 1-4 Week View",
    mediumTerm: "Medium-Term 3-6 Month View",
    longTerm: "Long-Term 12 Month View",
    gaps: "Data Gaps / Unavailable Data",
    invalidation: "Invalidation Conditions",
    confidence: "Confidence",
    sources: "Source Table",
    rating: "Rating", winner: "Debate winner", summary: "Summary", verdict: "Verdict",
    status: "Status", findings: "Key findings", questions: "Open questions", sourceIds: "sources",
    noEvidence: "No usable packet was recorded for this required analyst; this remains an explicit data gap.",
    noFindings: "No additional sourced finding was recorded.",
    noQuestions: "No additional open question was recorded.",
    noDebate: "No usable debate packet was recorded.",
    noSectionEvidence: "The applicable evidence packet recorded no additional detail; treat this as unavailable data, not as a positive finding.",
    noCatalysts: "No additional sourced catalyst was recorded.",
    noRisks: "No additional risk was recorded beyond the stated invalidation conditions.",
    noGaps: "No critical data gaps were found in the completed evidence packets.",
    noInvalidation: "No additional invalidation condition was recorded.",
    priceMissing: "The structured PM decision did not fix this band; obtain an evidence-backed numeric boundary before acting.",
    upper: "Do not touch", start: "Worth starting a position", lower: "Materially undervalued",
    upperMeaning: "Above the evidence-backed ceiling, the payoff no longer compensates for the recorded risks.",
    startMeaning: "Inside the supported valuation range, a bounded starter position may be considered only while the thesis remains valid.",
    lowerMeaning: "Below the evidence-backed lower band, adding is conditional on every invalidation test still passing.",
    noAction: "Do not infer a trade from a missing price boundary.",
    sourceUnavailable: "No source record was available.",
    round: "Round", bull: "Bull", bear: "Bear", answers: "Answers", asked: "Questions",
  }),
  zh: Object.freeze({
    title: "投资委员会报告",
    conclusion: "结论",
    analystLog: "分析师工作记录",
    debate: "多空辩论记录",
    weights: "最终席位权重审计",
    long: "多头观点",
    short: "空头观点",
    market: "市场预期与隐含门槛",
    analystRating: "分析师评级/目标价变化",
    earnings: "电话会管理层信号",
    quant: "量化/因子视角",
    news: "新闻和公司/行业人物发言信号",
    shortInterest: "short interest / borrow / options 信息",
    strategic: "战略交易 / 银行事件",
    valuation: "估值区间",
    price: "价位参考",
    catalysts: "关键催化剂",
    risks: "主要风险",
    position: "仓位建议",
    shortTerm: "短线 1-4 周判断",
    mediumTerm: "中期 3-6 个月判断",
    longTerm: "长期 12 个月判断",
    gaps: "数据缺口/未覆盖项",
    invalidation: "反证条件",
    confidence: "置信度",
    sources: "来源表",
    rating: "评级", winner: "辩论胜方", summary: "摘要", verdict: "最终判断",
    status: "状态", findings: "关键发现", questions: "待确认问题", sourceIds: "来源",
    noEvidence: "该必需分析席没有留下可用证据包；这是一项明确的数据缺口。",
    noFindings: "没有记录更多带来源的发现。",
    noQuestions: "没有记录更多待确认问题。",
    noDebate: "没有记录可用辩论包。",
    noSectionEvidence: "对应证据包没有记录更多细节；应视为数据不可得，而不是正面结论。",
    noCatalysts: "没有记录更多带来源的催化剂。",
    noRisks: "除已列反证条件外，没有记录更多风险。",
    noGaps: "已完成的证据包未发现关键数据缺口。",
    noInvalidation: "没有记录更多反证条件。",
    priceMissing: "结构化 PM 决策没有确定这一档；行动前必须取得有证据支持的数值边界。",
    upper: "不该碰", start: "值得建仓", lower: "显著低估",
    upperMeaning: "高于有证据支持的上限后，潜在回报不足以补偿已记录风险。",
    startMeaning: "在有依据的估值区间内，且论点仍成立时，才可考虑有上限的初始仓位。",
    lowerMeaning: "低于有证据支持的下沿后，只有所有反证测试仍通过时才可加仓。",
    noAction: "价位边界缺失时不得据此推导交易。",
    sourceUnavailable: "没有可用来源记录。",
    round: "第", bull: "多头", bear: "空头", answers: "逐题回答", asked: "提出的问题",
  }),
  ja: Object.freeze({
    title: "投資委員会レポート",
    conclusion: "結論",
    analystLog: "アナリスト作業記録",
    debate: "強気弱気討論記録",
    weights: "確定済み座席ウェイト監査",
    long: "強気論点",
    short: "弱気論点",
    market: "市場予想と織り込み条件",
    analystRating: "アナリスト評価と目標株価の変更",
    earnings: "決算説明会の経営シグナル",
    quant: "定量・ファクター視点",
    news: "ニュースと企業・業界シグナル",
    shortInterest: "空売り・貸株・オプション情報",
    strategic: "戦略取引・銀行イベント",
    valuation: "企業価値評価レンジ",
    price: "価格条件",
    catalysts: "カタリスト",
    risks: "リスク",
    position: "ポジション",
    shortTerm: "短期1–4週間の見通し",
    mediumTerm: "中期3–6か月の見通し",
    longTerm: "長期12か月の見通し",
    gaps: "データ欠落・利用不可データ",
    invalidation: "無効化条件",
    confidence: "信頼度",
    sources: "出典表",
    rating: "評価", winner: "討論の優勢側", summary: "要約", verdict: "最終判断",
    status: "状態", findings: "主な所見", questions: "未解決事項", sourceIds: "出典",
    noEvidence: "この必須分析席には利用可能な証拠パケットがなく、明示的なデータ欠落として扱います。",
    noFindings: "追加の出典付き所見は記録されていません。",
    noQuestions: "追加の未解決事項は記録されていません。",
    noDebate: "利用可能な討論パケットは記録されていません。",
    noSectionEvidence: "該当する証拠パケットに追加情報がなく、肯定的所見ではなく利用不可データとして扱います。",
    noCatalysts: "追加の出典付きカタリストは記録されていません。",
    noRisks: "無効化条件以外の追加リスクは記録されていません。",
    noGaps: "完了した証拠パケットに重大なデータ欠落はありません。",
    noInvalidation: "追加の無効化条件は記録されていません。",
    priceMissing: "構造化PM判断はこの価格帯を確定していません。行動前に証拠に基づく数値境界が必要です。",
    upper: "見送る水準", start: "初期ポジションを検討する水準", lower: "大幅な割安水準",
    upperMeaning: "証拠に基づく上限を超えると、期待収益が記録済みリスクを補えません。",
    startMeaning: "根拠ある評価レンジ内で投資仮説が有効な場合に限り、限定的な初期配分を検討します。",
    lowerMeaning: "根拠ある下限を下回る場合でも、全ての無効化テストが通ることを追加条件とします。",
    noAction: "価格境界が欠落した状態で取引を推定しません。",
    sourceUnavailable: "利用可能な出典記録がありません。",
    round: "ラウンド", bull: "強気", bear: "弱気", answers: "回答", asked: "質問",
  }),
  ko: Object.freeze({
    title: "투자위원회 보고서",
    conclusion: "결론",
    analystLog: "분석가 작업 기록",
    debate: "강세·약세 토론 기록",
    weights: "확정 좌석 가중치 감사",
    long: "강세 논거",
    short: "약세 논거",
    market: "시장 기대",
    analystRating: "애널리스트 등급 및 목표가 변경",
    earnings: "실적 발표 콜 경영진 신호",
    quant: "정량·팩터 관점",
    news: "뉴스 및 기업·산업 신호",
    shortInterest: "공매도·대차·옵션 정보",
    strategic: "전략적 거래·금융 이벤트",
    valuation: "가치평가 범위",
    price: "가격 조건",
    catalysts: "핵심 촉매",
    risks: "주요 위험",
    position: "포지션 제안",
    shortTerm: "단기 1–4주 전망",
    mediumTerm: "중기 3–6개월 전망",
    longTerm: "장기 12개월 전망",
    gaps: "데이터 공백·사용 불가 데이터",
    invalidation: "무효화 조건",
    confidence: "신뢰도",
    sources: "출처 표",
    rating: "등급", winner: "토론 우세 측", summary: "요약", verdict: "최종 판단",
    status: "상태", findings: "핵심 발견", questions: "미해결 질문", sourceIds: "출처",
    noEvidence: "이 필수 분석 좌석에는 사용 가능한 증거 패킷이 없으며 명시적인 데이터 공백입니다.",
    noFindings: "추가로 기록된 출처 기반 발견이 없습니다.",
    noQuestions: "추가로 기록된 미해결 질문이 없습니다.",
    noDebate: "사용 가능한 토론 패킷이 기록되지 않았습니다.",
    noSectionEvidence: "해당 증거 패킷에 추가 세부 정보가 없으며 긍정적 발견이 아닌 사용 불가 데이터로 처리합니다.",
    noCatalysts: "추가로 기록된 출처 기반 촉매가 없습니다.",
    noRisks: "무효화 조건 외에 추가로 기록된 위험이 없습니다.",
    noGaps: "완료된 증거 패킷에서 중대한 데이터 공백이 발견되지 않았습니다.",
    noInvalidation: "추가로 기록된 무효화 조건이 없습니다.",
    priceMissing: "구조화된 PM 판단이 이 가격대를 확정하지 않았으므로 행동 전에 증거 기반 수치 경계가 필요합니다.",
    upper: "접근 금지 수준", start: "초기 포지션 검토 수준", lower: "현저한 저평가 수준",
    upperMeaning: "증거 기반 상단을 넘으면 기대 보상이 기록된 위험을 보상하지 못합니다.",
    startMeaning: "근거 있는 가치평가 범위에서 투자 논리가 유효한 경우에만 제한된 초기 포지션을 검토합니다.",
    lowerMeaning: "근거 있는 하단보다 낮아도 모든 무효화 검사가 통과할 때만 추가 매수를 검토합니다.",
    noAction: "가격 경계가 누락된 상태에서는 거래를 추론하지 않습니다.",
    sourceUnavailable: "사용 가능한 출처 기록이 없습니다.",
    round: "라운드", bull: "강세", bear: "약세", answers: "답변", asked: "질문",
  }),
});

function packetFor(run, task) {
  return (run?.packets || []).find((packet) => packet?.task === task) || null;
}

function packetSourceIds(packet) {
  return uniqueStrings([
    ...(packet?.claims || []).flatMap((claim) => claim?.source_ids || []),
    ...(packet?.sources || []).map((source) => source?.id),
  ]);
}

function packetBody(run, task, copy) {
  const packet = packetFor(run, task);
  if (!packet) return copy.noEvidence;
  const claims = (packet.claims || []).map((claim) => {
    const body = [inline(claim?.claim), inline(claim?.evidence)].filter(Boolean).join(" — ");
    return `${body}${sourceSuffix(claim?.source_ids, copy)}`;
  });
  const gaps = (packet.open_questions || []).map(inline).filter(Boolean);
  return [
    inline(packet.summary) || copy.noSectionEvidence,
    claims.length ? bullets(claims, copy.noFindings) : `- ${copy.noFindings}`,
    gaps.length ? `${copy.questions}:\n${bullets(gaps, copy.noQuestions)}` : "",
    sourceSuffix(packetSourceIds(packet), copy).trim(),
  ].filter(Boolean).join("\n\n");
}

function analystLog(run, copy) {
  return (run?.tasks || []).map((task) => {
    const packet = packetFor(run, task);
    const status = run?.task_status?.[task]?.status || (packet ? "completed" : "missing");
    return [
      `### ${inline(task)}`,
      `- ${copy.status}: ${inline(status)}`,
      `- ${copy.summary}: ${inline(packet?.summary) || copy.noEvidence}`,
      `- ${copy.findings}:`,
      bullets((packet?.claims || []).map((claim) => `${inline(claim?.claim)}${sourceSuffix(claim?.source_ids, copy)}`), copy.noFindings),
      `- ${copy.questions}:`,
      bullets(packet?.open_questions, copy.noQuestions),
    ].join("\n");
  }).join("\n\n") || copy.noEvidence;
}

function debateSide(label, packet, copy) {
  if (!packet) return `### ${label}\n${copy.noDebate}`;
  const rounds = Array.isArray(packet.debate_rounds) && packet.debate_rounds.length
    ? packet.debate_rounds
    : [packet];
  return [
    `### ${label}`,
    `${copy.summary}: ${inline(packet.summary) || copy.noDebate}`,
    ...rounds.map((round, index) => [
      `#### ${copy.round} ${round?.round || index + 1}`,
      inline(round?.summary) || copy.noDebate,
      bullets([...(round?.long_thesis || []), ...(round?.short_thesis || [])], copy.noFindings),
      `**${copy.asked}:**`,
      bullets(round?.questions, copy.noQuestions),
      `**${copy.answers}:**`,
      bullets((round?.questions_answered || []).map((item) => `${inline(item?.question)} — ${inline(item?.answer)}`), copy.noQuestions),
    ].join("\n\n")),
  ].join("\n\n");
}

function priceRows(decision, copy) {
  const supplied = Array.isArray(decision?.price_levels) ? decision.price_levels.slice(0, 8) : [];
  const fallback = [
    { label: copy.upper, range: copy.priceMissing, meaning: copy.upperMeaning, action: copy.noAction, basis: inline(decision?.valuation_range) || copy.priceMissing },
    { label: copy.start, range: inline(decision?.valuation_range) || copy.priceMissing, meaning: copy.startMeaning, action: inline(decision?.position) || copy.noAction, basis: sourceSuffix(decision?.source_ids, copy) || copy.priceMissing },
    { label: copy.lower, range: copy.priceMissing, meaning: copy.lowerMeaning, action: inline(decision?.position) || copy.noAction, basis: bullets(decision?.invalidation, copy.noInvalidation).replace(/^- /u, "") },
  ];
  const rows = supplied.length >= 3 ? supplied : fallback;
  return [
    "| Band | Price range | What this price implies | Action | Basis |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row, index) => `| ${inline(row?.label) || fallback[index % 3].label} | ${inline(row?.range) || copy.priceMissing} | ${inline(row?.meaning) || copy.priceMissing} | ${inline(row?.action) || copy.noAction} | ${inline(row?.basis) || copy.priceMissing}${sourceSuffix(row?.source_ids, copy)} |`),
  ].join("\n");
}

function horizon(decision, field, fallbackParts, copy) {
  const value = inline(decision?.horizon_views?.[field]);
  if (value) return `${value}${sourceSuffix(decision?.source_ids, copy)}`;
  return `${fallbackParts.map(inline).filter(Boolean).join(" ") || copy.noSectionEvidence}${sourceSuffix(decision?.source_ids, copy)}`;
}

function sourceTable(run, copy) {
  const sources = (run?.packets || []).flatMap((packet) => packet?.sources || []);
  if (!sources.length) return `- ${copy.sourceUnavailable}`;
  return [
    "| Source ID | Title | Published | URL |",
    "| --- | --- | --- | --- |",
    ...sources.map((source) => `| ${inline(source?.id)} | ${inline(source?.title)} | ${inline(source?.published_at) || "unknown"} | ${inline(source?.url)} |`),
  ].join("\n");
}

export function managerDecisionNestedSourceIds(decision) {
  return uniqueStrings([
    ...(decision?.source_ids || []),
    ...(Array.isArray(decision?.price_levels)
      ? decision.price_levels.flatMap((row) => row?.source_ids || [])
      : []),
  ]);
}

export function renderStructuredManagerReport(run, decision, { bull = null, bear = null } = {}) {
  const copy = COPY[languageKey(run?.language)] || COPY.en;
  const resolvedWeightTable = weightTableMarkdown(
    resolveSeatWeights(run || {}, run?.seat_weight_overrides || {}),
    run?.language,
  );
  const gaps = uniqueStrings([
    ...(decision?.data_gaps || []),
    ...(run?.packets || []).flatMap((packet) => packet?.open_questions || []),
  ]);
  const citations = sourceSuffix(decision?.source_ids, copy);
  const conclusion = [
    `- ${copy.rating}: ${inline(decision?.rating)}`,
    `- ${copy.winner}: ${inline(decision?.winner)}`,
    `- ${copy.verdict}: ${inline(decision?.verdict)}${citations}`,
    `- ${copy.summary}: ${inline(decision?.summary)}${citations}`,
  ].join("\n");
  return [
    `# ${inline(run?.symbol)} ${copy.title}`,
    `## ${copy.conclusion}\n${conclusion}`,
    `## ${copy.analystLog}\n${analystLog(run, copy)}`,
    `## ${copy.debate}\n${debateSide(copy.bull, bull, copy)}\n\n${debateSide(copy.bear, bear, copy)}\n\n- ${copy.winner}: ${inline(decision?.winner)}`,
    resolvedWeightTable ? `## ${copy.weights}\n${resolvedWeightTable}` : "",
    `## ${copy.long}\n${bullets(decision?.long_thesis, copy.noFindings)}\n${citations}`,
    `## ${copy.short}\n${bullets(decision?.short_thesis, copy.noFindings)}\n${citations}`,
    `## ${copy.market}\n${packetBody(run, "forward_expectations", copy)}`,
    `## ${copy.analystRating}\n${packetBody(run, "forward_expectations", copy)}`,
    `## ${copy.earnings}\n${packetBody(run, "earnings_deep_dive", copy)}`,
    `## ${copy.quant}\n${packetBody(run, "quant_factor", copy)}`,
    `## ${copy.news}\n${packetBody(run, "news_industry_management", copy)}`,
    `## ${copy.shortInterest}\n${packetBody(run, "quant_factor", copy)}`,
    `## ${copy.strategic}\n${packetBody(run, "ib_event_analysis", copy)}`,
    `## ${copy.valuation}\n${inline(decision?.valuation_range) || copy.noSectionEvidence}${citations}\n\n${packetBody(run, "valuation_long_short", copy)}`,
    `## ${copy.price}\n${priceRows(decision, copy)}`,
    `## ${copy.catalysts}\n${bullets(decision?.catalysts, copy.noCatalysts)}\n${citations}`,
    `## ${copy.risks}\n${bullets(decision?.risks, copy.noRisks)}\n${citations}`,
    `## ${copy.position}\n${inline(decision?.position) || copy.noAction}${citations}`,
    `## ${copy.shortTerm}\n${horizon(decision, "short_term", [decision?.summary, decision?.catalysts?.[0]], copy)}`,
    `## ${copy.mediumTerm}\n${horizon(decision, "medium_term", [decision?.position, decision?.risks?.[0]], copy)}`,
    `## ${copy.longTerm}\n${horizon(decision, "long_term", [decision?.long_thesis?.[0], decision?.invalidation?.[0]], copy)}`,
    `## ${copy.gaps}\n${bullets(gaps, copy.noGaps)}`,
    `## ${copy.invalidation}\n${bullets(decision?.invalidation, copy.noInvalidation)}\n${citations}`,
    `## ${copy.confidence}\n${inline(decision?.confidence)}`,
    `## ${copy.sources}\n${sourceTable(run, copy)}`,
  ].join("\n\n");
}
