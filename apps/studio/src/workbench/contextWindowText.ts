const UNIT: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 };

export function parseContextWindow(text: string): number | 'invalid' {
  const match = /^(\d+)([km]?)$/i.exec(text.trim());
  if (!match) return 'invalid';
  const value = Number(match[1]) * (UNIT[(match[2] ?? '').toLowerCase()] ?? 1);
  return value >= 1 && value <= 10_000_000 ? value : 'invalid';
}
