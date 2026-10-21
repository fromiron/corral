import type { ScheduleRule } from '@corral/contracts';

/** Nonexistent wall times are skipped; repeated wall times use the earlier instant only. */
export function nextScheduleTime(rule: ScheduleRule, zone: string, after: string): string | null {
  const since = Date.parse(after);
  if (rule.kind === 'once') return Date.parse(rule.at) > since ? rule.at : null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (stamp: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(stamp).map((p) => [p.type, p.value]));
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
  };
  const today = new Date(wall(since));
  today.setUTCHours(0, 0, 0, 0);
  const [hours, minutes] = rule.time.split(':').map(Number);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(today.getTime() + day * 86_400_000);
    if (rule.kind === 'weekly' && !rule.weekdays.includes(date.getUTCDay())) continue;
    date.setUTCHours(hours ?? 0, minutes ?? 0);
    const target = date.getTime();
    // Sample both sides of a timezone transition, then validate the actual local time.
    // This handles fractional-hour offsets without assuming a fixed UTC offset.
    const offsets = new Set<number>();
    for (let h = -48; h <= 48; h += 6) {
      const sample = target + h * 3_600_000;
      offsets.add(wall(sample) - sample);
    }
    const candidates = [...offsets]
      .map((offset) => target - offset)
      .filter((instant) => wall(instant) === target)
      .sort((a, b) => a - b);
    const first = candidates[0];
    if (first !== undefined && first > since) return new Date(first).toISOString();
  }
  return null;
}
