/**
 * A shallow copy of `object` without `keys` — like a `{ key: _key, ...rest }`
 * destructure without the unused binding. Used to drop props before spreading
 * the rest onto an element.
 */
export function omit<T extends object, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Omit<T, K> {
  const rest = { ...object };
  for (const key of keys) delete rest[key];
  return rest;
}
