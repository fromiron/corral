export function monoFontFamily(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  );
}

export async function monoFontReady(size: number): Promise<void> {
  await document.fonts?.load(`${size}px ${monoFontFamily()}`).catch(() => undefined);
}
