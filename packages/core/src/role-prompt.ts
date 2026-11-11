/** A drafted role's instructions: its duty, then the rules every role follows. */
export const rolePrompt = (duty: string) =>
  `${duty} Use only the task and inputs you were given, keep exact artifact versions and evidence references, and submit with submit_result. Do not hide tool failures or missing evidence.`;
