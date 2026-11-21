// The studio's shortcut registry (apps/studio/src/shortcuts.ts), read as text: the desktop
// cannot import the studio, and a new shortcut there must not break what the desktop takes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface StudioChord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Every default binding as the desktop app's `effectiveShortcuts()` hands it over. */
export function studioDesktopBindings(): Record<string, StudioChord> {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../studio/src/shortcuts.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('export const SHORTCUTS'));
  const table = body.slice(0, body.indexOf('];'));
  const bindings: Record<string, StudioChord> = {};
  for (const match of table.matchAll(/\{ id: '([^']+)', chord: \{([^}]*)\}/g)) {
    const chord = match[2] ?? '';
    const flag = (name: string) => new RegExp(`${name}: true`).test(chord);
    bindings[match[1] ?? ''] = {
      key: /key: '([^']+)'/.exec(chord)?.[1] ?? '',
      ...(flag('mod') ? { mod: true } : {}),
      ...(flag('shift') ? { shift: true } : {}),
      ...(flag('alt') ? { alt: true } : {}),
    };
  }
  // An entry this reading missed would hide exactly the drift these tests are for.
  if (Object.keys(bindings).length !== [...table.matchAll(/\{ id: '/g)].length)
    throw new Error('The studio shortcut table changed shape');
  return bindings;
}
