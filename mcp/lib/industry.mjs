import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invalidParams } from "./errors.mjs";
import { fetchUniverse, fetchSubmissions } from "./sec.mjs";

/**
 * Industry framing.
 *
 * A question like "how does memory look right now" cannot be answered by a pipeline whose
 * only entry point is a single ticker, and it cannot be answered honestly by asking a
 * model to list the participants either -- that produces the names it saw most often,
 * silently dropping the ones that do not file with the SEC. SK hynix and Kioxia are
 * exactly the companies such a list loses, and in memory they are most of the industry.
 *
 * So the participant list is data, hand-maintained and explicitly incomplete, and the map
 * carries the two things a model reliably gets wrong on its own: which link in the chain
 * currently binds, and who actually creates the orders.
 */
const MAP_PATH = fileURLToPath(new URL("../../data/industry-map.json", import.meta.url));

let cached = null;
function load() {
  if (!cached) cached = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  return cached;
}

export function listIndustries() {
  const { industries } = load();
  return Object.entries(industries).map(([id, entry]) => ({
    id,
    title: entry.title,
    aliases: entry.aliases,
    participant_count: entry.layers.reduce((n, l) => n + l.participants.length, 0),
  }));
}

/** Resolve a free-text industry query against ids and aliases. */
export function resolveIndustry(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw invalidParams("industry query is empty");
  const { industries } = load();
  for (const [id, entry] of Object.entries(industries)) {
    if (id === needle) return { id, ...entry };
    if (entry.aliases.some((a) => a.toLowerCase() === needle)) return { id, ...entry };
  }
  // Fall back to substring so "存储芯片行业" or "HBM memory" still lands.
  for (const [id, entry] of Object.entries(industries)) {
    if (entry.aliases.some((a) => needle.includes(a.toLowerCase()) || a.toLowerCase().includes(needle))) {
      return { id, ...entry };
    }
  }
  return null;
}

/**
 * Everything a research run needs to start on an industry rather than a ticker.
 *
 * Deliberately returns no verdict. It returns the frame: participants by chain position
 * with their market and filing regime, who drives demand, the questions that must be
 * answered, and how the industry behaves through a cycle -- because reading a cyclical's
 * low P/E as cheap is the most expensive mistake available here.
 */
export function industryBrief(query) {
  const entry = resolveIndustry(query);
  if (!entry) {
    const known = listIndustries().map((i) => `${i.id} (${i.aliases.slice(0, 3).join(", ")})`);
    throw invalidParams(`no industry map for "${query}". Mapped industries: ${known.join("; ") || "none"}. Add one in data/industry-map.json.`);
  }

  const participants = entry.layers.flatMap((layer) =>
    layer.participants.map((p) => ({ ...p, layer: layer.layer })));

  // Which names this pipeline can screen mechanically, and which it cannot. Saying so up
  // front stops a run from quietly becoming US-only.
  const secScreenable = participants.filter((p) => p.symbol && p.market.includes("US"));
  const needsOtherSource = participants.filter((p) => p.symbol && !p.market.includes("US"));
  const unlisted = participants.filter((p) => !p.symbol);

  return {
    id: entry.id,
    title: entry.title,
    layers: entry.layers,
    participants,
    demand_drivers: entry.demand_drivers,
    key_questions: entry.key_questions,
    cyclicality: entry.cyclicality,
    coverage: {
      sec_screenable: secScreenable.map((p) => p.symbol),
      needs_local_regulator_feed: needsOtherSource.map((p) => ({ symbol: p.symbol, market: p.market })),
      unlisted: unlisted.map((p) => p.name),
      note:
        "screen_ticker and the SEC concepts cover US filers only. Korean, Japanese and Taiwanese participants "
        + "have to be researched through search and their own regulators (DART, EDINET, MOPS), and unlisted "
        + "capacity still moves global supply. Treat any conclusion drawn only from the US-listed subset as "
        + "partial, and say so.",
    },
    how_to_use:
      "This is a frame, not an answer. Run the council on the participants that matter for the question asked, "
      + "check the demand drivers' own disclosures rather than press coverage of them, and answer the key "
      + "questions explicitly. Guidance is not an order: distinguish what a customer said it plans to spend "
      + "from what has actually been ordered and at what lead time.",
  };
}


/**
 * SIC industry groups. This is the half that covers EVERY industry rather than the
 * handful someone has written a map for.
 *
 * SEC assigns a SIC code to every filer, so grouping by it classifies the whole US
 * universe with no curation and no model. What it cannot give is the part a curated map
 * exists for: chain position, non-US participants, and who actually creates the orders.
 * So the two are used together and the brief says which half it is standing on.
 */

/** Broad SIC ranges, so a query like "banks" or "biotech" lands without an exact code. */
export const SIC_GROUPS = [
  { id: "agriculture", range: [100, 999], title: { zh: "农业", en: "Agriculture" } },
  { id: "mining_energy", range: [1000, 1499], title: { zh: "采矿与能源", en: "Mining and energy" } },
  { id: "construction", range: [1500, 1799], title: { zh: "建筑", en: "Construction" } },
  { id: "food_beverage", range: [2000, 2199], title: { zh: "食品饮料", en: "Food and beverage" } },
  { id: "textiles_apparel", range: [2200, 2399], title: { zh: "纺织服装", en: "Textiles and apparel" } },
  { id: "paper_packaging", range: [2400, 2679], title: { zh: "造纸与包装", en: "Paper and packaging" } },
  { id: "publishing", range: [2700, 2799], title: { zh: "出版印刷", en: "Publishing and printing" } },
  { id: "chemicals", range: [2800, 2899], title: { zh: "化工", en: "Chemicals" } },
  { id: "pharma_biotech", range: [2833, 2836], title: { zh: "医药与生物科技", en: "Pharma and biotech" } },
  { id: "energy_refining", range: [2900, 2999], title: { zh: "炼化", en: "Refining" } },
  { id: "rubber_plastics", range: [3000, 3199], title: { zh: "橡胶塑料", en: "Rubber and plastics" } },
  { id: "building_materials", range: [3200, 3299], title: { zh: "建材", en: "Building materials" } },
  { id: "metals", range: [3300, 3399], title: { zh: "金属", en: "Metals" } },
  { id: "fabricated_metal", range: [3400, 3499], title: { zh: "金属制品", en: "Fabricated metal products" } },
  { id: "machinery", range: [3500, 3569], title: { zh: "机械", en: "Machinery" } },
  { id: "computers_hardware", range: [3570, 3579], title: { zh: "计算机硬件", en: "Computers and hardware" } },
  { id: "industrial_equipment", range: [3580, 3599], title: { zh: "工业设备", en: "Industrial equipment" } },
  { id: "electronics", range: [3600, 3673], title: { zh: "电子", en: "Electronics" } },
  { id: "semiconductors", range: [3674, 3674], title: { zh: "半导体", en: "Semiconductors" } },
  { id: "electrical_equipment", range: [3675, 3699], title: { zh: "电气设备", en: "Electrical equipment" } },
  { id: "autos", range: [3700, 3719], title: { zh: "汽车", en: "Automobiles" } },
  { id: "aerospace_defense", range: [3720, 3799], title: { zh: "航空航天与国防", en: "Aerospace and defense" } },
  { id: "instruments_medical", range: [3800, 3879], title: { zh: "仪器与医疗器械", en: "Instruments and medical devices" } },
  { id: "manufacturing_other", range: [3880, 3999], title: { zh: "其他制造", en: "Other manufacturing" } },
  { id: "transportation", range: [4000, 4799], title: { zh: "运输", en: "Transportation" } },
  { id: "telecom", range: [4800, 4899], title: { zh: "电信", en: "Telecom" } },
  { id: "utilities", range: [4900, 4999], title: { zh: "公用事业", en: "Utilities" } },
  { id: "wholesale", range: [5000, 5199], title: { zh: "批发分销", en: "Wholesale and distribution" } },
  { id: "retail", range: [5200, 5999], title: { zh: "零售", en: "Retail" } },
  { id: "banks", range: [6000, 6199], title: { zh: "银行", en: "Banks" } },
  { id: "brokers_asset_managers", range: [6200, 6299], title: { zh: "券商与资产管理", en: "Brokers and asset managers" } },
  { id: "insurance", range: [6300, 6411], title: { zh: "保险", en: "Insurance" } },
  { id: "financial_services", range: [6412, 6499], title: { zh: "金融服务", en: "Financial services" } },
  { id: "real_estate", range: [6500, 6799], title: { zh: "房地产", en: "Real estate" } },
  { id: "hospitality_leisure", range: [7000, 7099], title: { zh: "酒店与休闲", en: "Hospitality and leisure" } },
  { id: "business_services", range: [7100, 7369], title: { zh: "商业服务", en: "Business services" } },
  { id: "software", range: [7370, 7379], title: { zh: "软件与IT服务", en: "Software and IT services" } },
  { id: "consumer_services", range: [7380, 7799], title: { zh: "消费服务", en: "Consumer services" } },
  { id: "media_entertainment", range: [7800, 7999], title: { zh: "影视与娱乐", en: "Media and entertainment" } },
  { id: "healthcare_services", range: [8000, 8099], title: { zh: "医疗服务", en: "Healthcare services" } },
  { id: "professional_services", range: [8100, 8730], title: { zh: "专业服务", en: "Professional services" } },
  { id: "research_services", range: [8731, 8734], title: { zh: "研究服务", en: "Research services" } },
  { id: "other_services", range: [8735, 8999], title: { zh: "其他服务", en: "Other services" } },
];

export function sicGroupFor(sic) {
  const code = Number(sic);
  if (!Number.isFinite(code)) return null;
  // Narrowest matching range wins, so 3674 is semiconductors rather than electronics.
  const matches = SIC_GROUPS.filter((g) => code >= g.range[0] && code <= g.range[1]);
  if (!matches.length) return null;
  return matches.sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]))[0];
}

let universeCache = null;

/**
 * Every US filer whose SIC matches a query, with no curation involved.
 *
 * Resolving each company's SIC needs one request per company, which is far too many for
 * a 10k universe, so this works from a caller-supplied candidate list or from a name
 * match. It is a starting universe, not a definitive index membership list, and says so.
 */
export async function peersBySic({ cik, limit = 25 } = {}) {
  if (!cik) throw invalidParams("peersBySic needs a cik to anchor on");
  const anchor = await fetchSubmissions(cik);
  if (!anchor.sic) {
    return { anchor, group: null, peers: [], note: "SEC has no SIC classification for this filer." };
  }
  const group = sicGroupFor(anchor.sic);

  if (!universeCache) universeCache = await fetchUniverse();
  // Company names are the only universe-wide signal available without 10k requests.
  const words = anchor.name.toLowerCase().split(/\s+/).filter((w) => w.length > 4 && !/corp|inc|company|holdings|group|technologies/.test(w));
  const nameMatched = words.length
    ? universeCache.filter((c) => c.cik !== anchor.cik && words.some((w) => c.title.toLowerCase().includes(w)))
    : [];

  return {
    anchor,
    group: group ? { id: group.id, title: group.title, sic_range: group.range } : null,
    sic: anchor.sic,
    sic_description: anchor.sic_description,
    peers: nameMatched.slice(0, limit),
    note:
      `SIC ${anchor.sic} (${anchor.sic_description}) classifies this filer. SIC covers every US filer, so it `
      + "reaches industries no curated map has, but it says nothing about position in a value chain, about "
      + "non-US participants, or about who creates the demand. Where industry_brief has a curated map, prefer it "
      + "and use this only to widen the candidate list. Peer matching here is by company name and is a starting "
      + "point, not an index membership list.",
  };
}

/** Which half of the industry story is available for a query. */
export function industryCoverage(query) {
  const curated = resolveIndustry(query);
  const needle = String(query || "").toLowerCase();
  const sicGroup = SIC_GROUPS.find((g) =>
    g.id.includes(needle) || needle.includes(g.id) || g.title.en.toLowerCase().includes(needle) || g.title.zh.includes(query));
  return {
    query,
    curated: curated ? { id: curated.id, title: curated.title } : null,
    sic_group: sicGroup ? { id: sicGroup.id, title: sicGroup.title, sic_range: sicGroup.range } : null,
    guidance: curated
      ? "A curated map exists: use industry_brief for the chain, the non-US participants and the demand drivers."
      : sicGroup
        ? "No curated map, but SIC classifies this. Use screen_ticker on candidates and research the chain and "
          + "non-US participants through search -- and say in the report that the participant list is not curated."
        : "Neither a curated map nor a SIC group matched. Treat the participant list as research output, state that "
          + "it is not authoritative, and do not present it as complete.",
  };
}
