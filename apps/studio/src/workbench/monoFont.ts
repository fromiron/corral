const unquoted = (name: string) => name.trim().replace(/^["']|["']$/g, '');

export function monoFontFamily(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  );
}

export async function monoFontReady(): Promise<void> {
  const families = new Set(monoFontFamily().split(',').map(unquoted));
  const faces = [...(document.fonts ?? [])].filter((face) => families.has(unquoted(face.family)));
  await Promise.all(faces.map((face) => face.load().catch(() => undefined)));
}
