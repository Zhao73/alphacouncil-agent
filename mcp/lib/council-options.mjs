import { registry, selectRoster, personaTitle } from "./personas/registry.mjs";
import { DEFAULT_TASKS, LIMITS, QUICK_TASKS } from "./constants.mjs";
import { loadPacks } from "./personas-v2/loader.mjs";
import { compiledPersonaPacks } from "./personas-v3/registry.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { selectorCard } from "./master-catalog.mjs";

/**
 * The menu a host shows before a run starts.
 *
 * A council can be four seats or thirty-eight, and the difference is minutes and money the
 * user is spending. Choosing silently on their behalf is the wrong default in both
 * directions: pick small and the bench they were promised never runs, pick everything and
 * a quick question costs a full fan-out.
 *
 * MCP cannot draw a dialog, so this supplies the menu as data and the runtime skill
 * requires the host to ask. That works identically in Claude Code, Codex, OpenCode and
 * Grok Build, because all four can ask a question in chat.
 */

/** Rough per-seat cost, used only to rank presets. Not a promise about wall-clock time. */
const SEAT_MINUTES = { analyst: 1.5, master: 0.8, verifier: 0.5, debate: 1.5 };

const estimate = ({ analysts = 0, masters = 0, verifiers = 0, debate = 3 }) => {
  const seats = analysts + masters + verifiers + debate;
  const minutes = analysts * SEAT_MINUTES.analyst + masters * SEAT_MINUTES.master
    + verifiers * SEAT_MINUTES.verifier + debate * SEAT_MINUTES.debate;
  return { seats, rough_minutes: Math.round(minutes) };
};

const estimateSelectionRange = ({ analysts = 0, allMasters = 1, verifiers = 0, debate = 3 }) => {
  const minimum = estimate({ analysts, masters: 1, verifiers, debate });
  const maximum = estimate({ analysts, masters: allMasters, verifiers, debate });
  return {
    seats: `${minimum.seats}-${maximum.seats}`,
    rough_minutes: `${minimum.rough_minutes}-${maximum.rough_minutes}`,
    seats_min: minimum.seats,
    seats_max: maximum.seats,
    rough_minutes_min: minimum.rough_minutes,
    rough_minutes_max: maximum.rough_minutes,
  };
};

export function councilOptions({ language = "English" } = {}) {
  const chinese = /中文|chinese|zh/i.test(String(language));
  const reg = registry();
  const packs = loadPacks();
  const v3Packs = compiledPersonaPacks();

  const allAnalysts = reg.ids("analyst").map((id) => reg.get(id)).filter((p) => p.enabled);
  const masterRosters = [...new Set(
    reg.ids("master").flatMap((id) => reg.get(id).rosters || []),
  )].filter((r) => r !== "masters-core").sort();

  const analystChoices = allAnalysts.map((p) => ({
    id: p.id,
    title: personaTitle(p, language),
    in_default: DEFAULT_TASKS.includes(p.id),
    covers: (p.tags || []).join(", "),
  }));

  const rosterChoices = masterRosters.map((roster) => {
    const members = selectRoster(reg, { kind: "master", roster });
    return {
      roster,
      count: members.length,
      members: members.map((m) => ({ id: m.id, title: personaTitle(m, language) })),
    };
  });

  // A flattened, stable-order catalog is the selection source of truth. Rosters remain
  // useful shortcuts, but a user may choose any 1..N individual methods across schools.
  const masterChoices = reg.ids("master").map((id, offset) => {
    const persona = reg.get(id);
    const pack = packs.get(id);
    const v3 = v3Packs.get(id);
    const v3Selection = v3?.manifest?.selection;
    const v3Label = v3?.admitted_label;
    const provisionalV3 = v3?.build_profile === "solo_test";
    const localized = (value) => chinese ? value?.zh : value?.en;
    // Until a physical v3 pack exists, bind the receipt to the exact v2 pack or prompt
    // persona rather than publishing a null hash. A prompt edit must invalidate a catalog
    // the user saw before that edit just as a v3 policy edit does.
    const fallbackPackHash = pack
      ? sha256({ schema_version: 2, persona_id: id, pack })
      : sha256({
        schema_version: 1,
        persona_id: id,
        title: persona.title,
        philosophy_tags: persona.philosophy_tags,
        disqualifiers: persona.disqualifiers,
        bodies: persona.bodies,
      });
    return {
      index: offset + 1,
      id,
      title: localized(v3Label) || personaTitle(persona, language),
      ...(v3Selection ? {
        identity: localized(v3Selection.identity),
        method: localized(v3Selection.method),
        best_for: localized(v3Selection.best_for),
      } : selectorCard(persona, language)),
      maturity: v3?.maturity || pack?.kind || "prompt_lens",
      runtime_level: v3?.admission?.level || (pack ? "v2_operator" : "v1_prompt"),
      admission_level: v3?.admission?.level || (pack ? "operator_lens" : "prompt_lens"),
      pack_format: v3 ? provisionalV3 ? "schema_v3_solo_test" : "schema_v3_physical" : pack ? "schema_v2_legacy" : "prompt_v1_legacy",
      schema_version: v3 ? 3 : pack ? 2 : 1,
      legacy: !v3,
      production_status: v3 ? provisionalV3 ? "solo_test_provisional" : "production_physical_v3" : pack ? "legacy_v2" : "legacy_prompt",
      build_profile: v3?.build_profile || (pack ? "legacy_v2" : "legacy_prompt"),
      provisional: provisionalV3,
      pack_hash: v3?.pack_hash || fallbackPackHash,
      ...(v3?.source_cutoff ? { knowledge_cutoff: v3.source_cutoff } : {}),
      rosters: (persona.rosters || []).filter((r) => r !== "masters-core"),
      method_tags: persona.philosophy_tags || persona.tags || [],
      holding_period: persona.holding_period || "unspecified",
      native_decision: v3?.manifest?.capability?.native_decision_schema || pack?.native_decision_schema || "master_opinion_v1",
      relative_seat_cost: 1,
    };
  });

  const allMasters = masterChoices.length;
  const verifiers = reg.ids("verifier");

  const presets = [
    {
      id: "quick",
      label: chinese
        ? "快速：4 位核心分析师并行 + 最多 4 位大师 + 单轮并行多空 + 短综合"
        : "Quick: 4 core analysts in parallel + up to 4 masters + one parallel bull/bear round + short synthesis",
      analysts: QUICK_TASKS,
      master_selection: "required_1_to_N",
      master_selection_maximum: 4,
      suggested_masters_roster: null,
      verify: false,
      ...estimateSelectionRange({ analysts: QUICK_TASKS.length, allMasters: 4 }),
      council_mode: "quick",
      hard_time_budget_ms: LIMITS.QUICK_TOTAL_MS,
      debate_rounds: 1,
      report_contract: "quick_v1",
      full_council_equivalent: false,
      good_for: chinese
        ? "十分钟级方向性初读：保留大师、核心分析师和近期公司/行业新闻；不做三轮交叉问答或对抗核验"
        : "A bounded directional read retaining masters, core analysts and recent company/industry news; no three-round cross-exam or adversarial verification.",
    },
    {
      id: "standard",
      label: chinese ? "标准：8 位分析师 + 所选大师 + 辩论" : "Standard: 8 analysts + selected masters + debate",
      analysts: DEFAULT_TASKS,
      master_selection: "required_1_to_N",
      suggested_masters_roster: "masters-core",
      verify: false,
      ...estimateSelectionRange({ analysts: DEFAULT_TASKS.length, allMasters }),
      good_for: chinese
        ? "默认推荐。覆盖完整证据面，并运行用户本次确认的方法席"
        : "The recommended default: full evidence coverage plus this run's confirmed methods.",
    },
    {
      id: "deep",
      label: chinese ? "深度：全部分析师 + 所选大师 + 交叉验证 + 辩论" : "Deep: every analyst + selected masters + verification + debate",
      analysts: allAnalysts.map((p) => p.id),
      master_selection: "required_1_to_N",
      suggested_masters_roster: "masters-core",
      verify: true,
      ...estimateSelectionRange({ analysts: allAnalysts.length, allMasters, verifiers: verifiers.length * 3 }),
      good_for: chinese
        ? "要下真钱的时候用。每条承重论断都会被回源、独立重算和反面检索"
        : "For a decision with real money behind it. Every load-bearing claim is re-sourced, re-derived and attacked.",
    },
  ];

  return {
    language,
    presets,
    analysts: analystChoices,
    default_analysts: DEFAULT_TASKS,
    master_rosters: rosterChoices,
    masters: masterChoices,
    all_master_ids: masterChoices.map((m) => m.id),
    all_masters_count: allMasters,
    verifiers: verifiers.map((id) => ({ id, title: personaTitle(reg.get(id), language) })),
    how_to_ask: chinese ? [
      "每次新的委员会运行都先展示逐席名单，并要求用户选择至少 1 位大师；可以单选、任意多选或全选。",
      "用户已经点名时，把这些席位预选出来，但仍要展示名单并让用户提交本次选择。旧运行的选择不能自动复用。",
      "优先使用宿主原生多选；容纳不了完整名单时，展示固定编号表，并接受编号、稳定 ID 或 all。",
      "选择提交本身就是确认。不要再追加第二个确认问题，但没有 selection receipt 就不能开始研究。",
    ] : [
      "Before every new council run, show the individual catalog and require at least one master selection. The user may pick one, any combination, or all.",
      "If the request already names masters, preselect them, but still show the catalog and require a submission for this run. Never reuse an old run's selection silently.",
      "Prefer a host-native multi-select. If it cannot hold the full catalog, show the stable numbered table and accept numbers, stable IDs, or all.",
      "Submitting the selection is the confirmation. Do not add another confirmation question, but do not start research without a selection receipt.",
    ],
  };
}
