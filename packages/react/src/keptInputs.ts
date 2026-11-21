// Inputs a screen keeps after it goes, until the page is reloaded (features/session-panel.md
// 닫기와 패널 여닫기): an unsent instruction, a commit message, a review comment not added yet.
// In this page's memory only; nothing is written to storage.

const kept = new Map<string, unknown>();

/** What was kept under `key`, if anything. */
export function keptInput<T>(key: string): T | undefined {
  return kept.get(key) as T | undefined;
}

/** Keeps `value` under `key`; null lets it go. */
export function keepInput(key: string, value: unknown): void {
  if (value === null) kept.delete(key);
  else kept.set(key, value);
}

/** Lets every kept input go (tests). */
export function forgetKeptInputs(): void {
  kept.clear();
}
