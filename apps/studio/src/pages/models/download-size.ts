const MB = 1_000_000;

/** The install size the settings show: MB, or GB to one decimal once that reaches 1000 MB. */
export function downloadAmount(bytes: number): { amount: number; unit: 'MB' | 'GB' } {
  const mb = Math.round(bytes / MB);
  if (mb >= 1000) return { amount: mb / 1000, unit: 'GB' };
  return { amount: mb, unit: 'MB' };
}

export function formatDownload(
  bytes: number,
  format: (
    value: number,
    options?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
  ) => string,
): { size: string; unit: 'MB' | 'GB' } {
  const amount = downloadAmount(bytes);
  return {
    unit: amount.unit,
    size:
      amount.unit === 'GB'
        ? format(amount.amount, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : format(amount.amount),
  };
}
