// The names of a conversation's 문서 tabs (features/session-panel.md 문서 탭): the file name, and
// after it " — folder" with the nearest parent folder that tells apart other tabs' files of the
// same name. A copy and a source-folder file of one path keep one name; their marks tell them
// apart.
import type { PanelTab, TabKey } from './tabs.ts';
import { tabKey } from './tabs.ts';

type DocumentTab = Extract<PanelTab, { kind: 'document' }>;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** The folders above a file, nearest first. */
const parents = (path: string) => path.split('/').slice(0, -1).reverse();

/** The folder that tells `path` apart from each of `others`, or null when none does. */
function telling(path: string, others: readonly string[]): string | null {
  const own = parents(path);
  const theirs = others.map(parents);
  for (let depth = 0; depth < own.length; depth += 1) {
    const folder = own[depth];
    if (theirs.every((other) => other[depth] !== folder)) return folder ?? null;
  }
  return null;
}

/** Each 문서 tab's name, by its key, in the order the tabs are given. */
export function documentTabNames(tabs: readonly PanelTab[]): Map<TabKey, string> {
  const documents = tabs.filter((tab): tab is DocumentTab => tab.kind === 'document');
  const names = new Map<TabKey, string>();
  for (const tab of documents) {
    const name = fileName(tab.path);
    const others = [
      ...new Set(
        documents
          .filter((other) => other.path !== tab.path && fileName(other.path) === name)
          .map((other) => other.path),
      ),
    ];
    const folder = others.length ? telling(tab.path, others) : null;
    names.set(tabKey(tab), folder ? `${name} — ${folder}` : name);
  }
  return names;
}
