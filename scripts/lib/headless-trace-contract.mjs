const MODES = new Set(["full", "quick"]);
const SUCCESS_TERMINAL_TYPES = new Set(["run_complete", "run_degraded", "needs_verification"]);
const TERMINAL_TYPES = new Set([
  ...SUCCESS_TERMINAL_TYPES,
  "incomplete",
  "background_run_failed",
  "background_run_interrupted",
]);

function firstIndex(events, predicate) {
  return events.findIndex(predicate);
}

function typeIndex(events, type) {
  return firstIndex(events, (event) => event.type === type);
}

function roleIndex(events, type, role) {
  return firstIndex(events, (event) => event.type === type && event.role === role);
}

function before(errors, earlier, later, message) {
  if (later !== -1 && (earlier === -1 || earlier >= later)) errors.push(message);
}

/**
 * Validate the security-relevant ordering of one plugin-managed headless trace.
 *
 * This deliberately checks lifecycle barriers rather than every heartbeat so new diagnostic
 * events do not break the contract. Visible-host traces use different event names and are out of
 * scope; their server-side transition rules remain covered by visible-run tests.
 */
export function validateHeadlessTrace(events, { mode = "full", dryRun = false } = {}) {
  const errors = [];
  if (!Array.isArray(events)) return ["events must be an array"];
  if (!MODES.has(mode)) return [`unsupported headless trace mode: ${mode}`];
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      errors.push(`event ${index} must be an object with a string type`);
    }
  }
  if (errors.length) return errors;

  const receipt = typeIndex(events, "master_selection_consumed");
  const started = typeIndex(events, "run_started");
  const evidence = mode === "full"
    ? typeIndex(events, "evidence_complete")
    : firstIndex(events, (event) => event.type === "evidence_complete" || event.type === "evidence_degraded");
  const mastersStarted = typeIndex(events, "masters_started");
  const mastersComplete = typeIndex(events, "masters_complete");
  const debateStarted = typeIndex(events, "debate_started");
  const pmComplete = roleIndex(events, "agent_role_completed", "portfolio_manager");
  const successTerminal = firstIndex(events, (event) => SUCCESS_TERMINAL_TYPES.has(event.type));

  if (receipt === -1) errors.push("missing master_selection_consumed");
  if (started === -1) errors.push("missing run_started");
  before(errors, receipt, started, "run_started occurred before master_selection_consumed");
  before(errors, started, evidence, "evidence barrier occurred before run_started");
  before(errors, evidence, mastersStarted, "masters_started occurred before the evidence barrier");
  before(errors, mastersStarted, mastersComplete, "masters_complete occurred before masters_started");
  before(errors, mastersComplete, debateStarted, "debate_started occurred before masters_complete");

  const downstream = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => (
      event.type === "debate_round"
      || event.type === "agent_round_completed"
      || event.type === "agent_role_completed"
    ));
  for (const { event, index } of downstream) {
    before(errors, mastersComplete, index, `${event.type} occurred before masters_complete`);
    before(errors, debateStarted, index, `${event.type} occurred before debate_started`);
  }

  const rounds = events.filter((event) => event.type === "debate_round").map((event) => event.round);
  const expectedRounds = mode === "full" ? [1, 2, 3] : [1];
  const expectedPrefix = expectedRounds.slice(0, rounds.length);
  if (rounds.length > expectedRounds.length || JSON.stringify(rounds) !== JSON.stringify(expectedPrefix)) {
    errors.push(`${mode} debate rounds must be the ordered prefix ${expectedRounds.join(",")}; received ${rounds.join(",")}`);
  }

  const qnaGate = firstIndex(events, (event) => (
    event.type === "debate_qna_gate"
    && event.status === (mode === "full" ? "passed" : "not_run")
  ));
  if (pmComplete !== -1) {
    const requiredRound = firstIndex(events, (event) => (
      event.type === "debate_round" && event.round === (mode === "full" ? 3 : 1)
    ));
    before(errors, requiredRound, pmComplete, "portfolio_manager completed before the required debate round");
    before(errors, qnaGate, pmComplete, "portfolio_manager completed before the applicable Q&A gate");
  }

  if (successTerminal !== -1 && !dryRun) {
    const terminalType = events[successTerminal].type;
    for (const [name, index] of [
      ["evidence barrier", evidence],
      ["masters_started", mastersStarted],
      ["masters_complete", mastersComplete],
      ["debate_started", debateStarted],
      ["portfolio_manager completion", pmComplete],
      ["Q&A gate", qnaGate],
    ]) {
      if (index === -1) errors.push(`${terminalType} is missing ${name}`);
      else if (index >= successTerminal) errors.push(`${terminalType} occurred before ${name}`);
    }
    if (JSON.stringify(rounds) !== JSON.stringify(expectedRounds)) {
      errors.push(`${terminalType} ${mode} trace must contain debate rounds ${expectedRounds.join(",")}`);
    }
    if (terminalType === "run_degraded") {
      if (mode !== "quick") errors.push("run_degraded is only valid for a quick headless trace");
      if (typeIndex(events, "evidence_degraded") === -1) {
        errors.push("run_degraded is missing evidence_degraded");
      }
    }
  }

  const terminalEvents = events.filter((event) => TERMINAL_TYPES.has(event.type));
  if (terminalEvents.length > 1) {
    errors.push(`trace contains multiple terminal events: ${terminalEvents.map((event) => event.type).join(",")}`);
  }
  const terminalIndex = firstIndex(events, (event) => TERMINAL_TYPES.has(event.type));
  if (terminalIndex !== -1) {
    const lateLifecycle = events.slice(terminalIndex + 1).find((event) => (
      event.type === "masters_started"
      || event.type === "masters_complete"
      || event.type === "debate_started"
      || event.type === "debate_round"
      || event.type === "agent_round_completed"
      || event.type === "agent_role_completed"
    ));
    if (lateLifecycle) errors.push(`${lateLifecycle.type} occurred after terminal event ${events[terminalIndex].type}`);
  }

  return [...new Set(errors)];
}
