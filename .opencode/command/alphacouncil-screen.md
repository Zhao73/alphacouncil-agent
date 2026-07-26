---
description: Mechanical filings screen only — no language model judgment
argument-hint: [ticker]
---

# AlphaCouncil — mechanical screen

Ticker: **$ARGUMENTS**

Call `screen_ticker` with `ticker`. The CIK resolves itself.

Report the table exactly as returned, and state plainly:

- **A rule whose inputs are missing is `skipped`, never a pass.** Reporting "6/7 passed"
  without naming the seventh misrepresents the screen.
- **Surviving is not a recommendation.** It means the name is worth research time.
- No language model judgment is involved in this screen. Every elimination names the
  metric, the measured value and the threshold.

For a non-US ticker the SEC universe has no entry; say which market it is and use
`market_coverage` to say what that market supports instead of returning nothing.
