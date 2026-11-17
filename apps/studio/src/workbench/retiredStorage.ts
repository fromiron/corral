// What this device kept for screens Corral no longer has (workbench.md 파일과 문서 탭): each such
// key is deleted by its name, never read, so nothing in it is ever restored.

/** The key prefixes of retired screens: the source folder's in-pane preview. */
const RETIRED = ['corral:file-preview:v1:'] as const;

type KeyStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/** Deletes every key of a retired screen, by name alone. */
export function forgetRetiredKeys(storage: KeyStorage | null) {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && RETIRED.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // A storage that refuses is left as it is; nothing in it is read either way.
  }
}

/** This device's storage, where the page may reach it. */
export function deviceKeys(): KeyStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
