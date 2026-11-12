// Whether the person opened or closed a run's work log in the conversation, by run and density.
// A virtualized timeline unmounts rows off screen, so the choice lives here rather than in the
// row's state. Memory only: a reload starts from the default again. The newest choices are kept.
import { forgetOnReset } from './viewMemory.ts';

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

// The height a run's row last had on screen, so a row mounted again keeps it while its record
// is read again. Same memory rules as the choices.
const heights = new Map<string, number>();

export function rowHeight(runId: string): number | null {
  return heights.get(runId) ?? null;
}

export function keepRowHeight(runId: string, height: number) {
  if (heights.get(runId) === height) return;
  heights.delete(runId);
  heights.set(runId, height);
  while (heights.size > LIMIT) {
    const oldest = heights.keys().next().value;
    if (oldest === undefined) break;
    heights.delete(oldest);
  }
}

forgetOnReset(() => {
  choices.clear();
  heights.clear();
});
