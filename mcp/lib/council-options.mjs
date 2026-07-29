import { registry, selectRoster, personaTitle } from "./personas/registry.mjs";
import { DEFAULT_TASKS, LIMITS, QUICK_TASKS } from "./constants.mjs";
import { loadPacks } from "./personas-v2/loader.mjs";
import { compiledPersonaPacks } from "./personas-v3/registry.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { selectorCard } from "./master-catalog.mjs";
import { languageKey, localized } from "./lang.mjs";

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
  const locale = languageKey(language);
  const copy = (messages) => localized(language, messages);
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

  // A flattened, stable-order catalog is the selection source of truth. Rosters remain
  // useful shortcuts, but a user may choose any 1..N individual methods across schools.
  const masterChoices = reg.ids("master").map((id, offset) => {
    const persona = reg.get(id);
    const pack = packs.get(id);
    const v3 = v3Packs.get(id);
    const v3Selection = v3?.manifest?.selection;
    const v3Label = v3?.admitted_label;
    const provisionalV3 = v3?.build_profile === "solo_test";
    const field = (value, label) => {
      const selected = value?.[locale];
      if (typeof selected !== "string" || !selected.trim()) {
        throw new Error(`${id}: missing ${locale} selector ${label}`);
      }
      return selected;
    };
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
      title: v3Label ? field(v3Label, "title") : personaTitle(persona, language),
      ...(v3Selection ? {
        identity: field(v3Selection.identity, "identity"),
        method: field(v3Selection.method, "method"),
        best_for: field(v3Selection.best_for, "best_for"),
      } : selectorCard(persona, language)),
      maturity: v3?.maturity || pack?.kind || "prompt_lens",
      // The label names what a seat IS. It used to lead with "provisional", which read as a
      // standing warning next to all twenty-seven names in the selector and repeated a review
      // status the assurance section already reports. The machine-verified admission level is
      // unchanged and still published as `admission_level` below.
      maturity_label: copy({
        en: v3?.maturity === "method_model" ? "Validated method model" : v3?.maturity === "candidate" ? "Candidate method" : "Operator method lens",
        zh: v3?.maturity === "method_model" ? "已验证方法模型" : v3?.maturity === "candidate" ? "候选方法" : "方法透镜",
        ja: v3?.maturity === "method_model" ? "検証済みメソッドモデル" : v3?.maturity === "candidate" ? "候補メソッド" : "メソッド・レンズ",
        ko: v3?.maturity === "method_model" ? "검증된 방법론 모델" : v3?.maturity === "candidate" ? "후보 방법론" : "방법론 렌즈",
      }),
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

  const masterById = new Map(masterChoices.map((master) => [master.id, master]));
  const rosterChoices = masterRosters.map((roster) => {
    const members = selectRoster(reg, { kind: "master", roster });
    return {
      roster,
      count: members.length,
      members: members.map((member) => ({
        id: member.id,
        title: masterById.get(member.id)?.title || personaTitle(member, language),
      })),
    };
  });

  const allMasters = masterChoices.length;
  const verifiers = reg.ids("verifier");

  const presets = [
    {
      id: "quick",
      label: copy({
        en: "Quick: 4 core analysts in parallel + up to 4 masters + one parallel bull/bear round + short synthesis",
        zh: "快速：4 位核心分析师并行 + 最多 4 位大师 + 单轮并行多空 + 短综合",
        ja: "クイック：中核アナリスト4席を並列実行 + マスター最大4席 + 1回の並列Bull/Bear + 短い総合判断",
        ko: "퀵: 핵심 분석가 4개 좌석 병렬 + 마스터 최대 4개 좌석 + 1회 병렬 Bull/Bear + 짧은 종합 판단",
      }),
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
      good_for: copy({
        en: "A bounded directional read retaining masters, core analysts and recent company/industry news; no three-round cross-exam or adversarial verification.",
        zh: "十分钟级方向性初读：保留大师、核心分析师和近期公司/行业新闻；不做三轮交叉问答或对抗核验",
        ja: "短時間の方向性確認。マスター、中核アナリスト、直近の企業・業界ニュースを含むが、3ラウンドの反対尋問や対抗検証は行わない。",
        ko: "짧은 방향성 검토. 마스터, 핵심 분석가, 최근 기업·산업 뉴스를 포함하지만 3라운드 교차 질문이나 적대적 검증은 수행하지 않는다.",
      }),
    },
    {
      id: "standard",
      label: copy({
        en: "Standard: 8 analysts + selected masters + debate",
        zh: "标准：8 位分析师 + 所选大师 + 辩论",
        ja: "標準：アナリスト8席 + 選択したマスター + 討論",
        ko: "표준: 분석가 8개 좌석 + 선택한 마스터 + 토론",
      }),
      analysts: DEFAULT_TASKS,
      master_selection: "required_1_to_N",
      suggested_masters_roster: "masters-core",
      verify: false,
      ...estimateSelectionRange({ analysts: DEFAULT_TASKS.length, allMasters }),
      good_for: copy({
        en: "The recommended default: full evidence coverage plus this run's confirmed methods.",
        zh: "默认推荐。覆盖完整证据面，并运行用户本次确认的方法席",
        ja: "推奨される標準設定。証拠範囲を完全にカバーし、この実行で確定したメソッド席を動かす。",
        ko: "권장 기본값. 전체 증거 범위를 다루고 이번 실행에서 확정한 방법론 좌석을 실행한다.",
      }),
    },
    {
      id: "deep",
      label: copy({
        en: "Deep: every analyst + selected masters + verification + debate",
        zh: "深度：全部分析师 + 所选大师 + 交叉验证 + 辩论",
        ja: "詳細：全アナリスト + 選択したマスター + 交差検証 + 討論",
        ko: "심층: 전체 분석가 + 선택한 마스터 + 교차 검증 + 토론",
      }),
      analysts: allAnalysts.map((p) => p.id),
      master_selection: "required_1_to_N",
      suggested_masters_roster: "masters-core",
      verify: true,
      ...estimateSelectionRange({ analysts: allAnalysts.length, allMasters, verifiers: verifiers.length * 3 }),
      good_for: copy({
        en: "For a decision with real money behind it. Every load-bearing claim is re-sourced, re-derived and attacked.",
        zh: "要下真钱的时候用。每条承重论断都会被回源、独立重算和反面检索",
        ja: "実資金を伴う判断向け。重要な主張をすべて原典確認、独立再計算、反証検索にかける。",
        ko: "실제 자금이 걸린 판단용. 핵심 주장을 모두 원출처 확인, 독립 재계산, 반증 검색에 부친다.",
      }),
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
    how_to_ask: copy({
      en: [
        "Before every new council run, show the individual catalog and require at least one master selection. The user may pick one, any combination, or all.",
        "If the request already names masters, preselect them, but still show the catalog and require a submission for this run. Never reuse an old run's selection silently.",
        "Prefer a host-native multi-select. If it cannot hold the full catalog, show the stable numbered table and accept numbers, stable IDs, or all.",
        "Submitting the selection is the confirmation. Do not add another confirmation question, but do not start research without a selection receipt.",
      ],
      zh: [
        "每次新的委员会运行都先展示逐席名单，并要求用户选择至少 1 位大师；可以单选、任意多选或全选。",
        "用户已经点名时，把这些席位预选出来，但仍要展示名单并让用户提交本次选择。旧运行的选择不能自动复用。",
        "优先使用宿主原生多选；容纳不了完整名单时，展示固定编号表，并接受编号、稳定 ID 或 all。",
        "选择提交本身就是确认。不要再追加第二个确认问题，但没有 selection receipt 就不能开始研究。",
      ],
      ja: [
        "新しい委員会実行の前に必ず席ごとの一覧を表示し、少なくとも1つのマスター席を選んでもらう。単独、複数、全選択が可能。",
        "依頼文でマスターが指定済みでも、事前選択として表示したうえで今回の選択送信を求める。以前の実行の選択を黙って再利用しない。",
        "ホストの複数選択を優先し、一覧を収められない場合は固定番号表を示して番号、stable ID、allを受け付ける。",
        "選択の送信自体を確定とする。二重確認は追加しないが、selection receiptなしで調査を開始しない。",
      ],
      ko: [
        "새 위원회 실행 전에는 좌석별 목록을 모두 보여 주고 최소 1개 마스터 좌석을 선택받는다. 단일, 복수, 전체 선택이 가능하다.",
        "요청에 마스터가 이미 지정되어 있어도 사전 선택으로 표시한 뒤 이번 실행의 선택 제출을 받아야 한다. 이전 실행의 선택을 조용히 재사용하지 않는다.",
        "호스트의 다중 선택 기능을 우선하고, 전체 목록을 담을 수 없으면 고정 번호표를 보여 준 뒤 번호, stable ID 또는 all을 받는다.",
        "선택 제출 자체가 확정이다. 두 번째 확인 질문은 추가하지 않지만 selection receipt 없이는 조사를 시작하지 않는다.",
      ],
    }),
  };
}
