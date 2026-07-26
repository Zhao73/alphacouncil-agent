import { registry, selectRoster, personaTitle } from "./personas/registry.mjs";
import { DEFAULT_TASKS } from "./constants.mjs";

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

export function councilOptions({ language = "English" } = {}) {
  const chinese = /中文|chinese|zh/i.test(String(language));
  const reg = registry();

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

  const allMasters = reg.ids("master").length;
  const verifiers = reg.ids("verifier");

  const presets = [
    {
      id: "quick",
      label: chinese ? "快速：4 位分析师 + 辩论" : "Quick: 4 analysts + debate",
      analysts: DEFAULT_TASKS.slice(0, 4),
      masters_roster: null,
      verify: false,
      ...estimate({ analysts: 4 }),
      good_for: chinese
        ? "只想要一个方向性看法，接受没有大师视角、没有交叉验证"
        : "A directional read only. No master lenses and no cross-verification.",
    },
    {
      id: "standard",
      label: chinese ? "标准：8 位分析师 + 核心大师 + 辩论" : "Standard: 8 analysts + core bench + debate",
      analysts: DEFAULT_TASKS,
      masters_roster: "masters-core",
      verify: false,
      ...estimate({ analysts: DEFAULT_TASKS.length, masters: allMasters }),
      good_for: chinese
        ? "默认推荐。覆盖完整证据面并让全部大师议席发言"
        : "The recommended default. Full evidence coverage with every master lens reporting.",
    },
    {
      id: "deep",
      label: chinese ? "深度：全部分析师 + 全部大师 + 交叉验证 + 辩论" : "Deep: every analyst + every master + verification + debate",
      analysts: allAnalysts.map((p) => p.id),
      masters_roster: "masters-core",
      verify: true,
      ...estimate({ analysts: allAnalysts.length, masters: allMasters, verifiers: verifiers.length * 3 }),
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
    all_masters_count: allMasters,
    verifiers: verifiers.map((id) => ({ id, title: personaTitle(reg.get(id), language) })),
    how_to_ask: chinese ? [
      "开始跑之前，把上面的预设念给用户，让他们选一个，或者自己点名要哪些分析师和哪个大师名册。",
      "用户已经说清楚要什么（点了名册、说了「全部」、或说了「快点」），就不要再问——重复确认是打扰。",
      "预估时间是相对量级，不是承诺。说清楚「大师多一倍，时间大概多这些」，不要报一个精确分钟数。",
      "用户说「全都要」时照做，但先说一句它会明显更慢，让他们知道自己在换什么。",
    ] : [
      "Before starting, read the presets to the user and let them pick one, or name analysts and a master roster themselves.",
      "If the user already said what they want -- named a roster, said 'everything', said 'be quick' -- do not ask. A confirmation they did not need is an interruption.",
      "The estimates are relative magnitudes, not promises. Say that twice the bench costs roughly this much more; do not quote an exact number of minutes.",
      "If they say 'run everything', do it -- but say once that it will be noticeably slower, so they know what they are trading.",
    ],
  };
}
