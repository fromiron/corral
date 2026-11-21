import type { HarnessApi } from '@corral/client';
import type { HarnessEntryView } from '@corral/contracts';
import { entryId } from './EntryContent.tsx';

export type SkillCatalog = { entries: HarnessEntryView[]; disabled: Set<string> };

export async function loadSkillCatalog(api: HarnessApi): Promise<SkillCatalog> {
  const [entries, packages] = await Promise.all([api.entries(), api.packages()]);
  return {
    entries: entries.filter((entry) => entry.kind === 'skill'),
    disabled: new Set(
      packages.filter((pkg) => pkg.status !== 'enabled').map((pkg) => pkg.resource.hash),
    ),
  };
}

/** A skill "add skill" lets a person pick: trusted, switched on and not archived. */
export function usableSkill(entry: HarnessEntryView, catalog: SkillCatalog): boolean {
  return (
    !entry.archivedAt &&
    !catalog.disabled.has(entry.resourceHash) &&
    Boolean(entry.resource.trustedAt)
  );
}

export function skillState(
  entry: HarnessEntryView,
  disabled: ReadonlySet<string>,
): 'archived' | 'skillDisabled' | 'needsTrust' | 'newVersion' | null {
  if (entry.archivedAt) return 'archived';
  if (disabled.has(entry.resourceHash)) return 'skillDisabled';
  if (!entry.resource.trustedAt) return 'needsTrust';
  return entry.successor ? 'newVersion' : null;
}

// A display name is not an identity. Follow only exact entry-to-entry links, including archived versions.
export function versionsOf(selected: HarnessEntryView, entries: HarnessEntryView[]) {
  const byId = new Map(entries.map((entry) => [entryId(entry), entry]));
  const before = new Map(
    entries.flatMap((entry) =>
      entry.successor ? [[entryId(entry.successor), entry] as const] : [],
    ),
  );
  const seen = new Set([entryId(selected)]);
  const previous: HarnessEntryView[] = [];
  let entry = before.get(entryId(selected));
  while (entry && !seen.has(entryId(entry))) {
    seen.add(entryId(entry));
    previous.push(entry);
    entry = before.get(entryId(entry));
  }
  const chain = [...previous.reverse(), selected];
  entry = selected.successor ? byId.get(entryId(selected.successor)) : undefined;
  while (entry && !seen.has(entryId(entry))) {
    seen.add(entryId(entry));
    chain.push(entry);
    entry = entry.successor ? byId.get(entryId(entry.successor)) : undefined;
  }
  return { chain, index: previous.length };
}
