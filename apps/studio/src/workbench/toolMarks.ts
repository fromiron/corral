import type { AgentMark } from '@corral/react/design-kit';
import { Folder, Globe, MessageCircle, Pencil, Users } from '@corral/react/icons';

/** The kit icon a tool's name suggests; tools with no clear match show no mark. */
const TOOL_ICONS: [RegExp, AgentMark][] = [
  [/search|web|fetch|browse/i, Globe],
  [/read|list|open|view/i, Folder],
  [/write|edit|patch|create|submit/i, Pencil],
  [/ask|question|message|reply/i, MessageCircle],
  [/delegate|spawn|handoff|team/i, Users],
];

/** The distinct marks the named tools suggest, in first-use order. */
export function toolMarks(names: Iterable<string>): AgentMark[] {
  const marks = new Set<AgentMark>();
  for (const name of names) {
    const mark = TOOL_ICONS.find(([pattern]) => pattern.test(name))?.[1];
    if (mark) marks.add(mark);
  }
  return [...marks];
}
