import { registry, selectRoster } from "./personas/registry.mjs";

/**
 * How much each seat counts in the synthesis, and why.
 *
 * Two layers, both visible in the report:
 *
 *   1. A declared base weight per persona. Never hidden, always overridable.
 *   2. An adjustment driven by whether that seat's cited sources survived verification.
 *      A seat whose evidence was contradicted loses standing automatically -- it does not
 *      get to keep its share of the decision because its philosophy is well regarded.
 *
 * What this is NOT: an optimised allocation. Nobody can honestly claim to have found the
 * best weighting for a committee of language models, because measuring that would require
 * a return backtest of LLM judgment, and such a backtest is invalidated by look-ahead
 * bias -- the model already knows what happened after the as-of date. The weights are a
 * transparent, editable prior, and the report says so.
 */

/** Verifier outcomes that reduce a seat's standing, and by how much. */
const VERDICT_PENALTY = {
  contradicted: 1.0,
  disagree: 1.0,
  refuted: 1.0,
  source_does_not_mention: 0.75,
  partial: 0.4,
  weakened: 0.4,
  cannot_confirm: 0.3,
  source_unreachable: 0.3,
  superseded_by_newer: 0.3,
};

/** Floor so a penalised seat is quieter but never silently erased. */
const MIN_WEIGHT_FRACTION = 0.15;

export function baseWeight(persona) {
  const declared = persona?.default_weight;
  return Number.isFinite(declared) && declared > 0 ? declared : 1;
}

/**
 * @param {object[]} verdicts  [{ seat, verdict }] from the Stage 2b verifiers
 * @returns {{factor:number, reasons:string[]}}
 */
export function verificationAdjustment(seat, verdicts = []) {
  const mine = verdicts.filter((v) => v?.seat === seat && v?.verdict);
  if (mine.length === 0) return { factor: 1, reasons: [] };

  let penalty = 0;
  const reasons = [];
  for (const { verdict } of mine) {
    const hit = VERDICT_PENALTY[verdict];
    if (!hit) continue;
    penalty += hit;
    reasons.push(verdict);
  }
  if (penalty === 0) return { factor: 1, reasons: [] };

  // Penalty is per checked claim, so normalise by how many claims were checked: one bad
  // verdict out of ten is not the same as one out of one.
  const factor = Math.max(MIN_WEIGHT_FRACTION, 1 - penalty / mine.length);
  return { factor: Number(factor.toFixed(3)), reasons };
}

/**
 * Resolve final weights for every seat in a run.
 *
 * @param {object} run
 * @param {object[]} [run.master_opinions]
 * @param {object[]} [run.verifier_verdicts]  [{ seat, verdict, claim }]
 * @param {object}   [overrides]              seat id -> weight, from the caller
 */
export function resolveSeatWeights(run, overrides = {}) {
  const reg = registry();
  const seats = [];

  const debateIds = reg.ids("debate").filter((id) => id !== "portfolio_manager");
  const masterIds = (run.master_opinions || []).map((o) => o.master);

  for (const id of [...debateIds, ...masterIds]) {
    const persona = reg.get(id);
    if (!persona) continue;
    const declared = baseWeight(persona);
    const override = Number.isFinite(overrides[id]) && overrides[id] >= 0 ? overrides[id] : null;
    const base = override ?? declared;
    const { factor, reasons } = verificationAdjustment(id, run.verifier_verdicts);

    // A master that ruled itself out of scope should not carry weight into a verdict it
    // declined to give. That is not a penalty; it is taking the seat at its word.
    const opinion = (run.master_opinions || []).find((o) => o.master === id);
    const outOfScope = opinion?.stance === "out_of_scope";

    seats.push({
      seat: id,
      kind: persona.kind,
      declared_weight: declared,
      override_weight: override,
      verification_factor: factor,
      verification_reasons: reasons,
      out_of_scope: outOfScope,
      effective_weight: outOfScope ? 0 : Number((base * factor).toFixed(3)),
      stance: opinion?.stance,
    });
  }

  const total = seats.reduce((sum, s) => sum + s.effective_weight, 0);
  for (const seat of seats) {
    seat.share = total > 0 ? Number((seat.effective_weight / total).toFixed(4)) : 0;
  }
  return { seats, total_effective_weight: Number(total.toFixed(3)) };
}

/** A table the PM must reproduce in the report, so the weighting is never invisible. */
export function weightTableMarkdown(resolved, language = "English") {
  const chinese = /中文|chinese|zh/i.test(String(language));
  const { seats } = resolved;
  if (!seats.length) return "";

  const header = chinese
    ? "| 席位 | 立场 | 声明权重 | 核验系数 | 生效权重 | 占比 | 调整原因 |"
    : "| Seat | Stance | Declared | Verification | Effective | Share | Why adjusted |";
  const rule = "|---|---|---|---|---|---|---|";
  const rows = seats.map((s) => {
    const why = s.out_of_scope
      ? (chinese ? "自述超出判断范围" : "declared out of scope")
      : (s.verification_reasons.length
        ? s.verification_reasons.join(", ")
        : (chinese ? "无" : "-"));
    const stance = s.stance || (chinese ? "（辩论角色）" : "(debate role)");
    const declared = s.override_weight !== null
      ? `${s.override_weight} ${chinese ? "(覆盖)" : "(override)"}`
      : String(s.declared_weight);
    return `| ${s.seat} | ${stance} | ${declared} | ${s.verification_factor} | ${s.effective_weight} | ${(s.share * 100).toFixed(1)}% | ${why} |`;
  });

  const note = chinese
    ? "\n权重是可编辑的先验，不是最优解。没人能诚实地宣称找到了 LLM 委员会的最佳配比——要衡量它需要对 LLM 判断做收益回测，而那种回测被前视偏差证伪（模型已经知道分析基准日之后发生了什么）。引用被核验推翻的席位会自动降权，但不会被完全抹掉。"
    : "\nThese weights are an editable prior, not an optimum. Nobody can honestly claim to have found the best weighting for a committee of language models: measuring that would need a return backtest of LLM judgment, and such a backtest is invalidated by look-ahead bias -- the model already knows what happened after the as-of date. Seats whose cited evidence failed verification are down-weighted automatically, but never silently erased.";

  return [header, rule, ...rows].join("\n") + "\n" + note;
}

/** Seats available for a roster, for tool schemas and previews. */
export function rosterWeights(rosterName) {
  const reg = registry();
  return selectRoster(reg, { kind: "master", roster: rosterName }).map((p) => ({
    seat: p.id,
    declared_weight: baseWeight(p),
  }));
}
