# Agent Instructions

Read `CLAUDE.md` first. It defines the workflow, analyst roles, final-report requirements, evidence contract and repository boundaries.

For report-generation behavior, also follow `docs/report-contract.md`. The chat handoff may be concise, but the saved report and artifact files must preserve the full evidence chain.

For anti-laziness governance, also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with the plugin so installed agents inherit the same gates without separately installing `addyosmani/agent-skills`.

Run `npm run check` after any code or prompt change.
