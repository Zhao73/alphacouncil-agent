import { fetchQuote } from "./quotes.mjs";
import { invalidParams } from "./errors.mjs";

/**
 * Top-down macro context, built entirely from the keyless quote pipeline.
 *
 * Everything here is a market-priced series, so the snapshot is a set of observations
 * rather than a forecast. No API key, no vendor account: the same Yahoo/Stooq path
 * get_quote already uses.
 *
 * Deliberately NOT included: any single number claiming to say what "the regime" is.
 * The blocks give the inputs; the macro_regime persona has to argue the reading and say
 * what it means for the specific name under research.
 */
export const MACRO_BLOCKS = [
  {
    id: "rates",
    title: { zh: "利率曲线", en: "Rate curve" },
    why: {
      zh: "曲线形状决定了折现率和银行的放贷意愿；倒挂是最被过度解读也最不该忽略的一个信号。",
      en: "The curve sets the discount rate and the willingness of banks to lend. Inversion is the most over-read and least ignorable signal on this list.",
    },
    members: [
      { symbol: "^IRX", label: "US 3M" },
      { symbol: "^FVX", label: "US 5Y" },
      { symbol: "^TNX", label: "US 10Y" },
      { symbol: "^TYX", label: "US 30Y" },
    ],
  },
  {
    id: "dollar_liquidity",
    title: { zh: "美元与流动性", en: "Dollar and liquidity" },
    why: {
      zh: "美元走强会同时压制非美盈利和大宗；信用利差决定弱资产负债表的公司能不能续命。",
      en: "A stronger dollar compresses non-US earnings and commodities at once, and credit spreads decide whether weak balance sheets can refinance.",
    },
    members: [
      { symbol: "DX-Y.NYB", label: "Dollar index" },
      { symbol: "^VIX", label: "VIX" },
      { symbol: "HYG", label: "High yield" },
      { symbol: "LQD", label: "Investment grade" },
    ],
  },
  {
    id: "commodities",
    title: { zh: "商品", en: "Commodities" },
    why: {
      zh: "铜金比是最便宜的增长代理；油价同时是成本项和通胀项。",
      en: "The copper-gold ratio is the cheapest available growth proxy, and oil is simultaneously a cost line and an inflation input.",
    },
    members: [
      { symbol: "CL=F", label: "Crude" },
      { symbol: "GC=F", label: "Gold" },
      { symbol: "HG=F", label: "Copper" },
    ],
  },
  {
    id: "risk_appetite",
    title: { zh: "风险偏好与市场宽度", en: "Risk appetite and breadth" },
    why: {
      zh: "等权重相对市值加权的表现，揭示涨势是普遍的还是被少数权重股撑起来的。",
      en: "Equal weight against cap weight reveals whether a rally is broad or is being carried by a handful of index heavyweights.",
    },
    members: [
      { symbol: "^GSPC", label: "S&P 500" },
      { symbol: "^NDX", label: "Nasdaq 100" },
      { symbol: "RSP", label: "S&P equal weight" },
      { symbol: "SPY", label: "S&P cap weight" },
      { symbol: "^SOX", label: "Semiconductors" },
    ],
  },
  {
    id: "cross_market",
    title: { zh: "跨市场", en: "Cross market" },
    why: {
      zh: "非美市场常常先于美股反映同一个宏观变化，尤其对出口链和供应链敏感的标的。",
      en: "Non-US markets often price the same macro change first, especially for export and supply-chain exposed names.",
    },
    members: [
      { symbol: "^N225", label: "Japan" },
      { symbol: "^HSI", label: "Hong Kong" },
      { symbol: "000001.SS", label: "China A" },
      { symbol: "^KS11", label: "Korea" },
      { symbol: "^TWII", label: "Taiwan" },
    ],
  },
];

const price = (quotes, symbol) => {
  const quote = quotes.get(symbol);
  return quote && !quote.error && Number.isFinite(quote.price) ? quote.price : null;
};

/**
 * Ratios and spreads that are only meaningful as a pair. Each returns null rather than a
 * guess when either leg is unavailable, so a data gap stays visible as a data gap.
 */
function derived(quotes) {
  const out = [];
  const push = (id, label, value, note) => out.push({ id, label, value, available: value !== null, note });

  const y3m = price(quotes, "^IRX");
  const y10 = price(quotes, "^TNX");
  const y5 = price(quotes, "^FVX");
  const y30 = price(quotes, "^TYX");

  push("spread_10y_3m", "10Y minus 3M", y10 !== null && y3m !== null ? Number((y10 - y3m).toFixed(3)) : null,
    "Negative is an inverted curve. The most-watched recession proxy, and the one most often read too early.");
  push("spread_30y_5y", "30Y minus 5Y", y30 !== null && y5 !== null ? Number((y30 - y5).toFixed(3)) : null,
    "Steepening at the long end usually prices term premium or inflation risk rather than growth.");

  const copper = price(quotes, "HG=F");
  const gold = price(quotes, "GC=F");
  push("copper_gold", "Copper / gold", copper !== null && gold !== null ? Number((copper / gold).toFixed(6)) : null,
    "Rising is a growth signal, falling is a flight to safety. A cheap real-time growth proxy.");

  const hyg = price(quotes, "HYG");
  const lqd = price(quotes, "LQD");
  push("hyg_lqd", "High yield / investment grade", hyg !== null && lqd !== null ? Number((hyg / lqd).toFixed(4)) : null,
    "Falling means credit is repricing risk; weak balance sheets feel this before equity does.");

  const rsp = price(quotes, "RSP");
  const spy = price(quotes, "SPY");
  push("breadth_rsp_spy", "Equal weight / cap weight", rsp !== null && spy !== null ? Number((rsp / spy).toFixed(4)) : null,
    "Falling means the index is being carried by its largest members rather than by broad participation.");

  return out;
}

export async function getMacroSnapshot(args = {}) {
  const requested = Array.isArray(args?.blocks) && args.blocks.length ? args.blocks : MACRO_BLOCKS.map((b) => b.id);
  const unknown = requested.filter((id) => !MACRO_BLOCKS.some((b) => b.id === id));
  if (unknown.length) {
    throw invalidParams(`unknown macro block(s): ${unknown.join(", ")}. Available: ${MACRO_BLOCKS.map((b) => b.id).join(", ")}`);
  }
  const blocks = MACRO_BLOCKS.filter((block) => requested.includes(block.id));
  const symbols = [...new Set(blocks.flatMap((block) => block.members.map((m) => m.symbol)))];

  const results = await Promise.all(symbols.map((symbol) => fetchQuote(symbol).catch((error) => ({
    query: symbol,
    error: String(error?.message || error),
  }))));
  const quotes = new Map(symbols.map((symbol, index) => [symbol, results[index]]));

  const unavailable = [];
  const rendered = blocks.map((block) => ({
    id: block.id,
    title: block.title,
    why_it_matters: block.why,
    members: block.members.map((member) => {
      const quote = quotes.get(member.symbol);
      if (!quote || quote.error) unavailable.push(`${member.label} (${member.symbol})`);
      return { ...member, quote };
    }),
  }));

  return {
    as_of: new Date().toISOString(),
    blocks: rendered,
    derived: derived(quotes),
    unavailable,
    disclaimer:
      "Keyless delayed market data (Yahoo/Stooq, ~15m or EOD). These are observations, not a regime call: "
      + "read them, do not report them. Anything in `unavailable` is a data gap and belongs in open_questions, "
      + "never a number filled in from memory.",
  };
}
