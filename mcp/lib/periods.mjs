/** Window token for a duration whose length is set by data availability, not by the method. */
export const ANY_REPORTING_INTERVAL = "ANY";

/**
 * Check whether an observed interval satisfies a deterministic reporting-window contract.
 * Fiscal years are 52 or 53 weeks, so year windows use the same bounded tolerance everywhere
 * that creates or consumes typed facts.
 */
export function periodWindowMatches(fact, window) {
  if (!fact?.period_start || !fact?.period_end) return false;
  const start = Date.parse(fact.period_start);
  const end = Date.parse(fact.period_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  if (window === ANY_REPORTING_INTERVAL) return true;
  const match = /^P([1-9]\d*)([DMY])$/u.exec(window || "");
  if (!match) return false;
  const count = Number(match[1]);
  const elapsedDays = (end - start) / 86_400_000;
  if (match[2] === "D") return elapsedDays === count;
  if (match[2] === "M") return elapsedDays >= count * 27 && elapsedDays <= count * 32;
  return elapsedDays >= count * 364 - 2 && elapsedDays <= count * 366 + 1;
}
