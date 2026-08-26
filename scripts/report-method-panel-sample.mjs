#!/usr/bin/env node
/** Emit one raw, deterministic 26-decision sample for reviewer inspection. */

import { catalogSnapshot } from "../mcp/lib/council-selection.mjs";
import { recommendMethodPanel } from "../mcp/lib/method-panel-recommendation.mjs";

const catalog = catalogSnapshot("English");
const sample = recommendMethodPanel({
  catalog_hash: catalog.catalog_hash,
  instrument_classification: {
    asset_type: "equity",
    research_model: "operating_company",
    classification_source: "review_sample_not_live_market_data",
  },
  typed_fact_coverage: [
    "accounting.cash_conversion",
    "capital_allocation.share_count",
    "financial.free_cash_flow_5y",
    "financial.leverage",
    "financial.owner_earnings",
    "macro.credit_spread",
    "market.price",
    "valuation.revenue_growth",
  ],
});

process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
