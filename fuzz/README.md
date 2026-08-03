# AlphaCouncil development fuzzing

This directory is an isolated, development-only fuzz lane for the bounded JSON transport and
standalone runtime worker schemas. It is intentionally absent from the published npm package and
does not add a runtime dependency or an installation step for plugin users.

Requirements: Node.js 22 or newer. Install this directory independently:

```bash
cd fuzz
npm ci --ignore-scripts
mkdir -p .work/corpus artifacts
npm run fuzz:regression
npm run fuzz:pr
```

`fuzz:regression` replays the checked-in seeds once. `fuzz:pr` performs a deterministic 30-second
Jazzer.js run. `fuzz:manual` and `fuzz:scheduled` use longer budgets. `fuzz:node` is a deterministic,
coverage-blind fallback that does not require Jazzer's native engine after the source checkout is
available.

The first input byte selects a lane: `0` transport only, `1` evidence schema, `2` debate schema,
`3` method-voice schema, and `4` a constructed multiple-root negative control. Findings are written
below `artifacts/`; generated coverage corpus is kept below `.work/` and is not committed.
