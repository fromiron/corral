// Whether the person opened or closed a run's work log in the conversation, by run and density.
// A virtualized timeline unmounts rows off screen, so the choice lives here rather than in the
// row's state. Memory only: a reload starts from the default again. The newest choices are kept.

const LIMIT = 200;
const choices = new Map<string, boolean>();

const key = (runId: string, density: string) => `${runId}\u0000${density}`;

export function processChoice(runId: string, density: string): boolean | null {
  return choices.get(key(runId, density)) ?? null;
}

export function chooseProcess(runId: string, density: string, open: boolean) {
  const id = key(runId, density);
  choices.delete(id);
  choices.set(id, open);
  while (choices.size > LIMIT) {
    const oldest = choices.keys().next().value;
    if (oldest === undefined) break;
    choices.delete(oldest);
  }
}

/** Forgets every choice; for tests, so one does not leak into the next. */
export function resetProcessChoices() {
  choices.clear();
}
