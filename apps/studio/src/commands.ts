// Command palette model (roadmap UX-A5): what a command is and how a query ranks them.

export interface Command {
  id: string;
  title: string;
  /** Section heading in the palette. */
  group: string;
  /** Extra words that match but are not shown (status, ids). */
  keywords?: string[];
  /** A shortcut to show next to the title, if the command has one. */
  shortcut?: string;
  run(): void | Promise<void>;
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * Commands whose title or keywords contain every word of the query, in any order. A title
 * that starts with the first word ranks first; otherwise the given order is kept.
 */
export function rankCommands(query: string, commands: readonly Command[]): Command[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const first = words[0] ?? '';
  return commands
    .map((command, index) => {
      const title = fold(command.title);
      const haystack = [title, ...(command.keywords ?? []).map(fold)].join(' ');
      if (!words.every((w) => haystack.includes(w))) return null;
      return { command, index, rank: title.startsWith(first) ? 0 : 1 };
    })
    .filter((x): x is { command: Command; index: number; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.command);
}
