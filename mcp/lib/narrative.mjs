import { fetchFeeds, MARKET_FEEDS, queryNewsFeed } from "./feeds.mjs";
import { getMacroSnapshot } from "./macro.mjs";

/**
 * What story is the market currently telling itself, and does the tape agree?
 *
 * The pipeline could already read a company's filings and the macro tape, but not the
 * thing that actually moves crowded positioning: the prevailing narrative. That gap
 * matters because a name is repriced by the story it gets attached to long before its
 * fundamentals change.
 *
 * The design rule is the separation: **headlines are what people are saying, the macro
 * series is what happened.** Both are reported, never merged. When a theme dominates the
 * press and the corresponding series has not moved, that divergence is the finding -- it
 * is either a story running ahead of the data or a market that has stopped listening.
 *
 * Honest limitation, stated in the output: this can only find themes in its lexicon. It
 * will not discover an unnamed theme, and it says so rather than implying full coverage.
 */

/**
 * Each theme carries the terms that identify it and the series that would corroborate it.
 * `check` refers to a macro block member label or derived-measure id from macro.mjs, so a
 * claim about rates is answered by the actual 10-year rather than by more headlines.
 */
export const THEMES = [
  {
    id: "rates_policy",
    label: { zh: "利率与货币政策", en: "Rates and monetary policy" },
    terms: ["rate cut", "rate hike", "interest rate", "federal reserve", "fed ", "fomc", "powell",
      "monetary policy", "basis point", "tightening", "easing", "quantitative"],
    check: { series: ["US 10Y", "US 3M"], derived: ["spread_10y_3m"] },
  },
  {
    id: "treasury_yields",
    label: { zh: "美债收益率与财政", en: "Treasury yields and fiscal" },
    terms: ["treasury yield", "bond market", "10-year", "30-year", "debt ceiling", "deficit",
      "bond selloff", "auction", "fiscal", "sovereign debt"],
    check: { series: ["US 10Y", "US 30Y"], derived: ["spread_10y_3m"] },
  },
  {
    id: "inflation",
    label: { zh: "通胀", en: "Inflation" },
    terms: ["inflation", "cpi", "ppi", "price pressure", "disinflation", "core pce", "cost of living"],
    check: { series: ["Gold", "Crude"], derived: [] },
  },
  {
    id: "ai_capex",
    label: { zh: "AI 与资本开支周期", en: "AI and the capex cycle" },
    terms: ["artificial intelligence", " ai ", "data center", "datacenter", "capex", "capital expenditure",
      "hyperscaler", "gpu", "accelerator", "compute", "model training", "inference"],
    check: { series: ["Nasdaq 100", "Semiconductors"], derived: [] },
  },
  {
    id: "geopolitics",
    label: { zh: "地缘政治与能源", en: "Geopolitics and energy" },
    terms: ["iran", "israel", "ukraine", "russia", "strait", "middle east", "military strike",
      "sanction", "war", "conflict", "opec", "oil supply"],
    check: { series: ["Crude", "Gold"], derived: [] },
  },
  {
    id: "trade_tariffs",
    label: { zh: "关税与贸易", en: "Tariffs and trade" },
    terms: ["tariff", "trade war", "export control", "import duty", "trade deal", "supply chain",
      "decoupling", "entity list", "chip export"],
    check: { series: ["Dollar index"], derived: [] },
  },
  {
    id: "credit_stress",
    label: { zh: "信用与流动性压力", en: "Credit and liquidity stress" },
    terms: ["credit spread", "default", "bankruptcy", "refinancing risk", "refinancing wall",
      "high yield", "distressed", "bank failure", "liquidity crunch", "credit downgrade",
      "debt maturity", "covenant"],
    check: { series: ["High yield", "Investment grade", "VIX"], derived: ["hyg_lqd"] },
  },
  {
    id: "growth_recession",
    label: { zh: "增长与衰退", en: "Growth and recession" },
    terms: ["recession", "slowdown", "soft landing", "hard landing", "gdp", "unemployment",
      "jobless", "payroll", "layoff", "consumer spending"],
    check: { series: ["Copper", "Gold"], derived: ["copper_gold"] },
  },
  {
    id: "dollar_fx",
    label: { zh: "美元与汇率", en: "Dollar and currencies" },
    terms: ["dollar index", "currency", "yen", "euro", "devalu", "forex", "exchange rate", "peg"],
    check: { series: ["Dollar index"], derived: [] },
  },
  {
    id: "china",
    label: { zh: "中国", en: "China" },
    terms: ["china", "beijing", "yuan", "renminbi", "property developer", "stimulus", "pboc"],
    check: { series: ["China A", "Hong Kong"], derived: [] },
  },
  {
    id: "earnings_season",
    label: { zh: "财报季", en: "Earnings season" },
    terms: ["earnings", "guidance", "beat estimates", "missed estimates", "quarterly results",
      "profit margin", "revenue growth", "outlook cut", "outlook raise"],
    check: { series: ["S&P 500"], derived: [] },
  },
  {
    id: "politics_policy",
    label: { zh: "政治与监管", en: "Politics and regulation" },
    terms: ["election", "white house", "congress", "regulation", "antitrust", "executive order",
      "shutdown", "legislation", "president"],
    check: { series: [], derived: [] },
  },
];

const normalize = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;

/**
 * Match a term at a word boundary.
 *
 * Long terms match as a prefix so "tariff" catches "tariffs" and "refinanc" catches
 * "refinancing". Short ones must be whole words, because a prefix rule on "ai" would fire
 * on "aid" and "aircraft" and quietly inflate the AI theme -- the kind of error that makes
 * a coverage share look authoritative while being wrong.
 */
const hasTerm = (text, term) => {
  const t = normalize(term).trim();
  if (!t) return false;
  return t.length <= 3 ? text.includes(` ${t} `) : text.includes(` ${t}`);
};

/** Which themes does one headline touch? A headline may carry more than one. */
export function classify(title) {
  const text = normalize(title);
  const hits = [];
  for (const theme of THEMES) {
    const matched = theme.terms.filter((term) => hasTerm(text, term));
    if (matched.length) hits.push({ id: theme.id, matched });
  }
  return hits;
}

/** Pull the corroborating numbers for a theme out of an already-fetched macro snapshot. */
function marketCheck(theme, macro) {
  if (!macro) return { available: false, reason: "macro snapshot unavailable" };
  const series = [];
  for (const block of macro.blocks || []) {
    for (const member of block.members || []) {
      if (theme.check.series.includes(member.label)) {
        const q = member.quote || {};
        series.push({
          label: member.label,
          symbol: member.symbol,
          value: q.price ?? null,
          change_pct: q.change_pct ?? null,
          quote_time: q.quote_time ?? null,
          available: q.price != null,
        });
      }
    }
  }
  const derived = (macro.derived || [])
    .filter((d) => theme.check.derived.includes(d.id))
    .map((d) => ({ id: d.id, label: d.label, value: d.value ?? null, available: Boolean(d.available) }));
  if (!series.length && !derived.length) {
    return { available: false, reason: "no series in this snapshot corroborates this theme" };
  }
  return { available: true, series, derived };
}

export async function getMarketNarrative({ days = 7, asOf = null, extra_queries = [], top = 6 } = {}) {
  const specs = [
    ...MARKET_FEEDS,
    ...(Array.isArray(extra_queries) ? extra_queries.slice(0, 4).map((q) => queryNewsFeed(q)) : []),
  ];
  // The narrative and the tape are fetched independently on purpose; neither informs the other.
  const [news, macro] = await Promise.all([
    fetchFeeds(specs, { days, asOf }),
    getMacroSnapshot({}).catch(() => null),
  ]);

  const counts = new Map(THEMES.map((t) => [t.id, []]));
  let unclassified = 0;
  for (const item of news.items) {
    const hits = classify(item.title);
    if (!hits.length) { unclassified += 1; continue; }
    for (const hit of hits) counts.get(hit.id).push({ ...item, matched: hit.matched });
  }

  const total = news.items.length || 1;
  const themes = THEMES
    .map((theme) => {
      const items = counts.get(theme.id);
      const check = marketCheck(theme, macro);
      return {
        id: theme.id,
        label: theme.label,
        headline_count: items.length,
        share_of_coverage_pct: Number(((items.length / total) * 100).toFixed(1)),
        market_check: check,
        // Sample headlines carry their timestamp and link so any claim can be reopened.
        sample: items.slice(0, 4).map((i) => ({
          title: i.title, source: i.source, published_at: i.published_at, link: i.link, matched: i.matched,
        })),
      };
    })
    .filter((t) => t.headline_count > 0)
    .sort((a, b) => b.headline_count - a.headline_count)
    .slice(0, top);

  return {
    as_of: asOf || new Date().toISOString().slice(0, 10),
    window_days: days,
    headlines_in_window: news.items.length,
    excluded_outside_window: news.excluded_outside_window,
    excluded_sample: news.excluded_sample,
    feeds: news.feeds,
    unreachable: news.unreachable,
    themes,
    unclassified_headlines: unclassified,
    interpretation_rules: [
      "Headline counts measure what is being said, not what is true. A theme leading coverage "
      + "is evidence about attention and positioning, never about the underlying fact.",
      "Where a theme dominates coverage and its market_check series has not moved, that gap is "
      + "the finding: either the story is ahead of the data, or the market has stopped listening. "
      + "Say which you think it is and why.",
      "Never let a theme's prominence change a conclusion on a single name by itself. It sets "
      + "the environment the name is being priced in; it is not evidence about the business.",
    ],
    coverage_limits: [
      `Themes are matched against a fixed lexicon of ${THEMES.length} entries, so a genuinely new `
      + "narrative will land in unclassified_headlines rather than being discovered. "
      + `${unclassified} headlines in this window matched nothing.`,
      "English-language feeds only. A theme leading the Asian or European press and absent here "
      + "is a blind spot of this tool, not an absence of the theme.",
      "No social media. Positioning talk that lives on X or in group chats is not visible to "
      + "this layer, and a crowded trade can be crowded without appearing in any headline.",
    ],
  };
}
