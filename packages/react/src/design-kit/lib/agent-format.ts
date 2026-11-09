// Formatters shared by the agent components: money, elapsed time, latency,
// relative time, counts, and initials. Pure functions, so they also run in
// server components and tests.

const countFormat = new Intl.NumberFormat('en-US');

/** `$0.13`, `$4.17`, `$1,820`; `<$0.01` for a non-zero sliver. `precise`
 *  keeps three decimals under a dollar (`$0.026`), for per-run readouts. */
function formatCost(value: number, { precise = false }: { precise?: boolean } = {}): string {
  if (value > 0 && value < (precise ? 0.001 : 0.005)) return precise ? '<$0.001' : '<$0.01';
  if (precise && value < 1) return `$${value.toFixed(3)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${countFormat.format(Math.round(value))}`;
}

/** Cost per minute: `$0.08/min`. */
function formatRate(perMinute: number): string {
  return `${formatCost(perMinute)}/min`;
}

/** Clock-style elapsed time: `0:09`, `2:55`, `1:04:12`. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Worded duration: `38s`, `6m 00s`, `2h 05m`, `1d 3h`. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Tool-call latency: `700ms`, `1.5s`, `12s`. */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

/** Relative time against `now`: `now`, `17s ago`, `4m ago`, `2h ago`, `3d ago`;
 *  future times read `in 5m`. */
function formatRelative(at: number | Date, now: number = Date.now()): string {
  const t = typeof at === 'number' ? at : at.getTime();
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return 'now';
  let text: string;
  if (abs < 60) text = `${abs}s`;
  else if (abs < 3600) text = `${Math.floor(abs / 60)}m`;
  else if (abs < 86_400) text = `${Math.floor(abs / 3600)}h`;
  else text = `${Math.floor(abs / 86_400)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** Wall-clock time in the user's locale: `9:00 AM`. */
function formatTimeOfDay(at: number | Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** `1,312`. */
function formatCount(value: number): string {
  return countFormat.format(value);
}

/** Up to two initials from a name: `Alex Morgan` → `AM`, `Researcher` → `R`. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ''))[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export {
  formatClock,
  formatCost,
  formatCount,
  formatDuration,
  formatLatency,
  formatRate,
  formatRelative,
  formatTimeOfDay,
  initials,
};
