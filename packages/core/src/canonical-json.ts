/**
 * RFC 8785 JSON Canonicalization Scheme (ADR-015).
 * Keys are sorted by UTF-16 code units; numbers and strings use ECMAScript JSON serialization.
 * Anything that is not plain JSON data is rejected instead of being silently dropped.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${path}: not a plain JSON object`);
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`${path}: ${typeof value} is not JSON`);
}
