export const ROLE_RULES =
  'Use only the task and inputs you were given, keep exact artifact versions and evidence references, and submit with submit_result. Do not hide tool failures or missing evidence.';

/** Single-prompt roles carry their duty before the common rules. */
export const rolePrompt = (duty: string) => `${duty} ${ROLE_RULES}`;

/** A seat exported to a single instructions field, with its job before its reusable base. */
export function seatPrompt(base: string, stepInstruction?: string): string {
  if (!stepInstruction) return base;
  return base ? `${stepInstruction}\n\n${base}` : stepInstruction;
}
