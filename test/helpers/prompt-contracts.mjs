export function promptContractErrors(text, contract) {
  const value = String(text || "");
  const errors = [];
  for (const required of contract?.required || []) {
    if (!value.includes(required)) errors.push(`missing required prompt contract fragment: ${required}`);
  }
  for (const forbidden of contract?.forbidden || []) {
    if (value.includes(forbidden)) errors.push(`forbidden prompt contract fragment: ${forbidden}`);
  }
  return errors;
}

export function assertPromptContract(text, contract, label = "prompt") {
  const errors = promptContractErrors(text, contract);
  if (errors.length) throw new Error(`${label} violated its prompt contract:\n- ${errors.join("\n- ")}`);
  return text;
}
